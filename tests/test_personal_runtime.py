"""Personal-edition behavior against the real temporary Host ledger.

No browser, model, Runner, or existing business task is started.
"""
import hashlib,json,sys,unittest,uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from contextlib import closing
from unittest.mock import patch
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_harness_managed as fixture
from test_harness_control_plane import PAGE
from test_harness_goal_watch import OperatorFixture
from harness_goal_watch import Goals
from harness_state import HarnessError
from harness_managed import ManagedPages
from harness_run_limits import migrate_runs,deadline_live,sends_available
from harness_work_package import work_message


class PersonalRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.f=fixture.ManagedTests();self.f.setUp();self.h=self.f.h;self.m=self.f.m
        self.page='web-'+str(uuid.uuid4());self.url='https://chatgpt.com/c/'+str(uuid.uuid4())
        self.registration={'page_id':self.page,'title':'Personal direct','account':'A','model':'GPT-6 Astra Pro','effort':'最高'}
        self.record=self.m.browser('register-direct',self.registration);self.thread=self.record['thread_id']
        self.m.browser('bind-direct',{'page_id':self.page,'url':self.url})
        self.watch=Goals.__new__(Goals);self.watch.root=self.f.f.root;self.watch.path=self.h.state.path
        self.operator=OperatorFixture(self.f.f.s);self.watch.operator=self.operator

    def tearDown(self):self.f.tearDown()
    def view(self):return self.m.browser('view',{'page_id':self.page})
    def send(self,text='Original work'):
        self.request='personal-'+uuid.uuid4().hex
        self.f.f.command(self.thread,'message.send',{'text':text},key=self.request)
        return self.request
    def start(self,text='Original work'):
        self.send(text)
        offer=self.f.wire(self.page,'pulse')
        self.assertEqual(offer['state'],'offer')
        dispatch=self.f.wire(self.page,'dispatch',attempt_id=offer['attempt_id'])
        self.f.wire(self.page,'sent',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        self.offer=offer
        return dispatch
    def end(self,text='Finished work'):
        return self.f.wire(self.page,'result',attempt_id=self.offer['attempt_id'],
            page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64},assistant_turn_hash='d'*64,text=text)
    def append(self,text,key=None):
        return self.f.f.command(self.thread,'message.append',{'text':text,'expected_request_id':self.request},key=key or 'note-'+uuid.uuid4().hex)
    def goal(self,mode='automatic'):
        old=self.m.browser('goal-read',{'page_id':self.page})['goal']
        return self.m.browser('goal-save',{'page_id':self.page,'operation_id':'save-'+uuid.uuid4().hex,
            'expected_etag':old['etag'],'expected_goal_request_id':self.request,'objective':'Finish the entire deliverable.','mode':mode})
    def tick(self):
        with patch.object(self.watch,'health',return_value=True):self.watch.tick()
    def refill(self,sends=0,seconds=0):
        return self.m.browser('refill-budget',{'page_id':self.page,'operation_id':'budget-'+uuid.uuid4().hex,
            'expected_etag':self.view()['budget_status']['etag'],'add_dispatches':sends,'add_seconds':seconds})

    def test_direct_registration_reuses_identity_and_never_invents_project_session(self):
        replay=self.m.browser('register-direct',self.registration)
        self.assertEqual(replay['thread_id'],self.thread)
        with closing(self.h.state.connect()) as db:
            spec=json.loads(db.execute('SELECT spec FROM host_bindings WHERE thread_id=?',(self.thread,)).fetchone()[0])
            self.assertIsNone(spec['session_id']);self.assertIsNone(spec['project'])
            settings=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(self.page,)).fetchone()[0])
            self.assertIsNone(settings['duration_seconds']);self.assertIsNone(settings['max_dispatches'])
            carrier=self.h.team.carriers.projection(db,self.h.binding(db,thread=self.thread))
            self.assertTrue(carrier['queueable'])
        listed=self.m.browser('list',{})['pages'][0]
        self.assertEqual(listed['phase'],'bound');self.assertEqual(listed['conversation_mode'],'direct')
        self.assertFalse(listed['collaboration_enabled'])
        with self.assertRaises(HarnessError):self.m.browser('bind-direct',{'page_id':self.page,'url':'https://chatgpt.com/c/'+str(uuid.uuid4())})

    def test_normal_reply_ends_without_goal_and_current_mcp_receipt_not_required(self):
        self.start();result=self.end()
        self.assertEqual(self.view()['latest_request']['phase'],'completed');self.tick()
        self.assertEqual(self.operator.posts,[])
        self.assertIsNone(self.view()['run'])
        self.assertEqual(self.view()['latest_request']['delivery_state'],'sent')

    def test_new_direct_preview_uses_exact_work_message_without_enrollment(self):
        original='  用户原文\n保留顺序和空白。  '
        with closing(self.h.state.connect()) as db:
            before={table:db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ('managed_pages','host_requests','operations')}
        for account in ('A','B'):
            preview=self.m.browser('prompt-preview',{'page_id':'new-direct-preview-'+account,'account':account,
                'root':'','conversation_mode':'direct','instructions':original})
            self.assertEqual(preview['blocks'][0]['text'],work_message(original,first=True))
            self.assertEqual(preview['model_sends'],0);self.assertEqual(preview['conversation_mode'],'direct')
            for forbidden in ('Session','enroll','ticket','clwm_'):
                self.assertNotIn(forbidden,preview['blocks'][0]['text'])
        with closing(self.h.state.connect()) as db:
            for table,count in before.items():self.assertEqual(db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],count)

    def test_registered_direct_preview_uses_real_mode_and_saved_instructions_or_draft(self):
        preview=self.m.browser('prompt-preview',{'page_id':self.page,'conversation_mode':'managed','draft':'Draft before first send'})
        self.assertEqual(preview['blocks'][0]['text'],work_message('Draft before first send',first=True))
        with closing(self.h.state.connect()) as db:
            settings=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(self.page,)).fetchone()[0])
            settings['first_turn_instructions']='Saved original first task'
            db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(json.dumps(settings),self.page));db.commit()
        saved=self.m.browser('prompt-preview',{'page_id':self.page,'instructions':'Changed UI draft'})
        self.assertEqual(saved['blocks'][0]['text'],work_message('Saved original first task',first=True))

    def test_saved_direct_preview_matches_original_first_dispatch_with_goal_guidance(self):
        self.send('Actual original first message');self.goal()
        offered=self.f.wire(self.page,'pulse')
        dispatch=self.f.wire(self.page,'dispatch',attempt_id=offered['attempt_id'])
        preview=self.m.browser('prompt-preview',{'page_id':self.page,'conversation_mode':'managed','instructions':'Not the original message'})
        self.assertEqual(preview['source'],'saved_direct_message')
        self.assertEqual(preview['blocks'][0]['text'],dispatch['prompt'])
        self.assertIn('CLW_GOAL_STATUS',preview['blocks'][0]['text'])
        self.assertNotIn('Not the original message',preview['blocks'][0]['text'])

    def test_supplements_keep_original_order_and_do_not_block_current_delivery(self):
        self.start('Build the whole task')
        first=self.append('第一条\n保持原文')
        second=self.append('Second supplement, exact punctuation!')
        self.assertEqual(self.view()['next_round']['count'],2)
        with closing(self.h.state.connect()) as db:
            self.assertIsNone(db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',(self.request,)).fetchone())
        self.assertEqual(self.h.collaboration.request_details(self.request)['additional_instructions'],[])
        self.end();self.assertEqual(self.view()['latest_request']['phase'],'completed')
        self.tick();self.assertEqual(len(self.operator.posts),1)
        self.assertEqual(self.operator.posts[0]['data']['text'],'第一条\n保持原文\n\nSecond supplement, exact punctuation!')
        self.tick();self.assertEqual(len(self.operator.posts),1)
        self.assertEqual(self.view()['next_round']['count'],0)

    def test_lost_send_reply_and_reconstructed_host_do_not_replay_batch(self):
        self.start();self.append('Next complete work');self.end()
        self.operator.lose_reply=True;self.tick()
        self.assertEqual(len(self.operator.posts),1)
        self.h.managed=ManagedPages(self.h);self.m=self.h.managed
        self.operator.lose_reply=False;self.tick()
        self.assertEqual(len(self.operator.posts),1)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_next_round_batches').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests WHERE thread_id=?',(self.thread,)).fetchone()[0],2)

    def test_new_human_send_folds_queued_notes_and_revokes_unsent_prepared_batch(self):
        self.start();self.append('First input');self.append('Second input');self.end()
        prior=self.m.browser('next-round-prepare',{'page_id':self.page})['batch']
        key='explicit-'+uuid.uuid4().hex
        accepted=self.f.f.command(self.thread,'message.send',{'text':'Newest user input'},key=key)
        self.assertEqual(accepted['state'],'queued_for_web_host')
        self.tick();self.assertEqual(self.operator.posts,[])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT text FROM host_requests WHERE id=?',(key,)).fetchone()[0],
                'First input\n\nSecond input\n\nNewest user input')
            self.assertEqual(db.execute('SELECT state FROM managed_next_round_batches WHERE id=?',(prior['id'],)).fetchone()[0],'superseded')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests WHERE thread_id=?',(self.thread,)).fetchone()[0],2)
        late=self.f.f.command(self.thread,'message.send',{'text':prior['text']},key=prior['id'])
        self.assertEqual(late['state'],'rejected')
        self.assertEqual(self.view()['next_round']['count'],0)

    def test_large_chinese_supplements_merge_without_ascii_escape_rejection(self):
        self.start();self.goal()
        first='需'*10000;second='求'*10000
        self.append(first);self.append(second);self.end()
        self.tick();self.assertEqual(len(self.operator.posts),1)
        accepted=self.view()['latest_request']
        self.assertEqual(accepted['phase'],'queued')
        self.assertTrue(self.operator.posts[0]['data']['text'].startswith(first+'\n\n'+second))

    def test_unknown_prepared_send_only_reads_original_receipt(self):
        self.start();self.append('Preserve pending input');self.end()
        batch=self.m.browser('next-round-prepare',{'page_id':self.page})['batch']
        with closing(self.h.state.connect()) as db:
            # An original send was reserved before a crash; it may have executed.
            raw={'request_id':batch['id'],'thread_id':self.thread,'action':'message.send','data':{'text':batch['text']}}
            self.h.state.begin(batch['id'],raw)
            db.execute("UPDATE operations SET state='unknown' WHERE id=?",(batch['id'],));db.commit()
        self.tick();self.tick();self.assertEqual(self.operator.posts,[])
        self.assertEqual(self.view()['next_round']['state'],'delivery_unknown')

    def test_pausing_preserves_queued_notes_and_completed_goal(self):
        self.start();self.append('queued');self.end()
        self.m.browser('pause',{'page_id':self.page,'paused':True});self.tick()
        self.assertEqual(self.operator.posts,[]);self.assertEqual(self.view()['next_round']['count'],1)
        self.m.browser('pause',{'page_id':self.page,'paused':False});self.tick()
        self.assertEqual(len(self.operator.posts),1)

    def test_pending_supplement_can_be_withdrawn_after_current_result(self):
        self.start();note=self.append('Withdraw only this input');self.end()
        before=self.view()['next_round']['messages'][0]
        self.assertTrue(before['withdrawable'])
        result=self.m.browser('withdraw',{'page_id':self.page,'request_id':before['request_id'],'note_id':before['id']})
        self.assertEqual(result['text'],'Withdraw only this input')
        self.assertEqual(self.view()['next_round']['count'],0);self.tick()
        self.assertEqual(self.operator.posts,[])

    def test_automatic_goal_delivered_with_normal_result_no_review_turn(self):
        self.send();saved=self.goal();self.assertEqual(saved['goal']['display_state'],'running')
        offer=self.f.wire(self.page,'pulse');self.offer=offer
        dispatch=self.f.wire(self.page,'dispatch',attempt_id=offer['attempt_id'])
        self.assertIn('CLW_GOAL_STATUS',dispatch['prompt'])
        self.f.wire(self.page,'sent',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        self.end('All original work delivered.\nCLW_GOAL_STATUS: delivered')
        self.assertEqual(self.view()['goal']['state'],'complete');self.assertEqual(self.view()['goal']['display_state'],'delivered')
        self.tick();self.assertEqual(self.operator.posts,[])

    def test_new_manual_goal_only_disables_automatic_continuation(self):
        self.start();self.goal(mode='manual');self.end('Actual original delivery');self.tick()
        goal=self.view()['goal'];self.assertEqual(goal['result_contract'],2)
        self.assertFalse(goal['can_review']);self.assertEqual(goal['state'],'paused')
        sent=self.f.f.command(self.thread,'message.send',{'text':'Human selected next work'},key='manual-'+uuid.uuid4().hex)
        self.assertEqual(sent['state'],'queued_for_web_host')
        goal=self.view()['goal'];self.assertEqual(goal['request_id'],sent['request_id']);self.assertEqual(goal['state'],'paused')
        self.tick();self.assertEqual(self.operator.posts,[])

    def test_waiting_polls_only_original_jobs_and_merges_one_resume(self):
        self.start();self.goal()
        waiting={'job_ids':['already-submitted-job'],'result':'simulation results','resume':'Finish analysis and package','independent_work_complete':True}
        self.end('Independent work finished.\nCLW_GOAL_STATUS: waiting\nCLW_GOAL_WAIT: '+json.dumps(waiting))
        self.assertEqual(self.view()['goal']['display_state'],'waiting')
        def observed(status):
            return {'structuredContent':{'success':True,'error':None,'output':{'items':[{'index':0,'job_id':'already-submitted-job','success':True,
              'output':{'job_id':'already-submitted-job','status':status,'terminal':status=='completed','command_execution_state':'completed' if status=='completed' else 'running'}}]}}}
        with patch('harness_goal_watch.local_runtime_read',return_value=observed('running')) as read:
            self.tick();self.assertEqual(self.operator.posts,[])
            self.assertEqual(read.call_args.args[1],'observe_jobs')
        with patch('harness_goal_watch.local_runtime_read',return_value=observed('completed')):
            self.tick();self.tick()
        self.assertEqual(len(self.operator.posts),1)
        self.assertIn('所等结果已到齐',self.operator.posts[0]['data']['text'])

    def test_invalid_wait_never_discards_the_real_result(self):
        self.start();self.goal();self.end('Incomplete wait details\nCLW_GOAL_STATUS: waiting')
        self.assertEqual(self.view()['latest_request']['phase'],'completed')
        self.assertEqual(self.view()['goal']['state'],'needs_attention')

    def test_project_invalid_wait_metadata_saves_and_delivers_original_result(self):
        page,request,offer,context=self.f.start_browser_turn()
        old=self.m.browser('goal-read',{'page_id':page})['goal']
        self.m.browser('goal-save',{'page_id':page,'operation_id':'goal-'+uuid.uuid4().hex,
            'expected_etag':old['etag'],'expected_goal_request_id':request,'objective':'Complete the project','mode':'automatic'})
        saved=self.f.private(page,'turn-end',{'request_id':request,'claim_id':context['request']['claim_id'],
            'outcome':'completed','markdown':'Actual full original result','goal_status':'waiting'})
        self.assertEqual(saved['state'],'turn_outcome_saved');self.assertIn('goal_metadata_warning',saved)
        self.f.wire(page,'result',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64},assistant_turn_hash='d'*64,text='Actual DOM result')
        view=self.m.browser('view',{'page_id':page})
        self.assertEqual(view['latest_request']['phase'],'completed');self.assertEqual(view['goal']['state'],'needs_attention')

    def test_text_collaboration_updates_goal_in_the_original_result_transaction(self):
        page,binding=self.f.enroll(collaboration_protocol='text_v1')
        request=self.f.f.command(binding['thread_id'],'message.send',{'text':'Complete the original work'})['request_id']
        old=self.m.browser('goal-read',{'page_id':page})['goal']
        self.m.browser('goal-save',{'page_id':page,'operation_id':'goal-'+uuid.uuid4().hex,
            'expected_etag':old['etag'],'expected_goal_request_id':request,'objective':'Finish the complete deliverable','mode':'automatic'})
        offer=self.f.wire(page,'pulse');self.f.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        self.f.wire(page,'sent',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        original='Full delivered work.\nCLW_GOAL_STATUS: delivered\n```clw-plan-v1\n'+json.dumps({'version':1,'action':'completed','summary':'Original complete delivery'})+'\n```'
        self.m.browser('artifact',{'page_id':page,'attempt_id':offer['attempt_id'],'text':original,'assistant_turn_hash':'d'*64})
        self.f.wire(page,'result',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64},assistant_turn_hash='d'*64,text=original)
        self.assertEqual(self.m.browser('goal-read',{'page_id':page})['goal']['state'],'complete')

    def test_supplement_during_external_wait_keeps_original_wait_in_one_message(self):
        self.start();self.goal()
        waiting={'job_ids':['original-job'],'result':'original output','resume':'Finish the original analysis','independent_work_complete':True}
        self.end('CLW_GOAL_STATUS: waiting\nCLW_GOAL_WAIT: '+json.dumps(waiting))
        self.append('User priority, original text')
        with patch('harness_goal_watch.local_runtime_read',side_effect=AssertionError('queued input already has one next message')):
            self.tick();self.tick()
        self.assertEqual(len(self.operator.posts),1)
        message=self.operator.posts[0]['data']['text']
        self.assertTrue(message.startswith('User priority, original text'))
        self.assertIn('original-job',message);self.assertIn(waiting['resume'],message)

    def test_migration_preserves_old_paused_run_claim_receipt_and_operations(self):
        page,request,offer,context=self.f.start_browser_turn()
        with closing(self.h.state.connect()) as db:
            db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?',(page,))
            before={name:[tuple(r) for r in db.execute('SELECT * FROM '+name)] for name in ('host_requests','operations','control_attempts','control_browser_receipts','managed_pages','host_runs')}
            sql=db.execute("SELECT sql FROM sqlite_master WHERE name='host_runs'").fetchone()[0]
            sql=sql.replace('CREATE TABLE host_runs','CREATE TABLE legacy_runs').replace('deadline REAL,','deadline REAL NOT NULL,').replace('max_dispatches INTEGER,','max_dispatches INTEGER NOT NULL,')
            db.execute(sql);db.execute('INSERT INTO legacy_runs SELECT * FROM host_runs')
            db.execute('DROP TABLE host_runs');db.execute('ALTER TABLE legacy_runs RENAME TO host_runs');db.commit()
        def startup(_):
            with closing(self.h.state.connect()) as db:
                migrate_runs(db);db.commit()
        with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(startup,range(2)))
        with closing(self.h.state.connect()) as db:
            for name,rows in before.items():self.assertEqual([tuple(r) for r in db.execute('SELECT * FROM '+name)],rows,name)
            budgets={r['name']:r['notnull'] for r in db.execute('PRAGMA table_info(host_runs)')}
            self.assertFalse(budgets['deadline']);self.assertFalse(budgets['max_dispatches'])
            db.execute("INSERT INTO host_runs(id,controller_thread,controller_request,goal_ref,constraints_text,state,max_parallel,created) VALUES('unbounded-run',?,'unbounded-original','goal','','running',0,1)",(self.thread,))
            self.assertIsNone(db.execute("SELECT deadline FROM host_runs WHERE id='unbounded-run'").fetchone()[0])

    def test_new_project_defaults_null_budget_and_explicit_budget_remains_real(self):
        page='web-'+str(uuid.uuid4())
        self.m.browser('reserve',{'page_id':page,'title':'New project','root':str(self.f.f.root),'account':'A','model':'GPT-6 Astra Pro','effort':'最高'})
        item=next(row for row in self.m.browser('list',{})['pages'] if row['page_id']==page)
        self.assertIsNone(item['duration_seconds']);self.assertIsNone(item['max_dispatches'])
        finite={'deadline':100,'max_dispatches':3,'dispatches':1}
        self.assertFalse(deadline_live(finite,101));self.assertTrue(sends_available(finite,1,1));self.assertFalse(sends_available(finite,2,1))
        unbounded={'deadline':None,'max_dispatches':None,'dispatches':1000000}
        self.assertTrue(deadline_live(unbounded,1000000000));self.assertTrue(sends_available(unbounded,1000000,1))

    def test_direct_explicit_send_budget_counts_real_attempts_and_refill_preserves_notes(self):
        self.refill(sends=2);self.start();self.goal();self.end('Saved work\nCLW_GOAL_STATUS: in_progress');self.tick()
        self.assertEqual(len(self.operator.posts),1)
        next_request=self.view()['latest_request']['id']
        prior={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64}
        offered=self.f.wire(self.page,'pulse',page=prior)
        self.f.wire(self.page,'dispatch',attempt_id=offered['attempt_id'],page=prior)
        self.f.wire(self.page,'sent',attempt_id=offered['attempt_id'],page={**prior,'user_hash':'e'*64,'generating':True},assistant_before_hash='d'*64)
        self.f.wire(self.page,'result',attempt_id=offered['attempt_id'],page={**prior,'user_hash':'e'*64},assistant_turn_hash='f'*64,text='Saved more\nCLW_GOAL_STATUS: in_progress')
        self.tick();view=self.view()
        self.assertEqual(view['goal']['reason'],'user_budget_exhausted');self.assertEqual(view['budget_status']['used'],2)
        self.assertEqual(view['budget_status']['available_sends'],0);self.assertIsNone(view['run'])
        self.request=next_request;self.append('Do this next');self.tick();self.assertEqual(len(self.operator.posts),1)
        self.refill(sends=2);self.tick();self.assertEqual(len(self.operator.posts),2)
        self.assertEqual(self.view()['next_round']['count'],0)

    def test_direct_explicit_time_budget_starts_at_send_and_refill_keeps_original(self):
        self.refill(seconds=1);self.start();self.end()
        with closing(self.h.state.connect()) as db:
            first=db.execute('SELECT MIN(dispatched) FROM control_attempts WHERE thread_id=?',(self.thread,)).fetchone()[0]
        self.h.clock=lambda:first+100
        denied=self.f.f.command(self.thread,'message.send',{'text':'New user request'},key='new-'+uuid.uuid4().hex)
        self.assertEqual(denied['state'],'rejected');self.assertEqual(denied['code'],'managed_budget_needs_time_and_sends')
        self.refill(seconds=120)
        self.assertEqual(self.view()['budget_status']['available_seconds'],120)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(self.request,)).fetchone()[0],'completed')


if __name__=='__main__':unittest.main()
