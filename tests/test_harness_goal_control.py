"""Human goal/review/next-package protocol through real isolated ledgers.

No production profiles, browser, network, or model calls. These tests exercise
authority and recovery rather than merely checking the UI's labels.
"""
from contextlib import closing
from pathlib import Path
import json, sys, unittest, uuid
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
from harness_state import HarnessError
from harness_managed import ManagedPages
from harness_goal_watch import Goals
import test_harness_managed_budget as fixtures


class HumanGoalTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.BudgetTests();self.f.setUp()
        self.h=self.f.h;self.m=self.f.m;self.service=self.f.f.f.s
        self.page,self.request,self.offer,self.ctx=self.f.f.start_browser_turn()
        self.thread=self.ctx['request']['thread_id'];self.run=self.ctx['run']['id']
    def tearDown(self):self.f.tearDown()
    def goal(self):return self.m.browser('goal-read',{'page_id':self.page})['goal']
    def fields(self,**extra):
        g=self.goal()
        return {'page_id':self.page,'operation_id':str(uuid.uuid4()),'expected_etag':g['etag'],
                'expected_goal_request_id':g['request_id'],**extra}
    def save(self,objective='Deliver a tested product with clear acceptance criteria.'):
        return self.m.browser('goal-save',self.fields(objective=objective))
    def close(self):self.f.close(self.page,self.request,self.offer,self.ctx)
    def review(self,decision='continue',note='The original result is accepted. Continue the remaining goal.'):
        return self.m.browser('goal-review',self.fields(decision=decision,note=note))
    def prepare(self,instructions='Finish remaining delivery and verify recovery.'):
        return self.m.browser('goal-next',self.fields(expected_run_id=self.run,instructions=instructions))
    def ready(self):
        self.save();self.close();self.review();self.f.refill(self.page,sends=5,seconds=3600)
    def send(self,intent):
        return self.service.command({'request_id':intent['operation_id'],'action':'message.send',
            'thread_id':self.thread,'data':{'text':intent['objective']}})
    def rejected(self,result,code):
        self.assertEqual(result['state'],'rejected',result)
        self.assertFalse(result['unknown']);self.assertEqual(result['code'],code,result)
    def row(self,table,where,values):
        with closing(self.h.state.connect()) as db:
            row=db.execute('SELECT * FROM '+table+' WHERE '+where,values).fetchone()
            return dict(row) if row else None
    def mutate(self,sql,args=()):
        with closing(self.h.state.connect()) as db:db.execute(sql,args);db.commit()
    def watcher(self):
        w=Goals.__new__(Goals);w.root=self.f.f.f.root;w.path=self.h.state.path
        class NoOperator:
            def request(self,*a,**k):raise AssertionError('manual goals must never contact operator')
        w.operator=NoOperator()
        return w

    def test_save_keeps_active_execution_and_budget_paused_manual_metadata_only(self):
        before=self.row('host_requests','id=?',(self.request,));run=self.f.runrow(self.run)
        result=self.save();g=result['goal']
        self.assertEqual((g['mode'],g['state'],g['request_id']),('manual','paused',self.request))
        self.assertEqual(result['model_sends'],0)
        self.assertEqual(before,self.row('host_requests','id=?',(self.request,)))
        self.assertEqual(run,self.f.runrow(self.run));self.assertFalse(g['can_review'])
        self.watcher().tick()
    def test_save_replays_same_operation_after_restart_without_revision_or_quota_change(self):
        payload=self.fields(objective='Original human goal');first=self.m.browser('goal-save',payload)
        self.h.managed=ManagedPages(self.h);self.m=self.h.managed
        again=self.m.browser('goal-save',payload)
        self.assertTrue(again['replayed']);self.assertEqual(first['goal'],again['goal'])
        self.assertEqual(self.goal()['revision'],1)
        with self.assertRaisesRegex(HarnessError,'operation_conflict'):
            self.m.browser('goal-save',{**payload,'objective':'Different goal'})
    def test_stale_goal_or_request_is_rejected_without_overwrite(self):
        stale=self.fields(objective='Stale');self.save('Fresh')
        with self.assertRaisesRegex(HarnessError,'goal_changed'):self.m.browser('goal-save',stale)
        with self.assertRaisesRegex(HarnessError,'request_changed'):
            self.m.browser('goal-save',self.fields(objective='Other',expected_goal_request_id='foreign'))
        self.assertEqual(self.goal()['objective'],'Fresh')
    def test_worker_and_model_tools_cannot_set_goal_or_human_review(self):
        child,_=self.f.f.enroll(self.page)
        with self.assertRaisesRegex(HarnessError,'controller_required'):
            self.m.browser('goal-read',{'page_id':child})
        with self.assertRaisesRegex(ValueError,'managed_operation_unknown'):
            self.f.f.private(self.page,'goal-save',self.fields(objective='Model-selected goal'))
        self.assertFalse(self.goal()['configured'])
    def test_active_request_cannot_be_reviewed(self):
        self.save()
        with self.assertRaisesRegex(HarnessError,'not_settled'):self.review()
        self.assertIsNone(self.goal()['review'])
    def test_review_preserves_original_result_budget_errors_and_no_model_send(self):
        self.save();self.close();run=self.f.runrow(self.run)
        r=self.review();g=r['goal']
        self.assertEqual(r['model_sends'],0);self.assertEqual(g['review']['actor'],'human')
        self.assertFalse(g['review']['external_jobs_verified'])
        self.assertEqual(g['state'],'paused');self.assertEqual(run,self.f.runrow(self.run))
        self.assertFalse(g['can_start_next'])
    def test_complete_stops_next_package_and_remains_durable(self):
        self.save();self.close();self.review('complete','All goal criteria accepted by user.')
        self.f.refill(self.page,sends=2,seconds=1000)
        with self.assertRaisesRegex(HarnessError,'human_review_required'):self.prepare()
        self.watcher().tick();self.assertEqual(self.goal()['state'],'complete')
    def test_reviseenforces_new_review_before_start(self):
        self.save();self.close();self.review('revise','Needs changes before accepting.')
        self.f.refill(self.page,sends=2,seconds=1000)
        with self.assertRaisesRegex(HarnessError,'human_review_required'):self.prepare()
    def test_review_requires_original_registered_artifact_not_just_terminal_status(self):
        self.save();self.close()
        self.mutate('DELETE FROM managed_artifacts WHERE request_id=?',(self.request,))
        with self.assertRaisesRegex(HarnessError,'original_result_unavailable'):self.review()
    def test_review_rejects_modified_artifact_and_external_path(self):
        self.save();self.close()
        a=self.row('managed_artifacts','request_id=?',(self.request,));path=Path(a['path'])
        raw=path.read_bytes();path.write_bytes(raw+b'changed')
        with self.assertRaisesRegex(HarnessError,'original_result_unavailable'):self.review()
        path.write_bytes(raw)
        self.mutate('UPDATE managed_artifacts SET path=? WHERE request_id=?',
                    (str(self.f.f.f.root/'outside.md'),self.request))
        with self.assertRaisesRegex(HarnessError,'original_result_unavailable'):self.review()
    def test_next_requires_explicit_saved_quota_and_does_not_send(self):
        self.save();self.close();self.review()
        with self.assertRaisesRegex(HarnessError,'continuation_not_ready'):self.prepare()
        self.f.refill(self.page,sends=3,seconds=3600)
        r=self.prepare();self.assertEqual(r['state'],'goal_next_prepared');self.assertEqual(r['model_sends'],0)
        self.assertEqual(self.goal()['pending_id'],r['operation_id'])
        self.assertEqual(self.row('host_requests','id=?',(self.request,))['phase'],'completed')
        self.assertIsNone(self.row('host_requests','id=?',(r['operation_id'],)))
    def test_prepared_next_recovery_keeps_exact_original_key_and_full_text(self):
        self.ready();payload=self.fields(expected_run_id=self.run,instructions='Original instructions')
        r=self.m.browser('goal-next',payload)
        self.h.managed=ManagedPages(self.h);self.m=self.h.managed
        recovered=self.goal()['next'];self.assertEqual(recovered['operation_id'],r['operation_id'])
        self.assertEqual(recovered['objective'],r['objective'])
        self.assertTrue(self.m.browser('goal-next',payload)['replayed'])
        with self.assertRaisesRegex(HarnessError,'pending_original_send'):self.save('Do not overwrite intent')
        with self.assertRaisesRegex(HarnessError,'pending_original_send'):self.prepare('New key forbidden')
    def test_accepted_send_binds_goal_atomic_and_replay_creates_only_one_request(self):
        self.ready();intent=self.prepare();result=self.send(intent)
        self.assertEqual(result['request_id'],intent['operation_id'])
        g=self.goal();self.assertEqual((g['request_id'],g['pending_id'],g['cycles'],g['state']),
                                     (intent['operation_id'],None,1,'paused'))
        self.assertIsNone(g['review']);self.assertEqual(self.send(intent),result)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM host_requests WHERE id=?',(intent['operation_id'],)).fetchone()[0],1)
        self.watcher().tick()
    def test_generic_start_cannot_bypass_manual_review(self):
        self.save();self.close()
        self.rejected(self.service.command({'request_id':str(uuid.uuid4()),'action':'message.send',
                'thread_id':self.thread,'data':{'text':'Bypass review'}}),'managed_goal_human_review_required')
        self.assertEqual(self.goal()['request_id'],self.request)
    def test_changed_text_at_actual_send_is_refused_without_binding(self):
        self.ready();intent=self.prepare()
        self.rejected(self.service.command({'request_id':intent['operation_id'],'action':'message.send',
                'thread_id':self.thread,'data':{'text':intent['objective']+'tamper'}}),'managed_goal_prepared_text_changed')
        self.assertEqual(self.goal()['pending_id'],intent['operation_id'])
    def test_artifact_change_between_prepare_and_send_is_refused(self):
        self.ready();intent=self.prepare()
        path=Path(self.goal()['review']['artifact']['path']);path.write_text('replaced',encoding='utf8')
        self.rejected(self.send(intent),'managed_goal_original_result_unavailable')
        self.assertEqual(self.goal()['request_id'],self.request)
        self.assertIsNone(self.row('host_requests','id=?',(intent['operation_id'],)))
    def test_request_or_session_change_at_actual_send_is_refused(self):
        self.ready();intent=self.prepare()
        b=self.row('host_bindings','thread_id=?',(self.thread,));spec=json.loads(b['spec']);spec['session_id']='wc_sess_other'
        self.mutate('UPDATE host_bindings SET spec=? WHERE thread_id=?',(json.dumps(spec),self.thread))
        self.rejected(self.send(intent),'managed_goal_changed')
        self.assertIsNone(self.row('host_requests','id=?',(intent['operation_id'],)))
    def test_unresolved_other_operation_is_preserved_and_blocks_next(self):
        self.ready();intent=self.prepare();other=str(uuid.uuid4())
        self.service.state.begin(other,{'request_id':other,'action':'message.send','thread_id':self.thread,'data':{'text':'unknown'}})
        self.rejected(self.send(intent),'workspace_busy_or_unreconciled')
        self.assertEqual(self.row('operations','id=?',(other,))['state'],'reserved')
        self.assertIsNone(self.row('host_requests','id=?',(intent['operation_id'],)))
    def test_combined_next_text_rejects_oversize_instead_of_silent_truncation(self):
        self.save('x'*18000);self.close();self.review();self.f.refill(self.page,sends=2,seconds=1000)
        with self.assertRaisesRegex(HarnessError,'text_too_long'):self.prepare('y'*11000)
        self.assertIsNone(self.goal()['pending_id'])
    def test_human_goal_identity_changed_requires_original_account_and_session(self):
        self.save()
        page=self.row('managed_pages','page_id=?',(self.page,));settings=json.loads(page['settings']);settings['account']='A' if settings.get('account')!='A' else 'B'
        self.mutate('UPDATE managed_pages SET settings=? WHERE page_id=?',(json.dumps(settings),self.page))
        with self.assertRaisesRegex(HarnessError,'identity_changed'):self.save('Change without original account forbidden')

    def discard(self):
        return self.m.browser('goal-discard',self.fields(expected_pending_id=self.goal()['pending_id']))
    def test_unsent_preparation_can_be_discarded_and_late_send_is_refused(self):
        self.ready();intent=self.prepare();payload=self.fields(expected_pending_id=intent['operation_id'])
        result=self.m.browser('goal-discard',payload)
        self.assertEqual(result['state'],'goal_next_discarded');self.assertEqual(result['model_sends'],0)
        self.assertTrue(self.m.browser('goal-discard',payload)['replayed'])
        self.assertIsNone(self.goal()['pending_id']);self.assertIsNotNone(self.goal()['review'])
        self.rejected(self.send(intent),'managed_goal_prepared_intent_discarded')
        new=self.prepare();self.assertNotEqual(new['operation_id'],intent['operation_id'])
        self.assertEqual(self.send(new)['request_id'],new['operation_id'])
    def test_definitive_rejection_can_be_discarded_but_old_error_is_preserved(self):
        self.ready();intent=self.prepare();self.mutate('UPDATE host_bindings SET enabled=0 WHERE thread_id=?',(self.thread,))
        rejected=self.send(intent);self.rejected(rejected,'host_paused')
        self.assertTrue(self.goal()['next_recovery']['can_discard']);self.discard()
        self.assertEqual(self.service.receipt(intent['operation_id'])['result'],rejected)
        self.assertIsNone(self.goal()['pending_id']);self.assertEqual(self.goal()['state'],'paused')
    def test_unknown_or_reserved_original_send_cannot_be_discarded(self):
        self.ready();intent=self.prepare()
        command={'request_id':intent['operation_id'],'action':'message.send','thread_id':self.thread,'data':{'text':intent['objective']}}
        self.service.state.begin(intent['operation_id'],command)
        for state in ('reserved','dispatching','unknown','completed'):
            self.service.state.operation(intent['operation_id'],state)
            self.assertFalse(self.goal()['next_recovery']['can_discard'])
            with self.assertRaisesRegex(HarnessError,'original_send_unresolved'):self.discard()
        self.assertEqual(self.goal()['pending_id'],intent['operation_id'])
    def test_manual_goal_cannot_be_resumed_by_legacy_watcher_command(self):
        self.save()
        with self.assertRaisesRegex(ValueError,'manual_goal_requires'):self.watcher().state(self.page,'active','')
        self.mutate("UPDATE managed_goals SET state='active' WHERE page_id=?",(self.page,))
        self.watcher().tick()
        self.assertIsNone(self.goal()['pending_id'])
    def test_explicit_discard_before_prepare_revokes_delayed_original_prepare(self):
        self.ready();payload=self.fields(expected_run_id=self.run,instructions='Delayed preparation')
        cancelled=self.m.browser('goal-discard',self.fields(expected_pending_id=payload['operation_id']))
        self.assertEqual(cancelled['state'],'goal_next_discarded')
        # Replay cannot resurrect a key even if the caller refreshes its goal etag.
        with self.assertRaisesRegex(HarnessError,'intent_discarded'):
            self.m.browser('goal-next',{**payload,'expected_etag':self.goal()['etag']})
        self.assertIsNone(self.goal()['pending_id']);self.assertIsNotNone(self.goal()['review'])
    def test_discard_cannot_revoke_other_goal_metadata_operation(self):
        payload=self.fields(objective='Human original');self.m.browser('goal-save',payload)
        with self.assertRaisesRegex(HarnessError,'pending_changed'):
            self.m.browser('goal-discard',self.fields(expected_pending_id=payload['operation_id']))
    def test_store_change_refuses_review_and_send_even_with_same_page_session(self):
        self.ready();intent=self.prepare();self.mutate("UPDATE metadata SET value='different-store' WHERE key='id'")
        self.assertFalse(self.goal()['identity_valid'])
        self.rejected(self.send(intent),'managed_goal_store_changed')
    def test_text_result_requires_exact_public_turn_identity_and_source(self):
        self.save();self.close()
        page=self.row('managed_pages','page_id=?',(self.page,));settings=json.loads(page['settings']);settings['collaboration_protocol']='text_v1'
        self.mutate('UPDATE managed_pages SET settings=? WHERE page_id=?',(json.dumps(settings),self.page))
        receipt=self.row('control_browser_receipts','request_id=?',(self.request,))
        self.mutate("UPDATE managed_artifacts SET id=?,source='public_dom_markdown' WHERE request_id=?",
                    (receipt['attempt_id'],self.request))
        with self.assertRaisesRegex(HarnessError,'original_result_unavailable'):self.review()
        self.mutate('INSERT INTO managed_text_artifact_turns VALUES(?,?)',(receipt['attempt_id'],'wrong'))
        with self.assertRaisesRegex(HarnessError,'original_result_unavailable'):self.review()
        self.mutate('UPDATE managed_text_artifact_turns SET assistant_turn_hash=? WHERE attempt_id=?',
                    (receipt['result_turn_hash'],receipt['attempt_id']))
        self.assertEqual(self.review()['goal']['review']['artifact']['source'],'public_dom_markdown')

    def stop_goal(self,**extra):
        return self.m.browser('goal-stop',self.fields(**extra))

    def test_stop_active_goal_pauses_future_sends_without_cancelling_current_execution(self):
        self.m.browser('goal-save',self.fields(objective='Complete the original product.',mode='automatic'))
        original=self.row('host_requests','id=?',(self.request,));run=self.f.runrow(self.run)
        page=self.row('managed_pages','page_id=?',(self.page,))
        result=self.stop_goal();goal=result['goal']
        self.assertEqual(goal['state'],'stopped');self.assertEqual(goal['display_state'],'stopped')
        self.assertEqual((goal['request_id'],goal['objective']),(self.request,'Complete the original product.'))
        self.assertEqual(result['model_sends'],0);self.assertTrue(result['future_paused'])
        self.assertEqual(result['page_was_paused'],bool(page['paused']))
        self.assertTrue(result['current_execution_unchanged']);self.assertTrue(result['budget_unchanged'])
        self.assertEqual(original,self.row('host_requests','id=?',(self.request,)))
        self.assertEqual(run,self.f.runrow(self.run))
        self.assertTrue(self.row('managed_pages','page_id=?',(self.page,))['paused'])
        self.assertEqual(self.row('managed_pause_owners','page_id=?',(self.page,))['source'],'operator')
        self.assertFalse(goal['can_review']);self.assertFalse(goal['can_start_next'])

    def test_stop_receipt_is_durable_idempotent_and_rejects_operation_reuse(self):
        self.save();payload=self.fields();first=self.m.browser('goal-stop',payload)
        self.h.managed=ManagedPages(self.h);self.m=self.h.managed
        again=self.m.browser('goal-stop',payload)
        self.assertTrue(again['replayed']);self.assertEqual(first['goal'],again['goal'])
        self.assertEqual(self.goal()['revision'],2)
        with self.assertRaisesRegex(HarnessError,'operation_conflict'):
            self.m.browser('goal-stop',{**payload,'expected_goal_request_id':'foreign'})

    def test_stale_stop_and_foreign_request_cannot_change_fresh_goal(self):
        self.save('Original');stale=self.fields();self.save('Fresh')
        with self.assertRaisesRegex(HarnessError,'goal_changed'):self.m.browser('goal-stop',stale)
        with self.assertRaisesRegex(HarnessError,'request_changed'):
            self.stop_goal(expected_goal_request_id='foreign')
        self.assertEqual(self.goal()['objective'],'Fresh');self.assertEqual(self.goal()['state'],'paused')

    def test_stop_current_owner_identity_and_store_cas_preserve_other_task(self):
        self.save();page=self.row('managed_pages','page_id=?',(self.page,))
        settings=json.loads(page['settings']);settings['account']='foreign'
        self.mutate('UPDATE managed_pages SET settings=? WHERE page_id=?',(json.dumps(settings),self.page))
        self.assertFalse(self.goal()['owner_identity_valid']);self.assertFalse(self.goal()['identity_valid'])
        self.assertTrue(self.goal()['request_matches'])
        with self.assertRaisesRegex(HarnessError,'identity_changed'):self.stop_goal()
        self.mutate('UPDATE managed_pages SET settings=? WHERE page_id=?',(page['settings'],self.page))
        self.mutate("UPDATE metadata SET value='other-store' WHERE key='id'")
        self.assertFalse(self.goal()['owner_identity_valid']);self.assertFalse(self.goal()['identity_valid'])
        self.assertTrue(self.goal()['request_matches'])
        with self.assertRaisesRegex(HarnessError,'store_changed'):self.stop_goal()
        self.assertEqual(self.goal()['state'],'paused')

    def test_stop_unknown_pending_goal_send_preserves_original_operation_and_preparation(self):
        self.ready();intent=self.prepare()
        command={'request_id':intent['operation_id'],'action':'message.send','thread_id':self.thread,
                 'data':{'text':intent['objective']}}
        self.service.state.begin(intent['operation_id'],command)
        self.service.state.operation(intent['operation_id'],'unknown')
        original=self.row('operations','id=?',(intent['operation_id'],))
        preparation=self.row('managed_goal_receipts','id=?',(intent['operation_id'],))
        request=self.row('host_requests','id=?',(self.request,));run=self.f.runrow(self.run)
        stopped=self.stop_goal()
        self.assertTrue(stopped['pending_send_preserved'])
        self.assertEqual(self.goal()['pending_id'],intent['operation_id'])
        self.assertEqual(self.goal()['next']['operation_id'],intent['operation_id'])
        self.assertEqual(original,self.row('operations','id=?',(intent['operation_id'],)))
        self.assertEqual(preparation,self.row('managed_goal_receipts','id=?',(intent['operation_id'],)))
        self.assertEqual(request,self.row('host_requests','id=?',(self.request,)))
        self.assertEqual(run,self.f.runrow(self.run));self.assertIsNone(self.row('managed_goal_revocations','id=?',(intent['operation_id'],)))

    def test_prepared_goal_send_after_stop_is_rejected_and_goal_never_revives(self):
        self.ready();intent=self.prepare();self.stop_goal()
        from harness_goal_control import validate_send
        with closing(self.h.state.connect()) as db:
            with self.assertRaisesRegex(HarnessError,'goal_stopped'):
                validate_send(self.h,db,self.thread,intent['objective'],intent['operation_id'])
        self.assertEqual(self.goal()['state'],'stopped');self.assertEqual(self.goal()['pending_id'],intent['operation_id'])

    def test_late_accepted_send_only_records_acceptance_without_rewriting_stopped_goal(self):
        self.ready();intent=self.prepare();self.stop_goal()
        before=self.row('managed_goals','page_id=?',(self.page,))
        from harness_goal_control import bind_accepted
        with closing(self.h.state.connect()) as db:
            bind_accepted(self.h,db,self.page,intent['operation_id']);db.commit()
        self.assertEqual(before,self.row('managed_goals','page_id=?',(self.page,)))
        receipt=self.row('managed_goal_receipts','id=?',(intent['operation_id'],))
        self.assertEqual(receipt['accepted_request_id'],intent['operation_id'])

    def test_late_result_cannot_erase_stopped_goal_or_mark_it_complete(self):
        self.m.browser('goal-save',self.fields(objective='Original goal.',mode='automatic'));self.stop_goal()
        before=self.row('managed_goals','page_id=?',(self.page,))
        from harness_goal_control import apply_result
        with closing(self.h.state.connect()) as db:
            page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(self.page,)).fetchone()
            apply_result(db,page,self.request,'CLW_GOAL_STATUS: delivered');db.commit()
        self.assertEqual(before,self.row('managed_goals','page_id=?',(self.page,)))

    def test_stale_watcher_reconciliation_cannot_reactivate_or_consume_pending_stop(self):
        self.ready();intent=self.prepare();self.stop_goal()
        before=self.row('managed_goals','page_id=?',(self.page,));watcher=self.watcher()
        class OriginalReceipt:
            def __init__(self,state):self.state=state
            def request(self,route):
                assert route=='receipt?request_id='+intent['operation_id']
                return {'state':self.state,'result':{'request_id':intent['operation_id']}}
        for state in ('completed','unknown','failed'):
            watcher.operator=OriginalReceipt(state);watcher.reconcile(dict(before))
            self.assertEqual(before,self.row('managed_goals','page_id=?',(self.page,)))
        watcher.state(self.page,'needs_attention','cached observation',observed=True)
        self.assertEqual(before,self.row('managed_goals','page_id=?',(self.page,)))

    def test_stopped_goal_allows_explicit_ordinary_message_and_later_goal_reenable(self):
        self.m.browser('goal-save',self.fields(objective='First goal.',mode='automatic'));self.close();self.stop_goal()
        self.f.refill(self.page,sends=5,seconds=3600)
        self.m.browser('pause',{'page_id':self.page,'paused':False})
        self.assertEqual(self.goal()['state'],'stopped')
        message=self.service.command({'request_id':str(uuid.uuid4()),'action':'message.send','thread_id':self.thread,
                                      'data':{'text':'An ordinary new user message.'}})
        self.assertEqual(message['state'],'queued_for_web_host');self.assertEqual(self.goal()['request_id'],self.request)
        self.assertEqual(self.goal()['state'],'stopped')
        stopped=self.goal()
        self.assertTrue(stopped['owner_identity_valid']);self.assertFalse(stopped['request_matches'])
        self.assertFalse(stopped['identity_valid']);self.assertFalse(stopped['can_review']);self.assertFalse(stopped['can_start_next'])
        summary=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==self.page)['goal']
        self.assertEqual((summary['owner_identity_valid'],summary['request_matches'],summary['identity_valid']),(True,False,False))
        resumed=self.m.browser('goal-save',self.fields(objective='An explicitly new goal.',mode='automatic'))
        self.assertEqual(resumed['goal']['state'],'active');self.assertEqual(resumed['goal']['request_id'],message['request_id'])
        self.assertTrue(resumed['goal']['owner_identity_valid']);self.assertTrue(resumed['goal']['request_matches'])
        self.assertTrue(resumed['goal']['identity_valid'])

    def test_goal_view_detects_foreign_saved_thread_even_when_request_and_identity_text_match(self):
        self.save();self.mutate('UPDATE managed_goals SET thread_id=? WHERE page_id=?',('foreign-thread',self.page))
        goal=self.goal()
        self.assertFalse(goal['owner_identity_valid']);self.assertTrue(goal['request_matches'])
        self.assertFalse(goal['identity_valid']);self.assertFalse(goal['can_review']);self.assertFalse(goal['can_start_next'])
        with self.assertRaisesRegex(HarnessError,'identity_changed'):self.stop_goal()
        with self.assertRaisesRegex(HarnessError,'identity_changed'):self.save('Do not reassign a foreign saved Goal.')
        self.assertEqual(self.goal()['state'],'paused')

    def test_worker_and_model_tools_cannot_stop_controller_goal(self):
        self.save();child,_=self.f.f.enroll(self.page)
        with self.assertRaisesRegex(HarnessError,'controller_required'):
            self.m.browser('goal-stop',{**self.fields(),'page_id':child})
        with self.assertRaisesRegex(ValueError,'managed_operation_unknown'):
            self.f.f.private(self.page,'goal-stop',self.fields())
        self.assertEqual(self.goal()['state'],'paused')


