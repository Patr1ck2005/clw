"""Original Host maintenance proof; isolated ledgers and read-only transport doubles."""
from pathlib import Path
from contextlib import closing
from types import SimpleNamespace
from unittest.mock import patch
import unittest,json,shutil,sys,uuid,hashlib,tempfile,time
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_harness_managed_attention as fixtures
from maintenance_exit_readiness import readiness,authorize_shutdown,ledger_read,job_read,ledger_revision,revision_hash,retained_request_evidence,verify_page_bindings
from harness_state import HarnessError
from harness_service import HarnessService
from live_transport import ObservationError
from harness_job_inventory import ACTIVE,UNCERTAIN

class Transport:
    client_id='fixture'
    def __init__(self,jobs=()):self.jobs=list(jobs);self.calls=[];self.hook=None;self.truncated=False;self.call_active=False;self.detail_id=None;self.detail_complete=True;self.detail_running=0
    def post(self,op,p,deadline):
        self.calls.append((op,p))
        if self.hook:self.hook(op)
        if op=='status':
            n=lambda state:sum(j['status']==state for j in self.jobs)
            return {'service':'webcodex','version':'0.4.1','focus':{'client_id':self.client_id,'connected':True},'jobs':{'active_count':sum(n(s) for s in ACTIVE),'running_count':n('running')+n('started'),'queued_count':n('queued')+n('agent_queued')}}
        if op=='detail':return {'session_id':self.detail_id or p['session_id'],'running_call':self.call_active,'running_jobs':self.detail_running,'running_jobs_complete':self.detail_complete}
        rows=[j for j in self.jobs if j['status']==p['status'] and (not p.get('project') or j['project']==p['project']) and (not p.get('session_id') or j['session_id']==p['session_id'])]
        return {'jobs':rows[:100],'count':len(rows[:100]),'matched_count':len(rows),'truncated':self.truncated or len(rows)>100}

class JobReadTests(unittest.TestCase):
    scope=('agent:fixture:owned','wc_sess_owned')
    def row(self,state,execution=None,session=None):
        return {'job_id':'original-'+state,'client_id':'fixture','project':self.scope[0],
                'session_id':session or self.scope[1],'status':state,'command_execution_state':execution}
    def read(self,transport,exit_mode='maintenance'):
        return job_read(transport,{self.scope},time.monotonic()+12,{self.scope},exit_mode=exit_mode)
    def test_all_canonical_activity_blocks_even_with_zero_console_running_jobs(self):
        for state in ACTIVE:
            with self.subTest(state=state):
                transport=Transport([self.row(state)])
                with self.assertRaisesRegex(HarnessError,'jobs_active') as raised:self.read(transport)
                self.assertEqual(raised.exception.blockers[0]['status'],state)
                self.assertEqual(raised.exception.blockers[0]['session_id'],self.scope[1])
    def test_project_capped_detail_does_not_block_an_idle_original_session(self):
        transport=Transport([{**self.row('running',session='wc_sess_elsewhere'),'job_id':str(n)} for n in range(101)])
        transport.detail_complete=False
        proof=self.read(transport)
        self.assertTrue(proof['scopedFallback']);self.assertTrue(proof['inventoryComplete'])
        self.assertTrue(any(p.get('session_id')==self.scope[1] for op,p in transport.calls if op=='jobs'))
        transport.jobs.append(self.row('recovering'))
        with self.assertRaisesRegex(HarnessError,'jobs_active'):self.read(transport)
        transport.jobs=[];transport.call_active=True
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read(transport)
    def test_terminal_unknown_commands_preserve_the_original_job_identity(self):
        for state in UNCERTAIN:
            with self.subTest(state=state):
                transport=Transport([self.row(state,'outcome_unknown')])
                with self.assertRaisesRegex(HarnessError,'jobs_unverified') as raised:self.read(transport)
                blocker=raised.exception.blockers[0]
                self.assertEqual(blocker['kind'],'owned_job_outcome_unknown');self.assertEqual(blocker['job_id'],'original-'+state)
                self.assertEqual(blocker['command_execution_state'],'outcome_unknown')
                transport.jobs=[self.row(state,'outcome_unknown',session='wc_sess_elsewhere')]
                self.assertTrue(self.read(transport)['inventoryComplete'])
    def test_capped_lost_history_is_reduced_to_the_exact_owned_session(self):
        transport=Transport([{**self.row('lost','outcome_unknown',session='wc_sess_elsewhere'),'job_id':str(n)} for n in range(101)])
        self.assertTrue(self.read(transport)['scopedFallback'])
        transport.jobs.append(self.row('lost','outcome_unknown'))
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read(transport)
    def test_known_failed_and_never_started_lost_are_idle(self):
        for row in (self.row('failed','completed'),self.row('failed','not_started'),self.row('lost','not_started')):
            with self.subTest(row=row):self.assertTrue(self.read(Transport([row]))['inventoryComplete'])
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):
            self.read(Transport([{**self.row('lost','not_started'),'started_at':1}]))
    def test_global_inventory_of_another_runner_does_not_expand_idle_owned_scope_reads(self):
        transport=Transport()
        # This is the formal visibility split: a focused runtime_status, with
        # list_jobs also exposing another authorized Runner's current Jobs.
        post=transport.post
        def visible(op,args,deadline):
            if op=='jobs' and args['status']=='recovering' and not args.get('session_id'):
                transport.calls.append((op,args))
                row={**self.row('recovering',session='wc_sess_other'),'project':'agent:other:visible','client_id':'other'}
                return {'jobs':[row],'count':1,'matched_count':1,'truncated':False}
            return post(op,args,deadline)
        transport.post=visible
        self.assertFalse(self.read(transport)['scopedFallback'])
        self.assertEqual(len(transport.calls),2+len(ACTIVE)+len(UNCERTAIN))
    def missing(self,code='not_found'):
        transport=Transport()
        def unavailable(op):
            if op=='detail':raise ObservationError(code)
        transport.hook=unavailable
        return transport
    def test_ordinary_missing_metadata_requires_exact_eight_status_queries_and_retains_diagnostic(self):
        transport=self.missing();proof=self.read(transport,'ordinary')
        self.assertEqual(proof['missingSessions'],[{'project':self.scope[0],'session_id':self.scope[1],
            'code':'not_found','businessStateRetained':True}])
        selected=[p for op,p in transport.calls if op=='jobs' and p.get('session_id')]
        self.assertEqual(selected,[{'project':self.scope[0],'session_id':self.scope[1],'status':s,'limit':100} for s in ACTIVE+UNCERTAIN])
        self.assertTrue(proof['inventoryComplete']);self.assertEqual(proof['ownedActiveJobs'],0)
    def test_missing_metadata_cannot_hide_exact_scope_activity_or_unknown_outcome_behind_global_zero(self):
        for state in ACTIVE+UNCERTAIN:
            with self.subTest(state=state):
                transport=self.missing();post=transport.post
                def exact(op,args,deadline):
                    if op=='jobs' and args.get('session_id')==self.scope[1] and args['status']==state:
                        transport.calls.append((op,args));row=self.row(state,'outcome_unknown' if state in UNCERTAIN else None)
                        return {'jobs':[row],'count':1,'matched_count':1,'truncated':False}
                    return post(op,args,deadline)
                transport.post=exact
                with self.assertRaises(HarnessError) as raised:self.read(transport,'ordinary')
                blocker=raised.exception.blockers[0]
                self.assertEqual(blocker['session_id'],self.scope[1])
                self.assertEqual(blocker.get('job_id') or blocker['job_ids'][0],'original-'+state)
    def test_missing_metadata_is_not_accepted_for_maintenance_or_for_network_access_errors(self):
        for mode,code in [('maintenance','not_found')]+[('ordinary',c) for c in ('access_denied','auth_required','upstream_timeout','upstream_unreachable','upstream_invalid')]:
            with self.subTest(mode=mode,code=code),self.assertRaises(ObservationError) as raised:
                self.read(self.missing(code),mode)
            self.assertEqual(raised.exception.code,code)
    def test_missing_session_does_not_treat_exact_job_inventory_errors_as_empty(self):
        for code in ('not_found','access_denied','auth_required','upstream_timeout','upstream_unreachable'):
            with self.subTest(code=code):
                transport=self.missing();post=transport.post
                def unavailable(op,args,deadline):
                    if op=='jobs' and args.get('session_id'):raise ObservationError(code)
                    return post(op,args,deadline)
                transport.post=unavailable
                with self.assertRaises(ObservationError) as raised:self.read(transport,'ordinary')
                self.assertEqual(raised.exception.code,code)

class MaintenanceReadinessTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.AttentionTests();self.f.setUp();self.base=self.f.f;self.s=self.base.f.s;self.h=self.s.host_bridge
        old=self.s.state.path;new=self.s.root/'.local/harness/harness.sqlite3';new.parent.mkdir(parents=True)
        with closing(self.s.state.connect()) as src,closing(__import__('sqlite3').connect(new)) as dst:src.backup(dst)
        self.s.state.path=new;self.transport=Transport();self.s.transport=self.transport
    def tearDown(self):self.f.tearDown()
    def paused_attention(self,writer=False):
        page,request,offer,ctx=self.base.start_browser_turn();run=ctx['run']['id']
        if writer:
            with closing(self.s.state.connect()) as db:
                db.execute("UPDATE host_team_scopes SET access='write',write_paths='[\".\"]' WHERE thread_id=?",(ctx['request']['thread_id'],))
                db.execute("UPDATE host_team_leases SET access='write' WHERE request_id=?",(request,));db.commit()
        self.f.finish(page,request,offer,ctx['request']['claim_id'],'needs_attention','Original saved result and original refusal retained')
        with closing(self.s.state.connect()) as db:
            for binding in db.execute('SELECT target_id,spec FROM host_bindings').fetchall():
                spec=json.loads(binding['spec']);spec['project']='agent:fixture:owned';db.execute('UPDATE host_bindings SET spec=? WHERE target_id=?',(json.dumps(spec),binding['target_id']))
            db.commit()
        self.scope=next(iter(ledger_read(self.s)['scopes'])) if not writer else None
        return page,request,offer,ctx
    def payload(self):return {'store_id':self.s.state.id,'ledger_fingerprint':revision_hash(ledger_revision(self.s.state.path)),'page_bindings':[]}
    def read(self):return readiness(self.s,self.payload())
    def manual_waiting_receivers(self):
        f=self.base.f;child=f.join();parent=f.start();delegated=f.delegate(parent);f.yield_parent(parent)
        f.command(f.parent['id'],'host.pause');f.command(child['id'],'host.pause')
        with closing(self.s.state.connect()) as db:
            for binding in db.execute('SELECT target_id,spec FROM host_bindings').fetchall():
                spec=json.loads(binding['spec']);spec['project']='agent:fixture:owned'
                db.execute('UPDATE host_bindings SET spec=? WHERE target_id=?',(json.dumps(spec),binding['target_id']))
            db.commit()
        return f.parent['id'],parent,child['id'],delegated['child_request_id']
    def scope_for(self,thread):
        with closing(self.s.state.connect()) as db:spec=json.loads(db.execute('SELECT spec FROM host_bindings WHERE thread_id=?',(thread,)).fetchone()[0])
        return spec['project'],spec['session_id']
    def closed_page_history(self,count):
        page,_,_,_=self.paused_attention()
        self.closed_history_original_scope_count=len(ledger_read(self.s)['scopes'])
        bindings=[]
        with closing(self.s.state.connect()) as db:
            db.row_factory=__import__('sqlite3').Row
            original_page=dict(db.execute('SELECT * FROM managed_pages WHERE page_id=?',(page,)).fetchone())
            original_thread=dict(db.execute('SELECT * FROM threads WHERE id=?',(original_page['thread_id'],)).fetchone())
            original_binding=dict(db.execute('SELECT * FROM host_bindings WHERE thread_id=?',(original_page['thread_id'],)).fetchone())
            rows={name:[] for name in ('threads','managed_pages','host_bindings')}
            for n in range(count):
                ident=str(n);thread='closed-history-thread-'+ident;target='closed-history-target-'+ident;page_id='closed-history-page-'+ident
                url='https://chatgpt.com/c/closed-history-'+ident
                rows['threads'].append({**original_thread,'id':thread,'native_id':'closed-history-native-'+ident,'parent_id':None,'active_turn':None,'status':'idle'})
                rows['managed_pages'].append({**original_page,'page_id':page_id,'thread_id':thread,'target_id':target,'parent_target':None,'url':url,'paused':1})
                spec=json.loads(original_binding['spec']);spec['session_id']='wc_sess_closed_history_'+ident
                rows['host_bindings'].append({**original_binding,'target_id':target,'thread_id':thread,'spec':json.dumps(spec),'enabled':0})
                bindings.append({'page_id':page_id,'thread_id':thread,'url':url,'request_id':'closed-history-request-'+ident,'request_phase':'completed','attempt_id':None})
            for table,values in rows.items():
                columns=list(values[0]);db.executemany('INSERT INTO '+table+'('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',[tuple(row[column] for column in columns) for row in values])
            db.executemany("INSERT INTO host_requests(id,thread_id,text,phase,created_at,finished_at) VALUES(?,?,?,'completed',?,?)",[
                (binding['request_id'],binding['thread_id'],'Original completed history','2026-10-06T00:00:00+00:00','2026-10-06T00:00:01+00:00') for binding in bindings]);db.commit()
        return bindings
    def test_closed_bound_descriptors_exceed_2048_without_a_lifetime_exit_gate(self):
        import subprocess
        expected=self.closed_page_history(2049);root=Path(__file__).resolve().parents[1]
        # Exercise the real JS projection: hidden, released descriptors remain
        # in the same long-running BrowserPool even though no renderer exists.
        script="const m=require('./apps/web-host/maintenance-exit.cjs'),rows=JSON.parse(require('node:fs').readFileSync(0,'utf8'));const driver={records:new Map(rows.map(r=>[r.page_id,{thread_id:r.thread_id,url:r.url,latest_request:{id:r.request_id,phase:r.request_phase,attempt_id:r.attempt_id}}]))},pool={pages:new Map(rows.map(r=>[r.page_id,{id:r.page_id,hidden:true,view:null}]))};process.stdout.write(JSON.stringify(m.pageBindings(driver,pool)));"
        result=subprocess.run(['node','-e',script],input=json.dumps(expected),cwd=root,capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr);bindings=json.loads(result.stdout);self.assertEqual(bindings,expected)
        payload={**self.payload(),'page_bindings':bindings};self.assertLess(len(json.dumps(payload).encode()),12*1024*1024)
        before=self.s.state.path.read_bytes();proof=readiness(self.s,payload)
        self.assertTrue(proof['idle']);self.assertEqual(proof['jobs']['scopeCount'],len(bindings)+self.closed_history_original_scope_count);self.assertEqual(proof['jobs']['currentSessionCount'],0)
        self.assertEqual([op for op,_ in self.transport.calls],['status']+['jobs']*(len(ACTIVE)+len(UNCERTAIN)));self.assertEqual(self.s.state.path.read_bytes(),before)
    def test_large_descriptor_history_preserves_last_binding_identity_and_current_execution_checks(self):
        bindings=self.closed_page_history(3500);payload={**self.payload(),'page_bindings':bindings};before=self.s.state.path.read_bytes()
        self.assertTrue(readiness(self.s,payload)['idle']);self.assertEqual(self.s.state.path.read_bytes(),before)
        for field in ('thread_id','url','request_id','request_phase','attempt_id'):
            with self.subTest(field=field),self.assertRaisesRegex(HarnessError,'binding_unavailable'):
                readiness(self.s,{**payload,'page_bindings':bindings[:-1]+[{**bindings[-1],field:'different-original-binding'}]})
        for last in ({**bindings[-1],'url':'x'*2049},{**bindings[-1],'unexpected':True}):
            with self.assertRaisesRegex(HarnessError,'binding_unavailable'):readiness(self.s,{**payload,'page_bindings':bindings[:-1]+[last]})
        with self.assertRaisesRegex(HarnessError,'binding_unavailable'):readiness(self.s,{**payload,'page_bindings':bindings+[bindings[-1]]})
        self.transport.jobs=[{'job_id':'original-last-history-job','client_id':'fixture','project':'agent:fixture:owned','session_id':'wc_sess_closed_history_3499','status':'running'}]
        with self.assertRaisesRegex(HarnessError,'jobs_active'):readiness(self.s,payload)
        self.transport.jobs=[];self.h.active_business_operations=1
        try:
            with self.assertRaisesRegex(HarnessError,'execution_unresolved'):readiness(self.s,payload)
        finally:self.h.active_business_operations=0
        self.assertEqual(self.s.state.path.read_bytes(),before)
    def test_large_descriptor_history_does_not_repeat_public_view_queries_per_page(self):
        import sqlite3
        bindings=self.closed_page_history(2049);payload={**self.payload(),'page_bindings':bindings};queries=[]
        connect=sqlite3.connect
        def trace(*args,**kwargs):
            connection=connect(*args,**kwargs);connection.set_trace_callback(queries.append);return connection
        before=self.s.state.path.read_bytes()
        with patch('maintenance_exit_readiness.sqlite3.connect',side_effect=trace):proof=readiness(self.s,payload)
        self.assertTrue(proof['idle']);self.assertLess(len(queries),200,'history must not issue per-page public-view scans in both ledger reads')
        self.assertEqual(before,self.s.state.path.read_bytes())
    def test_descriptor_identity_batch_matches_real_public_latest_ordering_and_absence(self):
        import sqlite3
        from harness_managed_view import latest_request
        bindings=self.closed_page_history(8)
        with closing(self.s.state.connect()) as db:
            db.row_factory=sqlite3.Row
            def request(n,ident,phase,created):
                db.execute('INSERT INTO host_requests(id,thread_id,text,phase,created_at) VALUES(?,?,?,?,?)',
                           (ident,bindings[n]['thread_id'],'Retained original identity',phase,created))
            # An older active request outranks newer completed history; within
            # active requests created_at still picks the latest one.
            request(0,'active-old','queued','2025-01-01');request(0,'terminal-new','completed','2027-01-01')
            request(1,'active-earlier','queued','2025-01-01');request(1,'active-later','processing','2025-01-02')
            request(1,'terminal-even-later','completed','2028-01-01')
            # Equal timestamps retain the real canonical SQLite selection,
            # including attempts inserted in reverse epoch order.
            request(2,'tie-inserted-z','completed','2027-01-01');request(2,'tie-inserted-a','completed','2027-01-01')
            for epoch,ident,offered in ((2,'attempt-tie-z',20),(1,'attempt-tie-a',20),(0,'attempt-earlier',10)):
                db.execute("INSERT INTO control_attempts VALUES(?,?,?,?,1,'not_sent',?,?,NULL,NULL)",
                           (ident,bindings[3]['request_id'],bindings[3]['thread_id'],epoch,'a'*64,offered))
            for epoch,ident,offered in ((0,'offered-later',40),(1,'offered-earlier',30)):
                db.execute("INSERT INTO control_attempts VALUES(?,?,?,?,1,'not_sent',?,?,NULL,NULL)",
                           (ident,bindings[6]['request_id'],bindings[6]['thread_id'],epoch,'b'*64,offered))
            db.execute('DELETE FROM host_requests WHERE thread_id=?',(bindings[4]['thread_id'],))
            db.execute("UPDATE managed_pages SET url='' WHERE page_id=?",(bindings[7]['page_id'],));db.commit()
            expected=[]
            for binding in bindings:
                row=db.execute('SELECT thread_id,url FROM managed_pages WHERE page_id=?',(binding['page_id'],)).fetchone()
                latest=latest_request(db,row['thread_id'])
                expected.append({**binding,'url':row['url'],'request_id':latest['id'] if latest else None,
                    'request_phase':latest['phase'] if latest else None,'attempt_id':latest['attempt_id'] if latest else None})
            self.assertEqual(expected[0]['request_id'],'active-old');self.assertEqual(expected[1]['request_id'],'active-later')
            self.assertEqual(expected[2]['request_id'],'tie-inserted-a','Equal timestamps must use the public view rowid ordering')
            self.assertIsNone(expected[4]['request_id']);self.assertIsNone(expected[5]['attempt_id'])
            self.assertEqual(expected[6]['attempt_id'],'offered-later');self.assertEqual(expected[7]['url'],'')
            before=self.s.state.path.read_bytes();verify_page_bindings(db,expected);self.assertEqual(before,self.s.state.path.read_bytes())
            for n,field in ((0,'request_id'),(1,'request_phase'),(2,'request_id'),(3,'attempt_id'),(4,'request_id'),(5,'attempt_id'),(6,'attempt_id'),(7,'url')):
                with self.subTest(page=n,field=field),self.assertRaisesRegex(HarnessError,'binding_unavailable'):
                    verify_page_bindings(db,[*expected[:n],{**expected[n],field:'different-identity'},*expected[n+1:]])
    def test_paused_original_attention_is_allowed_without_changing_requests_or_claims(self):
        self.paused_attention();before=self.s.state.path.read_bytes();result=self.read()
        self.assertTrue(result['idle']);self.assertFalse(result['leaseReleaseAuthorized']);self.assertEqual(result['jobs']['ownedActiveJobs'],0)
        self.assertEqual(self.s.state.path.read_bytes(),before);self.assertEqual([op for op,_ in self.transport.calls],['status']+['jobs']*(len(ACTIVE)+len(UNCERTAIN)))
        self.assertEqual(result['jobs']['currentSessionCount'],0)
        self.assertTrue(any(x['code']=='retained_finished_browser_turn' for x in result['historyAttention']))
    def test_unknown_control_or_operation_rejects_before_any_external_read(self):
        page,request,offer,ctx=self.paused_attention()
        for table in ('control_attempts','operations'):
            with self.subTest(table=table),closing(self.s.state.connect()) as db:
                key=offer['attempt_id'] if table=='control_attempts' else request
                original=db.execute('SELECT state FROM '+table+' WHERE id=?',(key,)).fetchone()[0]
                db.execute('UPDATE '+table+" SET state='unknown' WHERE id=?",(key,));db.commit()
                with self.assertRaisesRegex(HarnessError,'execution_unresolved'):self.read()
                db.execute('UPDATE '+table+' SET state=? WHERE id=?',(original,key));db.commit()
        self.assertEqual(self.transport.calls,[])
    def test_active_original_job_rejects_but_unrelated_workbench_job_does_not(self):
        self.paused_attention();project,session=self.scope
        original={'job_id':'wc_job_original','client_id':'fixture','project':project,'session_id':session,'status':'running'}
        self.transport.jobs=[original]
        with self.assertRaisesRegex(HarnessError,'jobs_active'):self.read()
        self.transport.jobs=[{**original,'project':'agent:fixture:workbench','session_id':'wc_sess_other'}]
        self.assertTrue(self.read()['idle'])
    def test_queued_original_job_is_still_execution(self):
        self.paused_attention();project,session=self.scope
        self.transport.jobs=[{'job_id':'wc_job_queued','client_id':'fixture','project':project,'session_id':session,'status':'queued'}]
        with self.assertRaisesRegex(HarnessError,'jobs_active'):self.read()
    def test_truncated_inventory_or_changed_runner_is_not_idle(self):
        self.paused_attention();self.transport.truncated=True
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
        self.transport.truncated=False;self.transport.client_id='different'
        self.transport.jobs=[{'job_id':'wc_job_wrong_runner','client_id':'different','project':self.scope[0],'session_id':self.scope[1],'status':'running'}]
        with self.assertRaisesRegex(HarnessError,'binding_unavailable'):self.read()
    def test_unverified_writer_is_not_certified_from_page_silence(self):
        self.paused_attention(writer=True)
        with self.assertRaisesRegex(HarnessError,'execution_unresolved'):self.read()
        self.assertEqual(self.transport.calls,[])
    def test_existing_verified_writer_checkpoint_is_allowed_with_a_fresh_job_read_and_lease_retained(self):
        page,request,offer,ctx=self.paused_attention(writer=True);run=ctx['run']['id']
        held=self.h.managed.browser('maintenance',{'page_id':page,'action':'quiesce','operation_id':'hold-fixture-original-maintenance'})
        self.assertEqual(held['state'],'holding')
        evidence=self.s.root/'evidence/fixture-idle.json';evidence.parent.mkdir()
        evidence.write_text(json.dumps({'source':'Local-MCP-B.runtime_status','observed_at':self.h.clock(),'result':{'structuredContent':{'success':True,'error':None,'output':{'focus':{'client_id':'fixture','connected':True},'jobs':{'active_count':0,'running_count':0,'queued_count':0}}}}}))
        verified=self.h.team.public_command(ctx['request']['thread_id'],'verify-fixture-original-maintenance','verify-maintenance-idle',{'run_id':run,'request_id':request,'attempt_id':offer['attempt_id'],'evidence_path':str(evidence),'evidence_sha256':hashlib.sha256(evidence.read_bytes()).hexdigest(),'confirm':True})
        self.assertEqual(verified['state'],'settled');before=self.s.state.path.read_bytes();self.assertTrue(self.read()['idle']);self.assertEqual(before,self.s.state.path.read_bytes())
        with closing(self.s.state.connect()) as db:self.assertTrue(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())
    def test_unreleased_native_claim_and_orphan_lease_block(self):
        self.paused_attention()
        with closing(self.s.state.connect()) as db:db.execute('CREATE TABLE native_work_claims(claim_id,state)');db.execute("INSERT INTO native_work_claims VALUES('original','terminal_pending')");db.commit()
        with self.assertRaisesRegex(HarnessError,'execution_unresolved'):self.read()
        with closing(self.s.state.connect()) as db:db.execute("UPDATE native_work_claims SET state='released'");db.execute("INSERT INTO host_team_leases VALUES('missing-request','missing-run','missing-thread','fixture','write','[]',0)");db.commit()
        with self.assertRaisesRegex(HarnessError,'execution_unresolved'):self.read()
    def test_original_transport_swap_and_new_unknown_operation_during_read_are_rejected(self):
        self.paused_attention()
        def swap(op):self.s.transport=Transport()
        self.transport.hook=swap
        with self.assertRaisesRegex(HarnessError,'host_unavailable'):self.read()
        self.s.transport=self.transport;self.transport.hook=None
        def mutate(op):
            if op=='jobs':
                with closing(self.s.state.connect()) as db:db.execute("UPDATE operations SET state='unknown' WHERE action='message.send'");db.commit()
        self.transport.hook=mutate
        with self.assertRaisesRegex(HarnessError,'execution_unresolved'):self.read()
    def test_wrong_store_and_corrupt_ledger_never_become_empty(self):
        with self.assertRaisesRegex(HarnessError,'store_changed'):readiness(self.s,{**self.payload(),'store_id':'different'})
        original=self.s.state.path.read_bytes()
        try:
            self.s.state.path.write_bytes(b'corrupt fixture')
            with self.assertRaisesRegex(HarnessError,'ledger_unavailable'):self.read()
        finally:self.s.state.path.write_bytes(original)
    def test_paused_original_claim_change_during_jobs_read_cannot_replace_baseline(self):
        page,request,offer,ctx=self.paused_attention()
        def mutate(op):
            if op=='jobs':
                with closing(self.s.state.connect()) as db:db.execute("UPDATE host_requests SET claim_id='new-original-claim' WHERE id=?",(request,));db.commit()
        self.transport.hook=mutate
        with self.assertRaisesRegex(HarnessError,'store_changed'):self.read()
        with closing(self.s.state.connect()) as db:self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0],'new-original-claim')
    def test_more_than_100_unrelated_jobs_use_exact_session_scopes(self):
        self.paused_attention();self.transport.jobs=[{'job_id':'wc_job_other_'+str(i),'client_id':'fixture','project':'agent:fixture:workbench','session_id':'wc_sess_other','status':'running'} for i in range(101)]
        result=self.read();self.assertTrue(result['idle']);self.assertTrue(result['jobs']['scopedFallback'])
        self.assertTrue(any(op=='jobs' and p.get('session_id')==self.scope[1] for op,p in self.transport.calls))
    def test_current_session_call_and_identity_unknown_are_not_zero_jobs(self):
        _,_,child,_=self.manual_waiting_receivers();self.h.pause(child,True)
        self.assertEqual(ledger_read(self.s)['currentScopes'],{self.scope_for(child)});self.transport.call_active=True
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
        self.transport.call_active=False;self.transport.detail_id='wc_sess_not_original'
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
    def test_inactive_historical_bad_binding_is_retained_while_current_bad_binding_rejects(self):
        parent,_,child,_=self.manual_waiting_receivers()
        with closing(self.s.state.connect()) as db:
            old=json.loads(db.execute('SELECT spec FROM host_bindings WHERE thread_id=?',(parent,)).fetchone()[0])
            db.execute('UPDATE host_bindings SET spec=? WHERE thread_id=?',(json.dumps({**old,'session_id':'historical-invalid'}),parent));db.commit()
        self.assertTrue(self.read()['historyAttention']);self.h.pause(child,True)
        with closing(self.s.state.connect()) as db:db.execute("UPDATE host_bindings SET spec='{}' WHERE thread_id=?",(child,));db.commit()
        with self.assertRaisesRegex(HarnessError,'binding_unavailable'):self.read()
    def test_python_and_desktop_fingerprints_share_the_exact_fixture_file_identity(self):
        import subprocess
        root=Path(__file__).resolve().parents[1]
        result=subprocess.run(['node','-e',"console.log(require('./apps/web-host/maintenance-exit.cjs').ledgerFingerprint(process.argv[1]))",str(self.s.root)],cwd=root,capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),revision_hash(ledger_revision(self.s.state.path)))
    def test_cached_page_must_match_original_canonical_thread_request_attempt_and_url(self):
        from harness_managed_view import latest_request
        page,request,offer,ctx=self.paused_attention()
        with closing(self.s.state.connect()) as db:
            row=db.execute('SELECT thread_id,url FROM managed_pages WHERE page_id=?',(page,)).fetchone();latest=latest_request(db,row['thread_id'])
        binding={'page_id':page,'thread_id':row['thread_id'],'url':row['url'],'request_id':latest['id'],'request_phase':latest['phase'],'attempt_id':latest['attempt_id']}
        payload={**self.payload(),'page_bindings':[binding]};self.assertTrue(readiness(self.s,payload)['idle'])
        for field in ('thread_id','request_id','attempt_id','url'):
            with self.subTest(field=field),self.assertRaisesRegex(HarnessError,'binding_unavailable'):
                readiness(self.s,{**self.payload(),'page_bindings':[{**binding,field:'stale-renderer'}]})
    def test_loaded_transport_cannot_change_identity_in_place_after_job_read(self):
        self.paused_attention()
        def change(op):
            if op=='jobs':self.transport.namespace='different-loaded-identity'
        self.transport.hook=change
        with self.assertRaisesRegex(HarnessError,'host_unavailable'):self.read()
    def shutdown_payload(self,proof):return {'instance_id':proof['instanceId'],'store_id':proof['storeId'],'permit_id':proof['permitId'],'ledger_fingerprint':proof['ledgerFingerprint']}
    def test_shutdown_rechecks_original_jobs_with_same_permit_and_preserves_paused_intent(self):
        self.paused_attention();proof=self.read();saved=self.s._maintenance_exit_permit;before=self.s.state.path.read_bytes();self.transport.calls.clear()
        # Closing the Native owner can take longer than the preflight window.
        saved['proof']['observedAt']-=60
        receipt=authorize_shutdown(self.s,self.shutdown_payload(proof))
        self.assertEqual(receipt['permitId'],proof['permitId']);self.assertFalse(receipt['pauseAuthorized']);self.assertIs(self.s._maintenance_exit_permit,saved)
        self.assertEqual(before,self.s.state.path.read_bytes());self.assertEqual([op for op,_ in self.transport.calls],['status']+['jobs']*(len(ACTIVE)+len(UNCERTAIN)))
    def test_shutdown_fresh_jobs_failure_retains_original_permit_and_original_job(self):
        self.paused_attention();proof=self.read();saved=self.s._maintenance_exit_permit;project,session=self.scope
        self.transport.jobs=[{'job_id':'wc_job_original','client_id':'fixture','project':project,'session_id':session,'status':'running'}]
        with self.assertRaisesRegex(HarnessError,'jobs_active'):authorize_shutdown(self.s,self.shutdown_payload(proof))
        self.assertIs(self.s._maintenance_exit_permit,saved);self.assertEqual(self.transport.jobs[0]['job_id'],'wc_job_original')
    def test_shutdown_db_change_in_fresh_jobs_read_does_not_rebase_or_replace_permit(self):
        page,request,offer,ctx=self.paused_attention();proof=self.read();saved=self.s._maintenance_exit_permit
        def mutate(op):
            if op=='jobs':
                with closing(self.s.state.connect()) as db:db.execute("UPDATE host_requests SET claim_id='retained-changed-claim' WHERE id=?",(request,));db.commit()
        self.transport.hook=mutate
        with self.assertRaisesRegex(HarnessError,'store_changed'):authorize_shutdown(self.s,self.shutdown_payload(proof))
        self.assertIs(self.s._maintenance_exit_permit,saved)
        with closing(self.s.state.connect()) as db:self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0],'retained-changed-claim')
    def test_shutdown_rejects_wrong_permit_instance_and_loaded_transport_identity(self):
        self.paused_attention();proof=self.read();payload=self.shutdown_payload(proof)
        for field in ('instance_id','permit_id','store_id'):
            with self.subTest(field=field),self.assertRaisesRegex(HarnessError,'original_receipt'):authorize_shutdown(self.s,{**payload,field:'wrong'})
        self.transport.namespace='changed-before-shutdown'
        with self.assertRaisesRegex(HarnessError,'host_unavailable'):authorize_shutdown(self.s,payload)
    def test_completed_page_binding_is_verified_without_reading_its_expired_historical_session(self):
        page,request,offer,ctx=self.base.start_browser_turn();self.f.finish(page,request,offer,ctx['request']['claim_id'],'completed','Actual completed fixture result')
        with closing(self.s.state.connect()) as db:
            db.execute("UPDATE host_runs SET state='closed' WHERE id=?",(ctx['run']['id'],));db.commit()
            row=db.execute('SELECT thread_id,url FROM managed_pages WHERE page_id=?',(page,)).fetchone()
            from harness_managed_view import latest_request
            latest=latest_request(db,row['thread_id'])
        binding={'page_id':page,'thread_id':row['thread_id'],'url':row['url'],'request_id':latest['id'],'request_phase':latest['phase'],'attempt_id':latest['attempt_id']}
        def expired(op):
            if op=='detail':raise AssertionError('Completed historical Session must not be probed as current')
        self.transport.hook=expired
        result=readiness(self.s,{**self.payload(),'page_bindings':[binding]});self.assertTrue(result['idle']);self.assertEqual(result['jobs']['currentSessionCount'],0)
        with self.assertRaisesRegex(HarnessError,'binding_unavailable'):readiness(self.s,{**self.payload(),'page_bindings':[{**binding,'thread_id':'wrong-original-thread'}]})
    def test_closed_blocked_saved_turn_is_history_but_its_original_jobs_still_block(self):
        page,request,offer,ctx=self.paused_attention()
        self.f.team(page,'close',{'run_id':ctx['run']['id'],'claim_id':ctx['request']['claim_id'],
            'summary':'Original refusal retained, business work incomplete','references':[]})
        self.h.managed.browser('list',{})
        def unavailable(op):
            if op=='detail':raise ObservationError('not_found')
        self.transport.hook=unavailable;before=self.s.state.path.read_bytes();proof=self.read()
        self.assertEqual(proof['jobs']['currentSessionCount'],0);self.assertEqual(before,self.s.state.path.read_bytes())
        self.assertTrue(any(x['requestId']==request and x['requestPhase']=='blocked' and x['code']=='historical_finished_browser_turn' for x in proof['historyAttention']))
        project,session=self.scope;self.transport.jobs=[{'job_id':'retained-original-job','client_id':'fixture','project':project,'session_id':session,'status':'running'}]
        with self.assertRaisesRegex(HarnessError,'jobs_active'):self.read()
    def test_disabled_legacy_queue_and_authentic_wait_are_history_without_erasing_wait_pointers(self):
        parent,request,child,child_request=self.manual_waiting_receivers()
        def unavailable(op):
            if op=='detail':raise ObservationError('not_found')
        self.transport.hook=unavailable;before=self.s.state.path.read_bytes();proof=self.read()
        self.assertEqual(proof['jobs']['currentSessionCount'],0);self.assertEqual(before,self.s.state.path.read_bytes())
        retained={x['requestId']:x for x in proof['historyAttention']}
        self.assertEqual(retained[request]['waitingState'],'yielded');self.assertEqual(retained[child_request]['waitingState'],'unclaimed_queue')
        with closing(self.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT active_turn FROM threads WHERE id=?',(parent,)).fetchone()[0],request)
            self.assertEqual(db.execute('SELECT active_turn FROM threads WHERE id=?',(child,)).fetchone()[0],child_request)
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'suspended')
    def test_disabled_manual_receiver_requires_every_waiting_identity_condition(self):
        parent,request,child,child_request=self.manual_waiting_receivers();scope=self.scope_for(child)
        cases=[('enabled','UPDATE host_bindings SET enabled=1 WHERE thread_id=?',(child,),
                'UPDATE host_bindings SET enabled=0 WHERE thread_id=?',(child,)),
               ('processing_status',"UPDATE threads SET status='processing' WHERE id=?",(child,),
                "UPDATE threads SET status='waiting' WHERE id=?",(child,)),
               ('foreign_active_pointer',"UPDATE threads SET active_turn='different-original-request' WHERE id=?",(child,),
                'UPDATE threads SET active_turn=? WHERE id=?',(child_request,child)),
               ('claimed_queue',"UPDATE host_requests SET claim_id='accepted-original-claim' WHERE id=?",(child_request,),
                'UPDATE host_requests SET claim_id=NULL WHERE id=?',(child_request,)),
               ('processing_request',"UPDATE host_requests SET phase='processing' WHERE id=?",(child_request,),
                "UPDATE host_requests SET phase='queued' WHERE id=?",(child_request,))]
        for name,change,args,restore,restore_args in cases:
            with self.subTest(name=name),closing(self.s.state.connect()) as db:
                db.execute(change,args);db.commit();self.assertIn(scope,ledger_read(self.s)['currentScopes'])
                db.execute(restore,restore_args);db.commit()
        with closing(self.s.state.connect()) as db:
            db.execute("DELETE FROM events WHERE thread_id=? AND kind='host_waiting_children'",(parent,));db.commit()
        self.assertIn(self.scope_for(parent),ledger_read(self.s)['currentScopes'])
    def test_disabled_manual_current_provider_or_unknown_operation_is_not_idle(self):
        _,_,child,_=self.manual_waiting_receivers()
        with closing(self.s.state.connect()) as db:
            db.execute("UPDATE threads SET provider='codex' WHERE id=?",(child,));db.commit()
        with self.assertRaisesRegex(HarnessError,'execution_unresolved'):self.read()
        with closing(self.s.state.connect()) as db:
            db.execute("UPDATE threads SET provider='chatgpt_web_host' WHERE id=?",(child,))
            db.execute("UPDATE operations SET state='unknown' WHERE action='host.pause' AND thread_id=?",(child,));db.commit()
        with self.assertRaisesRegex(HarnessError,'execution_unresolved'):self.read()
        self.assertEqual(self.transport.calls,[])
    def test_disabled_manual_acknowledged_unfinished_call_stays_current(self):
        _,_,child,request=self.manual_waiting_receivers()
        with closing(self.s.state.connect()) as db:
            db.execute("INSERT INTO control_attempts VALUES('original-accepted',?,?,0,1,'acknowledged',?,1,2,3)",(request,child,'a'*64));db.commit()
        self.assertIn(self.scope_for(child),ledger_read(self.s)['currentScopes'])
        self.transport.call_active=True
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
    def test_manual_receiver_with_a_managed_page_is_current(self):
        _,_,child,_=self.manual_waiting_receivers();page,_=self.base.enroll()
        with closing(self.s.state.connect()) as db:
            db.execute('UPDATE managed_pages SET thread_id=?,paused=1 WHERE page_id=?',(child,page));db.commit()
        self.assertIn(self.scope_for(child),ledger_read(self.s)['currentScopes'])
    def test_current_missing_session_and_access_timeout_errors_are_not_idle(self):
        _,_,child,_=self.manual_waiting_receivers();self.h.pause(child,True)
        for code in ('not_found','access_denied','auth_required','upstream_timeout','upstream_unreachable'):
            with self.subTest(code=code):
                def unavailable(op):
                    if op=='detail':raise ObservationError(code)
                self.transport.hook=unavailable
                with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
        self.assertIsNone(getattr(self.s,'_maintenance_exit_permit',None))
    def test_paused_known_not_sent_original_queue_does_not_probe_an_old_session(self):
        page,binding=self.base.enroll();request=self.base.f.command(binding['thread_id'],'message.send',{'text':'Original unsent queued work'})['request_id']
        offer=self.base.wire(page,'pulse');self.base.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        self.h.managed.browser('pause',{'page_id':page,'paused':True})
        self.h.managed.browser('wire',{'page_id':page,'data':{'action':'finish','attempt_id':offer['attempt_id'],'result':'not_sent'}})
        def unavailable(op):
            if op=='detail':raise ObservationError('not_found')
        self.transport.hook=unavailable;before=self.s.state.path.read_bytes();proof=self.read()
        self.assertEqual(before,self.s.state.path.read_bytes());self.assertEqual(proof['jobs']['currentSessionCount'],0)
        self.assertTrue(any(x['requestId']==request and x['code']=='retained_not_sent_request' for x in proof['historyAttention']))
    def test_finished_handoff_source_uses_original_saved_turn_while_successor_stays_current(self):
        import test_harness_managed_handoff as handoff_fixture
        f=handoff_fixture.HandoffTests();f.f=self.base;f.h=self.h;f.m=self.h.managed
        page,request,offer,context,payload=f.begin();successor=self.base.private(page,'handoff',payload)['successor_page']
        f.finish_source(page,offer);f.enroll_successor(successor)
        with closing(self.s.state.connect()) as db:
            original=db.execute('SELECT * FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual(original['phase'],'handed_off')
            self.assertEqual(retained_request_evidence(db,self.s,original)['code'],'historical_finished_browser_turn')
            current=db.execute('SELECT r.* FROM host_requests r JOIN managed_pages p ON p.thread_id=r.thread_id WHERE p.page_id=?',(successor,)).fetchone()
            self.assertIsNone(retained_request_evidence(db,self.s,current))
    def test_original_partial_retirement_receipt_is_history_without_creating_host_reply(self):
        master,worker,run,request,_,observation=self.base.start_partial_text_worker()
        self.h.managed.browser('partial-public-send',observation);payload=self.base.partial_retirement_payload(worker,request,observation)
        with patch('native_work_admission.zero_local_jobs',return_value=True):self.h.managed.browser('retire-partial',payload)
        with closing(self.s.state.connect()) as db:
            original=db.execute('SELECT * FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual(retained_request_evidence(db,self.s,original)['code'],'historical_retired_partial_turn')
            self.assertFalse(db.execute('SELECT 1 FROM host_replies WHERE request_id=?',(request,)).fetchone())
            db.execute('DELETE FROM managed_partial_retirements WHERE request_id=?',(request,));db.commit()
            self.assertIsNone(retained_request_evidence(db,self.s,original))
    def test_first_task_requires_original_public_complete_receipt_after_authentic_wait(self):
        import test_harness_managed_first_task as first_fixture
        f=first_fixture.FirstTaskTests();f.f=self.base;f.m=self.h.managed
        parent,_=f.receive();self.base.private(parent,'first-task',{})
        child,_=self.base.reserve(parent,first_turn_mode='task_v1',first_turn_instructions='Read and return complete evidence.')
        self.base.private(parent,'wait-ready',{'targets':[child]});self.h.managed.browser('bind-first-turn',f.public_turn(parent))
        self.h.managed.browser('pause',{'page_id':parent,'paused':True})
        with closing(self.s.state.connect()) as db:
            original=db.execute('SELECT r.* FROM host_requests r JOIN managed_pages p ON p.thread_id=r.thread_id WHERE p.page_id=?',(parent,)).fetchone()
            self.assertEqual(retained_request_evidence(db,self.s,original)['code'],'retained_finished_first_turn')
            db.execute("DELETE FROM events WHERE thread_id=? AND kind='managed_first_turn_reconciled'",(original['thread_id'],));db.commit()
            self.assertIsNone(retained_request_evidence(db,self.s,original))
    def test_thousands_of_original_terminal_receipts_bound_only_diagnostics_and_keep_current_execution(self):
        parent,_,child,_=self.manual_waiting_receivers();self.h.pause(child,True)
        count=3000
        with closing(self.s.state.connect()) as db:
            requests=[('history-request-'+str(i),parent,'Original failed work','blocked','original','finished') for i in range(count)]
            db.executemany('INSERT INTO host_requests(id,thread_id,text,phase,created_at,finished_at) VALUES(?,?,?,?,?,?)',requests)
            replies=[('history-reply-'+str(i),'history-request-'+str(i),'original-fingerprint',json.dumps({
                'request_id':'history-request-'+str(i),'thread_id':parent,'reply_id':'history-reply-'+str(i),'phase':'blocked'})) for i in range(count)]
            db.executemany('INSERT INTO host_replies VALUES(?,?,?,?)',replies);db.commit()
        before=self.s.state.path.read_bytes();value=ledger_read(self.s)
        self.assertEqual(value['currentScopes'],{self.scope_for(child)})
        self.assertEqual(value['historyAttentionSummary']['byCode']['historical_terminal_host_receipt'],count)
        self.assertTrue(value['historyAttentionSummary']['truncated'])
        self.assertEqual(len(value['historyAttention']),value['historyAttentionSummary']['sampleCount'])
        self.assertLess(len(json.dumps(value['historyAttention']).encode()),128*1024)
        self.transport.call_active=True
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
        self.transport.call_active=False;proof=self.read()
        self.assertEqual(proof['jobs']['currentSessionCount'],1);self.assertLess(len(json.dumps(proof).encode()),128*1024)
        self.assertEqual(proof['historyAttentionSummary']['byCode']['historical_terminal_host_receipt'],count)
        self.assertEqual(before,self.s.state.path.read_bytes())
    def test_thousands_of_historical_bindings_keep_all_job_scopes_and_only_current_session(self):
        _,_,child,_=self.manual_waiting_receivers();self.h.pause(child,True)
        original=ledger_read(self.s)['scopes'];count=3500
        old_scopes={('agent:fixture:owned','wc_sess_history_'+str(i)) for i in range(count)}
        with closing(self.s.state.connect()) as db:
            db.executemany('INSERT INTO host_bindings(target_id,thread_id,spec,enabled) VALUES(?,?,?,0)',[
                ('history-target-'+str(i),'history-thread-'+str(i),json.dumps({'project':project,'session_id':session}))
                for i,(project,session) in enumerate(sorted(old_scopes))]);db.commit()
        before=self.s.state.path.read_bytes();value=ledger_read(self.s)
        self.assertEqual(value['scopes'],original|old_scopes)
        self.assertEqual(value['currentScopes'],{self.scope_for(child)})
        proof=self.read();self.assertTrue(proof['idle'])
        self.assertEqual(proof['jobs']['scopeCount'],len(original)+count)
        self.assertEqual(proof['jobs']['currentSessionCount'],1)
        self.assertEqual([p['session_id'] for op,p in self.transport.calls if op=='detail'],[self.scope_for(child)[1]])
        # Neither bounded diagnostics nor a complete global inventory can drop
        # the last historical scope's still-running original Job.
        project,session='agent:fixture:owned','wc_sess_history_3499'
        job={'job_id':'retained-last-history-job','client_id':'fixture','project':project,'session_id':session,'status':'running'}
        self.transport.jobs=[job]
        with self.assertRaisesRegex(HarnessError,'jobs_active'):self.read()
        # A truncated global list still queries every exact historical scope.
        self.transport.jobs=[{'job_id':'unrelated-'+str(i),'client_id':'fixture','project':'agent:fixture:workbench','session_id':'wc_sess_other','status':'running'} for i in range(101)]+[job]
        self.transport.calls.clear()
        with self.assertRaisesRegex(HarnessError,'jobs_active'):self.read()
        self.assertTrue(any(op=='jobs' and p.get('project')==project and p.get('session_id')==session for op,p in self.transport.calls))
        self.assertEqual(before,self.s.state.path.read_bytes())
    def test_thousands_of_invalid_historical_bindings_bound_diagnostics_but_reject_invalid_current(self):
        _,_,child,_=self.manual_waiting_receivers();self.h.pause(child,True);count=3500
        with closing(self.s.state.connect()) as db:
            db.executemany('INSERT INTO host_bindings(target_id,thread_id,spec,enabled) VALUES(?,?,?,0)',[
                ('invalid-history-target-'+str(i),'invalid-history-thread-'+str(i),'{}') for i in range(count)]);db.commit()
        before=self.s.state.path.read_bytes();proof=self.read()
        summary=proof['historyAttentionSummary']
        self.assertTrue(proof['idle']);self.assertEqual(proof['jobs']['currentSessionCount'],1)
        self.assertEqual(summary['byCode']['historical_binding_unavailable'],count)
        self.assertTrue(summary['truncated']);self.assertEqual(summary['sampleCount'],256)
        self.assertLess(len(json.dumps(proof).encode()),128*1024)
        self.assertEqual(before,self.s.state.path.read_bytes())
        with closing(self.s.state.connect()) as db:
            db.execute("UPDATE host_bindings SET spec='{}' WHERE thread_id=?",(child,));db.commit()
        self.transport.calls.clear()
        with self.assertRaisesRegex(HarnessError,'binding_unavailable'):self.read()
        self.assertEqual(self.transport.calls,[])

class EmptyOwnedLedgerMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.s=HarnessService(self.root,self.root/'.local/harness')
    def tearDown(self):self.s.close();self.tmp.cleanup()
    def payload(self):return {'store_id':self.s.state.id,'ledger_fingerprint':revision_hash(ledger_revision(self.s.state.path)),'page_bindings':[]}
    def read(self):return readiness(self.s,self.payload())
    def shutdown_payload(self,proof):return {'instance_id':proof['instanceId'],'store_id':proof['storeId'],'permit_id':proof['permitId'],'ledger_fingerprint':proof['ledgerFingerprint']}
    def completed_receipt(self):
        with closing(self.s.state.connect()) as db:
            db.execute("INSERT INTO host_replies VALUES('retained-original-receipt','old-request','original-fingerprint','{}')");db.commit()
    def test_first_use_unconfigured_empty_original_host_can_prove_and_authorize_normal_shutdown(self):
        self.assertIsNone(self.s.transport);self.assertIsNone(self.s.connection)
        before=self.s.state.path.read_bytes()
        with patch('maintenance_exit_readiness.job_read',side_effect=AssertionError('No external execution scope exists')):
            proof=self.read();saved=self.s._maintenance_exit_permit
            self.assertTrue(proof['idle']);self.assertFalse(proof['modelCalled']);self.assertFalse(proof['leaseReleaseAuthorized'])
            self.assertEqual(proof['jobs'],{'clientId':'no_execution_owner:'+self.s.state.id,'scopeCount':0,
                'currentSessionCount':0,'ownedActiveJobs':0,'inventoryComplete':True,'scopedFallback':False,
                'verification_scope':'empty_original_local_ledger_no_external_scope','externalInventoryVerified':False})
            self.assertEqual(before,self.s.state.path.read_bytes())
            receipt=authorize_shutdown(self.s,self.shutdown_payload(proof))
        self.assertEqual(receipt['state'],'maintenance_shutdown_accepted');self.assertEqual(receipt['permitId'],proof['permitId'])
        self.assertFalse(receipt['pauseAuthorized']);self.assertIs(self.s._maintenance_exit_permit,saved)
        self.assertEqual(self.s.host_bridge.maintenance_exit_fence,proof['permitId']);self.assertEqual(before,self.s.state.path.read_bytes())
    def test_empty_scope_list_with_an_idle_original_thread_still_requires_loaded_transport(self):
        self.s.state.bind('original-idle-native-thread','Prior original work',self.root)
        local=ledger_read(self.s);self.assertEqual(local['scopes'],set());self.assertFalse(local['emptyOriginalLocalLedger'])
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
        self.assertIsNone(getattr(self.s,'_maintenance_exit_permit',None))
    def test_orphan_completed_acceptance_receipt_is_not_a_fresh_empty_store(self):
        self.completed_receipt()
        with closing(self.s.state.connect()) as db:
            for name in ('threads','host_bindings','managed_pages','host_requests','host_runs'):
                self.assertEqual(db.execute('SELECT COUNT(*) FROM '+name).fetchone()[0],0)
        self.assertFalse(ledger_read(self.s)['emptyOriginalLocalLedger'])
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
    def test_released_native_claim_history_still_requires_transport_and_active_claim_still_blocks(self):
        with closing(self.s.state.connect()) as db:
            db.execute('CREATE TABLE native_work_claims(claim_id,state)');db.commit()
        self.assertTrue(self.read()['idle'],'A lazily initialized but empty claim table has no owner')
        with closing(self.s.state.connect()) as db:
            db.execute("INSERT INTO native_work_claims VALUES('original-native-history','released')");db.commit()
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
        with closing(self.s.state.connect()) as db:
            db.execute("UPDATE native_work_claims SET state='terminal_pending'");db.commit()
        with self.assertRaisesRegex(HarnessError,'execution_unresolved'):self.read()
    def test_unknown_journal_table_data_is_not_empty_evidence(self):
        with closing(self.s.state.connect()) as db:
            db.executescript("CREATE TABLE future_acceptance_receipts(id); INSERT INTO future_acceptance_receipts VALUES('original-receipt')");db.commit()
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
    def test_metadata_history_is_not_empty_evidence(self):
        with closing(self.s.state.connect()) as db:
            db.execute("INSERT INTO metadata VALUES('prior-execution-owner','retained-original-identity')");db.commit()
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
    def test_null_metadata_key_cannot_hide_retained_unknown_history_in_an_empty_store(self):
        with closing(self.s.state.connect()) as db:
            db.execute("INSERT INTO metadata VALUES(NULL,'retained-unknown-history')");db.commit()
            self.assertEqual(db.execute("SELECT COUNT(*) FROM metadata WHERE key IS NULL").fetchone()[0],1)
        self.assertFalse(ledger_read(self.s)['emptyOriginalLocalLedger'])
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
        self.assertIsNone(getattr(self.s,'_maintenance_exit_permit',None));self.assertIsNone(self.s.host_bridge.maintenance_exit_fence)
        with closing(self.s.state.connect()) as db:
            self.assertEqual(db.execute("SELECT value FROM metadata WHERE key IS NULL").fetchone()[0],'retained-unknown-history')
    def test_deleted_event_history_is_not_proven_fresh_from_zero_business_rows(self):
        with closing(self.s.state.connect()) as db:
            db.execute("INSERT INTO events(thread_id,kind,data,at) VALUES('old-original','host_result','{}','original-time')")
            db.execute('DELETE FROM events');db.commit()
        self.assertFalse(ledger_read(self.s)['emptyOriginalLocalLedger'])
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
    def test_invalid_sequence_history_is_not_a_zero_execution_owner(self):
        for sequence in (1,-1,'0',None):
            with self.subTest(sequence=sequence),closing(self.s.state.connect()) as db:
                db.execute("UPDATE sqlite_sequence SET seq=? WHERE name='host_team_signals'",(sequence,));db.commit()
                with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
    def test_orphan_zero_sequence_is_not_a_known_empty_business_table(self):
        with closing(self.s.state.connect()) as db:
            db.execute("INSERT INTO sqlite_sequence VALUES('missing-original-execution-table',0)");db.commit()
        with self.assertRaisesRegex(HarnessError,'jobs_unverified'):self.read()
    def test_changed_local_ledger_during_proof_is_rejected_even_if_file_metadata_is_unchanged(self):
        original=ledger_read;calls=0;revision=ledger_revision(self.s.state.path);payload=self.payload()
        def add_receipt(service,page_bindings=()):
            nonlocal calls
            result=original(service,page_bindings);calls+=1
            if calls==1:self.completed_receipt()
            return result
        with patch('maintenance_exit_readiness.ledger_read',side_effect=add_receipt),patch('maintenance_exit_readiness.ledger_revision',return_value=revision):
            with self.assertRaisesRegex(HarnessError,'store_changed'):readiness(self.s,payload)
        self.assertEqual(calls,2);self.assertIsNone(getattr(self.s,'_maintenance_exit_permit',None))
        with closing(self.s.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_replies').fetchone()[0],1)
    def test_loaded_transport_or_host_identity_change_during_empty_proof_is_rejected(self):
        for change in ('transport_object','transport_namespace','host_instance'):
            with self.subTest(change=change):
                transport=Transport();self.s.transport=transport;instance=self.s.instance
                original=ledger_read;calls=0
                def mutate(service,page_bindings=()):
                    nonlocal calls
                    result=original(service,page_bindings);calls+=1
                    if calls==1:
                        if change=='transport_object':self.s.transport=Transport()
                        elif change=='transport_namespace':transport.namespace='foreign-loaded-namespace'
                        else:self.s.instance='different-original-host'
                    return result
                with patch('maintenance_exit_readiness.ledger_read',side_effect=mutate):
                    with self.assertRaisesRegex(HarnessError,'host_unavailable'):self.read()
                self.assertIsNone(getattr(self.s,'_maintenance_exit_permit',None));self.s.instance=instance
    def test_late_transport_mutation_inside_final_empty_ledger_read_is_not_certified(self):
        self.s.transport=Transport();original=ledger_read;calls=0
        def mutate(service,page_bindings=()):
            nonlocal calls
            result=original(service,page_bindings);calls+=1
            if calls==2:self.s.transport.namespace='late-foreign-namespace'
            return result
        with patch('maintenance_exit_readiness.ledger_read',side_effect=mutate):
            with self.assertRaisesRegex(HarnessError,'host_unavailable'):self.read()
        self.assertEqual(calls,2);self.assertIsNone(getattr(self.s,'_maintenance_exit_permit',None))
    def test_empty_proof_cannot_authorize_shutdown_after_an_original_receipt_appears(self):
        proof=self.read();saved=self.s._maintenance_exit_permit;self.completed_receipt()
        with self.assertRaisesRegex(HarnessError,'store_changed'):authorize_shutdown(self.s,self.shutdown_payload(proof))
        self.assertIs(self.s._maintenance_exit_permit,saved);self.assertIsNone(self.s.host_bridge.maintenance_exit_fence)
        with closing(self.s.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_replies').fetchone()[0],1)
    def test_empty_proof_cannot_authorize_a_new_transport_or_foreign_store(self):
        proof=self.read();saved=self.s._maintenance_exit_permit;payload=self.shutdown_payload(proof)
        for field in ('store_id','instance_id','permit_id'):
            with self.subTest(field=field),self.assertRaisesRegex(HarnessError,'original_receipt'):
                authorize_shutdown(self.s,{**payload,field:'foreign-original-owner'})
        self.s.transport=Transport()
        with self.assertRaisesRegex(HarnessError,'host_unavailable'):authorize_shutdown(self.s,payload)
        self.assertIs(self.s._maintenance_exit_permit,saved);self.assertIsNone(self.s.host_bridge.maintenance_exit_fence)
    def test_synchronous_original_operation_blocks_an_otherwise_empty_store(self):
        self.s.host_bridge.active_business_operations=1
        try:
            with self.assertRaisesRegex(HarnessError,'execution_unresolved'):self.read()
        finally:self.s.host_bridge.active_business_operations=0
    def test_unavailable_or_corrupt_empty_ledger_is_not_certified(self):
        payload=self.payload();before=self.s.state.path.read_bytes()
        try:
            self.s.state.path.write_bytes(b'corrupt original fresh ledger')
            with self.assertRaisesRegex(HarnessError,'ledger_unavailable'):readiness(self.s,payload)
        finally:self.s.state.path.write_bytes(before)
        with closing(self.s.state.connect()) as db:db.execute('DROP TABLE host_maintenance_execution_checks');db.commit()
        with self.assertRaisesRegex(HarnessError,'ledger_unavailable'):self.read()

if __name__=='__main__':unittest.main()
