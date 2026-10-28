"""The first received Web message can also own an ordinary Host work request.

Enrollment establishes the real Session first. Work starts only after the
existing scope/lease gate, and results use the existing Host reply journal.
No synthetic browser attempt, second executor, or second model Send is made.
"""
import hashlib,json,re,secrets
from harness_run_limits import deadline_live,sends_available
from pathlib import Path
from harness_state import require,canonical,stamp,HarnessError
from harness_team_common import object_fields
from task_worker import file_bytes
from harness_recovery import DELAYS,digest
import harness_managed_preparation as preparation

MODE='task_v1'


def bootstrap_wait(managed,db,page):
    """Delay a known conflicting first task before spending its enrollment turn.

    This is a preflight, not an execution grant; the ordinary claim gate still
    checks all resources and identities when the actual task starts.
    """
    if not (page['parent_target'] and page['phase']=='reserved' and
            page['bootstrap_state']=='pending' and enabled(page)):return None
    settings=json.loads(page['settings'])
    candidate={'root':page['root'],'access':settings['access'],
               'write_paths':canonical(settings['write_paths']),
               'resources':canonical(settings.get('resources',[]))}
    for held in db.execute('SELECT * FROM host_team_leases'):
        other=dict(held);scope=managed.host.team.scopes.scope(db,held['thread_id'])
        if scope:other['write_paths']=scope['write_paths']
        if managed.host.team.scopes.conflict(candidate,other):
            return {'state':'waiting_local_slot','reason':'team_workspace_or_resource_busy',
                    'blocking_request_id':held['request_id'],'message_sent':False}
    return None

def prepare_worker(managed,db,parent,binding,p):
    """Attach a full task to a provably unsent child, retaining page and scope."""
    from harness_managed_preparation import instructions
    from harness_managed_prompt import enrollment_blocks
    object_fields(p,{'target','first_turn_instructions','activate'})
    require(p['activate'] is True,'managed_activate_required')
    require(binding['enabled'] and not managed.paused(db,parent),'managed_parent_paused',409)
    child=db.execute('SELECT * FROM managed_pages WHERE target_id=? AND parent_target=?',(p['target'],parent['target_id'])).fetchone()
    require(child,'managed_worker_not_owned',403)
    require(child['phase']=='reserved' and child['bootstrap_state']=='pending' and not child['thread_id'],
            'managed_worker_already_sent_or_enrolled',409)
    require(not db.execute('SELECT 1 FROM managed_bootstrap_budget WHERE page_id=?',(child['page_id'],)).fetchone(),
            'managed_worker_send_already_admitted',409)
    issue=db.execute('SELECT kind,detail FROM managed_page_issues WHERE page_id=?',(child['page_id'],)).fetchone()
    require(not issue or issue['kind']=='preparation_required','managed_worker_independent_issue',409)
    require(not db.execute('SELECT 1 FROM managed_stops WHERE page_id=? AND resumed=0',(child['page_id'],)).fetchone(),
            'managed_worker_user_stopped',409)
    require(not child['paused'] or (issue and issue['kind']=='preparation_required'),
            'managed_worker_operator_paused',409)
    pause_owner=db.execute('SELECT source FROM managed_pause_owners WHERE page_id=?',(child['page_id'],)).fetchone()
    require(not pause_owner or pause_owner['source']=='page_issue','managed_worker_operator_paused',409)
    work=instructions(p);require(bool(work),'managed_complete_first_task_required')
    request=db.execute("SELECT * FROM host_requests WHERE thread_id=? AND phase='processing' AND cancel_requested=0 ORDER BY created_at DESC LIMIT 1",(binding['thread_id'],)).fetchone()
    run=managed.host.team.run_for_request(db,request['id']) if request else None
    require(run and run['state']=='running' and run['controller_request']==request['id'] and deadline_live(run,managed.host.clock()),
            'managed_first_task_requires_active_controller',409)
    settings=json.loads(child['settings'])
    previous={'first_turn_mode':settings.get('first_turn_mode','prepare_v1'),
              'instructions_sha256':digest(settings.get('first_turn_instructions','')),
              'issue':dict(issue) if issue else None,'paused':bool(child['paused'])}
    settings.update(first_turn_mode=MODE,first_turn_instructions=work,
        first_task_parent={'run_id':run['id'],'request_id':request['id'],'claim_id':request['claim_id']},
        bootstrap_model_selection={**(settings.get('model_selection') or {}),'model':child['model'],'effort':child['effort']},
        bootstrap_model_verified=False,work_model_pending=False)
    ticket='clwm_'+secrets.token_urlsafe(32)
    blocks=enrollment_blocks(root=child['root'],account=settings.get('account','B'),instructions=work,first_turn_mode=MODE,
        cli=str(managed.host.root/'scripts/harness_managed_client.py'),store_id=managed.state.id,target=child['target_id'],ticket=ticket)
    db.execute('UPDATE managed_pages SET settings=?,bootstrap_text=?,ticket_hash=?,paused=? WHERE page_id=?',
        (canonical(settings),''.join(block['text'] for block in blocks),digest(ticket),0,child['page_id']))
    db.execute('DELETE FROM managed_page_issues WHERE page_id=?',(child['page_id'],))
    db.execute('DELETE FROM managed_pause_owners WHERE page_id=?',(child['page_id'],))
    managed.host.emit(db,binding['thread_id'],'managed_worker_first_task_prepared',{
        'page_id':child['page_id'],'request_id':request['id'],'previous':previous,'activated':p['activate'],
        'scope_unchanged':True,'model_sends':0})
    return {'state':'reserved','target':child['target_id'],'page_id':child['page_id'],
            'first_turn_mode':MODE,'activated':p['activate'],'model':child['model'],'effort':child['effort'],
            'scope_unchanged':True,'message_sent':False,'next':'wait-ready'}

