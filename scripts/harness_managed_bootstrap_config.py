"""Candidate explicit setup configuration; not registered in running source4.

Only a future supervised Managed operation may call this helper. Importing it
does not open a database, construct a Host, drive a browser or send a model turn.
The caller holds the existing Host lock and BEGIN IMMEDIATE transaction.
"""
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from harness_managed_models import effort_key, model_key
from harness_state import canonical, require
from harness_team_common import hash_value, object_fields, text

OPERATION = 'configure-bootstrap-model'
DECISION = '.local/camp-bootstrap-model-decision-20261001.json'
SELECTION_FIELDS = ('model', 'effort', 'selection', 'description', 'sliderCount',
                    'sliderContainerCount', 'slider', 'efforts', 'options')


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS managed_bootstrap_config_intents(
      operation_id TEXT PRIMARY KEY,page_id TEXT NOT NULL,actor TEXT NOT NULL,
      fingerprint TEXT NOT NULL,intent TEXT NOT NULL,state TEXT NOT NULL,
      created REAL NOT NULL)''')


def _row(db, sql, args):
    row = db.execute(sql, args).fetchone()
    return dict(row) if row else None


def _semantic_page(page):
    # Polling updates seen without changing execution or configuration identity.
    return {k: v for k, v in page.items() if k != 'seen'} if page else None


def expected_state(managed, db, page_id):
    page = _row(db, 'SELECT * FROM managed_pages WHERE page_id=?', (page_id,))
    require(page, 'managed_page_missing', 404)
    handoff = _row(db, 'SELECT * FROM managed_handoffs WHERE successor_page=?', (page_id,))
    require(handoff, 'managed_bootstrap_config_handoff_required', 409)
    source = _row(db, 'SELECT * FROM managed_pages WHERE page_id=?', (handoff['source_page'],))
    request = _row(db, 'SELECT * FROM host_requests WHERE id=?', (handoff['source_request'],))
    run = managed.host.team.run_for_request(db, handoff['source_request'])
    facts = {'page': _semantic_page(page), 'handoff': handoff,
             'source': _semantic_page(source), 'request': request, 'run': dict(run) if run else None,
             'source_attempt': _row(db, 'SELECT * FROM control_attempts WHERE id=?', (handoff['source_attempt'],)),
             'source_receipt': _row(db, 'SELECT * FROM control_browser_receipts WHERE attempt_id=?',
                                    (handoff['source_attempt'],))}
    for name, table in (('issue', 'managed_page_issues'), ('pause_owner', 'managed_pause_owners'),
                        ('stop', 'managed_stops'), ('bootstrap_budget', 'managed_bootstrap_budget')):
        facts[name] = _row(db, 'SELECT * FROM ' + table + ' WHERE page_id=?', (page_id,))
    for name, table in (('source_issue', 'managed_page_issues'), ('source_pause_owner', 'managed_pause_owners'),
                        ('source_stop', 'managed_stops')):
        facts[name] = _row(db, 'SELECT * FROM ' + table + ' WHERE page_id=?', (handoff['source_page'],))
    settings = json.loads(page['settings'])
    return {'state_fingerprint': hash_value(facts), 'phase': page['phase'],
            'bootstrap_state': page['bootstrap_state'], 'paused': bool(page['paused']),
            'thread_id': page['thread_id'], 'bootstrap_model_selection': settings.get('bootstrap_model_selection'),
            'handoff_id': handoff['id'], 'source_page': handoff['source_page'],
            'source_request': handoff['source_request'], 'source_thread': handoff['source_thread'],
            'source_attempt': handoff['source_attempt'], 'source_claim': handoff['source_claim'],
            'successor_request': handoff['successor_request'], 'run_id': handoff['run_id']}


def _json_file(root, relative, expected_hash, *, decision=False):
    require(isinstance(relative, str) and len(relative) <= 512, 'managed_bootstrap_config_evidence_path')
    path = Path(relative)
    require(not path.is_absolute() and '..' not in path.parts and
            (relative == DECISION if decision else path.parts and path.parts[0] == 'evidence') and
            path.suffix == '.json', 'managed_bootstrap_config_evidence_path', 403)
    root = Path(root).resolve()
    dest = root / path
    require(dest.resolve() == dest and dest.resolve().is_relative_to(root) and not dest.is_symlink(),
            'managed_bootstrap_config_evidence_path', 403)
    meta = dest.lstat()
    require(stat.S_ISREG(meta.st_mode) and meta.st_size <= 131072 and
            not (getattr(meta, 'st_file_attributes', 0) & 0x400),
            'managed_bootstrap_config_evidence_not_plain', 403)
    require(isinstance(expected_hash, str) and re.fullmatch('[0-9a-f]{64}', expected_hash),
            'managed_bootstrap_config_evidence_hash')
    with dest.open('rb') as source:
        opened = os.fstat(source.fileno())
        require((meta.st_dev, meta.st_ino) == (opened.st_dev, opened.st_ino),
                'managed_bootstrap_config_evidence_changed', 409)
        raw = source.read(131073)
    require(len(raw) <= 131072 and hashlib.sha256(raw).hexdigest() == expected_hash,
            'managed_bootstrap_config_evidence_changed', 409)
    value = json.loads(raw)
    require(isinstance(value, dict), 'managed_bootstrap_config_evidence_format')
    return value


def _choice(value, model, effort, position):
    require(isinstance(value, dict) and model_key(value.get('model', '')) == model_key(model)
            and effort_key(value.get('effort', '')) == effort_key(effort)
            and isinstance(value.get('selection'), list) and len(value['selection']) == 1
            and model_key(value['selection'][0]) == 'latest',
            'managed_bootstrap_config_public_choice_mismatch', 409)
    require(type(value.get('sliderCount')) is int and value['sliderCount'] == 1
            and type(value.get('sliderContainerCount')) is int and value['sliderContainerCount'] == 1,
            'managed_bootstrap_config_public_controls_not_unique', 409)
    slider = value.get('slider', {})
    require(isinstance(slider, dict) and slider == {'min': 0, 'max': 4, 'value': position}
            and all(type(slider[k]) is int for k in slider),
            'managed_bootstrap_config_public_slider_mismatch', 409)
    description = text(value.get('description'), 'model_description', 512)
    version = '5.6' if position == 3 else '6'
    require(re.search(r'(?<![\d.])' + re.escape(version) + r'(?![\d.])', description)
            and (re.search(r'Extra\s+High|极高', description, re.I) if position == 3
                 else re.search(r'\bPro\b', description, re.I)),
            'managed_bootstrap_config_public_description_mismatch', 409)
    efforts = value.get('efforts')
    require(isinstance(efforts, list) and len(efforts) == 5
            and [tick.get('value') for tick in efforts if isinstance(tick, dict) and type(tick.get('value')) is int] == list(range(5))
            and all(tick.get('available') is True for tick in efforts),
            'managed_bootstrap_config_public_efforts_unavailable', 409)
    # Real markup can mark all lower ticks selected; the unique slider wins.
    options = value.get('options')
    require(isinstance(options, list) and 0 < len(options) <= 20
            and all(isinstance(option, dict) for option in options),
            'managed_bootstrap_config_public_options')
    selected = [option for option in options if option.get('checked') is True]
    require(len(selected) == 1 and selected[0].get('available') is True
            and model_key(selected[0].get('name', '')) == 'latest',
            'managed_bootstrap_config_public_choice_mismatch', 409)


def _approval_and_proof(managed, payload, page, settings):
    owner = {'owner_pid': os.getppid(), 'core_pid': os.getpid(), 'store_id': managed.state.id}
    require(payload['owner'] == owner, 'managed_bootstrap_config_owner_changed', 409)
    decision = _json_file(managed.host.root, DECISION, payload['decision_sha256'], decision=True)
    require(decision.get('state') == 'approved', 'managed_bootstrap_config_approval_required', 403)
    text(decision.get('approval_ref'), 'human_approval_reference', 1000)
    require(decision.get('page') == page['page_id'] and decision.get('account') == settings.get('account')
            and decision.get('observedPublicChoice') == 'Latest'
            and decision.get('observedSetup') == {'model': 'GPT-5.6 · Latest', 'effort': 'Extra High'}
            and decision.get('observedFormalWork') == {'model': 'GPT-6 · Latest', 'effort': 'Pro'}
            and decision.get('exactOriginalEffortRestored') is True
            and type(decision.get('modelSends')) is int and decision['modelSends'] == 0,
            'managed_bootstrap_config_approval_mismatch', 403)
    require(model_key(page['model']) == 'gpt-6 · latest' and effort_key(page['effort']) == 'pro'
            and model_key((settings.get('model_selection') or {}).get('model', '')) == 'gpt-6 · latest'
            and effort_key((settings.get('model_selection') or {}).get('effort', '')) == 'pro',
            'managed_bootstrap_config_formal_choice_changed', 409)
    evidence = payload['evidence']
    object_fields(evidence, {'intent_path', 'intent_sha256', 'receipt_path', 'receipt_sha256'})
    require(decision.get('evidence') == evidence['receipt_path'], 'managed_bootstrap_config_approval_mismatch', 403)
    intent = _json_file(managed.host.root, evidence['intent_path'], evidence['intent_sha256'])
    receipt = _json_file(managed.host.root, evidence['receipt_path'], evidence['receipt_sha256'])
    result = receipt.get('result', {})
    require(intent.get('kind') == 'public_effort_inspection_and_exact_restore'
            and intent.get('page') == page['page_id'] and intent.get('owner') == owner['owner_pid']
            and type(intent.get('modelSends')) is int and intent['modelSends'] == 0 and result.get('restored') is True
            and type(result.get('modelSends')) is int and result['modelSends'] == 0 and result.get('before') == intent.get('before')
            and result.get('after') == result.get('before'),
            'managed_bootstrap_config_original_proof_mismatch', 409)
    started = datetime.fromisoformat(intent['at'].replace('Z', '+00:00')).timestamp()
    finished = datetime.fromisoformat(receipt['at'].replace('Z', '+00:00')).timestamp()
    require(0 <= finished - started <= 60, 'managed_bootstrap_config_original_proof_mismatch', 409)
    _choice(result['before'], 'GPT-5.6 · Latest', 'Extra High', 3)
    _choice(result.get('pro'), 'GPT-6 · Latest', 'Pro', 4)
    _choice(result['after'], 'GPT-5.6 · Latest', 'Extra High', 3)
    live = payload['live']
    object_fields(live, {'page_id', 'target_id', 'account', 'url', 'owner', 'observed_at',
                         'model_selection', 'generating', 'draft', 'composing', 'loginRequired',
                         'approvalRequired', 'editor', 'controlKnown'})
    require(type(live['observed_at']) in (int, float)
            and 0 <= managed.host.clock() - live['observed_at'] <= 30
            and live['owner'] == owner and live['page_id'] == page['page_id']
            and live['target_id'] == intent.get('targetId') and bool(live['target_id'])
            and live['account'] == settings.get('account') and live['url'] == page['url']
            and all(live[k] is False for k in ('generating', 'draft', 'composing', 'loginRequired', 'approvalRequired'))
            and live['editor'] is True and live['controlKnown'] is True,
            'managed_bootstrap_config_live_proof_changed', 409)
    _choice(live['model_selection'], 'GPT-5.6 · Latest', 'Extra High', 3)
    return {k: live['model_selection'][k] for k in SELECTION_FIELDS}, decision['approval_ref']


def receipt(managed, db, payload):
    object_fields(payload, {'page_id', 'operation_id'})
    managed.host.identifier(payload['operation_id'])
    intent = _row(db, 'SELECT * FROM managed_bootstrap_config_intents WHERE operation_id=?',
                  (payload['operation_id'],))
    record = _row(db, 'SELECT * FROM host_team_receipts WHERE operation_id=?', (payload['operation_id'],))
    if not intent and not record:
        return {'state': 'not_recorded', 'operation_id': payload['operation_id'], 'model_sends': 0,
                'retry_authorized': False}
    require(intent and intent['page_id'] == payload['page_id'], 'team_operation_conflict', 409)
    if not record:
        return {'state': 'unknown_reconcile_original', 'operation_id': payload['operation_id'],
                'model_sends': 0, 'retry_authorized': False}
    require(record['operation'] == OPERATION and record['actor'] == intent['actor']
            and record['fingerprint'] == intent['fingerprint'], 'team_operation_conflict', 409)
    return json.loads(record['response'])


def configure(managed, db, payload):
    require(db.in_transaction, 'managed_bootstrap_config_transaction_required', 409)
    object_fields(payload, {'page_id', 'operation_id', 'confirm', 'expected', 'decision_sha256',
                            'evidence', 'owner', 'live'})
    require(payload['confirm'] is True, 'managed_bootstrap_config_confirmation_required', 403)
    managed.host.identifier(payload['operation_id'])
    fingerprint = hash_value({'op': OPERATION, 'payload': payload})
    prior = _row(db, 'SELECT * FROM host_team_receipts WHERE operation_id=?', (payload['operation_id'],))
    if prior:
        require(prior['operation'] == OPERATION and prior['fingerprint'] == fingerprint,
                'team_operation_conflict', 409)
        return receipt(managed, db, {'page_id': payload['page_id'], 'operation_id': payload['operation_id']})
    require(not db.execute('SELECT 1 FROM managed_bootstrap_config_intents WHERE operation_id=?',
                           (payload['operation_id'],)).fetchone(),
            'managed_bootstrap_config_original_operation_unknown', 409)
    page = db.execute('SELECT * FROM managed_pages WHERE page_id=?', (payload['page_id'],)).fetchone()
    require(page and page['paused'] and page['phase'] == 'reserved' and page['bootstrap_state'] == 'pending'
            and not page['thread_id'] and not page['parent_target'],
            'managed_bootstrap_config_unsent_paused_successor_required', 409)
    settings = json.loads(page['settings'])
    require(not settings.get('bootstrap_model_configuration'),
            'managed_bootstrap_config_original_operation_recorded_reconcile', 409)
    require(settings.get('work_model_pending') is True and settings.get('first_turn_mode') != 'task_v1'
            and not str(settings.get('first_turn_instructions', '')).strip()
            and not settings.get('first_task_parent'), 'managed_bootstrap_config_setup_only_required', 409)
    issue = db.execute('SELECT * FROM managed_page_issues WHERE page_id=?', (page['page_id'],)).fetchone()
    require(issue and issue['kind'] == 'model_unavailable', 'managed_bootstrap_config_issue_changed', 409)
    require(not db.execute('SELECT 1 FROM managed_stops WHERE page_id=? AND resumed=0', (page['page_id'],)).fetchone()
            and not db.execute('SELECT 1 FROM managed_bootstrap_budget WHERE page_id=?', (page['page_id'],)).fetchone(),
            'managed_bootstrap_config_original_send_or_stop_preserved', 409)
    require(managed.handoffs.enrolling_successor(db, page), 'managed_bootstrap_config_handoff_changed', 409)
    expected = expected_state(managed, db, page['page_id'])
    require(payload['expected'] == expected, 'managed_bootstrap_config_state_changed', 409)
    run = managed.host.team.run_for_request(db, expected['source_request'])
    require(run['controller_thread'] == expected['source_thread']
            and run['controller_request'] == expected['source_request']
            and not managed.host.team.maintenance.held(db, run['id'])
            and not db.execute('SELECT 1 FROM host_requests WHERE id=?', (expected['successor_request'],)).fetchone(),
            'managed_bootstrap_config_handoff_changed', 409)
    require(not db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','unknown')",
                           (expected['source_thread'],)).fetchone(),
            'managed_bootstrap_config_original_operation_unknown', 409)
    selected, approval_ref = _approval_and_proof(managed, payload, page, settings)
    actor = managed.host.binding(db, thread=expected['source_thread'])['spec']['session_id']
    intent = {'operation': OPERATION, 'page_id': page['page_id'], 'expected': expected,
              'owner': payload['owner'], 'decision_sha256': payload['decision_sha256'],
              'evidence': payload['evidence'], 'approval_ref': approval_ref,
              'previous_selection': settings.get('bootstrap_model_selection'), 'selected': selected}
    db.execute('INSERT INTO managed_bootstrap_config_intents VALUES(?,?,?,?,?,?,?)',
               (payload['operation_id'], page['page_id'], actor, fingerprint, canonical(intent),
                'committed', managed.host.clock()))
    settings['bootstrap_model_selection'] = selected
    settings['bootstrap_model_verified'] = False
    settings['bootstrap_model_configuration'] = {'operation_id': payload['operation_id'],
        'decision_sha256': payload['decision_sha256'], 'evidence': payload['evidence'],
        'approval_ref': approval_ref, 'previous_selection': intent['previous_selection']}
    cursor = db.execute('UPDATE managed_pages SET settings=? WHERE page_id=? AND settings=? '
                        "AND paused=1 AND phase='reserved' AND bootstrap_state='pending' AND thread_id IS NULL",
                        (canonical(settings), page['page_id'], page['settings']))
    require(cursor.rowcount == 1, 'managed_bootstrap_config_state_changed', 409)
    result = {'state': 'bootstrap_model_configured', 'operation_id': payload['operation_id'],
              'page_id': page['page_id'], 'bootstrap_model_selection': selected,
              'bootstrap_model_verified': False, 'paused_preserved': True, 'issue_preserved': True,
              'formal_model_preserved': True, 'original_handoff_preserved': True,
              'budget_preserved': True, 'receiver_enrolled': False, 'model_sends': 0}
    db.execute('INSERT INTO host_team_receipts VALUES(?,?,?,?,?)',
               (payload['operation_id'], actor, OPERATION, fingerprint, canonical(result)))
    return result
