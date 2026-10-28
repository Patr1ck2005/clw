"""Current dormant managed admission, real temporary SQLite/protocol only.

The historical candidate is already in production source. Exercise that source
directly; live harness data, Chromium, model Send and owner processes are untouched.
"""
from pathlib import Path
from contextlib import closing
import json
import sys
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'tests')]
import test_harness_managed as fixtures
from test_harness_control_plane import PAGE
from harness_state import HarnessError

class DormantWorkerAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.ManagedTests()
        self.f.setUp()
        self.addCleanup(self.f.tearDown)
        self.h, self.m = self.f.h, self.f.m
        self.now = 10000.0
        self.h.clock = lambda: self.now
        self.parent, self.parent_request, self.parent_offer, self.ctx = self.f.start_browser_turn()
        self.child, self.child_binding = self.f.enroll(self.parent)
        self.run_id = self.ctx['run']['id']
        self.claim_id = self.ctx['request']['claim_id']

    def edit(self, statement, parameters=()):
        with closing(self.h.state.connect()) as db:
            db.execute(statement, parameters)
            db.commit()

    def settings(self, **changes):
        with closing(self.h.state.connect()) as db:
            settings = json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?', (self.child,)).fetchone()[0])
        settings.update(changes)
        self.edit('UPDATE managed_pages SET settings=? WHERE page_id=?', (json.dumps(settings), self.child))

    def stale(self):
        self.edit('UPDATE managed_pages SET seen=? WHERE page_id=?', (self.now - 301, self.child))

    def projection(self, target=None):
        with closing(self.h.state.connect()) as db:
            return self.h.team.carriers.projection(db, self.h.binding(db, target=target or self.child))

    def team(self, op, payload, key=None, actor=None):
        actor = actor or self.parent
        return self.h.private(self.f.f.key, {'action': 'team', 'store_id': self.h.state.id,
            'target_id': actor, 'session_id': self.f.sessions[actor], 'op': op,
            'operation_id': key or str(uuid.uuid4()), 'payload': payload})

    def assign(self, key=None, **changes):
        payload = {'run_id': self.run_id, 'claim_id': self.claim_id, 'target': self.child,
            'text': 'Verify the assigned independent proof using the approved local files; preserve the original request and return the complete result.',
            'depends_on': [], 'resources': [], **changes}
        return self.team('assign', payload, key)

    def ledger(self):
        with closing(self.h.state.connect()) as db:
            run = db.execute('SELECT dispatches,deadline,max_dispatches FROM host_runs WHERE id=?', (self.run_id,)).fetchone()
            return {'budget': tuple(run), 'attempts': db.execute('SELECT COUNT(*) FROM control_attempts').fetchone()[0],
                'leases': db.execute('SELECT COUNT(*) FROM host_team_leases').fetchone()[0],
                'requests': db.execute('SELECT COUNT(*) FROM host_requests').fetchone()[0]}

    def child_claim(self, request):
        return self.h.private(self.f.f.key, {'action': 'claim', 'store_id': self.h.state.id,
            'target_id': self.child, 'session_id': self.f.sessions[self.child],
            'request_id': request, 'claim_id': 'clw-isolated-claim-' + uuid.uuid4().hex})

    def assert_admission_rejected(self, pattern='team_worker_carrier_unverified', **changes):
        before = self.ledger()
        with self.assertRaisesRegex(HarnessError, pattern):
            self.assign(**changes)
        self.assertEqual(self.ledger(), before)
        self.assertEqual(self.f.f.bridge.posts, [])

    def test_stale_bound_worker_cannot_claim_or_dispatch_queued_work(self):
        self.stale()
        self.assertFalse(self.projection()['runnable'])
        self.assertTrue(self.projection()['queueable'])
        assigned=self.assign()
        before=self.ledger()
        with self.assertRaisesRegex(HarnessError,'team_request_not_runnable'):
            self.child_claim(assigned['request_id'])
        self.assertEqual(self.ledger(),before)
        self.assertEqual(self.f.f.bridge.posts,[])

    def test_runnable_fresh_300_second_boundary_is_unchanged(self):
        for age, runnable in ((0, True), (300, True), (300.001, False), (-0.001, False)):
            with self.subTest(age=age):
                self.edit('UPDATE managed_pages SET seen=? WHERE page_id=?', (self.now - age, self.child))
                self.assertEqual(self.projection()['runnable'], runnable)

    def test_current_source_queues_dormant_worker_without_claim_attempt_send_or_budget_spend(self):
        self.stale()
        carrier = self.projection()
        self.assertTrue(carrier['queueable'])
        self.assertFalse(carrier['runnable'])
        before = self.ledger()
        result = self.assign(key='original-dormant-assignment')
        self.assertEqual(result['state'], 'queued_original_host_request')
        self.assertFalse(result['model_called'])
        after = self.ledger()
        self.assertEqual(after, {**before, 'requests': before['requests'] + 1})
        self.assertEqual(self.assign(key='original-dormant-assignment'), result)
        with self.assertRaises(HarnessError):
            self.assign(key='original-dormant-assignment', text='Changed replay must not replace original queued work.')
        with self.assertRaisesRegex(HarnessError, 'team_request_not_runnable'):
            self.child_claim(result['request_id'])
        with closing(self.h.state.connect()) as db:
            request = db.execute('SELECT * FROM host_requests WHERE id=?', (result['request_id'],)).fetchone()
            self.assertEqual(request['phase'], 'queued')
            self.assertIsNone(request['claim_id'])
            self.assertFalse(self.h.team.ready(db, request))
        self.assertEqual(self.ledger(), after)
        self.assertEqual(self.f.f.bridge.posts, [])

    def test_fresh_real_protocol_pulse_then_dispatch_uses_original_queued_identity_once(self):
        self.stale()
        result = self.assign()
        before = self.ledger()
        offer = self.f.wire(self.child, 'pulse')
        self.assertEqual(offer['state'], 'offer')
        self.assertEqual(offer['request_id'], result['request_id'])
        self.assertTrue(self.projection()['runnable'])
        dispatch = self.f.wire(self.child, 'dispatch', attempt_id=offer['attempt_id'])
        self.assertTrue(dispatch['dispatch'])
        self.assertEqual(self.ledger()['budget'][0], before['budget'][0] + 1)
        sent = {**PAGE, 'model_label': 'GPT-6 Astra Pro', 'effort_label': '最高', 'user_hash': 'b'*64, 'generating': True}
        self.f.wire(self.child, 'sent', attempt_id=offer['attempt_id'], page=sent, assistant_before_hash='c'*64)
        context = self.f.private(self.child, 'context', {})
        self.assertEqual(context['request']['id'], result['request_id'])
        with self.assertRaisesRegex(HarnessError, 'control_dispatch_already_committed_no_retry'):
            self.f.wire(self.child, 'dispatch', attempt_id=offer['attempt_id'])
        self.assertEqual(self.ledger()['budget'][0], before['budget'][0] + 1)

    def test_fresh_unsafe_dom_and_wrong_model_cannot_offer_a_queued_request(self):
        self.stale()
        self.assign()
        before = self.ledger()
        for change in ({'draft': True}, {'generating': True}, {'composing': True},
                       {'controls_known': False}, {'model_label': 'GPT-5.6 Sol'}, {'effort_label': 'Extra High'}):
            with self.subTest(change=change):
                page = {**PAGE, 'model_label': 'GPT-6 Astra Pro', 'effort_label': '最高', **change}
                result = self.f.wire(self.child, 'pulse', page=page)
                self.assertEqual(result['state'], 'page_not_safe_or_model_mismatch')
                self.assertEqual(self.ledger(), before)

    def test_paused_child_is_not_queueable(self):
        self.stale()
        self.m.browser('pause', {'page_id': self.child, 'paused': True})
        self.assertFalse(self.projection()['queueable'])
        self.assert_admission_rejected()

    def test_operator_parent_pause_is_inherited_at_queue_admission(self):
        self.stale()
        self.m.browser('pause', {'page_id': self.parent, 'paused': True})
        self.assertFalse(self.projection()['queueable'])
        self.assert_admission_rejected()

    def test_maintenance_holding_rejects_before_run_state_changes(self):
        self.stale()
        status = self.m.browser('maintenance', {'page_id': self.parent, 'action': 'quiesce', 'operation_id': 'hold-original-run'})
        self.assertEqual(status['state'], 'holding')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM host_runs WHERE id=?', (self.run_id,)).fetchone()[0], 'running')
        self.assert_admission_rejected('team_maintenance_no_new_work')

    def test_disabled_binding_is_not_queueable(self):
        self.stale()
        self.edit('UPDATE host_bindings SET enabled=0 WHERE target_id=?', (self.child,))
        self.assertFalse(self.projection()['queueable'])
        self.assert_admission_rejected()

    def test_pending_formal_model_is_not_queueable(self):
        self.stale()
        self.settings(work_model_pending=True)
        self.assertFalse(self.projection()['queueable'])
        self.assert_admission_rejected()

    def test_invalid_account_is_not_queueable(self):
        self.stale()
        self.settings(account='other-account')
        self.assertFalse(self.projection()['queueable'])
        self.assert_admission_rejected()

    def test_changed_receiver_session_is_not_queueable(self):
        self.stale()
        self.edit('UPDATE threads SET native_id=? WHERE id=?', ('mcp-host/wc_sess_different_receiver', self.child_binding['thread_id']))
        self.assertFalse(self.projection()['queueable'])
        self.assert_admission_rejected()

    def test_foreign_worker_owner_and_wrong_controller_claim_are_rejected(self):
        other_parent, _ = self.f.enroll()
        foreign, _ = self.f.enroll(other_parent)
        self.assert_admission_rejected('team_not_owned_conversation', target=foreign)
        self.assert_admission_rejected('team_original_controller_claim_required', claim_id='wrong-controller-claim')

    def test_receiver_enrolled_first_task_keeps_fresh_admission_and_rejects_stale(self):
        self.edit("UPDATE managed_pages SET phase='receiver_enrolled',bootstrap_state='sent',seen=? WHERE page_id=?", (self.now, self.child))
        self.settings(first_turn_mode='task_v1', bootstrap_model_verified=True, work_model_pending=False)
        self.stale()
        carrier = self.projection()
        self.assertFalse(carrier['runnable'])
        self.assertNotIn('queueable', carrier)
        self.assert_admission_rejected()
        self.edit('UPDATE managed_pages SET seen=? WHERE page_id=?', (self.now, self.child))
        carrier = self.projection()
        self.assertTrue(carrier['runnable'])
        self.assertNotIn('queueable', carrier)
        queued = self.assign()
        before = self.ledger()
        with self.assertRaisesRegex(HarnessError, 'managed_page_not_ready'):
            self.f.wire(self.child, 'pulse')
        self.stale()
        with self.assertRaisesRegex(HarnessError, 'team_request_not_runnable'):
            self.child_claim(queued['request_id'])
        self.assertEqual(self.ledger(), before)

    def test_nonmanaged_logical_receiver_keeps_original_runnable_gate(self):
        self.edit('DELETE FROM managed_pages WHERE page_id=?', (self.child,))
        carrier = self.projection()
        self.assertNotIn('queueable', carrier)
        self.assertFalse(carrier['runnable'])
        self.assert_admission_rejected()


if __name__ == '__main__':
    unittest.main()
