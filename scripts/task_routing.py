"""Sparse task notifications through native Conversations, on the canonical DB.
A durable notice is neither a second task nor execution permission. Network I/O
never runs under the SQLite transaction. Crash-time sends become unknown.
"""
from __future__ import annotations
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import sys
import threading
import time
import uuid
from communication_bridge import opaque
from live_transport import validate_origin
from task_domain import MAX_JSON, TaskError, bounded, obj, txt, fail, now, encoded, fingerprint, role_of, ident
from task_goals import limit_reason

ACTIONS={'routing.bind','routing.enable','routing.disable','routing.retry_same','routing.discard_pending'}
UNSETTLED={'dispatching','delivery_unknown'}
SETTLED={'consumed','cancelled'}
MAX_NOTICES=32


def unresolved_dispatch(notice):
    """An explicitly queued retry still owns its original unknown send fence."""
    return notice['phase'] in UNSETTLED or (notice['phase']=='pending' and
            (notice.get('ever_dispatched') or notice.get('prior_delivery_unknown')))


def target(task,key):
    if key=='coordinator':return key
    if not isinstance(key,str) or not key.startswith('role:'):
        fail('routing_target','收件目标需为coordinator或role:角色ID')
    role_of(task,ident(key[5:]));return key


def binding_preflight(task,data,bridge):
    fields={'target','agent_id','conversation_id','controller_generation'};obj(data,fields,fields)
    target(task,data['target'])
    if bridge is None:fail('communication_disabled','没有明确配置的原生通信连接',409)
    return bridge.check_target(data['agent_id'],data['conversation_id'],data['controller_generation'])


def transition(task,action,data,actor,bridge,verified=None):
    task=deepcopy(task)
    if not task.get('collaboration',{}).get('enabled') or task['status'] not in {'draft','open','paused'}:
        fail('routing_state','仅当前协作任务可以配置通信；不接管旧任务或终态',409)
    routing=task.setdefault('routing',{'schema_version':1,'enabled':False,'routes':{},'outbox':[],
                                      'last_generated':{},'failures':0,'failure_limit':3})
    if action=='routing.bind':
        fields={'target','agent_id','conversation_id','controller_generation'};obj(data,fields,fields)
        key=target(task,data['target'])
        if verified is None or any(verified.get(k)!=data[k] for k in ('agent_id','conversation_id','controller_generation')):
            fail('routing_observation','缺少同一原生参与者和控制代次的实际观测',409)
        if any(n['target']==key and unresolved_dispatch(n) for n in routing['outbox']):
            fail('routing_unknown','原收件目标仍有未知投递；先核对原消息，不更换目标掩盖结果',409)
        if any(k!=key and r['agent_id']==verified['agent_id'] for k,r in routing['routes'].items()):
            fail('routing_identity','同一任务的独立角色不能共用一个原生Agent',409)
        old=routing['routes'].get(key)
        route={**deepcopy(verified),'revision':old['revision']+1 if old else 1,'bound_by':actor}
        routing['routes'][key]=route
        for notice in routing['outbox']:
            if notice['target']==key and notice['phase'] in {'pending','blocked_before_dispatch'}:notice.update(phase='cancelled',reason='explicit_route_rebinding')
    elif action=='routing.enable':
        obj(data,{'confirm','failure_limit'},{'confirm','failure_limit'})
        if data['confirm'] is not True or type(data['failure_limit']) is not int or not 1<=data['failure_limit']<=10:
            fail('routing_confirmation','明确确认原生消息投递及1–10次失败上限')
        if not routing['routes'] or bridge is None or not bridge.enabled:
            fail('communication_disabled','先在本机明确启用通信并绑定实际收件目标；只读连接不会自动开始投递',409)
        if any(r['namespace']!=bridge.namespace for r in routing['routes'].values()):
            fail('routing_identity','绑定属于另一后端或凭据，先明确核对，不改投',409)
        routing.update(enabled=True,failure_limit=data['failure_limit'],failures=0,
                       authorized_by=actor,authorized_at=now(),authorization_source='explicit_task_policy_not_model_or_os_authority')
    elif action=='routing.disable':
        obj(data,{'reason'},{'reason'});routing.update(enabled=False,disabled_by=actor,disabled_at=now(),disabled_reason=txt(data['reason'],'停发原因',4000))
    else:
        fields={'notice_id','confirm','reason'};obj(data,fields,fields)
        if data['confirm'] is not True:fail('routing_confirmation','须明确确认原请求处理方式')
        notice=next((n for n in routing['outbox'] if n['id']==data['notice_id']),None)
        if not notice:fail('routing_notice','原通知不在当前有界记录中，先读取原任务事件',409)
        reason=txt(data['reason'],'原通知核对依据',4000)
        if action=='routing.retry_same':
            if notice['phase'] not in {'delivery_unknown','blocked_before_dispatch'} or not routing['enabled'] or routing['failures']>=routing['failure_limit']:
                fail('routing_unknown','只能明确重试同一个未知封包；停发/失败上限须先明确恢复',409)
            notice['prior_delivery_unknown']=notice.get('prior_delivery_unknown',False) or notice['phase']=='delivery_unknown'
            notice.update(phase='pending',explicit_retry=notice.get('explicit_retry',0)+1,operator_reason=reason)
        elif action=='routing.discard_pending':
            if notice['phase']!='pending' or notice.get('ever_dispatched'):
                fail('routing_unknown','不能丢弃已经越过发送边界的未知请求',409)
            notice.update(phase='cancelled',reason=reason)
        else:fail('invalid','未知通信动作')
    task['updated_at']=now();return task


