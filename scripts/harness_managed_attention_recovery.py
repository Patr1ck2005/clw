"""Program-side recovery of saved, ended turns; never replay project operations.

Status IO is outside the shared SQLite transaction. The existing operator
reconciliation rechecks the original request, result, Jobs, stop and budget.
One durable operation per original turn survives a lost return or restart.
"""
from harness_run_limits import deadline_live,sends_available
from contextlib import closing
import hashlib
import json
import uuid

from harness_recovery import DELAYS
from harness_state import HarnessError, canonical
from harness_user_authorization import ended_turn_recovery_authorized
from native_work_admission import AdmissionError, local_runtime_read
from harness_job_inventory import ACTIVE, UNCERTAIN, JobInventoryError, read_session_inventory, inventory_in_progress
from product_runtime import atomic_json


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS managed_ended_recoveries(
      attempt_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,page_id TEXT NOT NULL,
      operation_id TEXT UNIQUE NOT NULL,state TEXT NOT NULL,tries INTEGER NOT NULL,
      due REAL NOT NULL,updated REAL NOT NULL,reason TEXT NOT NULL)''')


def public_state(db, request_id):
    if not request_id:
        return None
    row=db.execute('SELECT attempt_id,state,tries,due,reason FROM managed_ended_recoveries WHERE request_id=? ORDER BY updated DESC LIMIT 1',
                   (request_id,)).fetchone()
    return {**dict(row),'limit':len(DELAYS)} if row else None


def _mode(managed, db, attention, run):
    # A worker's saved public result can be returned to its controller without
    # another model turn. Real needs_attention work keeps the continuation path.
    if attention['request_id']==run['controller_request']:
        return 'continue'
    missing=db.execute("SELECT data FROM events WHERE thread_id=? AND kind='host_turn_attention' AND json_extract(data,'$.attempt_id')=? ORDER BY seq DESC LIMIT 1",
                       (attention['thread_id'],attention['attempt_id'])).fetchone()
    if (db.execute('SELECT 1 FROM managed_turn_outcomes WHERE attempt_id=?',(attention['attempt_id'],)).fetchone()
            or not missing or json.loads(missing['data']).get('missing_tool_outcome') is not True):
        return 'continue'
    if (not db.execute("SELECT 1 FROM managed_artifacts WHERE id=? AND request_id=? AND source='public_dom_markdown'",
                       (attention['attempt_id'],attention['request_id'])).fetchone()
            or managed.host.collaboration.outstanding(db,attention['request_id'])
            or db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',(attention['request_id'],)).fetchone()):
        return 'continue'
    return 'settle'


def _candidate(managed, db, p):
    h=managed.host
    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
    if not page or page['phase']!='bound' or not page['paused']:
        return None
    a=db.execute('''SELECT m.*,r.thread_id,r.phase,r.cancel_requested FROM managed_attention m
      JOIN host_requests r ON r.id=m.request_id WHERE r.thread_id=?
      AND r.phase IN ('processing','suspended') ORDER BY r.created_at DESC LIMIT 1''',
      (page['thread_id'],)).fetchone()
    if not a or a['cancel_requested'] or a['attempt_id']!=p.get('attempt_id'):
        return None
    latest=db.execute('SELECT id FROM host_requests WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
                      (page['thread_id'],)).fetchone()
    owner=db.execute('SELECT * FROM managed_pause_owners WHERE page_id=?',(page['page_id'],)).fetchone()
    if (not latest or latest['id']!=a['request_id'] or not owner or owner['source']!='attention'
            or owner['attempt_id']!=a['attempt_id'] or managed.pause_origin(db,page,include_self=False)
            or db.execute('SELECT 1 FROM managed_stops WHERE page_id=? AND resumed=0',(page['page_id'],)).fetchone()
            or db.execute('SELECT 1 FROM managed_page_issues WHERE page_id=?',(page['page_id'],)).fetchone()
            or db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','unknown')",
                          (page['thread_id'],)).fetchone()):
        return None
    run=h.team.run_for_request(db,a['request_id'])
    if not run or h.team.maintenance.held(db,run['id']):
        return None
    mode=_mode(managed,db,a,run)
    if mode=='settle':
        if (run['state'] not in ('running','draining') and
                not (run['state']=='closed' and run['reason']=='controller_summary')):
            return None
    elif (run['state']!='running' or not deadline_live(run,h.clock())
            or not sends_available(run,1,1)):
        return None
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_goals'").fetchone():
        goal=db.execute('SELECT state,pending_id FROM managed_goals WHERE page_id=?',(page['page_id'],)).fetchone()
        if goal and (goal['pending_id'] or goal['state'] in ('paused','completed')):
            return None
    br=db.execute('SELECT * FROM control_browser_receipts WHERE attempt_id=?',(a['attempt_id'],)).fetchone()
    o=p.get('browser',{})
    if (not br or not br['result_hash'] or br['completed'] is None
            or o.get('page_id')!=page['page_id'] or o.get('url')!=page['url']
            or not 0<=h.clock()-o.get('at',0)/1000<=30
            or o.get('user_hash')!=br['sent_user_hash'] or o.get('attempt_id')!=a['attempt_id']
            or o.get('marker_count')!=1 or o.get('complete') is not True
            or o.get('generating') is not False or o.get('history_at_latest') is not True
            or any(o.get(k,True) for k in ('loginRequired','approvalRequired','draft','composing'))):
        return None
    return {'page':dict(page),'request_id':a['request_id'],'attempt_id':a['attempt_id'],
            'run':dict(run),'mode':mode,'session_id':h.binding(db,thread=page['thread_id'])['spec']['session_id']}


def _committed(db, row):
    receipt=db.execute("SELECT response FROM host_team_receipts WHERE operation_id=? AND operation='reconcile-attention'",
                       (row['operation_id'],)).fetchone()
    if not receipt:
        return None
    value=json.loads(receipt['response'])
    return value if value.get('request_id')==row['request_id'] and value.get('attempt_id')==row['attempt_id'] else None


def _proof(result):
    if not isinstance(result,dict) or result.get('isError'):
        raise HarnessError('attention_original_jobs_not_idle',409)
    data=result.get('structuredContent',{})
    if not isinstance(data,dict):
        raise HarnessError('attention_original_jobs_not_idle',409)
    output=data.get('output',{})
    if not isinstance(output,dict):
        raise HarnessError('attention_original_jobs_not_idle',409)
    jobs=output.get('jobs')
    if not isinstance(jobs,list) or len(jobs)>(len(ACTIVE)+len(UNCERTAIN))*100 or any(not isinstance(j,dict) for j in jobs):
        raise HarnessError('attention_original_jobs_not_idle',409)
    return {'structuredContent':{'success':data.get('success'),'error':None if data.get('error') is None else 'reported_error',
        'output':{k:output[k] for k in ('count','matched_count','truncated','scope','session_id','history_sample','active_queries','uncertain_queries') if k in output}|{'jobs':[
            {k:j.get(k) for k in ('id','job_id','session_id','status','command_execution_state','started_at')} for j in jobs]}}}


def _jobs_in_progress(result, session):
    return inventory_in_progress(result, session)


def recover(managed, p, *, job_probe=None):
    h=managed.host
    if not ended_turn_recovery_authorized():
        return {'state':'recovery_not_authorized','model_sends':0}
    with h.lock,closing(managed.state.connect()) as db:
        db.execute('BEGIN IMMEDIATE')
        row=db.execute('SELECT * FROM managed_ended_recoveries WHERE attempt_id=? AND page_id=?',
                       (p.get('attempt_id'),p.get('page_id'))).fetchone()
        if row and (prior:=_committed(db,row)):
            db.execute("UPDATE managed_ended_recoveries SET state='recovered',reason='original_receipt_recovered',updated=? WHERE attempt_id=?",
                       (h.clock(),row['attempt_id']));db.commit()
            return {'state':'recovered','original_result':prior,'model_sends':0}
        c=_candidate(managed,db,p)
        if not c:
            db.commit();return {'state':'recovery_not_eligible','model_sends':0}
        count=db.execute("SELECT COUNT(*) FROM managed_ended_recoveries WHERE request_id=? AND state='recovered'",(c['request_id'],)).fetchone()[0]
        if not row:
            state='exhausted' if count>=len(DELAYS) else 'backoff'
            operation=str(uuid.uuid5(uuid.NAMESPACE_URL,'clw-ended-turn:'+managed.state.id+':'+c['attempt_id']))
            db.execute('INSERT INTO managed_ended_recoveries VALUES(?,?,?,?,?,?,?,?,?)',
                       (c['attempt_id'],c['request_id'],p['page_id'],operation,state,0,h.clock()+DELAYS[0],h.clock(),'verify_original_execution'))
            db.commit();return {'state':state,'model_sends':0}
        if row['state']=='exhausted' or row['tries']>=len(DELAYS):
            db.commit();return {'state':'exhausted','model_sends':0}
        if h.clock()<row['due'] or (row['state']=='probing' and h.clock()-row['updated']<30):
            db.commit();return {'state':'backoff','model_sends':0}
        db.execute("UPDATE managed_ended_recoveries SET state='probing',tries=tries+1,updated=? WHERE attempt_id=?",
                   (h.clock(),c['attempt_id']));db.commit()
        operation=row['operation_id'];tries=row['tries']+1
    try:
        # No shared DB lock is held across this bounded local HTTP read.
        result=(job_probe(c['session_id']) if job_probe else
                read_session_inventory(h.root,c['session_id'],local_runtime_read))
        safe_result=_proof(result)
        if _jobs_in_progress(safe_result,c['session_id']):
            with h.lock,closing(managed.state.connect()) as db:
                db.execute("UPDATE managed_ended_recoveries SET state='waiting_jobs',tries=tries-1,due=?,updated=?,reason='original_jobs_in_progress' WHERE attempt_id=?",
                           (h.clock()+DELAYS[1],h.clock(),c['attempt_id']));db.commit()
            return {'state':'waiting_jobs','model_sends':0}
        proof={'source':'CLW-MCP-Union.list_jobs','account':json.loads(c['page']['settings']).get('account','B'),
               'session_id':c['session_id'],'observed_at':h.clock(),'browser':p['browser'],'result':safe_result}
        dest=h.root/'evidence'/'ended-turn-recovery'/('original-'+c['attempt_id']+'.json')
        dest.parent.mkdir(parents=True,exist_ok=True);atomic_json(dest,proof)
        args={'run_id':c['run']['id'],'request_id':c['request_id'],'attempt_id':c['attempt_id'],
              'evidence_path':str(dest),'evidence_sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),
              'confirm':True,'mode':c['mode'],'reason':
              '程序已核对协作者原网页结束和原 Session Job 终态，按 blocked 回收已保存原结果给主控；'
              '保留缺失工具回执、原成果和原错误，不声明成功或已读，不新增模型发送。'
              if c['mode']=='settle' else
              '程序已核对原网页结束和原 Session Job 终态，保留原成果与错误，继续原完整目标。'
              '先读取原执行事实与剩余工作；已受理或未知命令不重放。按用户恢复授权合法修正调用或使用合适的已授权入口，'
              '真实权限、明确政策限制和用户停止仍须遵守。将研究、实施、验证、修复与交接合并在实质工作包中推进。'}
        value=h.team.public_command(c['run']['controller_thread'],operation,'reconcile-attention',args)
        with h.lock,closing(managed.state.connect()) as db:
            db.execute("UPDATE managed_ended_recoveries SET state='recovered',reason='original_execution_reconciled',updated=? WHERE attempt_id=?",
                       (h.clock(),c['attempt_id']));db.commit()
        return {'state':'recovered','original_result':value,'model_sends':0}
    except (HarnessError,AdmissionError,OSError,ValueError,KeyError,TypeError) as error:
        # Check the original durable receipt before considering another probe.
        with h.lock,closing(managed.state.connect()) as db:
            row=db.execute('SELECT * FROM managed_ended_recoveries WHERE attempt_id=?',(c['attempt_id'],)).fetchone()
            if prior:=_committed(db,row):
                state,reason='recovered','original_receipt_recovered'
            else:
                state='exhausted' if tries>=len(DELAYS) else 'backoff'
                reason=(error.code if isinstance(error,HarnessError) else
                        'attention_original_jobs_not_idle' if isinstance(error,JobInventoryError) else
                        str(error) if isinstance(error,AdmissionError) and len(str(error))<=160 and
                        all(c.islower() or c=='_' for c in str(error)) else
                        'original_execution_probe_unavailable')
            db.execute('UPDATE managed_ended_recoveries SET state=?,reason=?,due=?,updated=? WHERE attempt_id=?',
                       (state,reason,h.clock()+DELAYS[min(tries,len(DELAYS)-1)],h.clock(),c['attempt_id']));db.commit()
        return {'state':state,'reason':reason,'model_sends':0}
