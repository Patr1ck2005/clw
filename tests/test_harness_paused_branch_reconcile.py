"""Explicit paused-branch retirement; no browser/provider or live DB access."""
from contextlib import closing
from pathlib import Path
import json
import hashlib
import sys
import unittest
import uuid
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'scripts'), str(Path(__file__).parent)]
import test_harness_attention_reconcile as fixtures
from harness_state import HarnessError


class PausedBranchTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.ReconcileTests(); self.f.setUp()
        self.h, self.m = self.f.h, self.f.m

    def tearDown(self):
        self.f.tearDown()

    def setup_branch(self):
        parent, ctx, child, request, old, cc = self.f.ended_child(missing=True)
        # The shared fixture upgrades scope to write to test writer retention.
        # This contract requires the original assignment's read-only scope.
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE host_team_scopes SET access='read',write_paths='[]' WHERE thread_id=?",
                       (cc['request']['thread_id'],))
            db.execute('DELETE FROM host_team_leases WHERE request_id=?', (request,))
            db.commit()
        continue_key = str(uuid.uuid4())
        args = {**self.f.args(child, request, old['attempt_id'], ctx['run']['id']), 'mode': 'continue'}
        self.h.team.public_command(ctx['request']['thread_id'], continue_key, 'reconcile-attention', args)
        # A normal continuation offer is created, but never dispatched.
        offer = self.f.f.wire(child, 'pulse')
        self.assertEqual(offer['state'], 'offer')
        self.m.browser('pause', {'page_id': child, 'paused': True})
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE host_runs SET state='draining',reason='turn_budget',dispatches=max_dispatches-1 WHERE id=?",
                       (ctx['run']['id'],))
            db.execute("UPDATE host_requests SET phase='suspended' WHERE id=?", (ctx['request']['id'],))
            db.commit()
        proof = self.f.proof(child)
        proof['browser'].update(userHash='b' * 64, assistantTurnHash='d' * 64)
        payload = self.f.args(child, request, old['attempt_id'], ctx['run']['id'], proof)
        payload.update(mode='retire-paused', offered_attempt_id=offer['attempt_id'],
                       continue_operation_id=continue_key)
        return ctx, child, request, old, offer, payload

    def call(self, ctx, p, key=None):
        return self.h.team.public_command(ctx['request']['thread_id'], key or str(uuid.uuid4()),
                                          'reconcile-attention', p)

    def test_retire_retains_pause_artifacts_claim_notes_budget_and_final_ready(self):
        ctx, child, request, old, offer, p = self.setup_branch()
        with closing(self.h.state.connect()) as db:
            db.execute('INSERT INTO host_notes VALUES(?,?,?,?)', ('late-note', request, 'Keep this correction', 'now'))
            db.execute('INSERT INTO host_unread_notes VALUES(?,?)', ('late-note', request))
            db.execute('INSERT INTO managed_page_issues VALUES(?,?,?)',
                       (child, 'control_failed', '发送准备连续3次失败；原因 control_user_turn_changed'))
            db.commit()
            before = dict(db.execute('SELECT * FROM host_runs WHERE id=?', (ctx['run']['id'],)).fetchone())
            artifacts = [dict(x) for x in db.execute('SELECT * FROM managed_artifacts')]
            notes = [tuple(x) for x in db.execute('SELECT * FROM host_unread_notes')]
            outcomes = [dict(x) for x in db.execute('SELECT * FROM managed_turn_outcomes')]
            issue = dict(db.execute('SELECT * FROM managed_page_issues WHERE page_id=?', (child,)).fetchone())
            parent = db.execute('SELECT * FROM host_requests WHERE id=?', (ctx['request']['id'],)).fetchone()
            self.assertFalse(self.h.team.ready(db, parent))
        key = str(uuid.uuid4()); result = self.call(ctx, p, key)
        self.assertEqual(result['state'], 'paused_branch_retired')
        self.assertEqual(result['model_sends'], 0); self.assertFalse(result['task_completed'])
        self.assertIn({'request_id': request, 'note_id': 'late-note'}, result['unread_note_refs'])
        self.assertEqual(result['preserved_page_issue'], issue)
        self.assertEqual(self.call(ctx, p, key), result)
        with closing(self.h.state.connect()) as db:
            row = db.execute('SELECT * FROM host_requests WHERE id=?', (request,)).fetchone()
            self.assertEqual(row['phase'], 'blocked'); self.assertIsNotNone(row['finished_at'])
            self.assertEqual(row['claim_id'], db.execute(
                'SELECT claim_id FROM control_browser_receipts WHERE attempt_id=?', (old['attempt_id'],)).fetchone()[0])
            self.assertEqual(db.execute('SELECT paused FROM managed_pages WHERE page_id=?', (child,)).fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT source FROM managed_pause_owners WHERE page_id=?', (child,)).fetchone()[0], 'operator')
            self.assertEqual(db.execute('SELECT state FROM control_attempts WHERE id=?', (offer['attempt_id'],)).fetchone()[0], 'not_sent')
            self.assertEqual(dict(db.execute('SELECT * FROM host_runs WHERE id=?', (ctx['run']['id'],)).fetchone()), before)
            self.assertEqual([dict(x) for x in db.execute('SELECT * FROM managed_artifacts')], artifacts)
            self.assertEqual([tuple(x) for x in db.execute('SELECT * FROM host_unread_notes')], notes)
            self.assertEqual([dict(x) for x in db.execute('SELECT * FROM managed_turn_outcomes')], outcomes)
            self.assertEqual(dict(db.execute('SELECT * FROM managed_page_issues WHERE page_id=?', (child,)).fetchone()), issue)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_reads').fetchone()[0], 0)
            reply = db.execute("SELECT data FROM events WHERE kind='assistant_message' AND json_extract(data,'$.item_id') LIKE 'retired-%' AND thread_id=?",
                               (row['thread_id'],)).fetchone()
            self.assertIn('late-note', json.loads(reply['data'])['text'])
            self.assertIn('Keep this correction', json.loads(reply['data'])['text'])
            self.assertIn('control_failed', json.loads(reply['data'])['text'])
            self.assertIn('control_user_turn_changed', json.loads(reply['data'])['text'])
            self.assertTrue(self.h.team.ready(db, parent))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_paused_branch_retired'").fetchone()[0], 1)

    def test_reject_identity_artifact_send_unknown_lease_and_new_job(self):
        for kind in ('user', 'turn', 'session', 'job', 'sent', 'unknown', 'lease', 'artifact',
                     'continue', 'new_request', 'dispatched', 'ack', 'resources', 'auto_pause',
                     'stale', 'truncated', 'job_unknown', 'wrong_actor', 'resume_flag',
                     'user_stopped', 'login_required', 'approval_required'):
            with self.subTest(kind=kind):
                self.f.tearDown(); self.f.setUp(); self.h, self.m = self.f.h, self.f.m
                ctx, child, request, old, offer, p = self.setup_branch()
                proof = json.loads(Path(p['evidence_path']).read_bytes())
                if kind == 'user': proof['browser']['userHash'] = 'f' * 64
                if kind == 'turn': proof['browser']['assistantTurnHash'] = 'f' * 64
                if kind == 'session': proof['session_id'] = 'another-session'
                if kind == 'job':
                    proof['result']['structuredContent']['output'].update(
                        jobs=[{'session_id': proof['session_id'], 'status': 'running'}], count=1, matched_count=1)
                if kind == 'stale': proof['observed_at'] -= 121
                if kind == 'truncated': proof['result']['structuredContent']['output']['truncated'] = True
                if kind == 'job_unknown':
                    proof['result']['structuredContent']['output'].update(jobs=[{
                        'session_id': proof['session_id'], 'status': 'failed', 'command_execution_state': 'unknown'}], count=1, matched_count=1)
                if kind in ('user', 'turn', 'session', 'job', 'stale', 'truncated', 'job_unknown'):
                    p = {**self.f.args(child, request, old['attempt_id'], ctx['run']['id'], proof),
                         'mode': 'retire-paused', 'offered_attempt_id': offer['attempt_id'],
                         'continue_operation_id': p['continue_operation_id']}
                with closing(self.h.state.connect()) as db:
                    if kind == 'sent': db.execute("UPDATE control_attempts SET state='sent',dispatched=1 WHERE id=?", (offer['attempt_id'],))
                    if kind == 'dispatched': db.execute('UPDATE control_attempts SET dispatched=1 WHERE id=?', (offer['attempt_id'],))
                    if kind == 'ack': db.execute('UPDATE control_attempts SET acknowledged=1 WHERE id=?', (offer['attempt_id'],))
                    if kind == 'resources': db.execute("UPDATE host_team_work SET resources='[\"exclusive\"]' WHERE request_id=?", (request,))
                    if kind == 'auto_pause': db.execute("UPDATE managed_pause_owners SET source='attention' WHERE page_id=?", (child,))
                    if kind == 'wrong_actor': db.execute("UPDATE host_team_receipts SET actor='another-session' WHERE operation_id=?", (p['continue_operation_id'],))
                    if kind == 'resume_flag': p['resume_operator_pause'] = True
                    if kind in ('user_stopped', 'login_required', 'approval_required'):
                        db.execute('INSERT INTO managed_page_issues VALUES(?,?,?)', (child, kind, 'Preserved issue'))
                    if kind == 'unknown': db.execute("INSERT INTO operations VALUES('unknown-op','x','project.work',?,'unknown',NULL,'now')", (self.h.binding(db, target=child)['thread_id'],))
                    if kind == 'lease':
                        db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?,?,?,?)', (request, ctx['run']['id'], self.h.binding(db,target=child)['thread_id'], str(self.h.root), 'read', '[]', self.h.clock()))
                    if kind == 'artifact':
                        a = db.execute('SELECT path FROM managed_artifacts WHERE request_id=?', (request,)).fetchone()
                        Path(a['path']).write_text('changed')
                    if kind == 'continue': p['continue_operation_id'] = str(uuid.uuid4())
                    if kind == 'new_request':
                        db.execute("INSERT INTO host_requests(id,thread_id,text,phase,created_at) VALUES(?,?,?,'queued','9999')", ('supersede-' + uuid.uuid4().hex, self.h.binding(db,target=child)['thread_id'], 'New work'))
                    db.commit()
                with self.assertRaises(HarnessError): self.call(ctx, p)
                with closing(self.h.state.connect()) as db:
                    self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?', (request,)).fetchone()[0], 'suspended')

    def test_terminal_jobs_accepted_but_incomplete_inventory_rejected(self):
        ctx, child, request, old, offer, p = self.setup_branch()
        proof = json.loads(Path(p['evidence_path']).read_bytes())
        proof['result']['structuredContent']['output'].update(jobs=[{
            'session_id': proof['session_id'], 'status': 'failed', 'command_execution_state': 'completed'}], count=1, matched_count=1)
        p = {**self.f.args(child, request, old['attempt_id'], ctx['run']['id'], proof),
             'mode': 'retire-paused', 'offered_attempt_id': offer['attempt_id'],
             'continue_operation_id': p['continue_operation_id']}
        self.assertEqual(self.call(ctx, p)['state'], 'paused_branch_retired')

    def test_lost_reply_then_restart_uses_committed_receipt(self):
        ctx, child, request, old, offer, p = self.setup_branch(); key = str(uuid.uuid4())
        # Durable operation receipt commits before notification/return.
        with patch.object(self.h.team.changed, 'set', side_effect=ConnectionError('reply lost')):
            with self.assertRaises(ConnectionError): self.call(ctx, p, key)
        from harness_team import TeamRuntime
        self.h.team = TeamRuntime(self.h)
        result = self.call(ctx, p, key)
        self.assertEqual(result['state'], 'paused_branch_retired')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_paused_branch_retired'").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM host_replies WHERE request_id=? AND id LIKE 'retired-%'", (request,)).fetchone()[0], 1)

    def test_original_marker_dom_remount_accepts_only_canonical_identity(self):
        real_identity = 'managed-public:[CLW:control_f98da05e77f448ba997811b7962cdade]:user'
        self.assertEqual(hashlib.sha256(real_identity.encode()).hexdigest(),
                         'e4186071a12f10fbc043d9c8a35d0f046dc7bd0092240362b96c23594af555b2')
        ctx, child, request, old, offer, p = self.setup_branch()
        proof = json.loads(Path(p['evidence_path']).read_bytes())
        marker = '[CLW:' + old['attempt_id'] + ']'
        proof['browser'].update(userHash=hashlib.sha256(('managed-public:' + marker + ':user').encode()).hexdigest(),
                                marker=marker, marker_count=1, history_at_latest=True)
        for changed in ({'marker': '[CLW:control_' + 'e' * 32 + ']'}, {'marker_count': 2},
                        {'marker_count': True}, {'history_at_latest': False},
                        {'assistantTurnHash': 'e' * 64}, {'userHash': 'e' * 64}):
            bad = {**proof, 'browser': {**proof['browser'], **changed}}
            args = {**self.f.args(child, request, old['attempt_id'], ctx['run']['id'], bad),
                    'mode': 'retire-paused', 'offered_attempt_id': offer['attempt_id'],
                    'continue_operation_id': p['continue_operation_id']}
            with self.subTest(changed=changed), self.assertRaisesRegex(HarnessError, 'attention_browser_not_idle'):
                self.call(ctx, args)
        args = {**self.f.args(child, request, old['attempt_id'], ctx['run']['id'], proof),
                'mode': 'retire-paused', 'offered_attempt_id': offer['attempt_id'],
                'continue_operation_id': p['continue_operation_id']}
        value = self.call(ctx, args)
        self.assertEqual(value['browser_identity_source'], 'unique_original_public_marker')
        with closing(self.h.state.connect()) as db:
            receipt = db.execute('SELECT sent_user_hash,result_turn_hash FROM control_browser_receipts WHERE attempt_id=?',
                                 (old['attempt_id'],)).fetchone()
            self.assertEqual(receipt['sent_user_hash'], 'b' * 64)
            self.assertEqual(receipt['result_turn_hash'], 'd' * 64)
            self.assertEqual(db.execute('SELECT paused FROM managed_pages WHERE page_id=?', (child,)).fetchone()[0], 1)


if __name__ == '__main__': unittest.main()