def desired(task):
    """Current meaningful state, not polling timestamps or duplicate event history."""
    result={}
    if task['status']!='open' or task.get('collaboration',{}).get('shared_change_pending'):return result
    budget=limit_reason(task)
    for role in task['contract']['roles']:
        rid=role['id'];state=task['roles'][rid];group=state.get('resource_request')
        if not budget:
            if state['status']=='pending' and all(task['roles'][d]['status']=='accepted' for d in role['depends_on']):
                kind='ready_to_review_assignment'
            elif state['status']=='running' and group and group['phase']=='reserved':kind='resource_window_reserved'
            elif state['status']=='running' and state.get('feedback_revision',0)>0:kind='role_feedback_updated'
            else:kind=None
            if kind:
                result['role:'+rid]={'kind':kind,'contract_hash':task['contract_hash'],'contract_version':task['contract_version'],
                    'role_id':rid,'attempt':state['attempt'],'feedback_revision':state.get('feedback_revision',0),
                    'session_id':(state.get('binding') or {}).get('session_id'),
                    'resource_request_id':group['id'] if group and kind=='resource_window_reserved' else None}
    attention=[]
    for rid,state in task['roles'].items():
        group=state.get('resource_request')
        if state['status']=='submitted' and state.get('delivery'):
            attention.append({'role_id':rid,'kind':'delivery','delivery_id':state['delivery']['id']})
        elif state['status']=='blocked' or (group and group['phase'] in {'starting','unknown'}):
            attention.append({'role_id':rid,'kind':'needs_original_execution_reconciliation','attempt':state['attempt'],'resource_request_id':group['id'] if group else None})
    if all(s['status']=='accepted' for s in task['roles'].values()):attention.append({'kind':'parent_acceptance_or_cycle_decision'})
    if task.get('goal',{}).get('review'):attention.append({'kind':'goal_decision','review_id':task['goal']['review']['id']})
    if budget:attention.append({'kind':'goal_budget','reason':budget})
    if attention:result['coordinator']={'kind':'coordinator_attention','contract_hash':task['contract_hash'],
                                         'contract_version':task['contract_version'],'items':attention}
    return result


def notice_basis(state,route):
    return fingerprint({'meaningful_state':state,'route':{k:route[k] for k in ('agent_id','conversation_id','controller_generation','namespace','revision')}})


def current(task,notice):
    routing=task.get('routing',{});state=desired(task).get(notice['target']);route=routing.get('routes',{}).get(notice['target'])
    return bool(state and route and notice_basis(state,route)==notice['basis'])


