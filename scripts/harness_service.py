"""Conversation-first application service over native providers.
No model loop: Codex owns inference/tools/history; WebCodex owns native-Web work.
"""
from __future__ import annotations
from pathlib import Path
from contextlib import closing
from task_worker import file_bytes, WorkerError
import json, re, shutil, subprocess, threading, time, uuid
from harness_state import HarnessError, HarnessState, require, public
from harness_rpc import CodexConnection, RpcFailure
from communication_bridge import CommunicationBridge
from task_domain import TaskError
from harness_web import NativeWeb,BUSY
from harness_host import HostBridge,PROVIDER as HOST_PROVIDER,BUSY as HOST_BUSY
BUSY=BUSY|HOST_BUSY

TEAM_PANEL_ACTIONS={'team.invite','team.revoke','team.recover-enroll','team.pause','team.resume','team.quiesce','team.resume-maintenance','team.verify-maintenance-idle','team.reconcile-attention'}
ACTIONS={'provider.connect','thread.create','thread.fork','thread.sync','message.send','message.steer','turn.stop','approval.respond','web.probe','web.attach','host.pause','host.resume','message.append','recovery.pair','recovery.disable','control.pair','control.disable','control.adopt'}
APPROVAL_METHODS={'item/commandExecution/requestApproval','item/fileChange/requestApproval'}

