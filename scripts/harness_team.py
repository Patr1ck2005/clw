"""Event-driven run envelopes over ORIGINAL Host requests, not a second executor.

M supplies decisions and work blocks. This module owns no LLM, browser or native
Job, never calls a provider, and never turns silence into a model failure. All
scheduling state and receipts live in the same harness SQLite journal.
"""
from __future__ import annotations
from contextlib import closing
import json,sqlite3,threading,uuid
from harness_state import require,canonical,public,stamp,HarnessError
from harness_team_common import object_fields,text,identifier,integer,names,hash_value
from harness_team_carriers import Carriers
from harness_team_scopes import Scopes
from harness_team_intake import Intakes
from harness_team_journal import RunJournal
import harness_team_attention as attention_ops
import harness_attention_reconcile
from harness_run_limits import deadline_live,sends_available,migrate_runs
from harness_team_maintenance import Maintenance

FIELDS={'team':{'op','operation_id','payload'}}
READS={'status','context','result','snapshot','intake'}
OPS=READS|{'invite','revoke','recover-enroll','enroll','workspace','open','assign','wait','checkpoint','pause','resume','close','import-context','settle-attention','quiesce','resume-maintenance','verify-maintenance-idle','reconcile-attention'}
TERMINAL={'completed','blocked','cancelled'}

