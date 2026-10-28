"""Bounded, thread-owned record reads. These reads never acknowledge work or notes."""
from contextlib import closing
from collections import deque
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from harness_managed_actions import can_withdraw
from harness_state import require
from harness_team_common import object_fields


# Keep the historical default projection's kinds and 100-row window unchanged.
KINDS = ('user_message', 'assistant_message', 'host_user_note', 'host_queued',
         'host_claimed', 'control_dispatch', 'control_not_sent', 'control_received',
         'host_turn_yielded', 'host_turn_attention', 'host_parent_resumed',
         'host_child_result', 'host_waiting_children', 'host_delegated', 'host_result',
         'managed_model_changed', 'managed_message_withdrawn',
         'managed_preparation_requested', 'managed_preparation_reply',
         'managed_first_task_requested', 'managed_budget_refilled')
RECORD_KINDS = KINDS + ('managed_first_task_public_reply',)
INDEX_KINDS = ('user_message', 'assistant_message', 'host_user_note',
               'managed_preparation_requested', 'managed_preparation_reply',
               'managed_first_task_requested', 'managed_first_task_public_reply')
DEFAULT_LIMIT = 40
MAX_LIMIT = 80
PREVIEW_LENGTH = 600
MAX_SEQ = 2**63 - 1
MAX_BODY_BYTES = 8 * 1024 * 1024
REPLY_KINDS = ('assistant_message', 'managed_preparation_reply', 'managed_first_task_public_reply')
BODY_SOURCES = ('public_dom_markdown', 'local_mcp_public_result', 'authenticated_team_final_summary')
BODY_POINTER = re.compile(r'\n(?:完整公开原文（必须读取）：|完整结果：|完整首次准备回复：)'
                          r'([^\r\n]+)\r?\nSHA256: ([0-9a-f]{64})\s*\Z')
LABELS = {'user_message': '用户要求', 'host_user_note': '用户补充',
          'assistant_message': '回复', 'managed_preparation_requested': '首次准备要求',
          'managed_preparation_reply': '首次准备回复',
          'managed_first_task_requested': '首次任务要求',
          'managed_first_task_public_reply': '首次任务回复'}


def _page_id(value):
    require(isinstance(value, str) and 0 < len(value) <= 160
            and value == value.strip() and '\x00' not in value,
            'managed_record_page_id_invalid')
    return value


def _seq(value):
    require(type(value) is int and 1 <= value <= MAX_SEQ, 'managed_record_seq_invalid')
    return value


def _options(payload, *, index=False):
    optional = {'position', 'before_seq', 'after_seq', 'limit'}
    if index:
        optional.add('query')
    else:
        optional.add('around_seq')
    object_fields(payload, {'page_id'}, optional)
    _page_id(payload['page_id'])
    position = payload.get('position', 'latest')
    require(position in ('first', 'latest'), 'managed_record_position_invalid')
    limit = payload.get('limit', DEFAULT_LIMIT)
    require(type(limit) is int and 1 <= limit <= MAX_LIMIT, 'managed_record_limit_invalid')
    cursors = [key for key in ('before_seq', 'after_seq', 'around_seq') if key in payload]
    require(len(cursors) <= 1, 'managed_record_cursor_conflict')
    for key in cursors:
        _seq(payload[key])
    if index:
        query = payload.get('query', '')
        require(isinstance(query, str) and len(query) <= 1000 and '\x00' not in query,
                'managed_record_query_invalid')
    return position, limit


