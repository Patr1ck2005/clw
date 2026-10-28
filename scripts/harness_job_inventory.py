"""Bounded original-Session reads without a lifetime history limit.

A complete short inventory remains useful for checking unknown execution.
When history is capped, retain that sample and query every active status and
the terminal statuses that can carry an unknown outcome in the same Session.
Known original Job IDs are still checked separately by callers.
"""

ACTIVE = ('queued', 'agent_queued', 'started', 'running', 'stop_requested', 'recovering')
TERMINAL = ('completed', 'failed', 'stopped', 'timeout', 'timed_out', 'lost', 'cancelled')
# The canonical Runner validator permits OutcomeUnknown only on these states.
# Querying them separately prevents a recent completed-history sample from
# hiding a lost command while leaving normal completed history unbounded.
UNCERTAIN = ('failed', 'lost')


class JobInventoryError(ValueError):
    pass


def job_terminal(job):
    if not isinstance(job, dict):
        return False
    state, execution = job.get('status'), job.get('command_execution_state')
    if execution == 'completed':
        return state in ('completed', 'failed', 'stopped', 'cancelled')
    if execution == 'not_started':
        return state in ('failed', 'stopped', 'cancelled', 'lost') and job.get('started_at') is None
    if execution == 'timed_out':
        return state in ('timeout', 'timed_out')
    return False


def _output(reply, session, status=None):
    if not isinstance(reply, dict) or reply.get('isError'):
        raise JobInventoryError('original_jobs_unknown')
    data = reply.get('structuredContent', {})
    if not isinstance(data, dict) or data.get('success') is not True or data.get('error') is not None:
        raise JobInventoryError('original_jobs_unknown')
    out = data.get('output', {})
    rows = out.get('jobs') if isinstance(out, dict) else None
    if (not isinstance(rows, list) or len(rows) > 100
            or type(out.get('count')) is not int or out['count'] != len(rows)
            or type(out.get('matched_count')) is not int or out['matched_count'] < len(rows)
            or type(out.get('truncated')) is not bool
            or out['truncated'] != (out['matched_count'] > len(rows))
            or (out['truncated'] and len(rows) != 100)
            or any(not isinstance(j, dict) or j.get('session_id') != session
                   or j.get('status') not in (ACTIVE + TERMINAL)
                   or (status is not None and j.get('status') != status) for j in rows)):
        raise JobInventoryError('original_jobs_unknown')
    return out


def _safe(out):
    return {k: out[k] for k in ('count', 'matched_count', 'truncated')} | {
        'jobs': [{k: j.get(k) for k in ('id', 'job_id', 'session_id', 'status',
                                     'command_execution_state', 'started_at')} for j in out['jobs']]}


def read_session_inventory(root, session, runtime_read):
    first = runtime_read(root, 'list_jobs', {'session_id': session, 'limit': 100})
    sample = _output(first, session)
    if not sample['truncated']:
        return first
    # A visible unknown command is never made terminal by an active-status read.
    if any(j['status'] in TERMINAL and not job_terminal(j) for j in sample['jobs']):
        raise JobInventoryError('original_jobs_unknown')
    queries = []
    for status in ACTIVE + UNCERTAIN:
        value = runtime_read(root, 'list_jobs', {'session_id': session, 'status': status, 'limit': 100})
        queries.append({'status': status, 'output': _safe(_output(value, session, status))})
    rows = [j for q in queries for j in q['output']['jobs']]
    matched = sum(q['output']['matched_count'] for q in queries)
    return {'structuredContent': {'success': True, 'error': None, 'output': {
        'scope': 'session_active_statuses', 'session_id': session,
        'history_sample': _safe(sample), 'active_queries': queries[:len(ACTIVE)],
        'uncertain_queries': queries[len(ACTIVE):],
        'jobs': rows, 'count': len(rows), 'matched_count': matched,
        'truncated': matched != len(rows)}}}


def checked_inventory(reply, session):
    data = reply.get('structuredContent', {}) if isinstance(reply, dict) else {}
    out = data.get('output', {}) if isinstance(data, dict) else {}
    if not isinstance(out, dict) or out.get('scope') != 'session_active_statuses':
        return _output(reply, session)
    if (reply.get('isError') or data.get('success') is not True or data.get('error') is not None
            or out.get('session_id') != session):
        raise JobInventoryError('original_jobs_unknown')
    def wrap(value):
        return {'structuredContent': {'success': True, 'error': None, 'output': value}}
    history = _output(wrap(out.get('history_sample')), session)
    if (not history['truncated']
            or any(j['status'] in TERMINAL and not job_terminal(j) for j in history['jobs'])):
        raise JobInventoryError('original_jobs_unknown')
    active, uncertain = out.get('active_queries'), out.get('uncertain_queries')
    if (not isinstance(active, list) or len(active) != len(ACTIVE)
            or not isinstance(uncertain, list) or len(uncertain) != len(UNCERTAIN)):
        raise JobInventoryError('original_jobs_unknown')
    checked = []
    for status, query in zip(ACTIVE + UNCERTAIN, active + uncertain):
        if not isinstance(query, dict) or query.get('status') != status:
            raise JobInventoryError('original_jobs_unknown')
        checked.append(_output(wrap(query.get('output')), session, status))
    rows = [j for q in checked for j in q['jobs']]
    matched = sum(q['matched_count'] for q in checked)
    if (out.get('jobs') != rows or type(out.get('count')) is not int or out['count'] != len(rows)
            or type(out.get('matched_count')) is not int or out['matched_count'] != matched
            or type(out.get('truncated')) is not bool or out['truncated'] != (matched != len(rows))):
        raise JobInventoryError('original_jobs_unknown')
    return out


def inventory_in_progress(reply, session):
    return any(j['status'] in ACTIVE for j in checked_inventory(reply, session)['jobs'])


def inventory_idle(reply, session):
    try:
        out = checked_inventory(reply, session)
        return not out['truncated'] and all(job_terminal(j) for j in out['jobs'])
    except JobInventoryError:
        return False
