"""Local goal lifecycle tests, using the real ledger and operator command path.
No browser/model sends; fabricated completion data is confined to temp fixtures.
"""
from pathlib import Path
import hashlib,json,sys,time,unittest
from unittest.mock import patch
from urllib.error import HTTPError
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
from harness_goal_watch import Goals
import test_harness_managed as managed_fixture
from harness_managed_recovery import settle_saved_final
from native_work_admission import AdmissionError


class OperatorFixture:
    def __init__(self, service):
        self.service=service;self.posts=[];self.lose_reply=False;self.receipts={}
    def request(self, route, payload=None, intent=None):
        if route=='info':return {'store_id':self.service.state.id,'intent':'fixture'}
        if route=='command':
            self.posts.append(payload)
            result=self.service.command(payload)
            if self.lose_reply:raise OSError('response lost after acceptance')
            return result
        key=route.split('=',1)[1]
        if key in self.receipts:return self.receipts[key]
        try:return self.service.receipt(key)
        except Exception:raise HTTPError(route,404,'not found',None,None)


class GoalTests(unittest.TestCase):
    def setUp(self):
        self.fixture=managed_fixture.ManagedTests();self.fixture.setUp()
        self.service=self.fixture.f.s
        self.page,_=self.fixture.enroll()
        self.dbpath=self.service.state.path
        self.root=self.fixture.f.root
        # The production goal reader uses the same existing store, not a clone.
        self.goal=Goals.__new__(Goals);self.goal.root=self.root;self.goal.path=self.dbpath
        self.operator=OperatorFixture(self.service);self.goal.operator=self.operator
        with patch.object(Path,'is_file',return_value=True),patch.object(Goals,'db',self.goal.db):
            Goals(self.root,self.operator)
        with self.goal.db() as db:
            self.thread=db.execute('SELECT thread_id FROM managed_pages WHERE page_id=?',(self.page,)).fetchone()[0]
        self.request='original_request_12345'
        self.service.command({'request_id':self.request,'action':'message.send','thread_id':self.thread,'data':{'text':'original research'}})
        self.goal.enable(self.page,'Solve original problem with real evidence.')
        self.health=patch.object(self.goal,'health',return_value=True);self.health.start()
        self.jobs=patch('harness_goal_watch.local_runtime_read',side_effect=AssertionError('standard result must not probe Jobs'))
        self.jobs_mock=self.jobs.start()

    def tearDown(self):
        self.jobs.stop();self.health.stop();self.fixture.tearDown()

    def completed(self, text='Real fixture result', request=None):
        request=request or self.request
        artifact=self.root/'.local/harness/managed-results'/('fixture-'+request+'.md')
        artifact.parent.mkdir(parents=True,exist_ok=True);artifact.write_text(text,encoding='utf8')
        sha=hashlib.sha256(artifact.read_bytes()).hexdigest()
        with self.goal.db() as db:
            db.execute("UPDATE host_requests SET phase='completed',finished_at='done' WHERE id=?",(request,))
            db.execute("UPDATE threads SET status='idle',active_turn=NULL WHERE id=?",(self.thread,))
            db.execute("INSERT INTO host_runs(id,controller_thread,controller_request,goal_ref,constraints_text,state,deadline,max_dispatches,max_parallel,dispatches,final_granted,revision,wait_mode,after_seq,created,reason) VALUES(?,?,?,?,'','closed',?,43,0,6,0,0,'all',0,?,'controller_summary')",('run-'+request,self.thread,request,request,time.time()+600,time.time()))
            db.execute("INSERT INTO control_browser_receipts VALUES(?,?,?,?,?,?,?,?,?,?)",('attempt-'+request,request,self.thread,'claim','sent','before','turn',sha,'reply',time.time()))
            db.execute("INSERT INTO managed_artifacts VALUES(?,?,?,?,?,?,?,?)",('attempt-'+request+'-tool',request,self.thread,str(artifact),sha,artifact.stat().st_size,'local_mcp_public_result',time.time()))
        return artifact

    def saved_summary(self, text='Saved implementation progress; the complete goal remains open.'):
        """The real reconciliation writes all evidence in this temporary store."""
        unused=self.completed()
        with self.goal.db() as db:
            db.execute('DELETE FROM control_browser_receipts')
            db.execute('DELETE FROM managed_artifacts')
            self.attempt='control_'+'a'*32
            self.sent_hash=hashlib.sha256(('managed-public:[CLW:'+self.attempt+']:user').encode()).hexdigest()
            db.execute("INSERT INTO control_attempts VALUES(?,?,?,1,1,'acknowledged',?,?,?,?)",
                (self.attempt,self.request,self.thread,'a'*64,time.time()-3,time.time()-2,time.time()-1))
            db.execute("UPDATE host_requests SET phase='processing',claim_id='original_claim_12345',finished_at=NULL WHERE id=?",(self.request,))
            db.execute("UPDATE threads SET status='processing',active_turn=? WHERE id=?",(self.request,self.thread))
            self.fixture.h.emit(db,self.thread,'team_final_summary',{'run_id':'run-'+self.request,'request_id':self.request,
                'text':text,'references':['TURN-RESULT.md','FINAL-AUDIT.md'],'project_acceptance':False})
            self.fixture.h.emit(db,self.thread,'control_browser_result_failed',{'request_id':self.request,'attempt_id':self.attempt,
                'failure_kind':'generation_failed','failure_hash':hashlib.sha256('无法思考'.encode()).hexdigest(),'public_result_committed':False})
            binding=self.fixture.h.binding(db,thread=self.thread)
            # The fixture's ledger is under state/, while production saves next
            # to .local/harness/harness.sqlite3. Keep the real settling code and
            # its evidence layout, without moving or copying the temp ledger.
            with patch.object(self.fixture.m.state,'path',self.root/'.local/harness/harness.sqlite3'):
                self.assertTrue(settle_saved_final(self.fixture.m,db,binding))
            artifact=dict(db.execute("SELECT * FROM managed_artifacts WHERE id=?",('closed-summary-'+self.request,)).fetchone())
            self.session=binding['spec']['session_id']
            self.url=db.execute('SELECT url FROM managed_pages WHERE page_id=?',(self.page,)).fetchone()[0]
        unused.unlink()
        self.write_observation()
        self.jobs_mock.side_effect=None;self.jobs_mock.return_value=self.job_inventory()
        return Path(artifact['path'])

    def write_observation(self, **observed):
        now=time.time()
        status={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(now)),'connected':True,
            'pages':[{'id':self.page,'bound':True,'paused':False,'observation':{
                'url':self.url,'at':now*1000,'historyAtLatest':True,'generating':False,'draft':False,
                'composing':False,'approvalRequired':False,'loginRequired':False,
                'failure':'无法思考','complete':False,'attemptId':self.attempt,'userTurnHash':self.sent_hash,**observed}}]}
        path=self.root/'.local/web-host/task-status.json'
        path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(status),encoding='utf8')
        return path

    def job_inventory(self, jobs=None, **output):
        jobs=[] if jobs is None else jobs
        return {'structuredContent':{'success':True,'error':None,'output':{
            'jobs':jobs,'count':len(jobs),'matched_count':len(jobs),'truncated':False,**output}}}

    def test_busy_does_not_send(self):
        self.goal.tick();self.goal.tick()
        self.assertEqual(self.operator.posts,[])
        self.assertEqual(self.goal.status()[0]['reason'],'working')

    def test_saved_summary_large_history_uses_current_session_activity(self):
        self.saved_summary()
        def read(root, name, args):
            self.assertEqual(args['session_id'], self.session)
            if args.get('status'):
                return self.job_inventory()
            return self.job_inventory([{'id':str(n),'session_id':self.session,'status':'completed',
                                        'command_execution_state':'completed'} for n in range(100)],
                                      matched_count=1000,truncated=True)
        self.jobs_mock.side_effect=read
        self.goal.tick(); self.goal.tick()
        self.assertEqual(len(self.operator.posts),1)

    def test_saved_summary_cancelled_before_start_does_not_block_goal(self):
        self.saved_summary()
        self.jobs_mock.side_effect=None
        self.jobs_mock.return_value=self.job_inventory([{'session_id':self.session,
            'status':'cancelled','command_execution_state':'not_started'}])
        self.goal.tick()
        self.assertEqual(len(self.operator.posts),1)

    def test_completed_sends_one_full_package_through_real_service(self):
        self.completed();self.goal.tick();self.goal.tick()
        self.assertEqual(len(self.operator.posts),1)
        self.jobs_mock.assert_not_called()
        status=self.goal.status()[0];self.assertEqual(status['cycles'],1)
        self.assertIn('Solve original problem',self.operator.posts[0]['data']['text'])
        with self.goal.db() as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(status['request_id'],)).fetchone()[0],'queued')

    def test_reconciled_saved_summary_continues_once_after_lock_free_original_job_read(self):
        path=self.saved_summary();sha=hashlib.sha256(path.read_bytes()).hexdigest()
        def read(root,name,args):
            self.assertEqual((root,name,args),(self.root,'list_jobs',{'session_id':self.session,'limit':100}))
            with self.goal.db() as db:
                db.execute('BEGIN IMMEDIATE')
                db.rollback()
            return self.job_inventory([{'session_id':self.session,'status':status,'command_execution_state':'completed'}
                                       for status in ('completed','failed','cancelled')])
        self.jobs_mock.side_effect=read
        self.goal.tick();self.goal.tick()
        self.assertEqual(len(self.operator.posts),1);self.assertEqual(self.jobs_mock.call_count,1)
        status=self.goal.status()[0];self.assertEqual(status['cycles'],1)
        self.assertNotEqual(status['request_id'],self.request)
        prompt=self.operator.posts[0]['data']['text']
        self.assertIn('Solve original problem with real evidence.',prompt)
        self.assertIn('上一回合已结束并回收已保存总结，先读取完整引用结果并继续原完整目标',prompt)
        self.assertNotIn('上一完整工作包已结清',prompt)
        self.assertIn('继续未完成的完整目标',prompt)
        with self.goal.db() as db:
            self.assertEqual(tuple(db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',(self.request,)).fetchone()),
                             ('completed','original_claim_12345'))
            self.assertEqual(tuple(db.execute('SELECT state,reason FROM host_runs WHERE id=?',('run-'+self.request,)).fetchone()),
                             ('closed','controller_summary'))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_artifacts').fetchone()[0],1)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),sha)

    def test_saved_summary_does_not_interpret_natural_success_or_failure_as_goal_state(self):
        self.saved_summary('All done. Goal complete. 无法思考。Not complete; more implementation remains.')
        self.goal.tick()
        self.assertEqual(len(self.operator.posts),1)

    def test_saved_summary_respects_existing_exact_ready_for_review_marker_after_verification(self):
        path=self.saved_summary('Verified candidate ready for human review.\nCLW_GOAL_STATUS: ready_for_review\n')
        self.goal.tick()
        self.assertEqual(self.operator.posts,[]);self.jobs_mock.assert_not_called()
        self.assertEqual(self.goal.status()[0]['state'],'ready_for_review')
        self.goal.state(self.page,'active','');path.write_text('CLW_GOAL_STATUS: ready_for_review',encoding='utf8')
        self.goal.tick()
        self.assertEqual(self.goal.status()[0]['reason'],'final_evidence_invalid')

    def test_saved_summary_artifact_identity_bytes_and_hash_are_required(self):
        path=self.saved_summary()
        with self.goal.db() as db:
            original=dict(db.execute('SELECT * FROM managed_artifacts').fetchone())
        for column,value in [('id','wrong-summary'),('source','public_dom_markdown'),('request_id','foreign'),
                             ('thread_id','foreign'),('bytes',original['bytes']+1),('sha256','f'*64),
                             ('path',str(self.root/'outside-results.md'))]:
            with self.subTest(column=column):
                with self.goal.db() as db:
                    db.execute('UPDATE managed_artifacts SET '+column+'=?',(value,))
                    db.execute("UPDATE managed_goals SET state='active'")
                self.goal.tick()
                self.assertEqual(self.operator.posts,[]);self.assertIsNone(self.goal.status()[0]['pending_id'])
                self.jobs_mock.assert_not_called()
                with self.goal.db() as db:db.execute('UPDATE managed_artifacts SET '+column+'=?',(original[column],))
        path.write_text('tampered saved summary',encoding='utf8')
        self.goal.state(self.page,'active','');self.goal.tick()
        self.assertEqual(self.goal.status()[0]['reason'],'final_evidence_invalid')
        self.jobs_mock.assert_not_called()

    def test_saved_summary_requires_exact_original_event_and_closure_chain(self):
        self.saved_summary()
        with self.goal.db() as db:
            events={r['kind']:dict(r) for r in db.execute("SELECT * FROM events WHERE kind IN ('team_final_summary','control_browser_result_failed','host_result','managed_saved_final_reconciled')")}
        changes=[('team_final_summary','run_id','another-run'),('team_final_summary','request_id','foreign'),
                 ('managed_saved_final_reconciled','source_event_seq',events['host_result']['seq']),
                 ('managed_saved_final_reconciled','source_event_seq',True),
                 ('managed_saved_final_reconciled','model_sends',1),('managed_saved_final_reconciled','project_acceptance',True),
                 ('managed_saved_final_reconciled','path','foreign'),('host_result','status','blocked'),
                 ('control_browser_result_failed','request_id','foreign')]
        for kind,key,value in changes:
            with self.subTest(kind=kind,key=key):
                row=events[kind];data=json.loads(row['data']);data[key]=value
                with self.goal.db() as db:
                    db.execute('UPDATE events SET data=? WHERE seq=?',(json.dumps(data),row['seq']))
                    db.execute("UPDATE managed_goals SET state='active'")
                self.goal.tick();self.assertEqual(self.operator.posts,[]);self.jobs_mock.assert_not_called()
                with self.goal.db() as db:db.execute('UPDATE events SET data=? WHERE seq=?',(row['data'],row['seq']))
        with self.goal.db() as db:
            db.execute('DELETE FROM host_replies WHERE id=?',('closed-summary-'+self.request,))
            db.execute("UPDATE managed_goals SET state='active'")
        self.goal.tick();self.assertEqual(self.operator.posts,[]);self.jobs_mock.assert_not_called()

    def test_saved_summary_unknown_local_operations_and_control_delivery_never_probe_or_send(self):
        self.saved_summary()
        with self.goal.db() as db:
            db.execute("INSERT INTO operations VALUES('original-unknown','fp','command.run',?,'unknown',NULL,'now')",(self.thread,))
        self.goal.tick()
        self.assertEqual(self.goal.status()[0]['reason'],'original_execution_unknown');self.jobs_mock.assert_not_called()
        with self.goal.db() as db:
            db.execute("DELETE FROM operations WHERE id='original-unknown'")
            db.execute("UPDATE managed_goals SET state='active'")
            db.execute("INSERT INTO control_attempts VALUES('original-unknown',?,?,2,1,'unknown','hash',0,NULL,NULL)",(self.request,self.thread))
        self.goal.tick()
        self.assertEqual(self.operator.posts,[]);self.jobs_mock.assert_not_called()

    def test_saved_summary_nonterminal_jobs_wait_then_advance_without_new_operation_key(self):
        self.saved_summary()
        for status in ('queued','running'):
            self.jobs_mock.return_value=self.job_inventory([{'session_id':self.session,'status':status,'command_execution_state':status}])
            self.goal.tick()
            self.assertEqual((self.goal.status()[0]['state'],self.goal.status()[0]['reason']),('active','waiting_for_original_jobs'))
            self.assertIsNone(self.goal.status()[0]['pending_id']);self.assertEqual(self.operator.posts,[])
        self.jobs_mock.return_value=self.job_inventory()
        self.goal.tick()
        self.assertEqual(len(self.operator.posts),1)

    def test_saved_summary_jobs_require_strict_complete_same_session_inventory(self):
        self.saved_summary()
        job={'session_id':self.session,'status':'completed','command_execution_state':'completed'}
        invalid=[self.job_inventory([{**job,'session_id':'foreign'}]),
                 self.job_inventory([{**job,'status':'unknown'}]),
                 self.job_inventory([{**job,'command_execution_state':'pending'}]),
                 self.job_inventory([{k:v for k,v in job.items() if k!='command_execution_state'}]),
                 self.job_inventory([job],truncated=True),self.job_inventory([job],matched_count=2),
                 self.job_inventory([job],count=True),self.job_inventory([],matched_count=1),
                 {'structuredContent':{'success':False,'error':None,'output':self.job_inventory()['structuredContent']['output']}},
                 {'structuredContent':{'success':True,'error':'reported failure','output':self.job_inventory()['structuredContent']['output']}},
                 {'isError':True,**self.job_inventory()},{}]
        for result in invalid:
            with self.subTest(result=result):
                self.goal.state(self.page,'active','');self.jobs_mock.return_value=result
                self.goal.tick();status=self.goal.status()[0]
                self.assertEqual(status['state'],'needs_attention');self.assertIsNone(status['pending_id'])
                self.assertEqual(self.operator.posts,[])

    def test_saved_summary_probe_unavailable_preserves_original_and_never_retries_a_send(self):
        self.saved_summary()
        for error in (OSError('unavailable'),AdmissionError('local_runtime_identity_changed')):
            with self.subTest(error=error):
                self.goal.state(self.page,'active','');self.jobs_mock.side_effect=error
                self.goal.tick();self.goal.tick()
                self.assertEqual(self.goal.status()[0]['reason'],'original_jobs_probe_unavailable')
                self.assertIsNone(self.goal.status()[0]['pending_id']);self.assertEqual(self.operator.posts,[])

    def test_saved_summary_requires_fresh_exact_idle_original_page_even_when_thinking_failed(self):
        self.saved_summary()
        for key,value in [('url','https://chatgpt.com/c/foreign'),('at',0),('historyAtLatest',False),
                          ('generating',True),('draft',True),('composing',True),('approvalRequired',True),
                          ('loginRequired',True),('error','unavailable'),('unknown',True)]:
            with self.subTest(key=key):
                self.write_observation(**{key:value});self.goal.state(self.page,'active','');self.goal.tick()
                self.assertEqual(self.operator.posts,[]);self.jobs_mock.assert_not_called()
        self.write_observation().unlink();self.goal.state(self.page,'active','');self.goal.tick()
        self.assertEqual(self.goal.status()[0]['state'],'active');self.jobs_mock.assert_not_called()

    def test_saved_summary_canonical_identity_uses_existing_unique_marker_formula(self):
        self.saved_summary()
        original='control_c56cafa1e64b4188b46ea94cbcfbf19a'
        expected='2c78f8e63c698a14a6dde08db1d3eba1eea0d24cb63b929059624ea788638dc1'
        self.assertEqual(hashlib.sha256(('managed-public:[CLW:'+original+']:user').encode()).hexdigest(),expected)
        with self.goal.db() as db:
            goal=dict(db.execute('SELECT * FROM managed_goals').fetchone())
            reason,artifact=self.goal.eligible(db,goal)
        self.assertEqual(reason,'');self.assertEqual(artifact['saved_summary']['identity_source'],'canonical_public_marker')
        self.assertEqual(artifact['saved_summary']['attempt_id'],self.attempt)
        self.assertEqual(artifact['saved_summary']['sent_user_hash'],self.sent_hash)
        self.goal.tick();self.assertEqual(len(self.operator.posts),1)

    def test_saved_summary_foreign_or_missing_current_turn_identity_never_submits(self):
        self.saved_summary()
        for key,value in [('userTurnHash','f'*64),('attemptId','control_'+'f'*32),
                          ('userTurnHash',None),('attemptId',None),('userTurnHash',''),('attemptId','')]:
            with self.subTest(key=key,value=value):
                self.write_observation(**{key:value});self.goal.state(self.page,'active','');self.goal.tick()
                self.assertEqual(self.operator.posts,[]);self.assertIsNone(self.goal.status()[0]['pending_id'])
                self.jobs_mock.assert_not_called()

    def test_saved_summary_original_failed_attempt_identity_cannot_be_missing_or_foreign(self):
        self.saved_summary()
        with self.goal.db() as db:
            row=db.execute("SELECT seq,data FROM events WHERE kind='control_browser_result_failed'").fetchone()
            saved=json.loads(row['data'])
        for attempt in (None,'control_'+'f'*32):
            with self.subTest(attempt=attempt):
                data={**saved,'attempt_id':attempt}
                with self.goal.db() as db:
                    db.execute('UPDATE events SET data=? WHERE seq=?',(json.dumps(data),row['seq']))
                    db.execute("UPDATE managed_goals SET state='active'")
                self.goal.tick();self.assertEqual(self.operator.posts,[]);self.jobs_mock.assert_not_called()
        with self.goal.db() as db:
            db.execute('UPDATE events SET data=? WHERE seq=?',(json.dumps(saved),row['seq']))
            db.execute("UPDATE control_attempts SET thread_id='foreign' WHERE id=?",(self.attempt,))
            db.execute("UPDATE managed_goals SET state='active'")
        self.goal.tick();self.assertEqual(self.operator.posts,[]);self.jobs_mock.assert_not_called()

    def test_saved_summary_noncanonical_identity_requires_and_can_use_durable_original_receipt(self):
        self.saved_summary();noncanonical='b'*64
        self.write_observation(userTurnHash=noncanonical);self.goal.tick()
        self.assertEqual(self.operator.posts,[]);self.jobs_mock.assert_not_called()
        with self.goal.db() as db:
            db.execute('INSERT INTO control_browser_receipts VALUES(?,?,?,?,?,?,NULL,NULL,NULL,NULL)',
                (self.attempt,self.request,self.thread,'original_claim_12345',noncanonical,'f'*64))
            db.execute("UPDATE managed_goals SET state='active'")
        self.goal.tick();self.assertEqual(len(self.operator.posts),1)

    def test_saved_summary_durable_identity_event_must_keep_original_attempt_and_authenticated_proof(self):
        self.saved_summary();noncanonical='b'*64
        with self.goal.db() as db:
            # The original schema sequence 5 predates this fixture's summary.
            # Replace its harmless thread-status event with a fixture of the
            # real authenticated reconcile-user event; no real ledger touched.
            row=db.execute("SELECT seq FROM events WHERE seq < (SELECT seq FROM events WHERE kind='team_final_summary') ORDER BY seq DESC LIMIT 1").fetchone()
            data={'request_id':self.request,'attempt_id':self.attempt,'previous_user_hash':'c'*64,
                  'user_hash':noncanonical,'proof':'unique_public_marker_and_terminal_failure','request_replayed':False}
            db.execute("UPDATE events SET thread_id=?,kind='managed_browser_identity_reconciled',data=? WHERE seq=?",
                       (self.thread,json.dumps(data),row['seq']))
            db.execute('UPDATE events SET data=? WHERE seq=?',
                       (json.dumps({**data,'proof':'unique_public_marker_attention_only'}),row['seq']))
        self.write_observation(userTurnHash=noncanonical);self.goal.tick()
        self.assertEqual(self.operator.posts,[]);self.jobs_mock.assert_not_called()
        with self.goal.db() as db:
            db.execute('UPDATE events SET data=? WHERE seq=?',(json.dumps(data),row['seq']))
            db.execute("UPDATE managed_goals SET state='active'")
        self.goal.tick()
        self.assertEqual(len(self.operator.posts),1)

    def test_saved_summary_browser_turn_identity_change_during_job_probe_wins(self):
        self.saved_summary()
        for observed in ({'userTurnHash':'f'*64},{'attemptId':'control_'+'f'*32},{'attemptId':None}):
            with self.subTest(observed=observed):
                self.write_observation();self.goal.state(self.page,'active','')
                def changed(root,name,args):
                    self.write_observation(**observed);return self.job_inventory()
                self.jobs_mock.side_effect=changed;self.goal.tick()
                self.assertEqual(self.operator.posts,[]);self.assertIsNone(self.goal.status()[0]['pending_id'])

    def test_saved_summary_pause_or_identity_change_during_job_observation_wins(self):
        self.saved_summary()
        def paused(root,name,args):
            with self.goal.db() as db:db.execute('UPDATE managed_pages SET paused=1')
            return self.job_inventory()
        self.jobs_mock.side_effect=paused;self.goal.tick()
        self.assertEqual(self.operator.posts,[]);self.assertIsNone(self.goal.status()[0]['pending_id'])
        with self.goal.db() as db:db.execute('UPDATE managed_pages SET paused=0')
        def changed(root,name,args):
            with self.goal.db() as db:db.execute("UPDATE managed_pages SET settings=json_set(settings,'$.account','other')")
            return self.job_inventory()
        self.jobs_mock.side_effect=changed;self.goal.tick()
        self.assertEqual(self.operator.posts,[]);self.assertEqual(self.goal.status()[0]['reason'],'identity_changed')

    def test_saved_summary_evidence_tamper_or_new_draft_during_job_observation_never_submits(self):
        path=self.saved_summary();raw=path.read_bytes()
        def tampered(root,name,args):
            path.write_text('changed',encoding='utf8');return self.job_inventory()
        self.jobs_mock.side_effect=tampered;self.goal.tick()
        self.assertEqual(self.operator.posts,[]);self.assertEqual(self.goal.status()[0]['reason'],'final_evidence_invalid')
        path.write_bytes(raw);self.goal.state(self.page,'active','')
        def draft(root,name,args):
            self.write_observation(draft=True);return self.job_inventory()
        self.jobs_mock.side_effect=draft;self.goal.tick()
        self.assertEqual(self.operator.posts,[]);self.assertIsNone(self.goal.status()[0]['pending_id'])
        self.assertEqual(self.goal.status()[0]['reason'],'original_page_busy')

    def test_saved_summary_goal_pause_during_job_observation_is_not_overwritten(self):
        self.saved_summary()
        def paused(root,name,args):
            self.goal.state(self.page,'paused','user stopped');return self.job_inventory()
        self.jobs_mock.side_effect=paused;self.goal.tick()
        self.assertEqual(self.operator.posts,[]);self.assertEqual(self.goal.status()[0]['state'],'paused')
        self.assertIsNone(self.goal.status()[0]['pending_id'])

    def test_lost_reply_reconciles_without_second_post(self):
        self.completed();self.operator.lose_reply=True;self.goal.tick()
        self.assertIsNotNone(self.goal.status()[0]['pending_id'])
        self.goal.tick();self.goal.tick()
        self.assertEqual(len(self.operator.posts),1)
        self.assertEqual(self.goal.status()[0]['cycles'],1)

    def test_restart_before_post_never_blindly_replays(self):
        self.completed()
        with self.goal.db() as db:db.execute("UPDATE managed_goals SET pending_id='saved_intent_no_receipt'")
        self.goal.tick();self.goal.tick()
        self.assertEqual(self.operator.posts,[])
        self.assertEqual(self.goal.status()[0]['reason'],'submission_unknown_no_replay')

    def test_pause_and_resume_preserve_original(self):
        self.completed()
        with self.goal.db() as db:db.execute('UPDATE managed_pages SET paused=1')
        self.goal.tick();self.assertEqual(self.operator.posts,[])
        with self.goal.db() as db:db.execute('UPDATE managed_pages SET paused=0')
        self.goal.tick();self.assertEqual(len(self.operator.posts),1)

    def test_operator_adopts_accepted_same_identity_request_after_settled_failure(self):
        self.completed('Prior full failure is retained.')
        with self.goal.db() as db:
            db.execute("UPDATE host_requests SET phase='blocked' WHERE id=?", (self.request,))
        self.goal.state(self.page, 'paused', 'user power off')
        new = 'authorized_manual_next_12345'
        self.service.command({'request_id':new,'action':'message.send','thread_id':self.thread,
                              'data':{'text':'Continue the existing complete research goal.'}})
        self.goal.adopt_request(self.page, self.request, new, 'Human requested resumption', 'Same complete goal; arrange collaboration autonomously.')
        self.goal.adopt_request(self.page, self.request, new, 'Human requested resumption', 'Same complete goal; arrange collaboration autonomously.')
        self.goal.tick()
        status = self.goal.status()[0]
        self.assertEqual((status['request_id'],status['state'],status['cycles']), (new,'active',0))
        self.assertEqual(self.operator.posts, [])
        with self.goal.db() as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?', (self.request,)).fetchone()[0], 'blocked')
            self.assertEqual(db.execute('SELECT objective FROM managed_goals WHERE page_id=?', (self.page,)).fetchone()[0], 'Same complete goal; arrange collaboration autonomously.')

    def test_adoption_waits_for_page_resume_without_clearing_retained_faults(self):
        self.completed('Original failure evidence is retained.')
        with self.goal.db() as db:
            db.execute("UPDATE host_requests SET phase='blocked' WHERE id=?", (self.request,))
        self.goal.state(self.page, 'paused', 'User authorized a new complete package')
        new = 'authorized_manual_ready_12345'
        self.service.command({'request_id':new,'action':'message.send','thread_id':self.thread,
                              'data':{'text':'Continue the original complete development goal.'}})
        blockers = (
            ("UPDATE managed_pages SET paused=1 WHERE page_id=?", (self.page,),
             "UPDATE managed_pages SET paused=0 WHERE page_id=?", (self.page,)),
            ("UPDATE managed_pages SET phase='unbound' WHERE page_id=?", (self.page,),
             "UPDATE managed_pages SET phase='bound' WHERE page_id=?", (self.page,)),
            ("UPDATE host_bindings SET enabled=0 WHERE thread_id=?", (self.thread,),
             "UPDATE host_bindings SET enabled=1 WHERE thread_id=?", (self.thread,)),
            ("INSERT INTO managed_page_issues VALUES(?,'login_required','Original login issue')", (self.page,),
             "DELETE FROM managed_page_issues WHERE page_id=?", (self.page,)),
            ("INSERT INTO managed_stops VALUES(?,'user','turn',0)", (self.page,),
             "DELETE FROM managed_stops WHERE page_id=?", (self.page,)),
            ("INSERT INTO managed_attention VALUES(?,'attempt','tool_failed')", (new,),
             "DELETE FROM managed_attention WHERE request_id=?", (new,)),
        )
        for add, args, remove, remove_args in blockers:
            with self.subTest(blocker=add):
                with self.goal.db() as db:
                    db.execute(add, args)
                    before = list(db.iterdump())
                with self.assertRaisesRegex(ValueError, 'goal_new_request_page_not_ready'):
                    self.goal.adopt_request(self.page, self.request, new, 'User requested resumption')
                self.goal.tick()
                with self.goal.db() as db:
                    self.assertEqual(list(db.iterdump()), before)
                    db.execute(remove, remove_args)
                self.assertEqual(self.operator.posts, [])
        # A normal resume clears the page-side blockers before adoption; the
        # accepted request is reused, and the old failure is never rewritten.
        self.goal.adopt_request(self.page, self.request, new, 'Page explicitly resumed')
        self.goal.tick()
        self.assertEqual((self.goal.status()[0]['request_id'], self.goal.status()[0]['state']), (new, 'active'))
        self.assertEqual(self.operator.posts, [])
        with self.goal.db() as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?', (self.request,)).fetchone()[0], 'blocked')

    def test_adoption_retry_after_new_page_pause_does_not_resume_or_mutate(self):
        self.completed()
        self.goal.state(self.page, 'paused', 'User requested resumption')
        new = 'authorized_manual_retry_12345'
        self.service.command({'request_id':new,'action':'message.send','thread_id':self.thread,
                              'data':{'text':'Continue the original complete goal.'}})
        with self.goal.db() as db:
            # The ledger timestamps have second precision; preserve the latest
            # insertion when both requests were accepted in the same second.
            db.execute('UPDATE host_requests SET created_at=(SELECT created_at FROM host_requests WHERE id=?) WHERE id=?', (self.request, new))
        self.goal.adopt_request(self.page, self.request, new, 'User requested resumption')
        with self.goal.db() as db:
            db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?', (self.page,))
            db.execute("INSERT INTO managed_stops VALUES(?,'new-user-stop','new-turn',0)", (self.page,))
            before = list(db.iterdump())
        self.goal.adopt_request(self.page, self.request, new, 'Retry same accepted transition')
        with self.goal.db() as db:
            self.assertEqual(list(db.iterdump()), before)
        self.assertEqual(self.operator.posts, [])

    def test_adoption_rejects_existing_cancel_intent_before_page_stop_arrives(self):
        self.completed()
        self.goal.state(self.page, 'paused', 'User requested resumption')
        new = 'authorized_manual_cancel_12345'
        self.service.command({'request_id':new,'action':'message.send','thread_id':self.thread,
                              'data':{'text':'Continue the original complete goal.'}})
        with self.goal.db() as db:
            db.execute("UPDATE host_requests SET phase='processing' WHERE id=?", (new,))
        self.service.command({'request_id':'host_stop_manual_cancel_12345','action':'host.pause',
                              'thread_id':self.thread,'data':{}})
        self.service.command({'request_id':'host_resume_manual_cancel_12345','action':'host.resume',
                              'thread_id':self.thread,'data':{}})
        with self.goal.db() as db:
            # Ordinary pause/resume only changes future admission. Seed an
            # existing explicit cancel intent to exercise adoption rejection.
            self.assertEqual(db.execute('SELECT cancel_requested FROM host_requests WHERE id=?', (new,)).fetchone()[0], 0)
            db.execute('UPDATE host_requests SET cancel_requested=1 WHERE id=?', (new,))
            self.assertEqual(db.execute('SELECT cancel_requested FROM host_requests WHERE id=?', (new,)).fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT paused FROM managed_pages WHERE page_id=?', (self.page,)).fetchone()[0], 0)
            self.assertIsNone(db.execute('SELECT 1 FROM managed_stops WHERE page_id=?', (self.page,)).fetchone())
            before = list(db.iterdump())
        with self.assertRaisesRegex(ValueError, 'goal_new_request_not_current'):
            self.goal.adopt_request(self.page, self.request, new, 'User requested resumption')
        with self.goal.db() as db:
            self.assertEqual(list(db.iterdump()), before)
        self.assertEqual(self.operator.posts, [])

    def test_adoption_never_discards_unknown_send_or_unsettled_original(self):
        self.goal.state(self.page, 'paused', 'Human requested resumption')
        with self.assertRaisesRegex(ValueError, 'goal_original_not_settled'):
            self.goal.adopt_request(self.page, self.request, 'new', 'Human requested resumption')
        with self.goal.db() as db: db.execute("UPDATE managed_goals SET pending_id='unknown_original'")
        with self.assertRaisesRegex(ValueError, 'goal_pending_original_send'):
            self.goal.adopt_request(self.page, self.request, 'new', 'Human requested resumption')

    def test_human_objective_steering_preserves_page_stop_and_goal_lifecycle(self):
        for state in ('active', 'paused', 'needs_attention'):
            with self.subTest(state=state):
                self.goal.state(self.page, state, 'Original lifecycle reason')
                with self.goal.db() as db:
                    db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?', (self.page,))
                    db.execute("INSERT OR REPLACE INTO managed_stops VALUES(?,'user-stop','turn',0)", (self.page,))
                    before = dict(db.execute('SELECT * FROM managed_goals WHERE page_id=?', (self.page,)).fetchone())
                    other_before = [line for line in db.iterdump() if not line.startswith('INSERT INTO "managed_goals"')]
                self.goal.update_objective(self.page, self.request, 'Updated human-selected complete goal.', 'Human corrected obstacle handling')
                with self.goal.db() as db:
                    after = dict(db.execute('SELECT * FROM managed_goals WHERE page_id=?', (self.page,)).fetchone())
                    self.assertEqual([line for line in db.iterdump() if not line.startswith('INSERT INTO "managed_goals"')], other_before)
                self.assertEqual(after['objective'], 'Updated human-selected complete goal.')
                for key in before.keys() - {'objective', 'reason', 'updated'}:
                    self.assertEqual(after[key], before[key], key)
                self.assertEqual(self.operator.posts, [])

    def test_human_objective_steering_rejects_stale_or_unknown_original(self):
        with self.goal.db() as db:
            before = list(db.iterdump())
        with self.assertRaisesRegex(ValueError, 'goal_original_changed'):
            self.goal.update_objective(self.page, 'stale_request', 'Updated complete goal.', 'Human steering')
        with self.goal.db() as db:
            self.assertEqual(list(db.iterdump()), before)
            db.execute("UPDATE managed_goals SET pending_id='unknown_original_send' WHERE page_id=?", (self.page,))
            unknown = list(db.iterdump())
        with self.assertRaisesRegex(ValueError, 'goal_pending_original_send'):
            self.goal.update_objective(self.page, self.request, 'Updated complete goal.', 'Human steering')
        with self.goal.db() as db:
            self.assertEqual(list(db.iterdump()), unknown)
        self.assertEqual(self.operator.posts, [])

    def test_adoption_rejects_changed_identity_and_noncurrent_request(self):
        self.completed()
        self.goal.state(self.page, 'paused', 'Human requested resumption')
        with self.assertRaisesRegex(ValueError, 'goal_new_request_not_current'):
            self.goal.adopt_request(self.page, self.request, 'not_a_request', 'Human requested resumption')
        with self.goal.db() as db: db.execute("UPDATE managed_pages SET model='changed'")
        with self.assertRaisesRegex(ValueError, 'goal_identity_changed'):
            self.goal.adopt_request(self.page, self.request, 'new', 'Human requested resumption')

    def test_attention_is_visible_even_when_page_automatically_paused(self):
        with self.goal.db() as db:
            db.execute('UPDATE managed_pages SET paused=1')
            db.execute('INSERT INTO managed_attention VALUES(?,?,?)',(self.request,'original_attempt','Original waiting call refused'))
        self.goal.tick()
        self.assertEqual(self.operator.posts,[])
        status=self.goal.status()[0]
        self.assertEqual(status['state'],'needs_attention')
        self.assertEqual(status['reason'],'request_needs_attention')

    def test_settled_terminal_failure_is_visible_without_attention_on_paused_page(self):
        self.completed()
        for phase in ('blocked','cancelled','failed'):
            for enabled in (0,1):
                with self.subTest(phase=phase,enabled=enabled):
                    with self.goal.db() as db:
                        db.execute('UPDATE host_requests SET phase=? WHERE id=?',(phase,self.request))
                        db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?',(self.page,))
                        db.execute('UPDATE host_bindings SET enabled=? WHERE thread_id=?',(enabled,self.thread))
                        db.execute("UPDATE managed_goals SET state='active',reason='' WHERE page_id=?",(self.page,))
                        self.assertIsNone(db.execute('SELECT 1 FROM managed_attention').fetchone())
                        self.assertIsNone(db.execute('SELECT 1 FROM managed_page_issues').fetchone())
                        original_request=dict(db.execute('SELECT * FROM host_requests WHERE id=?',(self.request,)).fetchone())
                        original_run=dict(db.execute('SELECT * FROM host_runs WHERE controller_request=?',(self.request,)).fetchone())
                    self.goal.tick();self.goal.tick()
                    status=self.goal.status()[0]
                    self.assertEqual((status['state'],status['reason']),('needs_attention','request_needs_attention'))
                    self.assertEqual((status['request_id'],status['pending_id'],status['cycles']),(self.request,None,0))
                    self.assertEqual(self.operator.posts,[]);self.jobs_mock.assert_not_called()
                    with self.goal.db() as db:
                        self.assertEqual(db.execute('SELECT paused FROM managed_pages WHERE page_id=?',(self.page,)).fetchone()[0],1)
                        self.assertEqual(db.execute('SELECT enabled FROM host_bindings WHERE thread_id=?',(self.thread,)).fetchone()[0],enabled)
                        self.assertEqual(dict(db.execute('SELECT * FROM host_requests WHERE id=?',(self.request,)).fetchone()),original_request)
                        self.assertEqual(dict(db.execute('SELECT * FROM host_runs WHERE controller_request=?',(self.request,)).fetchone()),original_run)

    def test_paused_page_does_not_hide_changed_latest_request_behind_original_failure(self):
        self.completed()
        manual='manual_new_request_98765'
        self.service.command({'request_id':manual,'action':'message.send','thread_id':self.thread,'data':{'text':'different user goal'}})
        with self.goal.db() as db:
            db.execute("UPDATE host_requests SET phase='blocked' WHERE id=?",(self.request,))
            db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?',(self.page,))
        self.goal.tick();self.goal.tick()
        status=self.goal.status()[0]
        self.assertEqual((status['state'],status['reason']),('needs_attention','manual_request_changed'))
        self.assertEqual((status['request_id'],status['pending_id'],status['cycles']),(self.request,None,0))
        self.assertEqual(self.operator.posts,[]);self.jobs_mock.assert_not_called()
        with self.goal.db() as db:
            self.assertEqual(db.execute('SELECT paused FROM managed_pages WHERE page_id=?',(self.page,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(self.request,)).fetchone()[0],'blocked')
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(manual,)).fetchone()[0],'queued')

    def test_explicit_goal_pause_is_preserved_despite_terminal_failure_and_page_pause(self):
        self.completed()
        with self.goal.db() as db:
            db.execute("UPDATE host_requests SET phase='failed' WHERE id=?",(self.request,))
            db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?',(self.page,))
        self.goal.state(self.page,'paused','user stopped')
        original=self.goal.status()[0]
        self.goal.tick();self.goal.tick()
        self.assertEqual(self.goal.status()[0],original)
        self.assertEqual(self.operator.posts,[]);self.jobs_mock.assert_not_called()
        with self.goal.db() as db:
            self.assertEqual(db.execute('SELECT paused FROM managed_pages WHERE page_id=?',(self.page,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(self.request,)).fetchone()[0],'failed')

    def test_login_or_quota_issue_is_not_passive_pause(self):
        with self.goal.db() as db:
            db.execute('UPDATE managed_pages SET paused=1')
            db.execute('INSERT INTO managed_page_issues VALUES(?,?,?)',(self.page,'usage_limit','Public quota limit'))
        self.goal.tick()
        self.assertEqual(self.operator.posts,[])
        self.assertEqual(self.goal.status()[0]['reason'],'page_needs_attention')

    def test_disabled_goal_and_offline_never_send(self):
        self.completed();self.goal.state(self.page,'paused','user')
        self.goal.tick();self.assertEqual(self.operator.posts,[])
        self.goal.state(self.page,'active','')
        with patch.object(self.goal,'health',return_value=False):self.goal.tick()
        self.assertEqual(self.operator.posts,[])

    def test_original_identity_change_stops_goal(self):
        self.completed()
        with self.goal.db() as db:db.execute("UPDATE managed_pages SET effort='medium'")
        self.goal.tick();self.assertEqual(self.operator.posts,[])
        self.assertEqual(self.goal.status()[0]['reason'],'identity_changed')

    def test_manual_new_request_not_adopted(self):
        self.completed()
        self.service.command({'request_id':'manual_new_request_98765','action':'message.send','thread_id':self.thread,'data':{'text':'different user goal'}})
        self.goal.tick();self.assertEqual(self.operator.posts,[])
        self.assertEqual(self.goal.status()[0]['reason'],'manual_request_changed')

    def test_explicit_block_or_stop_never_replayed(self):
        for phase in ('blocked','cancelled','failed'):
            with self.subTest(phase=phase):
                with self.goal.db() as db:
                    db.execute('UPDATE host_requests SET phase=? WHERE id=?',(phase,self.request))
                    db.execute("UPDATE managed_goals SET state='active'")
                self.goal.tick()
                self.assertEqual(self.operator.posts,[])
                self.assertEqual(self.goal.status()[0]['state'],'needs_attention')

    def test_proof_handoff_is_not_prize_complete(self):
        self.completed('Full candidate\nCLW_GOAL_STATUS: ready_for_review\n')
        self.goal.tick();self.assertEqual(self.operator.posts,[])
        self.assertEqual(self.goal.status()[0]['state'],'ready_for_review')
        with self.assertRaises(ValueError):self.goal.state(self.page,'complete','')

    def test_result_tamper_is_not_completion(self):
        path=self.completed();path.write_text('different',encoding='utf8')
        self.goal.tick();self.assertEqual(self.operator.posts,[])
        self.assertEqual(self.goal.status()[0]['reason'],'final_evidence_invalid')

    def test_text_goal_uses_verified_public_reply_without_turn_end_tool(self):
        self.completed()
        with self.goal.db() as db:
            db.execute("UPDATE managed_pages SET settings=json_set(settings,'$.collaboration_protocol','text_v1')")
            db.execute("UPDATE managed_artifacts SET id=?,source='public_dom_markdown'",('attempt-'+self.request,))
            db.execute('INSERT INTO managed_text_artifact_turns VALUES(?,?)',('attempt-'+self.request,'turn'))
        self.goal.tick()
        self.assertEqual(len(self.operator.posts),1)
        self.assertEqual(self.goal.status()[0]['cycles'],1)

    def test_text_reply_from_different_turn_cannot_advance_goal(self):
        self.completed()
        with self.goal.db() as db:
            db.execute("UPDATE managed_pages SET settings=json_set(settings,'$.collaboration_protocol','text_v1')")
            db.execute("UPDATE managed_artifacts SET id=?,source='public_dom_markdown'",('attempt-'+self.request,))
            db.execute('INSERT INTO managed_text_artifact_turns VALUES(?,?)',('attempt-'+self.request,'another turn'))
        self.goal.tick();self.assertEqual(self.operator.posts,[])
        self.assertEqual(self.goal.status()[0]['reason'],'final_evidence_invalid')

    def test_receipt_required_not_just_completed_label(self):
        self.completed()
        with self.goal.db() as db:db.execute('DELETE FROM control_browser_receipts')
        self.goal.tick();self.assertEqual(self.operator.posts,[])
        self.assertEqual(self.goal.status()[0]['reason'],'final_evidence_missing')

    def test_wrong_store_and_reenable_fail(self):
        with self.assertRaises(ValueError):self.goal.enable(self.page,'another goal')
        self.completed()
        with self.goal.db() as db:db.execute("UPDATE managed_goals SET store_id='other'")
        self.goal.tick();self.assertEqual(self.operator.posts,[])
        self.assertEqual(self.goal.status()[0]['reason'],'store_changed')


if __name__=='__main__':unittest.main()
