"""Handoff gap regressions. Isolated protocol actors, never real Web acceptance."""
from pathlib import Path
from contextlib import closing
import json, sys, unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
import test_harness_collaboration as fixtures
from harness_state import HarnessError

class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.CollaborationTests();self.f.setUp()
        self.now=1000.0;self.f.s.host_bridge.clock=lambda:self.now
        self.child=self.f.join();self.parent=self.f.start()
        self.d=self.f.delegate(self.parent);self.f.yield_parent(self.parent)
    def tearDown(self):self.f.tearDown()
    def status(self):
        return self.f.p('main','results',request_id=self.parent,claim_id=self.f.claim)['children'][0]['handoff']
    def test_registered_child_is_not_a_live_receiver(self):
        s=self.status();self.assertEqual(s['state'],'receiver_unavailable');self.assertTrue(s['attention_required'])
        self.assertFalse(s['automatic_resume_verified'])
    def test_successful_poll_survives_release_instead_of_looking_offline(self):
        p=self.f.poll('child-a');self.assertTrue(p['available'])
        self.f.p('child-a','release-wait',wait_key='wait-child-a-fixed-key-0001')
        self.assertEqual(self.status()['state'],'handoff_offered_unclaimed')
        self.assertFalse(self.status()['attention_required'])
        self.now+=46
        s=self.status();self.assertTrue(s['attention_required']);self.assertEqual(s['next_action'],'recover_original_receiving_conversation')
        self.assertFalse(s['execution_replay_allowed'])
    def test_poll_repetition_has_one_offer_event(self):
        self.f.poll('child-a');self.f.poll('child-a')
        with closing(self.f.s.state.connect()) as db:
            n=db.execute("SELECT COUNT(*) FROM events WHERE thread_id=? AND kind='host_handoff_offered'",(self.child['id'],)).fetchone()[0]
        self.assertEqual(n,1)
    def test_handoff_is_not_child_claim_or_reply(self):
        self.f.poll('child-a');self.now+=120
        r=self.f.p('child-a','read',request_id=self.d['child_request_id'])
        self.assertEqual(r['phase'],'queued')
        self.assertEqual(self.status()['state'],'handoff_offered_unclaimed')
        with closing(self.f.s.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_replies').fetchone()[0],0)
    def test_claimed_receiver_never_uses_silence_as_failure(self):
        self.f.poll('child-a');self.f.p('child-a','claim',request_id=self.d['child_request_id'],claim_id=fixtures.uid())
        self.now+=86400
        s=self.status();self.assertEqual(s['state'],'claim_confirmed');self.assertFalse(s['attention_required'])
    def test_queued_dispatch_pause_keeps_original_input_until_explicit_resume(self):
        child_id=self.d['child_request_id']
        before=self.f.p('child-a','read',request_id=child_id)
        self.f.command(self.child['id'],'host.pause')
        paused=self.status()
        self.assertEqual(paused['state'],'dispatch_paused');self.assertTrue(paused['dispatch_paused'])
        self.assertEqual(paused['next_action'],'wait_for_explicit_resume');self.assertFalse(paused['attention_required'])
        self.assertFalse(paused['execution_replay_allowed'])
        current=self.f.p('child-a','read',request_id=child_id)
        self.assertEqual(current['phase'],before['phase']);self.assertFalse(current['cancel_requested'])
        with self.assertRaisesRegex(HarnessError,'host_paused'):self.f.poll('child-a')
        self.f.command(self.child['id'],'host.resume')
        self.assertEqual(self.f.poll('child-a')['request_id'],child_id)
        self.assertFalse(self.status()['dispatch_paused'])
    def test_parent_dispatch_pause_keeps_observing_claimed_child_and_collects_it(self):
        child_id=self.d['child_request_id'];claim=fixtures.uid()
        self.f.p('child-a','claim',request_id=child_id,claim_id=claim)
        self.f.command(self.f.parent['id'],'host.pause');self.now+=86400
        paused=self.status()
        self.assertTrue(paused['dispatch_paused']);self.assertEqual(paused['state'],'claim_confirmed')
        self.assertEqual(paused['next_action'],'observe_original_work');self.assertFalse(paused['attention_required'])
        current=self.f.p('child-a','read',request_id=child_id)
        self.assertEqual(current['phase'],'processing')
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(child_id,)).fetchone()[0],claim)
        self.assertFalse(current['cancel_requested'])
        self.f.finish('child-a',child_id,claim,'Original complete result under dispatch pause')
        self.assertEqual(self.status()['state'],'completed')
        self.assertTrue(self.status()['dispatch_paused'])
        self.assertEqual(self.f.p('main','read',request_id=self.parent)['phase'],'suspended')
    def test_paused_suspended_parent_inspects_original_results_instead_of_stopping(self):
        from harness_handoff import request_handoff
        self.f.command(self.f.parent['id'],'host.pause')
        with closing(self.f.s.state.connect()) as db:
            request=db.execute('SELECT * FROM host_requests WHERE id=?',(self.parent,)).fetchone()
            binding=self.f.s.host_bridge.binding(db,thread=self.f.parent['id'])
            handoff=request_handoff(db,binding,request,self.now)
        self.assertTrue(handoff['dispatch_paused']);self.assertEqual(handoff['state'],'waiting_children')
        self.assertEqual(handoff['next_action'],'inspect_original_child_results')
        self.assertFalse(handoff['attention_required']);self.assertFalse(request['cancel_requested'])
    def test_explicit_cancel_of_current_claim_retains_original_stop_reconciliation(self):
        child_id=self.d['child_request_id'];claim=fixtures.uid()
        self.f.p('child-a','claim',request_id=child_id,claim_id=claim)
        self.f.command(self.child['id'],'host.pause')
        with closing(self.f.s.state.connect()) as db:
            self.f.s.host_bridge.collaboration.cancel_descendants(db,self.parent);db.commit()
        cancelled=self.status()
        self.assertTrue(cancelled['dispatch_paused']);self.assertEqual(cancelled['state'],'cancel_requested')
        self.assertEqual(cancelled['next_action'],'reconcile_original_stop')
        self.assertFalse(cancelled['execution_replay_allowed'])
        current=self.f.p('child-a','read',request_id=child_id)
        self.assertEqual(current['phase'],'processing')
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(child_id,)).fetchone()[0],claim)
        self.assertTrue(current['cancel_requested'])
    def test_handoff_diagnostics_persist_after_restart(self):
        self.f.poll('child-a');self.f.s.close()
        self.f.s=fixtures.HarnessService(self.f.root,self.f.root/'state',connection_factory=fixtures.FakeConnection,web_targets=fixtures.copy.deepcopy(fixtures.CONFIG),web_bridge=self.f.bridge)
        self.f.s.host_bridge.clock=lambda:self.now
        self.now+=90
        self.assertEqual(self.status()['state'],'handoff_offered_unclaimed')
        self.assertTrue(self.status()['attention_required'])
    def test_diagnostics_do_not_leak_private_keys_or_instructions(self):
        self.f.poll('child-a');s=self.status();raw=json.dumps(s)
        self.assertNotIn(self.f.key,raw);self.assertNotIn('wait-child-a-fixed',raw)
        self.assertNotIn('text',s);self.assertNotIn('claim_id',s);self.assertNotIn('chat_url',s)
    def test_result_completed_preserves_parent_acceptance_boundary(self):
        claim=fixtures.uid();self.f.p('child-a','claim',request_id=self.d['child_request_id'],claim_id=claim)
        self.f.finish('child-a',self.d['child_request_id'],claim)
        s=self.status();self.assertEqual(s['state'],'completed');self.assertFalse(s['attention_required'])
        self.assertEqual(self.f.p('main','read',request_id=self.parent)['phase'],'suspended')