class ReconciledSummaryTests(unittest.TestCase):
    def setUp(self):
        from test_harness_goal_watch import GoalTests
        self.f=GoalTests();self.f.setUp();self.m=self.f.fixture.m
    def tearDown(self):self.f.tearDown()
    def goal(self):return self.m.browser('goal-read',{'page_id':self.f.page})['goal']
    def payload(self,**extra):
        g=self.goal()
        return {'page_id':self.f.page,'operation_id':str(uuid.uuid4()),'expected_etag':g['etag'],
                'expected_goal_request_id':g['request_id'],**extra}
    def test_reconciled_summary_is_reviewable_with_full_original_proof(self):
        path=self.f.saved_summary()
        self.m.browser('goal-save',self.payload(objective='Product goal'))
        result=self.m.browser('goal-review',self.payload(decision='continue',note='User accepts this saved package.'))
        self.assertEqual(result['goal']['review']['artifact']['path'],str(path))
        self.assertEqual(result['goal']['review']['artifact']['source'],'authenticated_team_final_summary')
    def test_reconciled_event_presence_without_original_chain_cannot_be_reviewed(self):
        self.f.saved_summary();self.m.browser('goal-save',self.payload(objective='Product goal'))
        with self.f.goal.db() as db:db.execute("DELETE FROM events WHERE kind='team_final_summary'")
        with self.assertRaisesRegex(HarnessError,'original_result_unavailable'):
            self.m.browser('goal-review',self.payload(decision='continue',note='Do not accept a fabricated event'))
    def test_earlier_yield_reply_cannot_replace_final_reconciled_summary(self):
        path=self.f.saved_summary()
        with self.f.goal.db() as db:
            db.execute("INSERT INTO control_browser_receipts VALUES(?,?,?,?,?,?,?,?,?,?)",
                       ('old-yield',self.f.request,self.f.thread,'oldclaim','sent','before','turn','a'*64,'reply',1.0))
        self.m.browser('goal-save',self.payload(objective='Product goal'))
        result=self.m.browser('goal-review',self.payload(decision='continue',note='Final result accepted'))
        self.assertEqual(result['goal']['review']['artifact']['path'],str(path))


