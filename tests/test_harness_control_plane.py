"""Isolated protocol tests for the real ControlPlane. No external models/pages."""
from pathlib import Path
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import copy,json,sys,unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
import test_harness_collaboration as fixtures
from harness_state import HarnessError
from harness_control_plane import permitted_labels
from harness_recovery import CONTINUATION_SENTENCE,continuation_prompt
from harness_work_package import WORK_PACKAGE_GUIDANCE

ORIGIN='chrome-extension://'+'a'*32
URL='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555'
PAGE=dict(visible=True,generating=False,draft=False,composing=False,focused=False,
          blocked=False,stopped=False,controls_known=True,model_pro_visible=False,effort_disallowed_visible=False,
          editor_known=True,user_known=True,mode_control_known=True,model_label='GPT-5.6 Sol',
          effort_label='Extra High',user_hash='a'*64,failure_hash='0'*64,failure_kind='')

def receiver_marker(f,target='child-a'):
    ticket=f.p('main','team',op='invite',operation_id=fixtures.uid(),payload={'target':target,'allow_rebind':False,'ttl_seconds':600,'reason':'Explicit isolated receiver enrollment'})
    return f.p(target,'team',op='enroll',operation_id=fixtures.uid(),payload={'ticket':ticket['ticket'],'project':f.s.host_bridge.targets['main']['project'],'root':str(f.root)})['browser_marker']

class ControlTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.CollaborationTests();self.f.setUp()
        self.now=1000.;self.h=self.f.s.host_bridge;self.h.clock=lambda:self.now
        self.c=self.h.control;self.bindings={}
    def tearDown(self):self.f.tearDown()
    def p(self,action,target='main',**data):return self.f.p(target,action,**data)
    def code(self,target='main'):
        return self.p('control-code',target,confirm=True,model_label='GPT-5.6 Sol',effort_label='Extra High')['pair_code']
    def pair(self,target='main',url=URL):
        raw=dict(action='pair',code=self.code(target),chat_url=url,tab_nonce='a'*32)
        pair=self.c.wire(ORIGIN,None,raw);self.bindings[target]=(pair,raw)
        return pair
    def wire(self,action,target='main',**data):
        p,r=self.bindings[target]
        return self.c.wire(ORIGIN,p['control_token'],dict(action=action,generation=p['generation'],chat_url=r['chat_url'],tab_nonce=r['tab_nonce'],**data))
    def request(self):return self.f.command(self.f.parent['id'],'message.send',{'text':'Original scoped work'})['request_id']
    def pulse(self,target='main',**page):return self.wire('pulse',target,page={**PAGE,**page})
    def offer(self):self.pair();r=self.request();return r,self.pulse()
    def grant(self,offer,target='main'):return self.wire('dispatch',target,attempt_id=offer['attempt_id'],page=PAGE)
    def sent(self,offer,target='main',user='b',assistant_before='c'):
        return self.wire('sent',target,attempt_id=offer['attempt_id'],
            page={**PAGE,'user_hash':user*64,'generating':True},
            assistant_before_hash=assistant_before*64)
    def browser_result(self,offer,target='main',text='Complete public browser result',user='b',turn='d'):
        return self.wire('result',target,attempt_id=offer['attempt_id'],
            page={**PAGE,'user_hash':user*64},assistant_turn_hash=turn*64,text=text)
    def failure_offer(self):
        request,original=self.offer();self.grant(original);self.sent(original)
        failed={**PAGE,'user_hash':'b'*64,'failure_kind':'generation_failed','failure_hash':'e'*64}
        self.assertEqual(self.wire('pulse',page=failed)['state'],'browser_result_failed_recovery_pending')
        self.now+=15;recovery=self.wire('pulse',page=failed)
        self.assertEqual(recovery['state'],'offer');self.assertTrue(recovery['recovery'])
        return request,original,recovery,failed

    def test_default_has_no_control_pairing(self):
        self.assertFalse(self.p('control-status')['paired'])
        self.assertEqual(self.p('control-status')['attempts'],[])
    def test_browser_turn_after_parent_yield_preserves_request_and_resumes_once(self):
        self.f.join()
        request,offer=self.offer();self.grant(offer);self.sent(offer)
        with closing(self.h.state.connect()) as db:
            claim=db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0]
        child=self.f.delegate(request,claim=claim)
        self.p('yield',request_id=request,claim_id=claim)
        result=self.browser_result(offer,text='Waiting for the independently running worker.')
        self.assertEqual(result['state'],'yielded')
        self.assertEqual(self.browser_result(offer,text='Waiting for the independently running worker.'),{**result,'replayed':True})
        with closing(self.h.state.connect()) as db:
            original=db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',(request,)).fetchone()
        self.assertEqual((original['phase'],original['claim_id']),('suspended',claim))
        self.assertNotEqual(self.pulse(user_hash='b'*64)['state'],'offer')
        child_claim=fixtures.uid()
        self.f.p('child-a','claim',request_id=child['child_request_id'],claim_id=child_claim)
        self.f.finish('child-a',child['child_request_id'],child_claim)
        resume=self.pulse(user_hash='b'*64)
        self.assertEqual(resume['state'],'offer')
        self.assertEqual(resume['request_id'],request)
        self.assertNotEqual(resume['attempt_id'],offer['attempt_id'])
        self.assertEqual(self.pulse(user_hash='b'*64)['attempt_id'],resume['attempt_id'])
    def test_model_budget_policy(self):
        for model in ['GPT-6 Pro','GPT-5.6 Sol Pro','GPT-5.6','',None]:
            with self.assertRaises(HarnessError):permitted_labels(model,'Extra High')
        for effort in ['High','Low','max']:
            with self.assertRaises(HarnessError):permitted_labels('GPT-5.6 Sol',effort)
        self.assertEqual(permitted_labels('GPT-5.6 Sol','Medium'),('gpt-5.6 sol','medium'))
        self.assertEqual(permitted_labels('GPT-5.6 Sol','中等'),('gpt-5.6 sol','中等'))
        self.assertEqual(permitted_labels('GPT-5.6 Sol','极高'),('gpt-5.6 sol','极高'))
    def test_pair_requires_confirmation(self):
        with self.assertRaises(HarnessError):self.p('control-code',confirm=False,model_label='GPT-5.6 Sol',effort_label='Extra High')
    def test_pair_code_single_use_and_expiry(self):
        code=self.code();data=dict(action='pair',code=code,chat_url=URL,tab_nonce='a'*32)
        self.c.wire(ORIGIN,None,data)
        with self.assertRaises(HarnessError):self.c.wire(ORIGIN,None,data)
        data['code']=self.code();self.now+=121
        with self.assertRaises(HarnessError):self.c.wire(ORIGIN,None,data)
    def test_only_exact_chat_urls(self):
        for url in ['https://chatgpt.com/','https://chatgpt.com/c/'+('a'*20)+'?other=1','http://chatgpt.com/c/'+('a'*20),'https://evil.test/c/'+('a'*20)]:
            with self.assertRaises(HarnessError):self.c.wire(ORIGIN,None,dict(action='pair',code=self.code(),chat_url=url,tab_nonce='a'*32))
    def test_old_request_requires_explicit_adopt(self):
        r=self.request();self.pair();self.assertNotEqual(self.pulse()['state'],'offer')
        self.p('control-adopt',confirm=True,request_id=r)
        self.assertEqual(self.pulse()['request_id'],r)
    def test_new_request_offer_does_not_claim(self):
        r,o=self.offer();self.assertEqual(o['state'],'offer')
        self.assertEqual(self.p('read',request_id=r)['phase'],'queued')
        self.assertEqual(self.pulse()['attempt_id'],o['attempt_id'])
    def test_extension_cannot_call_host_tools(self):
        self.pair()
        for action in ['claim','read','reply','run_process','control-adopt','control-receive']:
            with self.assertRaises(HarnessError):self.wire(action)
    def test_wrong_origin_token_generation_and_tab_refused(self):
        p=self.pair();data=dict(action='pulse',generation=p['generation'],chat_url=URL,tab_nonce='a'*32,page=PAGE)
        with self.assertRaises(HarnessError):self.c.wire('https://evil.test',p['control_token'],data)
        for k,v in [('generation',True),('generation',99),('tab_nonce','b'*32),('chat_url',URL.replace('11111111','22222222'))]:
            with self.assertRaises(HarnessError):self.c.wire(ORIGIN,p['control_token'],{**data,k:v})
    def test_readonly_projection_contains_no_token_url_or_prompt(self):
        p=self.pair();self.request();self.pulse();v=self.p('control-status');raw=json.dumps(v)
        self.assertNotIn(p['control_token'],raw);self.assertNotIn(URL,raw);self.assertNotIn('Original scoped work',raw)
        self.assertFalse(v['model_identity_attested'])
    def test_page_safety_and_model_mismatch_prevent_dispatch(self):
        self.pair();self.request()
        for k,v in [('draft',True),('focused',True),('composing',True),('generating',True),('visible',False),('controls_known',False),('model_label','GPT-6 Pro'),('effort_label','High')]:
            self.assertEqual(self.pulse(**{k:v})['state'],'page_not_safe_or_model_mismatch')
        self.assertEqual(self.p('control-status')['attempts'],[])
    def test_user_turn_changed_before_grant_fails_closed(self):
        r,o=self.offer()
        with self.assertRaises(HarnessError):self.wire('dispatch',attempt_id=o['attempt_id'],page={**PAGE,'user_hash':'b'*64})
        self.assertEqual(self.p('read',request_id=r)['phase'],'queued')
    def test_one_concurrent_dispatch_per_original_epoch(self):
        r,o=self.offer()
        def run(_):
            try:return self.grant(o)['dispatch']
            except HarnessError:return False
        with ThreadPoolExecutor(max_workers=4) as pool:grants=list(pool.map(run,range(8)))
        self.assertEqual(sum(grants),1)
        self.assertEqual(self.p('read',request_id=r)['phase'],'queued')
    def test_unknown_dispatch_never_resends(self):
        r,o=self.offer();self.grant(o)
        self.wire('finish',attempt_id=o['attempt_id'],result='unknown')
        self.assertEqual(self.pulse()['state'],'original_attempt_requires_reconciliation')
        with self.assertRaises(HarnessError):self.grant(o)
        with self.assertRaises(HarnessError):self.p('control-adopt',request_id=r,confirm=True)
    def test_repairing_cannot_erase_dispatch(self):
        r,o=self.offer();self.grant(o);old=self.bindings['main']
        self.pair()
        p,raw=old
        with self.assertRaises(HarnessError):self.c.wire(ORIGIN,p['control_token'],dict(action='pulse',generation=p['generation'],chat_url=URL,tab_nonce=raw['tab_nonce'],page=PAGE))
        with self.assertRaises(HarnessError):self.p('control-adopt',request_id=r,confirm=True)
    def test_stop_revokes_carrier_without_faking_native_interrupt(self):
        r,o=self.offer();self.assertEqual(self.pulse(stopped=True)['state'],'disabled')
        with self.assertRaises(HarnessError):self.grant(o)
        self.assertEqual(self.p('read',request_id=r)['phase'],'queued')
    def test_cancelled_request_not_dispatched(self):
        r,o=self.offer();self.f.command(self.f.parent['id'],'host.pause')
        with self.assertRaises(HarnessError):self.grant(o)
    def test_expired_offer_does_not_get_new_attempt(self):
        r,o=self.offer();self.now+=121
        with self.assertRaises(HarnessError):self.grant(o)
        self.assertEqual(self.pulse()['attempt_id'],o['attempt_id'])
    def test_real_project_receive_reuses_claim_and_is_idempotent(self):
        r,o=self.offer();g=self.grant(o)
        self.assertIn('Original scoped work',g['prompt']);self.assertIn('浏览器载体会自动确认领取',g['prompt'])
        self.assertIn(WORK_PACKAGE_GUIDANCE,g['prompt'])
        first=self.p('control-receive',attempt_id=o['attempt_id']);second=self.p('control-receive',attempt_id=o['attempt_id'])
        self.assertEqual(first['request_id'],r);self.assertEqual(first['original_claim_id'],second['original_claim_id'])
        self.assertTrue(second['already_received']);self.assertEqual(first['text'],'Original scoped work')
        self.assertEqual(self.wire('finish',attempt_id=o['attempt_id'],result='sent')['state'],'acknowledged')
    def test_browser_send_claims_original_and_public_result_completes_without_receiver_cli(self):
        r,o=self.offer();g=self.grant(o);self.assertIn('Original scoped work',g['prompt'])
        sent=self.sent(o);self.assertEqual(sent['state'],'browser_result_pending')
        current=self.p('read',request_id=r);self.assertEqual(current['phase'],'processing')
        with closing(self.f.s.state.connect()) as db:
            claim=db.execute('SELECT claim_id FROM host_requests WHERE id=?',(r,)).fetchone()['claim_id']
            self.assertTrue(claim.startswith('clw-browser-claim-'))
        out=self.browser_result(o,text='Full public browser result')
        self.assertEqual(out['state'],'completed');self.assertFalse(out['replayed'])
        self.assertEqual(self.p('read',request_id=r)['phase'],'completed')
        with closing(self.f.s.state.connect()) as db:
            event=db.execute("SELECT data FROM events WHERE kind='assistant_message' AND json_extract(data,'$.request_id')=? ORDER BY seq DESC LIMIT 1",(r,)).fetchone()
            self.assertEqual(json.loads(event['data'])['text'],'Full public browser result')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_browser_receipts WHERE attempt_id=?',(o['attempt_id'],)).fetchone()[0],1)

    def test_browser_result_is_idempotent_and_conflicting_replay_is_rejected(self):
        r,o=self.offer();self.grant(o);self.sent(o)
        one=self.browser_result(o,text='Stable public result');two=self.browser_result(o,text='Stable public result')
        self.assertFalse(one['replayed']);self.assertTrue(two['replayed'])
        with self.assertRaises(HarnessError):self.browser_result(o,text='Different replay')
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='assistant_message' AND json_extract(data,'$.request_id')=?",(r,)).fetchone()[0],1)

    def test_browser_result_must_be_new_assistant_turn_for_same_sent_user(self):
        r,o=self.offer();self.grant(o);self.sent(o,user='b',assistant_before='d')
        with self.assertRaises(HarnessError):self.browser_result(o,user='c',turn='e')
        with self.assertRaises(HarnessError):self.browser_result(o,user='b',turn='d')
        self.assertEqual(self.p('read',request_id=r)['phase'],'processing')

    def test_browser_public_result_explicit_failure_reenters_same_bounded_recovery(self):
        r,o=self.offer();self.grant(o);self.sent(o)
        failed={**PAGE,'user_hash':'b'*64,'failure_kind':'generation_failed','failure_hash':'e'*64}
        transition=self.wire('pulse',page=failed)
        self.assertEqual(transition['state'],'browser_result_failed_recovery_pending')
        self.assertEqual(self.p('read',request_id=r)['phase'],'processing')
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_browser_receipts WHERE attempt_id=?',(o['attempt_id'],)).fetchone()[0],0)
            rec=db.execute('SELECT ordinal,due FROM control_recoveries WHERE request_id=?',(r,)).fetchone()
            self.assertEqual(rec['ordinal'],1);due=rec['due']
        self.now=due
        recovery=self.wire('pulse',page=failed)
        self.assertEqual(recovery['state'],'offer');self.assertTrue(recovery['recovery'])
        self.assertEqual(recovery['request_id'],r)
        self.assertNotEqual(recovery['attempt_id'],o['attempt_id'])
        recovery_prompt=self.wire('dispatch',attempt_id=recovery['attempt_id'],page=failed)['prompt']
        self.assertEqual(recovery_prompt,continuation_prompt())
        self.assertNotIn('Original scoped work',recovery_prompt)
        self.assertNotIn('Workflow Session',recovery_prompt)
        self.assertNotIn(WORK_PACKAGE_GUIDANCE,recovery_prompt)

    def test_foreign_visible_failure_cannot_retire_accepted_browser_send(self):
        r,o=self.offer();self.grant(o);self.sent(o,user='b')
        wrong_turn={**PAGE,'user_hash':'c'*64,'failure_kind':'generation_failed','failure_hash':'e'*64}
        pending=self.wire('pulse',page=wrong_turn)
        self.assertEqual(pending['state'],'browser_result_pending')
        self.assertEqual(pending['attempt_id'],o['attempt_id'])
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_browser_receipts WHERE attempt_id=?',(o['attempt_id'],)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_recoveries WHERE request_id=?',(r,)).fetchone()[0],0)
        own_turn=self.wire('pulse',page={**wrong_turn,'user_hash':'b'*64})
        self.assertEqual(own_turn['state'],'browser_result_failed_recovery_pending')
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_browser_receipts WHERE attempt_id=?',(o['attempt_id'],)).fetchone()[0],0)

    def test_generation_failed_short_continue_completes_same_claim_binding_and_model(self):
        request,original,recovery,failed=self.failure_offer()
        with closing(self.f.s.state.connect()) as db:
            binding=dict(db.execute('SELECT * FROM host_bindings WHERE thread_id=?',(self.f.parent['id'],)).fetchone())
            claim=db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0]
        grant=self.wire('dispatch',attempt_id=recovery['attempt_id'],page=failed)
        self.assertEqual(grant['prompt'],continuation_prompt())
        self.assertTrue(grant['prompt'].startswith(CONTINUATION_SENTENCE))
        self.assertEqual(recovery['model_label'],original['model_label'])
        self.assertEqual(recovery['effort_label'],original['effort_label'])
        self.sent(recovery,user='c',assistant_before='d')
        result=self.browser_result(recovery,user='c',turn='f',text='Complete remaining work and hand off the previously saved result.')
        self.assertEqual(result['state'],'completed')
        with closing(self.f.s.state.connect()) as db:
            current=db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual(current[:],('completed',claim))
            self.assertEqual(dict(db.execute('SELECT * FROM host_bindings WHERE thread_id=?',(self.f.parent['id'],)).fetchone()),binding)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests WHERE thread_id=?',(self.f.parent['id'],)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT request_id FROM control_attempts WHERE id=?',(recovery['attempt_id'],)).fetchone()[0],request)

    def test_failure_short_prompt_delivers_new_notes_without_repeating_old_package(self):
        self.pair();request=self.request()
        self.f.command(self.f.parent['id'],'message.append',{'text':'Previously delivered requirement','expected_request_id':request})
        original=self.pulse();self.grant(original);self.sent(original)
        failed={**PAGE,'user_hash':'b'*64,'failure_kind':'generation_failed','failure_hash':'e'*64}
        self.wire('pulse',page=failed)
        self.f.command(self.f.parent['id'],'message.append',{'text':'New requirement arriving after the interruption','expected_request_id':request})
        self.now+=15;recovery=self.wire('pulse',page=failed)
        grant=self.wire('dispatch',attempt_id=recovery['attempt_id'],page=failed)
        self.assertIn('New requirement arriving after the interruption',grant['prompt'])
        self.assertNotIn('Previously delivered requirement',grant['prompt'])
        self.assertNotIn('Original scoped work',grant['prompt'])
        self.sent(recovery,user='c')
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_unread_notes WHERE request_id=?',(request,)).fetchone()[0],0)

    def test_failure_short_send_unknown_stays_in_reconciliation_without_resend(self):
        request,original,recovery,failed=self.failure_offer()
        self.wire('dispatch',attempt_id=recovery['attempt_id'],page=failed)
        self.wire('finish',attempt_id=recovery['attempt_id'],result='unknown')
        self.assertNotEqual(self.wire('pulse',page=failed)['state'],'offer')
        with self.assertRaises(HarnessError):self.wire('dispatch',attempt_id=recovery['attempt_id'],page=failed)
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],2)
            self.assertEqual(db.execute('SELECT state FROM control_attempts WHERE id=?',(recovery['attempt_id'],)).fetchone()[0],'unknown')

    def test_user_pause_after_failure_offer_prevents_short_continue(self):
        request,original,recovery,failed=self.failure_offer()
        self.f.command(self.f.parent['id'],'host.pause')
        with self.assertRaises(HarnessError):self.wire('dispatch',attempt_id=recovery['attempt_id'],page=failed)
        with closing(self.f.s.state.connect()) as db:
            self.assertIsNone(db.execute('SELECT dispatched FROM control_attempts WHERE id=?',(recovery['attempt_id'],)).fetchone()[0])

    def test_generation_failure_survives_service_restart_without_new_request(self):
        r,o=self.offer();self.grant(o);self.sent(o,user='b')
        failed={**PAGE,'user_hash':'b'*64,'failure_kind':'generation_failed','failure_hash':'e'*64}
        self.assertEqual(self.wire('pulse',page=failed)['state'],'browser_result_failed_recovery_pending')
        with closing(self.f.s.state.connect()) as db:
            due=db.execute('SELECT due FROM control_recoveries WHERE request_id=?',(r,)).fetchone()['due']
        self.f.s.close()
        self.f.s=fixtures.HarnessService(self.f.root,self.f.root/'state',connection_factory=fixtures.FakeConnection,
                                         web_targets=copy.deepcopy(fixtures.CONFIG),web_bridge=self.f.bridge)
        self.h=self.f.s.host_bridge;self.h.clock=lambda:self.now;self.c=self.h.control
        self.now=due
        recovery=self.wire('pulse',page=failed)
        self.assertEqual(recovery['state'],'offer')
        self.assertEqual(recovery['request_id'],r)
        self.assertTrue(recovery['recovery'])
        self.wire('dispatch',attempt_id=recovery['attempt_id'],page=failed)
        self.sent(recovery,user='c')
        final=self.browser_result(recovery,text='Recovered original request',user='c')
        self.assertEqual(final['state'],'completed')
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests WHERE id=?',(r,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(r,)).fetchone()[0],2)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_replies WHERE request_id=?',(r,)).fetchone()[0],1)

    def test_browser_result_before_confirmed_send_is_rejected(self):
        r,o=self.offer();self.grant(o)
        with self.assertRaises(HarnessError):self.browser_result(o)
        self.assertEqual(self.p('read',request_id=r)['phase'],'queued')

    def test_pulse_recovers_pending_browser_result_after_extension_restart(self):
        r,o=self.offer();self.grant(o);sent=self.sent(o)
        pending=self.pulse(user_hash='b'*64)
        self.assertEqual(pending['state'],'browser_result_pending')
        self.assertEqual(pending['attempt_id'],o['attempt_id'])
        self.assertEqual(pending['sent_user_hash'],'b'*64)

    def test_service_restart_preserves_accepted_send_and_completes_original_request(self):
        r,o=self.offer();self.grant(o);self.sent(o)
        self.f.s.close()
        self.f.s=fixtures.HarnessService(self.f.root,self.f.root/'state',connection_factory=fixtures.FakeConnection,
                                         web_targets=copy.deepcopy(fixtures.CONFIG),web_bridge=self.f.bridge)
        self.h=self.f.s.host_bridge;self.h.clock=lambda:self.now;self.c=self.h.control
        pending=self.pulse(user_hash='b'*64)
        self.assertEqual(pending['state'],'browser_result_pending')
        self.assertEqual(pending['attempt_id'],o['attempt_id'])
        with self.assertRaises(HarnessError):self.grant(o)
        result=self.browser_result(o,text='Result collected after host restart')
        self.assertEqual(result['state'],'completed')
        self.assertEqual(self.p('read',request_id=r)['phase'],'completed')
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(r,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_browser_receipts WHERE request_id=? AND result_hash IS NOT NULL',(r,)).fetchone()[0],1)

    def test_browser_prompt_includes_notes_and_send_acknowledges_them(self):
        r=self.request();self.f.command(self.f.parent['id'],'message.append',
            {'text':'Preserve the exact additional requirement','expected_request_id':r})
        self.pair();self.p('control-adopt',confirm=True,request_id=r);o=self.pulse();g=self.grant(o)
        self.assertIn('Preserve the exact additional requirement',g['prompt'])
        with closing(self.f.s.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_unread_notes WHERE request_id=?',(r,)).fetchone()[0],1)
        self.sent(o)
        with closing(self.f.s.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_unread_notes WHERE request_id=?',(r,)).fetchone()[0],0)

    def test_note_arriving_after_dispatch_is_not_falsely_acknowledged_by_browser_send(self):
        r,o=self.offer();self.grant(o)
        self.f.command(self.f.parent['id'],'message.append',
            {'text':'Late requirement after dispatch','expected_request_id':r})
        self.sent(o)
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_unread_notes WHERE request_id=?',(r,)).fetchone()[0],1)
        with self.assertRaises(HarnessError):self.browser_result(o,text='Result that did not see the late requirement')
        self.assertEqual(self.p('read',request_id=r)['phase'],'processing')

    def test_receive_requires_dispatch_not_only_offer(self):
        r,o=self.offer()
        with self.assertRaises(HarnessError):self.p('control-receive',attempt_id=o['attempt_id'])
    def test_parent_resume_epoch_reuses_original_parent_claim(self):
        self.f.join();r=self.f.start();original_claim=self.f.claim
        self.pair();d=self.f.delegate(r);self.f.yield_parent(r)
        self.assertNotEqual(self.pulse()['state'],'offer')
        c=fixtures.uid();self.f.p('child-a','claim',request_id=d['child_request_id'],claim_id=c)
        self.f.finish('child-a',d['child_request_id'],c)
        o=self.pulse();self.assertEqual(o['request_id'],r);self.grant(o)
        received=self.p('control-receive',attempt_id=o['attempt_id'])
        self.assertEqual(received['original_claim_id'],original_claim);self.assertTrue(received['already_claimed'])
    def test_legacy_poller_is_excluded_when_control_active(self):
        self.pair()
        with self.assertRaises(HarnessError):self.f.poll('main')
        self.p('control-disable',confirm=True)
        self.assertFalse(self.f.poll('main')['available'])
    def test_legacy_recovery_cannot_pair_while_control_enabled(self):
        self.pair();code=self.h.recovery.pairing_code(self.f.parent['id'])['pair_code']
        with self.assertRaises(HarnessError):self.h.recovery.pair(ORIGIN,dict(action='pair',code=code,chat_url=URL))
    def test_restart_retains_unknown_and_original_identity(self):
        r,o=self.offer();self.grant(o);self.f.s.close()
        self.f.s=fixtures.HarnessService(self.f.root,self.f.root/'state',connection_factory=fixtures.FakeConnection,web_targets=copy.deepcopy(fixtures.CONFIG),web_bridge=self.f.bridge)
        self.h=self.f.s.host_bridge;self.h.clock=lambda:self.now;self.c=self.h.control
        self.assertEqual(self.pulse()['attempt_state'],'dispatching')
        with self.assertRaises(HarnessError):self.grant(o)
        self.assertEqual(self.p('read',request_id=r)['phase'],'queued')

    def test_explicit_failure_recovers_original_claim_with_backoff(self):
        r,o=self.offer();self.grant(o);first=self.p('control-receive',attempt_id=o['attempt_id'])
        self.assertNotEqual(self.pulse(failure_hash='b'*64,failure_kind='cannot_think')['state'],'offer')
        self.now+=15
        failed={**PAGE,'failure_hash':'b'*64,'failure_kind':'cannot_think'}
        recovery=self.pulse(**failed);self.assertEqual(recovery['state'],'offer')
        self.wire('dispatch',attempt_id=recovery['attempt_id'],page=failed)
        resumed=self.p('control-receive',attempt_id=recovery['attempt_id'])
        self.assertEqual(first['original_claim_id'],resumed['original_claim_id']);self.assertTrue(resumed['already_claimed'])
        self.assertNotEqual(self.pulse(**failed)['state'],'offer')
    def test_silence_never_plans_failure_recovery(self):
        r,o=self.offer();self.grant(o);self.p('control-receive',attempt_id=o['attempt_id']);self.now+=2000
        self.assertNotEqual(self.pulse()['state'],'offer')
        with closing(self.f.s.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM control_recoveries').fetchone()[0],0)
    def test_existing_terminal_error_at_first_processing_observation_ignored(self):
        self.pair();r=self.request();self.p('claim',request_id=r,claim_id=self.f.claim)
        self.pulse(failure_kind='cannot_think',failure_hash='b'*64);self.now+=100
        self.assertNotEqual(self.pulse(failure_kind='cannot_think',failure_hash='b'*64)['state'],'offer')
    def test_generation_failure_budget_is_at_most_three(self):
        r,o=self.offer();self.grant(o);self.p('control-receive',attempt_id=o['attempt_id'])
        for delay in (15,45,120):
            page={**PAGE,'failure_hash':'b'*64,'failure_kind':'generation_failed'}
            self.pulse(**page);self.now+=delay;offer=self.pulse(**page)
            self.assertEqual(offer['state'],'offer')
            self.wire('dispatch',attempt_id=offer['attempt_id'],page=page);self.p('control-receive',attempt_id=offer['attempt_id'])
        self.assertNotEqual(self.pulse(failure_hash='b'*64,failure_kind='generation_failed')['state'],'offer')
        with closing(self.f.s.state.connect()) as db:
            recoveries=db.execute('SELECT failure_hash,ordinal FROM control_recoveries WHERE request_id=? ORDER BY ordinal',(r,)).fetchall()
            self.assertEqual(len(recoveries),3)
            self.assertEqual([x['ordinal'] for x in recoveries],[1,2,3])
            self.assertEqual(len({x['failure_hash'] for x in recoveries}),3)
    def test_legacy_failure_key_resumes_once_but_does_not_mask_next_failure(self):
        r,o=self.offer();self.grant(o);self.p('control-receive',attempt_id=o['attempt_id'])
        failed={**PAGE,'failure_hash':'b'*64,'failure_kind':'generation_failed'}
        self.pulse(**failed)
        with closing(self.f.s.state.connect()) as db:
            db.execute('UPDATE control_recoveries SET failure_hash=? WHERE request_id=?',('b'*64,r))
            db.commit()
        self.now+=15
        recovery=self.pulse(**failed)
        self.assertEqual(recovery['state'],'offer')
        self.wire('dispatch',attempt_id=recovery['attempt_id'],page=failed)
        self.p('control-receive',attempt_id=recovery['attempt_id'])
        self.assertNotEqual(self.pulse(**failed)['state'],'offer')
        with closing(self.f.s.state.connect()) as db:
            rows=db.execute('SELECT failure_hash,ordinal FROM control_recoveries WHERE request_id=? ORDER BY ordinal',(r,)).fetchall()
            self.assertEqual([(x['ordinal']) for x in rows],[1,2])
            self.assertEqual(rows[0]['failure_hash'],'b'*64)
            self.assertNotEqual(rows[1]['failure_hash'],rows[0]['failure_hash'])
    def test_lost_receive_cannot_be_repaired_by_another_error_send(self):
        r,o=self.offer();self.grant(o);self.p('claim',request_id=r,claim_id=self.f.claim)
        self.pulse(failure_hash='b'*64,failure_kind='cannot_think');self.now+=15
        self.assertNotEqual(self.pulse(failure_hash='b'*64,failure_kind='cannot_think')['state'],'offer')

    def test_control_projection_does_not_misreport_a_released_legacy_wait(self):
        from harness_handoff import request_handoff
        r=self.request();self.pair()
        with closing(self.f.s.state.connect()) as db:
            b=self.h.binding(db,target='main');req=self.c.original(db,b,r)
            view=request_handoff(db,b,req,self.now)
        self.assertEqual(view['state'],'control_explicit_adoption_required')
        self.p('control-adopt',confirm=True,request_id=r);o=self.pulse();self.grant(o)
        with closing(self.f.s.state.connect()) as db:
            view=request_handoff(db,self.h.binding(db,target='main'),self.c.original(db,self.h.binding(db,target='main'),r),self.now+50)
        self.assertEqual(view['state'],'control_dispatching');self.assertTrue(view['attention_required'])
    def test_two_control_children_cannot_both_send_before_either_claims(self):
        self.f.join();self.f.join('child-b');self.pair('child-a',URL.replace('11111111','33333333'));self.pair('child-b',URL.replace('11111111','44444444'))
        r=self.f.start();self.f.delegate(r,'child-a');self.f.delegate(r,'child-b');self.f.yield_parent(r)
        a=self.pulse('child-a');b=self.pulse('child-b');self.grant(a,'child-a')
        denied=self.grant(b,'child-b');self.assertFalse(denied['dispatch'])
        self.assertEqual(denied['state'],'workspace_waiting_other_control_receipt')
    def test_recovery_user_or_epoch_change_is_not_retried(self):
        r,o=self.offer();self.grant(o);self.p('control-receive',attempt_id=o['attempt_id'])
        self.pulse(failure_hash='b'*64,failure_kind='cannot_think');self.now+=15
        self.assertNotEqual(self.pulse(failure_hash='b'*64,failure_kind='cannot_think',user_hash='c'*64)['state'],'offer')
    def test_disable_receiving_control_never_reactivates_legacy_recovery(self):
        self.pair();self.p('control-disable',confirm=True)
        snapshot=self.h.recovery.snapshot(self.f.parent['id'])
        self.assertFalse(snapshot['paired'])

    def test_repairing_does_not_adopt_an_older_processing_failure(self):
        r,o=self.offer();self.grant(o);self.p('control-receive',attempt_id=o['attempt_id']);self.pair()
        self.pulse(failure_hash='b'*64,failure_kind='cannot_think');self.now+=15
        self.assertNotEqual(self.pulse(failure_hash='b'*64,failure_kind='cannot_think')['state'],'offer')
        with closing(self.f.s.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM control_recoveries').fetchone()[0],0)

    def test_live_document_renews_lease_but_expired_or_revoked_token_cannot(self):
        self.pair();self.now+=3500;self.pulse(generating=True)
        self.now+=3500;self.pulse(generating=True)
        self.assertTrue(self.p('control-status')['paired'])
        self.now+=3601
        with self.assertRaises(HarnessError):self.pulse()
        self.assertFalse(self.p('control-status')['paired'])


    def trust_companion_origin(self):
        code=self.h.recovery.pairing_code(self.f.parent['id'])['pair_code']
        return self.h.recovery.wire(ORIGIN,None,dict(action='pair',code=code,chat_url=URL))

    def test_unified_bootstrap_unique_new_page_can_be_one_click_adopted(self):
        self.trust_companion_origin()
        self.f.join();parent=self.f.start();delegated=self.f.delegate(parent);self.f.yield_parent(parent)
        child_url=URL.replace('11111111','77777777');nonce='b'*32
        boot=self.c.wire(ORIGIN,None,dict(action='bootstrap',chat_url=child_url,tab_nonce=nonce,page=PAGE,confirm_low_cost=True,enrollment=receiver_marker(self.f)))
        self.assertEqual(boot['state'],'one_confirmed_receiver');self.assertTrue(boot['auto_bind_safe']);self.assertFalse(boot['internal_target_required'])
        self.assertEqual(len(boot['candidates']),1);candidate=boot['candidates'][0];self.assertFalse(candidate['previously_bound'])
        self.assertEqual(candidate['title'],'独立分支 child-a')
        self.assertNotIn('target',json.dumps(candidate));self.assertNotIn(delegated['child_request_id'],json.dumps(candidate))
        bound=self.c.wire(ORIGIN,None,dict(action='bind',discovery_id=candidate['discovery_id'],confirm=True,confirm_low_cost=True,
            chat_url=child_url,tab_nonce=nonce,page=PAGE))
        self.assertEqual(bound['adopted_request_id'],delegated['child_request_id'])
        self.assertFalse(bound['internal_target_required']);self.assertFalse(bound['pair_code_required'])
        pulse=self.c.wire(ORIGIN,bound['control_token'],dict(action='pulse',generation=bound['generation'],
            chat_url=child_url,tab_nonce=nonce,page=PAGE))
        self.assertEqual(pulse['request_id'],delegated['child_request_id'])
        self.assertEqual(self.f.p('child-a','read',request_id=delegated['child_request_id'])['phase'],'queued')


    def test_explicit_popup_authorizes_unique_enrolled_receiver_page_without_receipt(self):
        self.trust_companion_origin()
        self.f.join();parent=self.f.start();delegated=self.f.delegate(parent);self.f.yield_parent(parent)
        receiver_marker(self.f)
        child_url=URL.replace('11111111','67676767');nonce='f'*32
        boot=self.c.wire(ORIGIN,None,dict(action='bootstrap',chat_url=child_url,tab_nonce=nonce,
            page=PAGE,confirm_low_cost=True,confirm_page_binding=True))
        self.assertEqual(len(boot['candidates']),1);candidate=boot['candidates'][0]
        bound=self.c.wire(ORIGIN,None,dict(action='bind',discovery_id=candidate['discovery_id'],
            confirm=True,confirm_low_cost=True,chat_url=child_url,tab_nonce=nonce,page=PAGE))
        self.assertEqual(bound['adopted_request_id'],delegated['child_request_id'])
        self.assertEqual(self.f.p('child-a','read',request_id=delegated['child_request_id'])['phase'],'queued')
        with closing(self.f.s.state.connect()) as db:
            child_thread=db.execute("SELECT thread_id FROM host_bindings WHERE target_id='child-a'").fetchone()['thread_id']
            link=db.execute('SELECT state,chat_url FROM host_carrier_links WHERE thread_id=?',(child_thread,)).fetchone()
            self.assertEqual(link['state'],'browser_bound');self.assertEqual(link['chat_url'],child_url)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_page_authorizations').fetchone()[0],0)
            event=db.execute("SELECT data FROM events WHERE thread_id=? AND kind='control_paired' ORDER BY seq DESC LIMIT 1",
                             (child_thread,)).fetchone()
            self.assertEqual(json.loads(event['data'])['source'],'explicit_page_authorization')

    def test_background_discovery_cannot_use_explicit_page_authorization_path(self):
        self.trust_companion_origin()
        self.f.join();parent=self.f.start();delegated=self.f.delegate(parent);self.f.yield_parent(parent)
        receiver_marker(self.f)
        child_url=URL.replace('11111111','68686868');nonce='b'*32
        boot=self.c.wire(ORIGIN,None,dict(action='bootstrap',chat_url=child_url,tab_nonce=nonce,
            page=PAGE,confirm_low_cost=True))
        self.assertEqual(len(boot['candidates']),1)
        with self.assertRaises(HarnessError) as error:
            self.c.wire(ORIGIN,None,dict(action='bind',discovery_id=boot['candidates'][0]['discovery_id'],
                confirm=True,confirm_low_cost=True,chat_url=child_url,tab_nonce=nonce,page=PAGE))
        self.assertEqual(error.exception.code,'team_browser_receipt_required')
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_page_authorizations').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_peers WHERE thread_id=?',
                (db.execute("SELECT thread_id FROM host_bindings WHERE target_id='child-a'").fetchone()['thread_id'],)).fetchone()[0],0)
        self.assertEqual(self.f.p('child-a','read',request_id=delegated['child_request_id'])['phase'],'queued')

    def test_explicit_page_authorization_cannot_steal_claimed_child(self):
        self.trust_companion_origin()
        self.f.join();parent=self.f.start();delegated=self.f.delegate(parent);self.f.yield_parent(parent)
        receiver_marker(self.f)
        self.f.p('child-a','claim',request_id=delegated['child_request_id'],claim_id=fixtures.uid())
        with self.assertRaises(HarnessError):
            self.c.wire(ORIGIN,None,dict(action='bootstrap',chat_url=URL.replace('11111111','69696969'),
                tab_nonce='c'*32,page=PAGE,confirm_low_cost=True,confirm_page_binding=True))
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_page_authorizations').fetchone()[0],0)

    def test_known_idle_main_page_never_steals_pending_independent_child(self):
        # Current URL is already known as the main page, but only the independent
        # child has runnable work. The page must be told to switch, not rebound.
        self.trust_companion_origin()
        self.f.join();parent=self.f.start();delegated=self.f.delegate(parent);self.f.yield_parent(parent)
        boot=self.c.wire(ORIGIN,None,dict(action='bootstrap',chat_url=URL,tab_nonce='e'*32,
            page=PAGE,confirm_low_cost=True))
        self.assertEqual(boot['state'],'wrong_registered_page')
        self.assertTrue(boot['switch_required'])
        self.assertIn('独立分支 child-a',boot['pending_titles'])
        self.assertNotIn('candidates',boot)
        raw=json.dumps(boot,ensure_ascii=False)
        self.assertNotIn('target_id',raw);self.assertNotIn(delegated['child_request_id'],raw)
        with closing(self.f.s.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_peers WHERE thread_id=?',
                (self.f.parent['id'],)).fetchone()[0],0)

    def test_unified_bootstrap_exact_prior_page_can_auto_bind_without_title_choice(self):
        child=self.f.join();parent=self.f.start();delegated=self.f.delegate(parent);self.f.yield_parent(parent)
        child_url=URL.replace('11111111','88888888')
        code=self.h.recovery.pairing_code(child['id'])['pair_code']
        self.h.recovery.wire(ORIGIN,None,dict(action='pair',code=code,chat_url=child_url))
        boot=self.c.wire(ORIGIN,None,dict(action='bootstrap',chat_url=child_url,tab_nonce='c'*32,page=PAGE,confirm_low_cost=True))
        self.assertEqual(boot['state'],'one_previously_bound');self.assertTrue(boot['auto_bind_safe'])
        self.assertEqual(len(boot['candidates']),1);self.assertTrue(boot['candidates'][0]['previously_bound'])
        bound=self.c.wire(ORIGIN,None,dict(action='bind',discovery_id=boot['candidates'][0]['discovery_id'],confirm=True,confirm_low_cost=True,
            chat_url=child_url,tab_nonce='c'*32,page=PAGE))
        self.assertEqual(bound['adopted_request_id'],delegated['child_request_id'])

    def test_unified_bootstrap_requires_previously_trusted_companion_origin(self):
        self.f.join();parent=self.f.start();self.f.delegate(parent);self.f.yield_parent(parent)
        with self.assertRaises(HarnessError):
            self.c.wire(ORIGIN,None,dict(action='bootstrap',chat_url=URL.replace('11111111','77777777'),
                tab_nonce='b'*32,page=PAGE,confirm_low_cost=True))

    def test_unified_bootstrap_requires_visible_known_unblocked_page(self):
        self.trust_companion_origin();self.f.join();parent=self.f.start();self.f.delegate(parent);self.f.yield_parent(parent)
        url=URL.replace('11111111','77777777')
        for patch in ({'controls_known':False},{'visible':False},{'blocked':True},{'stopped':True}):
            with self.assertRaises(HarnessError):
                self.c.wire(ORIGIN,None,dict(action='bootstrap',chat_url=url,tab_nonce='b'*32,page={**PAGE,**patch},confirm_low_cost=True))

    def test_current_radix_ui_can_use_explicit_one_click_low_cost_confirmation(self):
        self.trust_companion_origin();self.f.join();parent=self.f.start();delegated=self.f.delegate(parent);self.f.yield_parent(parent)
        page={**PAGE,'model_label':'','effort_label':'','model_pro_visible':False,'effort_disallowed_visible':False}
        url=URL.replace('11111111','99999999');nonce='d'*32
        boot=self.c.wire(ORIGIN,None,dict(action='bootstrap',chat_url=url,tab_nonce=nonce,page=page,confirm_low_cost=True,enrollment=receiver_marker(self.f)))
        self.assertEqual(len(boot['candidates']),1)
        bound=self.c.wire(ORIGIN,None,dict(action='bind',discovery_id=boot['candidates'][0]['discovery_id'],confirm=True,
            confirm_low_cost=True,chat_url=url,tab_nonce=nonce,page=page))
        self.assertEqual(bound['adopted_request_id'],delegated['child_request_id'])
        self.assertEqual(bound['model_label'],'@confirmed-sol-nonpro')
        self.assertEqual(bound['effort_label'],'@confirmed-medium-or-extra-high')
        self.bindings['child-a']=(bound,dict(chat_url=url,tab_nonce=nonce))
        pulse=self.pulse('child-a',model_label='',effort_label='')
        self.assertEqual(pulse['request_id'],delegated['child_request_id'])

    def test_current_radix_ui_visible_pro_or_disallowed_effort_still_fails_closed(self):
        self.trust_companion_origin();self.f.join();parent=self.f.start();self.f.delegate(parent);self.f.yield_parent(parent)
        url=URL.replace('11111111','99999999')
        for patch in ({'model_label':'','effort_label':'','model_pro_visible':True},
                      {'model_label':'GPT-5.6 Sol','effort_label':'High','effort_disallowed_visible':True}):
            with self.assertRaises(HarnessError):
                self.c.wire(ORIGIN,None,dict(action='bootstrap',chat_url=url,tab_nonce='d'*32,
                    page={**PAGE,**patch},confirm_low_cost=True))

    def test_unified_bootstrap_multiple_candidates_returns_titles_not_internal_targets(self):
        self.trust_companion_origin();self.f.join();self.f.join('child-b')
        parent=self.f.start();self.f.delegate(parent);self.f.delegate(parent,'child-b');self.f.yield_parent(parent)
        boot=self.c.wire(ORIGIN,None,dict(action='bootstrap',chat_url=URL.replace('11111111','77777777'),
            tab_nonce='b'*32,page=PAGE,confirm_low_cost=True))
        self.assertEqual(boot['state'],'enrollment_required');self.assertEqual(len(boot['titles']),2);self.assertNotIn('candidates',boot)
        raw=json.dumps(boot,ensure_ascii=False)
        self.assertIn('独立分支 child-a',raw);self.assertIn('独立分支 child-b',raw)
        self.assertNotIn('target_id',raw);self.assertNotIn('session_id',raw);self.assertNotIn('request_id',raw)
class SelectedWaitRecoveryTests(unittest.TestCase):
    def setUp(self):
        import test_harness_team
        self.b=test_harness_team.TeamTests();self.b.setUp();self.h=self.b.h

    def tearDown(self):self.b.tearDown()

    def resumed_controller(self,*,selected_complete=True,mode='selected'):
        for target in ('child-a','child-b'):
            self.b.f.join(target);self.b.enroll(target);self.b.workspace(target,read_only=True)
        request,run=self.b.start_run(read_only=True,seconds=1000,max_dispatches=16)
        old=self.b.assign(run);chosen=self.b.assign(run,'child-b')
        wait={'run_id':run['run_id'],'claim_id':self.b.f.claim,'after_seq':0,'mode':mode}
        if mode=='selected':wait['selected_requests']=[chosen['request_id']]
        self.b.call('wait',wait)
        _,old_claim=self.b.send_receive('child-a')
        # Model an already-held original branch in this temporary fixture only.
        # The recovery operation must leave its identity and suspended state intact.
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE host_requests SET phase='suspended' WHERE id=?",(old['request_id'],))
            db.commit()
        if selected_complete:
            _,got=self.b.send_receive('child-b');self.b.final('child-b',got)
        if not selected_complete or mode!='selected':
            self.b.f.command(self.b.f.parent['id'],'message.append',
                             {'expected_request_id':request,'text':'Review the original run without retiring the held branch.'})
        offer=self.b.wire('main','pulse',page=PAGE)
        self.assertEqual(offer['state'],'offer',offer)
        self.assertTrue(self.b.wire('main','dispatch',attempt_id=offer['attempt_id'],page=PAGE)['dispatch'])
        self.b.wire('main','sent',attempt_id=offer['attempt_id'],
                    page={**PAGE,'user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[:],
                             ('processing',self.b.f.claim))
            self.old_before=dict(db.execute('SELECT * FROM host_requests WHERE id=?',(old['request_id'],)).fetchone())
        self.assertEqual(self.old_before['claim_id'],old_claim['original_claim_id'])
        return request,run,old,chosen,offer

    def fail(self):
        self.failed={**PAGE,'user_hash':'b'*64,'failure_kind':'generation_failed','failure_hash':'e'*64}
        return self.b.wire('main','pulse',page=self.failed)

    def assert_old_preserved(self,old):
        with closing(self.h.state.connect()) as db:
            self.assertEqual(dict(db.execute('SELECT * FROM host_requests WHERE id=?',(old['request_id'],)).fetchone()),
                             self.old_before)

    def test_completed_selection_recovers_same_controller_without_replaying_held_branch(self):
        request,run,old,chosen,offer=self.resumed_controller()
        self.assertEqual(self.fail()['state'],'browser_result_failed_recovery_pending')
        with closing(self.h.state.connect()) as db:
            rec=db.execute('SELECT ordinal,due,base_epoch FROM control_recoveries WHERE request_id=?',(request,)).fetchone()
            self.assertEqual(rec['ordinal'],1);due=rec['due']
            self.assertEqual(db.execute('SELECT epoch FROM control_attempts WHERE id=?',(offer['attempt_id'],)).fetchone()[0],
                             rec['base_epoch'])
            self.assertFalse(db.execute('SELECT 1 FROM control_browser_receipts WHERE attempt_id=?',(offer['attempt_id'],)).fetchone())
            self.assertEqual(self.h.collaboration.outstanding(db,request),1)
        self.assertNotEqual(self.b.wire('main','pulse',page=self.failed)['state'],'offer')
        self.b.now=due
        recovery=self.b.wire('main','pulse',page=self.failed)
        self.assertEqual(recovery['state'],'offer');self.assertTrue(recovery['recovery'])
        self.assertEqual(recovery['request_id'],request)
        self.assertNotEqual(recovery['attempt_id'],offer['attempt_id'])
        self.assertEqual(self.b.wire('main','pulse',page=self.failed)['attempt_id'],recovery['attempt_id'])
        grant=self.b.wire('main','dispatch',attempt_id=recovery['attempt_id'],page=self.failed)
        self.assertTrue(grant['dispatch']);self.assertEqual(grant['prompt'],continuation_prompt())
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests WHERE id=?',(request,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0],self.b.f.claim)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_recoveries WHERE request_id=?',(request,)).fetchone()[0],1)
        self.assert_old_preserved(old)

    def test_pending_selected_request_blocks_failure_recovery_even_after_user_note_resume(self):
        request,run,old,chosen,offer=self.resumed_controller(selected_complete=False)
        self.assertEqual(self.fail()['state'],'browser_result_failed_recovery_pending')
        self.b.now+=15
        self.assertNotEqual(self.b.wire('main','pulse',page=self.failed)['state'],'offer')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_recoveries WHERE request_id=?',(request,)).fetchone()[0],0)
        self.assert_old_preserved(old)

    def test_default_all_wait_keeps_unselected_outstanding_barrier(self):
        request,run,old,chosen,offer=self.resumed_controller(mode='all')
        self.assertEqual(self.fail()['state'],'browser_result_failed_recovery_pending')
        self.b.now+=15
        self.assertNotEqual(self.b.wire('main','pulse',page=self.failed)['state'],'offer')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_recoveries WHERE request_id=?',(request,)).fetchone()[0],0)
        self.assert_old_preserved(old)

    def test_missing_or_illegal_saved_selection_cannot_release_failure_recovery(self):
        request,run,old,chosen,offer=self.resumed_controller()
        for raw in (None,'[]','["foreign-request"]','{}','{',json.dumps([chosen['request_id'],chosen['request_id']])):
            with self.subTest(selection=raw):
                with closing(self.h.state.connect()) as db:
                    db.execute('DELETE FROM host_team_wait_specs WHERE run_id=?',(run['run_id'],))
                    if raw is not None:db.execute('INSERT INTO host_team_wait_specs VALUES(?,?)',(run['run_id'],raw))
                    db.commit()
                self.assertNotEqual(self.fail()['state'],'offer')
                with closing(self.h.state.connect()) as db:
                    self.assertEqual(db.execute('SELECT COUNT(*) FROM control_recoveries WHERE request_id=?',(request,)).fetchone()[0],0)
                self.assert_old_preserved(old)

if __name__=='__main__':unittest.main(verbosity=2)
