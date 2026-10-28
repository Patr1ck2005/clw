"""Explicit operator retirement of an ended, paused read-only branch.

This preserves the pause and original failure. It retires only an offer which
never reached dispatch, using the original continue receipt and saved turn.
The caller owns the transaction and durable operation receipt.
"""
import hashlib
import json
from pathlib import Path

from harness_accounts import connector_name
from harness_state import canonical, require
from harness_team_common import object_fields
import harness_managed_recovery as recovery


def retire(team, db, actor, p):
    object_fields(p, {'mode', 'run_id', 'request_id', 'attempt_id',
                      'offered_attempt_id', 'continue_operation_id',
                      'evidence_path', 'evidence_sha256', 'reason'})
    require(p['mode'] == 'retire-paused', 'paused_branch_mode')
    require(isinstance(p['reason'], str) and 0 < len(p['reason'].strip()) <= 2000,
            'attention_reason_required')
    run = team.owned(db, actor, p['run_id'])
    require(run['state'] in ('running', 'paused', 'draining'), 'team_run_closed', 409)
    require(not team.maintenance.held(db, run['id']), 'team_use_resume_maintenance', 409)
    r = db.execute('SELECT * FROM host_requests WHERE id=?', (p['request_id'],)).fetchone()
    work = db.execute('SELECT * FROM host_team_work WHERE request_id=? AND run_id=?',
                      (p['request_id'], run['id'])).fetchone()
    edge = db.execute('SELECT * FROM host_delegations WHERE child_request_id=?',
                      (p['request_id'],)).fetchone()
    require(r and work and edge and r['id'] != run['controller_request']
            and edge['parent_request_id'] == run['controller_request']
            and edge['parent_thread_id'] == run['controller_thread'], 'team_foreign_result', 403)
    require(r['phase'] == 'suspended' and r['claim_id'] and not r['cancel_requested'],
            'paused_branch_request_changed', 409)
    latest_request = db.execute('SELECT id FROM host_requests WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
                                (r['thread_id'],)).fetchone()
    require(latest_request['id'] == r['id'], 'paused_branch_request_changed', 409)
    scope = db.execute('SELECT * FROM host_team_scopes WHERE thread_id=?', (r['thread_id'],)).fetchone()
    require(scope and scope['access'] == 'read' and not json.loads(scope['resources'])
            and not json.loads(scope['write_paths']) and not json.loads(work['resources'])
            and scope['fingerprint'] == work['scope_fingerprint'], 'paused_branch_read_only_required', 409)
    require(not db.execute('SELECT 1 FROM host_team_leases WHERE request_id=? OR thread_id=?',
                           (r['id'], r['thread_id'])).fetchone(), 'paused_branch_lease_held', 409)
    require(not team.host.collaboration.outstanding(db, r['id']), 'team_children_still_pending', 409)
    page = db.execute('SELECT * FROM managed_pages WHERE thread_id=?', (r['thread_id'],)).fetchone()
    owner = db.execute('SELECT * FROM managed_pause_owners WHERE page_id=?',
                        (page['page_id'],)).fetchone() if page else None
    require(page and page['paused'] and owner and owner['source'] == 'operator',
            'paused_branch_operator_pause_required', 409)
    require(not db.execute('SELECT 1 FROM managed_stops WHERE page_id=? AND resumed=0',
                           (page['page_id'],)).fetchone(), 'attention_explicit_stop_preserved', 409)
    issue = db.execute('SELECT * FROM managed_page_issues WHERE page_id=?',
                        (page['page_id'],)).fetchone()
    # Failed preparation blocks a future Send, but this zero-send blocked
    # collection keeps the original failure when all execution guards pass.
    require(not issue or issue['kind'] == 'control_failed', 'attention_page_issue_preserved', 409)
    preserved_issue = dict(issue) if issue else None
    require(not db.execute('SELECT 1 FROM managed_attention WHERE request_id=?',
                           (r['id'],)).fetchone(), 'paused_branch_attention_not_reconciled', 409)
    old = db.execute('SELECT * FROM control_attempts WHERE id=? AND request_id=? AND thread_id=?',
                      (p['attempt_id'], r['id'], r['thread_id'])).fetchone()
    receipt = db.execute('SELECT * FROM control_browser_receipts WHERE attempt_id=?',
                          (p['attempt_id'],)).fetchone()
    require(old and old['state'] == 'acknowledged' and receipt
            and receipt['request_id'] == r['id'] and receipt['thread_id'] == r['thread_id']
            and receipt['claim_id'] == r['claim_id'] and receipt['sent_user_hash']
            and receipt['result_turn_hash'] and receipt['result_hash'] and receipt['completed'] is not None,
            'paused_branch_original_turn_required', 409)
    offered = db.execute('SELECT * FROM control_attempts WHERE thread_id=? ORDER BY offered DESC,rowid DESC LIMIT 1',
                          (r['thread_id'],)).fetchone()
    require(offered and offered['id'] == p['offered_attempt_id'] and offered['request_id'] == r['id']
            and offered['state'] == 'offered' and offered['offered'] >= receipt['completed']
            and offered['dispatched'] is None and offered['acknowledged'] is None
            and not db.execute('SELECT 1 FROM control_browser_receipts WHERE attempt_id=?',
                               (offered['id'],)).fetchone()
            and not db.execute('SELECT 1 FROM host_team_dispatches WHERE attempt_id=?',
                               (offered['id'],)).fetchone(), 'paused_branch_offer_not_unsent', 409)
    require(not db.execute("SELECT 1 FROM control_attempts WHERE thread_id=? AND (state IN ('dispatching','sent','unknown') OR (id<>? AND offered>=? AND (dispatched IS NOT NULL OR acknowledged IS NOT NULL)))",
                           (r['thread_id'], old['id'], old['offered'])).fetchone(),
            'attention_dispatch_unknown', 409)
    require(not db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','unknown')",
                           (r['thread_id'],)).fetchone(), 'attention_local_execution_unknown', 409)
    saved = db.execute('SELECT snapshot FROM managed_recovery_contexts WHERE request_id=? AND attempt_id=?',
                        (r['id'], old['id'])).fetchone()
    prior = db.execute("SELECT response,actor FROM host_team_receipts WHERE operation_id=? AND operation='reconcile-attention'",
                        (p['continue_operation_id'],)).fetchone()
    facts = json.loads(saved['snapshot']) if saved else {}
    continued = json.loads(prior['response']) if prior else {}
    require(prior and prior['actor'] == actor['spec']['session_id']
            and continued.get('state') == 'original_work_resumed'
            and continued.get('request_id') == r['id'] and continued.get('attempt_id') == old['id']
            and continued.get('model_sends') == 0 and continued.get('task_completed') is False
            and facts.get('request', {}).get('id') == r['id']
            and facts['request'].get('claim_id') == r['claim_id']
            and facts['request'].get('thread_id') == r['thread_id']
            and facts.get('attempt', {}).get('id') == old['id']
            and facts['attempt'].get('request_id') == r['id']
            and facts['attempt'].get('acknowledged') == old['acknowledged']
            and facts.get('browser_reply_saved') is True,
            'paused_branch_saved_continue_required', 409)
    artifacts = db.execute('SELECT * FROM managed_artifacts WHERE request_id=?', (r['id'],)).fetchall()
    require(artifacts and facts.get('saved_turn_artifacts'), 'attention_original_result_required', 409)
    indexed = {a['path']: dict(a) for a in artifacts}
    for a in facts['saved_turn_artifacts']:
        current = indexed.get(a['path'])
        require(current and all(current[k] == a[k] for k in ('sha256', 'bytes', 'source')),
                'managed_result_file_changed', 409)
        raw = Path(a['path']).read_bytes()
        require(len(raw) == a['bytes'] and hashlib.sha256(raw).hexdigest() == a['sha256'],
                'managed_result_file_changed', 409)
    artifact = next((a for a in artifacts if a['id'] == old['id'] + '-tool'
                     and a['source'] == 'local_mcp_public_result'), None)
    if artifact is None:
        artifact = next((a for a in artifacts if a['id'] == old['id']
                         and a['source'] == 'public_dom_markdown'), None)
        source = db.execute('SELECT assistant_turn_hash FROM managed_text_artifact_turns WHERE attempt_id=?',
                            (old['id'],)).fetchone()
        require(artifact and (artifact['sha256'] == receipt['result_hash'] or
                source and source['assistant_turn_hash'] == receipt['result_turn_hash']),
                'attention_public_result_not_original', 409)
    require(any(a['path'] == artifact['path'] and a['sha256'] == artifact['sha256']
                for a in facts['saved_turn_artifacts']), 'paused_branch_saved_result_required', 409)
    path = Path(p['evidence_path']).resolve()
    require(path.is_relative_to((team.host.root / 'evidence').resolve()) and path.is_file(),
            'attention_evidence_path', 409)
    raw_proof = path.read_bytes()
    require(len(raw_proof) < 1048576 and hashlib.sha256(raw_proof).hexdigest() == p['evidence_sha256'],
            'attention_evidence_changed', 409)
    proof = json.loads(raw_proof)
    binding = team.host.binding(db, thread=r['thread_id'])
    account = json.loads(page['settings']).get('account', 'B')
    result = proof.get('result', {}).get('structuredContent', {})
    jobs = result.get('output', {})
    require((proof.get('source') == connector_name(account) + '.list_jobs' or
             proof.get('source') == 'CLW-MCP-Union.list_jobs' and proof.get('account') == account)
            and proof.get('session_id') == binding['spec']['session_id']
            and 0 <= team.host.clock() - proof.get('observed_at', 0) <= 120
            and result.get('success') is True and result.get('error') is None
            and jobs.get('truncated') is False and isinstance(jobs.get('jobs'), list)
            and jobs.get('count') == jobs.get('matched_count') == len(jobs['jobs'])
            and all(j.get('session_id') == proof['session_id']
                    and j.get('status') in ('completed', 'failed', 'cancelled')
                    and j.get('command_execution_state') == 'completed' for j in jobs['jobs']),
            'attention_original_jobs_not_idle', 409)
    observed = proof.get('browser', {})
    marker = '[CLW:' + old['id'] + ']'
    canonical_user = hashlib.sha256(('managed-public:' + marker + ':user').encode('utf-8')).hexdigest()
    literal_user = observed.get('userHash') == receipt['sent_user_hash']
    # page-dom's fallback turn keys are viewport ordinals after remount. Its
    # unique original public marker gives this stable canonical user identity.
    # Never update the original receipt or infer a new assistant identity.
    remounted_user = (observed.get('userHash') == canonical_user
                      and observed.get('marker') == marker
                      and type(observed.get('marker_count')) is int
                      and observed['marker_count'] == 1
                      and observed.get('history_at_latest') is True)
    require(observed.get('page_id') == page['page_id'] and observed.get('url') == page['url']
            and (literal_user or remounted_user)
            and observed.get('assistantTurnHash') == receipt['result_turn_hash']
            and 0 <= team.host.clock() - observed.get('at', 0) / 1000 <= 30
            and observed.get('generating') is False and observed.get('complete') is True
            and not any(observed.get(k, True) for k in ('loginRequired', 'approvalRequired', 'draft')),
            'attention_browser_not_idle', 409)
    # Formal blocked collection, never a successful author turn-end. Restore
    # processing only inside this transaction for project_reply's claim guard.
    db.execute("UPDATE host_requests SET phase='processing' WHERE id=?", (r['id'],))
    notes = [dict(n) for n in db.execute('''SELECT n.id AS note_id,n.text FROM host_unread_notes u
        JOIN host_notes n ON n.id=u.note_id WHERE u.request_id=? AND n.request_id=?
        ORDER BY n.rowid DESC''', (r['id'], r['id']))]
    note_refs = [{'request_id': r['id'], 'note_id': n['note_id']} for n in notes]
    body = ('Operator retired this ended paused branch; original task remains incomplete.\n'
            + p['reason'] + '\nOriginal result: ' + artifact['path'] + '\nSHA256: '
            + artifact['sha256'] + '\nOriginal recovery context reference: '
            + canonical({'request_id': r['id'], 'attempt_id': old['id']})
            + '\nCurrent unread instruction references (remain unread): ' + canonical(note_refs))
    if preserved_issue:
        body += '\nPreserved page issue, continuation still blocked; issue not cleared: ' + canonical(preserved_issue)
    require(len(body) <= 45000, 'paused_branch_instruction_refs_too_large', 409)
    note_text = canonical(notes)
    if len(note_text) <= 47000 - len(body):
        body += '\nCurrent unread instructions, full original text: ' + note_text
    else:
        body += ('\nCurrent unread instruction text window, truncated; obtain full original text by the references above: '
                 + note_text[:47000 - len(body)])
    # A long recovery summary may exceed the public reply window. Its exact
    # durable request/attempt reference is already included above.
    continuation = recovery.continuation_note(facts)
    if len(body) + len(continuation) <= 48000:
        body += continuation
    team.host.project_reply(db, binding, {**dict(r), 'phase': 'processing'}, {
        'request_id': r['id'], 'claim_id': r['claim_id'], 'reply_id': 'retired-' + offered['id'],
        'status': 'blocked', 'text': body})
    db.execute("UPDATE control_attempts SET state='not_sent' WHERE id=?", (offered['id'],))
    team.host.emit(db, r['thread_id'], 'control_not_sent', {
        'request_id': r['id'], 'attempt_id': offered['id'], 'source': 'operator_paused_branch_retirement',
        'model_received': False, 'automatic_retry': False})
    value = {'state': 'paused_branch_retired', 'request_id': r['id'], 'attempt_id': old['id'],
             'offered_attempt_id': offered['id'], 'continue_operation_id': p['continue_operation_id'],
             'original_claim_preserved': True, 'operator_pause_preserved': True,
             'task_completed': False, 'model_sends': 0, 'unread_notes_preserved': True,
             'browser_identity_source': 'original_receipt' if literal_user else 'unique_original_public_marker',
             'unread_note_refs': note_refs,
             'preserved_page_issue': preserved_issue,
             'recovery_context_ref': {'request_id': r['id'], 'attempt_id': old['id']},
             'evidence_sha256': p['evidence_sha256']}
    team.host.emit(db, run['controller_thread'], 'managed_paused_branch_retired', value)
    return value
