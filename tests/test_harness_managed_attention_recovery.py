"""Ended-turn recovery retains original ownership, evidence and stop semantics."""
from contextlib import closing
from pathlib import Path
import hashlib
import json
import sys
import unittest
from unittest.mock import patch

sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_harness_attention_reconcile as fixtures
import harness_managed_attention_recovery as recovery
from harness_state import HarnessError
from test_harness_control_plane import PAGE


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.ReconcileTests();self.f.setUp()
        self.h,self.m=self.f.h,self.f.m
        self.now=1000.;self.h.clock=lambda:self.now
        self.policy=patch.object(recovery,'ended_turn_recovery_authorized',return_value=True);self.policy.start()
    def tearDown(self):
        self.policy.stop();self.f.tearDown()
    def ended(self,missing=True,worker=False):
        page,request,offer,ctx=self.f.f.start_browser_turn()
        if worker:
            self.controller=page,request,offer,ctx
            child,_=self.f.f.enroll(page)
            assigned=self.f.a.team(page,'assign',{'run_id':ctx['run']['id'],'claim_id':ctx['request']['claim_id'],
                'target':child,'text':'Complete independent work','depends_on':[],'resources':[]})
            page,request=child,assigned['request_id']
            offer=self.f.f.wire(page,'pulse');self.f.f.wire(page,'dispatch',attempt_id=offer['attempt_id'])
            self.f.f.wire(page,'sent',attempt_id=offer['attempt_id'],assistant_before_hash='c'*64,
                page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True})
            ctx=self.f.f.private(page,'context',{})
        self.f.writer(ctx['request']['thread_id'],request)
        raw='Saved real progress. Continue remaining implementation and validation.'
        if missing:
            self.m.browser('artifact',{'page_id':page,'attempt_id':offer['attempt_id'],'text':raw,'assistant_turn_hash':'d'*64})
            self.f.f.wire(page,'result',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64},
                          assistant_turn_hash='d'*64,text=raw)
        else:
            self.f.a.finish(page,request,offer,ctx['request']['claim_id'],'needs_attention',raw)
        with closing(self.h.state.connect()) as db:
            url=db.execute('SELECT url FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0]
        self.p={'page_id':page,'attempt_id':offer['attempt_id'],'browser':{'page_id':page,'url':url,'at':self.now*1000,
            'attempt_id':offer['attempt_id'],'marker_count':1,'user_hash':'b'*64,'history_at_latest':True,
            'complete':True,'generating':False,'loginRequired':False,'approvalRequired':False,'draft':False,'composing':False}}
        self.ids=page,request,offer,ctx
        return self.ids
    def probe(self,session):
        # A second writer can acquire SQLite during external IO. No shared write lock is held.
        with closing(self.h.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE');db.rollback()
        self.assertEqual(session,self.f.f.sessions[self.p['page_id']])
        return {'structuredContent':{'success':True,'error':None,'output':{
            'jobs':[],'count':0,'matched_count':0,'truncated':False}}}
    def ready(self):
        self.assertEqual(recovery.recover(self.m,self.p,job_probe=self.probe)['state'],'backoff')
        self.now+=16;self.p['browser']['at']=self.now*1000
    def test_missing_management_ending_continues_original_goal_without_replaying_tools(self):
        page,request,offer,ctx=self.ended();self.ready()
        value=recovery.recover(self.m,self.p,job_probe=self.probe)
        self.assertEqual(value['state'],'recovered');self.assertEqual(value['model_sends'],0)
        self.assertEqual(value['original_result']['state'],'original_work_resumed')
        with closing(self.h.state.connect()) as db:
            r=db.execute('SELECT * FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual(r['phase'],'suspended');self.assertEqual(r['claim_id'],ctx['request']['claim_id'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertIsNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='host_turn_attention'").fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_reads').fetchone()[0],0)
        self.assertEqual(self.f.f.wire(page,'pulse')['state'],'offer')
    def test_authenticated_unresolved_turn_can_recover_with_original_result_kept(self):
        self.ended(missing=False);self.ready()
        self.assertEqual(recovery.recover(self.m,self.p,job_probe=self.probe)['state'],'recovered')
    def test_saved_dom_missing_worker_returns_blocked_result_without_new_turn_or_closing_parent(self):
        page,request,offer,ctx=self.ended(worker=True);self.ready()
        with closing(self.h.state.connect()) as db:
            before=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone())
            artifacts=[dict(x) for x in db.execute('SELECT * FROM managed_artifacts ORDER BY id')]
        value=recovery.recover(self.m,self.p,job_probe=self.probe)
        self.assertEqual(value['state'],'recovered');self.assertEqual(value['model_sends'],0)
        self.assertEqual(value['original_result']['state'],'blocked_result_collected')
        self.assertFalse(value['original_result']['task_completed'])
        with closing(self.h.state.connect()) as db:
            after=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone())
            self.assertEqual(after['state'],'running');self.assertEqual(after['dispatches'],before['dispatches'])
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'blocked')
            self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0],ctx['request']['claim_id'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertIsNone(db.execute('SELECT 1 FROM managed_turn_outcomes WHERE attempt_id=?',(offer['attempt_id'],)).fetchone())
            self.assertIsNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_reads').fetchone()[0],0)
            self.assertEqual([dict(x) for x in db.execute('SELECT * FROM managed_artifacts ORDER BY id')],artifacts)
        with self.assertRaisesRegex(HarnessError,'managed_page_not_ready'):
            self.f.f.wire(page,'pulse')
        parent,parent_request,_,parent_ctx=self.controller
        result=self.f.a.team(parent,'result',{'run_id':ctx['run']['id'],'request_id':request})
        self.assertEqual(result['phase'],'blocked')
    def test_missing_worker_can_collect_after_budget_expiry_draining_or_controller_summary(self):
        for state,reason in [('running',''),('draining','turn_budget'),('closed','controller_summary')]:
            with self.subTest(state=state):
                page,request,offer,ctx=self.ended(worker=True)
                with closing(self.h.state.connect()) as db:
                    db.execute('UPDATE host_runs SET state=?,reason=?,deadline=?,dispatches=max_dispatches WHERE id=?',
                               (state,reason,self.now-1,ctx['run']['id']));db.commit()
                self.ready()
                value=recovery.recover(self.m,self.p,job_probe=self.probe)
                self.assertEqual(value['original_result']['state'],'blocked_result_collected')
                with closing(self.h.state.connect()) as db:
                    run=db.execute('SELECT * FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone()
                    self.assertEqual(run['state'],state);self.assertEqual(run['reason'],reason)
                    self.assertEqual(run['dispatches'],run['max_dispatches'])
                    self.assertEqual(run['deadline'],self.now-17)
    def test_real_worker_attention_continues_instead_of_settling(self):
        page,request,offer,ctx=self.ended(missing=False,worker=True);self.ready()
        value=recovery.recover(self.m,self.p,job_probe=self.probe)
        self.assertEqual(value['original_result']['state'],'original_work_resumed')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'suspended')
            self.assertEqual(db.execute('SELECT paused FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0],0)
    def test_worker_unread_user_instruction_prevents_result_only_settlement(self):
        page,request,offer,ctx=self.ended(worker=True)
        with closing(self.h.state.connect()) as db:
            db.execute('INSERT INTO host_notes VALUES(?,?,?,?)',('late-note',request,'User correction','now'))
            db.execute('INSERT INTO host_unread_notes VALUES(?,?)',('late-note',request))
            db.execute('UPDATE host_runs SET dispatches=max_dispatches WHERE id=?',(ctx['run']['id'],));db.commit()
        self.assertEqual(recovery.recover(self.m,self.p,job_probe=self.probe)['state'],'recovery_not_eligible')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'processing')
            self.assertIsNotNone(db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',(request,)).fetchone())
    def test_worker_recovery_receipt_survives_lost_return_and_restart_once(self):
        page,request,offer,ctx=self.ended(worker=True);self.ready()
        original=self.h.team.public_command
        def lost(*args,**kwargs):
            original(*args,**kwargs);raise OSError('return lost after commit')
        with patch.object(self.h.team,'public_command',side_effect=lost):
            self.assertEqual(recovery.recover(self.m,self.p,job_probe=self.probe)['state'],'recovered')
        from harness_managed import ManagedPages
        restarted=ManagedPages(self.h)
        probe=unittest.mock.Mock(side_effect=AssertionError('no replay'))
        value=recovery.recover(restarted,self.p,job_probe=probe)
        self.assertEqual(value['original_result']['state'],'blocked_result_collected');probe.assert_not_called()
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_ended_recoveries WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM host_team_receipts WHERE operation='reconcile-attention'").fetchone()[0],1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_ended_execution_reconciled'").fetchone()[0],1)
    def preserves_worker_fault(self,fault):
        page,request,offer,ctx=self.ended(worker=True);self.ready()
        if fault=='pause':self.m.browser('pause',{'page_id':page,'paused':True})
        if fault=='stop':
            with closing(self.h.state.connect()) as db:
                db.execute('INSERT INTO managed_stops VALUES(?,?,?,0)',(page,'b'*64,'d'*64));db.commit()
        if fault=='changed_artifact':
            with closing(self.h.state.connect()) as db:
                path=db.execute('SELECT path FROM managed_artifacts WHERE id=?',(offer['attempt_id'],)).fetchone()[0]
            Path(path).write_text('Changed saved result',encoding='utf-8')
        probe=self.probe
        if fault=='unknown_job':
            probe=lambda session:{'structuredContent':{'success':True,'error':None,'output':{
                'jobs':[{'id':'original-job','session_id':session,'status':'failed','command_execution_state':'unknown'}],
                'count':1,'matched_count':1,'truncated':False}}}
        value=recovery.recover(self.m,self.p,job_probe=probe)
        self.assertNotEqual(value['state'],'recovered');self.assertEqual(value['model_sends'],0)
        if fault=='unknown_job':self.assertEqual(value['reason'],'attention_original_jobs_not_idle')
        if fault=='changed_artifact':self.assertEqual(value['reason'],'managed_result_file_changed')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'processing')
            self.assertIsNotNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())
    def test_worker_user_pause_preserves_original_work(self):self.preserves_worker_fault('pause')
    def test_worker_user_stop_preserves_original_work(self):self.preserves_worker_fault('stop')
    def test_worker_unknown_job_preserves_original_work(self):self.preserves_worker_fault('unknown_job')
    def test_worker_changed_artifact_preserves_original_work(self):self.preserves_worker_fault('changed_artifact')
    def test_managed_failure_dispatch_uses_short_prompt_actual_connector_and_original_context_ack(self):
        from harness_recovery import CONTINUATION_SENTENCE
        for account in ('A','B'):
            with self.subTest(account=account):
                page,request,offer,ctx=self.f.f.start_browser_turn()
                with closing(self.h.state.connect()) as db:
                    settings=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0])
                    settings['account']=account
                    db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(json.dumps(settings),page))
                    db.execute('INSERT INTO host_notes VALUES(?,?,?,?)',('late-'+account,request,'New user correction','now'))
                    db.execute('INSERT INTO host_unread_notes VALUES(?,?)',('late-'+account,request));db.commit()
                failed={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,
                        'failure_kind':'generation_failed','failure_hash':'e'*64}
                value=self.f.f.wire(page,'pulse',page=failed)
                self.assertEqual(value['state'],'browser_result_failed_recovery_pending')
                with closing(self.h.state.connect()) as db:
                    self.now=db.execute('SELECT due FROM control_recoveries WHERE request_id=?',(request,)).fetchone()[0]
                continuation=self.f.f.wire(page,'pulse',page=failed)
                self.assertTrue(continuation['recovery']);self.assertEqual(continuation['request_id'],request)
                prompt=self.f.f.wire(page,'dispatch',attempt_id=continuation['attempt_id'],page=failed)['prompt']
                self.assertTrue(prompt.startswith(CONTINUATION_SENTENCE))
                self.assertIn('@Local-MCP'+('-B' if account=='B' else '')+'\n',prompt)
                self.assertIn('--attempt-id '+continuation['attempt_id'],prompt)
                self.assertNotIn('--- 原始目标 ---',prompt);self.assertNotIn(ctx['request']['text'],prompt)
                self.assertNotIn('MANAGED_WEB.md',prompt);self.assertLess(len(prompt),800)
                self.m.browser('prepare',{'page_id':page,'attempt_id':continuation['attempt_id'],
                    'assistant_before_hash':'d'*64,'prompt_hash':hashlib.sha256(prompt.encode()).hexdigest()})
                context=self.f.f.private(page,'context',{'attempt_id':continuation['attempt_id']})
                self.assertEqual(context['request']['id'],request)
                self.assertEqual(context['request']['claim_id'],ctx['request']['claim_id'])
                self.assertEqual(context['run']['id'],ctx['run']['id'])
                self.assertEqual(context['additional_instructions'][-1]['text'],'New user correction')
    def test_normal_managed_dispatch_includes_shared_substantial_work_package_guidance(self):
        from harness_work_package import WORK_PACKAGE_GUIDANCE
        page,binding=self.f.f.enroll()
        target='Complete the approved character, animation and mechanism batches.'
        request=self.f.f.f.command(binding['thread_id'],'message.send',{'text':target})['request_id']
        offer=self.f.f.wire(page,'pulse')
        prompt=self.f.f.wire(page,'dispatch',attempt_id=offer['attempt_id'])['prompt']
        self.assertEqual(prompt.count(WORK_PACKAGE_GUIDANCE),1)
        self.assertIn(target,prompt)
    def test_backoff_does_not_probe_or_send_models(self):
        self.ended();probe=unittest.mock.Mock(side_effect=AssertionError('not due'))
        for _ in range(3):self.assertEqual(recovery.recover(self.m,self.p,job_probe=probe)['state'],'backoff')
        probe.assert_not_called()
    def test_stops_permission_pages_and_unknown_execution_do_not_recover(self):
        page,request,offer,ctx=self.ended()
        for flag,value in [('draft',True),('composing',True),('generating',True),('approvalRequired',True),('loginRequired',True),
                           ('history_at_latest',False),('user_hash','f'*64),('marker_count',2),('at',0)]:
            with self.subTest(flag=flag):
                old=self.p['browser'][flag];self.p['browser'][flag]=value
                self.assertEqual(recovery.recover(self.m,self.p,job_probe=self.probe)['state'],'recovery_not_eligible')
                self.p['browser'][flag]=old
        with closing(self.h.state.connect()) as db:
            db.execute("INSERT INTO operations VALUES('unknown-original','fp','command.run',?,'unknown',NULL,'now')",(ctx['request']['thread_id'],));db.commit()
        self.assertEqual(recovery.recover(self.m,self.p,job_probe=self.probe)['state'],'recovery_not_eligible')
        with closing(self.h.state.connect()) as db:
            db.execute("DELETE FROM operations WHERE id='unknown-original'");db.commit()
        self.m.browser('pause',{'page_id':page,'paused':True})
        self.assertEqual(recovery.recover(self.m,self.p,job_probe=self.probe)['state'],'recovery_not_eligible')
    def test_expired_budget_preserves_ended_writer(self):
        page,request,offer,ctx=self.ended()
        with closing(self.h.state.connect()) as db:
            db.execute('UPDATE host_runs SET deadline=? WHERE id=?',(self.now-1,ctx['run']['id']));db.commit()
        self.assertEqual(recovery.recover(self.m,self.p,job_probe=self.probe)['state'],'recovery_not_eligible')
        with closing(self.h.state.connect()) as db:self.assertIsNotNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())
    def test_three_failed_probes_stop_without_mutating_original_work(self):
        page,request,offer,ctx=self.ended();self.ready()
        probe=unittest.mock.Mock(side_effect=OSError('transport unavailable'))
        for seconds,state in [(0,'backoff'),(46,'backoff'),(121,'exhausted')]:
            self.now+=seconds;self.p['browser']['at']=self.now*1000
            self.assertEqual(recovery.recover(self.m,self.p,job_probe=probe)['state'],state)
        self.now+=200;self.p['browser']['at']=self.now*1000
        self.assertEqual(recovery.recover(self.m,self.p,job_probe=probe)['state'],'exhausted');self.assertEqual(probe.call_count,3)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'processing')
            self.assertIsNotNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())

    def test_original_runtime_identity_fault_is_durable_backoff_and_can_recover(self):
        page,request,offer,ctx=self.ended();self.ready()
        failed=unittest.mock.Mock(side_effect=recovery.AdmissionError('local_runtime_identity_changed'))
        result=recovery.recover(self.m,self.p,job_probe=failed)
        self.assertEqual((result['state'],result['reason']),('backoff','local_runtime_identity_changed'))
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0],ctx['request']['claim_id'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
        self.now+=46;self.p['browser']['at']=self.now*1000
        self.assertEqual(recovery.recover(self.m,self.p,job_probe=self.probe)['state'],'recovered')
    def test_lost_return_recovers_original_commit_once_without_second_probe(self):
        self.ended();self.ready()
        self.assertEqual(recovery.recover(self.m,self.p,job_probe=self.probe)['state'],'recovered')
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE managed_ended_recoveries SET state='probing'");db.commit()
        probe=unittest.mock.Mock(side_effect=AssertionError('no replay'))
        self.assertEqual(recovery.recover(self.m,self.p,job_probe=probe)['state'],'recovered');probe.assert_not_called()
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_ended_execution_reconciled'").fetchone()[0],1)
    def test_running_foreign_or_truncated_job_inventory_preserves_pause(self):
        self.ended();self.ready()
        for jobs in [dict(jobs=[{'session_id':'foreign','status':'completed','command_execution_state':'completed'}],count=1,matched_count=1,truncated=False),
                     dict(jobs=[],count=0,matched_count=0,truncated=True)]:
            self.p['browser']['at']=self.now*1000
            r=recovery.recover(self.m,self.p,job_probe=lambda s:{'structuredContent':{'success':True,'error':None,'output':jobs}})
            self.assertEqual(r['reason'],'attention_original_jobs_not_idle');self.now+=121
    def test_original_running_job_is_program_wait_not_failed_retry_or_new_execution(self):
        self.ended();self.ready()
        result={'structuredContent':{'success':True,'error':None,'output':{'jobs':[
            {'session_id':self.f.f.sessions[self.p['page_id']],'status':'running','command_execution_state':'running'}],
            'count':1,'matched_count':1,'truncated':False}}}
        for _ in range(4):
            self.p['browser']['at']=self.now*1000
            self.assertEqual(recovery.recover(self.m,self.p,job_probe=lambda s:result)['state'],'waiting_jobs');self.now+=46
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute('SELECT tries FROM managed_ended_recoveries').fetchone()[0],0)
        self.p['browser']['at']=self.now*1000
        self.assertEqual(recovery.recover(self.m,self.p,job_probe=self.probe)['state'],'recovered')
    def test_user_pause_during_probe_wins_over_old_idle_observation(self):
        page,request,offer,ctx=self.ended();self.ready()
        def probe(session):
            result=self.probe(session);self.m.browser('pause',{'page_id':page,'paused':True});return result
        self.assertEqual(recovery.recover(self.m,self.p,job_probe=probe)['reason'],'attention_explicit_stop_preserved')
    def test_disabled_owner_recovery_policy_never_probes(self):
        self.ended()
        with patch.object(recovery,'ended_turn_recovery_authorized',return_value=False):
            self.assertEqual(recovery.recover(self.m,self.p,job_probe=lambda _:self.fail('probe'))['state'],'recovery_not_authorized')


if __name__=='__main__':unittest.main()