def decorate_event(db, thread, row):
    """The shared full event projection, including the original delivery semantics."""
    event = {'seq': row['seq'], 'kind': row['kind'],
             'data': json.loads(row['data']), 'at': row['at']}
    data = event['data']
    if event['kind'] == 'user_message':
        request_id = data.get('operation_id')
        receipt = db.execute("""SELECT MAX(acknowledged) AS acknowledged,
            MAX(CASE WHEN state<>'not_sent' THEN dispatched END) AS dispatched
            FROM control_attempts WHERE request_id=?""", (request_id,)).fetchone()
        event['delivery'] = ('delivered' if receipt and receipt['acknowledged'] is not None else
                             'confirming' if receipt and receipt['dispatched'] is not None else 'queued')
        event['withdraw'] = {'request_id': request_id} if can_withdraw(db, thread, request_id) else None
        if db.execute('SELECT 1 FROM managed_withdrawals WHERE message_id=?', (request_id,)).fetchone():
            event['delivery'] = 'withdrawn'
    elif event['kind'] == 'host_user_note':
        note_id, request_id = data.get('note_id'), data.get('request_id')
        unread = db.execute('SELECT 1 FROM host_unread_notes WHERE note_id=?', (note_id,)).fetchone()
        event['delivery'] = 'queued_note' if unread else 'delivered_note'
        queued = db.execute('''SELECT q.batch_id,b.accepted_request_id FROM managed_next_round_notes q
          LEFT JOIN managed_next_round_batches b ON b.id=q.batch_id WHERE q.note_id=?''',(note_id,)).fetchone()
        if queued:
            from harness_next_round import delivery
            state=delivery(db,queued['accepted_request_id']) if queued['accepted_request_id'] else 'pending'
            event['delivery']='delivered_note' if state=='sent' else 'queued_note'
            event['delivery_state']=state
            event['delivery_scope']='next_round'
        event['withdraw'] = {'request_id': request_id, 'note_id': note_id} if can_withdraw(
            db, thread, request_id, note_id) else None
        if db.execute('SELECT 1 FROM managed_withdrawals WHERE message_id=?', (note_id,)).fetchone():
            event['delivery'] = 'withdrawn'
    return event


def event_summary(event):
    """Only bounded scalar metadata accompanies a preview; raw nested data stays lazy."""
    data = event['data']
    body = data.get('text', '')
    body = body if isinstance(body, str) else ''
    preview = {}
    for key, value in data.items():
        if key == 'text':
            preview[key] = body[:PREVIEW_LENGTH]
        elif len(preview) < 24 and len(key) <= 80 and (
                value is None or type(value) in (bool, int, float)
                or isinstance(value, str) and len(value) <= 256):
            preview[key] = value
    complete = preview == data
    return {**event, 'data': preview, 'body_loaded': complete,
            'text_length': len(body), 'truncated': not complete, 'full_length_known': True}


def _body_reference(db, page, event):
    """Resolve only the event's explicit original pointer and exact ledger ownership.

    This function reads registry metadata only. Polling history never opens a body.
    """
    if event['kind'] not in REPLY_KINDS:
        return None
    data = event['data']
    body = data.get('text', '')
    body = body if isinstance(body, str) else ''
    pointer = BODY_POINTER.search(body)
    path, sha = (pointer.group(1), pointer.group(2)) if pointer else (data.get('path'), data.get('sha256'))
    if pointer and ((data.get('path') is not None and data['path'] != path)
                    or (data.get('sha256') is not None and data['sha256'] != sha)):
        return {'reason': 'identity_mismatch'}
    if path is not None or sha is not None:
        if not isinstance(path, str) or not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{64}', sha):
            return {'reason': 'identity_mismatch'}
        if event['kind'] in ('managed_preparation_reply', 'managed_first_task_public_reply'):
            saved = db.execute('SELECT * FROM managed_preparation_results WHERE page_id=? AND path=? AND sha256=?',
                               (page['page_id'], path, sha)).fetchone()
            if saved and ((data.get('source_hash') is not None and data['source_hash'] != saved['source_hash'])
                          or (data.get('url') is not None and data['url'] != saved['url'])):
                saved = None
        else:
            saved = db.execute('''SELECT * FROM managed_artifacts WHERE thread_id=? AND request_id=?
                AND path=? AND sha256=? AND source IN (''' + ','.join('?' for _ in BODY_SOURCES) + ') LIMIT 1',
                               (page['thread_id'], data.get('request_id'), path, sha, *BODY_SOURCES)).fetchone()
        if not saved:
            return {'reason': 'identity_mismatch'}
        # Short preparation replies already contain their full source. A BOM in
        # the saved UTF-8 file is the only allowed byte-length difference here.
        # Equal length alone does not establish that the inline text is original.
        size = saved['bytes']
        if not pointer and type(size) is int:
            encoded = body.encode('utf-8')
            original = encoded if size == len(encoded) else b'\xef\xbb\xbf' + encoded if size == len(encoded) + 3 else None
            if original is not None and hashlib.sha256(original).hexdigest() == saved['sha256']:
                return None
        return {'record': dict(saved)}
    # Program-recovered tool summaries are attached by their original item ID;
    # their stored reply can be cut at 46000 characters without a textual path.
    item = data.get('item_id')
    if isinstance(item, str) and item.startswith('closed-summary-'):
        saved = db.execute('''SELECT * FROM managed_artifacts WHERE thread_id=? AND request_id=?
            AND id=? AND source='authenticated_team_final_summary' ''',
                           (page['thread_id'], data.get('request_id'), item)).fetchone()
        if saved and saved['bytes'] > len(body.encode('utf-8')):
            return {'record': dict(saved)}
    return None


