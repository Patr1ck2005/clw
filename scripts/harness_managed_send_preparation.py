"""One-use recovery of a positively unclicked, already prepared browser Send.

This is a supervised-process operation, never a model/HTTP command. It returns
the original grant without dispatching again or altering requests, claims, runs,
attempts or Jobs. A lost authorization response remains an original operation
to inspect; reading the same receipt cannot issue another authorization.
"""
from __future__ import annotations

import hashlib
import json
import re

from harness_accounts import connector_name
from harness_managed_models import effort_key, model_key
from harness_state import canonical, require
from harness_team_common import object_fields

KIND = 'managed_send_preparation_recovery_authorized'
LEGACY_INCIDENT = 'example-send-preparation'
LEGACY = {'store_id': '4de90d9ee0ab0d69a6d2da8a9106a0a2', 'page_id': 'web-00000000-0000-4000-8000-000000000001', 'thread_id': 'hthr_763093d42544fb90748db2517db64eb5', 'request_id': '00000000-0000-4000-8000-000000000002', 'attempt_id': 'control_aab5e7d3192a7478e9e18276d675a2a1', 'previous_attempt': 'control_11acf999a3fd29f273e586105cff8941', 'url': 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000003', 'account': 'A', 'run_id': 'clw-run-111771f2957337492f14f2fec2d0e098', 'root': 'c:\\clw-examples\\send-preparation', 'session_id': 'wc_sess_example_legacy', 'app_instance_id': '9551dee447402e71dddb16682a95774b', 'user_sha256': 'dad67577e56d1e025ce0ac11dacc425ecad43ddb167d13bc261c33b741cb0480', 'assistant_sha256': '8e0fa8e5fc3719b4564413fca9b2b52e5b8d414ad5c12a3280532cd4fa9267c1', 'error_at': 1767225600000}
LEGACY_FILES = {'web-driver-before.cjs': '532b09ea75057db786aa64b9c978157c1320f06bdd94fcc72e23393cbf24a553', 'driver-page-status.json': 'e1e9c1db439241ef5dbdb15a06d5e3add27a09a3194380d80b1a780887d78e37', 'task-observation.json': '0407410307073446a7ec58bae87fa82a65d93d3a141b9a0d80c71c50c467321e', 'task-status.json': 'c008c9029cc5928ed3b36499d84b997e18bc1d4fd115d522db70c174bf9009e3', 'app-state.json': '9436b891251f661c8578d71bf5f2487dd23dd7255ee49bc7bce5437cc5c4464d'}
PRECLICK_CODES = {
    'connector_composer_unavailable', 'connector_selection_mismatch',
    'editor_missing_or_user_draft', 'connector_query_changed',
    'connector_menu_not_unique', 'connector_not_available',
    'connector_selection_unconfirmed', 'connector_menu_not_unique_or_query_changed',
    'connector_row_not_unique_or_disabled', 'editor_prompt_mismatch',
    'editor_focus_failed', 'editor_selection_missing', 'editor_selection_foreign',
    'editor_insert_rejected', 'send_baseline_changed',
    'send_preparation_query_changed', 'send_preparation_query_clear_unconfirmed',
}


def sha(value):
    return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else value).hexdigest()


def _digest(value):
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value),
            'managed_send_preparation_digest_invalid')
    return value


def _browser(page, settings, attempt, prepared, value, *, allow_legacy_assistant_rebase=False):
    required = {'url', 'account', 'model', 'effort', 'user_turn_sha256',
                'assistant_turn_sha256', 'attempt_marker', 'attempt_marker_count',
                'editor_ready', 'controls_known', 'history_at_latest', 'generating',
                'composing', 'approval_required', 'access_limited', 'blocked',
                'login_required', 'stopped', 'composer'}
    object_fields(value, required, {'baseline_previous_marker', 'baseline_previous_marker_count',
                                    'failure', 'complete'})
    require(value['url'] == page['url'] and value['account'] == settings.get('account', 'B'),
            'managed_send_preparation_browser_identity_changed', 409)
    require(model_key(value['model']) == model_key(page['model']) and
            effort_key(value['effort']) == effort_key(page['effort']),
            'managed_send_preparation_model_changed', 409)
    require(all(value[key] is True for key in ('editor_ready', 'controls_known', 'history_at_latest')) and
            all(value[key] is False for key in ('generating', 'composing', 'approval_required',
                'access_limited', 'blocked', 'login_required', 'stopped')),
            'managed_send_preparation_browser_not_idle', 409)
    require(value['attempt_marker'] == f'[CLW:{attempt["id"]}]' and
            type(value['attempt_marker_count']) is int and value['attempt_marker_count'] == 0,
            'managed_send_preparation_marker_already_present', 409)
    assistant_hash = _digest(value['assistant_turn_sha256'])
    require(_digest(value['user_turn_sha256']) == attempt['user_hash'] and
            (assistant_hash == prepared['assistant_before_hash'] or allow_legacy_assistant_rebase),
            'managed_send_preparation_public_baseline_changed', 409)
    composer = object_fields(value['composer'], {'editor_count', 'text_bytes', 'text_sha256', 'selected'})
    connector = connector_name(value['account'])
    query = '@' + connector
    require(type(composer['editor_count']) is int and composer['editor_count'] == 1 and
            type(composer['text_bytes']) is int and
            (composer['text_bytes'], _digest(composer['text_sha256'])) in
                ((0, sha('')), (len(query.encode('utf-8')), sha(query))) and
            composer['selected'] in ([], [connector]),
            'managed_send_preparation_user_draft_preserved', 409)


