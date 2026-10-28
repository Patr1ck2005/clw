"""Ordinary quit retains unfinished work; strict maintenance remains separate."""
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import json,sqlite3,sys,time,unittest
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_maintenance_exit_readiness as fixtures
from maintenance_exit_readiness import readiness,authorize_shutdown,ledger_revision,revision_hash
from harness_managed_view import latest_request
from harness_state import HarnessError
from live_transport import ObservationError
from harness_job_inventory import ACTIVE,UNCERTAIN

class OrdinaryExitTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.MaintenanceReadinessTests();self.f.setUp()
        self.s,self.h,self.transport=self.f.s,self.f.h,self.f.transport
    def tearDown(self):self.f.tearDown()
    def start(self):
        page,request,offer,ctx=self.f.base.start_browser_turn()
        with closing(self.s.state.connect()) as db:
            for binding in db.execute('SELECT target_id,spec FROM host_bindings').fetchall():
                spec=json.loads(binding['spec']);spec['project']='agent:fixture:owned'
                db.execute('UPDATE host_bindings SET spec=? WHERE target_id=?',(json.dumps(spec),binding['target_id']))
            # The failed/draining run and its writer reservation are durable
            # business state, with no fabricated browser result or final reply.
            db.execute("UPDATE host_runs SET state='draining',reason='deadline' WHERE id=?",(ctx['run']['id'],))
            db.execute("UPDATE host_team_leases SET access='write' WHERE request_id=?",(request,))
            db.execute("INSERT INTO managed_goals(page_id,thread_id,store_id,identity,objective,state,request_id,updated) VALUES(?,?,?,'{}','Original complete goal','active',?,?)",
                       (page,ctx['request']['thread_id'],self.s.state.id,request,time.time()))
            db.commit()
        self.h.managed.browser('pause-all',{})
        return page,request,offer,ctx
    def payload(self):
        bindings=[];carriers=[]
        with closing(self.s.state.connect()) as db:
            for page in db.execute('SELECT * FROM managed_pages WHERE thread_id IS NOT NULL'):
                request=latest_request(db,page['thread_id'])
                binding={'page_id':page['page_id'],'thread_id':page['thread_id'],'url':page['url'],
                         'request_id':request['id'] if request else None,'request_phase':request['phase'] if request else None,
                         'attempt_id':request['attempt_id'] if request else None}
                bindings.append(binding)
                hashed=request['sent_user_hash'] if request else None
                carriers.append({k:binding[k] for k in ('page_id','thread_id','request_id','attempt_id')}|{
                    'observed_at':time.time(),'paused':True,'generating':False,'draft':False,'composing':False,
                    'raw_stop_present':False,'confirmation':False,'identity_verified':True,
                    'marker':'[CLW:'+binding['attempt_id']+']' if hashed else None,
                    'expected_user_hash':hashed,'observed_user_hash':hashed})
        return {'store_id':self.s.state.id,'ledger_fingerprint':revision_hash(ledger_revision(self.s.state.path)),
                'page_bindings':bindings,'exit_mode':'ordinary','paused_carriers':carriers}
    def shutdown(self,proof,**extra):
        return authorize_shutdown(self.s,{'instance_id':proof['instanceId'],'store_id':proof['storeId'],
             'permit_id':proof['permitId'],'ledger_fingerprint':proof['ledgerFingerprint'],'exit_mode':proof['exitMode'],**extra})
    def test_acked_unfinished_processing_write_lease_and_goal_are_preserved_on_ordinary_quit(self):
        page,request,offer,ctx=self.start();before=self.s.state.path.read_bytes()
        proof=readiness(self.s,self.payload())
        self.assertTrue(proof['idle']);self.assertEqual(proof['exitMode'],'ordinary')
        self.assertEqual(proof['jobs']['currentSessionCount'],1)
        self.assertTrue(any(row['code']=='ordinary_paused_browser_carrier' for row in proof['historyAttention']))
        self.assertEqual(self.shutdown(proof)['exitMode'],'ordinary')
        self.assertEqual(self.h.maintenance_exit_fence,proof['permitId'])
        self.assertEqual(before,self.s.state.path.read_bytes())
        with closing(self.s.state.connect()) as db:
            original=db.execute('SELECT * FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual(original['phase'],'processing');self.assertEqual(original['claim_id'],ctx['request']['claim_id'])
            self.assertIsNone(original['finished_at']);self.assertEqual(original['cancel_requested'],0)
            self.assertEqual(db.execute('SELECT active_turn FROM threads WHERE id=?',(original['thread_id'],)).fetchone()[0],request)
            self.assertEqual(db.execute('SELECT state FROM control_attempts WHERE id=?',(offer['attempt_id'],)).fetchone()[0],'acknowledged')
            self.assertIsNone(db.execute('SELECT result_hash FROM control_browser_receipts WHERE attempt_id=?',(offer['attempt_id'],)).fetchone()[0])
            self.assertTrue(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())
            self.assertEqual(db.execute('SELECT state FROM managed_goals WHERE page_id=?',(page,)).fetchone()[0],'active')
    def test_same_ordinary_state_still_blocks_maintenance_upgrade(self):
        self.start();payload=self.payload()
        with self.assertRaisesRegex(HarnessError,'execution_unresolved'):
            readiness(self.s,{k:v for k,v in payload.items() if k not in ('exit_mode','paused_carriers')})
        self.assertEqual(self.transport.calls,[])
    def historical_payload(self,page):
        payload=self.payload()
        return {**payload,'page_bindings':[b for b in payload['page_bindings'] if b['page_id']!=page],
                'paused_carriers':[c for c in payload['paused_carriers'] if c['page_id']!=page]}
    def test_absent_gui_historical_page_retains_acked_processing_claim_and_checks_original_session(self):
        page,request,offer,ctx=self.start()
        with closing(self.s.state.connect()) as db:
            db.execute("UPDATE threads SET active_turn=NULL,status='needs_attention' WHERE id=?",(ctx['request']['thread_id'],));db.commit()
        before=self.s.state.path.read_bytes();payload=self.historical_payload(page)
        proof=readiness(self.s,payload)
        self.assertEqual(proof['jobs']['currentSessionCount'],1)
        row=next(r for r in proof['historyAttention'] if r.get('requestId')==request)
        self.assertEqual(row['code'],'ordinary_paused_historical_page');self.assertEqual(row['pageId'],page)
        self.assertTrue(row['browserDescriptorAbsent'])
        self.assertEqual(self.transport.calls,[])
        self.assertEqual(self.shutdown(proof)['exitMode'],'ordinary');self.assertEqual(before,self.s.state.path.read_bytes())
        with closing(self.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'processing')
            self.assertEqual(db.execute('SELECT state FROM control_attempts WHERE id=?',(offer['attempt_id'],)).fetchone()[0],'acknowledged')
            self.assertTrue(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())
    def test_absent_historical_page_requires_pause_but_leaves_independent_runner_work(self):
        page,_,_,ctx=self.start();self.transport.call_active=True
        self.assertTrue(readiness(self.s,self.historical_payload(page))['idle'])
        self.transport.call_active=False;project,session=self.f.scope_for(ctx['request']['thread_id'])
        self.transport.jobs=[{'job_id':'historical-current-recovery','client_id':'fixture','project':project,'session_id':session,'status':'recovering'}]
        self.assertTrue(readiness(self.s,self.historical_payload(page))['idle'])
        self.transport.jobs=[]
        with closing(self.s.state.connect()) as db:db.execute('UPDATE managed_pages SET paused=0 WHERE page_id=?',(page,));db.commit()
        with self.assertRaisesRegex(HarnessError,'future_not_paused'):readiness(self.s,self.historical_payload(page))
    def test_descriptor_present_without_observation_still_refuses(self):
        self.start();payload=self.payload()
        with self.assertRaisesRegex(HarnessError,'observation_required'):
            readiness(self.s,{**payload,'paused_carriers':[]})
    def test_absent_historical_page_preserves_unknown_dispatch_and_command_without_replay(self):
        page,request,offer,_=self.start()
        for table,key in (('operations',request),('control_attempts',offer['attempt_id'])):
            with self.subTest(table=table),closing(self.s.state.connect()) as db:
                original=db.execute('SELECT state FROM '+table+' WHERE id=?',(key,)).fetchone()[0]
                db.execute('UPDATE '+table+" SET state='unknown' WHERE id=?",(key,));db.commit()
                self.assertTrue(readiness(self.s,self.historical_payload(page))['idle'])
                self.assertEqual(db.execute('SELECT state FROM '+table+' WHERE id=?',(key,)).fetchone()[0],'unknown')
                db.execute('UPDATE '+table+' SET state=? WHERE id=?',(original,key));db.commit()
    def test_evicted_original_session_metadata_is_retained_and_rechecked_before_ordinary_shutdown(self):
        _,_,_,ctx=self.start();project,session=self.f.scope_for(ctx['request']['thread_id'])
        def unavailable(op):
            if op=='detail':raise ObservationError('not_found')
        self.transport.hook=unavailable;before=self.s.state.path.read_bytes()
        proof=readiness(self.s,self.payload())
        self.assertEqual(proof['jobs']['source'],'independent_execution_retained')
        self.assertFalse(proof['jobs']['remoteInventoryRead'])
        self.assertEqual(self.transport.calls,[])
        self.transport.calls.clear();receipt=self.shutdown(proof)
        self.assertEqual(receipt['permitId'],proof['permitId']);self.assertEqual(receipt['exitMode'],'ordinary')
        self.assertEqual(self.transport.calls,[])
        self.assertEqual(before,self.s.state.path.read_bytes())
    def test_shared_runner_connection_problem_does_not_block_a_quiet_desktop_exit(self):
        self.start();before=self.s.state.path.read_bytes()
        for code in ('access_denied','auth_required','upstream_timeout','upstream_unreachable','upstream_invalid'):
            with self.subTest(code=code):
                def unavailable(op):
                    if op=='detail':raise ObservationError(code)
                self.transport.hook=unavailable
                self.assertTrue(readiness(self.s,self.payload())['idle'])
                self.assertEqual(self.transport.calls,[])
                self.assertEqual(before,self.s.state.path.read_bytes())
    def test_late_independent_job_keeps_running_when_desktop_exits(self):
        _,_,_,ctx=self.start();project,session=self.f.scope_for(ctx['request']['thread_id'])
        def unavailable(op):
            if op=='detail':raise ObservationError('not_found')
        self.transport.hook=unavailable;before=self.s.state.path.read_bytes();proof=readiness(self.s,self.payload())
        saved=self.s._maintenance_exit_permit
        self.transport.jobs=[{'job_id':'late-original-recovery','client_id':'fixture','project':project,'session_id':session,'status':'recovering'}]
        self.assertEqual(self.shutdown(proof)['permitId'],proof['permitId'])
        self.assertIs(self.s._maintenance_exit_permit,saved);self.assertEqual(self.h.maintenance_exit_fence,proof['permitId'])
        self.assertEqual(before,self.s.state.path.read_bytes())
    def test_submitted_original_call_and_jobs_belong_to_runner_and_are_retained(self):
        _,_,_,ctx=self.start();self.transport.call_active=True
        self.assertTrue(readiness(self.s,self.payload())['idle'])
        self.transport.call_active=False;project,session=self.f.scope_for(ctx['request']['thread_id'])
        for state in ('running','queued'):
            with self.subTest(state=state):
                self.transport.jobs=[{'job_id':'original-executing-job','client_id':'fixture','project':project,'session_id':session,'status':state}]
                self.assertTrue(readiness(self.s,self.payload())['idle'])
        self.assertEqual(self.transport.calls,[])
    def test_unknown_local_command_and_send_are_retained_without_ack_or_replay(self):
        _,request,offer,ctx=self.start()
        for table,key in (('operations',request),('control_attempts',offer['attempt_id'])):
            with self.subTest(table=table),closing(self.s.state.connect()) as db:
                state=db.execute('SELECT state FROM '+table+' WHERE id=?',(key,)).fetchone()[0]
                db.execute('UPDATE '+table+" SET state='unknown' WHERE id=?",(key,));db.commit()
                before=self.s.state.path.read_bytes();proof=readiness(self.s,self.payload())
                self.assertTrue(proof['idle']);self.assertEqual(self.shutdown(proof)['exitMode'],'ordinary')
                self.assertEqual(before,self.s.state.path.read_bytes())
                self.assertEqual(db.execute('SELECT state FROM '+table+' WHERE id=?',(key,)).fetchone()[0],'unknown')
                db.execute('UPDATE '+table+' SET state=? WHERE id=?',(state,key));db.commit()
                self.h.maintenance_exit_fence=None;self.s._maintenance_exit_permit=None
        self.assertEqual(self.transport.calls,[])
    def test_public_observation_must_be_fresh_quiet_and_identify_original_ack(self):
        self.start();base=self.payload();carrier=base['paused_carriers'][0]
        cases=[('generating',True,'browser_not_quiet'),
               ('composing',True,'browser_not_quiet'),('raw_stop_present',True,'browser_not_quiet'),
               ('confirmation',True,'browser_not_quiet'),('paused',False,'future_not_paused'),
               ('observed_at',time.time()-60,'observation_stale'),('identity_verified',False,'identity_changed'),
               ('marker','[CLW:foreign]','identity_changed'),('observed_user_hash','e'*64,'identity_changed')]
        for field,value,code in cases:
            with self.subTest(field=field),self.assertRaisesRegex(HarnessError,code):
                readiness(self.s,{**base,'paused_carriers':[{**carrier,field:value}]})
        with self.assertRaisesRegex(HarnessError,'observation_required'):readiness(self.s,{**base,'paused_carriers':[]})
        self.assertEqual(self.transport.calls,[])
    def test_local_pause_is_rechecked_and_not_inferred_from_carrier(self):
        page,_,_,_=self.start();payload=self.payload()
        with closing(self.s.state.connect()) as db:db.execute('UPDATE managed_pages SET paused=0 WHERE page_id=?',(page,));db.commit()
        payload['ledger_fingerprint']=revision_hash(ledger_revision(self.s.state.path))
        with self.assertRaisesRegex(HarnessError,'future_not_paused'):readiness(self.s,payload)
    def test_queued_unacknowledged_dispatch_history_does_not_block_a_quiet_exit(self):
        page,request,offer,_=self.start()
        with closing(self.s.state.connect()) as db:
            db.execute('DELETE FROM control_browser_receipts WHERE attempt_id=?',(offer['attempt_id'],))
            db.execute("UPDATE control_attempts SET state='not_sent',acknowledged=NULL WHERE id=?",(offer['attempt_id'],));db.commit()
            self.assertIsNotNone(db.execute('SELECT dispatched FROM control_attempts WHERE id=?',(offer['attempt_id'],)).fetchone()[0])
            db.execute("UPDATE host_requests SET phase='queued' WHERE id=?",(request,));db.commit()
        for state in ('not_sent','dispatching','unknown','sent'):
            with self.subTest(state=state),closing(self.s.state.connect()) as db:
                db.execute('UPDATE control_attempts SET state=? WHERE id=?',(state,offer['attempt_id']));db.commit()
                before=self.s.state.path.read_bytes();proof=readiness(self.s,self.payload())
                self.assertTrue(proof['idle']);self.assertEqual(self.shutdown(proof)['exitMode'],'ordinary')
                self.assertEqual(before,self.s.state.path.read_bytes())
                attempt=db.execute('SELECT * FROM control_attempts WHERE id=?',(offer['attempt_id'],)).fetchone()
                self.assertEqual(attempt['state'],state);self.assertIsNone(attempt['acknowledged'])
                self.assertEqual(db.execute('SELECT count(*) FROM control_browser_receipts WHERE attempt_id=?',(offer['attempt_id'],)).fetchone()[0],0)
                original=db.execute('SELECT * FROM host_requests WHERE id=?',(request,)).fetchone()
                self.assertEqual(original['phase'],'queued');self.assertEqual(original['cancel_requested'],0)
                self.assertIsNone(original['finished_at'])
                self.assertEqual(db.execute('SELECT state FROM managed_goals WHERE page_id=?',(page,)).fetchone()[0],'active')
                self.h.maintenance_exit_fence=None;self.s._maintenance_exit_permit=None
        self.assertEqual(self.transport.calls,[])
    def test_original_empty_host_can_ordinary_quit_without_inventing_external_owner(self):
        fresh=fixtures.EmptyOwnedLedgerMaintenanceTests();fresh.setUp()
        try:
            payload={**fresh.payload(),'exit_mode':'ordinary','paused_carriers':[]}
            before=fresh.s.state.path.read_bytes();proof=readiness(fresh.s,payload)
            receipt=authorize_shutdown(fresh.s,{**fresh.shutdown_payload(proof),'exit_mode':'ordinary'})
            self.assertEqual(receipt['exitMode'],'ordinary');self.assertEqual(proof['jobs']['currentSessionCount'],0)
            self.assertFalse(proof['jobs']['remoteInventoryRead']);self.assertEqual(before,fresh.s.state.path.read_bytes())
        finally:fresh.tearDown()
    def test_actual_desktop_carrier_projection_matches_host_contract(self):
        import hashlib,subprocess
        page,_,offer,_=self.start();user='Original managed public user turn'
        with closing(self.s.state.connect()) as db:
            db.execute('UPDATE control_browser_receipts SET sent_user_hash=? WHERE attempt_id=?',
                       (hashlib.sha256(user.encode()).hexdigest(),offer['attempt_id']));db.commit()
        record=next(row for row in self.h.managed.browser('list',{})['pages'] if row['page_id']==page)
        snapshot={'generating':False,'draft':False,'composing':False,'approvalRequired':False,
                  'rawStopPresent':False,'known':True,'attemptMarker':'[CLW:'+offer['attempt_id']+']',
                  'attemptMarkerCount':1,'historyAtLatest':True,'userId':user}
        code="const m=require('./apps/web-host/maintenance-exit.cjs'),v=JSON.parse(require('node:fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(m.ordinaryCarrier(v.page,v.record,v.snapshot)));"
        result=subprocess.run(['node','-e',code],input=json.dumps({'page':{'id':page},'record':record,'snapshot':snapshot}),
                              cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        payload=self.payload();payload['paused_carriers']=[json.loads(result.stdout)]
        self.assertEqual(readiness(self.s,payload)['exitMode'],'ordinary')
    def test_actual_desktop_unknown_carrier_projection_preserves_original_db(self):
        import subprocess
        page,request,offer,_=self.start()
        with closing(self.s.state.connect()) as db:
            db.execute('DELETE FROM control_browser_receipts WHERE attempt_id=?',(offer['attempt_id'],))
            db.execute("UPDATE control_attempts SET state='unknown',acknowledged=NULL WHERE id=?",(offer['attempt_id'],))
            db.execute("UPDATE host_requests SET phase='queued' WHERE id=?",(request,))
            settings=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0])
            settings['conversation_mode']='direct'
            db.execute("UPDATE managed_pages SET phase='bound',url='https://chatgpt.com/',settings=? WHERE page_id=?",(json.dumps(settings),page));db.commit()
        record=next(row for row in self.h.managed.browser('list',{})['pages'] if row['page_id']==page)
        code=r'''
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {WorkspaceState,restoreConversationUrl}=require('./apps/web-host/workspace-state.cjs'),maintenanceExit=require('./apps/web-host/maintenance-exit.cjs');
const record=JSON.parse(fs.readFileSync(0,'utf8')),id=record.page_id,url='https://chatgpt.com/c/accepted-original',folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-ordinary-reading-'));
try{
 const state=new WorkspaceState(folder,u=>u.startsWith('https://chatgpt.com/'));
 state.update(id,{account:record.account,url:record.url,goal:{objective:'Original complete goal',state:'active'}});
 state.pendingStarts[id]={state:'unknown',operation_id:'original-send-key'};
 state.capture({selected:id,inspect:()=>[{id,account:record.account,url}]},new Map([[id,record]]));
 state.capture({selected:id,inspect:()=>[{id,account:record.account,url:record.url}]},new Map([[id,record]]));state.save();
 const workspace=new WorkspaceState(folder,u=>u.startsWith('https://chatgpt.com/')),actual=restoreConversationUrl(record,workspace.tasks.get(id));
 const contents={id:1,getURL:()=>actual,isDestroyed:()=>false},page={id,account:record.account,url:actual,view:{webContents:contents},documentGeneration:1};
 const pool={pages:new Map([[id,page]])},driver={records:new Map([[id,record]])};
 const snapshot={url:actual,editor:true,controlKnown:true,generating:false,draft:false,composing:false,approvalRequired:false,rawStopPresent:false,known:true,attemptMarker:null,attemptMarkerCount:0,userId:''};
 const before=JSON.stringify([record,[...workspace.tasks],workspace.pendingStarts]),saved=fs.readFileSync(workspace.file);
 const source=fs.readFileSync('./apps/web-host/main.cjs','utf8'),start=source.indexOf('async function quitPageObservations('),end=source.indexOf('async function pauseOrdinaryQuitFuture(',start);
 const observe=vm.runInNewContext('(function(){'+source.slice(start,end)+';return quitPageObservations;})()',{
  driver,pool,workspace,restoreConversationUrl,maintenanceExit,loaded:()=>true,runDom:async()=>snapshot,
  pausedUnsentQuitPage:async()=>{throw Error('accepted original must not require a never-sent offer');}});
 const carriers=[];
 observe([{page,owner:pool,view:page.view,contents,url:actual,documentGeneration:1}],()=>{},{original:{ordinaryExit:true},carriers}).then(()=>{
  process.stdout.write(JSON.stringify({carriers,bindings:maintenanceExit.pageBindings(driver,pool),actual,
   preserved:before===JSON.stringify([record,[...workspace.tasks],workspace.pendingStarts])&&saved.equals(fs.readFileSync(workspace.file))}));
 }).finally(()=>fs.rmSync(folder,{recursive:true,force:true})).catch(e=>{console.error(e.message);process.exitCode=1;});
}catch(e){fs.rmSync(folder,{recursive:true,force:true});throw e;}
'''
        result=subprocess.run(['node','-e',code],input=json.dumps(record),
                              cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        projection=json.loads(result.stdout);self.assertTrue(projection['preserved'])
        self.assertEqual(projection['actual'],'https://chatgpt.com/c/accepted-original')
        self.assertEqual(projection['bindings'][0]['url'],'https://chatgpt.com/')
        payload=self.payload();payload['page_bindings']=projection['bindings'];payload['paused_carriers']=projection['carriers']
        self.assertIsNone(payload['paused_carriers'][0]['marker'])
        before=self.s.state.path.read_bytes();proof=readiness(self.s,payload)
        self.assertEqual(self.shutdown(proof)['exitMode'],'ordinary')
        self.assertEqual(before,self.s.state.path.read_bytes());self.assertEqual(self.transport.calls,[])
    def test_same_permit_can_refresh_after_slow_native_exit_but_cannot_change_mode_or_carrier(self):
        self.start();payload=self.payload();proof=readiness(self.s,payload)
        saved=self.s._maintenance_exit_permit
        # Native already exited; renew DOM time in the same exit intent rather
        # than requiring an impossible fresh Native permit from a gone owner.
        saved['payload']['paused_carriers'][0]['observed_at']-=60
        with self.assertRaisesRegex(HarnessError,'observation_stale'):self.shutdown(proof)
        fresh=readiness(self.s,{**self.payload(),'permit_id':proof['permitId']})
        self.assertEqual(fresh['permitId'],proof['permitId'])
        for field,value in (('permit_id','f'*32),('exit_mode','maintenance')):
            with self.subTest(field=field),self.assertRaises(HarnessError):
                readiness(self.s,{**self.payload(),'permit_id':proof['permitId'],field:value})
        with self.assertRaisesRegex(HarnessError,'original_receipt'):self.shutdown(fresh,exit_mode='maintenance')
        self.assertEqual(self.shutdown(fresh)['permitId'],proof['permitId'])
    def test_shutdown_retains_late_original_jobs_and_the_same_permit(self):
        _,_,_,ctx=self.start();proof=readiness(self.s,self.payload());saved=self.s._maintenance_exit_permit
        project,session=self.f.scope_for(ctx['request']['thread_id'])
        self.transport.jobs=[{'job_id':'late-original-job','client_id':'fixture','project':project,'session_id':session,'status':'running'}]
        self.assertEqual(self.shutdown(proof)['permitId'],proof['permitId'])
        self.assertIs(self.s._maintenance_exit_permit,saved);self.assertEqual(self.h.maintenance_exit_fence,proof['permitId'])
    def test_local_claim_change_after_original_read_cannot_rebase_permit(self):
        _,request,_,_=self.start()
        proof=readiness(self.s,self.payload())
        with closing(self.s.state.connect()) as db:
            db.execute("UPDATE host_requests SET claim_id='different-original-claim' WHERE id=?",(request,));db.commit()
        with self.assertRaisesRegex(HarnessError,'store_changed'):self.shutdown(proof)
    def test_disabled_manual_receivers_keep_queued_and_yielded_requests_and_check_current_sessions(self):
        parent,_,child,_=self.f.manual_waiting_receivers()
        before=self.s.state.path.read_bytes();proof=readiness(self.s,self.payload())
        self.assertEqual(proof['jobs']['currentSessionCount'],2)
        self.assertTrue(all(row['code']=='ordinary_paused_manual_receiver' for row in proof['historyAttention']))
        self.assertEqual(before,self.s.state.path.read_bytes())
    def test_historical_run_and_bad_history_binding_are_not_current_session_calls(self):
        self.start()
        with closing(self.s.state.connect()) as db:
            db.execute("INSERT INTO host_requests(id,thread_id,text,phase,created_at,finished_at) VALUES('old-request','old-thread','Historical unfinished business','blocked','old','old')")
            run=dict(db.execute('SELECT * FROM host_runs LIMIT 1').fetchone())
            run.update(id='old-run',controller_thread='old-thread',controller_request='old-request')
            columns=list(run);db.execute('INSERT INTO host_runs('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',tuple(run.values()))
            db.execute("INSERT INTO control_attempts VALUES('old-ack','old-request','old-thread',0,1,'acknowledged',?,1,2,3)",('d'*64,))
            db.execute("INSERT INTO host_bindings(target_id,thread_id,spec,enabled) VALUES('old-target','old-thread','{}',0)");db.commit()
        proof=readiness(self.s,self.payload())
        self.assertEqual(proof['jobs']['currentSessionCount'],1)
        self.assertTrue(any(row['code']=='historical_binding_unavailable' for row in proof['historyAttention']))
    def test_old_run_history_is_not_a_lifetime_exit_limit(self):
        self.start()
        with closing(self.s.state.connect()) as db:
            original=dict(db.execute('SELECT * FROM host_runs LIMIT 1').fetchone());columns=list(original)
            runs=[];requests=[]
            for n in range(1025):
                request='history-request-'+str(n)
                requests.append((request,'historical-thread','Retained unfinished history','blocked','old','old'))
                runs.append(tuple({**original,'id':'history-run-'+str(n),'controller_thread':'historical-thread','controller_request':request}.values()))
            db.executemany('INSERT INTO host_requests(id,thread_id,text,phase,created_at,finished_at) VALUES(?,?,?,?,?,?)',requests)
            db.executemany('INSERT INTO host_runs('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',runs);db.commit()
        proof=readiness(self.s,self.payload())
        self.assertEqual(proof['jobs']['currentSessionCount'],1);self.assertTrue(proof['historyAttentionSummary']['truncated'])

class OrdinaryIntegrityPolicyTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.EmptyOwnedLedgerMaintenanceTests();self.f.setUp()
        self.s,self.h=self.f.s,self.f.s.host_bridge
    def tearDown(self):self.f.tearDown()
    def payload(self,mode='ordinary'):
        payload=self.f.payload()
        return {**payload,'exit_mode':mode,'paused_carriers':[]} if mode=='ordinary' else payload
    def sqlite_policy(self,checks,*,deny_integrity=False,deny_metadata=False):
        def connect(*args,**kwargs):
            db=sqlite3.connect(*args,**kwargs)
            def authorize(action,first,second,*_):
                if action==sqlite3.SQLITE_PRAGMA and first.lower()=='quick_check':
                    checks.append(first)
                    if deny_integrity:return sqlite3.SQLITE_DENY
                if deny_metadata and action==sqlite3.SQLITE_READ and first=='metadata':return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            db.set_authorizer(authorize)
            return db
        # Keep the fixture's own SQLite connections outside this policy.
        return patch('maintenance_exit_readiness.sqlite3',SimpleNamespace(
            connect=connect,Row=sqlite3.Row,Error=sqlite3.Error))
    def test_ordinary_quit_does_not_run_whole_ledger_integrity_scan(self):
        payload=self.payload();before=self.s.state.path.read_bytes();checks=[]
        with self.sqlite_policy(checks,deny_integrity=True):proof=readiness(self.s,payload)
        self.assertTrue(proof['idle']);self.assertEqual(checks,[])
        self.assertEqual(before,self.s.state.path.read_bytes())
    def test_maintenance_still_requires_the_integrity_scan(self):
        payload=self.payload('maintenance');before=self.s.state.path.read_bytes();checks=[]
        with self.sqlite_policy(checks,deny_integrity=True):
            with self.assertRaisesRegex(HarnessError,'maintenance_ledger_unavailable'):readiness(self.s,payload)
        self.assertEqual(checks,['quick_check']);self.assertIsNone(self.h.maintenance_exit_fence)
        self.assertEqual(before,self.s.state.path.read_bytes())
    def test_ordinary_current_host_operation_remains_blocking(self):
        payload=self.payload();before=self.s.state.path.read_bytes();checks=[]
        self.h.active_business_operations=1
        try:
            with self.sqlite_policy(checks,deny_integrity=True):
                with self.assertRaisesRegex(HarnessError,'maintenance_original_execution_unresolved') as raised:
                    readiness(self.s,payload)
            self.assertEqual(raised.exception.blockers,[{'kind':'host_operation','active_count':1}])
            self.assertEqual(checks,[]);self.assertIsNone(self.h.maintenance_exit_fence)
            self.assertEqual(before,self.s.state.path.read_bytes())
        finally:self.h.active_business_operations=0
    def test_ordinary_sqlite_read_error_is_not_bypassed(self):
        payload=self.payload();before=self.s.state.path.read_bytes();checks=[]
        with self.sqlite_policy(checks,deny_metadata=True):
            with self.assertRaisesRegex(HarnessError,'maintenance_ledger_unavailable'):readiness(self.s,payload)
        self.assertEqual(checks,[]);self.assertIsNone(self.h.maintenance_exit_fence)
        self.assertEqual(before,self.s.state.path.read_bytes())

if __name__=='__main__':unittest.main()