def _saved_body(db, reference):
    if reference.get('reason'):
        return None, reference['reason']
    saved = reference['record']
    size = saved['bytes']
    if type(size) is not int or size < 0:
        return None, 'invalid_size'
    if size > MAX_BODY_BYTES:
        return None, 'too_large'
    # SQLite supplies this connection's actual ledger path. No payload path or
    # project root participates, and symlink/../ escapes are rejected after resolve.
    filename = db.execute("SELECT file FROM pragma_database_list WHERE name='main'").fetchone()[0]
    store = Path(filename).resolve().parent / 'managed-results'
    try:
        path = Path(saved['path'])
        if not path.is_absolute() or path.resolve().parent != store or path.name != saved['sha256'] + '.md':
            return None, 'path_outside_store'
        if not path.is_file():
            return None, 'missing'
        if path.stat().st_size > MAX_BODY_BYTES:
            return None, 'too_large'
        with path.open('rb') as source:
            raw = source.read(MAX_BODY_BYTES + 1)
        if len(raw) > MAX_BODY_BYTES:
            return None, 'too_large'
        if len(raw) != size:
            return None, 'size_mismatch'
        if hashlib.sha256(raw).hexdigest() != saved['sha256']:
            return None, 'hash_mismatch'
        return raw.decode('utf-8-sig'), None
    except UnicodeDecodeError:
        return None, 'invalid_utf8'
    except (OSError, RuntimeError):
        return None, 'unreadable'


