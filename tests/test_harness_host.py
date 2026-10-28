"""Project Host protocol tests. No actual ChatGPT or native communication calls."""
from pathlib import Path
from contextlib import closing
import copy,http.client,json,os,sqlite3,sys,tempfile,threading,unittest,uuid
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from harness_service import HarnessService
from harness_state import HarnessError,public
from harness_host import read_local_key,PROVIDER
from harness_host_client import Client
from harness_http import HarnessHTTP
from serve_control_center import create_server
from test_harness_service import FakeConnection
from test_harness_web import CONFIG,FakeBridge

def uid():return str(uuid.uuid4())
class HostTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.native=FakeBridge();self.native.denied=True
        self.s=HarnessService(self.root,self.root/'state',connection_factory=FakeConnection,web_targets=copy.deepcopy(CONFIG),web_bridge=self.native)
        self.key=read_local_key(self.root/'state');self.session=CONFIG['targets'][0]['session_id'];self.claim=uid()
    def tearDown(self):self.s.close();self.tmp.cleanup()
    def private(self,action,**kw):return self.s.host_bridge.private(self.key,dict(action=action,store_id=self.s.state.id,target_id='main',session_id=self.session,**kw))
    def register(self):return self.private('register',confirm=True)['thread']
    def cmd(self,action,row,data=None,request_id=None):return self.s.command({'request_id':request_id or uid(),'action':action,'thread_id':row['id'],'data':data or {}})
    def send(self,row,text='真实要求',key=None):return self.cmd('message.send',row,{'text':text},key)
    def accept(self,request):return self.private('claim',request_id=request['request_id'],claim_id=self.claim)
    def reply(self,request,status='completed',text='公开测试结果',reply_id=None):return self.private('reply',request_id=request['request_id'],claim_id=self.claim,reply_id=reply_id or uid(),status=status,text=text)
    def test_registration_not_native_scope_repair_or_codex(self):
        row=self.register();self.assertEqual(row['provider'],PROVIDER);self.assertIsNone(self.s.connection);self.assertEqual(self.native.checks,0);self.assertEqual(self.native.posts,[])
    def test_register_reuses_original_binding(self):
        row=self.register();self.assertEqual(self.register()['id'],row['id']);self.assertEqual(len(self.s.state.listing()),1)
    def test_private_key_not_public_and_redacted(self):
        self.register();self.assertNotIn(self.key,json.dumps(self.s.info()));self.assertNotIn(self.key,json.dumps(self.s.host_bridge.snapshot()));self.assertEqual(public(self.key),'[redacted]')
    def test_wrong_process_key_rejected(self):
        with self.assertRaises(HarnessError):self.s.host_bridge.private('bad',{})
    def test_wrong_store_or_session_rejected(self):
        for field,value in [('store_id','other'),('session_id','wc_sess_wrong_sessionx')]:
            d=dict(action='register',store_id=self.s.state.id,target_id='main',session_id=self.session,confirm=True);d[field]=value
            with self.assertRaises(HarnessError):self.s.host_bridge.private(self.key,d)
    def test_no_browser_register_command(self):
        with self.assertRaises(HarnessError):self.s.command({'request_id':uid(),'action':'host.register','data':{}})
    def test_confirm_is_required_and_no_scope_fallback(self):
        with self.assertRaises(HarnessError):self.private('register',confirm=False)
        self.assertEqual(self.native.posts,[])
    def test_send_poll_claim_reply_distinct(self):
        row=self.register();r=self.send(row);self.assertEqual(r['state'],'queued_for_web_host')
        polled=self.private('poll',wait_key=uid());self.assertTrue(polled['available']);self.assertFalse(polled['claim_performed'])
        self.assertEqual(self.private('read',request_id=r['request_id'])['phase'],'queued')
        claimed=self.accept(r);self.assertFalse(claimed['already_claimed']);self.assertEqual(claimed['text'],'真实要求')
        self.reply(r,'progress');self.assertEqual(self.s.state.thread(row['id'])['status'],'processing')
        self.reply(r);self.assertEqual(self.s.state.thread(row['id'])['status'],'idle');self.assertEqual(self.native.posts,[])
    def test_duplicate_send_preserves_one_request(self):
        row=self.register();key=uid();a=self.send(row,key=key);b=self.send(row,key=key);self.assertEqual(a,b)
        with closing(self.s.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests').fetchone()[0],1)
    def test_changed_send_id_conflicts(self):
        row=self.register();key=uid();self.send(row,key=key)
        with self.assertRaises(HarnessError):self.send(row,'其他要求',key)
    def test_duplicate_claim_is_recovery_not_new_work(self):
        r=self.send(self.register());self.accept(r);a=self.accept(r);self.assertTrue(a['already_claimed']);self.assertEqual(a['execution'],'recover_original_do_not_repeat')
    def test_legacy_claim_holds_shared_write_lock_across_busy_and_processing_update(self):
        row=self.register();request=self.send(row)
        host=self.s.host_bridge
        original_busy=host.collaboration.busy
        original_emit=host.emit
        observed=[]
        def other_writer_is_blocked():
            with closing(sqlite3.connect(self.s.state.path,timeout=0)) as competing:
                with self.assertRaisesRegex(sqlite3.OperationalError,'locked'):
                    competing.execute('BEGIN IMMEDIATE')
        def check_busy(db,thread,git_probe=None,held_request_id=None):
            self.assertTrue(db.in_transaction)
            self.assertEqual(held_request_id,request['request_id'])
            other_writer_is_blocked()
            observed.append('busy')
            return original_busy(db,thread,git_probe=git_probe,held_request_id=held_request_id)
        def check_emit(db,thread,kind,data):
            if kind=='host_claimed':
                self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',
                                            (request['request_id'],)).fetchone()[0],'processing')
                with closing(sqlite3.connect(self.s.state.path,timeout=0)) as outside:
                    self.assertEqual(outside.execute('SELECT phase FROM host_requests WHERE id=?',
                                                     (request['request_id'],)).fetchone()[0],'queued')
                other_writer_is_blocked()
                observed.append('processing_update')
            return original_emit(db,thread,kind,data)
        with patch.object(host.collaboration,'busy',side_effect=check_busy),\
             patch.object(host,'emit',side_effect=check_emit):
            self.assertFalse(self.accept(request)['already_claimed'])
        self.assertEqual(observed,['busy','processing_update'])
        with closing(sqlite3.connect(self.s.state.path,timeout=0)) as competing:
            competing.execute('BEGIN IMMEDIATE')
            competing.rollback()
        from native_work_admission import request as reserve_native
        result=self.root/'native-after-claim';result.mkdir()
        claim=reserve_native(self.s.state.path,workspace=str(self.root),result_path=str(result),owner_pid=123456)
        self.assertEqual(claim['state'],'queued')
    def test_foreign_claim_or_unclaimed_reply_rejected(self):
        r=self.send(self.register())
        with self.assertRaises(HarnessError):self.reply(r)
        self.accept(r)
        with self.assertRaises(HarnessError):self.private('claim',request_id=r['request_id'],claim_id=uid())
    def test_reply_dedup_and_conflict(self):
        r=self.send(self.register());self.accept(r);key=uid();a=self.reply(r,reply_id=key);self.assertEqual(a,self.reply(r,reply_id=key))
        with self.assertRaises(HarnessError):self.reply(r,text='改动',reply_id=key)
    def test_old_reply_cannot_finish_new_request(self):
        row=self.register();old=self.send(row);self.accept(old);self.reply(old);new=self.send(row)
        with self.assertRaises(HarnessError):self.reply(old)
        self.assertEqual(self.s.state.thread(row['id'])['active_turn'],new['request_id'])
    def test_completed_goal_next_send_names_native_holder_and_resumes_after_reconciliation(self):
        from native_work_admission import request, start
        from native_work_interruption import recover_interrupted
        from harness_team_scopes import plain_root
        row=self.register();old=self.send(row);self.accept(old);self.reply(old)
        root=plain_root(str(self.root));stat=self.root.stat()
        with closing(self.s.state.connect()) as db:
            db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?,?,?,?,?,?)',
                (row['id'],'fixture',root,'write','["."]','[]','fixture','operator',stat.st_dev,stat.st_ino))
            db.commit()
        result=self.root/'tenet-diagnostic';result.mkdir()
        claim=request(self.s.state.path,workspace=root,result_path=str(result),owner_pid=123456)
        start(self.s.state.path,claim['claim_id'],123456)
        rejected=self.send(row,'next goal')
        self.assertEqual(rejected['state'],'rejected')
        self.assertEqual(rejected['blocker']['claim_id'],claim['claim_id'])
        self.assertEqual(rejected['blocker']['result_path'],plain_root(str(result)))
        with closing(self.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests').fetchone()[0],1)
        recover_interrupted(self.s.state.path,result,owner_probe=lambda _:False,
            process_probe=lambda *_:True,runtime_probe=lambda:True,
            evidence_probe=lambda _:{'thread':'fixture','eventsSha256':'fixed'})
        next_request=self.send(row,'next goal',key=uid())
        self.assertEqual(next_request['state'],'queued_for_web_host')
        self.assertEqual(self.private('read',request_id=old['request_id'])['phase'],'completed')
        self.assertEqual(self.native.posts,[])

    def test_pause_holds_unclaimed_original_until_explicit_resume(self):
        row=self.register();r=self.send(row);self.cmd('host.pause',row)
        with self.assertRaises(HarnessError):self.accept(r)
        self.assertEqual(self.private('read',request_id=r['request_id'])['phase'],'queued')
        self.cmd('host.resume',row);self.assertEqual(self.private('poll',wait_key=uid())['request_id'],r['request_id'])
    def test_pause_processing_is_not_fake_native_interrupt(self):
        row=self.register();r=self.send(row);self.accept(r);result=self.cmd('host.pause',row)
        self.assertFalse(result['native_execution_stopped']);self.assertFalse(self.private('read',request_id=r['request_id'])['cancel_requested']);self.assertEqual(self.s.state.thread(row['id'])['status'],'processing')
    def test_result_cannot_undo_user_pause(self):
        row=self.register();r=self.send(row);self.accept(r);self.cmd('host.pause',row);self.reply(r)
        self.assertEqual(self.s.state.thread(row['id'])['status'],'host_paused')
        self.assertEqual(self.send(row)['code'],'host_paused')
        self.cmd('host.resume',row);self.assertEqual(self.s.state.thread(row['id'])['status'],'idle')
    def test_idle_pause_is_visible_before_any_send(self):
        row=self.register();self.cmd('host.pause',row);self.assertEqual(self.s.state.thread(row['id'])['status'],'host_paused')
    def test_unknown_codex_send_keeps_workspace_guard(self):
        row=self.register();c=self.s.command({'request_id':uid(),'action':'thread.create','data':{}})['thread'];self.s.connection.unknown_send=True
        self.cmd('message.send',c,{'text':'uncertain'});self.s.state.update(c['id'],status='idle')
        self.assertEqual(self.send(row)['code'],'workspace_has_unresolved_send')
    def test_no_fake_fork_steer_or_stop(self):
        row=self.register()
        for action in ('thread.fork','message.steer','turn.stop'):
            self.assertEqual(self.cmd(action,row)['code'],'host_control_not_supported_no_provider_fallback')
        self.assertIsNone(self.s.connection)
    def test_single_waiter_and_expiry_is_not_work_replay(self):
        self.register();clock=[100.0];self.s.host_bridge.clock=lambda:clock[0];a=uid();self.private('poll',wait_key=a)
        with self.assertRaises(HarnessError):self.private('poll',wait_key=uid())
        clock[0]=131.;b=uid();self.private('poll',wait_key=b);self.private('release-wait',wait_key=a)
        with self.assertRaises(HarnessError):self.private('poll',wait_key=uid())
    def test_same_root_codex_is_blocked_by_waiting_web(self):
        row=self.register();self.send(row)
        c=self.s.command({'request_id':uid(),'action':'thread.create','data':{}})['thread']
        result=self.cmd('message.send',c,{'text':'not concurrent'});self.assertEqual(result['code'],'workspace_busy_or_unreconciled')
    def test_same_root_web_is_blocked_by_codex(self):
        row=self.register();c=self.s.command({'request_id':uid(),'action':'thread.create','data':{}})['thread'];self.cmd('message.send',c,{'text':'code'})
        self.assertEqual(self.send(row)['code'],'workspace_busy_or_unreconciled')
    def test_remote_web_pending_blocks_local_host(self):
        row=self.register();other=self.s.state.bind('other','other',self.root,provider='native_web');self.s.state.update(other['id'],status='web_waiting')
        self.assertEqual(self.send(row)['code'],'workspace_busy_or_unreconciled')
    def test_host_configuration_cannot_reassign_old_request(self):
        row=self.register();r=self.send(row);self.s.host_bridge.targets['main']['session_id']='wc_sess_other_session'
        with self.assertRaises(HarnessError):self.accept(r)
    def test_restart_keeps_request_claim_key_and_original_data(self):
        row=self.register();r=self.send(row);self.accept(r);store=self.s.state.id;self.s.close()
        self.s=HarnessService(self.root,self.root/'state',connection_factory=FakeConnection,web_targets=copy.deepcopy(CONFIG),web_bridge=self.native)
        self.assertEqual(self.s.state.id,store);self.assertEqual(read_local_key(self.root/'state'),self.key)
        self.assertTrue(self.accept(r)['already_claimed']);self.assertEqual(self.s.state.thread(row['id'])['native_id'],row['native_id'])
    def test_malformed_private_body_no_mutation(self):
        self.register()
        with self.assertRaises(HarnessError):self.private('poll',wait_key=uid(),command='shell')
    def test_http_private_boundary_and_client_roundtrip(self):
        server=create_server(0);server.harness_api=HarnessHTTP(self.s);thread=threading.Thread(target=server.serve_forever);thread.start();port=server.server_address[1];origin='http://127.0.0.1:'+str(port)
        try:
            c=http.client.HTTPConnection('127.0.0.1',port,timeout=5);body=json.dumps({'action':'register','store_id':self.s.state.id,'target_id':'main','session_id':self.session,'confirm':True})
            c.request('POST','/api/harness/host-control',body,{'Origin':origin,'Content-Type':'application/json','X-CLW-Intent':self.s.intent});response=c.getresponse();self.assertEqual(response.status,403);response.read();c.close()
            client=Client(origin,self.root/'state',self.s.state.id,'main',self.session)
            row=client.call('register',confirm=True)['thread'];r=self.send(row);claimed=client.call('claim',request_id=r['request_id'],claim_id=self.claim)
            self.assertEqual(claimed['phase'],'processing');self.assertEqual(self.native.posts,[])
        finally:server.shutdown();server.server_close();thread.join()
class PausedManagedWaitAdmissionTests(unittest.TestCase):
    def setUp(self):
        import test_harness_managed
        from test_harness_control_plane import PAGE
        self.f=test_harness_managed.ManagedTests();self.f.setUp();self.h=self.f.h
        self.old,self.binding=self.f.enroll(access='write',write_paths=['.'])
        self.new,self.new_binding=self.f.enroll(access='write',write_paths=['.'])
        self.original=self.f.f.command(self.binding['thread_id'],'message.send',{'text':'Original held work'})['request_id']
        offer=self.f.wire(self.old,'pulse');self.attempt=offer['attempt_id']
        self.f.wire(self.old,'dispatch',attempt_id=self.attempt)
        self.f.wire(self.old,'sent',attempt_id=self.attempt,
                    page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True},
                    assistant_before_hash='c'*64)
        context=self.f.private(self.old,'context',{})
        self.run=context['run']['id'];self.claim=context['request']['claim_id']
        # Exercise the same ended-turn wait transition used by the managed carrier.
        with closing(self.h.state.connect()) as db:
            actor=self.h.binding(db,thread=self.binding['thread_id'])
            self.h.team.wait(db,actor,{'run_id':self.run,'claim_id':self.claim,'after_seq':0,'mode':'all'},
                             browser_turn_ended=True)
            db.commit()
        self.h.private(self.f.f.key,{'action':'team','store_id':self.h.state.id,'target_id':self.old,
            'session_id':self.f.sessions[self.old],'op':'pause','operation_id':uid(),
            'payload':{'run_id':self.run,'reason':'Preserve the original held work'}})
        self.f.m.browser('pause',{'page_id':self.old,'paused':True})

    def tearDown(self):self.f.tearDown()

    def edit(self,sql,args=()):
        with closing(self.h.state.connect()) as db:db.execute(sql,args);db.commit()

    def old_state(self):
        with closing(self.h.state.connect()) as db:
            return {name:[tuple(row) for row in db.execute(sql,args)] for name,sql,args in (
                ('page','SELECT * FROM managed_pages WHERE page_id=?',(self.old,)),
                ('pause','SELECT * FROM managed_pause_owners WHERE page_id=?',(self.old,)),
                ('request','SELECT * FROM host_requests WHERE id=?',(self.original,)),
                ('thread','SELECT * FROM threads WHERE id=?',(self.binding['thread_id'],)),
                ('run','SELECT * FROM host_runs WHERE id=?',(self.run,)),
                ('lease','SELECT * FROM host_team_leases WHERE thread_id=?',(self.binding['thread_id'],)),
                ('attempt','SELECT * FROM control_attempts WHERE thread_id=? ORDER BY id',(self.binding['thread_id'],)),
                ('receipt','SELECT * FROM control_browser_receipts WHERE thread_id=? ORDER BY attempt_id',(self.binding['thread_id'],)),
            )}

    def submit(self):
        return self.f.f.command(self.new_binding['thread_id'],'message.send',{'text':'Complete the independently authorized next goal.'})

    def assert_blocked_without_changing_old_work(self):
        before=self.old_state();result=self.submit()
        self.assertEqual(result['state'],'rejected',result)
        self.assertEqual(result['code'],'workspace_busy_or_unreconciled')
        self.assertEqual(self.old_state(),before)
        with closing(self.h.state.connect()) as db:
            self.assertFalse(db.execute('SELECT 1 FROM host_requests WHERE thread_id=?',(self.new_binding['thread_id'],)).fetchone())

    def assert_permitted_without_changing_old_work(self):
        before=self.old_state();result=self.submit()
        self.assertEqual(result['state'],'queued_for_web_host',result)
        self.assertEqual(self.old_state(),before)
        with closing(self.h.state.connect()) as db:
            old=db.execute('SELECT phase,claim_id,cancel_requested FROM host_requests WHERE id=?',(self.original,)).fetchone()
            self.assertEqual(tuple(old),('suspended',self.claim,0))
            self.assertEqual(db.execute('SELECT state FROM host_runs WHERE id=?',(self.run,)).fetchone()[0],'paused')
        self.assertIsNone(self.f.f.s.connection);self.assertEqual(self.f.f.bridge.posts,[])

    def test_paused_quiet_waiting_children_allows_next_goal_and_preserves_original(self):
        self.assert_permitted_without_changing_old_work()

    def test_paused_quiet_waiting_allows_next_goal_and_preserves_original(self):
        self.edit("UPDATE threads SET status='waiting' WHERE id=?",(self.binding['thread_id'],))
        self.assert_permitted_without_changing_old_work()

    def test_unpaused_waiting_remains_a_conflicting_scope(self):
        self.edit('UPDATE managed_pages SET paused=0 WHERE page_id=?',(self.old,))
        self.assert_blocked_without_changing_old_work()

    def test_missing_scope_or_unbound_page_cannot_use_quiet_pause_exception(self):
        self.edit("UPDATE managed_pages SET phase='receiver_enrolled' WHERE page_id=?",(self.old,))
        self.assert_blocked_without_changing_old_work()
        self.edit("UPDATE managed_pages SET phase='bound' WHERE page_id=?",(self.old,))
        self.edit('DELETE FROM host_team_scopes WHERE thread_id=?',(self.binding['thread_id'],))
        self.assert_blocked_without_changing_old_work()

    def test_processing_or_retained_lease_still_blocks_even_when_page_is_paused(self):
        self.edit("UPDATE host_requests SET phase='processing' WHERE id=?",(self.original,))
        self.assert_blocked_without_changing_old_work()
        self.edit("UPDATE host_requests SET phase='suspended' WHERE id=?",(self.original,))
        with closing(self.h.state.connect()) as db:
            scope=self.h.team.scopes.scope(db,self.binding['thread_id'])
        self.edit('INSERT INTO host_team_leases VALUES(?,?,?,?,?,?,?)',
                  (self.original,self.run,self.binding['thread_id'],scope['root'],'write','[]',self.h.clock()))
        self.assert_blocked_without_changing_old_work()

    def test_uncertain_send_or_operation_keeps_original_write_fence(self):
        for state in ('dispatching','sent','unknown'):
            with self.subTest(send_state=state):
                self.edit('UPDATE control_attempts SET state=? WHERE id=?',(state,self.attempt))
                self.assert_blocked_without_changing_old_work()
        self.edit("UPDATE control_attempts SET state='acknowledged' WHERE id=?",(self.attempt,))
        for state in ('reserved','dispatching','unknown'):
            with self.subTest(operation_state=state):
                operation=uid()
                self.edit('INSERT INTO operations VALUES(?,?,?,?,?,?,?)',
                          (operation,'fixture-uncertain','team.fixture',self.binding['thread_id'],state,None,'fixture'))
                self.assert_blocked_without_changing_old_work()
                self.edit('DELETE FROM operations WHERE id=?',(operation,))

    def test_native_same_root_guard_is_not_relaxed_for_a_quiet_paused_page(self):
        from native_work_admission import request as reserve_native
        result_path=self.f.f.root/'native-result';result_path.mkdir()
        claim=reserve_native(self.h.state.path,workspace=str(self.f.f.root),result_path=str(result_path),owner_pid=os.getpid())
        self.assertEqual(claim['state'],'reserved')
        self.assert_blocked_without_changing_old_work()

if __name__=='__main__':unittest.main(verbosity=2)
