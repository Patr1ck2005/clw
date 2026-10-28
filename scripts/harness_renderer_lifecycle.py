"""Read-only carrier lifetime, independent of the retained business outcome.

A yielded/attention request can stay unfinished for days after its original
browser result was saved. Keeping that request is not a reason to recreate a
renderer. Unknown sends and later attempts still need their original receipt.
"""
import json
import re

FINISHED_REPLIES = {'completed', 'blocked', 'cancelled', 'needs_attention', 'yielded'}


def read_context(db):
    # One current-work snapshot per list, rather than rescanning cumulative
    # operations/receipts for every historical page. No history count limit.
    return {
        'leases': {r[0] for r in db.execute('SELECT thread_id FROM host_team_leases')},
        'operations': {r[0] for r in db.execute("SELECT DISTINCT thread_id FROM operations WHERE thread_id IS NOT NULL AND state IN ('reserved','dispatching','unknown')")},
        'attempts': {r[0] for r in db.execute("SELECT DISTINCT thread_id FROM control_attempts WHERE state IN ('dispatching','sent','unknown')")},
        'results': {r[0] for r in db.execute('''SELECT DISTINCT a.thread_id FROM control_attempts a
            JOIN host_requests q ON q.id=a.request_id AND q.thread_id=a.thread_id
            LEFT JOIN control_browser_receipts b ON b.attempt_id=a.id AND b.request_id=a.request_id
            AND b.thread_id=a.thread_id WHERE a.state='acknowledged'
            AND (b.attempt_id IS NOT NULL OR q.phase IN ('queued','processing','suspended','unknown'))
            AND (b.result_hash IS NULL OR b.completed IS NULL)''')},
    }


def project_lifecycle(db, page, latest=None, context=None):
    context = read_context(db) if context is None else context
    thread_id = page['thread_id']
    if latest is None and thread_id:
        latest = db.execute("""SELECT id,phase FROM host_requests WHERE thread_id=?
            ORDER BY phase IN ('queued','processing','suspended') DESC,created_at DESC LIMIT 1""",
                            (thread_id,)).fetchone()
    request = db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',
                         (latest['id'], thread_id)).fetchone() if latest else None
    attempts = db.execute('''SELECT a.*,b.claim_id AS receipt_claim,b.result_hash,
        b.completed,b.reply_id,h.response AS saved_response FROM control_attempts a LEFT JOIN control_browser_receipts b
        ON b.attempt_id=a.id AND b.request_id=a.request_id AND b.thread_id=a.thread_id
        LEFT JOIN host_replies h ON h.id=b.reply_id AND h.request_id=a.request_id
        WHERE a.request_id=? ORDER BY a.offered DESC,a.id DESC''',
                          (request['id'],)).fetchall() if request else []
    result = {'version': 1, 'page_id': page['page_id'], 'thread_id': thread_id,
              'request_id': request['id'] if request else None,
              'request_phase': request['phase'] if request else None,
              'attempt_id': attempts[0]['id'] if attempts else None}

    def state(required, reason, **evidence):
        return {**result, 'required': required, 'reason': reason, **evidence}

    if thread_id in context['leases']:
        return state(True, 'execution_lease')
    if thread_id in context['operations']:
        return state(True, 'original_operation_pending')
    if thread_id in context['attempts']:
        return state(True, 'original_attempt_pending')
    # An older accepted result must not be hidden by a later terminal request.
    if thread_id in context['results']:
        return state(True, 'original_result_pending')
    thread = db.execute('SELECT status,active_turn FROM threads WHERE id=?',
                        (thread_id,)).fetchone()
    if thread and (thread['status'] in ('working', 'stopping', 'unknown') or
                   thread['active_turn'] not in (None, request['id'] if request else None)):
        return state(True, 'current_thread_execution')
    if request and request['phase'] == 'unknown':
        return state(True, 'original_request_unknown')

    if request and request['phase'] in ('processing', 'suspended', 'queued'):
        saved = []
        for attempt in attempts:
            if attempt['state'] == 'not_sent' and attempt['acknowledged'] is None:
                continue
            if attempt['state'] != 'acknowledged':
                return state(True, 'original_attempt_unsettled')
            try:response = json.loads(attempt['saved_response']) if attempt['saved_response'] else None
            except (ValueError, TypeError):response = None
            if not (attempt['result_hash'] and re.fullmatch(r'[a-f0-9]{64}', attempt['result_hash']) and
                    type(attempt['completed']) in (int, float) and isinstance(response, dict) and
                    response.get('request_id') == request['id'] and response.get('thread_id') == thread_id and
                    response.get('reply_id') == attempt['reply_id'] and response.get('phase') in FINISHED_REPLIES and
                    request['claim_id'] and attempt['receipt_claim'] == request['claim_id']):
                return state(True, 'original_receipt_unverified')
            saved.append((attempt['id'], response['phase']))
        if request['phase'] == 'queued':
            if request['claim_id'] is None and attempts and not saved:
                return state(False, 'original_attempt_not_sent')
            return state(True, 'original_queue_unsettled')
        if saved and thread:
            latest_attempt, outcome = saved[0]
            if thread['active_turn'] is None or (request['phase'] == 'suspended' and
                    thread['status'] == 'waiting_children' and thread['active_turn'] == request['id'] and
                    outcome == 'yielded'):
                return state(False, 'carrier_reply_saved', receipt_attempt_id=latest_attempt, outcome=outcome)
        if request['phase'] == 'suspended' and not attempts and thread and thread['status'] == 'waiting_children':
            settings = json.loads(page['settings'])
            receipt = db.execute("""SELECT e.seq FROM events e JOIN events w
                ON w.seq=json_extract(e.data,'$.source_event_seq') AND w.thread_id=e.thread_id
                AND w.kind='host_waiting_children' AND json_extract(w.data,'$.request_id')=?
                WHERE e.thread_id=? AND e.kind='managed_first_turn_reconciled'
                AND json_extract(e.data,'$.request_id')=? AND json_extract(e.data,'$.outcome')='yielded'
                AND json_extract(e.data,'$.proof')='own_session_receipt_and_unique_sent_bootstrap'
                AND e.seq>w.seq ORDER BY e.seq DESC LIMIT 1""",
                                 (request['id'], thread_id, request['id'])).fetchone()
            if (request['claim_id'] == 'clw-first-claim-'+page['page_id'].removeprefix('web-') and
                    receipt and settings.get('first_task_request_id') == request['id'] and
                    settings.get('first_task_outcome') == 'yielded'):
                return state(False, 'first_carrier_yield_saved', event_sequence=receipt['seq'])
        return state(True, 'original_carrier_unsettled')

    if page['phase'] != 'bound' and (page['bootstrap_state'] in ('sending', 'sent', 'unknown') or
                                    page['phase'] == 'receiver_enrolled'):
        # The renderer decides whether the original conversation address still
        # exists. Loading a new homepage cannot monitor this unknown old send.
        return state(True, 'bootstrap_original_page_only')
    return state(False, 'no_current_carrier')
