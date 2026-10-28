"""Shared original Host admission, real isolated SQLite and program concurrency."""
from contextlib import closing
from unittest.mock import patch
import json,threading,unittest,uuid
import test_maintenance_exit_readiness as fixtures
from maintenance_exit_readiness import authorize_shutdown,ledger_revision,revision_hash
from harness_state import HarnessError

class HostAdmissionTests(unittest.TestCase):
    def setUp(self):
        # This fixture uses the production-shaped journal path but has no
        # installed watcher script. Observe its wake request without spawning
        # a child whose cwd would outlive the isolated temporary directory.
        watcher=patch('harness_goal_watch.start_if_enabled')
        self.start_watch=watcher.start();self.addCleanup(watcher.stop)
        self.f=fixtures.MaintenanceReadinessTests();self.f.setUp();self.s=self.f.s;self.h=self.f.h
    def tearDown(self):self.f.tearDown()
    def seal(self):
        proof=self.f.read();authorize_shutdown(self.s,self.f.shutdown_payload(proof));return proof
    def test_final_seal_blocks_every_new_business_before_any_ledger_reservation(self):
        self.f.paused_attention();proof=self.seal();before=revision_hash(ledger_revision(self.s.state.path))
        calls=[lambda:self.s.command({'request_id':str(uuid.uuid4()),'action':'message.send','data':{'text':'must not be reserved'}}),
               lambda:self.h.private(self.h._key,{'action':'join'}),lambda:self.h.managed.private({'op':'create'}),
               lambda:self.h.managed.browser('reserve',{}),lambda:self.h.control.process('invalid',None,{'action':'pulse'}),
               lambda:self.h.control.private({}, {'action':'control-code'}),lambda:self.h.recovery.wire('invalid',None,{'action':'observe'})]
        for call in calls:
            with self.assertRaisesRegex(HarnessError,'host_shutdown_pending'):call()
            self.assertEqual(self.h.active_business_operations,0);self.assertEqual(revision_hash(ledger_revision(self.s.state.path)),before)
        self.assertEqual(self.h.maintenance_exit_fence,proof['permitId'])
    def test_admitted_command_held_before_state_begin_prevents_seal_and_keeps_original_permit(self):
        page,request,offer,ctx=self.f.paused_attention();proof=self.f.read();saved=self.s._maintenance_exit_permit
        entered=threading.Event();release=threading.Event();results=[];original=self.s.state.begin
        def held(*args):entered.set();self.assertTrue(release.wait(2));return original(*args)
        def command():
            try:results.append(self.s.command({'request_id':str(uuid.uuid4()),'action':'host.pause','thread_id':ctx['request']['thread_id'],'data':{}}))
            except Exception as error:results.append(error)
        with patch.object(self.s.state,'begin',held):
            thread=threading.Thread(target=command);thread.start()
            try:
                self.assertTrue(entered.wait(1));self.assertEqual(self.h.active_business_operations,1)
                with self.assertRaisesRegex(HarnessError,'execution_unresolved'):authorize_shutdown(self.s,self.f.shutdown_payload(proof))
                self.assertIs(self.s._maintenance_exit_permit,saved);self.assertIsNone(self.h.maintenance_exit_fence)
            finally:release.set();thread.join(2)
        self.assertFalse(thread.is_alive());self.assertEqual(self.h.active_business_operations,0);self.assertEqual(len(results),1)
        self.assertIsInstance(results[0],dict)
    def test_nested_exception_restores_original_count_without_releasing_a_sealed_fence(self):
        with self.assertRaisesRegex(ValueError,'original failure'):
            with self.h.business_admission():
                with self.h.business_admission():self.assertEqual(self.h.active_business_operations,2);raise ValueError('original failure')
        self.assertEqual(self.h.active_business_operations,0);self.h.seal_maintenance('original-permit')
        with self.assertRaises(ValueError):
            with self.h.business_admission(read_only=True):raise ValueError('readonly failure')
        self.assertEqual(self.h.active_business_operations,0);self.assertEqual(self.h.maintenance_exit_fence,'original-permit')
    def test_private_original_read_and_list_preserve_next_round_input_under_exit_seal(self):
        page,request,offer,ctx=self.f.paused_attention()
        note=self.s.command({'request_id':str(uuid.uuid4()),'action':'message.append','thread_id':ctx['request']['thread_id'],'data':{'expected_request_id':request,'text':'original unread note'}})
        self.assertEqual(note['delivery_scope'],'next_round')
        self.start_watch.assert_called_once_with(self.s.root)
        queued=self.h.managed.browser('next-round-read',{'page_id':page})
        self.assertEqual([(x['id'],x['request_id'],x['text']) for x in queued['messages']],[(note['operation_id'],request,'original unread note')])
        self.seal();before=revision_hash(ledger_revision(self.s.state.path))
        value=self.h.private(self.h._key,{'action':'read','store_id':self.s.state.id,'target_id':page,'session_id':self.f.base.sessions[page],'request_id':request})
        self.assertEqual(value['request_id'],request);self.assertTrue(self.h.managed.browser('list',{})['pages'])
        self.assertTrue(self.h.control.process(None,None,{'action':'capabilities'})['receiver_enrollment'])
        self.assertEqual(self.h.managed.browser('next-round-read',{'page_id':page}),queued)
        self.assertEqual(before,revision_hash(ledger_revision(self.s.state.path)))
        with closing(self.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_unread_notes WHERE request_id=?',(request,)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_next_round_notes WHERE source_request_id=?',(request,)).fetchone()[0],1)
    def test_legacy_native_web_sent_or_progress_is_not_host_idle_and_is_never_replayed(self):
        import test_harness_web as web_fixtures
        from harness_web import NativeWeb
        bridge=web_fixtures.FakeBridge();self.s.web=NativeWeb(self.s.state,self.s.root,None,targets=web_fixtures.CONFIG,bridge=bridge)
        row=self.s.command({'request_id':str(uuid.uuid4()),'action':'web.attach','data':{'target_id':'main','confirm':True}})['thread']
        request=self.s.command({'request_id':str(uuid.uuid4()),'action':'message.send','thread_id':row['id'],'data':{'text':'original legacy native-Web task'}})
        self.assertEqual(request['state'],'message_posted_not_completed');before=revision_hash(ledger_revision(self.s.state.path))
        with self.assertRaisesRegex(HarnessError,'execution_unresolved'):self.f.read()
        self.assertEqual(before,revision_hash(ledger_revision(self.s.state.path)));self.assertEqual(self.f.transport.calls,[]);self.assertEqual(len(bridge.posts),1)
        fake=web_fixtures.WebTests();fake.s=self.s;fake.bridge=bridge;fake.reply(request,'progress');self.s.command({'request_id':str(uuid.uuid4()),'action':'thread.sync','thread_id':row['id'],'data':{}})
        self.assertEqual(self.s.state.thread(row['id'])['status'],'web_processing')
        with self.assertRaisesRegex(HarnessError,'execution_unresolved'):self.f.read()
        fake.reply(request,'completed');self.s.command({'request_id':str(uuid.uuid4()),'action':'thread.sync','thread_id':row['id'],'data':{}})
        self.assertTrue(self.f.read()['idle']);self.assertEqual(len(bridge.posts),1)

if __name__=='__main__':unittest.main()
