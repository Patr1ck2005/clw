"""Real fixture ledger boundaries for setup-only Latest crossover; no model sends."""
from pathlib import Path
from contextlib import closing
import sys,json,re,uuid,unittest
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_harness_managed as fixture
from harness_state import HarnessError
from harness_managed_models import accept_bootstrap_observed

PRO={'model':'GPT-6 · 最新','effort':'Pro','selection':['最新']}
SETUP={'model':'GPT-6 · 最新','effort':'极高','selection':['最新']}
OBSERVED={'model':'GPT-6.1 · Latest','effort':'Extra High','selection':['Latest'],
          'sliderCount':1,'sliderContainerCount':1,'slider':{'min':0,'max':4,'value':3}}

class BootstrapLatestTests(unittest.TestCase):
    def setUp(self):
        self.f=fixture.ManagedTests();self.f.setUp();self.m=self.f.m
    def tearDown(self):self.f.tearDown()
    def reserve(self,**overrides):
        return self.f.reserve(model=PRO['model'],effort=PRO['effort'],model_selection=PRO,
                              bootstrap_model_selection=SETUP,account='A',access='write',write_paths=['notes'],**overrides)
    def row(self,page):return next(r for r in self.m.browser('list',{})['pages'] if r['page_id']==page)
    def assert_no_send(self,page):
        self.assertEqual(self.row(page)['bootstrap_state'],'pending')
        with closing(self.f.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests').fetchone()[0],0)
    def test_observed_latest_setup_is_saved_without_changing_formal_work_or_identity(self):
        page,_=self.reserve();before=self.row(page)
        result=self.m.browser('bootstrap-model-ready',{'page_id':page,'model_selection':OBSERVED})
        after=self.row(page);self.assertTrue(result['verified']);self.assertEqual(result['model_sends'],0)
        self.assertEqual(result['model'],'gpt-6.1 · latest');self.assertEqual(after['bootstrap_model_selection'],OBSERVED)
        for field in ('page_id','target_id','thread_id','root','account','model','effort','access','write_paths','duration_seconds','max_dispatches'):
            self.assertEqual(after[field],before[field],field)
        self.assertEqual(after['model_selection'],PRO);self.assertEqual(after['effort'],'pro');self.assertTrue(after['work_model_pending'])
        self.assert_no_send(page)
    def test_wrong_family_named_choices_effort_and_duplicate_controls_are_rejected(self):
        page,_=self.reserve()
        for wrong in [{'model':'GPT-5.6 · Latest'},{'model':'GPT-7 · Latest'},{'model':'GPT-6.1 Sol'},
                      {'selection':['Newest']},{'selection':['GPT-6','Latest']},{'selection':[]},
                      {'effort':'Pro'},{'effort':'High'},{'sliderCount':2},{'sliderContainerCount':2}]:
            reason='managed_pro_enrollment_not_allowed_use_extra_high' if wrong.get('effort')=='Pro' else 'managed_model_observation_mismatch'
            with self.subTest(wrong=wrong),self.assertRaisesRegex(HarnessError,reason):
                self.m.browser('bootstrap-model-ready',{'page_id':page,'model_selection':{**OBSERVED,**wrong}})
            self.assertEqual(self.row(page)['bootstrap_model_selection'],SETUP);self.assert_no_send(page)
    def test_preparation_instructions_keep_exact_bootstrap_matching(self):
        page,_=self.reserve(first_turn_instructions='Review and deliver the substantive plan.')
        with self.assertRaisesRegex(HarnessError,'managed_model_observation_mismatch'):
            self.m.browser('bootstrap-model-ready',{'page_id':page,'model_selection':OBSERVED})
        self.m.browser('bootstrap-model-ready',{'page_id':page,'model_selection':SETUP});self.assert_no_send(page)
    def test_no_work_pending_first_task_and_sent_identity_cannot_use_setup_crossover(self):
        page={'model':PRO['model'],'effort':PRO['effort'],'phase':'reserved','bootstrap_state':'pending'}
        settings={'bootstrap_model_selection':SETUP,'work_model_pending':True}
        for row,config in [({**page,'phase':'bound'},settings),({**page,'bootstrap_state':'sent'},settings),
                           (page,{**settings,'work_model_pending':False}),(page,{**settings,'first_turn_mode':'task_v1'}),
                           (page,{**settings,'bootstrap_model_selection':{**SETUP,'selection':['GPT-6','Latest']}}),
                           (page,{**settings,'bootstrap_model_selection':{**SETUP,'model':'GPT-6 Sol','selection':['GPT-6 Sol']}})]:
            with self.subTest(row=row,config=config),self.assertRaisesRegex(HarnessError,'managed_model_observation_mismatch'):
                accept_bootstrap_observed(row,config,OBSERVED)
    def test_after_original_setup_formal_work_ready_is_still_exact_6_pro(self):
        page,prompt=self.reserve();self.m.browser('bootstrap-model-ready',{'page_id':page,'model_selection':OBSERVED})
        self.f.sessions[page]='wc_sess_'+uuid.uuid4().hex
        receiver=self.f.private(page,'enroll',{'ticket':re.search(r'clwm_[A-Za-z0-9_-]{43}',prompt['bootstrap_text'])[0],
                                              'project':'own-project','root':str(self.f.f.root)})
        self.m.browser('bind',{'page_id':page,'url':'https://chatgpt.com/c/'+str(uuid.uuid4()),'public_text':receiver['browser_marker']})
        for wrong in [OBSERVED,{**OBSERVED,'effort':'Pro'}]:
            with self.subTest(wrong=wrong),self.assertRaisesRegex(HarnessError,'managed_model_observation_mismatch'):
                self.m.browser('work-model-ready',{'page_id':page,'model_selection':wrong})
        actual_pro={**PRO,'model':'GPT-6 · Latest','selection':['Latest']}
        result=self.m.browser('work-model-ready',{'page_id':page,'model_selection':actual_pro})
        row=self.row(page);self.assertEqual(result['model_sends'],0);self.assertFalse(row['work_model_pending'])
        self.assertEqual(row['model'],'gpt-6 · latest');self.assertEqual(row['effort'],'pro');self.assertEqual(row['account'],'A')
        with closing(self.f.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts').fetchone()[0],0)

if __name__=='__main__':unittest.main()
