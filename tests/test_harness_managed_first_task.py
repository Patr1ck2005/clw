"""One real enrollment identity, one Host task, one model send; local fixtures only."""
from pathlib import Path
from contextlib import closing
from unittest.mock import patch
import sys,json,re,uuid,hashlib,unittest
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_harness_managed as fixture
from harness_state import HarnessError
from harness_managed_client import enter_first_task
from harness_control_plane import digest
from harness_work_package import WORK_PACKAGE_GUIDANCE

class FirstTaskTests(unittest.TestCase):
    def test_heavy_guidance_is_in_actual_first_task_but_not_bare_enrollment(self):
        for account in ('A', 'B'):
            with self.subTest(account=account):
                task='Implement assets, actors, animation and mechanics; verify the integrated build.'
                _, sent=self.f.reserve(account=account,first_turn_mode='task_v1',first_turn_instructions=task)
                self.assertIn(task,sent['bootstrap_text'])
                self.assertEqual(sent['bootstrap_text'].count(WORK_PACKAGE_GUIDANCE),1)
                _, bare=self.f.reserve(account=account)
                self.assertNotIn(WORK_PACKAGE_GUIDANCE,bare['bootstrap_text'])
    def setUp(self):
        self.f=fixture.ManagedTests();self.f.setUp();self.m=self.f.m
    def tearDown(self):self.f.tearDown()
    def test_unsent_worker_accepts_localized_latest_but_keeps_version_effort_and_parent(self):
        parent,_=self.receive(access='write',write_paths=['.'])
        self.f.private(parent,'first-task',{})
        child,_=self.f.reserve(parent,first_turn_mode='task_v1',
                                first_turn_instructions='Implement and verify the full independent module.')
        for model,effort in [('GPT-5.6 · Latest','Pro'),('GPT-6.1 · Latest','Pro'),
                             ('GPT-6 · Newest','Pro'),('GPT-6 · Latest','Extra High')]:
            with self.subTest(model=model,effort=effort):
                with self.assertRaisesRegex(HarnessError,'managed_model_observation_mismatch'):
                    self.m.browser('bootstrap-model-ready',{'page_id':child,'model_selection':{'model':model,'effort':effort,'selection':['Latest']}})
        result=self.m.browser('bootstrap-model-ready',{'page_id':child,'model_selection':{'model':'GPT-6 · Latest','effort':'Pro','selection':['Latest']}})
        self.assertTrue(result['verified']);self.assertEqual(result['model_sends'],0)
        rows={p['page_id']:p for p in self.m.browser('list',{})['pages']}
        self.assertEqual(rows[child]['model'],'gpt-6 · latest');self.assertEqual(rows[child]['effort'],'pro')
        self.assertEqual(rows[child]['bootstrap_model_selection']['selection'],['Latest'])
        self.assertFalse(rows[child]['work_model_pending']);self.assertEqual(rows[child]['bootstrap_state'],'pending')
        self.assertIsNone(rows[child]['latest_request']);self.assertEqual(rows[parent]['model'],'gpt-6 · 最新')
    def receive(self,parent=None,historical_busy_send=False,**options):
        pro={'model':'GPT-6 · 最新','effort':'Pro','selection':['最新']}
        selection={} if parent else {'model':pro['model'],'effort':'Pro','model_selection':pro}
        page,prompt=self.f.reserve(parent,**selection,first_turn_mode='task_v1',
                                  first_turn_instructions='Read, implement, verify and deliver this complete task.',**options)
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
        self.m.browser('bootstrap-model-ready',{'page_id':page,'model_selection':row['bootstrap_model_selection']})
        if historical_busy_send:
            # Reproduce an enrollment already sent by the previous release.
            with patch('harness_managed_first_task.bootstrap_wait',return_value=None):
                self.m.browser('bootstrap',{'page_id':page,'state':'sending'})
        else:self.m.browser('bootstrap',{'page_id':page,'state':'sending'})
        self.m.browser('bootstrap',{'page_id':page,'state':'sent'})
        self.f.sessions[page]='wc_sess_'+uuid.uuid4().hex
        enrollment=self.f.private(page,'enroll',{'ticket':re.search(r'clwm_[A-Za-z0-9_-]{43}',prompt['bootstrap_text'])[0],
            'project':'own-project','root':str(self.f.f.root)},'enroll-'+page)
        return page,enrollment
    def bind(self,page,enrollment,text='Public result'):
        text+='\n'+enrollment['browser_marker']
        return self.m.browser('bind',{'page_id':page,'url':'https://chatgpt.com/c/'+page,'public_text':text,
            'preparation_markdown':text,'source_hash':hashlib.sha256(text.encode()).hexdigest()})
    def finish(self,page,request,text='Complete **Markdown**\n\n```py\nprint(1)\n```\n\n$E=mc^2$',outcome='completed'):
        return self.f.private(page,'turn-end',{'request_id':request['id'],'claim_id':request['claim_id'],
            'outcome':outcome,'markdown':text},'finish-'+page)
    def test_controller_and_worker_finish_in_their_enrollment_turn_without_second_assignment(self):
        parent,enrollment=self.receive(access='write',write_paths=['.'],max_dispatches=3)
        started=self.f.private(parent,'first-task',{})
        self.assertEqual(started['state'],'first_task_ready');self.assertEqual(started['run']['dispatches'],1)
        request=started['request'];run_id=started['run']['id']
        child,child_enrollment=self.receive(parent,historical_busy_send=True)
        waiting=self.f.private(child,'first-task',{})
        self.assertEqual(waiting['state'],'waiting_local_slot')
        self.f.private(parent,'wait-ready',{'targets':[child]})
        self.finish(parent,request,'Waiting for the original worker','yielded');self.bind(parent,enrollment)
        claimed=self.f.private(child,'first-task',{})
        self.assertEqual(claimed['state'],'first_task_ready')
        self.assertEqual(self.f.private(child,'first-task',{})['request']['claim_id'],claimed['request']['claim_id'])
        result=self.finish(child,claimed['request'])
        self.assertIn('$E=mc^2$',Path(result['path']).read_text(encoding='utf-8'))
        self.assertEqual(self.finish(child,claimed['request']),result)
        self.bind(child,child_enrollment)
        with closing(self.f.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT dispatches FROM host_runs WHERE id=?',(run_id,)).fetchone()[0],2)
            self.assertEqual(db.execute('SELECT count(*) FROM host_team_work WHERE run_id=?',(run_id,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(claimed['request']['id'],)).fetchone()[0],'completed')
            self.assertEqual(db.execute('SELECT count(*) FROM host_team_leases WHERE request_id=?',(claimed['request']['id'],)).fetchone()[0],0)
            self.assertEqual(self.m.pages_ready(db,[child])['state'],'pages_ready')
            settings=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(child,)).fetchone()[0])
            self.assertEqual(settings['bootstrap_model_selection']['effort'],'pro')
            from harness_team_timing import result_timing
            timing=result_timing(db,claimed['request']['id'])
            self.assertEqual(timing['confirmed_sends'],1);self.assertEqual(timing['state'],'observed')
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==child)
        self.assertEqual(row['latest_request']['phase'],'completed');self.assertFalse(row['work_model_pending'])
    def test_missing_result_does_not_turn_public_reply_into_success(self):
        page,enrollment=self.receive()
        begun=self.f.private(page,'first-task',{})
        self.bind(page,enrollment,'Only a public claim of completion')
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
        self.assertTrue(row['paused']);self.assertEqual(row['issue_kind'],'bootstrap_receipt_missing')
        self.assertEqual(row['latest_request']['id'],begun['request']['id'])
        self.assertEqual(row['latest_request']['phase'],'processing')

    def test_first_task_returns_executable_result_contract_without_manual_read(self):
        page,enrollment=self.receive()
        started=self.f.private(page,'first-task',{},'first-contract-fixed-key')
        self.assertEqual(self.f.private(page,'first-task',{},'first-contract-fixed-key'),started)
        contract=started['result_delivery'];argv=contract['argv']
        self.assertEqual(argv[5],'turn-end')
        self.assertEqual(argv[argv.index('--session-id')+1],self.f.sessions[page])
        self.assertEqual(argv[argv.index('--target')+1],page)
        payload={**contract['payload'],'markdown':'无需另读管理手册的完整成果'}
        key=argv[argv.index('--operation-id')+1]
        result=self.f.private(page,'turn-end',payload,key)
        self.assertEqual(result['state'],'turn_outcome_saved')
        self.assertEqual(self.f.private(page,'turn-end',payload,key),result)
        self.assertEqual(Path(result['path']).read_text(encoding='utf-8'),payload['markdown'])
        self.bind(page,enrollment)

    def test_first_task_full_result_checks_identity_and_saved_content(self):
        page,_=self.receive();started=self.f.private(page,'first-task',{})
        result=self.finish(page,started['request'])
        request_id=started['request']['id']
        with closing(self.f.h.state.connect()) as db:
            event=db.execute("SELECT data FROM events WHERE kind='assistant_message' AND json_extract(data,'$.request_id')=?",(request_id,)).fetchone()
            reply=json.loads(event['data'])
            self.assertTrue(reply['item_id'].startswith('clw-initial-result-'))
            self.assertNotIn('[redacted]',reply['item_id'])
            self.assertIn('$E=mc^2$',self.m.text._full_public_reply(db,request_id,reply))
            # Prior versions used "first-task-result-...", whose "sk-"
            # substring was redacted. Reconcile only its original receipt.
            db.execute('UPDATE host_replies SET id=? WHERE request_id=?',('first-task-result-original-fixed-key',request_id))
            legacy={**reply,'item_id':'first-ta[redacted]'}
            self.assertIn('$E=mc^2$',self.m.text._full_public_reply(db,request_id,legacy))
            db.rollback()
            # A different request must never borrow this result, even if its
            # transport summary happens to name the same result file.
            other_reply={**reply,'text':'原摘要，不能借用别的请求成果'}
            self.assertEqual(self.m.text._full_public_reply(db,'other-request',other_reply),other_reply['text'])
            Path(result['path']).write_text('changed',encoding='utf-8')
            with self.assertRaisesRegex(HarnessError,'managed_text_public_artifact_changed'):
                self.m.text._full_public_reply(db,request_id,reply)

    def test_complete_workers_inherit_existing_authority_without_another_grant(self):
        parent,_=self.receive(access='write',write_paths=['.'])
        self.f.private(parent,'first-task',{})
        child,enrollment=self.receive(parent,historical_busy_send=True)
        reader,_=self.receive(parent,historical_busy_send=True,access='read',write_paths=[])
        rows={p['page_id']:p for p in self.m.browser('list',{})['pages']}
        self.assertEqual((rows[child]['access'],rows[child]['write_paths']),('write',['.']))
        self.assertEqual((rows[reader]['access'],rows[reader]['write_paths']),('read',[]))
        with closing(self.f.h.state.connect()) as db:
            scope=self.f.h.team.scopes.scope(db,enrollment['thread_id'])
            self.assertEqual((scope['access'],json.loads(scope['write_paths'])),('write',['.']))
            events=db.execute("SELECT COUNT(*) FROM events WHERE thread_id=? AND kind='team_workspace_granted'",(enrollment['thread_id'],)).fetchone()[0]
            self.assertEqual(events,1)

    def test_unsent_legacy_child_gets_full_task_on_same_page_and_current_run(self):
        parent,_=self.receive();started=self.f.private(parent,'first-task',{})
        child,old=self.f.reserve(parent)
        self.m.browser('page-issue',{'page_id':child,'kind':'preparation_required','detail':'Missing complete task'})
        payload={'target':child,'first_turn_instructions':'Read values and return a complete independent review.','activate':True}
        prepared=self.f.private(parent,'prepare-worker',payload,'prepare-original')
        self.assertEqual(self.f.private(parent,'prepare-worker',payload,'prepare-original'),prepared)
        self.assertEqual(prepared['page_id'],child);self.assertFalse(prepared['message_sent'])
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==child)
        self.assertEqual(row['first_turn_mode'],'task_v1');self.assertFalse(row['paused']);self.assertIsNone(row['issue_kind'])
        self.assertEqual(row['bootstrap_model_selection']['effort'],'pro');self.assertEqual(row['access'],'read')
        with closing(self.f.h.state.connect()) as db:
            saved=db.execute('SELECT settings,bootstrap_text FROM managed_pages WHERE page_id=?',(child,)).fetchone()
            self.assertEqual(json.loads(saved['settings'])['first_task_parent']['run_id'],started['run']['id'])
            self.assertNotEqual(saved['bootstrap_text'],old['bootstrap_text'])
            self.assertEqual(db.execute('SELECT count(*) FROM managed_pages').fetchone()[0],2)
        self.m.browser('bootstrap-model-ready',{'page_id':child,'model_selection':row['bootstrap_model_selection']})
        self.m.browser('bootstrap',{'page_id':child,'state':'sending'})
        with self.assertRaisesRegex(HarnessError,'managed_worker_already_sent_or_enrolled'):
            self.f.private(parent,'prepare-worker',payload,'never-rewrite-sending')

    def test_prepare_worker_preserves_independent_errors_pause_and_owner(self):
        parent,_=self.receive();self.f.private(parent,'first-task',{})
        child,_=self.f.reserve(parent)
        payload={'target':child,'first_turn_instructions':'Read and review.','activate':True}
        self.m.browser('pause',{'page_id':child,'paused':True})
        with self.assertRaisesRegex(HarnessError,'managed_worker_operator_paused'):
            self.f.private(parent,'prepare-worker',payload)
        self.m.browser('page-issue',{'page_id':child,'kind':'preparation_required','detail':'Missing complete task'})
        self.m.browser('pause',{'page_id':child,'paused':True})
        with self.assertRaisesRegex(HarnessError,'managed_worker_operator_paused'):
            self.f.private(parent,'prepare-worker',payload)
        self.m.browser('page-issue',{'page_id':child,'kind':'bootstrap_failed','detail':'Original platform refusal'})
        with self.assertRaisesRegex(HarnessError,'managed_worker_independent_issue'):
            self.f.private(parent,'prepare-worker',payload)
        with self.assertRaisesRegex(HarnessError,'managed_worker_not_owned'):
            self.f.private(parent,'prepare-worker',{**payload,'target':parent})

    def public_turn(self,page,body='Waiting for the actual children.'):
        return {'page_id':page,'url':'https://chatgpt.com/c/'+page,'public_text':body,
                'preparation_markdown':body,'source_hash':hashlib.sha256(body.encode()).hexdigest(),
                'history_at_latest':True,'public_complete':True,'marker_count':1,
                'user_marker':'[CLW-BOOTSTRAP:'+page+']'}

    def test_first_worker_waits_before_send_without_spending_budget(self):
        parent,_=self.receive(access='write',write_paths=['.'])
        started=self.f.private(parent,'first-task',{})
        child,_=self.f.reserve(parent,first_turn_mode='task_v1',first_turn_instructions='Implement, verify, deliver.')
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==child)
        self.assertEqual(row['bootstrap_wait']['blocking_request_id'],started['request']['id'])
        self.m.browser('bootstrap-model-ready',{'page_id':child,'model_selection':row['bootstrap_model_selection']})
        with self.assertRaisesRegex(HarnessError,'managed_bootstrap_waiting_local_slot'):
            self.m.browser('bootstrap',{'page_id':child,'state':'sending'})
        with closing(self.f.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT dispatches FROM host_runs WHERE id=?',(started['run']['id'],)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT bootstrap_state FROM managed_pages WHERE page_id=?',(child,)).fetchone()[0],'pending')
        self.f.private(parent,'wait-ready',{'targets':[child]})
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==child)
        self.assertIsNone(row['bootstrap_wait'])
        self.m.browser('bootstrap',{'page_id':child,'state':'sending'})
        with closing(self.f.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT dispatches FROM host_runs WHERE id=?',(started['run']['id'],)).fetchone()[0],2)

    def test_old_queued_first_turn_binds_without_claim_and_requires_explicit_resume(self):
        parent,_=self.receive(access='write',write_paths=['.'])
        self.f.private(parent,'first-task',{})
        child,enrollment=self.receive(parent,historical_busy_send=True)
        self.assertEqual(self.f.private(child,'first-task',{})['state'],'waiting_local_slot')
        self.m.browser('page-issue',{'page_id':child,'kind':'bootstrap_receipt_missing',
            'detail':'工具已接入，但本轮最终回复缺少原接入标记。请核对原网页，未自动重发。'})
        for bad in ({'marker_count':2},{'history_at_latest':False},{'user_marker':'foreign'}):
            with self.assertRaises(HarnessError):self.m.browser('bind-first-turn',{**self.public_turn(child),**bad})
        self.m.browser('bind-first-turn',self.public_turn(child,'Original admission was waiting. Diagnostic read was refused.'))
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==child)
        self.assertEqual(row['phase'],'bound');self.assertTrue(row['paused']);self.assertIsNone(row['issue_kind'])
        self.assertEqual(row['latest_request']['phase'],'queued')
        self.assertEqual(row['preparation_result']['task_outcome'],'not_started')
        rid=enrollment['first_task']['request_id']
        with closing(self.f.h.state.connect()) as db:
            self.assertIsNone(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(rid,)).fetchone()[0])
            self.assertEqual(db.execute('SELECT count(*) FROM control_attempts').fetchone()[0],0)
        self.f.private(parent,'wait-ready',{'targets':[child]})
        self.m.browser('pause',{'page_id':child,'paused':False,'expected_request_id':rid})
        offer=self.f.wire(child,'pulse',page={**fixture.PAGE,'model_label':row['model'],'effort_label':row['effort']})
        self.assertEqual(offer['state'],'offer');self.assertEqual(offer['request_id'],rid)
        with closing(self.f.h.state.connect()) as db:
            self.assertEqual(self.m.pages_ready(db,[child])['state'],'waiting_events')
        browser={**fixture.PAGE,'model_label':row['model'],'effort_label':row['effort']}
        self.f.wire(child,'dispatch',attempt_id=offer['attempt_id'],page=browser)
        browser={**browser,'user_hash':'b'*64}
        self.f.wire(child,'sent',attempt_id=offer['attempt_id'],page=browser,assistant_before_hash='c'*64)
        context=self.f.private(child,'context',{})
        self.assertEqual(context['request']['id'],rid)
        self.finish(child,context['request'],'Actual independent implementation and verification saved.')
        result=self.f.wire(child,'result',attempt_id=offer['attempt_id'],page=browser,
                           assistant_turn_hash='d'*64,text='Implementation delivered.')
        self.assertEqual(result['state'],'completed')
        with closing(self.f.h.state.connect()) as db:
            self.assertEqual(self.m.pages_ready(db,[child])['state'],'pages_ready')
            self.assertEqual(db.execute('SELECT count(*) FROM host_team_work').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT count(*) FROM control_attempts WHERE request_id=?',(rid,)).fetchone()[0],1)

    def test_unclaimed_binding_preserves_independent_issue_and_rejects_a_claim(self):
        page,enrollment=self.receive()
        self.m.browser('page-issue',{'page_id':page,'kind':'bootstrap_failed','detail':'Original tool refusal'})
        self.m.browser('bind-first-turn',self.public_turn(page,'No execution admitted.'))
        row=self.m.browser('list',{})['pages'][0]
        self.assertTrue(row['paused']);self.assertEqual(row['issue_kind'],'bootstrap_failed')
        other,_=self.receive()
        self.f.private(other,'first-task',{})
        with self.assertRaisesRegex(HarnessError,'managed_first_turn_receipt_required'):
            self.m.browser('bind-first-turn',self.public_turn(other,'Finished is not a tool receipt.'))

    def test_real_wait_binds_without_echo_or_extra_tool_call_and_repairs_only_false_alarm(self):
        parent,_=self.receive();self.f.private(parent,'first-task',{})
        child,_=self.f.reserve(parent,first_turn_mode='task_v1',first_turn_instructions='Read data and return result.')
        self.f.private(parent,'wait-ready',{'targets':[child]})
        self.m.browser('page-issue',{'page_id':parent,'kind':'bootstrap_receipt_missing',
            'detail':'工具已接入，但本轮最终回复缺少原接入标记。请核对原网页，未自动重发。'})
        for bad in ({'marker_count':2},{'history_at_latest':False},{'user_marker':'foreign'}):
            with self.assertRaises(HarnessError):self.m.browser('bind-first-turn',{**self.public_turn(parent),**bad})
        self.m.browser('bind-first-turn',self.public_turn(parent))
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==parent)
        self.assertEqual(row['phase'],'bound');self.assertFalse(row['paused']);self.assertIsNone(row['issue_kind'])
        self.assertEqual(row['latest_request']['phase'],'suspended')
        self.assertEqual(row['preparation_result']['task_outcome'],'yielded')

    def test_browser_completion_requires_tool_result_and_preserves_operator_pause(self):
        parent,_=self.receive();begun=self.f.private(parent,'first-task',{})
        with self.assertRaisesRegex(HarnessError,'managed_first_turn_receipt_required'):
            self.m.browser('bind-first-turn',self.public_turn(parent,'I say I finished.'))
        self.finish(parent,begun['request'])
        self.m.browser('pause',{'page_id':parent,'paused':True})
        self.m.browser('bind-first-turn',self.public_turn(parent,'Real result saved.'))
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==parent)
        self.assertTrue(row['paused']);self.assertEqual(row['latest_request']['phase'],'completed')

    def test_inflight_worker_enrollment_keeps_identity_when_parent_paused(self):
        parent,_=self.receive();self.f.private(parent,'first-task',{})
        child,prompt=self.f.reserve(parent,first_turn_mode='task_v1',first_turn_instructions='Read original data.')
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==child)
        self.m.browser('bootstrap-model-ready',{'page_id':child,'model_selection':row['bootstrap_model_selection']})
        self.m.browser('bootstrap',{'page_id':child,'state':'sending'})
        self.m.browser('bootstrap',{'page_id':child,'state':'sent'})
        self.m.browser('pause',{'page_id':parent,'paused':True})
        self.f.sessions[child]='wc_sess_'+uuid.uuid4().hex
        result=self.f.private(child,'enroll',{'ticket':re.search(r'clwm_[A-Za-z0-9_-]{43}',prompt['bootstrap_text'])[0],
            'project':'own-project','root':str(self.f.f.root)})
        self.assertEqual(result['state'],'receiver_enrolled')
        with self.assertRaisesRegex(HarnessError,'managed_parent_paused'):
            self.f.private(child,'first-task',{})
        context=self.f.private(child,'context',{})
        self.assertEqual(context['session_id'],self.f.sessions[child])
    def test_failed_first_work_stream_error_recovers_original_claim_without_reenrolling(self):
        now=[1000.];self.f.h.clock=lambda:now[0]
        page,enrollment=self.receive()
        original=self.f.private(page,'first-task',{})
        observed={'page_id':page,'url':'https://chatgpt.com/c/'+page,
            'marker':'[CLW-BOOTSTRAP:'+page+']','marker_count':1,'history_at_latest':True,
            'user_hash':'b'*64,'failure':'消息流中的错误'}
        with self.assertRaises(HarnessError):self.m.browser('first-task-failed',{**observed,'marker_count':2})
        with self.assertRaisesRegex(HarnessError,'managed_first_task_failure_unverified'):
            self.m.browser('first-task-failed',{**observed,'failure':'OpenAI 无法确定请求的安全状态'})
        self.m.browser('first-task-failed',observed)
        self.assertEqual(self.m.browser('view',{'page_id':page})['automatic_recovery']['state'],'backoff')
        failed={**fixture.PAGE,'model_label':'GPT-6 · 最新','effort_label':'pro','user_hash':'b'*64,
            'failure_kind':'generation_failed','failure_hash':digest('消息流中的错误')}
        self.assertNotEqual(self.f.wire(page,'pulse',page=failed)['state'],'offer')
        now[0]+=300
        offer=self.f.wire(page,'pulse',page=failed)
        self.assertTrue(offer['recovery']);self.assertEqual(offer['request_id'],original['request']['id'])
        self.f.wire(page,'dispatch',attempt_id=offer['attempt_id'],page=failed)
        self.f.wire(page,'sent',attempt_id=offer['attempt_id'],page={**failed,'generating':True,'user_hash':'c'*64,'failure_kind':''},assistant_before_hash='d'*64)
        context=self.f.private(page,'context',{})
        self.assertEqual(context['request']['claim_id'],original['request']['claim_id'])
        self.assertEqual(context['run']['dispatches'],2)
        self.f.wire(page,'pulse',page={**failed,'user_hash':'c'*64})
        self.assertEqual(self.m.browser('view',{'page_id':page})['automatic_recovery']['ordinal'],2)
        with closing(self.f.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM control_attempts').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT count(*) FROM host_requests').fetchone()[0],1)
    def test_first_work_requires_verified_send_and_preserves_explicit_pause(self):
        page,prompt=self.f.reserve(first_turn_mode='task_v1',first_turn_instructions='Implement and verify.')
        self.f.sessions[page]='wc_sess_'+uuid.uuid4().hex
        with self.assertRaisesRegex(HarnessError,'managed_first_task_model_or_send_unverified'):
            self.f.private(page,'enroll',{'ticket':re.search(r'clwm_[A-Za-z0-9_-]{43}',prompt['bootstrap_text'])[0],
                'project':'own-project','root':str(self.f.f.root)})
        page,enrollment=self.receive()
        self.m.browser('pause',{'page_id':page,'paused':True})
        with self.assertRaisesRegex(HarnessError,'managed_parent_paused'):self.f.private(page,'first-task',{})
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
        self.assertEqual(row['latest_request']['phase'],'queued')
    def test_local_wait_polls_only_an_unaccepted_claim_not_a_model_or_refused_operation(self):
        class Client:
            def __init__(self):self.calls=[]
            def call(self,action,**payload):
                self.calls.append((action,payload))
                return {'state':'waiting_local_slot'} if len(self.calls)==1 else {'state':'first_task_ready'}
        client=Client();sleeps=[]
        result=enter_first_task(client,{'first_task':{'request_id':'original'}},'fixed-key',sleep=sleeps.append)
        self.assertEqual(result['first_task']['state'],'first_task_ready')
        self.assertEqual(client.calls[0],client.calls[1]);self.assertEqual(sleeps,[2])
        client.call=lambda *a,**k: (_ for _ in ()).throw(HarnessError('platform_refused',403))
        with self.assertRaises(HarnessError):enter_first_task(client,{'first_task':{} or {'request_id':'r'}},'key',sleep=sleeps.append)
        self.assertEqual(sleeps,[2])

if __name__=='__main__':unittest.main()
