"""Real isolated SQLite authority; pausing future work does not revoke sent receipts."""
from contextlib import closing
from pathlib import Path
import sys,unittest
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
from harness_state import HarnessError
import test_harness_managed as managed_fixture
import test_harness_control_plane as control_fixture
from test_harness_control_plane import PAGE
import test_harness_collaboration as collaboration_fixture
from test_harness_collaboration import uid


class ManagedFutureTests(unittest.TestCase):
    def setUp(self):
        self.f=managed_fixture.ManagedTests();self.f.setUp();self.m=self.f.m;self.h=self.f.h
    def tearDown(self):self.f.tearDown()
    def test_unsent_managed_original_cannot_claim_through_legacy_host_after_pause(self):
        page,b=self.f.enroll();request=self.f.f.command(b['thread_id'],'message.send',{'text':'Original whole package'})['request_id']
        self.m.browser('pause',{'page_id':page,'paused':True,'expected_request_id':request})
        with self.assertRaisesRegex(HarnessError,'host_paused'):
            self.h.private(self.f.f.key,dict(action='claim',store_id=self.h.state.id,target_id=page,session_id=self.f.sessions[page],request_id=request,claim_id=uid()))
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'queued')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts').fetchone()[0],0)
    def test_only_durable_original_dispatch_can_receive_under_operator_pause(self):
        page,b=self.f.enroll();request=self.f.f.command(b['thread_id'],'message.send',{'text':'Original whole package'})['request_id']
        offer=self.f.wire(page,'pulse')
        self.m.browser('pause',{'page_id':page,'paused':True})
        with self.assertRaisesRegex(HarnessError,'managed_no_prepared_send'):
            self.f.private(page,'context',{'attempt_id':offer['attempt_id']})
    def test_durable_dispatch_can_receive_and_confirm_under_operator_pause(self):
        page,b=self.f.enroll();request=self.f.f.command(b['thread_id'],'message.send',{'text':'Original whole package'})['request_id']
        offer=self.f.wire(page,'pulse')
        self.f.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        self.m.browser('prepare',{'page_id':page,'attempt_id':offer['attempt_id'],'assistant_before_hash':'c'*64,'prompt_hash':'d'*64})
        self.m.browser('pause',{'page_id':page,'paused':True})
        self.f.private(page,'context',{'attempt_id':offer['attempt_id']})
        sent={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True}
        result=self.f.wire(page,'sent',attempt_id=offer['attempt_id'],page=sent,assistant_before_hash='c'*64)
        self.assertEqual(result['state'],'browser_result_pending')
        with closing(self.h.state.connect()) as db:
            row=db.execute('SELECT phase,cancel_requested FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual(tuple(row),('processing',0));self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_tool_received').fetchone()[0],1)
        self.assertTrue(next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)['paused'])
    def test_explicit_stop_cannot_use_the_operator_pause_exception(self):
        page,request,offer,_=self.f.start_browser_turn()
        self.m.browser('page-issue',{'page_id':page,'kind':'user_stopped','detail':'Explicit user stop'})
        with self.assertRaisesRegex(HarnessError,'managed_page_not_ready|managed_no_prepared_send'):
            self.f.private(page,'context',{'attempt_id':offer['attempt_id']})
        with self.assertRaisesRegex(HarnessError,'managed_page_not_ready'):
            self.m.browser('wire',{'page_id':page,'data':{'action':'finish','attempt_id':offer['attempt_id'],'result':'sent'}})
    def test_original_attention_cannot_use_the_operator_pause_exception(self):
        page,request,offer,_=self.f.start_browser_turn()
        self.m.browser('prepare',{'page_id':page,'attempt_id':offer['attempt_id'],'assistant_before_hash':'c'*64,'prompt_hash':'d'*64})
        with closing(self.h.state.connect()) as db:
            db.execute('INSERT INTO managed_attention VALUES(?,?,?)',(request,offer['attempt_id'],'original fault'));db.commit()
        self.m.browser('pause',{'page_id':page,'paused':True})
        with self.assertRaisesRegex(HarnessError,'managed_page_not_ready'):
            self.f.private(page,'context',{'attempt_id':offer['attempt_id']})


