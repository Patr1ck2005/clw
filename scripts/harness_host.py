"""Project-local Host inbox, consumed through an already-authorized MCP Job.

This is NOT an adapter for a denied communication principal. It never calls the
native Conversation API, uses a PAT, changes Agent ownership, or runs a model.
The private endpoint is available to trusted processes in this explicit local
workspace, not browser clients. Provider identity is an operator binding, not
cryptographic certification of a ChatGPT account or reasoning configuration.
"""
from __future__ import annotations
from contextlib import closing,contextmanager
from pathlib import Path
import hashlib, hmac, json, os, re, secrets, stat, threading, time
from harness_state import HarnessError,canonical, public, require, stamp
from harness_collaboration import HostCollaboration, FIELDS as BRANCH_FIELDS, title as host_title
from harness_handoff import record_offer
from harness_control_plane import ControlPlane, PRIVATE_FIELDS as CONTROL_FIELDS
from harness_team import TeamRuntime, FIELDS as TEAM_FIELDS

PROVIDER = 'chatgpt_web_host'
KEY_NAME = 'host-access.key'
ACTIVE = ('queued', 'processing', 'suspended')
BUSY = {'working','stopping','unknown','waiting','processing','waiting_children','web_waiting','web_processing'}

def read_local_key(directory: Path) -> str:
    path = Path(directory) / KEY_NAME
    s = path.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= 128
            and not (getattr(s,'st_file_attributes',0) & 0x400),'host_key_not_plain',403)
    with path.open('rb') as f:
        opened = os.fstat(f.fileno())
        require((s.st_dev,s.st_ino)==(opened.st_dev,opened.st_ino),'host_key_changed',409)
        value = f.read(129).decode('ascii').strip()
    require(bool(re.fullmatch(r'clwh_[A-Za-z0-9_-]{43}',value)),'host_key_invalid',403)
    return value

