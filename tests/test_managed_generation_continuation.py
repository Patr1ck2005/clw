"""Managed browser recovery over the real ledger, without model requests."""
from pathlib import Path
from contextlib import closing
import sys,unittest,hashlib,json
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_harness_managed as fixture
from test_harness_control_plane import PAGE
from harness_managed import ManagedPages
from harness_user_authorization import user_authorization
from harness_recovery import CONTINUATION_SENTENCE
from harness_state import HarnessError

class GenerationContinuationTests(unittest.TestCase):
    def setUp(self):
        self.f=fixture.ManagedTests();self.f.setUp()
        self.now=[1000.];self.f.h.clock=lambda:self.now[0]
    def tearDown(self):self.f.tearDown()
    def test_slow_recovery_keeps_claim_budget_and_context_across_restart(self):
        f=self.f
        page,request,offer,context=f.start_browser_turn()
        claim=context['request']['claim_id'];run=context['run']['id']
        failed={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'failure_kind':'generation_failed','failure_hash':'f'*64}
        self.assertEqual(f.wire(page,'pulse',page=failed)['state'],'browser_result_failed_recovery_pending')
        self.assertEqual(f.m.browser('view',{'page_id':page})['automatic_recovery']['state'],'backoff')
        self.now[0]+=300
        f.h.managed=f.m=ManagedPages(f.h)
        recovery=f.wire(page,'pulse',page=failed)
        self.assertEqual(recovery['state'],'offer');self.assertTrue(recovery['recovery']);self.assertEqual(recovery['request_id'],request)
        prompt=f.wire(page,'dispatch',attempt_id=recovery['attempt_id'],page=failed)['prompt']
        self.assertEqual(prompt.count(CONTINUATION_SENTENCE),1)
        self.assertIn('--attempt-id '+recovery['attempt_id'],prompt)
        self.assertIn('--session-id '+f.sessions[page],prompt)
        self.assertIn('沿本对话原 Session 执行',prompt)
        self.assertEqual(prompt.count(user_authorization().strip()),0)
        f.wire(page,'sent',attempt_id=recovery['attempt_id'],page={**failed,'user_hash':'c'*64,'failure_kind':'','generating':True},assistant_before_hash='d'*64)
        recovered=f.private(page,'context',{})
        self.assertEqual(recovered['request']['id'],request);self.assertEqual(recovered['request']['claim_id'],claim)
        self.assertEqual(recovered['run']['id'],run);self.assertEqual(recovered['run']['dispatches'],2)
        self.assertIsNone(f.m.browser('view',{'page_id':page})['automatic_recovery'])

    def test_repeated_failures_are_bounded_and_visible_not_silently_idle(self):
        f=self.f;page,request,offer,context=f.start_browser_turn();user='b'
        for i in range(4):
            failed={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':user*64,'failure_kind':'generation_failed','failure_hash':'f'*64}
            f.wire(page,'pulse',page=failed)
            state=f.m.browser('view',{'page_id':page})['automatic_recovery']
            self.assertEqual(state['state'],'exhausted' if i==3 else 'backoff')
            self.now[0]+=300
            next_offer=f.wire(page,'pulse',page=failed)
            if i==3:
                self.assertNotEqual(next_offer['state'],'offer');break
            f.wire(page,'dispatch',attempt_id=next_offer['attempt_id'],page=failed)
            user=chr(ord(user)+1)
            f.wire(page,'sent',attempt_id=next_offer['attempt_id'],page={**failed,'user_hash':user*64,'generating':True,'failure_kind':''},assistant_before_hash='d'*64)
        self.assertEqual(f.private(page,'context',{})['run']['dispatches'],4)
        with closing(f.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests WHERE id=?',(request,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_recoveries WHERE request_id=?',(request,)).fetchone()[0],3)

    def test_failure_after_reload_reconciles_exact_marker_before_recovery(self):
        f=self.f;page,request,offer,context=f.start_browser_turn()
        f.m.browser('prepare',{'page_id':page,'attempt_id':offer['attempt_id'],'assistant_before_hash':'c'*64,'prompt_hash':'d'*64})
        failed={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'c'*64,
                'failure_kind':'generation_failed','failure_hash':'f'*64}
        self.assertEqual(f.wire(page,'pulse',page=failed)['state'],'browser_result_pending')
        row=next(p for p in f.m.browser('list',{})['pages'] if p['page_id']==page)
        observation={'page_id':page,'url':row['url'],'attempt_id':offer['attempt_id'],
            'previous_user_hash':'b'*64,'user_hash':'c'*64,'marker':'[CLW:'+offer['attempt_id']+']',
            'marker_count':1,'history_at_latest':True,'terminal_failure':'无法思考','complete':False}
        for invalid in ({'marker_count':2},{'history_at_latest':False},{'terminal_failure':'OpenAI blocked this tool'}):
            with self.assertRaises(HarnessError):f.m.browser('reconcile-user',{**observation,**invalid})
        f.m.browser('reconcile-user',observation)
        self.assertEqual(f.wire(page,'pulse',page=failed)['state'],'browser_result_failed_recovery_pending')
        self.now[0]+=300
        retry=f.wire(page,'pulse',page=failed)
        self.assertTrue(retry['recovery']);self.assertEqual(retry['request_id'],request)
        self.assertEqual(f.private(page,'context',{})['request']['claim_id'],context['request']['claim_id'])

    def test_saved_close_summary_is_recovered_without_a_model_round(self):
        f=self.f;page,request,offer,context=f.start_browser_turn()
        with closing(f.h.state.connect()) as db:
            b=f.h.binding(db,target=page)
            f.h.team.lifecycle(db,b,'close',{'run_id':context['run']['id'],'claim_id':context['request']['claim_id'],
                'summary':'Implementation saved; independent review remains blocked.','references':['RESULT.md']})
            db.commit()
        failed={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'failure_kind':'generation_failed','failure_hash':'f'*64}
        f.wire(page,'pulse',page=failed)
        self.now[0]+=300
        self.assertNotEqual(f.wire(page,'pulse',page=failed)['state'],'offer')
        view=f.m.browser('view',{'page_id':page})
        self.assertEqual(view['latest_request']['phase'],'completed');self.assertEqual(view['run']['dispatches'],1)
        self.assertTrue(any('independent review remains blocked' in e['data'].get('text','') for e in view['events']))
        with closing(f.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT count(*) FROM control_recoveries WHERE request_id=?',(request,)).fetchone()[0],0)

    def failed_offered_turn(self):
        f=self.f;page,request,original,context=f.start_browser_turn()
        f.m.browser('prepare',{'page_id':page,'attempt_id':original['attempt_id'],'assistant_before_hash':'c'*64,'prompt_hash':'d'*64})
        failed={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,
                'failure_kind':'generation_failed','failure_hash':hashlib.sha256('无法思考'.encode()).hexdigest()}
        f.wire(page,'pulse',page=failed);self.now[0]+=300
        offered=f.wire(page,'pulse',page=failed);self.assertEqual(offered['state'],'offer')
        row=next(p for p in f.m.browser('list',{})['pages'] if p['page_id']==page)
        public={'url':row['url'],'marker':'[CLW:'+original['attempt_id']+']','marker_count':1,
                'history_at_latest':True,'terminal_failure':'无法思考'}
        return page,request,original,offered,context,failed,public

    def test_failed_offered_turn_remount_rebinds_the_same_recovery_only(self):
        f=self.f;page,request,original,offered,context,failed,public=self.failed_offered_turn()
        remounted={**failed,'user_hash':'c'*64}
        self.assertNotEqual(f.wire(page,'pulse',page=remounted)['state'],'offer')
        f.h.managed=f.m=ManagedPages(f.h)
        resumed=f.wire(page,'pulse',page=remounted,public_failure=public)
        self.assertEqual(resumed['attempt_id'],offered['attempt_id']);self.assertEqual(resumed['request_id'],request)
        with closing(f.h.state.connect()) as db:
            event=json.loads(db.execute("SELECT data FROM events WHERE kind='managed_failed_turn_identity_reconciled'").fetchone()[0])
            self.assertEqual(event['attempt_id'],original['attempt_id']);self.assertEqual(event['model_sends'],0)
            self.assertEqual(db.execute('SELECT count(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],2)
            self.assertEqual(db.execute('SELECT count(*) FROM control_recoveries WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertIsNone(db.execute('SELECT dispatched FROM control_attempts WHERE id=?',(offered['attempt_id'],)).fetchone()[0])
        f.wire(page,'dispatch',attempt_id=resumed['attempt_id'],page=remounted)
        f.wire(page,'sent',attempt_id=resumed['attempt_id'],page={**remounted,'user_hash':'d'*64,'failure_kind':'','generating':True},assistant_before_hash='e'*64)
        after=f.private(page,'context',{})
        self.assertEqual(after['request']['claim_id'],context['request']['claim_id']);self.assertEqual(after['run']['id'],context['run']['id'])
        self.assertEqual(after['run']['dispatches'],context['run']['dispatches']+1)

    def test_failed_identity_requires_original_visible_failure_and_preserves_pauses(self):
        f=self.f;page,request,original,offered,context,failed,public=self.failed_offered_turn()
        remounted={**failed,'user_hash':'c'*64}
        def unchanged():
            with closing(f.h.state.connect()) as db:
                self.assertEqual(db.execute('SELECT user_hash FROM control_attempts WHERE id=?',(offered['attempt_id'],)).fetchone()[0],'b'*64)
                self.assertEqual(db.execute('SELECT count(*) FROM events WHERE kind=?',('managed_failed_turn_identity_reconciled',)).fetchone()[0],0)
        for invalid in ({'marker':'[CLW:control_'+'e'*32+']'},{'marker_count':2},{'marker_count':True},
                        {'history_at_latest':False},{'url':'https://chatgpt.com/c/foreign'},
                        {'terminal_failure':'OpenAI blocked this tool'}):
            with self.subTest(invalid=invalid):
                f.wire(page,'pulse',page=remounted,public_failure={**public,**invalid});unchanged()
        for flag in ('generating','draft','composing','blocked'):
            f.wire(page,'pulse',page={**remounted,flag:True},public_failure=public);unchanged()
        f.m.browser('pause',{'page_id':page,'paused':True})
        with self.assertRaises(HarnessError):f.wire(page,'pulse',page=remounted,public_failure=public)
        unchanged()

    def test_failed_identity_cannot_modify_an_already_dispatched_recovery(self):
        f=self.f;page,request,original,offered,context,failed,public=self.failed_offered_turn()
        f.wire(page,'dispatch',attempt_id=offered['attempt_id'],page=failed)
        f.wire(page,'pulse',page={**failed,'user_hash':'c'*64},public_failure=public)
        with closing(f.h.state.connect()) as db:
            row=db.execute('SELECT state,user_hash FROM control_attempts WHERE id=?',(offered['attempt_id'],)).fetchone()
            self.assertEqual((row['state'],row['user_hash']),('dispatching','b'*64))
            self.assertEqual(db.execute('SELECT count(*) FROM events WHERE kind=?',('managed_failed_turn_identity_reconciled',)).fetchone()[0],0)

if __name__=='__main__':unittest.main()