def _legacy_reload_baseline(browser, prepared):
    """A reloaded failed assistant DOM may remount, while its original user is stable."""
    require(prepared['assistant_before_hash'] == LEGACY['assistant_sha256'] and
            browser['user_turn_sha256'] == LEGACY['user_sha256'] and
            browser['assistant_turn_sha256'] == sha(
                f'managed-public:[CLW:{LEGACY["previous_attempt"]}]:failed-assistant:无法思考') and
            browser.get('baseline_previous_marker') == f'[CLW:{LEGACY["previous_attempt"]}]' and
            type(browser.get('baseline_previous_marker_count')) is int and
            browser['baseline_previous_marker_count'] == 1 and
            browser.get('failure') == '无法思考' and browser.get('complete') is False,
            'managed_send_preparation_legacy_failed_turn_changed', 409)


def _legacy(managed, page, binding, request, attempt, run, browser, prepared):
    """The old driver had no structured proof; this one incident has a source fence.

    In this exact archived source send_page_identity_changed only comes from
    requireOpen, and every call is before sendInvoked/the DOM Send invocation.
    No arbitrary old error string or caller-supplied path grants authority.
    """
    require(managed.state.id == LEGACY['store_id'] and
            page['page_id'] == LEGACY['page_id'] and page['thread_id'] == LEGACY['thread_id'] and
            request['id'] == LEGACY['request_id'] and attempt['id'] == LEGACY['attempt_id'] and
            run['id'] == LEGACY['run_id'] and page['root'].lower() == LEGACY['root'] and
            page['url'] == LEGACY['url'] and browser['account'] == LEGACY['account'] and
            binding['spec'].get('session_id') == LEGACY['session_id'] and attempt['epoch'] == -1 and
            browser['user_turn_sha256'] == LEGACY['user_sha256'] and
            prepared['assistant_before_hash'] == LEGACY['assistant_sha256'],
            'managed_send_preparation_legacy_identity_changed', 409)
    directory = managed.host.root / '.local' / 'camp-hourly-20261006T2341'
    artifacts = {}
    for name, expected in LEGACY_FILES.items():
        path = directory / name
        require(path.is_file() and path.stat().st_size <= 150000, 'managed_send_preparation_legacy_proof_missing', 409)
        raw = path.read_bytes()
        require(sha(raw) == expected, 'managed_send_preparation_legacy_source_changed', 409)
        if name.endswith('.json'):
            artifacts[name] = json.loads(raw.decode('utf-8-sig'))
    archived = artifacts['driver-page-status.json']
    observation = archived['observation']
    public = artifacts['task-observation.json']['receipt']['result']
    status = artifacts['task-status.json']['receipt']['result']
    app = artifacts['app-state.json']
    require(archived['id'] == page['page_id'] and archived['root'] == page['root'] and
            observation['error'] == '原网页、账号或请求身份已变化；未再次发送，原请求保留。' and
            observation['errorAt'] == LEGACY['error_at'] and
            0 < observation['errorAt'] / 1000 - attempt['dispatched'] < 2 and
            observation['attemptId'] == LEGACY['previous_attempt'] and
            public['url'] == page['url'] and public['page_id'] == page['page_id'] and
            public['user_turn_sha256'] == attempt['user_hash'] and
            public['assistant_turn_sha256'] == prepared['assistant_before_hash'] and
            public['snapshot']['attemptMarker'] == f'[CLW:{LEGACY["previous_attempt"]}]' and
            public['snapshot']['attemptMarkerCount'] == 1 and
            public['composer']['text_utf8_bytes'] == 10 and
            public['composer']['text_sha256'] == sha('@Local-MCP') and
            status['latest_request']['id'] == request['id'] and
            status['attempt']['id'] == attempt['id'] and status['attempt']['state'] == 'dispatching' and
            status['attempt']['acknowledged'] is None and
            app['app_instance_id'] == LEGACY['app_instance_id'] and
            app['runtime']['store_id'] == managed.state.id,
            'managed_send_preparation_legacy_proof_invalid', 409)
    return sha(canonical(LEGACY_FILES)), LEGACY['error_at']