class HarnessService:
    def __init__(self,root:Path,state_dir:Path,transport=None,connection_factory=CodexConnection,web_targets=None,web_bridge=None):
        self.root=Path(root).resolve();self.state=HarnessState(Path(state_dir)/'harness.sqlite3')
        self.transport=transport;self.connection_factory=connection_factory;self.connection=None
        self.instance=uuid.uuid4().hex;self.intent=uuid.uuid4().hex;self.lock=threading.RLock()
        self.account={};self.config={};self.approvals={};self.attached=set();self.sends={};self.notice='';self.closed=False
        self.turn_condition=threading.Condition(threading.RLock());self.control_start_wait_secs=5.0
        self.web=NativeWeb(self.state,self.root,transport,targets=web_targets,bridge=web_bridge)
        self.host_bridge=HostBridge(self.state,self.root,self.web.targets,self.lock)
        self.web_poll_stop=threading.Event();self.web_poll_thread=None
    def start_web_observer(self):
        self.host_bridge.team.start()
        if self.web_poll_thread:return
        def observe():
            while not self.web_poll_stop.wait(2):
                if self.web.denied:continue
                for key in self.web.pending()[:16]:
                    if self.web_poll_stop.is_set():return
                    try:
                        with self.host_bridge.business_admission():self.web.sync(key)
                    except (TaskError,HarnessError,OSError,ValueError):pass  # Preserve cursor; no resend.
        self.web_poll_thread=threading.Thread(target=observe,name='clw-web-public-replies',daemon=True);self.web_poll_thread.start()
    def _turn_observation(self,key,turn_id):
        # Only lifecycle facts, not response IDs or a wall-clock inference.
        with closing(self.state.connect()) as db:
            rows=db.execute("SELECT kind,data FROM events WHERE thread_id=? AND kind IN ('turn_started','turn_completed') ORDER BY seq DESC LIMIT 64",(key,)).fetchall()
        for item in rows:
            data=json.loads(item['data'])
            if data.get('turn_id')==turn_id:
                return data.get('status') if item['kind']=='turn_completed' else 'inProgress'
        return None
    def _await_control_start(self,row,turn_id):
        # turn/start can respond before the provider installs the active turn.
        # Wait on the exact native event, never retry a rejected control blindly.
        deadline=time.monotonic()+self.control_start_wait_secs
        with self.turn_condition:
            while True:
                observed=self._turn_observation(row['id'],turn_id)
                if observed in ('completed','interrupted','failed'):return observed
                current=self.state.thread(row['id'])
                require(current['active_turn']==turn_id,'active_turn_changed',409)
                require(not self.closed and self.connection and self.connection.alive,'connection_lost_reconcile_original',409)
                if observed=='inProgress':return observed
                remaining=deadline-time.monotonic()
                require(remaining>0,'native_start_not_observed_no_control_sent',409)
                self.turn_condition.wait(min(remaining,.2))
    def refresh_liveness(self):
        if self.connection and not self.connection.alive:
            self.notice='connection_lost_original_work_retained'
            for row in self.state.listing():
                if row['provider']=='codex' and row['status'] in ('working','stopping'):
                    self.state.update(row['id'],status='unknown')
                    self.state.event(row['id'],'connection_lost',{'code':'native_connection_closed','replay':False})
            self.approvals.clear();self.sends.clear()
    def info(self):
        self.refresh_liveness()
        alive=bool(self.connection and self.connection.alive)
        return {'instance_id':self.instance,'store_id':self.state.id,'intent':self.intent,'root':str(self.root),
          'lifetime':getattr(self,'lifetime',{'owner':'bounded-or-unknown','source':'unverified','durability_verified':False,'runner_deadline_bypassed':False}),
          'version':'0.7.0-alpha.1','providers':[
            {'id':'codex','name':'本地 Codex','installed':bool(shutil.which('codex')),'connected':alive,
             'account':self.account,'defaults':self.config,'capabilities':['create','resume','fork','send','steer','interrupt','approvals','public_events'],'protocol':'codex-app-server-jsonl','status':self.notice or ('connected' if alive else 'not_connected')},
            {'id':'native_web','name':'ChatGPT Web','configured':self.transport is not None,'protocol':'webcodex-conversation','capabilities':['diagnose','attach_existing','send_message','public_replies'],'status':self.web.access['status'],'authorization_verified':self.web.access['status']=='read_authorized','automatic_fork':False,'native_interrupt':False},
            {'id':HOST_PROVIDER,'name':'ChatGPT Web · MCP Host','protocol':'authorized-project-job-host','capabilities':['registered_host_send','public_replies','pause_receiving'],'status':'registered' if self.host_bridge.snapshot()['bindings'] else 'host_pairing_needed','automatic_fork':False,'native_interrupt':False,'native_communication_auth_fixed':False},
            {'id':'pi','name':'Pi / 其他 Harness','installed':bool(shutil.which('pi')),'protocol':'provider-adapter','capabilities':[],'status':'adapter_not_implemented'}],
          'no_model_fallback':True,'business_pipeline':False,'workspace_parallelism':'same-root managed turns serialized; independent workspace adapters next'}
    def connect(self):
        with self.lock:
            require(not self.closed,'service_closed',503)
            if self.connection and self.connection.alive:return self.info()
            self.connection=self.connection_factory(self.root,self.on_event)
            try:
                self.connection.start()
                account=self.connection.request('account/read',{'refreshToken':False})
                acc=account.get('account') or {}
                require(acc.get('type')=='chatgpt','codex_chatgpt_login_required_no_api_fallback',403)
                self.account={'type':acc.get('type'),'plan_type':acc.get('planType')}
                cfg=self.connection.request('config/read',{'includeLayers':False}).get('config') or {}
                # A configured external provider must be explicitly integrated, never silently charged.
                require(cfg.get('model_provider') in (None,'openai'),'external_model_provider_not_enabled',403)
                self.config={'model':cfg.get('model'),'effort':cfg.get('model_reasoning_effort'),'source':'installed_codex_configuration'}
                self.notice='';self.attached.clear()
            except Exception:
                self.connection.close();self.connection=None;raise
            return self.info()
    def native_diagnostics(self):
        # Reads return retained observations; an authorization denial is not polled repeatedly.
        return self.web.snapshot()
    def _web_command(self,action,key,data,row=None):
        if action=='web.probe':
            require(set(data)<={'authorization_changed'} and type(data.get('authorization_changed',False)) is bool,'invalid_web_confirmation')
            return {'web':self.web.probe(data.get('authorization_changed',False))}
        if action=='web.attach':
            require(set(data)=={'target_id','confirm'},'invalid_web_binding')
            return self.web.attach(data['target_id'],data['confirm'])
        if action=='thread.sync':
            require(not data,'unexpected_fields');return self.web.sync(row['id'],force=True)
        require(action=='message.send','native_web_action_not_supported_no_fallback',409)
        require(set(data)=={'text'},'invalid_message')
        with self.lock:
            require(not any(t['id']!=row['id'] and t['status'] in BUSY for t in self.state.listing()),'workspace_busy_or_unreconciled',409)
            with closing(self.state.connect()) as db:
                uncertain=db.execute("SELECT 1 FROM operations WHERE action='message.send' AND state IN ('reserved','dispatching','unknown') AND id<>?",(key,)).fetchone()
            require(uncertain is None,'workspace_has_unresolved_send',409)
            return self.web.send(row['id'],data['text'],key)
    def on_event(self,event):
        method=event.get('method','');params=event.get('params') or {}
        if not isinstance(params,dict):return
        # Never persist reasoning streams or raw auth diagnostics in the UI journal.
        if 'reasoning' in method.lower() or 'auth' in method.lower() or method.startswith('config/'):return
        native=params.get('threadId') or (params.get('thread') or {}).get('id')
        row=self.state.by_native(native) if isinstance(native,str) else None
        if not row:
            if method in ('clw/closed','clw/protocolError'):
                for item in self.state.listing():
                    if item['provider']=='codex' and item['status'] in ('working','stopping'):
                        self.state.update(item['id'],status='unknown')
                        self.state.event(item['id'],'connection_lost',{'code':'native_connection_closed','replay':False})
            return
        key=row['id']
        if 'id' in event:
            request_id=event['id'];approval_key=uuid.uuid4().hex
            self.approvals[approval_key]={'thread_id':key,'request_id':request_id,'method':method,'params':public(params),'instance_id':self.instance}
            self.state.event(key,'approval',{'approval_id':approval_key,'method':method,'params':public(params),'supported':method in APPROVAL_METHODS})
            return
        if method=='item/agentMessage/delta':
            self.state.event(key,'assistant_delta',{'item_id':params.get('itemId'),'text':params.get('delta',''),'turn_id':params.get('turnId')})
        elif method=='item/completed':
            item=params.get('item') or {};kind=item.get('type')
            if kind=='agentMessage':self.state.event(key,'assistant_message',{'item_id':item.get('id'),'text':item.get('text',''),'turn_id':params.get('turnId')})
            elif kind in ('commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch','collabAgentToolCall'):
                # Do not include raw environment / arbitrary tool argument objects.
                self.state.event(key,'tool',{'type':kind,'item_id':item.get('id'),'command':item.get('command'),'status':item.get('status'),'exit_code':item.get('exitCode'),'output':item.get('aggregatedOutput','')[-24000:],'changes':item.get('changes',[])})
        elif method=='turn/started':
            turn=params.get('turn') or {};turn_id=turn.get('id')
            if not isinstance(turn_id,str):return
            with self.turn_condition:
                current=self.state.thread(key)
                if self._turn_observation(key,turn_id) in ('completed','interrupted','failed'):return
                if current['active_turn'] not in (None,turn_id):return
                self.state.update(key,status='stopping' if current['status']=='stopping' else 'working',active_turn=turn_id)
                operation_id=self.sends.pop(native,None)
                self.state.event(key,'turn_started',{'turn_id':turn_id,'operation_id':operation_id})
                if operation_id:
                    self.state.operation(operation_id,'completed',{'operation_id':operation_id,'thread_id':key,'turn_id':turn_id,'state':'accepted_not_completed','source':'native_turn_started_event'})
                self.turn_condition.notify_all()
        elif method=='turn/completed':
            turn=params.get('turn') or {};turn_id=turn.get('id');status=turn.get('status')
            if not isinstance(turn_id,str):return
            with self.turn_condition:
                current=self.state.thread(key);matches=current['active_turn']==turn_id or (current['active_turn'] is None and native not in self.sends)
                if matches:
                    state={'completed':'idle','interrupted':'interrupted','failed':'error'}.get(status,'unknown')
                    self.state.update(key,status=state,active_turn=None)
                self.state.event(key,'turn_completed',{'turn_id':turn_id,'status':status,'error':public(turn.get('error'))})
                if matches:
                    for aid,a in list(self.approvals.items()):
                        if a['thread_id']==key:self.approvals.pop(aid,None)
                self.turn_condition.notify_all()
        elif method=='turn/diff/updated':self.state.event(key,'diff',{'text':params.get('diff','')[:120000]})
        elif method=='turn/plan/updated':self.state.event(key,'plan',{'plan':params.get('plan'),'explanation':params.get('explanation')})
        elif method=='error':self.state.event(key,'provider_error',{'code':'native_turn_error','message':str(params.get('message',''))[:2000]})
    def _attach(self,row):
        self.connect()
        if row['native_id'] not in self.attached:
            result=self.connection.request('thread/resume',{'threadId':row['native_id'],'cwd':row['cwd'],'approvalPolicy':'on-request','sandbox':'workspace-write'})
            require((result.get('thread') or {}).get('id')==row['native_id'],'native_resume_identity_mismatch',502)
            self.attached.add(row['native_id'])
    def receipt(self,key):
        original=self.state.receipt(key)
        known=self.host_bridge.team.completed_public_receipt(key) if not original.get('result') else None
        return {'operation_id':key,'state':'completed','result':known,'derived_from_original_team_receipt':True} if known else original
    def command(self,raw):
        with self.host_bridge.business_admission():return self._command(raw)
    def _command(self,raw):
        require(isinstance(raw,dict) and set(raw)<={'request_id','action','thread_id','data'},'invalid_command')
        require(raw.get('action') in ACTIONS|TEAM_PANEL_ACTIONS,'unsupported_action')
        require(isinstance(raw.get('data',{}),dict),'invalid_command_data')
        # Count actual UTF-8 bytes; ASCII escaping made Chinese merged notes
        # exceed the transport cap despite staying within their input budget.
        require(len(json.dumps(raw,ensure_ascii=False).encode('utf-8'))<=262144,'command_too_large',413)
        fresh,old=self.state.begin(raw.get('request_id'),raw)
        if not fresh:
            return (self.host_bridge.team.completed_public_receipt(raw['request_id']) or old) if raw.get('action') in TEAM_PANEL_ACTIONS else old
        key=raw['request_id'];action=raw['action'];data=raw.get('data',{});row=None;send_reserved=False
        try:
            if action in ('web.probe','web.attach'):
                result=self._web_command(action,key,data)
            elif raw.get('thread_id') and self.state.thread(raw['thread_id'])['provider']=='native_web':
                row=self.state.thread(raw['thread_id']);result=self._web_command(action,key,data,row)
            elif raw.get('thread_id') and self.state.thread(raw['thread_id'])['provider']==HOST_PROVIDER:
                row=self.state.thread(raw['thread_id'])
                if action in TEAM_PANEL_ACTIONS:
                    result=self.host_bridge.team.public_command(row['id'],key,action.removeprefix('team.'),data)
                elif action=='message.send':
                    require(set(data)=={'text'},'invalid_message');result=self.host_bridge.send(row['id'],data['text'],key)
                elif action in ('control.pair','control.disable','control.adopt'):
                    expected={'control.pair':{'confirm','model_label','effort_label'},'control.disable':{'confirm'},'control.adopt':{'confirm','request_id'}}[action]
                    require(set(data)==expected,'control_command_fields')
                    mapped={'control.pair':'control-code','control.disable':'control-disable','control.adopt':'control-adopt'}[action]
                    with self.lock:
                        with closing(self.state.connect()) as db:b=self.host_bridge.binding(db,thread=row['id'])
                        result=self.host_bridge.control.private(b,{'action':mapped,**data})
                elif action=='recovery.pair':
                    require(not data,'unexpected_fields');result=self.host_bridge.recovery.pairing_code(row['id'])
                elif action=='recovery.disable':
                    require(not data,'unexpected_fields');result=self.host_bridge.recovery.disable(row['id'])
                elif action=='message.append':
                    require(set(data)=={'text','expected_request_id'},'invalid_host_note')
                    result=self.host_bridge.collaboration.append(row['id'],data['expected_request_id'],data['text'],key)
                elif action=='thread.sync':
                    require(not data,'unexpected_fields');result={'thread':row,'host':self.host_bridge.snapshot(),'source':'local_host_receipts_not_native_history_mirror'}
                elif action in ('host.pause','host.resume'):
                    require(not data,'unexpected_fields');result=self.host_bridge.pause(row['id'],action=='host.resume')
                else:require(False,'host_control_not_supported_no_provider_fallback',409)
            elif action=='provider.connect':
                require(not data,'unexpected_fields');result={'provider':self.connect()}
            elif action in ('thread.create','thread.fork'):
                require(set(data)<={'title'},'unexpected_fields');title=data.get('title') or '新的开发对话'
                require(isinstance(title,str) and 0<len(title)<=160,'invalid_title')
                with self.lock:
                    self.connect();params={'cwd':str(self.root),'approvalPolicy':'on-request','sandbox':'workspace-write'}
                    if action=='thread.fork':
                        row=self.state.thread(raw.get('thread_id'));require(row['status'] not in ('working','stopping','unknown'),'parent_not_idle',409)
                        params['threadId']=row['native_id']
                    self.state.operation(key,'dispatching')
                    reply=self.connection.request('thread/fork' if row else 'thread/start',params)
                    native=reply.get('thread') or {};require(isinstance(native.get('id'),str),'missing_native_thread',502)
                    thread=self.state.bind(native['id'],title,self.root,reply.get('model') or self.config.get('model'),self.config.get('effort'),row['id'] if row else None)
                    self.attached.add(native['id']);self.state.event(thread['id'],'thread_created',{'provider':'codex','native_id':native['id'],'parent_id':row['id'] if row else None,'inherited_history':bool(row)})
                    result={'thread':thread}
            else:
                row=self.state.thread(raw.get('thread_id'));require(row['provider']=='codex','unsupported_provider')
                if action=='message.send':
                    require(set(data)=={'text'} and isinstance(data.get('text'),str) and 0<len(data['text'].strip())<=24000,'invalid_message')
                    with self.lock:
                        row=self.state.thread(row['id'])
                        require(row['status'] not in ('working','stopping','unknown'),'thread_busy_or_unknown',409)
                        with closing(self.state.connect()) as db:
                            unresolved=db.execute("SELECT 1 FROM operations WHERE action='message.send' AND state IN ('reserved','dispatching','unknown') AND id<>? LIMIT 1",(key,)).fetchone()
                        require(unresolved is None,'workspace_has_unresolved_send',409)
                        require(not any(t['id']!=row['id'] and t['cwd']==row['cwd'] and t['status'] in BUSY for t in self.state.listing()),'workspace_busy_or_unreconciled',409)
                        self._attach(row);self.state.update(row['id'],status='working');send_reserved=True
                        self.state.event(row['id'],'user_message',{'text':data['text'],'operation_id':key})
                        self.state.operation(key,'dispatching');self.sends[row['native_id']]=key
                        reply=self.connection.request('turn/start',{'threadId':row['native_id'],'input':[{'type':'text','text':data['text'],'text_elements':[]}]})
                        turn=reply.get('turn') or {};require(isinstance(turn.get('id'),str),'missing_native_turn',502)
                        if self.state.thread(row['id'])['status']=='working':self.state.update(row['id'],active_turn=turn['id'])
                        result={'thread_id':row['id'],'turn_id':turn['id'],'state':'accepted_not_completed'}
                elif action=='turn.stop':
                    require(not data,'unexpected_fields');require(row['active_turn'] and row['status'] in ('working','stopping'),'no_observed_active_turn',409)
                    turn_id=row['active_turn'];observed=self._await_control_start(row,turn_id)
                    if observed!='inProgress':
                        result={'thread_id':row['id'],'turn_id':turn_id,'state':'already_terminal','native_status':observed,'interrupt_sent':False}
                    else:
                        self.state.operation(key,'dispatching');self.connection.request('turn/interrupt',{'threadId':row['native_id'],'turnId':turn_id})
                        with self.turn_condition:
                            current=self.state.thread(row['id'])
                            if current['active_turn']==turn_id and current['status']=='working':self.state.update(row['id'],status='stopping')
                        result={'thread_id':row['id'],'turn_id':turn_id,'state':'stop_requested_not_terminal'}
                elif action=='message.steer':
                    require(set(data)=={'text','expected_turn_id'} and isinstance(data.get('text'),str) and 0<len(data['text'].strip())<=24000,'invalid_steering')
                    require(isinstance(data.get('expected_turn_id'),str) and data['expected_turn_id']==row['active_turn'],'active_turn_changed',409)
                    require(row['status']=='working','thread_not_steerable',409)
                    require(self._await_control_start(row,data['expected_turn_id'])=='inProgress','turn_already_terminal_no_steering_sent',409)
                    require(self.state.thread(row['id'])['status']=='working','thread_not_steerable',409)
                    self.state.operation(key,'dispatching')
                    reply=self.connection.request('turn/steer',{'threadId':row['native_id'],'expectedTurnId':data['expected_turn_id'],'input':[{'type':'text','text':data['text'],'text_elements':[]}]})
                    require(reply.get('turnId')==data['expected_turn_id'],'native_steer_identity_mismatch',502)
                    self.state.event(row['id'],'user_steering',{'text':data['text'],'operation_id':key,'turn_id':reply['turnId']})
                    result={'thread_id':row['id'],'turn_id':reply['turnId'],'state':'steered_not_completed'}
                elif action=='approval.respond':
                    require(set(data)=={'approval_id','decision'} and data['decision'] in ('accept','decline','cancel'),'invalid_approval')
                    approval=self.approvals.get(data['approval_id']);require(approval and approval['thread_id']==row['id'] and approval['instance_id']==self.instance,'approval_expired_or_foreign',409)
                    require(approval['method'] in APPROVAL_METHODS,'unsupported_approval_type',409)
                    require(self.connection and self.connection.alive,'connection_lost_reconcile_original',409)
                    self.state.operation(key,'dispatching');self.connection.respond(approval['request_id'],{'decision':data['decision']})
                    self.approvals.pop(data['approval_id'],None);self.state.event(row['id'],'approval_resolved',data)
                    result={'state':'approval_response_sent'}
                elif action=='thread.sync':
                    require(not data,'unexpected_fields');self.connect()
                    reply=self.connection.request('thread/read',{'threadId':row['native_id'],'includeTurns':True})
                    native=reply.get('thread') or {};require(native.get('id')==row['native_id'],'native_read_identity_mismatch',502)
                    turns=native.get('turns') or [];last=turns[-1] if turns else None
                    with self.turn_condition:
                        current=self.state.thread(row['id'])
                        stable=current['active_turn']==row['active_turn'] and current['status']==row['status']
                        applies=stable and (current['active_turn'] is None or bool(last and last.get('id')==current['active_turn']))
                        if applies:
                            state={'completed':'idle','interrupted':'interrupted','failed':'error','inProgress':'working'}.get(last.get('status'),'unknown') if last else 'idle'
                            if current['status']=='stopping' and state=='working':state='stopping'
                            self.state.update(row['id'],status=state,active_turn=last.get('id') if last and state in ('working','stopping') else None)
                        self.state.event(row['id'],'native_sync',{'native_id':native['id'],'turn_count':len(turns),'last_turn_status':last.get('status') if last else None,'state_applied':applies,'unknown_send_not_replayed':True})
                    result={'thread':self.state.thread(row['id']),'state_applied':applies,'turns':[{ 'id':t.get('id'),'status':t.get('status'),'messages':[{'type':i.get('type'),'text':i.get('text')} for i in t.get('items',[]) if i.get('type')=='agentMessage']} for t in turns[-5:]],'unknown_send_not_replayed':True}
            result=public({'operation_id':key,'state':'completed',**result});self.state.operation(key,'completed',result);return result
        except (HarnessError,RpcFailure,TaskError) as exc:
            if (action.startswith('web.') or (row and row['provider']=='native_web')) and getattr(exc,'native_http_status',None) in (401,403):
                self.web.denied=True;self.web._save_access({'status':'blocked','code':exc.code,'http_status':exc.native_http_status,'required_scopes':getattr(exc,'required_scopes',[])})
            unknown=getattr(exc,'unknown',False)
            if isinstance(exc,HarnessError) and exc.status>=500:unknown=True
            if unknown and send_reserved:
                observed=self.state.receipt(key).get('result')
                if observed and observed.get('turn_id'):return observed
            if send_reserved and not unknown:self.sends.pop(row['native_id'],None)
            if row and send_reserved and self.state.thread(row['id'])['status']=='working':self.state.update(row['id'],status='unknown' if unknown else 'error')
            result={'operation_id':key,'state':'unknown' if unknown else 'rejected','code':exc.code,'unknown':unknown}
            if exc.code=='workspace_busy_or_unreconciled' and isinstance(getattr(exc,'blocker',None),dict):result['blocker']=public(exc.blocker)
            self.state.operation(key,result['state'],result)
            if row:self.state.event(row['id'],'operation_error',result)
            return result
        except Exception:
            result={'operation_id':key,'state':'unknown','code':'unexpected_error_reconcile_original','unknown':True}
            self.state.operation(key,'unknown',result)
            if row:
                if send_reserved:self.state.update(row['id'],status='unknown')
                self.state.event(row['id'],'operation_error',result)
            return result
    def artifacts(self,key):
        self.state.thread(key);items=[]
        with closing(self.state.connect()) as db:
            rows=db.execute("SELECT seq,data FROM events WHERE thread_id=? AND kind='tool' ORDER BY seq DESC LIMIT 100",(key,)).fetchall()
        for row in rows:
            value=json.loads(row['data'])
            if value.get('type')!='fileChange':continue
            for index,change in enumerate(value.get('changes',[])[:32]):
                raw=change.get('path')
                if not isinstance(raw,str):continue
                path=Path(raw);path=path if path.is_absolute() else self.root/path
                try:relative=path.relative_to(self.root).as_posix()
                except ValueError:continue
                parts=relative.lower().split('/')
                protected=any(p in {'.git','.local','node_modules','.codex','secrets','credentials'} or p.startswith('.env') for p in parts) or parts[-1] in {'auth.json','credentials.json','connection.json','runner.toml','webcodex-user-token'}
                previewable=not protected and path.suffix.lower() in {'.txt','.md','.py','.json','.js','.mjs','.html','.css','.cs','.toml','.yaml','.yml','.shader','.xml','.csv','.log'}
                items.append({'id':'f'+str(row['seq'])+'_'+str(index),'path':relative,'previewable':previewable,'source':'native_file_change','event_seq':row['seq']})
        return {'items':items[:100],'scope':'native recorded file changes, not arbitrary filesystem browsing'}
    def artifact(self,key,artifact_id):
        require(isinstance(artifact_id,str) and re.fullmatch(r'f[0-9]+_[0-9]+',artifact_id),'invalid_artifact')
        item=next((x for x in self.artifacts(key)['items'] if x['id']==artifact_id),None)
        require(item and item['previewable'],'artifact_not_previewable',403)
        try:data=file_bytes(self.root,item['path'],256*1024)
        except (WorkerError,OSError,ValueError):raise HarnessError('artifact_unavailable_or_unstable',409) from None
        try:text=data.decode('utf-8-sig')
        except UnicodeError:raise HarnessError('artifact_not_utf8_text',415) from None
        import hashlib
        return {**item,'text':public(text),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'meaning':'current file bytes, not automatically approved or original snapshot'}
    def diff(self,key):
        row=self.state.thread(key);require(Path(row['cwd']).resolve()==self.root,'foreign_workspace',403)
        # A bounded argument-only read; never arbitrary shell text from HTTP.
        result=subprocess.run(['git','--no-pager','diff','--no-ext-diff','--no-textconv','--stat'],cwd=self.root,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=12)
        patch=subprocess.run(['git','--no-pager','diff','--no-ext-diff','--no-textconv','--unified=3'],cwd=self.root,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=12)
        return {'summary':public(result.stdout[:16000]),'text':public(patch.stdout[:120000]),'truncated':len(patch.stdout)>120000,'scope':'current working tree, not exclusively this model turn','exit_code':patch.returncode}
    def pending(self,key):
        self.state.thread(key)
        return [{'approval_id':k,**{n:v for n,v in a.items() if n!='request_id'}} for k,a in self.approvals.items() if a['thread_id']==key]
    def close(self):
        self.host_bridge.team.close()
        self.closed=True;self.web.closed=True;self.web_poll_stop.set()
        if self.web_poll_thread and self.web_poll_thread is not threading.current_thread():self.web_poll_thread.join(timeout=35)
        if self.connection:self.connection.close()
        for row in self.state.listing():
            if row['status'] in ('working','stopping'):self.state.update(row['id'],status='unknown')