class WaitAndDoctorTests(unittest.TestCase):
    def test_wait_returns_missing_receiver_attention_without_empty_poll_loop(self):
        from harness_handoff import wait_for_results
        class Client:
            calls=0
            def call(self,action,**data):
                self.calls+=1
                return {'pending_children':1,'children':[{'handoff':{'attention_required':True}}]}
        c=Client();r=wait_for_results(c,'parent','claim',100,sleep=lambda _:self.fail('must not sleep'))
        self.assertEqual(r['state'],'attention_required');self.assertEqual(c.calls,1);self.assertFalse(r['parent_completed'])
    def test_wait_never_converts_auth_denial_into_a_retry(self):
        from harness_handoff import wait_for_results
        from harness_state import HarnessError
        class Client:
            def call(self,*a,**k):raise HarnessError('host_session_mismatch',403)
        with self.assertRaises(HarnessError):wait_for_results(Client(),'parent','claim',100,sleep=lambda _:self.fail('denial retry'))
    def test_wait_transport_retries_are_bounded_and_no_effect_is_replayed(self):
        from harness_handoff import wait_for_results
        class Client:
            calls=0
            def call(self,action,**data):
                assert action=='results';self.calls+=1;raise OSError('offline')
        c=Client();sleeps=[]
        r=wait_for_results(c,'parent','claim',100,sleep=sleeps.append)
        self.assertEqual(c.calls,3);self.assertEqual(sleeps,[2,4]);self.assertEqual(r['state'],'transport_unavailable')
    def test_wait_child_results_do_not_complete_parent(self):
        from harness_handoff import wait_for_results
        class Client:
            def call(self,*a,**k):return {'pending_children':0,'children':[]}
        r=wait_for_results(Client(),'p','c',1);self.assertEqual(r['state'],'children_returned');self.assertFalse(r['parent_completed'])
    def test_wait_deadline_is_bounded_without_treating_model_silence_as_failure(self):
        from harness_handoff import wait_for_results
        now=[0.0]
        class Client:
            def call(self,*a,**k):return {'pending_children':1,'children':[{'handoff':{'state':'claim_confirmed','attention_required':False}}]}
        r=wait_for_results(Client(),'p','c',3,clock=lambda:now[0],sleep=lambda n:now.__setitem__(0,now[0]+n))
        self.assertEqual(r['state'],'bounded_wait_expired');self.assertEqual(now[0],3)
    def test_doctor_missing_store_does_not_create_it(self):
        import tempfile
        from harness_doctor import inspect_store
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'not-created.sqlite3';r=inspect_store(p)
            self.assertEqual(r['status'],'store_missing');self.assertFalse(p.exists())
    def test_doctor_existing_store_is_read_only_and_no_private_body_leaks(self):
        import hashlib
        from harness_doctor import inspect_store
        f=fixtures.CollaborationTests();f.setUp()
        try:
            f.join();p=f.start();f.delegate(p);f.yield_parent(p)
            before=hashlib.sha256(f.s.state.path.read_bytes()).hexdigest()
            r=inspect_store(f.s.state.path)
            self.assertEqual(before,hashlib.sha256(f.s.state.path.read_bytes()).hexdigest())
            raw=json.dumps(r);self.assertNotIn(f.key,raw);self.assertNotIn(f.claim,raw);self.assertNotIn('原始完整目标',raw)
            self.assertEqual(len(r['requests']),2)
        finally:f.tearDown()
    def test_cancelled_child_never_recommends_wakeup(self):
        f=fixtures.CollaborationTests();f.setUp()
        try:
            f.join();p=f.start();f.delegate(p);f.yield_parent(p)
            # Explicit cancellation is a different state transition from the
            # user's ordinary future-dispatch pause.
            with closing(f.s.state.connect()) as db:
                f.s.host_bridge.collaboration.cancel_descendants(db,p);db.commit()
            r=f.p('main','results',request_id=p,claim_id=f.claim)['children'][0]['handoff']
            self.assertEqual(r['state'],'cancelled');self.assertFalse(r['attention_required'])
        finally:f.tearDown()
    def test_parent_pause_holds_receiver_without_cancelling_or_replaying_child(self):
        f=fixtures.CollaborationTests();f.setUp()
        try:
            f.join();p=f.start();delegation=f.delegate(p);f.yield_parent(p)
            child_id=delegation['child_request_id'];before=f.p('child-a','read',request_id=child_id)
            f.command(f.parent['id'],'host.pause')
            child=f.p('child-a','read',request_id=child_id)
            self.assertEqual(child['request_id'],child_id);self.assertEqual(child['phase'],before['phase'])
            self.assertFalse(child['cancel_requested']);self.assertFalse(f.poll('child-a')['available'])
            paused=f.p('main','results',request_id=p,claim_id=f.claim)['children'][0]['handoff']
            self.assertEqual(paused['state'],'dispatch_paused');self.assertTrue(paused['dispatch_paused'])
            self.assertEqual(paused['next_action'],'wait_for_explicit_resume');self.assertFalse(paused['attention_required'])
            self.assertEqual(f.p('main','read',request_id=p)['phase'],'suspended')
            f.command(f.parent['id'],'host.resume')
            self.assertEqual(f.poll('child-a')['request_id'],child_id)
        finally:f.tearDown()