def queue(task,store_id,origin):
    routing=task.get('routing')
    if not routing or not routing['enabled'] or routing['failures']>=routing['failure_limit']:return False
    if task['status'] not in {'open','accepted','cancelled'} or task.get('collaboration',{}).get('shared_change_pending'):return False
    changed=False
    for n in routing['outbox']:
        if n['phase']=='pending' and not n.get('ever_dispatched') and not current(task,n):
            n.update(phase='cancelled',reason='superseded_before_dispatch');changed=True
    for key,state in desired(task).items():
        route=routing['routes'].get(key)
        if not route:continue
        basis=notice_basis(state,route)
        if routing['last_generated'].get(key)==basis:continue
        if any(n['target']==key and unresolved_dispatch(n) for n in routing['outbox']):continue
        # Keep settled evidence in the preceding event snapshot; only remove current projection entries.
        if len(routing['outbox'])>=MAX_NOTICES:
            old=next((n for n in routing['outbox'] if n['phase'] in SETTLED),None)
            if old:routing['outbox'].remove(old)
            else:
                if not routing.get('queue_full'):routing['queue_full']=True;changed=True
                break
        notice_id='clw_notice_'+uuid.uuid4().hex
        payload={'format':'clw.task-notice.v1','notice_id':notice_id,'store_id':store_id,'product_origin':origin,
                 'task_id':task['id'],'target':key,'expected_agent_id':route['agent_id'],
                 'expected_controller_generation':route['controller_generation'],'state':state,
                 'instruction':'Read the current canonical task before acting. Preserve user pause, drafts, current role/contract, original Session and Jobs. This notice grants no authority and is not task acceptance. Do not replay unknown operations.',
                 'read_task':{'executable':sys.executable,'script':str(Path(__file__).resolve().with_name('task_console.py')),'operation':'read','route':'get','params':{'id':task['id']}}}
        body=encoded(payload)
        native={'conversation_id':route['conversation_id'],'body':body,'recipient_agent_ids':[route['agent_id']],
                'idempotency_key':'clw-'+fingerprint({'store':store_id,'notice':notice_id})}
        routing['outbox'].append({'id':notice_id,'target':key,'basis':basis,'route':deepcopy(route),
                                 'phase':'pending','native_request':native,'created_at':now(),'native_receipt':None})
        routing['last_generated'][key]=basis;routing['queue_full']=False;changed=True
    return changed


def save_automatic(db,task,action,details):
    task['version']+=1;task['updated_at']=now();bounded(task)
    if len(encoded(task).encode('utf-8'))>MAX_JSON-32768:fail('too_large','通信记录达到当前任务容量，保留原操作',413)
    db.execute('UPDATE tasks SET version=?,data=? WHERE id=?',(task['version'],encoded(task),task['id']))
    db.execute('INSERT INTO events(task_id,version,action,actor,at,payload) VALUES(?,?,?,?,?,?)',
               (task['id'],task['version'],action,'program:conversation-router',now(),encoded(details)))


