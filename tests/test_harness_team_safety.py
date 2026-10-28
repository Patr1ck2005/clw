"""Adversarial continuation tests against the real isolated Host/run state machines.
No browser accounts, external providers or production database writes.
"""
from contextlib import closing
from pathlib import Path
import json,sys,unittest,uuid
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
import test_harness_team as fixtures
from test_harness_control_plane import PAGE,URL,ORIGIN,receiver_marker
from harness_state import HarnessError

class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.b=fixtures.TeamTests();self.b.setUp();self.h=self.b.h
    def tearDown(self):self.b.tearDown()
    def one_worker(self):
        self.b.f.join();self.b.enroll('child-a');self.b.workspace('child-a')
        r,run=self.b.start_run();child=self.b.assign(run);self.b.wait(run)
        _,got=self.b.send_receive('child-a')
        return r,run,child,got
    def reply(self,target,got,status,body):
        return self.b.f.p(target,'reply',request_id=got['request_id'],claim_id=got['original_claim_id'],
                         reply_id=uuid.uuid4().hex,status=status,text=body)
    def test_public_result_keeps_all_progress_and_final_parts_in_order(self):
        r,run,child,got=self.one_worker()
        parts=['第一部分：原始推导，尚待核验。','第二部分：反例与修订。','最终结果：前两段也是交付的一部分。']
        self.reply('child-a',got,'progress',parts[0]);self.reply('child-a',got,'progress',parts[1]);self.reply('child-a',got,'completed',parts[2])
        _,parent=self.b.send_receive('main');after=0;seen=[]
        while True:
            page=self.b.call('result',{'run_id':run['run_id'],'request_id':child['request_id'],'after_seq':after})
            self.assertIsNotNone(page['reply']);seen.append(page['reply']['text']);after=page['next_after']
            if not page['has_more']:break
            with self.assertRaises(HarnessError):self.b.f.finish('main',r,self.b.f.claim)
        self.assertEqual(seen,parts);self.assertTrue(page['all_public_parts_read'])
        self.b.f.finish('main',r,self.b.f.claim)
    def test_caller_cannot_jump_to_final_result_and_skip_earlier_evidence(self):
        r,run,child,got=self.one_worker()
        self.reply('child-a',got,'progress','Evidence that the final brief does not repeat')
        self.reply('child-a',got,'completed','Final brief')
        self.b.send_receive('main')
        with closing(self.h.state.connect()) as db:
            seq=db.execute("SELECT MAX(seq) FROM events WHERE kind='assistant_message' AND json_extract(data,'$.request_id')=?",(child['request_id'],)).fetchone()[0]
        with self.assertRaises(HarnessError):self.b.call('result',{'run_id':run['run_id'],'request_id':child['request_id'],'after_seq':seq-1})
        with self.assertRaises(HarnessError):self.b.f.finish('main',r,self.b.f.claim)
    def test_failed_dependency_becomes_explicit_unstarted_block_not_infinite_all_wait(self):
        for t in ('child-a','child-b'):
            self.b.f.join(t);self.b.enroll(t);self.b.workspace(t,read_only=True)
        r,run=self.b.start_run(read_only=True)
        a=self.b.assign(run);b=self.b.assign(run,'child-b',depends=[a['request_id']]);self.b.wait(run,mode='all')
        _,got=self.b.send_receive('child-a');self.reply('child-a',got,'blocked','Input assumption failed; do not run dependent work.')
        self.h.team.tick()
        child=self.b.f.p('child-b','read',request_id=b['request_id'])
        self.assertEqual(child['phase'],'blocked');self.assertIsNone(child.get('claim_id'))
        self.assertNotEqual(self.b.wire('child-b','pulse',page=PAGE)['state'],'offer')
        _,parent=self.b.send_receive('main');self.assertEqual(parent['request_id'],r)
        with closing(self.h.state.connect()) as db:
            self.assertFalse(db.execute('SELECT 1 FROM control_attempts WHERE request_id=?',(b['request_id'],)).fetchone())
    def test_selected_wait_only_resumes_for_requested_result_set(self):
        for t in ('child-a','child-b'):
            self.b.f.join(t);self.b.enroll(t);self.b.workspace(t,read_only=True)
        r,run=self.b.start_run(read_only=True)
        a=self.b.assign(run);b=self.b.assign(run,'child-b')
        self.b.call('wait',{'run_id':run['run_id'],'claim_id':self.b.f.claim,'after_seq':0,'mode':'selected','selected_requests':[b['request_id']]})
        _,ga=self.b.send_receive('child-a');_,gb=self.b.send_receive('child-b');self.b.final('child-a',ga)
        self.assertNotEqual(self.b.wire('main','pulse',page=PAGE)['state'],'offer')
        self.b.final('child-b',gb);_,parent=self.b.send_receive('main');self.assertEqual(parent['original_claim_id'],self.b.f.claim)
    def test_selected_wait_cannot_wait_on_foreign_request(self):
        r,run=self.b.start_run()
        with self.assertRaises(HarnessError):self.b.call('wait',{'run_id':run['run_id'],'claim_id':self.b.f.claim,'after_seq':0,'mode':'selected','selected_requests':['foreign-request']})
        self.assertEqual(self.b.f.p('main','read',request_id=r)['phase'],'processing')
    def test_worker_cannot_open_nested_independent_budget_on_parent_managed_work(self):
        r,run,child,got=self.one_worker()
        with self.assertRaises(HarnessError):self.b.call('open',{'request_id':child['request_id'],'claim_id':got['original_claim_id'],
            'duration_seconds':1000,'max_dispatches':9000,'max_parallel':16,'goal_ref':'unauthorized-new-budget','constraints':'cannot bypass parent'},target='child-a')
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_runs').fetchone()[0],1)
    def test_active_legacy_scope_is_not_changed_to_claim_false_parallelism(self):
        self.b.workspace();r=self.b.f.start()
        with self.assertRaises(HarnessError):self.b.workspace(read_only=True)
        with closing(self.h.state.connect()) as db:self.assertEqual(self.h.team.scopes.scope(db,self.b.f.parent['id'])['access'],'write')
    def test_revoke_remains_revoked_through_known_page_rediscovery(self):
        self.b.enroll()
        with closing(self.h.state.connect()) as db:i=db.execute('SELECT invitation_id FROM host_carrier_links').fetchone()[0]
        self.b.call('revoke',{'invitation_id':i,'reason':'operator disabled this binding'})
        with self.assertRaises(HarnessError):
            boot=self.h.control.wire(ORIGIN,None,dict(action='bootstrap',chat_url=URL,tab_nonce='a'*32,page=PAGE,confirm_low_cost=True))
            self.h.control.wire(ORIGIN,None,dict(action='bind',discovery_id=boot['candidates'][0]['discovery_id'],chat_url=URL,tab_nonce='a'*32,page=PAGE,confirm=True,confirm_low_cost=True))
        self.assertEqual(self.b.call('status')['carriers'][0]['state'],'revoked')
    def test_legacy_pair_code_cannot_bypass_receiver_enrollment_or_revoke(self):
        self.b.enroll()
        with closing(self.h.state.connect()) as db:i=db.execute('SELECT invitation_id FROM host_carrier_links').fetchone()[0]
        self.b.call('revoke',{'invitation_id':i,'reason':'operator disabled'})
        with self.assertRaises(HarnessError):
            code=self.b.f.p('main','control-code',confirm=True,model_label='GPT-5.6 Sol',effort_label='Extra High')['pair_code']
            self.h.control.wire(ORIGIN,None,dict(action='pair',code=code,chat_url=URL,tab_nonce='e'*32))
    def test_reenrollment_preserves_the_known_original_chat_url(self):
        self.b.f.join();_,url=self.b.enroll('child-a')
        marker=receiver_marker(self.b.f)
        with self.assertRaises(HarnessError):self.h.control.wire(ORIGIN,None,dict(action='bootstrap',chat_url=url.replace('22222222','88888888'),tab_nonce='e'*32,page=PAGE,confirm_low_cost=True,enrollment=marker))
    def test_operator_cannot_orphan_recover_a_branch_that_has_a_real_bound_page(self):
        self.b.f.join();self.b.enroll('child-a')
        ticket=self.b.call('invite',{'target':'child-a','allow_rebind':True,'ttl_seconds':600,'reason':'wrongly labelled orphan'})
        self.b.f.sessions['child-a']='wc_sess_tttttttttttttttt'
        with self.assertRaises(HarnessError):self.b.call('enroll',{'ticket':ticket['ticket'],'project':self.h.targets['main']['project'],'root':str(self.b.f.root)},target='child-a')
    def test_managed_run_never_dispatches_when_exact_cost_labels_are_hidden(self):
        self.b.f.join();self.b.enroll('child-a');self.b.workspace('child-a')
        r,run=self.b.start_run();child=self.b.assign(run);self.b.wait(run)
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE control_peers SET model='@confirmed-sol-nonpro',effort='@confirmed-medium-or-extra-high' WHERE thread_id=(SELECT thread_id FROM host_bindings WHERE target_id='child-a')");db.commit()
        response=self.b.wire('child-a','pulse',page={**PAGE,'model_label':'','effort_label':''})
        self.assertEqual(response['state'],'team_visible_model_and_effort_required');self.assertFalse(response['dispatch'])
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(child['request_id'],)).fetchone()[0],0)
    def test_pause_does_not_cancel_unknown_dispatched_child_or_release_its_lease(self):
        r,run,a,b=self.b.parallel_setup(shared=True)
        offer=self.b.wire('child-a','pulse',page=PAGE)
        self.b.wire('child-a','dispatch',attempt_id=offer['attempt_id'],page=PAGE)
        self.b.wire('child-a','finish',attempt_id=offer['attempt_id'],result='unknown')
        self.b.f.command(self.b.f.parent['id'],'host.pause')
        state=self.b.f.p('child-a','read',request_id=a['request_id'])
        self.assertEqual(state['phase'],'queued');self.assertFalse(state['cancel_requested'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_leases WHERE request_id=?',(a['request_id'],)).fetchone()[0],1)
        self.assertNotEqual(self.b.wire('child-b','pulse',page=PAGE)['state'],'offer')
    def test_explicit_cancel_does_not_mark_unknown_dispatched_child_as_stopped(self):
        r,run,a,b=self.b.parallel_setup(shared=True)
        offer=self.b.wire('child-a','pulse',page=PAGE)
        self.b.wire('child-a','dispatch',attempt_id=offer['attempt_id'],page=PAGE)
        self.b.wire('child-a','finish',attempt_id=offer['attempt_id'],result='unknown')
        with closing(self.h.state.connect()) as db:
            self.h.collaboration.cancel_descendants(db,r);db.commit()
        state=self.b.f.p('child-a','read',request_id=a['request_id'])
        self.assertEqual(state['phase'],'queued');self.assertTrue(state['cancel_requested'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_leases WHERE request_id=?',(a['request_id'],)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT state FROM control_attempts WHERE id=?',(offer['attempt_id'],)).fetchone()[0],'unknown')
        self.assertNotEqual(self.b.wire('child-b','pulse',page=PAGE)['state'],'offer')

if __name__=='__main__':unittest.main(verbosity=2)
