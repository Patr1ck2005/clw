"""Operator actions; original execution receipts remain authoritative."""
from pathlib import Path
import hashlib,json,re
from harness_state import require,stamp,canonical
from harness_team_common import object_fields,text

def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS managed_withdrawals(
        message_id TEXT PRIMARY KEY,page_id TEXT NOT NULL,request_id TEXT NOT NULL,
        kind TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,withdrawn_at TEXT NOT NULL)''')
    db.execute('''CREATE TABLE IF NOT EXISTS managed_partial_retirements(
        request_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,observation_hash TEXT NOT NULL,
        fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL)''')


def retire_partial(managed,db,p,*,local_jobs_verified=False):
    """Retire one observed partial public turn without claiming it was unsent or successful.

    This is a process-private, explicit operator action. The renderer supplies a
    fresh, completed DOM identity; the local MCP Job probe must be clear. Neither
    condition can be inferred from a missing browser receipt alone.
    """
    object_fields(p,{'page_id','request_id','attempt_id','observation_hash','url',
                     'user_hash','assistant_turn_hash','user_text','assistant_text','reason','confirm',
                     'complete','history_at_latest','generating','draft','composing'})
    require(p['confirm'] is True,'managed_partial_retirement_confirmation_required',403)
    require(all(type(p[k]) is bool for k in ('complete','history_at_latest','generating','draft','composing'))
            and p['complete'] and p['history_at_latest']
            and not any(p[k] for k in ('generating','draft','composing')),
            'managed_partial_retirement_turn_not_complete',409)
    require(all(isinstance(p[k],str) and re.fullmatch('[0-9a-f]{64}',p[k])
                for k in ('observation_hash','user_hash','assistant_turn_hash')),
            'managed_partial_retirement_identity',409)
    reason=text(p['reason'],'reason',2000)
    live_user=text(p['user_text'],'user_text',512000)
    live_assistant=text(p['assistant_text'],'assistant_text',48000)
    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
    require(page and page['phase']=='bound' and page['parent_target'] and page['url']==p['url'],
            'managed_partial_retirement_page_changed',409)
    partial=db.execute('SELECT * FROM managed_partial_public_sends WHERE attempt_id=?',
                       (p['attempt_id'],)).fetchone()
    require(partial and partial['observation_hash']==p['observation_hash'],
            'managed_partial_retirement_observation_changed',409)
    artifact=db.execute("SELECT * FROM managed_artifacts WHERE id=? AND request_id=? AND thread_id=? AND source='public_dom_partial_send'",
                        (partial['artifact_id'],p['request_id'],page['thread_id'])).fetchone()
    require(artifact and Path(artifact['path']).is_file()
            and hashlib.sha256(Path(artifact['path']).read_bytes()).hexdigest()==artifact['sha256'],
            'managed_partial_retirement_artifact_changed',409)
    evidence=json.loads(Path(artifact['path']).read_text(encoding='utf-8-sig'))
    observed=evidence['observation']
    require(evidence['attempt_id']==p['attempt_id'] and evidence['request_id']==p['request_id']
            and all(p[k]==observed[k] for k in ('url','user_hash','assistant_turn_hash'))
            and live_user==observed['user_text']
            and live_assistant==observed['assistant_text'],
            'managed_partial_retirement_public_turn_changed',409)
    fingerprint=hashlib.sha256(canonical({k:p[k] for k in p if k!='reason'} | {'reason':reason}).encode()).hexdigest()
    old=db.execute('SELECT * FROM managed_partial_retirements WHERE request_id=?',(p['request_id'],)).fetchone()
    if old:
        require(old['attempt_id']==p['attempt_id'] and old['fingerprint']==fingerprint,
                'managed_partial_retirement_conflict',409)
        return {**json.loads(old['result']),'replayed':True}
    request=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',
                       (p['request_id'],page['thread_id'])).fetchone()
    attempt=db.execute('SELECT * FROM control_attempts WHERE id=? AND request_id=? AND thread_id=?',
                       (p['attempt_id'],p['request_id'],page['thread_id'])).fetchone()
    attention=db.execute('SELECT * FROM managed_attention WHERE request_id=? AND attempt_id=?',
                         (p['request_id'],p['attempt_id'])).fetchone()
    prepared=db.execute('SELECT * FROM managed_dispatches WHERE attempt_id=?',(p['attempt_id'],)).fetchone()
    require(request and request['phase']=='queued' and request['claim_id'] is None
            and not request['cancel_requested'] and attempt and attempt['state']=='dispatching'
            and attempt['dispatched'] is not None and attempt['acknowledged'] is None
            and prepared and attention and evidence['prepared_prompt_hash']==prepared['prompt_hash'],
            'managed_partial_retirement_original_changed',409)
    run=managed.host.team.run_for_request(db,request['id'])
    require(run and run['state'] in ('running','draining') and
            db.execute('SELECT 1 FROM host_team_work WHERE run_id=? AND request_id=?',(run['id'],request['id'])).fetchone(),
            'managed_partial_retirement_run_changed',409)
    scope=managed.host.team.scopes.scope(db,page['thread_id'])
    lease=db.execute('SELECT * FROM host_team_leases WHERE request_id=? AND thread_id=?',
                     (request['id'],page['thread_id'])).fetchone()
    thread=db.execute('SELECT status,active_turn FROM threads WHERE id=?',(page['thread_id'],)).fetchone()
    owner=db.execute('SELECT source,attempt_id FROM managed_pause_owners WHERE page_id=?',(page['page_id'],)).fetchone()
    require(scope and scope['access']=='read' and not json.loads(scope['resources'])
            and lease and lease['access']=='read' and not json.loads(lease['resources'])
            and thread and thread['active_turn'] in (None,request['id'])
            and thread['status'] in ('waiting','needs_attention','processing')
            and page['paused'] and owner and owner['source']=='attention'
            and owner['attempt_id']==attempt['id'],
            'managed_partial_retirement_execution_not_quiescent',409)
    require(not managed.host.collaboration.outstanding(db,request['id'])
            and not db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',(request['id'],)).fetchone()
            and not db.execute('SELECT 1 FROM host_replies WHERE request_id=?',(request['id'],)).fetchone()
            and not db.execute('SELECT 1 FROM control_browser_receipts WHERE request_id=?',(request['id'],)).fetchone()
            and not db.execute('SELECT 1 FROM managed_tool_received WHERE attempt_id=?',(attempt['id'],)).fetchone()
            and not db.execute('SELECT 1 FROM managed_turn_outcomes WHERE attempt_id=?',(attempt['id'],)).fetchone()
            and not db.execute('SELECT 1 FROM managed_artifacts WHERE request_id=? AND id<>?',
                               (request['id'],partial['artifact_id'])).fetchone()
            and not db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','unknown')",
                               (page['thread_id'],)).fetchone(),
            'managed_partial_retirement_prior_execution',409)
    # The page is finished and its only workspace reservation is read-only.
    # Even so, never retire while any Local-MCP-B job is still active/unknown.
    require(local_jobs_verified is True,'managed_partial_retirement_external_jobs_not_idle',409)
    reusable=not db.execute('SELECT 1 FROM managed_stops WHERE page_id=? AND resumed=0',
                            (page['page_id'],)).fetchone() and not db.execute(
                            'SELECT 1 FROM managed_page_issues WHERE page_id=?',(page['page_id'],)).fetchone()
    result={'request_id':request['id'],'status':'blocked','source':'operator_retired_partial_public_send',
            'reason':reason,'original_attempt_id':attempt['id'],'public_send_observed':True,
            'original_attempt_preserved':True,'old_request_retried':False,
            'worker_reported_success':False,'model_called':False,
            'artifact':{'path':artifact['path'],'sha256':artifact['sha256']},
            'worker_available_for_new_work':bool(reusable),'external_jobs_verified_zero':True}
    db.execute('INSERT INTO managed_partial_retirements VALUES(?,?,?,?,?,?)',
               (request['id'],attempt['id'],partial['observation_hash'],fingerprint,canonical(result),stamp()))
    db.execute('INSERT INTO host_team_attention_resolutions VALUES(?,?,?,?,?,?)',
               (request['id'],run['id'],run['controller_thread'],attempt['id'],reason,stamp()))
    db.execute("UPDATE control_attempts SET state='partial_retired' WHERE id=?",(attempt['id'],))
    db.execute("UPDATE host_requests SET phase='blocked',finished_at=? WHERE id=?",(stamp(),request['id']))
    db.execute("UPDATE threads SET status='error',active_turn=NULL,updated_at=? WHERE id=?",
               (stamp(),page['thread_id']))
    db.execute('DELETE FROM managed_attention WHERE request_id=?',(request['id'],))
    if reusable:
        db.execute('UPDATE managed_pages SET paused=0 WHERE page_id=?',(page['page_id'],))
        db.execute('DELETE FROM managed_pause_owners WHERE page_id=?',(page['page_id'],))
    managed.host.emit(db,page['thread_id'],'host_result',result)
    managed.host.emit(db,run['controller_thread'],'host_child_result',
                      {'request_id':run['controller_request'],'child_request_id':request['id'],
                       'child_thread_id':page['thread_id'],'status':'blocked','source':result['source'],
                       'parent_completed':False})
    return result

def can_withdraw(db,thread,request_id,note_id=None):
    r=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',(request_id,thread)).fetchone()
    if note_id:
        future=db.execute('SELECT batch_id FROM managed_next_round_notes WHERE note_id=? AND source_request_id=? AND thread_id=?',(note_id,request_id,thread)).fetchone()
        if future:
            return bool(r and not r['cancel_requested'] and (not future['batch_id'] or
                not db.execute('SELECT 1 FROM operations WHERE id=?',(future['batch_id'],)).fetchone() and
                db.execute("SELECT 1 FROM managed_next_round_batches WHERE id=? AND state='prepared'",(future['batch_id'],)).fetchone()))
    if not r or r['cancel_requested'] or r['phase'] not in ('queued','processing','suspended'):return False
    if note_id:
        unread=db.execute('SELECT 1 FROM host_notes n JOIN host_unread_notes u ON n.id=u.note_id WHERE n.id=? AND n.request_id=?',(note_id,request_id)).fetchone()
        reserved=db.execute("SELECT 1 FROM control_browser_note_receipts n JOIN control_attempts a ON a.id=n.attempt_id WHERE n.note_id=? AND ((a.dispatched IS NOT NULL AND a.state<>'not_sent') OR a.acknowledged IS NOT NULL OR a.state IN ('dispatching','sent','unknown','acknowledged'))",(note_id,)).fetchone()
        return bool(unread and not reserved)
    sent=db.execute("SELECT 1 FROM control_attempts WHERE request_id=? AND ((dispatched IS NOT NULL AND state<>'not_sent') OR acknowledged IS NOT NULL OR state IN ('dispatching','sent','unknown','acknowledged'))",(request_id,)).fetchone()
    return r['phase']=='queued' and not r['claim_id'] and not sent

def withdraw(host,db,p):
    object_fields(p,{'page_id','request_id'},{'note_id'})
    require('note_id' not in p or isinstance(p['note_id'],str) and bool(p['note_id']),'managed_note_id_required')
    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
    require(page and page['phase']=='bound','managed_page_not_ready',409)
    note=p.get('note_id');ident=note or p['request_id']
    old=db.execute('SELECT * FROM managed_withdrawals WHERE message_id=?',(ident,)).fetchone()
    if old:
        require(old['page_id']==p['page_id'] and old['request_id']==p['request_id'],'managed_withdraw_identity_changed',409)
    else:
        require(can_withdraw(db,page['thread_id'],p['request_id'],note),'managed_message_already_delivering',409)
        r=db.execute('SELECT * FROM host_requests WHERE id=?',(p['request_id'],)).fetchone()
        at=stamp()
        if not note:
            db.execute("UPDATE host_requests SET phase='cancelled',cancel_requested=1,finished_at=? WHERE id=?",(stamp(),r['id']))
            db.execute("UPDATE threads SET status='idle',active_turn=NULL,updated_at=? WHERE id=? AND active_turn=?",(stamp(),page['thread_id'],r['id']))
            db.execute('INSERT INTO managed_withdrawals VALUES(?,?,?,?,?,?,?)',(ident,page['page_id'],r['id'],'goal',r['text'],r['created_at'],at))
        notes=db.execute('SELECT n.* FROM host_notes n WHERE n.request_id=? AND (EXISTS (SELECT 1 FROM host_unread_notes u WHERE u.note_id=n.id) OR EXISTS (SELECT 1 FROM managed_next_round_notes q WHERE q.note_id=n.id))'+(' AND n.id=?' if note else ''),(r['id'],note) if note else (r['id'],)).fetchall()
        for n in notes:
            db.execute('INSERT INTO managed_withdrawals VALUES(?,?,?,?,?,?,?)',(n['id'],page['page_id'],r['id'],'note',n['text'],n['created_at'],at))
            # Archive before removal: legacy/context readers must never redeliver
            # a withdrawn note. The original event and this full archive survive.
            db.execute('DELETE FROM host_unread_notes WHERE note_id=?',(n['id'],))
            queued=db.execute('SELECT batch_id FROM managed_next_round_notes WHERE note_id=?',(n['id'],)).fetchone()
            if queued and queued['batch_id']:
                db.execute("UPDATE managed_next_round_batches SET state='withdrawn' WHERE id=?",(queued['batch_id'],))
                db.execute('UPDATE managed_next_round_notes SET batch_id=NULL WHERE batch_id=?',(queued['batch_id'],))
            db.execute('DELETE FROM managed_next_round_notes WHERE note_id=?',(n['id'],))
            db.execute('DELETE FROM host_notes WHERE id=?',(n['id'],))
        host.emit(db,page['thread_id'],'managed_message_withdrawn',{'request_id':r['id'],'message_id':ident,'kind':'note' if note else 'goal','model_started':False})
        if not note:host.emit(db,page['thread_id'],'host_result',{'request_id':r['id'],'status':'cancelled','reason':'operator_withdrew_unsent_goal','model_started':False})
    saved=old or db.execute('SELECT * FROM managed_withdrawals WHERE message_id=?',(ident,)).fetchone()
    restored=[saved['text']] if note else [r['text'] for r in db.execute("SELECT text FROM managed_withdrawals WHERE request_id=? AND withdrawn_at=? ORDER BY CASE kind WHEN 'goal' THEN 0 ELSE 1 END,created_at,rowid",(p['request_id'],saved['withdrawn_at']))]
    return {'state':'withdrawn','request_id':p['request_id'],'message_id':ident,'text':'\n\n'.join(restored),'replayed':bool(old),'model_sends':0}

def check_model_change(db,p,label):
    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
    require(page and page['phase']=='bound','managed_page_not_ready',409)
    require(not page['parent_target'],'managed_worker_model_inherited',409)
    require(page['model']==label(p['expected_model']) and page['effort']==label(p['expected_effort']),'managed_model_settings_changed',409)
    require(not db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('processing','suspended')",(page['thread_id'],)).fetchone(),'managed_model_wait_for_turn_end',409)
    require(not db.execute("SELECT 1 FROM control_attempts a JOIN host_requests r ON r.id=a.request_id WHERE a.thread_id=? AND (a.state IN ('dispatching','sent','unknown') OR (a.dispatched IS NOT NULL AND r.phase IN ('queued','processing','suspended')))",(page['thread_id'],)).fetchone(),'managed_original_send_unconfirmed',409)
    require(not db.execute("SELECT 1 FROM managed_handoffs WHERE source_page=? AND state IN ('enrolling','active')",(p['page_id'],)).fetchone(),'managed_resume_successor_instead',409)
    return page