class ControlPauseHandoffTests(unittest.TestCase):
    def test_paused_original_control_attempt_keeps_reconciliation_and_never_replays(self):
        from test_harness_control_plane import ControlTests
        from harness_handoff import request_handoff
        for state in ('dispatching','unknown','not_sent'):
            with self.subTest(state=state):
                fixture=ControlTests();fixture.setUp()
                try:
                    request,offer=fixture.offer();fixture.grant(offer)
                    if state!='dispatching':fixture.wire('finish',attempt_id=offer['attempt_id'],result=state)
                    fixture.f.command(fixture.f.parent['id'],'host.pause')
                    with closing(fixture.h.state.connect()) as db:
                        before=dict(db.execute('SELECT * FROM control_attempts WHERE id=?',(offer['attempt_id'],)).fetchone())
                        original=dict(db.execute('SELECT * FROM host_requests WHERE id=?',(request,)).fetchone())
                        binding=fixture.h.binding(db,thread=fixture.f.parent['id'])
                        handoff=request_handoff(db,binding,original,fixture.now)
                        self.assertEqual(dict(db.execute('SELECT * FROM control_attempts WHERE id=?',(offer['attempt_id'],)).fetchone()),before)
                        self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
                    self.assertTrue(handoff['dispatch_paused']);self.assertEqual(handoff['state'],'control_'+state)
                    self.assertEqual(handoff['attempt_id'],offer['attempt_id'])
                    self.assertEqual(handoff['next_action'],'reconcile_original_control_attempt_no_send_retry')
                    self.assertFalse(handoff['execution_replay_allowed']);self.assertFalse(original['cancel_requested'])
                finally:fixture.tearDown()

if __name__=='__main__':unittest.main(verbosity=2)