def fail(managed,db,page,p):
    """Observe an actual failed bootstrap, not a fabricated control attempt."""
    settings=json.loads(page['settings'])
    require(received(page) and p.get('history_at_latest') is True and
            p.get('marker')=='[CLW-BOOTSTRAP:'+page['page_id']+']' and p.get('marker_count')==1 and
            p.get('failure') in ('Thinking failed','思考失败','无法思考','Something went wrong while generating the response.','生成回复时出错',
                'Error in message stream','Error in message stream.','消息流中的错误','消息流中的错误。','消息流中的错误.') and
            re.fullmatch('[0-9a-f]{64}',p.get('user_hash','')) and
            re.fullmatch(r'https://chatgpt\.com/c/[A-Za-z0-9-]+',p.get('url','')),
            'managed_first_task_failure_unverified',409)
    r=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',(settings.get('first_task_request_id'),page['thread_id'])).fetchone()
    require(r and r['phase']=='processing' and r['claim_id'] and not r['cancel_requested'] and
            not settings.get('first_task_outcome'),'managed_first_task_not_processing',409)
    failure_hash=digest(p['failure']);key=digest('bootstrap:'+page['page_id']+':'+failure_hash)
    due=managed.host.clock()+DELAYS[0]
    db.execute('INSERT INTO control_recoveries VALUES(?,?,?,?,?,?,?)',
        (r['id'],key,p['user_hash'],1,due,managed.control.epoch(db,r),1))
    # Initial Send was admitted only on an error-free new page. Subsequent
    # recovery attempts use the same baseline and bounded recovery ledger.
    db.execute('INSERT OR IGNORE INTO control_baselines VALUES(?,?)',(r['id'],digest('')))
    settings['first_task_failure']={'request_id':r['id'],'user_hash':p['user_hash'],'failure_hash':failure_hash,'recovery_key':key,'due':due}
    db.execute("UPDATE managed_pages SET phase='bound',url=?,settings=?,seen=? WHERE page_id=?",
               (p['url'],canonical(settings),managed.host.clock(),page['page_id']))
    managed.host.emit(db,page['thread_id'],'managed_first_task_generation_failed',{
        'request_id':r['id'],'failure':p['failure'],'proof':'own_session_and_unique_bootstrap_message',
        'claim_preserved':True,'model_sends':0})
    return {'state':'first_task_failed_recovery_pending','request_id':r['id'],'due':due}

