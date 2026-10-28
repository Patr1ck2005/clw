"""Local budget accounting and same-conversation continuation, no model calls."""
from contextlib import closing
import json,unittest,uuid
import test_harness_managed as fixtures
from test_harness_control_plane import PAGE
from harness_state import HarnessError
from harness_managed import ManagedPages
from harness_managed_budget import ready_to_start

class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.ManagedTests();self.f.setUp();self.h=self.f.h;self.m=self.f.m
        self.now=10000.;self.h.clock=lambda:self.now
    def tearDown(self):self.f.tearDown()
    def view(self,page):return self.m.browser('view',{'page_id':page})
    def payload(self,page,sends=40,seconds=21600):
        return {'page_id':page,'operation_id':str(uuid.uuid4()),'expected_etag':self.view(page)['budget_status']['etag'],'add_dispatches':sends,'add_seconds':seconds}
    def refill(self,page,**kw):return self.m.browser('refill-budget',self.payload(page,**kw))
    def runrow(self,run):
        with closing(self.h.state.connect()) as db:return dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run,)).fetchone())
    def finish(self,page,request,offer,ctx):
        self.f.private(page,'turn-end',{'request_id':request,'claim_id':ctx['request']['claim_id'],'outcome':'completed','markdown':'Original \\[x^2\\] result'})
        self.f.wire(page,'result',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64},assistant_turn_hash='d'*64,text='DOM result')
    def close(self,page,request,offer,ctx):
        self.finish(page,request,offer,ctx)
        self.assertEqual(self.runrow(ctx['run']['id'])['state'],'closed')
    def final_turn(self):
        page,request,offer,ctx=self.f.start_browser_turn();run=ctx['run']['id'];claim=ctx['request']['claim_id']
        self.h.private(self.f.f.key,{'action':'team','store_id':self.h.state.id,'target_id':page,
            'session_id':self.f.sessions[page],'op':'wait','operation_id':str(uuid.uuid4()),
            'payload':{'run_id':run,'claim_id':claim,'after_seq':0,'mode':'all'}})
        self.f.private(page,'turn-end',{'request_id':request,'claim_id':claim,'outcome':'yielded','markdown':'Saved before waiting'})
        self.f.wire(page,'result',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro',
            'effort_label':'最高','user_hash':'b'*64},assistant_turn_hash='d'*64,text='Saved before waiting')
        self.now+=21601;self.h.team.tick()
        final=self.f.wire(page,'pulse',page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64})
        self.assertEqual(final['state'],'offer')
        self.f.wire(page,'dispatch',attempt_id=final['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro',
            'effort_label':'最高','user_hash':'b'*64})
        self.f.wire(page,'sent',attempt_id=final['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro',
            'effort_label':'最高','user_hash':'c'*64,'generating':True},assistant_before_hash='d'*64)
        final_ctx=self.f.private(page,'context',{})
        self.assertEqual(final_ctx['run']['final_granted'],1)
        return page,request,final,final_ctx
    def end_final(self,page,request,offer,ctx):
        self.f.private(page,'turn-end',{'request_id':request,'claim_id':ctx['request']['claim_id'],
            'outcome':'needs_attention','markdown':'Saved final turn; original task still needs repair'})
        result=self.f.wire(page,'result',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro',
            'effort_label':'最高','user_hash':'c'*64},assistant_turn_hash='f'*64,text='Saved final turn; original task still needs repair')
        self.assertEqual(result['state'],'needs_attention')
    def test_active_refill_keeps_claim_counters_and_pause_and_replays_once_after_restart(self):
        page,request,offer,ctx=self.f.start_browser_turn();run=ctx['run']['id']
        self.m.browser('pause',{'page_id':page,'paused':True});before=self.runrow(run);payload=self.payload(page)
        result=self.m.browser('refill-budget',payload);after=self.runrow(run)
        self.assertEqual(after['dispatches'],before['dispatches']);self.assertEqual(after['deadline'],before['deadline']+21600)
        self.assertEqual(after['max_dispatches'],before['max_dispatches']+40);self.assertEqual(result['model_sends'],0)
        self.h.managed=ManagedPages(self.h);self.m=self.h.managed
        self.assertTrue(self.m.browser('refill-budget',payload)['replayed']);self.assertEqual(self.runrow(run),after)
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0],ctx['request']['claim_id'])
        self.assertTrue(next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)['paused'])
        with self.assertRaisesRegex(HarnessError,'operation_conflict'):self.m.browser('refill-budget',{**payload,'add_dispatches':41})
        with self.assertRaisesRegex(HarnessError,'budget_changed'):self.m.browser('refill-budget',{**payload,'operation_id':str(uuid.uuid4())})
    def test_worker_cannot_create_a_separate_budget(self):
        page,_,_,_=self.f.start_browser_turn();child,_=self.f.enroll(page)
        with self.assertRaisesRegex(HarnessError,'controller_required'):
            self.m.browser('refill-budget',{'page_id':child,'operation_id':str(uuid.uuid4()),'expected_etag':'unused','add_dispatches':40,'add_seconds':21600})
        self.assertEqual(self.view(child)['budget_status']['scope'],'controller')
    def test_expired_window_refill_requires_explicit_resume_and_retains_cancelled_work(self):
        page,request,offer,ctx=self.f.start_browser_turn();run=ctx['run']['id']
        child,_=self.f.enroll(page)
        with closing(self.h.state.connect()) as db:
            assigned=self.h.team.assign(db,self.h.binding(db,target=page),{'run_id':run,'claim_id':ctx['request']['claim_id'],'target':child,'text':'Pending review','depends_on':[],'resources':[]},str(uuid.uuid4()))
            db.commit()
        self.now+=21601;self.h.team.tick()
        self.assertEqual(self.runrow(run)['state'],'draining')
        result=self.refill(page)
        self.assertEqual(self.runrow(run)['state'],'paused');self.assertEqual(self.runrow(run)['deadline'],self.now+21600)
        self.assertTrue(next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)['paused'])
        self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        self.assertEqual(self.runrow(run)['state'],'running');self.assertEqual(result['model_sends'],0)
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(assigned['request_id'],)).fetchone()[0],'cancelled')
    def test_closed_refill_carries_credit_preserves_checkpoint_and_starts_time_at_send(self):
        page,request,offer,ctx=self.f.start_browser_turn();run=ctx['run']['id'];thread=ctx['request']['thread_id']
        with closing(self.h.state.connect()) as db:
            actor=self.h.binding(db,target=page)
            self.h.team.checkpoint(db,actor,{'run_id':run,'expected_version':0,'summary':'original evidence','references':[],'basis_seq':0})
            db.execute('UPDATE host_runs SET dispatches=37 WHERE id=?',(run,));db.commit()
        self.close(page,request,offer,ctx);self.now+=21601;before=self.runrow(run)
        result=self.refill(page);self.assertEqual(result['budget']['available_sends'],43);self.assertEqual(result['budget']['available_seconds'],21600)
        self.assertEqual(self.runrow(run),before);self.assertTrue(result['budget']['can_continue'])
        with self.assertRaisesRegex(HarnessError,'source_changed'):
            self.m.browser('budget-continuation',{'page_id':page,'expected_run_id':'stale'})
        objective=self.m.browser('budget-continuation',{'page_id':page,'expected_run_id':run})['objective']
        self.now+=4000
        nextrequest=self.f.f.command(thread,'message.send',{'text':objective})['request_id']
        nextoffer=self.f.wire(page,'pulse');self.f.wire(page,'dispatch',attempt_id=nextoffer['attempt_id'])
        self.f.wire(page,'sent',attempt_id=nextoffer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'e'*64},assistant_before_hash='d'*64)
        context=self.f.private(page,'context',{})
        self.assertEqual(context['run']['deadline'],self.now+21600);self.assertEqual(context['run']['max_dispatches'],43)
        self.assertEqual(context['request']['id'],nextrequest);self.assertEqual(context['request']['thread_id'],thread)
        self.assertEqual(context['budget_continuation']['prior_sends'],37)
        self.assertEqual(context['budget_continuation']['original_goal'],'可核对的工作目标')
        self.assertEqual(context['budget_continuation']['checkpoints'][0]['summary'],'original evidence')
        self.assertEqual(len(context['budget_continuation']['controller_artifacts']),1)
        self.assertEqual(self.runrow(run),before);self.assertFalse(self.view(page)['budget_status']['saved'])
    def test_partial_refill_needs_both_time_and_sends_before_next_send(self):
        page,request,offer,ctx=self.f.start_browser_turn();run=ctx['run']['id']
        with closing(self.h.state.connect()) as db:db.execute('UPDATE host_runs SET dispatches=max_dispatches WHERE id=?',(run,));db.commit()
        self.close(page,request,offer,ctx);self.now+=21601
        self.assertFalse(self.refill(page,sends=20,seconds=0)['budget']['can_continue'])
        with closing(self.h.state.connect()) as db:
            with self.assertRaisesRegex(HarnessError,'needs_time_and_sends'):ready_to_start(db,db.execute('SELECT * FROM managed_pages WHERE page_id=?',(page,)).fetchone())
        self.assertTrue(self.refill(page,sends=0,seconds=3600)['budget']['can_continue'])
    def test_final_in_flight_can_reserve_next_budget_without_starting_or_mutating_old_run(self):
        page,request,offer,ctx=self.f.start_browser_turn();run=ctx['run']['id']
        with closing(self.h.state.connect()) as db:db.execute("UPDATE host_runs SET state='draining',reason='deadline',final_granted=1 WHERE id=?",(run,));db.commit()
        before=self.runrow(run);result=self.refill(page)
        self.assertEqual(result['budget']['scope'],'next');self.assertFalse(result['budget']['can_continue']);self.assertEqual(self.runrow(run),before)
        with self.assertRaisesRegex(HarnessError,'not_ready'):self.m.browser('budget-continuation',{'page_id':page,'expected_run_id':run})
        self.close(page,request,offer,ctx)
        self.assertTrue(self.view(page)['budget_status']['can_continue'])
    def test_ended_final_attention_refill_resumes_the_same_goal_once(self):
        page,request,offer,ctx=self.final_turn();run=ctx['run']['id'];self.end_final(page,request,offer,ctx)
        before=self.runrow(run)
        self.assertEqual(self.view(page)['budget_status']['scope'],'current')
        result=self.refill(page,sends=12,seconds=3600)
        self.assertEqual(result['model_sends'],0);self.assertTrue(result['budget']['ended_final_turn'])
        funded=self.runrow(run);self.assertEqual(funded['state'],'paused');self.assertEqual(funded['final_granted'],1)
        self.assertEqual(funded['dispatches'],before['dispatches'])
        self.assertEqual(funded['max_dispatches'],before['max_dispatches']+12)
        resumed=self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        self.assertEqual(resumed['resumed_original_requests'],[request])
        active=self.runrow(run);self.assertEqual(active['state'],'running');self.assertEqual(active['final_granted'],0)
        self.assertEqual(active['dispatches'],before['dispatches'])
        self.assertEqual(self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})['resumed_original_requests'],[])
        with closing(self.h.state.connect()) as db:
            q=db.execute('SELECT * FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual(q['claim_id'],ctx['request']['claim_id']);self.assertEqual(q['phase'],'suspended')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests WHERE thread_id=?',(q['thread_id'],)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],2)
            self.assertEqual(db.execute('SELECT is_final FROM host_team_dispatches WHERE attempt_id=?',(offer['attempt_id'],)).fetchone()[0],1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_operator_resumed_run'").fetchone()[0],1)
        next_turn=self.f.wire(page,'pulse',page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'c'*64})
        self.assertEqual(next_turn['state'],'offer');self.assertNotEqual(next_turn['attempt_id'],offer['attempt_id'])
        self.assertEqual(next_turn['request_id'],request)
        self.f.wire(page,'dispatch',attempt_id=next_turn['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro',
            'effort_label':'最高','user_hash':'c'*64})
        self.f.wire(page,'sent',attempt_id=next_turn['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro',
            'effort_label':'最高','user_hash':'e'*64,'generating':True},assistant_before_hash='f'*64)
        continued=self.f.private(page,'context',{})
        self.assertEqual(continued['request']['id'],request);self.assertEqual(continued['request']['claim_id'],ctx['request']['claim_id'])
        self.assertEqual(continued['run']['id'],run);self.assertEqual(continued['run']['dispatches'],before['dispatches']+1)
    def test_credit_saved_during_final_turn_reopens_original_goal_only_on_resume(self):
        page,request,offer,ctx=self.final_turn();run=ctx['run']['id'];before=self.runrow(run)
        reserved=self.refill(page,sends=12,seconds=3600)['budget']
        self.assertEqual(reserved['scope'],'next');self.assertEqual(self.runrow(run),before)
        self.end_final(page,request,offer,ctx);self.now+=600
        ready=self.view(page)['budget_status'];self.assertEqual(ready['scope'],'current')
        self.assertEqual(ready['available_sends'],reserved['available_sends'])
        self.assertEqual(ready['available_seconds'],3600)
        self.assertEqual(self.runrow(run),before)
        self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        after=self.runrow(run);self.assertEqual(after['max_dispatches'],before['dispatches']+reserved['available_sends'])
        self.assertEqual(after['deadline'],self.now+3600);self.assertEqual(after['final_granted'],0)
        self.assertFalse(self.view(page)['budget_status']['saved'])
    def test_refilling_ended_final_consumes_saved_credit_without_double_counting(self):
        page,request,offer,ctx=self.final_turn();run=ctx['run']['id'];before=self.runrow(run)
        saved=self.refill(page,sends=12,seconds=3600)['budget'];self.end_final(page,request,offer,ctx)
        result=self.refill(page,sends=3,seconds=1200)['budget'];after=self.runrow(run)
        self.assertEqual(after['max_dispatches'],before['dispatches']+saved['available_sends']+3)
        self.assertEqual(after['deadline'],self.now+4800);self.assertEqual(after['final_granted'],1)
        self.assertEqual(result['available_sends'],saved['available_sends']+3);self.assertFalse(result['saved'])
    def test_ended_final_needs_time_and_work_credit_and_preserves_identity_after_restart(self):
        page,request,offer,ctx=self.final_turn();run=ctx['run']['id'];self.end_final(page,request,offer,ctx)
        with closing(self.h.state.connect()) as db:
            db.execute('UPDATE host_runs SET max_dispatches=dispatches WHERE id=?',(run,));db.commit()
        self.refill(page,sends=0,seconds=3600);before=self.runrow(run)
        with self.assertRaisesRegex(HarnessError,'managed_resume_sends_exhausted'):
            self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        self.assertEqual(self.runrow(run),before)
        payload=self.payload(page,sends=4,seconds=0);self.m.browser('refill-budget',payload)
        self.h.managed=ManagedPages(self.h);self.m=self.h.managed;funded=self.runrow(run)
        self.assertTrue(self.m.browser('refill-budget',payload)['replayed']);self.assertEqual(self.runrow(run),funded)
        with self.assertRaisesRegex(HarnessError,'managed_resume_request_changed'):
            self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':'foreign-request'})
        self.assertEqual(self.runrow(run),funded)
        self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        self.assertEqual(self.runrow(run)['final_granted'],0)
    def test_ended_final_refill_preserves_maintenance_until_its_original_resume(self):
        page,request,offer,ctx=self.final_turn();run=ctx['run']['id'];self.end_final(page,request,offer,ctx)
        held=self.m.browser('maintenance',{'page_id':page,'action':'quiesce','operation_id':'held-ended-final'})
        self.assertEqual(held['state'],'settled')
        self.refill(page,sends=12,seconds=3600)
        funded=self.runrow(run);self.assertEqual(funded['reason'],'maintenance');self.assertEqual(funded['final_granted'],1)
        with self.assertRaisesRegex(HarnessError,'team_use_resume_maintenance'):
            self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        self.assertEqual(self.runrow(run),funded)
        self.m.browser('maintenance',{'page_id':page,'action':'resume-maintenance',
            'operation_id':'resume-held-final','checkpoint_hash':held['checkpoint_hash']})
        self.assertEqual(self.runrow(run)['final_granted'],1)
        resumed=self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        self.assertEqual(resumed['resumed_original_requests'],[request]);self.assertEqual(self.runrow(run)['final_granted'],0)
    def test_final_recovery_requires_actual_original_ending_and_no_unknown_execution(self):
        page,request,offer,ctx=self.final_turn();run=ctx['run']['id']
        self.refill(page,sends=12,seconds=3600)
        # A paused final still in flight may continue its accepted work, but it
        # cannot consume the reserved credit or receive another browser turn.
        self.m.browser('pause',{'page_id':page,'paused':True})
        self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        self.assertEqual(self.runrow(run)['final_granted'],1);self.assertEqual(self.runrow(run)['state'],'draining')
        self.end_final(page,request,offer,ctx)
        faults=[("UPDATE control_browser_receipts SET completed=NULL WHERE attempt_id=?",(offer['attempt_id'],)),
                ("UPDATE control_browser_receipts SET claim_id='foreign-claim' WHERE attempt_id=?",(offer['attempt_id'],)),
                ("UPDATE host_team_dispatches SET is_final=0 WHERE attempt_id=?",(offer['attempt_id'],)),
                ("UPDATE host_team_dispatches SET request_id='foreign-request' WHERE attempt_id=?",(offer['attempt_id'],)),
                ("UPDATE control_attempts SET state='unknown' WHERE id=?",(offer['attempt_id'],))]
        for sql,args in faults:
            with self.subTest(sql=sql),closing(self.h.state.connect()) as db:
                db.execute('SAVEPOINT original_fault');db.execute(sql,args)
                page_row=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(page,)).fetchone()
                from harness_managed_budget import ended_final_attention
                self.assertIsNone(ended_final_attention(db,page_row,self.runrow(run)))
                db.execute('ROLLBACK TO original_fault')
        with closing(self.h.state.connect()) as db:
            db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?,?)",('unknown-local','fingerprint','command',ctx['request']['thread_id'],'unknown',None,'now'));db.commit()
        before=self.runrow(run)
        with self.assertRaisesRegex(HarnessError,'managed_resume_finalizing'):
            self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        self.assertEqual(self.runrow(run),before)
        self.assertTrue(next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)['paused'])
    def test_invalid_refill_is_atomic(self):
        page,_,_,ctx=self.f.start_browser_turn();before=self.runrow(ctx['run']['id'])
        for sends,seconds in [(True,6),(-1,0),(1.5,10),(0,0),(1,604801)]:
            with self.subTest(sends=sends,seconds=seconds),self.assertRaises(HarnessError):self.refill(page,sends=sends,seconds=seconds)
        self.assertEqual(self.runrow(ctx['run']['id']),before)
    def test_maintenance_refill_excludes_held_time_without_resuming_team(self):
        import test_harness_managed_maintenance as mf
        other=mf.MaintenanceTests();other.setUp()
        try:
            parent,request,offer,ctx=other.base.start_browser_turn();run=ctx['run']['id']
            other.child(parent,ctx,sent=False)
            other.settle_parent(parent,request,offer,ctx)
            held=other.m.browser('maintenance',{'page_id':parent,'action':'quiesce','operation_id':'maintenance-budget-hold'})
            self.assertEqual(held['state'],'settled')
            with closing(other.h.state.connect()) as db:before=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run,)).fetchone())
            other.now+=900
            b=other.m.browser('view',{'page_id':parent})['budget_status']
            r=other.m.browser('refill-budget',{'page_id':parent,'operation_id':str(uuid.uuid4()),'expected_etag':b['etag'],'add_dispatches':20,'add_seconds':21600})
            self.assertEqual(r['budget']['available_seconds'],b['available_seconds']+21600)
            self.assertEqual(other.m.browser('view',{'page_id':parent})['maintenance']['state'],'settled')
            other.m.browser('maintenance',{'page_id':parent,'action':'resume-maintenance','operation_id':'maintenance-budget-resume','checkpoint_hash':held['checkpoint_hash']})
            with closing(other.h.state.connect()) as db:
                after=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run,)).fetchone())
                self.assertEqual(after['deadline'],before['deadline']+21600+900)
                self.assertEqual(after['dispatches'],before['dispatches'])
        finally:other.tearDown()

if __name__=='__main__':unittest.main()
