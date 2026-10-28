"""Bounded, read-only Local-MCP metadata for one enrolled Web conversation.

The union records a hash of a tool call's session_id argument. Matching that
hash to an enrolled page identifies a Workflow Session, not an exact browser
turn or proof that a reported file operation succeeded.
"""
from datetime import datetime
from hashlib import sha256
from pathlib import Path
import json
import re

EVENTS = frozenset(('mcp_call_started', 'mcp_call_finished', 'mcp_transport_interrupted',
                    'mcp_client_disconnected', 'mcp_response_sent', 'mcp_call_details'))
CALL = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z', re.I)
TOOL = re.compile(r'[A-Za-z][A-Za-z0-9_.:-]{0,95}\Z')
RESULT = re.compile(r'result_[a-f0-9]{32}\Z')
MAX_BYTES = 128 * 1024
MAX_EVENTS = 160


def _tail(path):
    """Read at most one journal window and discard incomplete edge records."""
    if path.is_symlink() or not path.is_file():
        return (), False
    with path.open('rb') as stream:
        stream.seek(0, 2)
        size = stream.tell()
        length = min(size, MAX_BYTES)
        stream.seek(size - length)
        raw = stream.read(length)
    if size > length:
        raw = raw.partition(b'\n')[2]
    if not raw.endswith(b'\n'):
        raw = raw.rpartition(b'\n')[0]
    return raw.splitlines(), size > length


def _event(raw, session_hash, since):
    if len(raw) > 2048:
        return None
    try:
        row = json.loads(raw)
    except (ValueError, UnicodeError):
        return None
    if not isinstance(row, dict) or row.get('sessionHash') != session_hash or row.get('route') != 'webcodex':
        return None
    event, tool, call_id, at = (row.get(key) for key in ('event', 'tool', 'callId', 'at'))
    if (event not in EVENTS or not isinstance(tool, str) or not TOOL.fullmatch(tool) or
            not isinstance(call_id, str) or not CALL.fullmatch(call_id) or not isinstance(at, str)):
        return None
    try:
        when = datetime.fromisoformat(at.replace('Z', '+00:00'))
        if when.tzinfo is None or when.timestamp() < since:
            return None
    except (ValueError, OverflowError):
        return None
    result = {'id': call_id + ':' + event, 'at': at, 'callId': call_id,
              'event': event, 'tool': tool, 'route': 'webcodex'}
    if event == 'mcp_call_details':
        if row.get('part') not in ('arguments', 'response'):
            return None
        result['part'] = row['part']
        result['id'] += ':' + row['part']
        if isinstance(row.get('resultId'), str) and RESULT.fullmatch(row['resultId']):
            result['resultId'] = row['resultId']
        if type(row.get('complete')) is bool:
            result['complete'] = row['complete']
        if isinstance(row.get('code'), str) and re.fullmatch(r'call_details_[a-z_]{1,64}', row['code']):
            result['code'] = row['code']
    if isinstance(row.get('httpStatus'), int) and 100 <= row['httpStatus'] <= 599:
        result['httpStatus'] = row['httpStatus']
    if isinstance(row.get('durationMs'), int) and 0 <= row['durationMs'] <= 7 * 86400000:
        result['durationMs'] = row['durationMs']
    if type(row.get('itemFailureCount')) is int and 0 <= row['itemFailureCount'] <= 1000000:
        result['itemFailureCount'] = row['itemFailureCount']
    for key in ('bodyInspected', 'rpcError', 'isError', 'applicationSuccess'):
        if type(row.get(key)) is bool:
            result[key] = row[key]
    return result


def session_activity(root, session_id, created):
    """Project only the page's own Session metadata; never return its identity."""
    result = {'source': 'mcp_union_metadata', 'scope': 'bound_session_argument',
              'turnAttribution': 'unavailable', 'history': 'bounded_rotating_journal',
              'windowTruncated': False, 'events': []}
    if not isinstance(session_id, str) or not session_id:
        return result
    session_hash = sha256(session_id.encode('utf-8')).hexdigest()
    base = Path(root) / '.local' / 'codex-web-bridge'
    files = (base / 'mcp-activity.jsonl.previous', base / 'mcp-activity.jsonl')
    seen = set()
    for path in files:
        try:
            lines, truncated = _tail(path)
        except OSError:
            result['windowTruncated'] = True
            continue
        result['windowTruncated'] |= truncated
        for raw in lines:
            event = _event(raw, session_hash, float(created))
            if event and event['id'] not in seen:
                seen.add(event['id'])
                result['events'].append(event)
    if len(result['events']) > MAX_EVENTS:
        result['windowTruncated'] = True
        result['events'] = result['events'][-MAX_EVENTS:]
    saved = {}
    for event in result['events']:
        if event['event'] != 'mcp_call_details':
            continue
        reference = event.get('resultId')
        available = bool(reference and (base / 'result-cache' / reference / 'meta.json').is_file())
        value = {'available': available}
        if reference:
            value['result_id'] = reference
        if 'complete' in event:
            value['complete'] = event['complete']
        if not available:
            value['reason'] = event.get('code') or ('original_call_details_expired' if reference else 'original_call_details_not_recorded')
        saved.setdefault(event['callId'], {})[event['part']] = value
    for event in result['events']:
        parts = saved.get(event['callId'], {})
        event['details'] = {'available': any(part.get('available') for part in parts.values()),
            **{name: parts.get(name, {'available': False, 'reason': 'original_call_details_not_recorded'})
               for name in ('arguments', 'response')}}
    return result