def recovery_candidate(control,db,peer,binding,page):
    record=json.loads(peer['settings']).get('first_task_failure')
    if not record:return None
    r=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',(record['request_id'],binding['thread_id'])).fetchone()
    if not r or r['phase']!='processing' or r['cancel_requested'] or control.host.collaboration.outstanding(db,r['id']):return None
    if db.execute('SELECT 1 FROM control_attempts WHERE request_id=? AND acknowledged IS NOT NULL',(r['id'],)).fetchone():return None
    rec=db.execute('SELECT * FROM control_recoveries WHERE request_id=? AND failure_hash=?',(r['id'],record['recovery_key'])).fetchone()
    if (not rec or not page['failure_kind'] or page['failure_hash']!=record['failure_hash'] or
        page['user_hash']!=rec['user_hash'] or control.host.clock()<rec['due'] or control.epoch(db,r)!=rec['base_epoch']):return None
    return dict(r),-rec['ordinal']

def enabled(page):
    return json.loads(page['settings']).get('first_turn_mode')==MODE

def received(page):
    settings=json.loads(page['settings'])
    return bool(enabled(page) and page['thread_id'] and page['phase']=='receiver_enrolled'
                and settings.get('bootstrap_model_verified') and not settings.get('work_model_pending')
                and page['bootstrap_state'] in ('sending','sent','unknown'))

def reconcile_turn(managed,db,page,p):
    """Real task receipts plus the original finished turn replace a copied echo."""
    require(received(page) and
            p.get('history_at_latest') is True and p.get('public_complete') is True and
            p.get('user_marker')=='[CLW-BOOTSTRAP:'+page['page_id']+']' and p.get('marker_count')==1,
            'managed_first_turn_identity_unverified',409)
    settings=json.loads(page['settings'])
    r=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',
        (settings.get('first_task_request_id'),page['thread_id'])).fetchone()
    require(r and not r['cancel_requested'],'managed_first_turn_receipt_required',409)
    if r['phase']=='queued':
        # A real enrollment may finish before admission. Bind the SAME page
        # and retain the queued request, but never grant it from public prose.
        receipt=db.execute("""SELECT rowid FROM managed_receipts WHERE actor=?
          AND json_extract(response,'$.state')='receiver_enrolled'
          AND json_extract(response,'$.first_task.request_id')=? LIMIT 1""",
          (page['page_id'],r['id'])).fetchone()
        require(receipt and not r['claim_id'] and not settings.get('first_task_outcome') and
                not db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(r['id'],)).fetchone() and
                not db.execute('SELECT 1 FROM control_attempts WHERE request_id=?',(r['id'],)).fetchone(),
                'managed_first_turn_unclaimed_receipt_required',409)
        settings['first_task_outcome']='not_started'
        settings['first_task_recovery']={'request_id':r['id'],'reason':'public_turn_ended_before_admission',
                                         'operator_resume_required':True}
        db.execute('UPDATE managed_pages SET settings=?,paused=1 WHERE page_id=?',
                   (canonical(settings),page['page_id']))
        db.execute("INSERT OR IGNORE INTO managed_pause_owners VALUES(?,'page_issue',NULL)",(page['page_id'],))
        issue=db.execute('SELECT kind,detail FROM managed_page_issues WHERE page_id=?',(page['page_id'],)).fetchone()
        managed.host.emit(db,page['thread_id'],'managed_first_turn_not_admitted',{
            'request_id':r['id'],'enrollment_receipt_row':receipt[0],
            'previous_issue':dict(issue) if issue else None,'outcome':'not_started',
            'original_request_preserved':True,'operator_resume_required':True,'model_sends':0})
        return
    require(r['claim_id'],'managed_first_turn_receipt_required',409)
    if r['phase']=='suspended':
        receipt=db.execute("SELECT seq FROM events WHERE thread_id=? AND kind='host_waiting_children' AND json_extract(data,'$.request_id')=? ORDER BY seq DESC LIMIT 1",
            (page['thread_id'],r['id'])).fetchone()
        require(receipt and settings.get('first_task_outcome') in (None,'yielded'),'managed_first_wait_receipt_required',409)
        settings['first_task_outcome']='yielded'
    else:
        require((r['phase'],settings.get('first_task_outcome')) in (('completed','completed'),('blocked','needs_attention')),
                'managed_first_turn_receipt_required',409)
        receipt=db.execute("SELECT seq FROM events WHERE thread_id=? AND kind='host_result' AND json_extract(data,'$.request_id')=? ORDER BY seq DESC LIMIT 1",
            (page['thread_id'],r['id'])).fetchone()
        require(receipt,'managed_first_turn_receipt_required',409)
    db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),page['page_id']))
    issue=db.execute('SELECT kind,detail FROM managed_page_issues WHERE page_id=?',(page['page_id'],)).fetchone()
    owner=db.execute('SELECT * FROM managed_pause_owners WHERE page_id=?',(page['page_id'],)).fetchone()
    # Repair only our missing-echo false alarm. A user pause or another fault is retained.
    if issue and issue['kind']=='bootstrap_receipt_missing' and issue['detail'].startswith('工具已接入，但本轮最终回复缺少原接入标记') and owner and owner['source']=='page_issue':
        db.execute('UPDATE managed_pages SET paused=0 WHERE page_id=?',(page['page_id'],))
        db.execute('DELETE FROM managed_pause_owners WHERE page_id=?',(page['page_id'],))
    managed.host.emit(db,page['thread_id'],'managed_first_turn_reconciled',{
        'request_id':r['id'],'source_event_seq':receipt['seq'],'outcome':settings['first_task_outcome'],
        'proof':'own_session_receipt_and_unique_sent_bootstrap','model_sends':0})