class DelegationFutureTests(unittest.TestCase):
    def setUp(self):self.f=collaboration_fixture.CollaborationTests();self.f.setUp();self.h=self.f.s.host_bridge
    def tearDown(self):self.f.tearDown()
    def original_child(self):
        self.f.join();r=self.f.start();d=self.f.delegate(r);self.f.yield_parent(r);return r,d
    def test_accepted_child_can_finish_but_cannot_delegate_new_work_under_parent_hold(self):
        self.f.join();self.f.join('grandchild','child-a');r=self.f.start();d=self.f.delegate(r);self.f.yield_parent(r);claim=uid()
        self.f.p('child-a','claim',request_id=d['child_request_id'],claim_id=claim);self.f.command(self.f.parent['id'],'host.pause')
        with self.assertRaisesRegex(HarnessError,'host_parent_not_delegating'):
            self.f.p('child-a','delegate',request_id=d['child_request_id'],claim_id=claim,child_target_id='grandchild',delegation_id=uid(),text='New unsent work')
        result=self.f.finish('child-a',d['child_request_id'],claim)
        self.assertEqual(result['phase'],'completed')
        self.assertEqual(self.f.p('main','read',request_id=r)['phase'],'suspended')
    def test_missing_and_foreign_delegation_identity_never_become_independent_roots(self):
        for mutation in ['missing','child','parent','cycle']:
            with self.subTest(mutation=mutation):
                f=collaboration_fixture.CollaborationTests();f.setUp()
                try:
                    f.join();r=f.start();d=f.delegate(r);f.yield_parent(r);h=f.s.host_bridge
                    with closing(h.state.connect()) as db:
                        if mutation=='missing':db.execute('DELETE FROM host_delegations WHERE child_request_id=?',(d['child_request_id'],))
                        elif mutation=='child':db.execute("UPDATE host_delegations SET child_thread_id='foreign' WHERE child_request_id=?",(d['child_request_id'],))
                        elif mutation=='parent':db.execute("UPDATE host_delegations SET parent_thread_id='foreign' WHERE child_request_id=?",(d['child_request_id'],))
                        else:db.execute('UPDATE host_delegations SET parent_request_id=?,parent_thread_id=child_thread_id WHERE child_request_id=?',(d['child_request_id'],d['child_request_id']))
                        db.commit()
                    with self.assertRaisesRegex(HarnessError,'host_delegation_'):f.poll('child-a')
                    with closing(h.state.connect()) as db:self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(d['child_request_id'],)).fetchone()[0],'queued')
                finally:f.tearDown()


class BrowserReceiptFutureTests(unittest.TestCase):
    def setUp(self):self.f=control_fixture.ControlTests();self.f.setUp()
    def tearDown(self):self.f.tearDown()
    def test_original_sent_receipt_survives_pause_but_peer_revocation_and_expiry_do_not(self):
        request,offer=self.f.offer();self.f.grant(offer);self.f.f.command(self.f.f.parent['id'],'host.pause')
        self.assertEqual(self.f.sent(offer)['state'],'browser_result_pending')
        with closing(self.f.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT cancel_requested FROM host_requests WHERE id=?',(request,)).fetchone()[0],0)
        for mutate in ['revoke','expire']:
            with closing(self.f.h.state.connect()) as db:
                db.execute('UPDATE control_peers SET enabled=?,expires=?',(0 if mutate=='revoke' else 1,self.f.now-1 if mutate=='expire' else self.f.now+100));db.commit()
            with self.assertRaises(HarnessError):self.f.browser_result(offer)
    def test_parent_pause_blocks_failure_recovery_without_creating_another_attempt(self):
        f=self.f;f.f.join();f.pair('child-a');parent=f.f.start();child=f.f.delegate(parent);f.f.yield_parent(parent)
        offer=f.pulse('child-a');f.grant(offer,'child-a');f.sent(offer,'child-a');f.f.command(f.f.parent['id'],'host.pause')
        failed={**PAGE,'user_hash':'b'*64,'failure_kind':'generation_failed','failure_hash':'e'*64}
        with closing(f.h.state.connect()) as db:before=db.execute('SELECT COUNT(*) FROM control_attempts').fetchone()[0]
        self.assertNotEqual(f.wire('pulse','child-a',page=failed)['state'],'offer');f.now+=15
        self.assertNotEqual(f.wire('pulse','child-a',page=failed)['state'],'offer')
        with closing(f.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts').fetchone()[0],before)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_recoveries').fetchone()[0],0)


if __name__=='__main__':unittest.main()
