"""Real ledger transitions, with fixture Sessions only; no model is simulated."""
from contextlib import closing
import json,re,uuid,unittest
import test_harness_managed as managed_fixture
from harness_state import HarnessError
PAGE=managed_fixture.PAGE

class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.f=managed_fixture.ManagedTests();self.f.setUp();self.h=self.f.h;self.m=self.f.m
    def tearDown(self):self.f.tearDown()
    def begin(self,collaboration_protocol=None):
        if collaboration_protocol is None:
            page,request,offer,context=self.f.start_browser_turn()
        else:
            page,b=self.f.enroll(collaboration_protocol=collaboration_protocol)
            request=self.f.f.command(b['thread_id'],'message.send',{'text':'可核对的工作目标'})['request_id']
            offer=self.f.wire(page,'pulse')
            self.f.wire(page,'dispatch',attempt_id=offer['attempt_id'])
            sent={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True}
            self.f.wire(page,'sent',attempt_id=offer['attempt_id'],page=sent,assistant_before_hash='c'*64)
            context=self.f.private(page,'context',{})
        with closing(self.h.state.connect()) as db:
            self.h.team.checkpoint(db,self.h.binding(db,target=page),{'run_id':context['run']['id'],'expected_version':0,'summary':'已完成的事实、未决方案与精确公式 \\[x_1+\\alpha\\]','references':['result.md'],'basis_seq':0});db.commit()
        payload={'request_id':request,'claim_id':context['request']['claim_id'],'checkpoint_version':1,'no_pending_jobs':True}
        return page,request,offer,context,payload
    def finish_source(self,page,offer):
        result_page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64}
        result=self.f.wire(page,'result',attempt_id=offer['attempt_id'],page=result_page,assistant_turn_hash='d'*64,text='已保存公开检查点，交给后继；业务目标未完成。')
        self.assertEqual(result['state'],'yielded')
        return self.m.browser('list',{})
    def enroll_successor(self,page):
        row=next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==page)
        if row['bootstrap_model_selection']:
            self.m.browser('bootstrap-model-ready',{'page_id':page,'model_selection':row['bootstrap_model_selection']})
        self.f.sessions[page]='wc_sess_'+uuid.uuid4().hex
        self.m.browser('bootstrap',{'page_id':page,'state':'sending'})
        self.m.browser('bootstrap',{'page_id':page,'state':'sent'})
        ticket=re.search(r'clwm_[A-Za-z0-9_-]{43}',row['bootstrap_text'])[0]
        receiver=self.f.private(page,'enroll',{'ticket':ticket,'project':'own-project','root':str(self.f.f.root)})
        self.m.browser('bind',{'page_id':page,'url':'https://chatgpt.com/c/'+str(uuid.uuid4()),'public_text':receiver['browser_marker']})
        if row['work_model_pending']:
            self.m.browser('work-model-ready',{'page_id':page,'model_selection':row['model_selection']})
        self.m.browser('list',{})
        return receiver
    def test_successor_setup_uses_same_family_extra_high_and_keeps_formal_pro(self):
        page,request,offer,context,p=self.begin()
        pro={'model':'GPT-6 · 最新','effort':'Pro','selection':['最新'],
             'slider':{'min':0,'max':4,'value':4},'description':'6 Pro'}
        with closing(self.h.state.connect()) as db:
            settings=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0])
            settings.update(model_selection=pro,bootstrap_model_selection=pro,account='A')
            db.execute('UPDATE managed_pages SET model=?,effort=?,settings=? WHERE page_id=?',
                       (pro['model'],'pro',json.dumps(settings),page));db.commit()
        successor=self.f.private(page,'handoff',p)['successor_page']
        row=next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==successor)
        self.assertEqual(row['bootstrap_model_selection'],{'model':pro['model'],'selection':['最新'],'effort':'极高'})
        self.assertEqual(row['model_selection'],pro);self.assertEqual(row['effort'],'pro')
        self.assertTrue(row['work_model_pending']);self.assertEqual(row['account'],'A')
        self.finish_source(page,offer);self.enroll_successor(successor)
        next_offer=self.f.wire(successor,'pulse',page={**PAGE,'model_label':pro['model'],'effort_label':'Pro'})
        self.assertEqual(next_offer['state'],'offer')
        with closing(self.h.state.connect()) as db:
            run=db.execute('SELECT * FROM host_runs WHERE id=?',(context['run']['id'],)).fetchone()
            self.assertEqual(run['deadline'],context['run']['deadline']);self.assertEqual(run['max_dispatches'],40)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_runs').fetchone()[0],1)

    def test_explicit_resume_repairs_only_original_unsent_enrolling_successor(self):
        for scenario in ('pending','sent','unknown','refusal','cancelled','changed-claim','deadline','unrelated'):
            with self.subTest(scenario=scenario):
                if scenario!='pending':self.tearDown();self.setUp()
                page,request,offer,context,p=self.begin()
                successor=self.f.private(page,'handoff',p)['successor_page'];self.finish_source(page,offer)
                pro={'model':'GPT-6 · 最新','effort':'Pro','selection':['最新'],'slider':{'value':4}}
                with closing(self.h.state.connect()) as db:
                    settings=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(successor,)).fetchone()[0])
                    settings.update(model_selection=pro,bootstrap_model_selection=pro,work_model_pending=False)
                    state=scenario if scenario in ('sent','unknown') else 'pending'
                    db.execute('UPDATE managed_pages SET model=?,effort=?,settings=?,bootstrap_state=? WHERE page_id=?',
                               (pro['model'],'pro',json.dumps(settings),state,successor))
                    if scenario=='cancelled':db.execute('UPDATE host_requests SET cancel_requested=1 WHERE id=?',(request,))
                    if scenario=='changed-claim':db.execute('UPDATE host_requests SET claim_id=? WHERE id=?',('changed',request))
                    if scenario=='deadline':db.execute('UPDATE host_runs SET deadline=? WHERE id=?',(self.h.clock()-1,context['run']['id']))
                    if scenario=='unrelated':db.execute('DELETE FROM managed_handoffs WHERE successor_page=?',(successor,))
                    db.commit()
                self.m.browser('page-issue',{'page_id':successor,'kind':'bootstrap_failed' if scenario=='refusal' else 'preparation_required',
                                           'detail':'Original enrollment failure, never a model Send.'})
                before=next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==successor)
                self.m.browser('pause',{'page_id':successor,'paused':False})
                after=next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==successor)
                repair=scenario=='pending'
                self.assertEqual(after['bootstrap_model_selection']['effort'],'极高' if repair else 'Pro')
                for field in ('page_id','target_id','thread_id','parent_target','phase','bootstrap_state','bootstrap_text','model','effort'):
                    self.assertEqual(before[field],after[field])
                with closing(self.h.state.connect()) as db:
                    saved=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(successor,)).fetchone()[0])
                    self.assertEqual('enrollment_repair' in saved,repair)
                    self.assertEqual(db.execute('SELECT COUNT(*) FROM host_runs').fetchone()[0],1)
    def test_safe_handoff_waits_for_real_turn_receipt_and_retains_original_budget(self):
        page,request,offer,context,p=self.begin();key=str(uuid.uuid4())
        # Older managed pages had no stored protocol key; their successor stays legacy.
        with closing(self.h.state.connect()) as db:
            settings=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0])
            self.assertEqual(settings.pop('collaboration_protocol'),'tool_v1')
            db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(json.dumps(settings),page))
            db.commit()
        result=self.f.private(page,'handoff',p,key);successor=result['successor_page']
        self.assertEqual(self.f.private(page,'handoff',p,key),result)
        self.assertEqual(self.m.browser('list',{})['pages'][-1]['phase'],'handoff_waiting')
        self.assertEqual(self.m.browser('list',{})['pages'][-1]['collaboration_protocol'],'tool_v1')
        with self.assertRaises(HarnessError):self.m.browser('bootstrap',{'page_id':successor,'state':'sending'})
        self.finish_source(page,offer);receiver=self.enroll_successor(successor)
        next_offer=self.f.wire(successor,'pulse');self.assertEqual(next_offer['state'],'offer')
        dispatch=self.f.wire(successor,'dispatch',attempt_id=next_offer['attempt_id'])
        self.assertIn('managed_client.py',dispatch['prompt'])
        sent={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'e'*64}
        self.f.wire(successor,'sent',attempt_id=next_offer['attempt_id'],page=sent,assistant_before_hash='d'*64)
        current=self.f.private(successor,'context',{})
        self.assertEqual(current['run']['id'],context['run']['id'])
        self.assertEqual(current['run']['deadline'],context['run']['deadline'])
        self.assertEqual(current['run']['max_dispatches'],40)
        self.assertEqual(current['run']['dispatches'],3)
        self.assertNotEqual(current['request']['claim_id'],context['request']['claim_id'])
        self.assertNotEqual(current['session_id'],context['session_id'])
        self.assertEqual(current['handoff']['source_request'],request)
        self.assertIn('x_1',current['handoff']['checkpoint']['summary'])
        with closing(self.h.state.connect()) as db:
            old=db.execute('SELECT phase,claim_id,thread_id FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual(tuple(old),('handed_off',context['request']['claim_id'],context['request']['thread_id']))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_runs').fetchone()[0],1)
        with self.assertRaises(HarnessError):self.m.browser('pause',{'page_id':page,'paused':False})
    def test_text_v1_handoff_preserves_controller_protocol_and_prompt(self):
        page,_,offer,_,p=self.begin(collaboration_protocol='text_v1')
        child,_=self.f.enroll(page)
        successor=self.f.private(page,'handoff',p)['successor_page']
        rows={row['page_id']:row for row in self.m.browser('list',{})['pages']}
        self.assertEqual(rows[page]['collaboration_protocol'],'text_v1')
        self.assertEqual(rows[successor]['collaboration_protocol'],'text_v1')
        self.finish_source(page,offer)
        self.enroll_successor(successor)
        next_offer=self.f.wire(successor,'pulse')
        self.assertEqual(next_offer['state'],'offer')
        dispatch=self.f.wire(successor,'dispatch',attempt_id=next_offer['attempt_id'])
        self.assertIn('clw-plan-v1',dispatch['prompt'])
        self.assertIn('你是主控',dispatch['prompt'])
        self.assertIn(child,dispatch['prompt'])
        sent={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'e'*64}
        self.f.wire(successor,'sent',attempt_id=next_offer['attempt_id'],
                    page={**sent,'generating':True},assistant_before_hash='d'*64)
        plan='接续原协作者。\n```clw-plan-v1\n'+json.dumps({
            'version':1,'action':'dispatch','workers':[{'key':'A','target':child,'objective':'核对原成果'}],
            'wait':{'mode':'all','workers':['A']},'resume':'整合'},ensure_ascii=False)+'\n```'
        self.m.browser('artifact',{'page_id':successor,'attempt_id':next_offer['attempt_id'],
                                   'text':plan,'assistant_turn_hash':'f'*64})
        self.assertEqual(self.f.wire(successor,'result',attempt_id=next_offer['attempt_id'],
                                     page=sent,assistant_turn_hash='f'*64,text=plan)['state'],'yielded')
        with closing(self.h.state.connect()) as db:
            run=db.execute('SELECT id FROM host_runs WHERE controller_thread=?',
                           (self.h.binding(db,target=successor)['thread_id'],)).fetchone()[0]
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work WHERE run_id=?',
                                        (run,)).fetchone()[0],1)
    def test_explicit_pause_survives_service_reconstruction_during_handoff(self):
        page,request,offer,context,p=self.begin();successor=self.f.private(page,'handoff',p)['successor_page']
        self.m.browser('pause',{'page_id':successor,'paused':True})
        self.finish_source(page,offer)
        from harness_managed import ManagedPages
        restored=ManagedPages(self.h)
        row=next(x for x in restored.browser('list',{})['pages'] if x['page_id']==successor)
        self.assertEqual(row['phase'],'reserved');self.assertTrue(row['paused'])
        with self.assertRaises(HarnessError):restored.browser('bootstrap',{'page_id':successor,'state':'sending'})
    def test_handoff_rejects_late_append_without_acknowledging_or_losing_it(self):
        page,request,offer,context,p=self.begin();successor=self.f.private(page,'handoff',p)['successor_page']
        note=self.f.f.command(context['request']['thread_id'],'message.append',{'text':'New constraint during handoff','expected_request_id':request})
        self.assertEqual(note['state'],'rejected')
        self.assertEqual(note['code'],'host_handoff_in_progress')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_notes WHERE request_id=?',(request,)).fetchone()[0],0)
        self.finish_source(page,offer);self.enroll_successor(successor)
    def test_deadline_expiry_and_original_cancel_stop_handoff_without_budget_reset(self):
        for reason in ('deadline','cancel'):
            with self.subTest(reason=reason):
                if reason=='cancel':self.tearDown();self.setUp()
                page,request,offer,context,p=self.begin();successor=self.f.private(page,'handoff',p)['successor_page']
                with closing(self.h.state.connect()) as db:
                    if reason=='deadline':db.execute('UPDATE host_runs SET deadline=? WHERE id=?',(self.h.clock()-1,context['run']['id']))
                    else:db.execute('UPDATE host_requests SET cancel_requested=1 WHERE id=?',(request,))
                    db.commit()
                rows=self.m.browser('list',{})['pages']
                self.assertTrue(all(x['paused'] for x in rows))
                self.assertTrue(all(x['attention'] for x in rows))
                with closing(self.h.state.connect()) as db:
                    self.assertEqual(db.execute('SELECT state FROM managed_handoffs').fetchone()[0],'needs_attention')
                    self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests WHERE thread_id IS NOT NULL AND id LIKE ?',('clw-handoff-%',)).fetchone()[0],0)
                    self.assertEqual(db.execute('SELECT dispatches FROM host_runs').fetchone()[0],1)
    def test_missing_checkpoint_unread_notes_or_live_children_refuse_handoff(self):
        page,request,offer,context,p=self.begin()
        with self.assertRaises(HarnessError):self.f.private(page,'handoff',{**p,'checkpoint_version':2})
        with self.assertRaises(HarnessError):self.f.private(page,'handoff',{**p,'no_pending_jobs':False})
        self.f.f.command(context['request']['thread_id'],'message.append',{'text':'新约束','expected_request_id':request})
        with self.assertRaises(HarnessError):self.f.private(page,'handoff',p)
        self.f.private(page,'context',{})
        child,_=self.f.enroll(page)
        with closing(self.h.state.connect()) as db:
            self.h.team.assign(db,self.h.binding(db,target=page),{'run_id':context['run']['id'],'claim_id':p['claim_id'],'target':child,'text':'尚未完成的真实工作占位','depends_on':[],'resources':[]},str(uuid.uuid4()));db.commit()
        with self.assertRaises(HarnessError):self.f.private(page,'handoff',p)
    def test_reuses_completed_worker_without_reparenting_its_session(self):
        page,request,offer,context,p=self.begin();child,child_binding=self.f.enroll(page)
        successor=self.f.private(page,'handoff',p)['successor_page']
        self.finish_source(page,offer);receiver=self.enroll_successor(successor)
        with closing(self.h.state.connect()) as db:
            actor=self.h.binding(db,target=successor)
            inherited=self.h.team.carriers.may_manage(db,actor,child)
            self.assertEqual(inherited['thread_id'],child_binding['thread_id'])
            self.assertEqual(inherited['spec']['parent_target_id'],page)
            self.assertEqual(inherited['spec']['session_id'],self.f.sessions[child])
        rows={x['page_id']:x for x in self.m.browser('list',{})['pages']}
        self.assertTrue(rows[page]['paused']);self.assertFalse(rows[child]['paused'])
        self.m.browser('pause',{'page_id':successor,'paused':True})
        self.assertTrue(next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==child)['paused'])
    def test_worker_resume_uses_live_successor_pause_without_changing_historical_parent(self):
        page,request,offer,context,p=self.begin();child,_=self.f.enroll(page)
        successor=self.f.private(page,'handoff',p)['successor_page']
        self.finish_source(page,offer);self.enroll_successor(successor)
        self.m.browser('pause',{'page_id':child,'paused':True})
        self.m.browser('pause',{'page_id':child,'paused':False})
        rows={x['page_id']:x for x in self.m.browser('list',{})['pages']}
        self.assertFalse(rows[child]['paused']);self.assertEqual(rows[child]['parent_target'],page)
        self.assertTrue(rows[page]['paused'])
        self.m.browser('pause',{'page_id':successor,'paused':True})
        with self.assertRaises(HarnessError):self.m.browser('pause',{'page_id':child,'paused':False})

    def test_result_cursor_keeps_original_reader_and_old_controller_cannot_mutate(self):
        page,request,offer,context,p=self.begin();child,_=self.f.enroll(page);run=context['run']['id']
        with closing(self.h.state.connect()) as db:
            assigned=self.h.team.assign(db,self.h.binding(db,target=page),{'run_id':run,'claim_id':p['claim_id'],'target':child,'text':'Read and return exact formulas','depends_on':[],'resources':[]},str(uuid.uuid4()));db.commit()
        co=self.f.wire(child,'pulse');self.f.wire(child,'dispatch',attempt_id=co['attempt_id'])
        state={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64}
        self.f.wire(child,'sent',attempt_id=co['attempt_id'],page=state,assistant_before_hash='c'*64)
        cc=self.f.private(child,'context',{})
        self.f.private(child,'turn-end',{'request_id':assigned['request_id'],'claim_id':cc['request']['claim_id'],'outcome':'completed','markdown':'Exact result: \\[x_1+\\alpha\\].'})
        self.f.wire(child,'result',attempt_id=co['attempt_id'],page=state,assistant_turn_hash='d'*64,text='Public result summary')
        with closing(self.h.state.connect()) as db:
            actor=self.h.binding(db,target=page)
            result=self.h.team.journal.result(db,actor,{'run_id':run,'request_id':assigned['request_id']})
            latest=db.execute('SELECT MAX(seq) FROM host_team_signals WHERE run_id=?',(run,)).fetchone()[0]
            self.h.team.checkpoint(db,actor,{'run_id':run,'expected_version':1,'summary':'Read result, ready for successor','references':[],'basis_seq':latest});db.commit()
        successor=self.f.private(page,'handoff',{**p,'checkpoint_version':2})['successor_page']
        self.finish_source(page,offer);self.enroll_successor(successor)
        with closing(self.h.state.connect()) as db:
            actor=self.h.binding(db,target=successor);original=self.h.binding(db,target=page)
            self.h.team.require_results_read(db,actor,self.h.team.owned(db,actor,run),latest)
            continuation=self.h.team.journal.result(db,actor,{'run_id':run,'request_id':assigned['request_id'],'after_seq':result['next_after']})
            self.assertIsNone(continuation['reply'])
            readers=[r[0] for r in db.execute('SELECT controller_thread FROM host_team_reads WHERE run_id=?',(run,))]
            self.assertEqual(readers,[original['thread_id']]);db.commit()
        with self.assertRaises(HarnessError):
            self.h.team.handle(original,{'op':'pause','operation_id':str(uuid.uuid4()),'payload':{'run_id':run,'reason':'old source must not control successor'}})
        self.assertIn(child,[r['target_id'] for r in self.f.private(successor,'pages',{})['pages']])

if __name__=='__main__':unittest.main()