class GoalMigrationTests(unittest.TestCase):
    def test_two_concurrent_startups_migrate_legacy_goal_once_preserving_original_state(self):
        import sqlite3,tempfile,threading
        from concurrent.futures import ThreadPoolExecutor
        from harness_goal_control import schema
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'legacy.sqlite3'
            with closing(sqlite3.connect(path)) as db:
                db.execute('CREATE TABLE managed_goals(page_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,store_id TEXT NOT NULL,identity TEXT NOT NULL,objective TEXT NOT NULL,state TEXT NOT NULL,request_id TEXT NOT NULL,pending_id TEXT,cycles INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT "",updated REAL NOT NULL)')
                db.execute('INSERT INTO managed_goals VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                           ('page','thread','store','originalidentity','Original goal','paused','request',None,7,'human_round_control',1.0))
                db.commit()
            barrier=threading.Barrier(2)
            def migrate():
                with closing(sqlite3.connect(path,timeout=5)) as db:
                    db.row_factory=sqlite3.Row;barrier.wait(timeout=4);schema(db);db.commit()
            with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(lambda _:migrate(),range(2)))
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute('SELECT state,request_id,cycles,reason,control_mode,revision FROM managed_goals').fetchone(),
                                 ('paused','request',7,'human_round_control','automatic',0))

if __name__=='__main__':unittest.main()
