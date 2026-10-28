"""Human goal/review controls on the desktop's private pipe.

Saving and review are metadata operations. Prepared next-package intents share
the original message.send key; the Host binds the new goal in its send transaction.
No model tool can perform a human review through this module.
"""
from pathlib import Path
import hashlib, json, time, re
from harness_state import require, canonical, stamp,HarnessError
from harness_team_common import object_fields, hash_value
import harness_managed_budget as budget
from harness_work_package import WORK_PACKAGE_GUIDANCE

TERMINAL=('completed','blocked','failed','cancelled')


def schema(db):
    # PRAGMA then ALTER must share one write lock with any concurrent desktop
    # or watcher startup. Both preserve the legacy goal rows and defaults.
    if not db.in_transaction:db.execute('BEGIN IMMEDIATE')
    db.execute('''CREATE TABLE IF NOT EXISTS managed_goals(
      page_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,store_id TEXT NOT NULL,
      identity TEXT NOT NULL,objective TEXT NOT NULL,state TEXT NOT NULL,
      request_id TEXT NOT NULL,pending_id TEXT,cycles INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',updated REAL NOT NULL)''')
    columns={row['name'] for row in db.execute('PRAGMA table_info(managed_goals)')}
    for name,definition in [('control_mode',"TEXT NOT NULL DEFAULT 'automatic'"),
                            ('revision','INTEGER NOT NULL DEFAULT 0'),('review','TEXT'),
                            ('result_status','TEXT'),('wait_context','TEXT'),
                            ('result_contract','INTEGER NOT NULL DEFAULT 1')]:
        if name not in columns:db.execute('ALTER TABLE managed_goals ADD COLUMN '+name+' '+definition)
    db.execute('''CREATE TABLE IF NOT EXISTS managed_goal_receipts(
      id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,action TEXT NOT NULL,
      page_id TEXT NOT NULL,response TEXT NOT NULL,basis TEXT,created TEXT NOT NULL,
      accepted_request_id TEXT)''')
    if 'discontinued' not in {r['name'] for r in db.execute('PRAGMA table_info(managed_goal_receipts)')}:
        db.execute('ALTER TABLE managed_goal_receipts ADD COLUMN discontinued TEXT')
    db.execute('''CREATE TABLE IF NOT EXISTS managed_goal_revocations(
      id TEXT PRIMARY KEY,page_id TEXT NOT NULL,created TEXT NOT NULL)''')
    db.execute('''CREATE TABLE IF NOT EXISTS managed_goal_turn_metadata(
      attempt_id TEXT PRIMARY KEY,status TEXT,wait_context TEXT)''')


def identity(db,page):
    from harness_goal_watch import Goals
    return Goals.identity(db,page)


def current_request(db,page):
    return db.execute('SELECT * FROM host_requests WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
                      (page['thread_id'],)).fetchone()