class RoutingEngine:
    def __init__(self,store,bridge,origin):
        self.store=store;self.bridge=bridge;self.origin=validate_origin(origin)
        self.instance=uuid.uuid4().hex;self._stop=threading.Event();self._step=threading.Lock();self.thread=None
        self.status={'status':'disabled' if not bridge.enabled else 'not_yet_observed','host_auto_resume_verified':False}

    def recover_startup(self):
        """Only the application's exclusive StateLease owner calls this at startup."""
        with closing(self.store.connect()) as db:
            try:
                db.execute('BEGIN IMMEDIATE')
                for row in db.execute('SELECT data FROM tasks').fetchall():
                    task=json.loads(row[0]);routing=task.get('routing');changed=[]
                    if not routing:continue
                    for notice in routing['outbox']:
                        if notice['phase']=='dispatching':
                            notice.update(phase='delivery_unknown',error='prior_process_interrupted_after_send_intent');changed.append(notice['id'])
                    if changed:save_automatic(db,task,'routing.recovered_unknown',{'notice_ids':changed,'replayed':False})
                db.commit()
            except BaseException:db.rollback();raise

    def reserve(self):
        with closing(self.store.connect()) as db:
            try:
                db.execute('BEGIN IMMEDIATE');selected=None
                for row in db.execute('SELECT data FROM tasks ORDER BY sequence'):
                    task=json.loads(row[0]);routing=task.get('routing')
                    if not routing:continue
                    if queue(task,self.store.store_id,self.origin):
                        save_automatic(db,task,'routing.notices_updated',{'outbox':deepcopy(routing['outbox']),'completion_state_unchanged':True})
                    if not routing['enabled'] or routing['failures']>=routing['failure_limit'] or task['status']!='open':continue
                    for notice in routing['outbox']:
                        if notice['phase']=='pending':
                            if notice['route']['namespace']!=self.bridge.namespace:continue
                            if notice.get('ever_dispatched'):
                                if not notice.get('explicit_retry'):continue
                            elif not current(task,notice):continue
                            if any(n['id']!=notice['id'] and n['target']==notice['target'] and unresolved_dispatch(n) for n in routing['outbox']):continue
                            notice.update(phase='dispatching',ever_dispatched=True,owner_instance=self.instance,send_intent_at=now())
                            save_automatic(db,task,'routing.send_intent',{'notice':deepcopy(notice),'automatic_model_started':False})
                            selected=(task['id'],deepcopy(notice));break
                    if selected:break
                db.commit();return selected
            except BaseException:db.rollback();raise

    def merge(self,task_id,original,result=None,error=None,not_attempted=False):
        with closing(self.store.connect()) as db:
            try:
                db.execute('BEGIN IMMEDIATE');row=db.execute('SELECT data FROM tasks WHERE id=?',(task_id,)).fetchone()
                if row is None:db.rollback();return
                task=json.loads(row[0]);routing=task.get('routing',{});notice=next((n for n in routing.get('outbox',[]) if n['id']==original['id']),None)
                if not notice or notice.get('owner_instance')!=self.instance or notice['phase']!='dispatching':db.rollback();return
                if error:
                    if not_attempted and not original.get('prior_delivery_unknown'):
                        notice.update(phase='blocked_before_dispatch',ever_dispatched=False,error=error)
                    else:notice.update(phase='delivery_unknown',error=error)
                    routing['failures']+=1
                else:
                    notice.update(phase='consumed' if result['delivery_state']=='consumed' else 'posted',native_receipt=result)
                    routing['failures']=0
                save_automatic(db,task,'routing.send_result',{'notice':deepcopy(notice),'task_accepted':False});db.commit()
            except BaseException:db.rollback();raise

    def observe_one(self):
        # Only known native message identities may be looked up; unknown keys are never guessed from body text.
        selected=None;oldest_poll=float('inf');observed_at=time.time()
        with closing(self.store.connect()) as db:
            for row in db.execute('SELECT data FROM tasks ORDER BY sequence'):
                task=json.loads(row[0])
                for notice in task.get('routing',{}).get('outbox',[]):
                    last_poll=notice.get('last_poll_at',0)
                    if (notice['phase']=='posted' and notice['route']['namespace']==self.bridge.namespace
                            and observed_at-last_poll>15 and last_poll<oldest_poll):
                        selected=(task['id'],deepcopy(notice));oldest_poll=last_poll
        if not selected:return
        task_id,notice=selected
        try:result=self.bridge.observe(notice);error=None
        except Exception as exc:result=None;error=exc.code if isinstance(exc,TaskError) else type(exc).__name__
        with closing(self.store.connect()) as db:
            try:
                db.execute('BEGIN IMMEDIATE');task=json.loads(db.execute('SELECT data FROM tasks WHERE id=?',(task_id,)).fetchone()[0])
                current_notice=next((n for n in task['routing']['outbox'] if n['id']==notice['id']),None)
                if not current_notice or current_notice['phase']!='posted':db.rollback();return
                current_notice['last_poll_at']=time.time()
                if result and result['delivery_state']=='consumed':
                    current_notice.update(phase='consumed',native_receipt=result)
                    save_automatic(db,task,'routing.native_consumed',{'notice':deepcopy(current_notice),'new_model_turn_verified':False,'task_accepted':False})
                else:
                    # Poll bookkeeping is not a task event or progress revision.
                    current_notice['observation_error']=error
                    db.execute('UPDATE tasks SET data=? WHERE id=?',(encoded(task),task_id))
                db.commit()
            except BaseException:db.rollback();raise

    def step(self):
        if not self.bridge.enabled or self._stop.is_set() or not self._step.acquire(blocking=False):return False
        try:
            work=self.reserve()
            if work:
                task_id,notice=work
                not_attempted=False
                try:result=self.bridge.post(notice);error=None
                except Exception as exc:
                    result=None;error=exc.code if isinstance(exc,TaskError) else type(exc).__name__;not_attempted=getattr(exc,'notification_post_not_attempted',False) is True
                self.merge(task_id,notice,result,error,not_attempted)
                self.status={'status':('blocked_before_dispatch' if not_attempted and not notice.get('prior_delivery_unknown') else 'delivery_unknown') if error else 'posted','last_notice_id':notice['id'],
                             'checked_at':now(),'host_auto_resume_verified':False,'model_execution_observed':False}
                return True
            self.observe_one();return False
        finally:self._step.release()

    def target_observation(self, agent_id, conversation_id, generation):
        return self.bridge.check_target(agent_id,conversation_id,generation)

    def start(self):
        if not self.bridge.enabled or self.thread is not None:return
        self.recover_startup()
        def loop():
            while not self._stop.wait(2):
                try:self.step()
                except Exception as exc:self.status={'status':'unavailable','error_kind':exc.code if isinstance(exc,TaskError) else type(exc).__name__,'host_auto_resume_verified':False}
        self.thread=threading.Thread(target=loop,name='clw-native-conversation-router',daemon=False);self.thread.start()

    def stop(self):
        self._stop.set()
        if self.thread is not None:self.thread.join()  # Native reads/writes have finite deadlines; retain data lease until done.