def register(managed,db,page,binding):
    settings=json.loads(page['settings'])
    if not enabled(page):return None
    require(received(page),'managed_first_task_model_or_send_unverified',409)
    work=settings['first_turn_instructions']
    if page['parent_target']:
        parent=managed.host.binding(db,target=page['parent_target'])
        original=settings['first_task_parent']
        result=managed.host.team.assign(db,parent,{'run_id':original['run_id'],'claim_id':original['claim_id'],
             'target':page['target_id'],'text':work,'depends_on':[],'resources':settings.get('resources',[])},
             'first-task-'+page['page_id'],enrollment=page['page_id'])
        request_id=result['request_id']
    else:
        request_id='clw-first-'+page['page_id'].removeprefix('web-')
        db.execute("INSERT INTO host_requests(id,thread_id,text,phase,created_at) VALUES(?,?,?,'queued',?)",
                   (request_id,binding['thread_id'],work,stamp()))
        db.execute("UPDATE threads SET status='waiting',active_turn=?,updated_at=? WHERE id=?",(request_id,stamp(),binding['thread_id']))
        managed.host.emit(db,binding['thread_id'],'host_queued',{'request_id':request_id,'source':'first_received_web_turn'})
    settings['first_task_request_id']=request_id
    db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),page['page_id']))
    return {'request_id':request_id,'state':'queued','next':'first-task','model_sends':1}