def result_metadata(content,goal_status=None,wait_context=None):
    """An explicit status in the original result; never infer completion prose."""
    matches=re.findall(r'^CLW_GOAL_STATUS:\s*(delivered|waiting|in_progress|complete|ready_for_review)\s*$',content,re.M)
    status=goal_status or (matches[-1] if matches else None)
    if status=='complete':status='delivered'
    if status not in (None,'delivered','waiting','in_progress','ready_for_review'):
        raise ValueError('managed_goal_result_status_invalid')
    if wait_context is None:
        marker=re.findall(r'^CLW_GOAL_WAIT:\s*(\{.*\})\s*$',content,re.M)
        if marker:
            try:wait_context=json.loads(marker[-1])
            except ValueError:wait_context=None
    if status=='waiting':
        require(isinstance(wait_context,dict) and wait_context.get('independent_work_complete') is True,
                'managed_goal_wait_independent_work_required',409)
        jobs=wait_context.get('job_ids')
        require(isinstance(jobs,list) and 1<=len(jobs)<=32 and len(jobs)==len(set(jobs)) and
                all(isinstance(j,str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}',j) for j in jobs),
                'managed_goal_wait_submitted_jobs_required',409)
        require(all(isinstance(wait_context.get(k),str) and 0<len(wait_context[k])<=4000 for k in ('result','resume')),
                'managed_goal_wait_resume_required',409)
        require(len(canonical(wait_context))<=16000,'managed_goal_wait_too_large')
    return status,wait_context


def apply_result(db,page,request,content,goal_status=None,wait_context=None):
    goal=goal_row(db,page)
    if not goal or goal['control_mode']!='automatic' or goal['request_id']!=request or goal['state'] not in ('active','waiting'):
        return
    # Malformed optional wait metadata cannot prevent saving the actual reply.
    try:status,waiting=result_metadata(content,goal_status,wait_context)
    except (ValueError,TypeError,HarnessError) as error:
        db.execute("UPDATE managed_goals SET state='needs_attention',reason=?,updated=? WHERE page_id=?",
                   (getattr(error,'code',str(error)),time.time(),page['page_id']))
        return
    if not status:return
    if status=='waiting':
        binding=db.execute('SELECT spec FROM host_bindings WHERE thread_id=?',(page['thread_id'],)).fetchone()
        session=json.loads(binding['spec']).get('session_id') if binding else None
        if session:
            if waiting.get('session_id') not in (None,session):
                db.execute("UPDATE managed_goals SET state='needs_attention',reason='goal_wait_original_session_changed',updated=? WHERE page_id=?",(time.time(),page['page_id']))
                return
            waiting={**waiting,'session_id':session}
    state={'delivered':'complete','waiting':'waiting','ready_for_review':'ready_for_review','in_progress':'active'}[status]
    db.execute('UPDATE managed_goals SET state=?,result_status=?,wait_context=?,reason=?,revision=revision+1,updated=? WHERE page_id=?',
               (state,status,canonical(waiting) if waiting else None,'goal_delivered' if status=='delivered' else 'waiting_external_results' if status=='waiting' else '',time.time(),page['page_id']))


def goal_row(db,page):
    return db.execute('SELECT * FROM managed_goals WHERE page_id=?',(page['page_id'],)).fetchone()


def basis(goal):
    if not goal:return None
    goal=dict(goal)
    return {key:goal.get(key) for key in ('page_id','thread_id','store_id','identity','objective','state',
                                          'request_id','control_mode','revision','review')}


def etag(db,page,goal):
    req=current_request(db,page)
    return hash_value({'identity':identity(db,page),'store_id':db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()[0],'goal':basis(goal),
                       'pending_id':goal['pending_id'] if goal else None,
                       'current_request_id':req['id'] if req else None})


def settled(db,page,request_id,exclude_operation=None):
    req=current_request(db,page)
    if not req or req['id']!=request_id or req['phase'] not in TERMINAL:return None
    run=db.execute('SELECT * FROM host_runs WHERE controller_request=? AND controller_thread=? ORDER BY created DESC,rowid DESC LIMIT 1',
                   (request_id,page['thread_id'])).fetchone()
    direct=json.loads(page['settings']).get('conversation_mode')=='direct'
    if not run and direct:run={'id':None,'state':'closed'}
    if not run or run['state']!='closed':return None
    if run['id'] and db.execute('SELECT 1 FROM host_team_leases WHERE run_id=?',(run['id'],)).fetchone():return None
    if run['id'] and db.execute("SELECT 1 FROM host_team_work w JOIN host_requests r ON r.id=w.request_id WHERE w.run_id=? AND r.phase NOT IN ('completed','blocked','failed','cancelled')",(run['id'],)).fetchone():return None
    if db.execute("SELECT 1 FROM host_delegations d LEFT JOIN host_requests r ON r.id=d.child_request_id WHERE d.parent_request_id=? AND (r.id IS NULL OR r.phase NOT IN ('completed','blocked','failed','cancelled'))",(request_id,)).fetchone():return None
    if db.execute("SELECT 1 FROM control_attempts WHERE thread_id=? AND state IN ('dispatching','sent','unknown')",(page['thread_id'],)).fetchone():return None
    if db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','unknown') AND (? IS NULL OR id<>?)",(page['thread_id'],exclude_operation,exclude_operation)).fetchone():return None
    return run


def artifact(db,page,request_id,managed=None):
    from harness_goal_evidence import original_result
    reason,result=original_result(db,page,request_id)
    if reason:return None
    if not result:return None
    result=dict(result)
    if managed is not None:
        try:
            path=Path(result['path']).resolve()
            roots=((managed.state.path.parent/'managed-results').resolve(),
                   (managed.host.root/'.local/harness/managed-results').resolve())
            if not any(path.is_relative_to(root) for root in roots):return None
            import os
            limit=4*1024*1024
            def signature(stat):return tuple(getattr(stat,key) for key in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns'))
            before=path.stat()
            if not 0<before.st_size<=limit:return None
            with path.open('rb') as stream:
                opened=os.fstat(stream.fileno())
                if signature(before)!=signature(opened):return None
                raw=stream.read(limit+1);after=os.fstat(stream.fileno())
            if len(raw)>limit or signature(before)!=signature(after) or signature(after)!=signature(path.stat()):return None
            if len(raw)!=result['bytes'] or hashlib.sha256(raw).hexdigest()!=result['sha256']:return None
        except (OSError,ValueError,TypeError):return None
    return {key:result[key] for key in ('path','sha256','bytes','source')}


def view(db,page,team,summary=False):
    goal=goal_row(db,page);req=current_request(db,page)
    if not goal:
        return {'configured':False,'mode':'manual','state':'not_set','objective':'',
                'etag':etag(db,page,None),'request_id':req['id'] if req else None,'revision':0,
                'review':None,'can_review':False,'can_start_next':False,'next':None,'next_recovery':None,
                'owner_identity_valid':False,'request_matches':False,'identity_valid':False}
    goal=dict(goal);review=json.loads(goal['review']) if goal.get('review') else None
    owner_same=(goal['page_id']==page['page_id'] and goal['thread_id']==page['thread_id'] and
                identity(db,page)==goal['identity'] and
                goal['store_id']==db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()[0])
    request_same=bool(req and req['id']==goal['request_id'])
    same=bool(owner_same and request_same)
    run=settled(db,page,goal['request_id']) if same and not goal['pending_id'] else None
    saved=artifact(db,page,goal['request_id']) if run else None
    credit=budget.status(db,page,team)
    legacy_review=goal.get('control_mode')=='manual' and goal.get('result_contract',1)==1
    can_review=bool(legacy_review and run and saved and goal['state'] not in ('complete','stopped'))
    ready=bool(can_review and review and review['request_id']==goal['request_id'] and
               review['decision']=='continue' and credit.get('can_continue'))
    next_intent=None
    if goal['pending_id']:
        pending=db.execute("SELECT response FROM managed_goal_receipts WHERE id=? AND page_id=? AND action='goal-next'",
                           (goal['pending_id'],page['page_id'])).fetchone()
        if pending:next_intent=json.loads(pending[0])
    result={'configured':True,'objective':goal['objective'],'state':goal['state'],
            'mode':goal.get('control_mode','automatic'),'result_contract':goal.get('result_contract',1),'etag':etag(db,page,goal),
            'request_id':goal['request_id'],'revision':goal.get('revision',0),'review':review,
            'can_review':can_review,'can_start_next':ready,'next':next_intent,
            'next_recovery':pending_recovery(db,page,goal) if goal['pending_id'] else None,
            'owner_identity_valid':bool(owner_same),'request_matches':request_same,
            'identity_valid':same,'cycles':goal['cycles'],'pending_id':goal['pending_id'],
            'reason':goal.get('reason',''),
            'result_status':goal.get('result_status'),'wait_context':json.loads(goal['wait_context']) if goal.get('wait_context') else None,
            'display_state':{'active':'running','complete':'delivered','ready_for_review':'delivered','needs_attention':'needs_attention'}.get(goal['state'],goal['state'])}
    if summary:
        result.pop('objective');result.pop('review');result.pop('next')
    return result


def pending_recovery(db,page,goal):
    """Only durable absence of an accepted send or definitive rejection is safe.

    A later concurrent send cannot slip through: discarding revokes its immutable
    grant inside the same ledger transaction, and Host.send checks it again.
    """
    key=goal['pending_id']
    accepted=db.execute('SELECT 1 FROM host_requests WHERE id=?',(key,)).fetchone()
    attempts=db.execute('SELECT 1 FROM control_attempts WHERE request_id=?',(key,)).fetchone()
    op=db.execute('SELECT * FROM operations WHERE id=?',(key,)).fetchone()
    if accepted or attempts:return {'can_discard':False,'send_state':'accepted','reason':'reconcile_original_request'}
    if not op:return {'can_discard':True,'send_state':'not_sent','reason':'prepared_only'}
    response=json.loads(op['response']) if op['response'] else {}
    rejected=(op['action']=='message.send' and op['thread_id']==page['thread_id'] and
              op['state']=='rejected' and response.get('state')=='rejected' and response.get('unknown') is False)
    return {'can_discard':bool(rejected),'send_state':op['state'],
            'reason':'original_send_rejected' if rejected else 'reconcile_original_operation'}


def replay(managed,db,action,p):
    managed.host.identifier(p['operation_id'])
    require(not db.execute('SELECT 1 FROM managed_goal_revocations WHERE id=?',(p['operation_id'],)).fetchone(),
            'managed_goal_prepared_intent_discarded',409)
    old=db.execute('SELECT * FROM managed_goal_receipts WHERE id=?',(p['operation_id'],)).fetchone()
    if old:
        require(old['fingerprint']==hash_value(p) and old['action']==action,'managed_goal_operation_conflict',409)
        return {**json.loads(old['response']),'replayed':True}


def record(managed,db,action,p,result,grant_basis=None):
    db.execute('INSERT INTO managed_goal_receipts(id,fingerprint,action,page_id,response,basis,created) VALUES(?,?,?,?,?,?,?)',
               (p['operation_id'],hash_value(p),action,p['page_id'],canonical(result),
                canonical(grant_basis) if grant_basis else None,stamp()))
    managed.host.emit(db,db.execute('SELECT thread_id FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()[0],
                      'managed_'+action.replace('-','_'),{'operation_id':p['operation_id'],'model_sends':0,
                                                        'goal_revision':result.get('goal',{}).get('revision')})
    return result


def discard(managed,db,p):
    object_fields(p,{'page_id','operation_id','expected_etag','expected_goal_request_id','expected_pending_id'})
    old=replay(managed,db,'goal-discard',p)
    if old:return old
    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
    require(page and page['phase']=='bound' and not page['parent_target'],'managed_goal_controller_required',409)
    goal=goal_row(db,page);req=current_request(db,page)
    require(goal and req and goal['request_id']==req['id']==p['expected_goal_request_id'],
            'managed_goal_request_changed',409)
    require(identity(db,page)==goal['identity'],'managed_goal_identity_changed',409)
    require(goal['store_id']==db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()[0],'managed_goal_store_changed',409)
    managed.host.identifier(p['expected_pending_id'])
    require(p['operation_id']!=p['expected_pending_id'],'managed_goal_operation_conflict',409)
    require(not goal['pending_id'] or goal['pending_id']==p['expected_pending_id'],'managed_goal_pending_changed',409)
    require(p['expected_etag']==etag(db,page,goal),'managed_goal_changed',409)
    original=p['expected_pending_id']
    recovery=pending_recovery(db,page,{**dict(goal),'pending_id':original})
    require(recovery['can_discard'],'managed_goal_original_send_unresolved',409)
    grant=db.execute("SELECT * FROM managed_goal_receipts WHERE id=? AND page_id=? AND action='goal-next'",
                     (original,page['page_id'])).fetchone()
    if grant:
        require(not grant['accepted_request_id'] and not grant['discontinued'] and goal['pending_id']==original,
                'managed_goal_pending_changed',409)
        db.execute('UPDATE managed_goal_receipts SET discontinued=? WHERE id=?',(stamp(),original))
    else:
        require(not goal['pending_id'] and not db.execute('SELECT 1 FROM managed_goal_receipts WHERE id=?',(original,)).fetchone(),
                'managed_goal_pending_changed',409)
    require(not db.execute('SELECT 1 FROM managed_goal_revocations WHERE id=?',(original,)).fetchone(),
            'managed_goal_pending_changed',409)
    db.execute('INSERT INTO managed_goal_revocations VALUES(?,?,?)',(original,page['page_id'],stamp()))
    db.execute("UPDATE managed_goals SET pending_id=NULL,revision=revision+1,reason='human_prepared_next_discarded',updated=? WHERE page_id=?",
               (time.time(),page['page_id']))
    result={'state':'goal_next_discarded','original_operation_id':original,'goal':view(db,page,managed.host.team),
            'model_sends':0,'budget_unchanged':True,'original_error_preserved':True,'replayed':False}
    return record(managed,db,'goal-discard',p,result)


def checked(managed,db,p,require_goal=False,allow_stopped_request=False):
    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
    require(page and page['phase']=='bound' and not page['parent_target'],'managed_goal_controller_required',409)
    require(not db.execute("SELECT 1 FROM managed_handoffs WHERE source_page=? AND state IN ('prepared','enrolling','active')",(page['page_id'],)).fetchone(),
            'managed_resume_successor_instead',409)
    goal=goal_row(db,page);req=current_request(db,page)
    stopped=bool(allow_stopped_request and goal and goal['state']=='stopped')
    expected_request=goal['request_id'] if stopped else req['id'] if req else None
    require(req and expected_request==p['expected_goal_request_id'],'managed_goal_request_changed',409)
    require(not require_goal or goal,'managed_goal_not_set',409)
    require(not goal or (goal['thread_id']==page['thread_id'] and identity(db,page)==goal['identity']),
            'managed_goal_identity_changed',409)
    require(not goal or goal['store_id']==db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()[0],'managed_goal_store_changed',409)
    require(not goal or stopped or goal['request_id']==req['id'],'managed_goal_request_changed',409)
    require(not goal or not goal['pending_id'],'managed_goal_pending_original_send',409)
    require(p['expected_etag']==etag(db,page,goal),'managed_goal_changed',409)
    return page,goal,req


def save(managed,db,p):
    object_fields(p,{'page_id','operation_id','expected_etag','expected_goal_request_id','objective'},{'mode','auto_continue'})
    old=replay(managed,db,'goal-save',p)
    if old:return old
    require(isinstance(p['objective'],str) and 0<len(p['objective'].strip())<=18000 and '\0' not in p['objective'],'managed_goal_invalid')
    page,goal,req=checked(managed,db,p,allow_stopped_request=True)
    mode=p.get('mode','automatic' if p.get('auto_continue') is True else 'manual')
    require(mode in ('manual','automatic') and ('auto_continue' not in p or type(p['auto_continue']) is bool),'managed_goal_mode_invalid')
    state='active' if mode=='automatic' else 'paused'
    contract=2 if 'mode' in p or 'auto_continue' in p else (goal['result_contract'] if goal else 1)
    if goal:
        db.execute("UPDATE managed_goals SET objective=?,control_mode=?,state=?,result_contract=?,request_id=?,revision=revision+1,review=NULL,result_status=NULL,wait_context=NULL,reason='human_goal_saved',updated=? WHERE page_id=?",
                   (p['objective'].strip(),mode,state,contract,req['id'],time.time(),p['page_id']))
    else:
        store=db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()[0]
        db.execute("INSERT INTO managed_goals(page_id,thread_id,store_id,identity,objective,state,request_id,reason,updated,control_mode,revision,result_contract) VALUES(?,?,?,?,?,?,?,'human_goal_saved',?,?,1,?)",
                   (p['page_id'],page['thread_id'],store,identity(db,page),p['objective'].strip(),state,req['id'],time.time(),mode,contract))
    result={'state':'goal_saved','goal':view(db,page,managed.host.team),'model_sends':0,'replayed':False,
            'current_execution_unchanged':True,'budget_unchanged':True}
    return record(managed,db,'goal-save',p,result)


def stop(managed,db,p):
    """End this Goal's future continuation without cancelling original work.

    Pending sends remain identified and queryable. An accepted or unknown send,
    a still-running public turn, and independently running Jobs are not reasons
    to withhold this local decision to stop pursuing the Goal.
    """
    object_fields(p,{'page_id','operation_id','expected_etag','expected_goal_request_id'})
    old=replay(managed,db,'goal-stop',p)
    if old:return old
    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
    require(page and page['phase']=='bound' and not page['parent_target'],'managed_goal_controller_required',409)
    require(not db.execute("SELECT 1 FROM managed_handoffs WHERE source_page=? AND state IN ('prepared','enrolling','active')",(page['page_id'],)).fetchone(),
            'managed_resume_successor_instead',409)
    goal=goal_row(db,page)
    require(goal,'managed_goal_not_set',409)
    require(goal['request_id']==p['expected_goal_request_id'],'managed_goal_request_changed',409)
    require(goal['thread_id']==page['thread_id'] and identity(db,page)==goal['identity'],
            'managed_goal_identity_changed',409)
    require(goal['store_id']==db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()[0],'managed_goal_store_changed',409)
    require(p['expected_etag']==etag(db,page,goal),'managed_goal_changed',409)
    if goal['state']!='stopped':
        db.execute("UPDATE managed_goals SET state='stopped',reason='human_goal_stopped',revision=revision+1,updated=? WHERE page_id=? AND revision=? AND request_id=?",
                   (time.time(),p['page_id'],goal['revision'],goal['request_id']))
        require(db.execute('SELECT changes()').fetchone()[0]==1,'managed_goal_changed',409)
    # Use the same local future-send pause as the existing Pause action. This
    # also holds any previously composed Goal+note batch without editing it.
    db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?',(p['page_id'],))
    db.execute("INSERT OR REPLACE INTO managed_pause_owners VALUES(?,'operator',NULL)",(p['page_id'],))
    result={'state':'goal_stopped','goal':view(db,page,managed.host.team),'model_sends':0,
            'current_execution_unchanged':True,'budget_unchanged':True,'future_paused':True,
            'page_was_paused':bool(page['paused']),
            'original_request_preserved':True,'pending_send_preserved':bool(goal['pending_id']),
            'replayed':False}
    return record(managed,db,'goal-stop',p,result)


def review(managed,db,p):
    object_fields(p,{'page_id','operation_id','expected_etag','expected_goal_request_id','decision','note'})
    old=replay(managed,db,'goal-review',p)
    if old:return old
    require(p['decision'] in ('continue','complete','revise'),'managed_goal_review_decision_invalid')
    require(isinstance(p['note'],str) and len(p['note'])<=6000 and '\0' not in p['note'],'managed_goal_review_note_invalid')
    page,goal,req=checked(managed,db,p,True)
    require(settled(db,page,req['id']),'managed_goal_result_not_settled',409)
    saved=artifact(db,page,req['id'],managed)
    require(saved,'managed_goal_original_result_unavailable',409)
    verdict={'request_id':req['id'],'decision':p['decision'],'note':p['note'].strip(),
             'at':stamp(),'actor':'human','artifact':saved,'execution_acceptance':'user_review',
             'external_jobs_verified':False}
    db.execute("UPDATE managed_goals SET control_mode='manual',state=?,revision=revision+1,review=?,reason='human_review_recorded',updated=? WHERE page_id=?",
               ('complete' if p['decision']=='complete' else 'paused',canonical(verdict),time.time(),page['page_id']))
    result={'state':'goal_review_saved','goal':view(db,page,managed.host.team),'model_sends':0,
            'budget_unchanged':True,'stops_and_errors_preserved':True,'replayed':False}
    return record(managed,db,'goal-review',p,result)


def prepare_next(managed,db,p):
    object_fields(p,{'page_id','operation_id','expected_etag','expected_goal_request_id','expected_run_id','instructions'})
    old=replay(managed,db,'goal-next',p)
    if old:return old
    require(isinstance(p['instructions'],str) and len(p['instructions'])<=11000 and '\0' not in p['instructions'],'managed_goal_instructions_invalid')
    page,goal,req=checked(managed,db,p,True)
    review=json.loads(goal['review']) if goal['review'] else None
    require(goal['control_mode']=='manual' and goal['state'] not in ('complete','stopped') and review and
            review['request_id']==req['id'] and review['decision']=='continue','managed_goal_human_review_required',409)
    run=settled(db,page,req['id']);require(run and run['id']==p['expected_run_id'],'managed_goal_result_not_settled',409)
    saved=artifact(db,page,req['id'],managed)
    require(saved and saved==review['artifact'],'managed_goal_original_result_unavailable',409)
    budget.continuation(managed,db,p['page_id'],p['expected_run_id'])
    objective=(goal['objective']+'\n\n用户已验收上一工作包并明确发起下一包。验收反馈：\n'+review['note']+
               '\n原结果：'+saved['path']+'\nSHA256：'+saved['sha256']+
               '\n保持原账号、模型、Session与工作范围，复用已完成成果，沿未完成工作继续。'+
               ('\n本包补充：\n'+p['instructions'].strip() if p['instructions'].strip() else '')+
               '\n'+WORK_PACKAGE_GUIDANCE)
    require(len(objective)<=24000,'managed_goal_next_text_too_long',409)
    result={'state':'goal_next_prepared','operation_id':p['operation_id'],'objective':objective,
            'source_request_id':req['id'],'expected_run_id':run['id'],'model_sends':0,'replayed':False}
    record(managed,db,'goal-next',p,result,basis(goal))
    db.execute("UPDATE managed_goals SET pending_id=?,reason='human_next_prepared',updated=? WHERE page_id=?",
               (p['operation_id'],time.time(),p['page_id']))
    return result


def validate_send(host,db,thread,text,request_id):
    require(not db.execute('SELECT 1 FROM managed_goal_revocations WHERE id=?',(request_id,)).fetchone(),
            'managed_goal_prepared_intent_discarded',409)
    page=db.execute('SELECT * FROM managed_pages WHERE thread_id=?',(thread,)).fetchone()
    goal=goal_row(db,page) if page else None
    grant=db.execute("SELECT * FROM managed_goal_receipts WHERE id=? AND action='goal-next'",(request_id,)).fetchone()
    if goal and goal['state']=='stopped':
        # Ordinary explicitly sent messages remain ordinary conversations. A
        # delayed automatic/prepared Goal send cannot resurrect a stopped Goal.
        require(not grant and goal['pending_id']!=request_id,'managed_goal_stopped',409)
        require(not goal['pending_id'],'managed_goal_pending_original_send',409)
        return None
    if not grant:
        require(not goal or goal['control_mode']!='manual' or goal['result_contract']==2,'managed_goal_human_review_required',409)
        if goal:
            require(not goal['pending_id'] or goal['pending_id']==request_id,'managed_goal_pending_original_send',409)
            require(identity(db,page)==goal['identity'],'managed_goal_identity_changed',409)
            # The previous automatic watcher adopts its already accepted send
            # via the original receipt. Preserve that legacy contract until a
            # user explicitly saves the personal-edition Goal mode.
            if goal['result_contract']==1:return None
            return page['page_id']
        return None
    require(not grant['discontinued'],'managed_goal_prepared_intent_discarded',409)
    require(page and goal and grant['page_id']==page['page_id'],'managed_goal_identity_changed',409)
    require(goal['store_id']==db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()[0],'managed_goal_store_changed',409)
    expected=json.loads(grant['response'])
    require(text==expected['objective'],'managed_goal_prepared_text_changed',409)
    require(goal['pending_id']==request_id and canonical(basis(goal))==grant['basis'] and
            identity(db,page)==goal['identity'],'managed_goal_changed',409)
    run=settled(db,page,expected['source_request_id'],request_id)
    require(run and run['id']==expected['expected_run_id'],'managed_goal_result_not_settled',409)
    saved=artifact(db,page,expected['source_request_id'],host.managed)
    require(saved and saved==json.loads(goal['review'])['artifact'],'managed_goal_original_result_unavailable',409)
    budget.continuation(host.managed,db,page['page_id'],run['id'])
    # The operation was already reserved by Service.command. That own request is
    # the only exception; no other accepted/unknown send may be bypassed.
    return page['page_id']


def bind_accepted(host,db,page_id,request_id):
    if not page_id:return
    goal=db.execute('SELECT state FROM managed_goals WHERE page_id=?',(page_id,)).fetchone()
    if goal and goal['state']=='stopped':
        # Preserve the original stopped Goal even if a cached continuation's
        # acceptance is reported late. The accepted original operation remains
        # queryable; this is not a cancellation or a fabricated rejection.
        db.execute('UPDATE managed_goal_receipts SET accepted_request_id=? WHERE id=?',(request_id,request_id))
        return
    db.execute("UPDATE managed_goals SET request_id=?,pending_id=NULL,cycles=cycles+1,state=CASE WHEN control_mode='manual' OR state='paused' THEN 'paused' ELSE 'active' END,revision=revision+1,review=NULL,result_status=NULL,wait_context=NULL,reason='next_round_accepted',updated=? WHERE page_id=? AND (pending_id IS NULL OR pending_id=?)",
               (request_id,time.time(),page_id,request_id))
    require(db.execute('SELECT changes()').fetchone()[0]==1,'managed_goal_changed',409)
    db.execute('UPDATE managed_goal_receipts SET accepted_request_id=? WHERE id=?',(request_id,request_id))
