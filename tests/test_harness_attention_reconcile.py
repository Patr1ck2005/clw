"""Ended writers release ownership only after an operator's original execution audit."""
from contextlib import closing
from pathlib import Path
import hashlib
import json
import sys
import unittest
import uuid

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'scripts'), str(Path(__file__).parent)]
import test_harness_managed_attention as attention_fixture
from test_harness_control_plane import PAGE
from harness_state import HarnessError


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.a = attention_fixture.AttentionTests(); self.a.setUp()
        self.f, self.h, self.m = self.a.f, self.a.h, self.a.m

    def tearDown(self):
        self.a.tearDown()

    def writer(self, thread, request):
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE host_team_scopes SET access='write',write_paths='[\".\"]' WHERE thread_id=?", (thread,))
            db.execute("UPDATE host_team_leases SET access='write' WHERE request_id=?", (request,))
            db.commit()

    def proof(self, page):
        with closing(self.h.state.connect()) as db:
            p = db.execute('SELECT * FROM managed_pages WHERE page_id=?', (page,)).fetchone()
        return {'source': 'Local-MCP-B.list_jobs', 'session_id': self.f.sessions[page],
                'observed_at': self.h.clock(), 'result': {'structuredContent': {
                    'success': True, 'error': None, 'output': {'jobs': [], 'count': 0,
                                                             'matched_count': 0, 'truncated': False}}},
                'browser': {'page_id': page, 'url': p['url'], 'at': self.h.clock() * 1000,
                            'generating': False, 'complete': True, 'loginRequired': False,
                            'approvalRequired': False, 'draft': False}}

    def args(self, page, request, attempt, run, proof=None):
        path = self.f.f.root / 'evidence' / ('audit-' + uuid.uuid4().hex + '.json')
        path.parent.mkdir(exist_ok=True)
        raw = json.dumps(proof or self.proof(page)).encode(); path.write_bytes(raw)
        return {'run_id': run, 'request_id': request, 'attempt_id': attempt,
                'evidence_path': str(path), 'evidence_sha256': hashlib.sha256(raw).hexdigest(),
                'reason': 'Original execution ended; collect independent work. Preserve the refused operation.',
                'confirm': True}

    def ended_parent(self):
        page, request, offer, ctx = self.f.start_browser_turn()
        self.writer(ctx['request']['thread_id'], request)
        children = []
        for _ in range(2):
            child, _ = self.f.enroll(page)
            assigned = self.a.team(page, 'assign', {'run_id': ctx['run']['id'],
                'claim_id': ctx['request']['claim_id'], 'target': child, 'text': 'Independent review',
                'depends_on': [], 'resources': []})
            children.append((child, assigned['request_id']))
        self.a.finish(page, request, offer, ctx['request']['claim_id'], 'needs_attention',
                      'Saved result. A different project action was refused.')
        return page, request, offer, ctx, children

    def ended_child(self,missing=False):
        parent,request,offer,ctx=self.f.start_browser_turn()
        child,_=self.f.enroll(parent)
        assigned=self.a.team(parent,'assign',{'run_id':ctx['run']['id'],'claim_id':ctx['request']['claim_id'],
            'target':child,'text':'Independent work','depends_on':[],'resources':[]})
        co=self.f.wire(child,'pulse');self.f.wire(child,'dispatch',attempt_id=co['attempt_id'])
        self.f.wire(child,'sent',attempt_id=co['attempt_id'],assistant_before_hash='c'*64,
            page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True})
        cc=self.f.private(child,'context',{})
        self.writer(cc['request']['thread_id'],assigned['request_id'])
        raw='Saved original public result. No management outcome was issued.'
        if missing:
            self.m.browser('artifact',{'page_id':child,'attempt_id':co['attempt_id'],'text':raw,'assistant_turn_hash':'d'*64})
            self.f.wire(child,'result',attempt_id=co['attempt_id'],
                page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64},
                assistant_turn_hash='d'*64,text=raw)
        else:
            self.a.finish(child,assigned['request_id'],co,cc['request']['claim_id'],'needs_attention',raw)
        return parent,ctx,child,assigned['request_id'],co,cc

    def test_controller_releases_ended_writer_and_collects_original_children_once(self):
        page, request, offer, ctx, children = self.ended_parent()
        args = self.args(page, request, offer['attempt_id'], ctx['run']['id'])
        key = str(uuid.uuid4())
        result = self.h.team.public_command(ctx['request']['thread_id'], key, 'reconcile-attention', args)
        self.assertEqual(result['model_sends'], 0)
        self.assertEqual(self.h.team.public_command(ctx['request']['thread_id'], key, 'reconcile-attention', args), result)
        self.assertEqual(self.f.wire(page, 'pulse')['state'], 'idle_or_old_request_not_adopted')
        with closing(self.h.state.connect()) as db:
            self.assertIsNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?', (request,)).fetchone())
            self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?', (request,)).fetchone()[0], ctx['request']['claim_id'])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='host_turn_attention'").fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_recovery_contexts WHERE request_id=?', (request,)).fetchone()[0], 1)
        for child, child_request in children:
            co = self.f.wire(child, 'pulse')
            self.assertEqual(co['state'], 'offer')
            self.f.wire(child, 'dispatch', attempt_id=co['attempt_id'])
            self.f.wire(child, 'sent', attempt_id=co['attempt_id'], assistant_before_hash='c'*64,
                        page={**PAGE, 'model_label': 'GPT-6 Astra Pro', 'effort_label': '最高',
                              'user_hash': 'b'*64, 'generating': True})
            child_ctx = self.f.private(child, 'context', {})
            self.assertEqual(child_ctx['request']['id'], child_request)
            self.a.finish(child, child_request, co, child_ctx['request']['claim_id'], 'completed', 'Complete independent result')
        self.assertEqual(self.f.wire(page, 'pulse')['state'], 'offer')

    def test_fresh_scoped_complete_evidence_and_original_pause_are_required(self):
        page, request, offer, ctx, _ = self.ended_parent()
        for kind in ('stale', 'foreign_session', 'running', 'truncated', 'browser_generating'):
            with self.subTest(kind=kind):
                proof = self.proof(page)
                if kind == 'stale': proof['observed_at'] -= 121
                if kind == 'foreign_session': proof['session_id'] = 'another-session'
                if kind == 'running':
                    proof['result']['structuredContent']['output'].update(jobs=[{'session_id': self.f.sessions[page], 'status': 'running'}], count=1, matched_count=1)
                if kind == 'truncated': proof['result']['structuredContent']['output']['truncated'] = True
                if kind == 'browser_generating': proof['browser']['generating'] = True
                with self.assertRaises(HarnessError):
                    self.h.team.public_command(ctx['request']['thread_id'], str(uuid.uuid4()), 'reconcile-attention',
                        self.args(page, request, offer['attempt_id'], ctx['run']['id'], proof))
        self.m.browser('pause', {'page_id': page, 'paused': True})
        with self.assertRaisesRegex(HarnessError, 'attention_explicit_stop_preserved'):
            self.h.team.public_command(ctx['request']['thread_id'], str(uuid.uuid4()), 'reconcile-attention',
                self.args(page, request, offer['attempt_id'], ctx['run']['id']))
        with closing(self.h.state.connect()) as db:
            self.assertIsNotNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?', (request,)).fetchone())
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?', (request,)).fetchone()[0], 'processing')

    def test_project_session_cannot_certify_own_idle_execution(self):
        page, request, offer, ctx, _ = self.ended_parent()
        args = self.args(page, request, offer['attempt_id'], ctx['run']['id']); args.pop('confirm')
        with self.assertRaisesRegex(HarnessError, 'team_attention_operator_audit_required'):
            self.a.team(page, 'reconcile-attention', args)

    def test_explicit_resume_after_normal_shutdown_still_preserves_actual_stop(self):
        page, request, offer, ctx, _ = self.ended_parent()
        self.m.browser('pause-all', {})
        args = self.args(page, request, offer['attempt_id'], ctx['run']['id'])
        args['resume_operator_pause'] = True
        result = self.h.team.public_command(ctx['request']['thread_id'], str(uuid.uuid4()), 'reconcile-attention', args)
        self.assertEqual(result['state'], 'independent_children_resumed_controller_parked')

    def test_ended_child_is_blocked_not_successful_and_parent_can_collect(self):
        page, request, offer, ctx = self.f.start_browser_turn()
        child, _ = self.f.enroll(page)
        assigned = self.a.team(page, 'assign', {'run_id': ctx['run']['id'], 'claim_id': ctx['request']['claim_id'],
            'target': child, 'text': 'Independent work', 'depends_on': [], 'resources': []})
        co = self.f.wire(child, 'pulse'); self.f.wire(child, 'dispatch', attempt_id=co['attempt_id'])
        self.f.wire(child, 'sent', attempt_id=co['attempt_id'], assistant_before_hash='c'*64,
                    page={**PAGE, 'model_label': 'GPT-6 Astra Pro', 'effort_label': '最高', 'user_hash': 'b'*64, 'generating': True})
        cc = self.f.private(child, 'context', {})
        self.writer(cc['request']['thread_id'], assigned['request_id'])
        self.a.finish(child, assigned['request_id'], co, cc['request']['claim_id'], 'needs_attention', 'Saved partial implementation; refused edit preserved.')
        result = self.h.team.public_command(ctx['request']['thread_id'], str(uuid.uuid4()), 'reconcile-attention',
            self.args(child, assigned['request_id'], co['attempt_id'], ctx['run']['id']))
        self.assertEqual(result['state'], 'blocked_result_collected')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?', (assigned['request_id'],)).fetchone()[0], 'blocked')
            self.assertIsNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?', (assigned['request_id'],)).fetchone())
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?', (assigned['request_id'],)).fetchone()[0], 1)

    def test_worker_button_reconciles_own_latest_original_request_via_actual_controller_once(self):
        parent,ctx,child,request,offer,cc=self.ended_child(missing=True)
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE host_runs SET state='draining',reason='turn_budget',dispatches=max_dispatches WHERE id=?",
                       (ctx['run']['id'],));db.commit()
        payload=self.args(child,request,offer['attempt_id'],ctx['run']['id']);payload['mode']='settle'
        args={'page_id':child,'operation_id':str(uuid.uuid4()),'payload':payload}
        value=self.m.browser('reconcile-attention',args)
        self.assertEqual(value['state'],'blocked_result_collected');self.assertEqual(value['model_sends'],0)
        self.assertEqual(self.m.browser('reconcile-attention',args),value)
        with closing(self.h.state.connect()) as db:
            receipt=db.execute('SELECT actor FROM host_team_receipts WHERE operation_id=?',(args['operation_id'],)).fetchone()
            self.assertEqual(receipt['actor'],self.f.sessions[parent])
            run=db.execute('SELECT state,dispatches,max_dispatches FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone()
            self.assertEqual(run['state'],'draining');self.assertEqual(run['dispatches'],run['max_dispatches'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_reads').fetchone()[0],0)
            self.assertIsNone(db.execute('SELECT 1 FROM managed_turn_outcomes WHERE attempt_id=?',(offer['attempt_id'],)).fetchone())
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_ended_execution_reconciled'").fetchone()[0],1)

    def test_worker_button_rejects_peer_request_wrong_run_and_superseded_request(self):
        parent,ctx,child,request,offer,cc=self.ended_child(missing=True)
        peer,_=self.f.enroll(parent)
        payload=self.args(child,request,offer['attempt_id'],ctx['run']['id'])
        for page,p,reason in [(peer,payload,'managed_reconcile_request_changed'),
                              (child,{**payload,'run_id':'clw-foreign-run-00000000'},'managed_reconcile_run_changed')]:
            with self.subTest(reason=reason),self.assertRaisesRegex(HarnessError,reason):
                self.m.browser('reconcile-attention',{'page_id':page,'operation_id':str(uuid.uuid4()),'payload':p})
        with closing(self.h.state.connect()) as db:
            db.execute('INSERT INTO host_requests(id,thread_id,text,phase,created_at) VALUES(?,?,?,?,?)',
                       ('request-superseding-original',cc['request']['thread_id'],'New user work','queued','9999'));db.commit()
        with self.assertRaisesRegex(HarnessError,'managed_reconcile_request_changed'):
            self.m.browser('reconcile-attention',{'page_id':child,'operation_id':str(uuid.uuid4()),'payload':payload})
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'processing')
            self.assertIsNotNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())

    def test_exhausted_controller_can_close_blocked_without_forging_unread_result_receipts(self):
        page, request, offer, ctx = self.f.start_browser_turn()
        child, _ = self.f.enroll(page)
        assigned = self.a.team(page, 'assign', {'run_id': ctx['run']['id'], 'claim_id': ctx['request']['claim_id'],
            'target': child, 'text': 'Independent work', 'depends_on': [], 'resources': []})
        co = self.f.wire(child, 'pulse'); self.f.wire(child, 'dispatch', attempt_id=co['attempt_id'])
        self.f.wire(child, 'sent', attempt_id=co['attempt_id'], assistant_before_hash='c'*64,
                    page={**PAGE, 'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True})
        cc = self.f.private(child, 'context', {})
        self.a.finish(child, assigned['request_id'], co, cc['request']['claim_id'], 'completed', 'Saved original child result')
        self.writer(ctx['request']['thread_id'], request)
        self.a.finish(page, request, offer, ctx['request']['claim_id'], 'needs_attention', 'Summary saved; child result not reviewed.')
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE host_runs SET state='draining',deadline=?,dispatches=max_dispatches WHERE id=?",
                       (self.h.clock()-1,ctx['run']['id']));db.commit()
            before = dict(db.execute('SELECT * FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone())
            artifacts = [dict(x) for x in db.execute('SELECT * FROM managed_artifacts ORDER BY id')]
        args = self.args(page, request, offer['attempt_id'], ctx['run']['id']);key = str(uuid.uuid4())
        result = self.h.team.public_command(ctx['request']['thread_id'], key, 'reconcile-attention', args)
        self.assertEqual(result['state'], 'blocked_controller_closed');self.assertEqual(result['model_sends'],0)
        self.assertEqual(self.h.team.public_command(ctx['request']['thread_id'],key,'reconcile-attention',args),result)
        with closing(self.h.state.connect()) as db:
            after = dict(db.execute('SELECT * FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone())
            self.assertEqual(after['state'],'closed');self.assertEqual(after['reason'],'operator_reconciled_blocked')
            self.assertEqual(after['dispatches'],before['dispatches']);self.assertEqual(after['deadline'],before['deadline'])
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'blocked')
            self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0],ctx['request']['claim_id'])
            self.assertEqual(db.execute('SELECT paused FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_reads').fetchone()[0],0)
            self.assertIsNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())
            self.assertEqual([dict(x) for x in db.execute('SELECT * FROM managed_artifacts ORDER BY id')],artifacts)
            binding=self.h.binding(db,thread=ctx['request']['thread_id'])
            original=db.execute('SELECT * FROM host_requests WHERE id=?',(request,)).fetchone()
            with self.assertRaisesRegex(HarnessError,'team_audited_failure_not_success'):
                self.h.team.final_gate(db,binding,original,status='completed')

    def test_exhausted_controller_cannot_use_finalization_to_restart_pending_children(self):
        page, request, offer, ctx, _ = self.ended_parent()
        with closing(self.h.state.connect()) as db:
            db.execute('UPDATE host_runs SET deadline=? WHERE id=?',(self.h.clock()-1,ctx['run']['id']));db.commit()
        with self.assertRaisesRegex(HarnessError,'attention_original_run_not_runnable'):
            self.h.team.public_command(ctx['request']['thread_id'],str(uuid.uuid4()),'reconcile-attention',
                self.args(page,request,offer['attempt_id'],ctx['run']['id']))
        with closing(self.h.state.connect()) as db:
            self.assertIsNotNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'processing')

    def test_terminal_reconciliation_keeps_unread_user_instructions(self):
        page, request, offer, ctx = self.f.start_browser_turn()
        self.writer(ctx['request']['thread_id'],request)
        self.a.finish(page,request,offer,ctx['request']['claim_id'],'needs_attention','Partial result')
        with closing(self.h.state.connect()) as db:
            db.execute('INSERT INTO host_notes VALUES(?,?,?,?)',('late-note',request,'User correction','now'))
            db.execute('INSERT INTO host_unread_notes VALUES(?,?)',('late-note',request));db.commit()
        with self.assertRaisesRegex(HarnessError,'attention_unread_instructions'):
            self.h.team.public_command(ctx['request']['thread_id'],str(uuid.uuid4()),'reconcile-attention',
                self.args(page,request,offer['attempt_id'],ctx['run']['id']))
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone()[0],'running')
            self.assertIsNotNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())


if __name__ == '__main__': unittest.main()