class HostBridge:
    def __init__(self,state,root:Path,targets:dict,lock=None,clock=time.time):
        self.state,self.root,self.targets = state,Path(root).resolve(),targets
        self.lock=lock or threading.RLock();self.clock=clock
        self.maintenance_exit_fence=None;self.active_business_operations=0
        path=state.path.parent/KEY_NAME
        try:
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        except FileExistsError:pass
        else:
            with os.fdopen(fd,'w',encoding='ascii') as f:
                f.write('clwh_'+secrets.token_urlsafe(32)+'\n');f.flush();os.fsync(f.fileno())
        self._key=read_local_key(state.path.parent)
        with closing(state.connect()) as db:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS host_bindings(
                target_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE,
                spec TEXT NOT NULL, enabled INTEGER NOT NULL,
                wait_key TEXT, wait_until REAL NOT NULL DEFAULT 0);
              CREATE TABLE IF NOT EXISTS host_requests(
                id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, text TEXT NOT NULL,
                phase TEXT NOT NULL, claim_id TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, finished_at TEXT);
              CREATE TABLE IF NOT EXISTS host_replies(
                id TEXT PRIMARY KEY, request_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL, response TEXT NOT NULL);
            ''');db.commit()
        self.collaboration = HostCollaboration(self)
        from harness_recovery import Recovery
        self.recovery = Recovery(self)
        self.control = ControlPlane(self)
        self.team = TeamRuntime(self)
        from harness_managed import ManagedPages
        self.managed = ManagedPages(self)
    def authorize(self,value):
        require(isinstance(value,str) and len(value)<=128 and hmac.compare_digest(value,self._key),'host_process_authorization_required',403)
    @contextmanager
    def business_admission(self,*,read_only=False):
        # Count the original synchronous operation across bounded external IO,
        # without holding the shared lock during that IO. A shutdown cannot
        # seal while an admitted operation can still commit or dispatch.
        if read_only:
            yield
            return
        with self.lock:
            require(self.maintenance_exit_fence is None,'maintenance_original_host_shutdown_pending',409)
            self.active_business_operations+=1
        try:yield
        finally:
            if not read_only:
                with self.lock:self.active_business_operations-=1
    def seal_maintenance(self,permit_id):
        with self.lock:
            require(self.active_business_operations==0,'maintenance_original_execution_unresolved',409)
            require(self.maintenance_exit_fence in (None,permit_id),'maintenance_exit_requires_original_receipt',409)
            self.maintenance_exit_fence=permit_id
    @staticmethod
    def identifier(value):
        require(isinstance(value,str) and bool(re.fullmatch(r'[A-Za-z0-9_-]{16,100}',value)),'host_operation_id_required')
        return value
    def emit(self,db,thread,kind,data):
        cursor=db.execute('INSERT INTO events(thread_id,kind,data,at) VALUES(?,?,?,?)',(thread,kind,canonical(public(data)),stamp()))
        if hasattr(self,'team'):self.team.on_event(db,thread,kind,data,cursor.lastrowid)
        return cursor.lastrowid
    def binding(self,db,target=None,thread=None):
        row=db.execute('SELECT * FROM host_bindings WHERE '+('target_id' if target is not None else 'thread_id')+'=?',(target if target is not None else thread,)).fetchone()
        require(row is not None,'host_binding_missing',409)
        result=dict(row);result['spec']=json.loads(result['spec']);return result
    def future_paused(self,db,binding,request=None):
        """Only admission is inherited along the ORIGINAL request delegation chain."""
        managed=db.execute("SELECT * FROM managed_pages WHERE thread_id=? AND phase='bound'",(binding['thread_id'],)).fetchone()
        if managed and self.managed.paused(db,managed):return True
        if not binding['enabled']:return True
        if request is None:return False
        require(request['thread_id']==binding['thread_id'],'host_request_identity_changed',409)
        seen=set();current=request['id'];current_thread=request['thread_id']
        while current:
            require(current not in seen,'host_delegation_graph_invalid',409);seen.add(current)
            edge=db.execute('SELECT * FROM host_delegations WHERE child_request_id=?',(current,)).fetchone()
            provenance=db.execute("SELECT data FROM events WHERE thread_id=? AND kind='host_delegated_input' AND json_extract(data,'$.request_id')=?",(current_thread,current)).fetchall()
            if not edge:
                require(not provenance,'host_delegation_identity_changed',409)
                return False
            require(edge['child_thread_id']==current_thread and self.binding(db,thread=current_thread)['target_id']==edge['child_target_id'],'host_delegation_identity_changed',409)
            require(len(provenance)==1,'host_delegation_identity_changed',409)
            source=json.loads(provenance[0]['data'])
            require(source.get('parent_request_id')==edge['parent_request_id'] and source.get('parent_thread_id')==edge['parent_thread_id'],'host_delegation_identity_changed',409)
            parent=db.execute('SELECT id,thread_id FROM host_requests WHERE id=?',(edge['parent_request_id'],)).fetchone()
            require(parent and parent['thread_id']==edge['parent_thread_id'],'host_delegation_identity_changed',409)
            owner=self.binding(db,thread=parent['thread_id'])
            if self.future_paused(db,owner):return True
            current=parent['id'];current_thread=parent['thread_id']
        return False
    def private(self,token,data):
        self.authorize(token)
        read_only=self.maintenance_exit_fence is not None and isinstance(data,dict) and data.get('action')=='read'
        with self.business_admission(read_only=read_only):return self._private(token,data)
    def _private(self,token,data):
        self.authorize(token)
        require(isinstance(data,dict) and data.get('store_id')==self.state.id,'host_store_mismatch',409)
        action=data.get('action')
        fields={'register':{'confirm'},'poll':{'wait_key'},'claim':{'request_id','claim_id'},'read':{'request_id'},'reply':{'request_id','claim_id','reply_id','status','text'},'release-wait':{'wait_key'}}
        fields.update(BRANCH_FIELDS)
        fields.update(CONTROL_FIELDS)
        fields.update(TEAM_FIELDS)
        fields['managed']={'op','operation_id','payload'}
        fields['recover']={'request_id','recovery_id'}
        require(action in fields and set(data)=={'action','store_id','target_id','session_id'}|fields[action],'host_command_fields')
        if action == 'join':return self.collaboration.join(data)
        if action == 'managed':return self.managed.private(data)
        if action=='team' and data['op']=='enroll':return self.team.enroll(data)
        target=data.get('target_id')
        expected=self.targets.get(target) or self.managed.definition(target) or self.collaboration.definition(target)
        require(data.get('session_id')==expected['session_id'],'host_session_mismatch',403)
        with self.lock:
            if action=='register':return self.register(expected,data['confirm'])
            with closing(self.state.connect()) as db:
                binding=self.binding(db,target=target)
                require(binding['spec']==expected,'host_binding_configuration_changed',409)
                git_probe=self.team.scopes.preflight_native_git(binding['thread_id']) if action in ('poll','claim') else None
                if action=='claim':
                    # The native admission ledger uses this same SQLite write
                    # lock. Hold it across the legacy busy check and the
                    # processing/claim transition, so a native writer cannot
                    # reserve the same directory in between.
                    db.execute('BEGIN IMMEDIATE')
                    binding=self.binding(db,target=target)
                    require(binding['spec']==expected,'host_binding_configuration_changed',409)
                if action in CONTROL_FIELDS:return self.control.private(binding,data)
                if action=='team':return self.team.handle(binding,data)
                if action in BRANCH_FIELDS:return self.collaboration.action(db,binding,data)
                if action=='poll':
                    require(not self.control.owns(db,binding['thread_id']),'control_carrier_owns_receiver_no_legacy_poll',409)
                    self.identifier(data['wait_key']);require(binding['enabled'],'host_paused',409)
                    now=self.clock()
                    require(binding['wait_key'] in (None,data['wait_key']) or binding['wait_until']<now,'host_wait_already_owned',409)
                    db.execute('UPDATE host_bindings SET wait_key=?,wait_until=? WHERE target_id=?',(data['wait_key'],now+30,target));db.commit()
                    r=self.collaboration.candidate(db,binding,git_probe=git_probe)
                    if r is not None:record_offer(db,self,binding,r)
                    return {'available':bool(r),'request_id':r['id'] if r else None,'thread_id':binding['thread_id'],'session_id':expected['session_id'],'project':expected['project'],'guide':'docs/harness/HOST_RECEIVER.md','claim_performed':False}
                if action=='release-wait':
                    self.identifier(data['wait_key']);db.execute('UPDATE host_bindings SET wait_key=NULL,wait_until=0 WHERE target_id=? AND wait_key=?',(target,data['wait_key']));db.commit();return {'released':True}
                self.identifier(data.get('request_id'))
                r=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',(data['request_id'],binding['thread_id'])).fetchone()
                require(r is not None,'host_request_missing',404);r=dict(r)
                if action=='recover':return self.recovery.acknowledge(db,binding,r,data['recovery_id'])
                if action=='read':
                    result=self.project_request(binding,r)
                    if self.maintenance_exit_fence is None:self.collaboration.acknowledge_notes(db,r['id'])
                    return result
                if action=='claim':
                    self.identifier(data['claim_id'])
                    if r['phase']=='processing':
                        require(r['claim_id']==data['claim_id'],'host_request_already_claimed',409)
                        return {**self.project_request(binding,r),'already_claimed':True,'execution':'recover_original_do_not_repeat'}
                    if self.future_paused(db,binding,r):
                        attempts=db.execute("SELECT a.id,a.epoch FROM control_attempts a JOIN control_peers p ON p.thread_id=a.thread_id AND p.generation=a.generation WHERE a.request_id=? AND a.thread_id=? AND a.state IN ('dispatching','sent','unknown','acknowledged') AND p.enabled=1 AND p.expires>?",(r['id'],binding['thread_id'],self.clock())).fetchall()
                        require(any(a['epoch']==self.control.epoch(db,r) and data['claim_id']=='clw-control-claim-'+a['id'].removeprefix('control_') for a in attempts),'host_paused',409)
                    self.team.claim_gate(db,r,git_probe=git_probe)
                    require(not self.collaboration.busy(db,binding['thread_id'],git_probe=git_probe,
                                                        held_request_id=r['id']),'host_checkout_execution_busy',409)
                    if r['phase']=='suspended':
                        require(r['claim_id']==data['claim_id'],'host_parent_claim_mismatch',409)
                        require(self.team.can_resume(db,r),'host_children_still_pending',409)
                        db.execute("UPDATE host_requests SET phase='processing' WHERE id=?",(r['id'],))
                        db.execute("UPDATE threads SET status='processing',active_turn=?,updated_at=? WHERE id=?",(r['id'],stamp(),binding['thread_id']))
                        self.emit(db,binding['thread_id'],'host_parent_resumed',{'request_id':r['id'],'original_claim':True})
                        db.commit();r['phase']='processing'
                        return {**self.project_request(binding,r),'already_claimed':True,'execution':'resume_original_after_children_no_new_request'}
                    require(r['phase']=='queued' and not r['cancel_requested'],'host_request_not_runnable',409)
                    db.execute("UPDATE host_requests SET phase='processing',claim_id=? WHERE id=?",(data['claim_id'],r['id']))
                    db.execute("UPDATE threads SET status='processing',active_turn=?,updated_at=? WHERE id=?",(r['id'],stamp(),binding['thread_id']))
                    self.emit(db,binding['thread_id'],'host_claimed',{'request_id':r['id'],'source':'explicit_project_host_process_not_provider_authentication'})
                    db.commit();r.update(phase='processing',claim_id=data['claim_id'])
                    return {**self.project_request(binding,r),'already_claimed':False,'execution':'new_claim_check_original_jobs_before_work'}
                result=self.project_reply(db,binding,r,data);db.commit();return result
    def project_reply(self,db,binding,r,data):
        self.identifier(data['reply_id']);self.identifier(data['claim_id'])
        require(data['status'] in ('progress','completed','blocked','cancelled'),'host_reply_status')
        require(isinstance(data['text'],str) and 0<len(data['text'].strip())<=48000,'host_reply_text')
        fp=hashlib.sha256(canonical(data).encode()).hexdigest()
        previous=db.execute('SELECT * FROM host_replies WHERE id=?',(data['reply_id'],)).fetchone()
        if previous:
            require(previous['fingerprint']==fp,'host_reply_conflict',409);return json.loads(previous['response'])
        require(r['phase']=='processing' and r['claim_id']==data['claim_id'],'host_claim_not_current',409)
        status=data['status'];final=status!='progress'
        if final:require(not self.collaboration.outstanding(db,r['id']),'host_children_still_pending',409)
        if final:self.team.final_gate(db,binding,r,status=status)
        if final and data['status']=='completed':require(db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',(r['id'],)).fetchone() is None,'host_new_instructions_read_before_final',409)
        self.emit(db,binding['thread_id'],'assistant_message',{'item_id':data['reply_id'],'text':data['text'],'provider':PROVIDER,'request_id':r['id'],'source':'bound_project_host_reply','session_id':binding['spec']['session_id']})
        if final:
            db.execute('UPDATE host_requests SET phase=?,finished_at=? WHERE id=?',(status,stamp(),r['id']))
            db.execute("UPDATE threads SET status=?,active_turn=NULL,updated_at=? WHERE id=? AND active_turn=?",('host_paused' if not binding['enabled'] else 'idle' if status=='completed' else 'interrupted' if status=='cancelled' else 'error',stamp(),binding['thread_id'],r['id']))
            self.emit(db,binding['thread_id'],'host_result',{'request_id':r['id'],'status':status,'model_source':'operator_bound_ChatGPT_Web','independent_acceptance':False})
            parent=db.execute('SELECT parent_thread_id,parent_request_id FROM host_delegations WHERE child_request_id=?',(r['id'],)).fetchone()
            if parent:self.emit(db,parent['parent_thread_id'],'host_child_result',{'request_id':parent['parent_request_id'],'child_request_id':r['id'],'child_thread_id':binding['thread_id'],'status':status,'parent_completed':False})
        result={'request_id':r['id'],'reply_id':data['reply_id'],'phase':status,'thread_id':binding['thread_id'],'source':'project_host_receipt'}
        db.execute('INSERT INTO host_replies VALUES(?,?,?,?)',(data['reply_id'],r['id'],fp,canonical(result)));return result
    def browser_claim(self,db,binding,r,attempt_id,git_probe=None):
        """A confirmed UI Send becomes the original request claim.

        The browser capability never chooses a request or claim id; both are
        derived from the already-authorized attempt inside the Host journal.
        """
        self.team.claim_gate(db,r,git_probe=git_probe)
        require(not self.collaboration.busy(db,binding['thread_id'],git_probe=git_probe,
                                            held_request_id=r['id']),'host_checkout_execution_busy',409)
        if r['phase']=='processing':
            require(r['claim_id'],'host_processing_claim_missing',409)
            return r['claim_id']
        if r['phase']=='suspended':
            require(r['claim_id'] and self.team.can_resume(db,r),'host_children_still_pending',409)
            db.execute("UPDATE host_requests SET phase='processing' WHERE id=?",(r['id'],))
            db.execute("UPDATE threads SET status='processing',active_turn=?,updated_at=? WHERE id=?",
                       (r['id'],stamp(),binding['thread_id']))
            self.emit(db,binding['thread_id'],'host_parent_resumed',
                      {'request_id':r['id'],'original_claim':True,'source':'bound_browser_carrier'})
            r['phase']='processing'
            return r['claim_id']
        require(r['phase']=='queued' and not r['cancel_requested'],'host_request_not_runnable',409)
        claim='clw-browser-claim-'+attempt_id.removeprefix('control_')
        self.identifier(claim)
        db.execute("UPDATE host_requests SET phase='processing',claim_id=? WHERE id=?",(claim,r['id']))
        db.execute("UPDATE threads SET status='processing',active_turn=?,updated_at=? WHERE id=?",
                   (r['id'],stamp(),binding['thread_id']))
        self.emit(db,binding['thread_id'],'host_claimed',
                  {'request_id':r['id'],'source':'bound_browser_public_receiver'})
        r.update(phase='processing',claim_id=claim)
        return claim

    def browser_reply(self,db,binding,r,claim,attempt_id,text,turn_hash):
        """Commit one new PUBLIC assistant reply to the original request."""
        if r['phase']=='suspended':
            # Ending a model turn after wait() is NOT ending the business task.
            # Store an idempotent turn receipt, leaving the original claim and
            # child dependencies intact for event-driven continuation.
            require(r['claim_id']==claim,'host_claim_not_current',409)
            reply_id='clw-browser-reply-'+attempt_id.removeprefix('control_')
            fingerprint=hashlib.sha256(canonical({'text':text,'turn_hash':turn_hash,'request_id':r['id']}).encode()).hexdigest()
            previous=db.execute('SELECT * FROM host_replies WHERE id=?',(reply_id,)).fetchone()
            if previous:
                require(previous['fingerprint']==fingerprint,'host_reply_conflict',409)
                return json.loads(previous['response'])
            result={'request_id':r['id'],'reply_id':reply_id,'phase':'yielded',
                    'thread_id':binding['thread_id'],'source':'bound_browser_public_reply'}
            self.emit(db,binding['thread_id'],'host_turn_yielded',
                      {'request_id':r['id'],'attempt_id':attempt_id,'text':text,
                       'public_turn_hash':turn_hash,'task_completed':False})
            db.execute('INSERT INTO host_replies VALUES(?,?,?,?)',(reply_id,r['id'],fingerprint,canonical(result)))
            return result
        require(r['phase']=='processing' and r['claim_id']==claim,'host_claim_not_current',409)
        require(not self.collaboration.outstanding(db,r['id']),'host_children_still_pending',409)
        self.team.final_gate(db,binding,r)
        require(db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',(r['id'],)).fetchone() is None,
                'host_new_instructions_read_before_final',409)
        reply_id='clw-browser-reply-'+attempt_id.removeprefix('control_')
        self.identifier(reply_id)
        payload={'request_id':r['id'],'reply_id':reply_id,'phase':'completed',
                 'thread_id':binding['thread_id'],'source':'bound_browser_public_reply'}
        fingerprint=hashlib.sha256(canonical({'text':text,'turn_hash':turn_hash,'request_id':r['id']}).encode()).hexdigest()
        previous=db.execute('SELECT * FROM host_replies WHERE id=?',(reply_id,)).fetchone()
        if previous:
            require(previous['fingerprint']==fingerprint,'host_reply_conflict',409)
            return json.loads(previous['response'])
        self.emit(db,binding['thread_id'],'assistant_message',
                  {'item_id':reply_id,'text':text,'provider':PROVIDER,'request_id':r['id'],
                   'source':'bound_browser_public_reply','session_id':binding['spec'].get('session_id'),
                   'public_turn_hash':turn_hash})
        db.execute("UPDATE host_requests SET phase='completed',finished_at=? WHERE id=?",(stamp(),r['id']))
        db.execute("UPDATE threads SET status=?,active_turn=NULL,updated_at=? WHERE id=? AND active_turn=?",
                   ('host_paused' if not binding['enabled'] else 'idle',stamp(),binding['thread_id'],r['id']))
        self.emit(db,binding['thread_id'],'host_result',
                  {'request_id':r['id'],'status':'completed','model_source':'operator_bound_ChatGPT_Web',
                   'independent_acceptance':False,'browser_public_reply':True})
        parent=db.execute('SELECT parent_thread_id,parent_request_id FROM host_delegations WHERE child_request_id=?',
                          (r['id'],)).fetchone()
        if parent:self.emit(db,parent['parent_thread_id'],'host_child_result',
                            {'request_id':parent['parent_request_id'],'child_request_id':r['id'],
                             'child_thread_id':binding['thread_id'],'status':'completed','parent_completed':False})
        db.execute('INSERT INTO host_replies VALUES(?,?,?,?)',(reply_id,r['id'],fingerprint,canonical(payload)))
        return payload

    def register(self,spec,confirm):
        require(confirm is True,'host_explicit_pairing_required',403)
        native='mcp-host/'+spec['session_id']
        row=self.state.by_native(native)
        if row:require(row['provider']==PROVIDER,'host_identity_collision',409)
        else:row=self.state.bind(native,host_title(spec['title']),self.root,provider=PROVIDER)
        with closing(self.state.connect()) as db:
            old=db.execute('SELECT * FROM host_bindings WHERE target_id=?',(spec['id'],)).fetchone()
            if old:
                require(old['thread_id']==row['id'] and json.loads(old['spec'])==spec,'host_binding_conflict',409)
            else:
                db.execute('INSERT INTO host_bindings(target_id,thread_id,spec,enabled) VALUES(?,?,?,1)',(spec['id'],row['id'],canonical(spec)))
                self.emit(db,row['id'],'host_bound',{'session_id':spec['session_id'],'source':'user_authorized_project_tool_pairing','native_conversation_authority_changed':False,'history_mirror':False})
                db.commit()
        return {'thread':row,'target_id':spec['id'],'registered':True,'new_native_agent':False,'automatic_resume_verified':False}
    def public_branch_state(self, thread):
        with closing(self.state.connect()) as db:
            binding=self.binding(db,thread=thread)
            request=db.execute('SELECT id,phase,cancel_requested FROM host_requests WHERE thread_id=? ORDER BY created_at DESC LIMIT 1',(thread,)).fetchone()
            children=self.collaboration.action(db,binding,{'action':'branches'})
            results=self.collaboration.results(db,request['id']) if request else {'children':[],'pending_children':0}
            return {'children':children['children'],'request':dict(request) if request else None,'results':results,'native_browser_fork':False,'same_checkout_writers':'serialized'}

    def project_request(self,binding,r):
        return {'format':'clw.host.request.v1','request_id':r['id'],'thread_id':r['thread_id'],'store_id':self.state.id,'text':r['text'],'phase':r['phase'],'cancel_requested':bool(r['cancel_requested']),'project':binding['spec']['project'],'session_id':binding['spec']['session_id'],'root':str(self.root),'target_id':binding['target_id'],'execution_context':self.team.scopes.execution_context_from_thread(binding['thread_id']),'run_state':self.team.request_run_state(r['id']),'source':'local_operator_request_not_new_project_authority','guide':'docs/harness/HOST_RECEIVER.md',**self.collaboration.request_details(r['id'])}
    def snapshot(self):
        with closing(self.state.connect()) as db:rows=db.execute('SELECT target_id,thread_id,enabled,wait_until,spec FROM host_bindings').fetchall()
        return {'provider':PROVIDER,'protocol':'authorized_project_job_terminal_host','bindings':[{'target_id':r['target_id'],'thread_id':r['thread_id'],'enabled':bool(r['enabled']),'waiter_recent':r['wait_until']>=self.clock(),'session_id':json.loads(r['spec'])['session_id'],'parent_target_id':json.loads(r['spec']).get('parent_target_id')} for r in rows],
                'native_communication_access_changed':False,'private_endpoint_is_browser_accessible':False,'automatic_fork':False,'native_interrupt':False,'account_authentication':False}
    def send(self,thread,text,request_id):
        require(isinstance(text,str) and 0<len(text.strip())<=131072,'invalid_message')
        git_probe=self.team.scopes.preflight_native_git(thread)
        with self.lock,closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            b=self.binding(db,thread=thread);require(b['enabled'],'host_paused',409)
            direct=b['spec'].get('conversation_mode')=='direct'
            row=self.state.thread(thread)
            require(row['status'] not in BUSY,'host_work_pending_or_unreconciled',409)
            current_scope=self.team.scopes.scope(db,thread)
            if current_scope is None and not direct:
                require(not any(t['id']!=thread and t['status'] in BUSY for t in self.state.listing()),'workspace_busy_or_unreconciled',409)
            elif current_scope is not None:
                self.team.scopes.verify(current_scope)
                blocker=self.team.scopes.native_blocker(db,current_scope,git_probe)
                if blocker is not None:
                    error=HarnessError('workspace_busy_or_unreconciled',409)
                    error.blocker=blocker
                    raise error
                require(not self.team.scopes.busy(db,thread,exclude_operation=request_id,git_probe=git_probe),'workspace_busy_or_unreconciled',409)
                for other in self.state.listing():
                    if other['id']!=thread and other['status'] in BUSY:
                        if self.managed.held_legacy(db,other['id']):continue
                        other_scope=self.team.scopes.scope(db,other['id'])
                        if other_scope is not None and other['status'] in ('waiting','waiting_children'):
                            page=db.execute("SELECT page_id,parent_target,paused FROM managed_pages WHERE thread_id=? AND phase='bound'",
                                            (other['id'],)).fetchone()
                            # Paused, quiescent continuations retain their original
                            # request without retaining an active write lease.
                            if page and self.managed.paused(db,page) and self.managed.legacy_quiet(db,other['id']):continue
                        require(other_scope is not None and not self.team.scopes.conflict(current_scope,other_scope),'workspace_busy_or_unreconciled',409)
            uncertain=db.execute("SELECT 1 FROM operations WHERE action='message.send' AND state IN ('reserved','dispatching','unknown') AND id<>?"+(' AND thread_id=?' if direct else ''),
                                 (request_id,thread) if direct else (request_id,)).fetchone()
            require(uncertain is None,'workspace_has_unresolved_send',409)
            require(db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended')",(thread,)).fetchone() is None,'host_request_unresolved',409)
            from harness_goal_control import validate_send,bind_accepted
            goal_page=validate_send(self,db,thread,text,request_id)
            import harness_next_round as next_round
            page=db.execute('SELECT * FROM managed_pages WHERE thread_id=?',(thread,)).fetchone()
            if direct:
                from harness_managed_budget import ready_to_start
                ready_to_start(db,page,self.clock())
            is_next_round=next_round.validate_send(db,page,text,request_id)
            if not is_next_round:text,is_next_round=next_round.fold_user_send(db,page,text,request_id)
            result={'operation_id':request_id,'thread_id':thread,'request_id':request_id,'state':'queued_for_web_host','model_executed':False}
            db.execute('INSERT INTO host_requests(id,thread_id,text,phase,created_at) VALUES(?,?,?,?,?)',(request_id,thread,text,'queued',stamp()))
            bind_accepted(self,db,goal_page,request_id)
            if is_next_round:next_round.accepted(db,request_id)
            db.execute("UPDATE threads SET status='waiting',active_turn=?,updated_at=? WHERE id=?",(request_id,stamp(),thread))
            self.emit(db,thread,'user_message',{'text':text,'operation_id':request_id})
            self.emit(db,thread,'host_queued',{'request_id':request_id,'waiter_recent':b['wait_until']>=self.clock(),'not_model_started':True})
            db.execute("UPDATE operations SET state='completed',response=? WHERE id=?",(canonical(result),request_id));db.commit();return result
    def pause(self,thread,enabled):
        with self.lock,closing(self.state.connect()) as db:
            b=self.binding(db,thread=thread)
            db.execute('UPDATE host_bindings SET enabled=? WHERE thread_id=?',(int(enabled),thread))
            if not enabled:
                # Keep queued inputs, admitted claims and every descendant's
                # original receipt. Disabling future admission is not cancel.
                if not db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended')",(thread,)).fetchone():db.execute("UPDATE threads SET status='host_paused',active_turn=NULL,updated_at=? WHERE id=?",(stamp(),thread))
            elif self.state.thread(thread)['status']=='host_paused':
                db.execute("UPDATE threads SET status='idle',active_turn=NULL,updated_at=? WHERE id=?",(stamp(),thread))
            self.emit(db,thread,'host_paused',{'enabled':enabled,'future_dispatch_paused':not enabled,'original_requests_retained':True,'native_execution_stopped':False});db.commit()
        return {'thread':self.state.thread(thread),'enabled':enabled,'future_dispatch_paused':not enabled,'original_requests_retained':True,'native_execution_stopped':False}