def _body_revision(page, event, reference):
    """Version the saved identity without opening or hashing an artifact file."""
    data = event['data']
    binding = {'page_id': page['page_id'], 'thread_id': page['thread_id'],
               'seq': event['seq'], 'kind': event['kind']}
    for key in ('request_id', 'operation_id', 'note_id', 'item_id', 'source',
                'source_hash', 'path', 'sha256', 'url'):
        if isinstance(data.get(key), str):
            binding[key] = data[key]
    if reference and reference.get('record'):
        saved = reference['record']
        binding['artifact'] = {key: saved[key] for key in
                               ('id', 'page_id', 'thread_id', 'request_id', 'source',
                                'source_hash', 'path', 'sha256', 'bytes', 'url') if key in saved}
    else:
        body = data.get('text', '')
        body = body if isinstance(body, str) else ''
        binding['text_sha256'] = hashlib.sha256(body.encode('utf-8')).hexdigest()
        if reference:
            binding['unavailable_reason'] = reference.get('reason')
    encoded = json.dumps(binding, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _record_summary(db, page, event):
    result = event_summary(event)
    reference = _body_reference(db, page, event)
    result['body_revision'] = _body_revision(page, event, reference)
    if reference:
        result.update(body_loaded=False, truncated=True, full_length_known=False)
        if reference.get('record'):
            result['body_bytes'] = reference['record']['bytes']
        if reference.get('reason'):
            result.update(body_unavailable=True, body_unavailable_reason=reference['reason'])
    return result


def project_events(db, thread):
    """Compatibility projection: filter after taking the original last 100 rows."""
    rows = db.execute('SELECT seq,kind,data,at FROM events WHERE thread_id=? AND kind IN (' +
                      ','.join('?' for _ in KINDS) + ') ORDER BY seq DESC LIMIT 100',
                      (thread, *KINDS)).fetchall()
    events = [decorate_event(db, thread, row) for row in reversed(rows)]
    return [event for event in events if not (event['kind'] == 'host_queued' and db.execute(
        'SELECT 1 FROM managed_withdrawals WHERE message_id=?',
        (event['data'].get('request_id'),)).fetchone())]


def _where(thread, kinds=RECORD_KINDS, query=''):
    clause = ('e.thread_id=? AND e.kind IN (' + ','.join('?' for _ in kinds) +
              ") AND NOT (e.kind='host_queued' AND EXISTS (SELECT 1 FROM managed_withdrawals w "
              "WHERE w.message_id=json_extract(e.data,'$.request_id')))")
    args = (thread, *kinds)
    if query:
        # instr treats %, _, quotes, and SQL-looking text literally; all input is bound.
        clause += " AND instr(COALESCE(json_extract(e.data,'$.text'),''),?)>0"
        args += (query,)
    return clause, args


def _owned_cursor(db, thread, seq):
    where, args = _where(thread)
    require(db.execute('SELECT 1 FROM events e WHERE ' + where + ' AND e.seq=?',
                       (*args, seq)).fetchone(), 'managed_record_event_missing', 404)


def _window(db, thread, payload, position, limit, *, index=False):
    kinds = INDEX_KINDS if index and not payload.get('query', '') else RECORD_KINDS
    where, args = _where(thread, kinds, payload.get('query', '') if index else '')
    for key in ('before_seq', 'after_seq', 'around_seq'):
        if key in payload:
            _owned_cursor(db, thread, payload[key])
    # Index reads fetch labels only, never full JSON event data into the caller.
    columns = "e.seq,e.kind,e.at,substr(COALESCE(json_extract(e.data,'$.text'),''),1,600) AS text" if index else 'e.seq,e.kind,e.data,e.at'

    def select(suffix='', extra=(), order='ASC', count=limit):
        return db.execute('SELECT ' + columns + ' FROM events e WHERE ' + where + suffix +
                          ' ORDER BY e.seq ' + order + ' LIMIT ?', (*args, *extra, count)).fetchall()

    if 'around_seq' in payload:
        anchor = payload['around_seq']
        left = select(' AND e.seq<?', (anchor,), 'DESC', limit // 2)
        right = select(' AND e.seq>=?', (anchor,), count=limit - len(left))
        if len(left) + len(right) < limit:
            left = select(' AND e.seq<?', (anchor,), 'DESC', limit - len(right))
        rows = list(reversed(left)) + right
    elif 'before_seq' in payload:
        rows = list(reversed(select(' AND e.seq<?', (payload['before_seq'],), 'DESC')))
    elif 'after_seq' in payload:
        rows = select(' AND e.seq>?', (payload['after_seq'],))
    else:
        rows = select(order='ASC' if position == 'first' else 'DESC')
        if position == 'latest':
            rows = list(reversed(rows))
    total = db.execute('SELECT COUNT(*) FROM events e WHERE ' + where, args).fetchone()[0]
    first, last = (rows[0]['seq'], rows[-1]['seq']) if rows else (None, None)
    anchor = payload.get('before_seq', payload.get('after_seq'))
    before = first if first is not None else anchor
    after = last if last is not None else anchor
    has_before = before is not None and bool(db.execute(
        'SELECT 1 FROM events e WHERE ' + where + ' AND e.seq<? LIMIT 1', (*args, before)).fetchone())
    has_after = after is not None and bool(db.execute(
        'SELECT 1 FROM events e WHERE ' + where + ' AND e.seq>? LIMIT 1', (*args, after)).fetchone())
    return rows, {'has_before': has_before, 'has_after': has_after,
                  'total': total, 'first_seq': first, 'last_seq': last}


def _search_window(db, page, payload, position, limit):
    """Search saved bodies locally, retaining at most one page of matching labels."""
    thread, query = page['thread_id'], payload['query']
    where, args = _where(thread)
    for key in ('before_seq', 'after_seq'):
        if key in payload:
            _owned_cursor(db, thread, payload[key])
    take_latest = 'before_seq' in payload or ('after_seq' not in payload and position == 'latest')
    selected = deque(maxlen=limit) if take_latest else []
    total = unavailable = 0
    first_match = last_match = None
    for row in db.execute('SELECT e.seq,e.kind,e.data,e.at FROM events e WHERE ' + where + ' ORDER BY e.seq', args):
        event = {'seq': row['seq'], 'kind': row['kind'], 'at': row['at'], 'data': json.loads(row['data'])}
        body = event['data'].get('text', '')
        body = body if isinstance(body, str) else ''
        reference = _body_reference(db, page, event)
        if reference:
            complete, reason = _saved_body(db, reference)
            if reason:
                unavailable += 1
            else:
                body = complete
        if query not in body:
            continue
        total += 1
        first_match = row['seq'] if first_match is None else first_match
        last_match = row['seq']
        if 'before_seq' in payload and row['seq'] >= payload['before_seq']:
            continue
        if 'after_seq' in payload and row['seq'] <= payload['after_seq']:
            continue
        if take_latest or len(selected) < limit:
            selected.append({'seq': row['seq'], 'kind': row['kind'], 'at': row['at'], 'text': body[:600]})
    rows = list(selected)
    first, last = (rows[0]['seq'], rows[-1]['seq']) if rows else (None, None)
    anchor = payload.get('before_seq', payload.get('after_seq'))
    before = first if first is not None else anchor
    after = last if last is not None else anchor
    return rows, {'total': total, 'first_seq': first, 'last_seq': last,
                  'has_before': before is not None and first_match is not None and first_match < before,
                  'has_after': after is not None and last_match is not None and last_match > after,
                  'unavailable_body_count': unavailable}


def record_history(db, page, payload=None):
    payload = payload or {'page_id': page['page_id']}
    position, limit = _options(payload)
    rows, meta = _window(db, page['thread_id'], payload, position, limit)
    return {'page_id': page['page_id'], 'thread_id': page['thread_id'],
            'events': [_record_summary(db, page, decorate_event(db, page['thread_id'], row)) for row in rows], **meta}


def record_index(db, page, payload):
    position, limit = _options(payload, index=True)
    if payload.get('query', ''):
        rows, meta = _search_window(db, page, payload, position, limit)
    else:
        rows, meta = _window(db, page['thread_id'], payload, position, limit, index=True)
    items = [{'seq': row['seq'], 'kind': row['kind'], 'at': row['at'],
              'label': (' '.join(row['text'].split())[:120] or LABELS.get(row['kind'], row['kind']))}
             for row in rows]
    return {'page_id': page['page_id'], 'thread_id': page['thread_id'], 'items': items, **meta}


def record_body(db, page, payload):
    object_fields(payload, {'page_id', 'seq'})
    _page_id(payload['page_id'])
    seq = _seq(payload['seq'])
    where, args = _where(page['thread_id'])
    row = db.execute('SELECT e.seq,e.kind,e.data,e.at FROM events e WHERE ' + where + ' AND e.seq=?',
                     (*args, seq)).fetchone()
    require(row, 'managed_record_event_missing', 404)
    event = decorate_event(db, page['thread_id'], row)
    reference = _body_reference(db, page, event)
    event['body_revision'] = _body_revision(page, event, reference)
    if reference:
        body, reason = _saved_body(db, reference)
        if reason:
            event.update(body_loaded=False, body_unavailable=True, body_unavailable_reason=reason,
                         full_length_known=False, truncated=True)
        else:
            event['data']['text'] = body
            event.update(body_loaded=True, body_unavailable=False, full_length_known=True,
                         text_length=len(body), truncated=False)
    return {'page_id': page['page_id'], 'thread_id': page['thread_id'], 'event': event}


def browser_record(state, op, payload):
    """An independent read-only snapshot, entered before any shared writer lock."""
    if op == 'record-body':
        object_fields(payload, {'page_id', 'seq'})
        _page_id(payload['page_id'])
        _seq(payload['seq'])
    else:
        _options(payload, index=op == 'record-index')
    uri = state.path.resolve().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(uri, uri=True, timeout=10)) as db:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN')
        page = db.execute('SELECT page_id,thread_id FROM managed_pages WHERE page_id=?',
                          (payload['page_id'],)).fetchone()
        require(page, 'managed_page_missing', 404)
        return {'record-history': record_history, 'record-index': record_index,
                'record-body': record_body}[op](db, page, payload)