def begin(managed,db,page,binding,p,git_probe,key):
    object_fields(p,set())
    require(enabled(page) and received(page),'managed_first_task_not_receiving',409)
    require(not managed.paused(db,page) and binding['enabled'],'managed_parent_paused',409)
    settings=json.loads(page['settings'])
    r=dict(db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',
                     (settings['first_task_request_id'],binding['thread_id'])).fetchone())
    require(not r['cancel_requested'] and r['phase'] in ('queued','processing'),'managed_first_task_already_ended',409)
    if r['phase']=='queued':
        db.execute('SAVEPOINT first_task_claim')
        try:
            managed.host.team.claim_gate(db,r,git_probe=git_probe)
            require(not managed.host.collaboration.busy(db,binding['thread_id'],git_probe=git_probe,held_request_id=r['id']),
                    'host_checkout_execution_busy',409)
            claim='clw-first-claim-'+page['page_id'].removeprefix('web-')
            db.execute("UPDATE host_requests SET phase='processing',claim_id=? WHERE id=?",(claim,r['id']))
            db.execute("UPDATE threads SET status='processing',active_turn=?,updated_at=? WHERE id=?",(r['id'],stamp(),binding['thread_id']))
            managed.host.emit(db,binding['thread_id'],'host_claimed',{'request_id':r['id'],'source':'own_session_first_received_turn'})
            managed.open_run_in_transaction(db,page,git_probe=git_probe)
            db.execute('RELEASE first_task_claim')
            r.update(phase='processing',claim_id=claim)
        except HarnessError as error:
            db.execute('ROLLBACK TO first_task_claim');db.execute('RELEASE first_task_claim')
            if error.code in ('team_workspace_or_resource_busy','host_checkout_execution_busy','team_parallel_budget'):
                return {'state':'waiting_local_slot','reason':error.code,'request_id':r['id'],'work_started':False}
            raise
    return {'state':'first_task_ready','request':r,'run':managed.host.team.run_for_request(db,r['id']),
            'execution_context':managed.host.team.scopes.execution_context(db,binding['thread_id']),
            'result_delivery':preparation.result_delivery(managed,binding,r,key),
            'result_operation':'turn-end','no_second_send':True}

def finish(managed,db,page,binding,r,p,key):
    settings=json.loads(page['settings'])
    require(enabled(page) and settings.get('first_task_request_id')==r['id'] and page['phase']=='receiver_enrolled',
            'managed_first_task_not_current',409)
    if p['outcome']=='completed':
        notes=db.execute('SELECT n.id,n.text FROM host_notes n JOIN host_unread_notes u ON u.note_id=n.id AND u.request_id=n.request_id WHERE n.request_id=?',(r['id'],)).fetchall()
        if notes:
            db.execute('DELETE FROM host_unread_notes WHERE request_id=?',(r['id'],))
            return {'state':'additional_instructions_pending','additional_instructions':[dict(n) for n in notes],'task_completed':False}
    require(not ('markdown' in p and 'markdown_path' in p),'managed_single_result_source')
    if 'markdown_path' in p:raw=file_bytes(Path(page['root']),p['markdown_path'],8*1024*1024)
    else:
        value=p.get('markdown','让出等待' if p['outcome']=='yielded' else '')
        require(isinstance(value,str) and 0<len(value)<=48000,'managed_first_task_result_required')
        raw=value.encode('utf-8')
    sha=hashlib.sha256(raw).hexdigest();dest=managed.state.path.parent/'managed-results'/(sha+'.md');dest.parent.mkdir(exist_ok=True)
    if not dest.exists():dest.write_bytes(raw)
    ident='first-task-'+page['page_id']
    db.execute('INSERT INTO managed_artifacts VALUES(?,?,?,?,?,?,?,?)',
               (ident,r['id'],binding['thread_id'],str(dest),sha,len(raw),'local_mcp_public_result',managed.host.clock()))
    if p['outcome']!='yielded':
        body=raw.decode('utf-8-sig')
        if len(body)>46000:body=body[:1000]+'\n完整结果：'+str(dest)+'\nSHA256: '+sha
        managed.host.project_reply(db,binding,dict(r),{'request_id':r['id'],'claim_id':p['claim_id'],
            'reply_id':'clw-initial-result-'+hashlib.sha256(key.encode()).hexdigest(),
            'status':'completed' if p['outcome']=='completed' else 'blocked','text':body})
    settings['first_task_outcome']=p['outcome']
    db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),page['page_id']))
    return {'state':'turn_outcome_saved','outcome':p['outcome'],'path':str(dest),'sha256':sha,'first_task':True}
