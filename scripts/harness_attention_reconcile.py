"""Operator reconciliation of an ended writer, not replay of its failed tools.

The browser and authenticated result must have ended and the original Session's
Job inventory must be complete and idle. A failed child becomes blocked; a
controller hands its already accepted, independent children back to the scheduler,
or ends as blocked when every child is already terminal. Unread results remain unread.
No project operation, model message, checkpoint or model-authored wait is run.
"""
import hashlib
import json
from harness_run_limits import deadline_live,sends_available
from pathlib import Path

from harness_state import require, stamp
from harness_team_common import object_fields
from harness_accounts import connector_name
from harness_job_inventory import inventory_idle
import harness_managed_recovery as recovery


def reconcile(team, db, actor, payload):
    if payload.get('mode') == 'retire-paused':
        from harness_paused_branch_reconcile import retire
        return retire(team, db, actor, payload)
    object_fields(payload, {'run_id', 'request_id', 'attempt_id', 'evidence_path',
                            'evidence_sha256', 'reason'}, {'resume_operator_pause','mode'})
    mode=payload.get('mode','settle')
    require(mode in ('settle','continue'),'attention_reconcile_mode')
    require(type(payload.get('resume_operator_pause', False)) is bool, 'attention_pause_choice')
    run = team.owned(db, actor, payload['run_id'])
    require(run['state'] in ('running', 'paused', 'draining') or
            (mode=='settle' and run['state']=='closed' and run['reason']=='controller_summary'),
            'team_run_closed', 409)
    require(not team.maintenance.held(db, run['id']), 'team_use_resume_maintenance', 409)
    request = db.execute('SELECT * FROM host_requests WHERE id=?', (payload['request_id'],)).fetchone()
    require(request and (request['id'] == run['controller_request'] or db.execute(
        'SELECT 1 FROM host_team_work WHERE run_id=? AND request_id=?',
        (run['id'], request['id'])).fetchone()), 'team_foreign_result', 403)
    require(request['phase'] in ('processing', 'suspended') and not request['cancel_requested'],
            'attention_request_changed', 409)
    attention = db.execute('SELECT * FROM managed_attention WHERE request_id=? AND attempt_id=?',
                           (request['id'], payload['attempt_id'])).fetchone()
    require(attention, 'team_attention_not_current', 409)
    page = db.execute('SELECT * FROM managed_pages WHERE thread_id=?', (request['thread_id'],)).fetchone()
    owner = db.execute('SELECT * FROM managed_pause_owners WHERE page_id=?', (page['page_id'],)).fetchone()
    automatic_pause = owner and owner['source'] == 'attention' and owner['attempt_id'] == payload['attempt_id']
    authorized_pause = owner and owner['source'] == 'operator' and payload.get('resume_operator_pause') is True
    require(page['paused'] and (automatic_pause or authorized_pause), 'attention_explicit_stop_preserved', 409)
    if mode=='continue':
        require(not team.host.managed.pause_origin(db,page,include_self=False),
                'attention_explicit_stop_preserved',409)
    require(not db.execute('SELECT 1 FROM managed_stops WHERE page_id=? AND resumed=0',
                           (page['page_id'],)).fetchone(), 'attention_explicit_stop_preserved', 409)
    require(not db.execute('SELECT 1 FROM managed_page_issues WHERE page_id=?',
                           (page['page_id'],)).fetchone(), 'attention_page_issue_preserved', 409)
    latest = db.execute('SELECT * FROM control_attempts WHERE request_id=? ORDER BY offered DESC LIMIT 1',
                        (request['id'],)).fetchone()
    receipt = db.execute('SELECT * FROM control_browser_receipts WHERE attempt_id=?',
                         (payload['attempt_id'],)).fetchone()
    outcome = db.execute('SELECT kind FROM managed_turn_outcomes WHERE attempt_id=?',
                         (payload['attempt_id'],)).fetchone()
    missing=db.execute("SELECT data FROM events WHERE thread_id=? AND kind='host_turn_attention' AND json_extract(data,'$.attempt_id')=? ORDER BY seq DESC LIMIT 1",
                       (request['thread_id'],payload['attempt_id'])).fetchone()
    missing_outcome=not outcome and missing and json.loads(missing['data']).get('missing_tool_outcome') is True
    require(latest and latest['id'] == payload['attempt_id'] and latest['state'] == 'acknowledged'
            and receipt and receipt['result_hash'] and receipt['completed'] is not None
            and ((outcome and outcome['kind'] == 'needs_attention') or missing_outcome),
            'attention_turn_not_saved', 409)
    require(not db.execute("SELECT 1 FROM control_attempts WHERE thread_id=? AND state IN ('dispatching','sent','unknown')",
                           (request['thread_id'],)).fetchone(), 'attention_dispatch_unknown', 409)
    require(not db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','unknown') AND action<>'team.reconcile-attention'",
                           (request['thread_id'],)).fetchone(), 'attention_local_execution_unknown', 409)
    artifact = db.execute("SELECT * FROM managed_artifacts WHERE id=? AND request_id=? AND source='local_mcp_public_result'",
                          (payload['attempt_id'] + '-tool', request['id'])).fetchone()
    if not artifact and missing_outcome:
        artifact=db.execute("SELECT * FROM managed_artifacts WHERE id=? AND request_id=? AND source='public_dom_markdown'",
                            (payload['attempt_id'],request['id'])).fetchone()
    require(artifact, 'attention_original_result_required', 409)
    raw = Path(artifact['path']).read_bytes()
    require(len(raw)==artifact['bytes'] and hashlib.sha256(raw).hexdigest() == artifact['sha256'],
            'managed_result_file_changed', 409)
    if artifact['source']=='public_dom_markdown':
        source=db.execute('SELECT assistant_turn_hash FROM managed_text_artifact_turns WHERE attempt_id=?',
                          (payload['attempt_id'],)).fetchone()
        require(artifact['sha256']==receipt['result_hash'] or
                (source and source['assistant_turn_hash']==receipt['result_turn_hash']),
                'attention_public_result_not_original',409)
    proof_path = Path(payload['evidence_path']).resolve()
    require(proof_path.is_relative_to((team.host.root / 'evidence').resolve()) and proof_path.is_file(),
            'attention_evidence_path', 409)
    proof_raw = proof_path.read_bytes()
    require(len(proof_raw) < 1048576 and hashlib.sha256(proof_raw).hexdigest() == payload['evidence_sha256'],
            'attention_evidence_changed', 409)
    proof = json.loads(proof_raw)
    binding = team.host.binding(db, thread=request['thread_id'])
    result = proof.get('result', {}).get('structuredContent', {})
    jobs = result.get('output', {})
    observed = proof.get('browser', {})
    expected_source=connector_name(json.loads(page['settings']).get('account','B'))+'.list_jobs'
    require((proof.get('source') == expected_source or
             (proof.get('source')=='CLW-MCP-Union.list_jobs' and proof.get('account')==json.loads(page['settings']).get('account','B')))
            and proof.get('session_id') == binding['spec']['session_id']
            and 0 <= team.host.clock() - proof.get('observed_at', 0) <= 120
            and inventory_idle(proof.get('result'),proof['session_id']),
            'attention_original_jobs_not_idle', 409)
    require(observed.get('page_id') == page['page_id'] and observed.get('url') == page['url']
            and 0 <= team.host.clock() - observed.get('at', 0) / 1000 <= 30
            and observed.get('generating') is False and observed.get('complete') is True
            and not any(observed.get(k, True) for k in ('loginRequired', 'approvalRequired', 'draft')),
            'attention_browser_not_idle', 409)
    require(isinstance(payload['reason'], str) and 0 < len(payload['reason']) <= 2000,
            'attention_reason_required')
    facts = recovery.preserve(db, team, request['id'])
    is_controller = request['id'] == run['controller_request']
    pending = team.host.collaboration.outstanding(db, request['id'])
    if mode=='continue' or (is_controller and pending):
        # Only resuming work needs remaining runtime and send budget. Saving a
        # terminal blocked result must still work after time/sends run out.
        require(run['state'] == 'running' and deadline_live(run,team.host.clock())
                and sends_available(run,1,1),
                'attention_original_run_not_runnable', 409)
        team.scopes.release(db, request['id'])
        # Start only work already accepted before the fault. This operator
        # barrier is not a successful receipt for the earlier refused wait.
        cursor = db.execute('SELECT COALESCE(MAX(seq),0) FROM host_team_signals WHERE run_id=?',
                            (run['id'],)).fetchone()[0] if pending else run['after_seq']
        db.execute("UPDATE host_requests SET phase='suspended' WHERE id=?", (request['id'],))
        if is_controller:
            db.execute("UPDATE host_runs SET wait_mode='all',after_seq=?,revision=revision+1 WHERE id=?",
                       (cursor, run['id']))
        db.execute("UPDATE threads SET status='waiting_children',active_turn=NULL,updated_at=? WHERE id=?",
                   (stamp(), request['thread_id']))
        db.execute('UPDATE managed_pages SET paused=0 WHERE page_id=?', (page['page_id'],))
        db.execute('DELETE FROM managed_pause_owners WHERE page_id=?', (page['page_id'],))
        note = 'clw-reconciled-' + payload['attempt_id']
        db.execute('INSERT OR IGNORE INTO host_notes VALUES(?,?,?,?)',
                   (note, request['id'], payload['reason'] + recovery.continuation_note(facts), stamp()))
        db.execute('INSERT OR IGNORE INTO host_unread_notes VALUES(?,?)', (note, request['id']))
        if not pending:
            # No provider is called here. The ordinary control plane carries
            # the complete original goal and saved evidence into one next turn.
            team.host.emit(db,request['thread_id'],'host_user_note',{
                'request_id':request['id'],'note_id':note,
                'text':payload['reason']+recovery.continuation_note(facts),'native_steer':False})
        team.host.emit(db, request['thread_id'], 'host_waiting_children', {
            'request_id': request['id'], 'reason': 'operator_reconciled_ended_execution',
            'no_new_request': True, 'model_wait_receipt': False})
        state = 'original_work_resumed' if not pending else 'independent_children_resumed_controller_parked'
        if mode=='continue' and is_controller and db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_goals'").fetchone():
            from harness_goal_watch import Goals
            goal=db.execute('SELECT * FROM managed_goals WHERE page_id=?',(page['page_id'],)).fetchone()
            if (goal and goal['request_id']==request['id'] and not goal['pending_id'] and
                    goal['state']=='needs_attention' and goal['reason'] in ('request_needs_attention','page_needs_attention') and
                    goal['identity']==Goals.identity(db,page)):
                db.execute("UPDATE managed_goals SET state='active',reason='original_execution_reconciled',updated=? WHERE page_id=?",
                           (team.host.clock(),page['page_id']))
    else:
        require(not pending, 'team_children_still_pending', 409)
        require(not db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',
                               (request['id'],)).fetchone(), 'attention_unread_instructions', 409)
        if is_controller:
            require(not db.execute('SELECT 1 FROM host_team_leases WHERE run_id=? AND request_id<>?',
                                   (run['id'], request['id'])).fetchone(),
                    'attention_child_execution_not_settled', 409)
            # Close an audited, ended failure, not the normal successful-summary
            # path. Do not insert read/ack/checkpoint receipts for unread results.
            db.execute("UPDATE host_runs SET state='closed',reason='operator_reconciled_blocked',revision=revision+1 WHERE id=?",
                       (run['id'],))
        team.scopes.release(db, request['id'])
        body = raw.decode('utf-8-sig')
        if len(body) > 46000:
            body = body[:1000] + '\n完整结果：' + artifact['path'] + '\nSHA256: ' + artifact['sha256']
        team.host.project_reply(db, binding, dict(request), {
            'request_id': request['id'], 'claim_id': request['claim_id'],
            'reply_id': 'reconciled-' + payload['attempt_id'], 'status': 'blocked', 'text': body})
        state = 'blocked_controller_closed' if is_controller else 'blocked_result_collected'
    db.execute('DELETE FROM managed_attention WHERE request_id=?', (request['id'],))
    result = {'state': state, 'request_id': request['id'], 'attempt_id': payload['attempt_id'],
              'original_claim_preserved': True, 'model_sends': 0, 'task_completed': False,
              'prior_refusals_preserved': True, 'evidence_sha256': payload['evidence_sha256']}
    team.host.emit(db, actor['thread_id'], 'managed_ended_execution_reconciled', result)
    return result
