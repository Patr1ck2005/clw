"""Recover partial execution on the original request without replay or new budget."""
from contextlib import closing
from pathlib import Path
import json,sys,unittest,uuid
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
from harness_managed import ManagedPages
from harness_state import HarnessError
import test_harness_managed as fixtures
from test_harness_control_plane import PAGE


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.ManagedTests();self.f.setUp();self.m=self.f.m;self.h=self.f.h
    def tearDown(self):self.f.tearDown()
    def team(self,page,op,p):
        return self.h.private(self.f.f.key,{'action':'team','store_id':self.h.state.id,'target_id':page,
            'session_id':self.f.sessions[page],'op':op,'operation_id':str(uuid.uuid4()),'payload':p})
    def park_partial(self):
        page,request,offer,ctx=self.f.start_browser_turn();child,_=self.f.enroll(page)
        run=ctx['run']['id'];claim=ctx['request']['claim_id']
        assigned=self.team(page,'assign',{'run_id':run,'claim_id':claim,'target':child,'text':'Independent work','depends_on':[],'resources':[]})
        self.team(page,'checkpoint',{'run_id':run,'expected_version':0,'summary':'Files saved, child assigned','references':['handoff.md'],'basis_seq':0})
        self.m.browser('artifact',{'page_id':page,'attempt_id':offer['attempt_id'],'text':'No tools were available, nothing executed'})
        self.f.wire(page,'result',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64},assistant_turn_hash='d'*64,text='No tools were available, nothing executed')
        return page,request,offer,ctx,child,assigned
    def test_partial_execution_is_exposed_and_recovery_preserves_identity(self):
        page,request,offer,ctx,child,assigned=self.park_partial()
        view=self.m.browser('view',{'page_id':page});facts=view['reconciliation']
        self.assertTrue(facts['missing_tool_outcome']);self.assertTrue(facts['browser_reply_saved'])
        self.assertEqual(facts['latest_checkpoint']['version'],1)
        self.assertEqual(facts['assignments_in_ended_turn'][0]['request_id'],assigned['request_id'])
        self.assertEqual(facts['assignments_in_ended_turn'][0]['send_attempted'],0)
        self.assertEqual(facts['external_jobs'],'not_verified_by_this_ledger')
        self.assertFalse(facts['automatic_retry_authorized'])
        with closing(self.h.state.connect()) as db:
            before=tuple(db.execute('SELECT deadline,dispatches,max_dispatches FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone())
        self.m.browser('pause',{'page_id':page,'paused':False})
        self.m.browser('pause',{'page_id':page,'paused':False})
        restored=self.f.private(page,'context',{})
        self.assertEqual(restored['request']['id'],request)
        self.assertEqual(restored['request']['claim_id'],ctx['request']['claim_id'])
        self.assertEqual(restored['recovery_context']['attempt']['id'],offer['attempt_id'])
        self.assertEqual(len(restored['additional_instructions']),1)
        self.assertIn(assigned['request_id'],restored['additional_instructions'][0]['text'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(tuple(db.execute('SELECT deadline,dispatches,max_dispatches FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone()),before)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_recovery_contexts WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_delegations WHERE parent_request_id=?',(request,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertFalse(db.execute('SELECT 1 FROM managed_turn_outcomes WHERE attempt_id=?',(offer['attempt_id'],)).fetchone())
        # Context survives a runtime restart but does not unpause or send anything.
        ManagedPages(self.h)
        self.assertEqual(self.f.private(page,'context',{})['recovery_context'],restored['recovery_context'])
    def test_pause_source_is_inherited_but_child_operator_pause_is_independent(self):
        page,request,offer,ctx,child,_=self.park_partial()
        rows={p['page_id']:p for p in self.m.browser('list',{})['pages']}
        self.assertTrue(rows[child]['pause_origin']['inherited'])
        self.assertEqual(rows[child]['pause_origin']['page_id'],page)
        self.assertEqual(rows[child]['pause_origin']['source'],'attention')
        with self.assertRaisesRegex(HarnessError,'managed_parent_paused_resume_parent_first'):
            self.m.browser('pause',{'page_id':child,'paused':False})
        self.m.browser('pause',{'page_id':child,'paused':True})
        self.m.browser('pause',{'page_id':page,'paused':False})
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==child)
        self.assertTrue(row['paused']);self.assertFalse(row['pause_origin']['inherited'])
        self.assertEqual(row['pause_origin']['source'],'operator')
    def test_expired_run_recovery_is_finalization_only_and_keeps_cancelled_work(self):
        page,request,offer,ctx,child,assigned=self.park_partial()
        with closing(self.h.state.connect()) as db:
            run=self.h.team.run_for_request(db,request);self.h.team.drain(db,run,'deadline');db.commit()
        self.m.browser('pause',{'page_id':page,'paused':False})
        restored=self.f.private(page,'context',{})
        self.assertEqual(restored['recovery_context']['next_action'],'reconcile_then_close_original_run')
        self.assertEqual(restored['recovery_context']['assignments_in_ended_turn'][0]['phase'],'cancelled')
        self.assertIn('不得重建取消任务',restored['additional_instructions'][0]['text'])
        # The final turn must actually be admitted before testing its assign gate.
        final=self.f.wire(page,'pulse');self.f.wire(page,'dispatch',attempt_id=final['attempt_id'])
        self.f.wire(page,'sent',attempt_id=final['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'e'*64,'generating':True},assistant_before_hash='d'*64)
        with self.assertRaisesRegex(HarnessError,'team_run_not_accepting_new_work'):
            self.team(page,'assign',{'run_id':ctx['run']['id'],'claim_id':ctx['request']['claim_id'],'target':child,'text':'replay','depends_on':[],'resources':[]})


if __name__=='__main__':unittest.main()