class TeamRuntime:
    def __init__(self,host):
        self.host,self.state=host,host.state
        self.changed=threading.Event();self.stop=threading.Event();self.thread=None;self._settling_dependencies=False
        self.carriers=Carriers(self);self.scopes=Scopes(self);self.intakes=Intakes(self);self.journal=RunJournal(self)
        self.maintenance=Maintenance(self)
        with closing(self.state.connect()) as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS host_team_receipts(
              operation_id TEXT PRIMARY KEY,actor TEXT NOT NULL,operation TEXT NOT NULL,
              fingerprint TEXT NOT NULL,response TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS host_runs(
              id TEXT PRIMARY KEY,controller_thread TEXT NOT NULL,controller_request TEXT NOT NULL UNIQUE,
              goal_ref TEXT NOT NULL,constraints_text TEXT NOT NULL,state TEXT NOT NULL,
              deadline REAL,max_dispatches INTEGER,max_parallel INTEGER NOT NULL,
              dispatches INTEGER NOT NULL DEFAULT 0,final_granted INTEGER NOT NULL DEFAULT 0,
              revision INTEGER NOT NULL DEFAULT 1,wait_mode TEXT NOT NULL DEFAULT 'all',
              after_seq INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL,reason TEXT NOT NULL DEFAULT '');
            CREATE TABLE IF NOT EXISTS host_team_work(
              request_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,dependencies TEXT NOT NULL,
              resources TEXT NOT NULL,scope_fingerprint TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS host_team_signals(
              seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,source_event INTEGER NOT NULL,
              request_id TEXT,kind TEXT NOT NULL,UNIQUE(run_id,source_event));
            CREATE INDEX IF NOT EXISTS host_team_signal_run ON host_team_signals(run_id,seq);
            CREATE TABLE IF NOT EXISTS host_team_snapshots(
              run_id TEXT NOT NULL,thread_id TEXT NOT NULL,version INTEGER NOT NULL,
              summary TEXT NOT NULL,refs TEXT NOT NULL,basis_seq INTEGER NOT NULL,hash TEXT NOT NULL,
              PRIMARY KEY(run_id,thread_id,version));
            CREATE TABLE IF NOT EXISTS host_team_reads(
              run_id TEXT NOT NULL,controller_thread TEXT NOT NULL,request_id TEXT NOT NULL,
              result_hash TEXT NOT NULL,PRIMARY KEY(run_id,controller_thread,request_id));
            CREATE TABLE IF NOT EXISTS host_team_dispatches(
              attempt_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,request_id TEXT NOT NULL,
              is_final INTEGER NOT NULL,at REAL NOT NULL);
            ''')
            migrate_runs(db)
            self.carriers.schema(db);self.scopes.schema(db);self.intakes.schema(db);self.journal.schema(db);self.maintenance.schema(db);db.commit()
    def start(self):
        if self.thread:return
        def loop():
            while not self.stop.is_set():
                self.changed.clear()
                try:
                    self.tick()
                    with closing(self.state.connect()) as db:
                        row=db.execute("SELECT MIN(deadline) FROM host_runs WHERE state='running' AND id NOT IN (SELECT run_id FROM host_team_maintenance WHERE state IN ('holding','settled'))").fetchone()
                    delay=max(.05,min(60.,row[0]-self.host.clock())) if row and row[0] is not None else 5.
                except (OSError,sqlite3.Error,HarnessError):delay=5.
                self.changed.wait(delay)
        self.thread=threading.Thread(target=loop,name='clw-run-deadlines-no-model',daemon=True);self.thread.start()
    def close(self):
        self.stop.set();self.changed.set()
        if self.thread and self.thread is not threading.current_thread():self.thread.join(timeout=5)
    def on_event(self,db,thread,kind,data,event_seq):
        if kind not in {'host_result','host_cancel_requested','host_user_note','managed_pages_settled','host_turn_attention'}:return
        request=data.get('request_id')
        run=self.run_for_request(db,request)
        if not run:return
        if kind=='host_result':self.scopes.release(db,request)
        if request==run['controller_request'] and kind=='host_result':
            # An ordinary reply can end the envelope only after the same Host
            # pending-child checks have succeeded; it is not scientific acceptance.
            db.execute("UPDATE host_runs SET state='closed',revision=revision+1 WHERE id=?",(run['id'],))
        else:
            db.execute('INSERT OR IGNORE INTO host_team_signals(run_id,source_event,request_id,kind) VALUES(?,?,?,?)',(run['id'],event_seq,request,kind))
        if kind in ('host_result','host_cancel_requested'):self.settle_dependencies(db,run['id'])
        self.changed.set()
    def run_for_request(self,db,request):
        if not request:return None
        row=db.execute('SELECT * FROM host_runs WHERE controller_request=?',(request,)).fetchone()
        if not row:row=db.execute('SELECT r.* FROM host_runs r JOIN host_team_work w ON w.run_id=r.id WHERE w.request_id=?',(request,)).fetchone()
        return dict(row) if row else None
    def request_run_state(self,request):
        with closing(self.state.connect()) as db:
            run=self.run_for_request(db,request)
            return self.public_run(run) if run else None
    def owned(self,db,actor,run_id,controller=True):
        identifier(run_id);run=db.execute('SELECT * FROM host_runs WHERE id=?',(run_id,)).fetchone()
        require(run,'team_run_missing',404);run=dict(run)
        if run['controller_thread']!=actor['thread_id']:
            require(not controller and db.execute('SELECT 1 FROM host_team_work w JOIN host_requests q ON q.id=w.request_id WHERE w.run_id=? AND q.thread_id=?',(run_id,actor['thread_id'])).fetchone(),'team_run_not_owned',403)
        return run
    def controller_request(self,db,actor,run,claim,processing=True):
        r=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',(run['controller_request'],actor['thread_id'])).fetchone()
        require(r and r['claim_id']==claim and not r['cancel_requested'],'team_original_controller_claim_required',409)
        require(not processing or r['phase']=='processing','team_controller_not_processing',409)
        return dict(r)
    def signal(self,db,run,kind,request=None):
        self.host.emit(db,run['controller_thread'],kind,{'run_id':run['id'],'request_id':request,'model_called':False})
        seq=db.execute('SELECT MAX(seq) FROM events').fetchone()[0]
        db.execute('INSERT OR IGNORE INTO host_team_signals(run_id,source_event,request_id,kind) VALUES(?,?,?,?)',(run['id'],seq,request,kind));self.changed.set()
    def drain(self,db,run,reason):
        if run['state']!='running':return
        db.execute("UPDATE host_runs SET state='draining',reason=?,revision=revision+1 WHERE id=?",(reason,run['id']))
        # Cancel only undispatched queued work. At-most-once unknown requests and
        # already running long turns retain their original states and leases.
        rows=db.execute("SELECT q.* FROM host_requests q JOIN host_team_work w ON w.request_id=q.id WHERE w.run_id=? AND q.phase='queued'",(run['id'],)).fetchall()
        for q in rows:
            sent=db.execute("SELECT 1 FROM control_attempts WHERE request_id=? AND state IN ('dispatching','sent','unknown','acknowledged')",(q['id'],)).fetchone()
            if sent:continue
            db.execute("UPDATE host_requests SET phase='cancelled',cancel_requested=1,finished_at=? WHERE id=?",(stamp(),q['id']))
            db.execute("UPDATE threads SET status='idle',active_turn=NULL,updated_at=? WHERE id=? AND active_turn=?",(stamp(),q['thread_id'],q['id']))
            self.host.emit(db,q['thread_id'],'host_result',{'request_id':q['id'],'status':'cancelled','reason':reason,'model_started':False})
        self.signal(db,run,'team_draining')
    @staticmethod
    def has_unsettled_dispatch(db,request):
        return bool(db.execute("SELECT 1 FROM control_attempts WHERE request_id=? AND state IN ('dispatching','sent','unknown') LIMIT 1",(request,)).fetchone())
    def settle_dependencies(self,db,run_id):
        if self._settling_dependencies:return
        self._settling_dependencies=True
        try:
            rows=db.execute('SELECT w.request_id,w.dependencies,q.thread_id,q.phase FROM host_team_work w JOIN host_requests q ON q.id=w.request_id WHERE w.run_id=?',(run_id,)).fetchall()
            by_id={r['request_id']:dict(r) for r in rows};followers={}
            for row in rows:
                for dep in json.loads(row['dependencies']):followers.setdefault(dep,[]).append(row['request_id'])
            queue=[r['request_id'] for r in rows if r['phase'] in ('blocked','cancelled')]
            seen=set()
            while queue:
                failed=queue.pop()
                if failed in seen:continue
                seen.add(failed)
                for key in followers.get(failed,[]):
                    child=by_id[key]
                    if child['phase']!='queued' or self.has_unsettled_dispatch(db,key):continue
                    db.execute("UPDATE host_requests SET phase='blocked',finished_at=? WHERE id=? AND phase='queued'",(stamp(),key))
                    child['phase']='blocked';queue.append(key)
                    db.execute("UPDATE threads SET status='error',active_turn=NULL,updated_at=? WHERE id=? AND active_turn=?",(stamp(),child['thread_id'],key))
                    self.host.emit(db,child['thread_id'],'host_result',{'request_id':key,'status':'blocked','reason':'dependency_not_completed','dependency_request':failed,'model_started':False,'independent_acceptance':False})
        finally:self._settling_dependencies=False
    def tick(self):
        with self.host.lock,closing(self.state.connect()) as db:
            if self.host.maintenance_exit_fence is not None:return
            db.execute('BEGIN IMMEDIATE')
            for raw in db.execute("SELECT * FROM host_runs WHERE state='running' AND deadline<=?",(self.host.clock(),)).fetchall():
                if self.maintenance.held(db,raw['id']):continue
                # Deadline preserves in-flight originals; it never certifies stop.
                self.drain(db,dict(raw),'deadline')
            for row in db.execute("SELECT run_id FROM host_team_maintenance WHERE state='holding'").fetchall():self.maintenance.reconcile(db,row['run_id'])
            db.commit()
    def ready(self,db,r):
        """None means legacy request; otherwise apply ONLY this run's gates."""
        run=self.run_for_request(db,r['id'])
        if not run:return None
        if self.maintenance.held(db,run['id']):return False
        if r['cancel_requested'] or run['state'] in ('paused','closed'):return False
        if not deadline_live(run,self.host.clock()) and run['state']=='running':return False
        b=self.host.binding(db,thread=r['thread_id'])
        if not self.carriers.projection(db,b)['runnable']:return False
        if r['id']==run['controller_request']:
            if r['phase']!='suspended':return r['phase'] in ('queued','processing')
            pending=self.host.collaboration.outstanding(db,r['id'])
            if run['state']=='draining':return not pending and not run['final_granted']
            return self.journal.wait_ready(db,run,run['wait_mode'],run['after_seq'])
        if run['state']!='running':return False
        held=db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(r['id'],)).fetchone()
        slots=db.execute('SELECT COUNT(*) FROM host_team_leases WHERE run_id=? AND thread_id<>?',(run['id'],run['controller_thread'])).fetchone()[0]
        if run['max_parallel'] and not held and slots>=run['max_parallel']:return False
        w=db.execute('SELECT * FROM host_team_work WHERE request_id=?',(r['id'],)).fetchone()
        if not w:return False
        scope=self.scopes.scope(db,r['thread_id'])
        if not scope or scope['fingerprint']!=w['scope_fingerprint']:return False
        for dep in json.loads(w['dependencies']):
            row=db.execute('SELECT phase FROM host_requests WHERE id=?',(dep,)).fetchone()
            if not row or row['phase']!='completed':return False
        return True
    def committed_receipt(self,db,r):
        epoch=self.host.control.epoch(db,r)
        return bool(db.execute("SELECT 1 FROM host_team_dispatches d JOIN control_attempts a ON a.id=d.attempt_id WHERE d.request_id=? AND a.epoch=? AND a.state IN ('dispatching','sent','unknown','acknowledged')",(r['id'],epoch)).fetchone())
    def can_resume(self,db,r):
        run=self.run_for_request(db,r['id'])
        if run and self.maintenance.held(db,run['id']):return False
        ready=self.ready(db,r)
        return (ready or self.committed_receipt(db,r)) if ready is not None else not self.host.collaboration.outstanding(db,r['id'])
    def claim_gate(self,db,r,git_probe=None):
        run=self.run_for_request(db,r['id'])
        if not run:return
        require(not r['cancel_requested'] and (self.ready(db,r) is True or self.committed_receipt(db,r)),'team_request_not_runnable',409)
        # An already committed send retains its lease through expiry/pause. Its
        # receiver may continue its original authorized local work and receipts.
        # A future hold blocks new browser turns/assignments, not that accepted
        # package. Independent stop, scope and lease checks still apply; no extra
        # budget is granted.
        self.scopes.reserve(db,run,r,git_probe=git_probe)
    def final_gate(self,db,b,r,status=None):
        run=self.run_for_request(db,r['id'])
        if not run or r['id']!=run['controller_request']:return
        if run['state']=='closed' and run['reason']=='operator_reconciled_blocked':
            require(status=='blocked','team_audited_failure_not_success',409)
            return
        latest=db.execute('SELECT COALESCE(MAX(seq),0) FROM host_team_signals WHERE run_id=?',(run['id'],)).fetchone()[0]
        self.require_results_read(db,b,run,latest)
    def before_dispatch(self,db,r,attempt,git_probe=None):
        run=self.run_for_request(db,r['id'])
        if not run:return None
        if self.maintenance.held(db,run['id']):return 'team_maintenance_no_new_dispatch'
        prior=db.execute('SELECT * FROM host_team_dispatches WHERE attempt_id=?',(attempt,)).fetchone()
        if prior:return 'team_dispatch_already_counted_no_replay'
        if run['state']=='running' and (not deadline_live(run,self.host.clock()) or not sends_available(run,1,1)):
            self.drain(db,run,'deadline' if not deadline_live(run,self.host.clock()) else 'turn_budget');run=self.run_for_request(db,r['id'])
        final=run['state']=='draining' and r['id']==run['controller_request'] and not self.host.collaboration.outstanding(db,r['id'])
        if run['state'] not in ('running','draining') or (run['state']=='draining' and not final):return 'team_run_not_dispatching'
        if not sends_available(run) or (final and run['final_granted']):return 'team_turn_budget_exhausted'
        try:self.scopes.reserve(db,run,r,git_probe=git_probe)
        except HarnessError as exc:
            if exc.code in {'team_workspace_or_resource_busy','team_parallel_budget'}:return exc.code
            raise
        db.execute('INSERT INTO host_team_dispatches VALUES(?,?,?,?,?)',(attempt,run['id'],r['id'],int(final),self.host.clock()))
        db.execute('UPDATE host_runs SET dispatches=dispatches+1,final_granted=MAX(final_granted,?),revision=revision+1 WHERE id=?',(int(final),run['id']))
        return None
    def handle(self,actor,data,operator=False):
        require(data.get('op')!='verify-maintenance-idle' or operator,'team_maintenance_operator_audit_required',403)
        require(data.get('op')!='reconcile-attention' or operator,'team_attention_operator_audit_required',403)
        op=data['op'];require(op in OPS,'team_unknown_operation')
        key=data['operation_id'];self.host.identifier(key);payload=data['payload'];require(isinstance(payload,dict),'team_payload_fields')
        who=actor['spec']['session_id'];fp=hash_value({'op':op,'actor':who,'payload':payload})
        git_probe=self.scopes.preflight_native_git(actor['thread_id']) if op=='open' else None
        with self.host.lock,closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            if op not in READS:
                prior=db.execute('SELECT * FROM host_team_receipts WHERE operation_id=?',(key,)).fetchone()
                if prior:
                    require(prior['fingerprint']==fp and prior['actor']==who,'team_operation_conflict',409)
                    return json.loads(prior['response'])
                if hasattr(self.host,'managed'):
                    require(not db.execute("SELECT 1 FROM managed_handoffs WHERE source_thread=? AND state='active'",(actor['thread_id'],)).fetchone(),'managed_handoff_source_read_only',409)
            if op=='invite':result=self.carriers.invite(db,actor,payload)
            elif op=='revoke':result=self.carriers.revoke(db,actor,payload)
            elif op=='recover-enroll':result=self.carriers.recover(db,actor,payload)
            elif op=='workspace':result=self.scopes.grant(db,actor,payload)
            elif op=='import-context':result=self.intakes.save(db,actor,payload)
            elif op=='intake':result=self.intakes.read(db,actor,payload)
            elif op=='status':result=self.status(db,actor)
            elif op=='open':result=self.open(db,actor,payload,git_probe=git_probe)
            elif op=='assign':result=self.assign(db,actor,payload,key)
            elif op=='context':result=self.context(db,actor,payload)
            elif op=='result':result=self.journal.result(db,actor,payload)
            elif op=='settle-attention':result=attention_ops.settle(self,db,actor,payload)
            elif op=='reconcile-attention':result=harness_attention_reconcile.reconcile(self,db,actor,payload)
            elif op=='quiesce':result=self.maintenance.request(db,actor,payload)
            elif op=='resume-maintenance':result=self.maintenance.resume(db,actor,payload)
            elif op=='verify-maintenance-idle':result=self.maintenance.confirm_execution_idle(db,actor,payload)
            elif op=='snapshot':result=self.snapshot(db,actor,payload)
            elif op=='wait':result=self.wait(db,actor,payload)
            elif op=='checkpoint':result=self.checkpoint(db,actor,payload)
            elif op in ('pause','resume','close'):result=self.lifecycle(db,actor,op,payload)
            else:raise HarnessError('team_enroll_uses_original_invitation',403)
            if op not in READS:db.execute('INSERT INTO host_team_receipts VALUES(?,?,?,?,?)',(key,who,op,fp,canonical(result)))
            db.commit();self.changed.set();return result
    def enroll(self,data):
        self.host.identifier(data['operation_id']);who=data['session_id'];p=data['payload'];target=data['target_id']
        fp=hash_value({'op':'enroll','actor':who,'target':target,'payload':p})
        with self.host.lock,closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            prev=db.execute('SELECT * FROM host_team_receipts WHERE operation_id=?',(data['operation_id'],)).fetchone()
            if prev:
                require(prev['fingerprint']==fp,'team_operation_conflict',409);return json.loads(prev['response'])
            result=self.carriers.enroll(db,target,who,p)
            db.execute('INSERT INTO host_team_receipts VALUES(?,?,?,?,?)',(data['operation_id'],who,'enroll',fp,canonical(result)))
            db.commit();return result
    def status(self,db,actor):
        carriers=[]
        for row in db.execute('SELECT target_id FROM host_bindings WHERE thread_id=? OR target_id IN (SELECT target_id FROM host_branches WHERE parent_target_id=?) ORDER BY target_id LIMIT 128',(actor['thread_id'],actor['target_id'])):
            b=self.host.binding(db,target=row['target_id'])
            carriers.append({'target_id':b['target_id'],'title':b['spec']['title'],**self.carriers.projection(db,b)})
        runs=[self.public_run(dict(r)) for r in db.execute('SELECT * FROM host_runs WHERE controller_thread=? ORDER BY created DESC LIMIT 64',(actor['thread_id'],))]
        return {'carriers':carriers,'runs':runs,'model_calls':0,'meaning':'retained_control_metadata_not_inference_status'}
    def completed_public_receipt(self,key):
        # Recover a committed same-DB result if the UI connection died between
        # the team transaction and the outer operations receipt. Never execute.
        with closing(self.state.connect()) as db:
            row=db.execute("SELECT t.response FROM host_team_receipts t JOIN operations o ON o.id=t.operation_id WHERE o.id=? AND o.action='team.'||t.operation",(key,)).fetchone()
        return {'operation_id':key,'state':'completed',**json.loads(row['response'])} if row else None
    def public_status(self):
        with closing(self.state.connect()) as db:
            carriers=[]
            for row in db.execute('SELECT target_id FROM host_bindings ORDER BY target_id LIMIT 128'):
                b=self.host.binding(db,target=row['target_id'])
                pending_recovery=bool(db.execute("SELECT 1 FROM host_carrier_invites WHERE target_id=? AND state='pending' AND allow_rebind=1 LIMIT 1",(b['target_id'],)).fetchone())
                carriers.append({'thread_id':b['thread_id'],'title':b['spec']['title'],'recovery_pending':pending_recovery,**self.carriers.projection(db,b)})
            runs=[self.public_run(dict(r)) for r in db.execute('SELECT * FROM host_runs ORDER BY created DESC LIMIT 64')]
            for run in runs:
                row=db.execute('SELECT controller_thread FROM host_runs WHERE id=?',(run['id'],)).fetchone()
                run['controller_thread']=row['controller_thread']
                run['maintenance']=self.maintenance.status(db,run['id'])
            return {'carriers':carriers,'runs':runs,'scope':'registered_connections_only_not_all_browser_chats','default_enabled':False}
    def public_command(self,thread,key,op,p):
        require(op in {'invite','revoke','recover-enroll','pause','resume','quiesce','resume-maintenance','verify-maintenance-idle','reconcile-attention'},'team_panel_operation_not_allowed',403)
        require(isinstance(p,dict) and p.get('confirm') is True,'team_panel_confirmation_required',403)
        p=dict(p);p.pop('confirm')
        with closing(self.state.connect()) as db:
            actor=self.host.binding(db,thread=thread)
            if op=='invite':
                existing=p.pop('existing_thread_id',None)
                if existing:p['target']=self.host.binding(db,thread=existing)['target_id']
                else:p['target']='web-'+hash_value({'operation_id':key})[:20]
            if op=='recover-enroll':
                existing=p.pop('existing_thread_id',None);require(existing,'team_recovery_target_required',403)
                target=self.host.binding(db,thread=existing)
                rows=db.execute("SELECT id FROM host_carrier_invites WHERE target_id=? AND inviter_thread=? AND state='pending' AND allow_rebind=1 ORDER BY expires DESC LIMIT 2",(target['target_id'],actor['thread_id'])).fetchall()
                require(len(rows)==1,'team_recovery_pending_invitation_not_unique',409)
                p['invitation_id']=rows[0]['id'];p['runtime_project']=target['spec']['project'];p['confirm']=True
            if op=='resume':p['confirm']=True
        return self.handle(actor,{'op':op,'operation_id':key,'payload':p},operator=True)
    @staticmethod
    def public_run(r):
        return {k:r[k] for k in ('id','controller_request','goal_ref','state','deadline','max_dispatches','max_parallel','dispatches','final_granted','revision','reason')}
    def open(self,db,actor,p,git_probe=None,*,accepted_attempt=None):
        object_fields(p,{'request_id','claim_id','goal_ref','constraints'},{'intake_id','duration_seconds','max_dispatches','max_parallel'})
        p={**{'duration_seconds':None,'max_dispatches':None,'max_parallel':0},**p}
        self.host.identifier(p['request_id']);self.host.identifier(p['claim_id'])
        if p['duration_seconds'] is not None:integer(p['duration_seconds'],1,604800)
        if p['max_dispatches'] is not None:integer(p['max_dispatches'],2,10000)
        integer(p['max_parallel'],0,2**53-1)
        text(p['goal_ref'],'goal_ref',512);text(p['constraints'],'constraints',12000)
        q=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',(p['request_id'],actor['thread_id'])).fetchone()
        require(q and q['phase']=='processing' and q['claim_id']==p['claim_id'] and not q['cancel_requested'],'team_original_controller_claim_required',409)
        require(not db.execute('SELECT 1 FROM host_team_work WHERE request_id=?',(q['id'],)).fetchone(),'team_nested_run_requires_shared_parent_budget',409)
        carrier=self.carriers.projection(db,actor)
        accepted=False
        if accepted_attempt is not None:
            # Internal receipt path only. A unique tool echo can arrive after an
            # operator future hold; it cannot create a different Send or grant.
            page=db.execute("SELECT * FROM managed_pages WHERE thread_id=? AND phase='bound'",(actor['thread_id'],)).fetchone()
            receipt=db.execute("SELECT a.request_id,a.thread_id,a.state,r.claim_id FROM control_attempts a JOIN managed_dispatches d ON d.attempt_id=a.id JOIN managed_tool_received t ON t.attempt_id=a.id JOIN control_browser_receipts r ON r.attempt_id=a.id WHERE a.id=?",(accepted_attempt,)).fetchone()
            origin=self.host.managed.pause_origin(db,page) if page else None
            native=db.execute('SELECT native_id FROM threads WHERE id=?',(actor['thread_id'],)).fetchone()
            accepted=bool(page and receipt and receipt['request_id']==q['id'] and receipt['thread_id']==actor['thread_id'] and receipt['state']=='acknowledged' and receipt['claim_id']==q['claim_id'] and
                          native and native['native_id']=='mcp-host/'+actor['spec']['session_id'] and page['target_id']==actor['target_id'] and page['url'] and
                          carrier['physical_conversation_bound'] and carrier['receiver_confirmed'] and origin and origin['source']=='operator' and self.host.managed.receipt_collection_allowed(db,page))
        require(carrier['runnable'] or accepted,'team_controller_carrier_unverified',409)
        self.scopes.verify(self.scopes.scope(db,actor['thread_id']))
        require(not db.execute('SELECT 1 FROM host_runs WHERE controller_request=?',(q['id'],)).fetchone(),'team_original_run_exists',409)
        require(not db.execute("SELECT 1 FROM host_runs WHERE controller_thread=? AND state<>'closed'",(actor['thread_id'],)).fetchone(),'team_controller_run_in_progress',409)
        run='clw-run-'+uuid.uuid4().hex
        db.execute("INSERT INTO host_runs(id,controller_thread,controller_request,goal_ref,constraints_text,state,deadline,max_dispatches,max_parallel,created) VALUES(?,?,?,?,?,'running',?,?,?,?)",
            (run,actor['thread_id'],q['id'],p['goal_ref'],p['constraints'],self.host.clock()+p['duration_seconds'] if p['duration_seconds'] is not None else None,p['max_dispatches'],p['max_parallel'],self.host.clock()))
        if p.get('intake_id'):self.intakes.attach(db,actor,run,p['intake_id'])
        self.host.emit(db,actor['thread_id'],'team_run_opened',{'run_id':run,'request_id':q['id'],'no_new_controller':True})
        self.scopes.reserve(db,dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run,)).fetchone()),dict(q),git_probe=git_probe)
        return {'run_id':run,'request_id':q['id'],'state':'running','summary_turn_reserved':1,'dispatches':0,'operator_started_current_turn_not_counted':True}
    def assign(self,db,actor,p,key,*,prepared=False,enrollment=None):
        object_fields(p,{'run_id','claim_id','target','text','depends_on','resources'})
        run=self.owned(db,actor,p['run_id']);r=self.controller_request(db,actor,run,p['claim_id'],processing=not (prepared or enrollment))
        require(enrollment or not self.maintenance.held(db,run['id']),'team_maintenance_no_new_work',409)
        if enrollment:
            from harness_managed_first_task import received
            initial=db.execute('SELECT * FROM managed_pages WHERE page_id=? AND target_id=? AND parent_target=?',(enrollment,p['target'],actor['target_id'])).fetchone()
            require(initial and received(initial) and r['phase'] in ('processing','suspended'),'managed_first_task_parent_changed',409)
            original=json.loads(initial['settings']).get('first_task_parent',{})
            require(original.get('run_id')==run['id'] and original.get('request_id')==r['id'] and original.get('claim_id')==r['claim_id'],'managed_first_task_parent_changed',409)
            require(db.execute('SELECT 1 FROM managed_bootstrap_budget WHERE page_id=? AND run_id=?',(enrollment,run['id'])).fetchone(),
                    'managed_first_task_send_not_counted',409)
        if prepared:
            # A durable text batch may finish page enrollment after the
            # controller has yielded. Only trusted in-process reconciliation
            # uses this path; public team commands retain the processing guard.
            require(r['phase']=='suspended' and run['wait_mode']=='all',
                    'team_prepared_controller_not_waiting',409)
        # Enrollment work already spent its Send budget before obtaining the
        # real Session. Register that accepted work; claim_gate still applies
        # pause, deadline and resource rules before any project execution.
        require(enrollment or (run['state']=='running' and deadline_live(run,self.host.clock()) and sends_available(run,1,1)),'team_run_not_accepting_new_work',409)
        body=text(p['text'],'work',24000);deps=names(p['depends_on'],32);resources=names(p['resources'],32)
        b=self.carriers.may_manage(db,actor,p['target']);require(b and b['thread_id']!=actor['thread_id'],'team_direct_child_required',403)
        # Accepted first-turn enrollment registers its identity even if the
        # controller paused while it was in flight. Execution still uses the
        # separate first-task/claim gate; never roll back the real Session here.
        carrier=self.carriers.projection(db,b)
        require(b['enabled'] and (enrollment or carrier.get('queueable',carrier['runnable'])),'team_worker_carrier_unverified',409)
        s=self.scopes.scope(db,b['thread_id']);self.scopes.verify(s)
        require(set(resources)<=set(json.loads(s['resources'])),'team_resource_not_granted',403)
        require(not db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended')",(b['thread_id'],)).fetchone(),'team_worker_has_original_work',409)
        for dep in deps:require(db.execute('SELECT 1 FROM host_team_work WHERE run_id=? AND request_id=?',(run['id'],dep)).fetchone(),'team_dependency_not_in_run',409)
        child='clw-team-child-'+hash_value({'run':run['id'],'key':key})[:32];delegation='clw-team-edge-'+hash_value({'run':run['id'],'key':key})[:32];at=stamp()
        db.execute("INSERT INTO host_requests(id,thread_id,text,phase,created_at) VALUES(?,?,?,'queued',?)",(child,b['thread_id'],body,at))
        db.execute('INSERT INTO host_delegations VALUES(?,?,?,?,?,?,?,?)',(delegation,r['id'],actor['thread_id'],b['target_id'],b['thread_id'],child,hash_value(p),at))
        db.execute('INSERT INTO host_team_work VALUES(?,?,?,?,?)',(child,run['id'],canonical(deps),canonical(resources),s['fingerprint']))
        db.execute("UPDATE threads SET status='waiting',active_turn=?,updated_at=? WHERE id=?",(child,at,b['thread_id']))
        self.host.emit(db,b['thread_id'],'host_delegated_input',{'text':body,'request_id':child,'parent_request_id':r['id'],'parent_thread_id':actor['thread_id'],'run_id':run['id']})
        self.host.emit(db,actor['thread_id'],'host_delegated',{'child_request_id':child,'child_thread_id':b['thread_id'],'model_started':False})
        self.settle_dependencies(db,run['id'])
        return {'run_id':run['id'],'request_id':child,'delegation_id':delegation,'state':'queued_original_host_request','model_called':False,'execution_context':self.scopes.execution_context(db,b['thread_id'])}
    def context(self,db,actor,p):
        object_fields(p,{'run_id','after_seq'},{'work_after','snapshots_after'});integer(p['after_seq'],0,2**53-1)
        work_after=p.get('work_after',0);snapshots_after=p.get('snapshots_after',0)
        integer(work_after,0,2**53-1);integer(snapshots_after,0,2**53-1)
        run=self.owned(db,actor,p['run_id'],controller=False)
        rows=db.execute('SELECT * FROM host_team_signals WHERE run_id=? AND seq>? ORDER BY seq LIMIT 65',(run['id'],p['after_seq'])).fetchall()
        signals=[dict(x) for x in rows[:64]]
        snapshots=[dict(x) for x in db.execute('SELECT s.rowid AS cursor,s.* FROM host_team_snapshots s WHERE s.run_id=? AND s.rowid>? AND s.version=(SELECT MAX(t.version) FROM host_team_snapshots t WHERE t.run_id=s.run_id AND t.thread_id=s.thread_id) ORDER BY s.rowid LIMIT 17',(run['id'],snapshots_after))]
        more_snapshots=len(snapshots)>16;snapshots=snapshots[:16]
        snapshots=[{'cursor':s['cursor'],'thread_id':s['thread_id'],'version':s['version'],'hash':s['hash'],'basis_seq':s['basis_seq'],
                    'summary_excerpt':s['summary'][:240],'full_snapshot_requires_read':True} for s in snapshots]
        works=[]
        work_rows=db.execute('SELECT w.rowid AS cursor,w.*,q.thread_id,q.phase,b.spec FROM host_team_work w JOIN host_requests q ON q.id=w.request_id JOIN host_bindings b ON b.thread_id=q.thread_id WHERE w.run_id=? AND w.rowid>? ORDER BY w.rowid LIMIT 65',(run['id'],work_after)).fetchall()
        for w in work_rows[:64]:
            b=self.host.binding(db,thread=w['thread_id'])
            works.append({'cursor':w['cursor'],'target':b['target_id'],'request_id':w['request_id'],'phase':w['phase'],'title':b['spec']['title'],'carrier':self.carriers.projection(db,b),'depends_on':json.loads(w['dependencies']),'attention':self.journal.attention(db,w['request_id'],w['thread_id'])})
        imported=db.execute('SELECT intake_id FROM host_run_intakes WHERE run_id=?',(run['id'],)).fetchone()
        return {'run':self.public_run(run),'constraints':run['constraints_text'],'signals':signals,'has_more':len(rows)>64,
            'next_after':signals[-1]['seq'] if signals else p['after_seq'],'work':works,'work_listing_bounded':True,'snapshots':snapshots,'intake_id':imported['intake_id'] if imported else None,
            'work_has_more':len(work_rows)>64,'next_work_after':works[-1]['cursor'] if works else work_after,
            'snapshots_has_more':more_snapshots,'next_snapshots_after':snapshots[-1]['cursor'] if snapshots else snapshots_after,
            'note':'Use result for full original public reply; snapshots are author statements, not accepted conclusions.'}
    def snapshot(self,db,actor,p):
        object_fields(p,{'run_id','target','version'});integer(p['version'],0,100000)
        run=self.owned(db,actor,p['run_id'],controller=False)
        b=self.host.binding(db,target=p['target'])
        require(actor['thread_id']==run['controller_thread'] or b['thread_id']==actor['thread_id'],'team_snapshot_not_owned',403)
        row=db.execute('SELECT * FROM host_team_snapshots WHERE run_id=? AND thread_id=? AND (?=0 OR version=?) ORDER BY version DESC LIMIT 1',
                       (run['id'],b['thread_id'],p['version'],p['version'])).fetchone()
        require(row,'team_snapshot_missing',404);v=dict(row);v['references']=json.loads(v.pop('refs'))
        return {**v,'source':'author_supplied_public_snapshot_not_hidden_thought'}
    def wait(self,db,actor,p,*,browser_turn_ended=False):
        object_fields(p,{'run_id','claim_id','after_seq','mode'},{'selected_requests'});integer(p['after_seq'],0,2**53-1)
        run=self.owned(db,actor,p['run_id']);q=self.controller_request(db,actor,run,p['claim_id'])
        selected=self.journal.selection(db,run,p['mode'],p.get('selected_requests',[]),store=True)
        maximum=db.execute('SELECT COALESCE(MAX(seq),0) FROM host_team_signals WHERE run_id=?',(run['id'],)).fetchone()[0]
        require(p['after_seq']<=maximum and p['after_seq']>=run['after_seq'],'team_signal_cursor_invalid',409)
        self.require_results_read(db,actor,run,p['after_seq'])
        ready=self.journal.wait_ready(db,run,p['mode'],p['after_seq'],selected) or (p['mode']=='selected' and self.journal.selected_terminal(db,selected))
        if ready and not browser_turn_ended:
            return {'run_id':run['id'],'request_id':q['id'],'state':'events_ready_continue_same_turn','model_polling':False,'next_after':p['after_seq']}
        if run['state']=='draining' and not self.host.collaboration.outstanding(db,q['id']):
            return {'run_id':run['id'],'request_id':q['id'],'state':'summarize_in_current_turn','model_polling':False}
        db.execute('UPDATE host_runs SET after_seq=?,wait_mode=?,revision=revision+1 WHERE id=?',(p['after_seq'],p['mode'],run['id']))
        db.execute("UPDATE host_requests SET phase='suspended' WHERE id=?",(q['id'],))
        db.execute("UPDATE threads SET status='waiting_children',updated_at=? WHERE id=?",(stamp(),actor['thread_id']))
        self.scopes.release(db,q['id'])
        self.host.emit(db,actor['thread_id'],'host_waiting_children',{'request_id':q['id'],'run_id':run['id'],'wait_mode':p['mode'],'no_new_request':True})
        return {'run_id':run['id'],'request_id':q['id'],'state':'waiting_events','model_polling':False,'mode':p['mode']}
    def require_results_read(self,db,actor,run,through):
        rows=db.execute("SELECT DISTINCT request_id FROM host_team_signals WHERE run_id=? AND seq<=? AND kind='host_result'",(run['id'],through)).fetchall()
        for row in rows:
            event=db.execute("SELECT data FROM events WHERE kind='assistant_message' AND json_extract(data,'$.request_id')=? ORDER BY seq DESC LIMIT 1",(row['request_id'],)).fetchone()
            if not event:continue  # Undispatched cancellation has no fabricated reply.
            read=db.execute('SELECT result_hash FROM host_team_reads WHERE run_id=? AND controller_thread=? AND request_id=?',(run['id'],actor['thread_id'],row['request_id'])).fetchone()
            if not read and hasattr(self.host,'managed'):read=self.host.managed.handoffs.inherited_read(db,run['id'],actor['thread_id'],row['request_id'],'host_team_reads')
            require(read and read['result_hash']==hash_value(json.loads(event['data'])),'team_read_full_result_before_ack',409)
    def checkpoint(self,db,actor,p):
        object_fields(p,{'run_id','expected_version','summary','references','basis_seq'})
        run=self.owned(db,actor,p['run_id'],controller=False);integer(p['expected_version'],0,100000);integer(p['basis_seq'],0,2**53-1)
        text(p['summary'],'snapshot',16000);require(isinstance(p['references'],list) and len(p['references'])<=32,'team_reference_limit')
        refs=[text(x,'reference',2000) for x in p['references']]
        version=db.execute('SELECT COALESCE(MAX(version),0) FROM host_team_snapshots WHERE run_id=? AND thread_id=?',(run['id'],actor['thread_id'])).fetchone()[0]
        require(version==p['expected_version'],'team_snapshot_version_changed',409)
        require(version<4096,'team_snapshot_capacity',409)
        basis=db.execute('SELECT COALESCE(MAX(seq),0) FROM host_team_signals WHERE run_id=?',(run['id'],)).fetchone()[0]
        require(p['basis_seq']<=basis,'team_snapshot_future_basis',409)
        h=hash_value({'summary':p['summary'],'refs':refs,'basis_seq':p['basis_seq']})
        db.execute('INSERT INTO host_team_snapshots VALUES(?,?,?,?,?,?,?)',(run['id'],actor['thread_id'],version+1,p['summary'],canonical(refs),p['basis_seq'],h))
        return {'run_id':run['id'],'version':version+1,'hash':h,'source':'receiver_authored_snapshot_not_hidden_context','next_model_call':False}
    def lifecycle(self,db,actor,op,p):
        required={'run_id','reason'} if op=='pause' else {'run_id','expected_revision','confirm'} if op=='resume' else {'run_id','claim_id','summary','references'}
        object_fields(p,required);run=self.owned(db,actor,p['run_id'])
        if op=='pause':
            text(p['reason'],'reason',2000);require(run['state']!='closed','team_run_closed',409)
            db.execute("UPDATE host_runs SET state='paused',reason=?,revision=revision+1 WHERE id=?",(p['reason'],run['id']))
        elif op=='resume':
            require(not self.maintenance.held(db,run['id']),'team_use_resume_maintenance',409)
            require(p['confirm'] is True and type(p['expected_revision']) is int and p['expected_revision']==run['revision'],'team_run_revision_or_confirmation',409)
            require(run['state']=='paused' and deadline_live(run,self.host.clock()) and sends_available(run,1,1),'team_resume_requires_unspent_original_budget',409)
            db.execute("UPDATE host_runs SET state='running',reason='',revision=revision+1 WHERE id=?",(run['id'],))
        else:
            q=self.controller_request(db,actor,run,p['claim_id']);text(p['summary'],'summary',24000)
            require(not db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',(q['id'],)).fetchone(),'host_new_instructions_read_before_final',409)
            require(not self.host.collaboration.outstanding(db,q['id']),'team_children_still_pending',409)
            latest=db.execute('SELECT COALESCE(MAX(seq),0) FROM host_team_signals WHERE run_id=?',(run['id'],)).fetchone()[0]
            self.require_results_read(db,actor,run,latest)
            require(isinstance(p['references'],list) and len(p['references'])<=32,'team_reference_limit')
            refs=[text(x,'reference',2000) for x in p['references']]
            self.host.emit(db,actor['thread_id'],'team_final_summary',{'run_id':run['id'],'request_id':q['id'],'text':p['summary'],'references':refs,'project_acceptance':False})
            db.execute("UPDATE host_runs SET state='closed',reason='controller_summary',revision=revision+1 WHERE id=?",(run['id'],))
            self.scopes.release(db,q['id'])
        row=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run['id'],)).fetchone())
        return {**self.public_run(row),'native_model_interrupted':False,'original_requests_retained':True}