def _structured(page, request, attempt, browser, proof):
    fields = {'page_id', 'thread_id', 'request_id', 'attempt_id', 'account', 'url', 'document_generation',
              'connection_generation', 'user_turn_sha256', 'assistant_turn_sha256', 'marker',
              'stage', 'send_invoked', 'started_at', 'at', 'error_code', 'known_not_sent'}
    object_fields(proof, fields)
    require(proof['page_id'] == page['page_id'] and proof['thread_id'] == page['thread_id'] and
            proof['request_id'] == request['id'] and
            proof['attempt_id'] == attempt['id'] and proof['url'] == page['url'] and
            proof['account'] == browser['account'] and proof['marker'] == browser['attempt_marker'] and
            proof['user_turn_sha256'] == browser['user_turn_sha256'] and
            proof['assistant_turn_sha256'] == browser['assistant_turn_sha256'] and
            proof['send_invoked'] is False and proof['known_not_sent'] is True and
            proof['error_code'] in PRECLICK_CODES and
            proof['stage'] in ('connector-preparation', 'body-preparation', 'body-verification',
                               'pre-send-verification', 'recovery-preparation') and
            type(proof['document_generation']) is int and proof['document_generation'] > 0 and
            type(proof['connection_generation']) is int and proof['connection_generation'] > 0 and
            type(proof['started_at']) in (int, float) and type(proof['at']) in (int, float) and
            attempt['dispatched'] * 1000 <= proof['started_at'] <= proof['at'],
            'managed_send_preparation_positive_preclick_proof_required', 409)
    return sha(canonical(proof)), proof['started_at']


