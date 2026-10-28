"""Read-only eligibility evidence for clearing an unsent bootstrap app query.

This is not Send, bootstrap retry or pause-resume authority. It inspects only
the original reservation and its own durable guards; parent execution can
continue without invalidating a harmless query-clear contract.
"""
import hashlib
import json

from harness_state import canonical


def _bounded(value, limit):
    return value[:limit] if isinstance(value, str) else None


def _sha(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def candidate(managed, db, page_id):
    """Return a bounded projection using SELECT statements only.

    Do not call managed.paused(): its inherited parent state concerns later
    execution, whereas this check grants no dispatch, admission or resume.
    """
    result = {
        'eligible': False, 'code': 'page_missing',
        'page_id': _bounded(page_id, 80), 'account': None, 'root': None,
        'phase': None, 'bootstrap_state': None, 'thread_id': None,
        'own_paused': False, 'issue_kind': None, 'budget_admitted': False,
        'contract_sha256': None,
    }
    page = db.execute('SELECT * FROM managed_pages WHERE page_id=?', (page_id,)).fetchone()
    if not page:
        return result
    result.update(page_id=_bounded(page['page_id'], 80), root=_bounded(page['root'], 4096),
                  phase=_bounded(page['phase'], 80), bootstrap_state=_bounded(page['bootstrap_state'], 80),
                  thread_id=_bounded(page['thread_id'], 160), own_paused=bool(page['paused']))
    try:
        settings = json.loads(page['settings'])
        if not isinstance(settings, dict) or not isinstance(settings.get('first_turn_instructions', ''), str):
            raise ValueError('settings_shape')
        if not isinstance(page['bootstrap_text'], str):
            raise ValueError('bootstrap_text_shape')
    except (TypeError, ValueError):
        result['code'] = 'invalid_settings'
        return result

    result['account'] = _bounded(settings.get('account', 'B'), 8)
    issue = db.execute('SELECT kind FROM managed_page_issues WHERE page_id=?', (page_id,)).fetchone()
    result['issue_kind'] = _bounded(issue['kind'], 80) if issue else None
    result['budget_admitted'] = bool(db.execute(
        'SELECT 1 FROM managed_bootstrap_budget WHERE page_id=?', (page_id,)).fetchone())
    stop = db.execute('SELECT resumed FROM managed_stops WHERE page_id=?', (page_id,)).fetchone()
    unresumed_stop = bool(stop and not stop['resumed'])
    handoff = bool(db.execute(
        'SELECT 1 FROM managed_handoffs WHERE source_page=? OR successor_page=? LIMIT 1',
        (page_id, page_id)).fetchone())
    # A missing thread is not a predicate for all NULL/unknown requests.
    # Partial receiver state is checked through this exact target only.
    request_present = bool(db.execute(
        'SELECT 1 FROM host_requests r JOIN host_bindings b ON b.thread_id=r.thread_id '
        'WHERE b.target_id=? LIMIT 1', (page['target_id'],)).fetchone())
    if page['thread_id']:
        request_present = request_present or bool(db.execute(
            'SELECT 1 FROM host_requests WHERE thread_id=? LIMIT 1', (page['thread_id'],)).fetchone())
    if settings.get('first_task_request_id'):
        request_present = request_present or bool(db.execute(
            'SELECT 1 FROM host_requests WHERE id=?', (settings['first_task_request_id'],)).fetchone())

    # Bind all own reservation fields except the observation clock. Settings
    # retain their exact nested structure; sensitive bodies are digest-only.
    contract_page = {key: page[key] for key in page.keys() if key not in ('seen', 'settings', 'bootstrap_text')}
    contract_settings = {key: value for key, value in settings.items() if key not in ('seen', 'first_turn_instructions')}
    contract_settings['first_turn_instructions_sha256'] = _sha(settings.get('first_turn_instructions', ''))
    contract = {'version': 1, 'page': contract_page, 'settings': contract_settings,
                'bootstrap_text_sha256': _sha(page['bootstrap_text']),
                'guards': {'issue_kind': issue['kind'] if issue else None,
                           'budget_admitted': result['budget_admitted'], 'unresumed_stop': unresumed_stop,
                           'handoff': handoff, 'host_request_present': request_present}}
    try:
        result['contract_sha256'] = _sha(canonical(contract))
    except (TypeError, ValueError):
        result['code'] = 'invalid_contract'
        return result

    checks = (
        (result['account'] in ('A', 'B'), 'account_invalid'),
        (page['phase'] == 'reserved', 'reservation_not_reserved'),
        (page['bootstrap_state'] == 'pending', 'bootstrap_not_pending'),
        (page['paused'] == 1, 'reservation_not_paused'),
        (page['thread_id'] is None, 'original_thread_present'),
        (not request_present, 'original_host_request_present'),
        (issue is not None and issue['kind'] == 'control_failed', 'issue_not_control_failed'),
        (not result['budget_admitted'], 'bootstrap_budget_admitted'),
        (not any(key in settings for key in ('bootstrap_sending_at', 'bootstrap_sent_at', 'bootstrap_unknown_at')),
         'bootstrap_send_evidence_present'),
        (not unresumed_stop, 'original_stop_not_resumed'),
        (not handoff, 'original_handoff_present'),
    )
    for allowed, code in checks:
        if not allowed:
            result['code'] = code
            return result
    result.update(eligible=True, code='bootstrap_query_reset_eligible')
    return result