def authorize(managed, db, payload):
    object_fields(payload, {'page_id', 'url', 'operation_id', 'expected_request_id',
                           'expected_attempt_id', 'browser', 'proof'})
    operation_id = managed.host.identifier(payload['operation_id'])
    fingerprint = sha(canonical(payload))
    db.execute('''CREATE TABLE IF NOT EXISTS managed_send_preparation_recoveries(
        operation_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,request_id TEXT NOT NULL,
        proof_sha256 TEXT NOT NULL,fingerprint TEXT NOT NULL,authorized_at REAL NOT NULL,
        response TEXT NOT NULL,UNIQUE(attempt_id,proof_sha256))''')
    prior = db.execute('SELECT * FROM managed_send_preparation_recoveries WHERE operation_id=?', (operation_id,)).fetchone()
    if prior:
        require(prior['fingerprint'] == fingerprint, 'managed_send_preparation_operation_conflict', 409)
        return {**json.loads(prior['response']), 'authorized': False, 'authorization_already_issued': True}
    page = db.execute('SELECT * FROM managed_pages WHERE page_id=?', (payload['page_id'],)).fetchone()
    require(page and page['phase'] == 'bound' and page['url'] == payload['url'],
            'managed_send_preparation_page_changed', 409)
    binding = managed.host.binding(db, thread=page['thread_id'])
    request = db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',
                         (payload['expected_request_id'], page['thread_id'])).fetchone()
    latest = db.execute("SELECT id FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended') ORDER BY created_at DESC,rowid DESC LIMIT 1", (page['thread_id'],)).fetchone()
    require(request and latest and latest['id'] == request['id'] and request['phase'] == 'processing' and
            request['claim_id'] and not request['cancel_requested'],
            'managed_send_preparation_request_changed', 409)
    require(not managed.host.future_paused(db, binding, request), 'managed_send_preparation_paused', 409)
    require(not db.execute('SELECT 1 FROM managed_stops WHERE page_id=? AND resumed=0',
                          (page['page_id'],)).fetchone(), 'managed_send_preparation_explicit_stop', 409)
    settings = json.loads(page['settings'])
    require(not settings.get('work_model_pending'), 'managed_work_model_pending', 409)
    run = managed.host.team.run_for_request(db, request['id'])
    require(run and run['state'] == 'running' and not managed.host.team.maintenance.held(db, run['id']),
            'managed_send_preparation_run_changed', 409)
    scope = managed.host.team.scopes.scope(db, page['thread_id'])
    work = db.execute('SELECT * FROM host_team_work WHERE request_id=?', (request['id'],)).fetchone()
    lease = db.execute('SELECT * FROM host_team_leases WHERE request_id=?', (request['id'],)).fetchone()
    controller = run['controller_request'] == request['id'] and run['controller_thread'] == page['thread_id']
    require(scope and lease and scope['project'] == binding['spec']['project'] and
            scope['root'] == page['root'] == lease['root'] and
            scope['access'] == settings.get('access', 'read') == lease['access'] and
            json.loads(scope['write_paths']) == settings.get('write_paths', []) and
            run['id'] == lease['run_id'] and
            (controller or work and work['run_id'] == run['id'] and
             work['scope_fingerprint'] == scope['fingerprint']) and
            lease['thread_id'] == page['thread_id'],
            'managed_send_preparation_original_scope_changed', 409)
    attempt = db.execute('SELECT * FROM control_attempts WHERE id=? AND request_id=? AND thread_id=?',
                         (payload['expected_attempt_id'], request['id'], page['thread_id'])).fetchone()
    latest_attempt = db.execute('SELECT id FROM control_attempts WHERE request_id=? ORDER BY offered DESC,rowid DESC LIMIT 1', (request['id'],)).fetchone()
    require(attempt and latest_attempt['id'] == attempt['id'] and attempt['state'] == 'dispatching' and
            attempt['generation'] == 1 and attempt['dispatched'] is not None and attempt['acknowledged'] is None,
            'managed_send_preparation_attempt_unresolved', 409)
    prepared = db.execute('SELECT * FROM managed_dispatches WHERE attempt_id=?', (attempt['id'],)).fetchone()
    dispatch = db.execute('SELECT * FROM host_team_dispatches WHERE attempt_id=?', (attempt['id'],)).fetchone()
    require(prepared and dispatch and dispatch['request_id'] == request['id'] and dispatch['run_id'] == run['id'],
            'managed_send_preparation_original_dispatch_missing', 409)
    require(not db.execute('SELECT 1 FROM control_browser_receipts WHERE attempt_id=?', (attempt['id'],)).fetchone() and
            not db.execute('SELECT 1 FROM managed_tool_received WHERE attempt_id=?', (attempt['id'],)).fetchone() and
            not db.execute('SELECT 1 FROM managed_turn_outcomes WHERE attempt_id=?', (attempt['id'],)).fetchone() and
            not db.execute('SELECT 1 FROM managed_partial_public_sends WHERE attempt_id=?', (attempt['id'],)).fetchone(),
            'managed_send_preparation_original_send_received', 409)
    proof = payload['proof']
    legacy = proof == {'legacy_incident': LEGACY_INCIDENT}
    browser = payload['browser']
    _browser(page, settings, attempt, prepared, browser, allow_legacy_assistant_rebase=legacy)
    rebased = browser['assistant_turn_sha256'] != prepared['assistant_before_hash']
    if legacy:
        proof_sha256, started_at = _legacy(managed, page, binding, request, attempt, run, browser, prepared)
        if rebased:
            _legacy_reload_baseline(browser, prepared)
    else:
        proof_sha256, started_at = _structured(page, request, attempt, browser, proof)
    previous = db.execute('SELECT * FROM managed_send_preparation_recoveries WHERE attempt_id=? ORDER BY authorized_at DESC,rowid DESC', (attempt['id'],)).fetchall()
    require(len(previous) < 10 and all(row['proof_sha256'] != proof_sha256 for row in previous) and
            (not previous or started_at > previous[0]['authorized_at'] * 1000),
            'managed_send_preparation_original_authorization_requires_reconciliation', 409)
    prompt = managed.control.prompt(db, binding, attempt)
    require(sha(prompt) == prepared['prompt_hash'], 'managed_send_preparation_original_prompt_changed', 409)
    response = {'state': 'prepared_send_recovery_authorized', 'operation_id': operation_id,
                'request_id': request['id'], 'attempt_id': attempt['id'],
                'proof_sha256': proof_sha256, 'original_request_preserved': True,
                'original_claim_preserved': True, 'original_run_preserved': True,
                'dispatch_repeated': False, 'jobs_replayed': False,
                'assistant_baseline_rebased': rebased,
                'assistant_before_hash_previous': prepared['assistant_before_hash'],
                'assistant_before_hash': browser['assistant_turn_sha256']}
    if rebased:
        # Only the positively unsent, source-fenced legacy incident may rebase
        # its failed assistant DOM. The prompt, original Send and business stay.
        db.execute('UPDATE managed_dispatches SET assistant_before_hash=? WHERE attempt_id=? AND assistant_before_hash=?',
                   (browser['assistant_turn_sha256'], attempt['id'], prepared['assistant_before_hash']))
    db.execute('INSERT INTO managed_send_preparation_recoveries VALUES(?,?,?,?,?,?,?)',
               (operation_id, attempt['id'], request['id'], proof_sha256, fingerprint,
                managed.host.clock(), canonical(response)))
    managed.host.emit(db, page['thread_id'], KIND, response)
    return {**response, 'authorized': True, 'prompt': prompt, 'prompt_hash': prepared['prompt_hash'],
            'previous_user_hash': attempt['user_hash'], 'assistant_before_hash': browser['assistant_turn_sha256']}
