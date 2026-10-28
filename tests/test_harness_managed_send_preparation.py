"""Original SQLite/Host contracts, without a browser, model or game operation."""
from pathlib import Path
from contextlib import closing
import copy
import hashlib
import json
import sys
import unittest
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'scripts'), str(Path(__file__).parent)]
import test_harness_managed as fixture
from test_harness_control_plane import PAGE
from harness_state import HarnessError
import harness_managed_send_preparation as recovery


class PreparedSendRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.ManagedTests()
        self.f.setUp()
        self.now = [1000.]
        self.f.h.clock = lambda: self.now[0]

    def tearDown(self):
        self.f.tearDown()

    def original(self):
        f = self.f
        page, request, original, context = f.start_browser_turn()
        failed = {**PAGE, 'model_label': 'GPT-6 Astra Pro', 'effort_label': '最高',
                  'user_hash': 'b' * 64, 'failure_kind': 'generation_failed', 'failure_hash': 'f' * 64}
        f.wire(page, 'pulse', page=failed)
        self.now[0] += 300
        offer = f.wire(page, 'pulse', page=failed)
        grant = f.wire(page, 'dispatch', page=failed, attempt_id=offer['attempt_id'])
        prompt_hash = recovery.sha(grant['prompt'])
        f.m.browser('prepare', {'page_id': page, 'attempt_id': offer['attempt_id'],
                               'assistant_before_hash': 'd' * 64, 'prompt_hash': prompt_hash})
        row = next(row for row in f.m.browser('list', {})['pages'] if row['page_id'] == page)
        browser = {'url': row['url'], 'account': 'B', 'model': row['model'], 'effort': row['effort'],
                   'user_turn_sha256': 'b' * 64, 'assistant_turn_sha256': 'd' * 64,
                   'attempt_marker': '[CLW:' + offer['attempt_id'] + ']', 'attempt_marker_count': 0,
                   'editor_ready': True, 'controls_known': True, 'history_at_latest': True,
                   'generating': False, 'composing': False, 'approval_required': False,
                   'access_limited': False, 'blocked': False, 'login_required': False, 'stopped': False,
                   'composer': {'editor_count': 1, 'text_bytes': 12,
                                'text_sha256': recovery.sha('@Local-MCP-B'), 'selected': []}}
        proof = {'page_id': page, 'thread_id': row['thread_id'], 'request_id': request, 'attempt_id': offer['attempt_id'],
                 'account': 'B', 'url': row['url'], 'document_generation': 1, 'connection_generation': 1,
                 'user_turn_sha256': 'b' * 64, 'assistant_turn_sha256': 'd' * 64,
                 'marker': browser['attempt_marker'], 'stage': 'connector-preparation',
                 'send_invoked': False, 'started_at': self.now[0] * 1000, 'at': self.now[0] * 1000 + 1,
                 'error_code': 'connector_not_available', 'known_not_sent': True}
        return {'page_id': page, 'url': row['url'], 'operation_id': 'preclick-recovery-000000000001',
                'expected_request_id': request, 'expected_attempt_id': offer['attempt_id'],
                'browser': browser, 'proof': proof}, grant, context

    def call(self, payload):
        return self.f.m.browser('reconcile-send-preparation', payload)

    def facts(self, payload):
        with closing(self.f.h.state.connect()) as db:
            tables = ('host_requests', 'control_attempts', 'managed_dispatches',
                      'control_browser_receipts', 'managed_tool_received', 'host_runs',
                      'host_team_dispatches', 'host_team_work', 'host_team_leases')
            return {table: [tuple(row) for row in db.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]
                    for table in tables}

    def count(self):
        with closing(self.f.h.state.connect()) as db:
            return db.execute('SELECT COUNT(*) FROM events WHERE kind=?', (recovery.KIND,)).fetchone()[0]

    def test_original_prepared_grant_once_preserves_attempt_claim_run_and_counted_dispatch(self):
        payload, grant, context = self.original()
        before = self.facts(payload)
        result = self.call(payload)
        self.assertTrue(result['authorized'])
        self.assertEqual(result['attempt_id'], payload['expected_attempt_id'])
        self.assertEqual(result['request_id'], context['request']['id'])
        self.assertEqual(result['prompt'], grant['prompt'])
        self.assertEqual(result['prompt_hash'], hashlib.sha256(grant['prompt'].encode()).hexdigest())
        self.assertEqual(result['previous_user_hash'], 'b' * 64)
        self.assertEqual(result['assistant_before_hash'], 'd' * 64)
        self.assertFalse(result['dispatch_repeated'])
        self.assertFalse(result['jobs_replayed'])
        self.assertEqual(self.facts(payload), before)
        repeated = self.call(payload)
        self.assertFalse(repeated['authorized'])
        self.assertTrue(repeated['authorization_already_issued'])
        self.assertNotIn('prompt', repeated)
        self.assertEqual(self.count(), 1)
        self.assertEqual(self.facts(payload), before)

    def test_same_proof_new_operation_cannot_reissue_and_same_operation_payload_conflicts(self):
        payload, _, _ = self.original()
        self.call(payload)
        with self.assertRaises(HarnessError):
            self.call({**payload, 'operation_id': 'preclick-recovery-000000000002'})
        modified = copy.deepcopy(payload)
        modified['browser']['composer'] = {'editor_count': 1, 'text_bytes': 0,
                                           'text_sha256': recovery.sha(''), 'selected': []}
        with self.assertRaises(HarnessError):
            self.call(modified)
        self.assertEqual(self.count(), 1)

    def test_unknown_sent_acknowledged_attempt_is_never_a_preclick_recovery(self):
        for state in ('unknown', 'sent', 'acknowledged', 'not_sent'):
            with self.subTest(state=state):
                payload, _, _ = self.original()
                with closing(self.f.h.state.connect()) as db:
                    db.execute('UPDATE control_attempts SET state=? WHERE id=?',
                               (state, payload['expected_attempt_id']))
                    db.commit()
                before = self.facts(payload)
                with self.assertRaises(HarnessError):
                    self.call(payload)
                self.assertEqual(self.facts(payload), before)
                self.assertEqual(self.count(), 0)

    def test_foreign_request_attempt_url_and_account_rejected(self):
        payload, _, _ = self.original()
        for change in ({'expected_request_id': 'other-request'}, {'expected_attempt_id': 'other-attempt'},
                       {'url': 'https://chatgpt.com/c/other'}):
            with self.subTest(change=change), self.assertRaises(HarnessError):
                self.call({**payload, **change})
        browser = {**payload['browser'], 'account': 'A'}
        with self.assertRaises(HarnessError):
            self.call({**payload, 'browser': browser})
        self.assertEqual(self.count(), 0)

    def test_public_baseline_marker_model_idle_and_user_draft_are_required(self):
        payload, _, _ = self.original()
        cases = ({'user_turn_sha256': 'c' * 64}, {'assistant_turn_sha256': 'e' * 64},
                 {'attempt_marker_count': 1}, {'attempt_marker_count': False},
                 {'attempt_marker': '[CLW:foreign]'}, {'model': 'GPT-5.5'},
                 {'effort': '高'}, {'history_at_latest': False}, {'controls_known': False},
                 *({key: True} for key in ('generating', 'composing', 'approval_required',
                                          'access_limited', 'blocked', 'login_required', 'stopped')),
                 {'composer': {'editor_count': 1, 'text_bytes': 12,
                               'text_sha256': recovery.sha('user message'), 'selected': []}},
                 {'composer': {'editor_count': True, 'text_bytes': 0,
                               'text_sha256': recovery.sha(''), 'selected': []}})
        for change in cases:
            with self.subTest(change=change), self.assertRaises(HarnessError):
                self.call({**payload, 'browser': {**payload['browser'], **change}})
        self.assertEqual(self.count(), 0)

    def test_caller_not_sent_without_private_positive_proof_is_rejected(self):
        payload, _, _ = self.original()
        for change in ({'send_invoked': True}, {'known_not_sent': False},
                       {'error_code': 'send_page_identity_changed'}, {'error_code': 'unknown'},
                       {'request_id': 'foreign'}, {'stage': 'send'}, {'at': 0},
                       {'document_generation': True}):
            with self.subTest(change=change), self.assertRaises(HarnessError):
                self.call({**payload, 'proof': {**payload['proof'], **change}})
        with self.assertRaises(HarnessError):
            self.call({**payload, 'proof': {'notSent': True}})
        with self.assertRaises(HarnessError):
            self.call({**payload, 'proof': {'legacy_incident': recovery.LEGACY_INCIDENT}})
        self.assertEqual(self.count(), 0)

    def test_empty_query_and_correct_owned_connector_pill_can_recover(self):
        payload, _, _ = self.original()
        payload['browser']['composer'] = {'editor_count': 1, 'text_bytes': 0,
                                          'text_sha256': recovery.sha(''), 'selected': ['Local-MCP-B']}
        self.assertTrue(self.call(payload)['authorized'])

    def test_pause_stop_scope_cancel_and_tool_receipt_preserve_original(self):
        mutations = (
            ("UPDATE managed_pages SET paused=1 WHERE page_id=?", 'page_id'),
            ("UPDATE host_requests SET cancel_requested=1 WHERE id=?", 'expected_request_id'),
            ("UPDATE host_runs SET state='closed' WHERE controller_request=?", 'expected_request_id'),
            ("UPDATE host_team_scopes SET root='changed' WHERE thread_id=(SELECT thread_id FROM managed_pages WHERE page_id=?)", 'page_id'),
            ("INSERT INTO managed_tool_received VALUES(?,0)", 'expected_attempt_id'),
        )
        for sql, key in mutations:
            with self.subTest(sql=sql):
                payload, _, _ = self.original()
                with closing(self.f.h.state.connect()) as db:
                    db.execute(sql, (payload[key],))
                    db.commit()
                before = self.facts(payload)
                with self.assertRaises(HarnessError):
                    self.call(payload)
                self.assertEqual(self.facts(payload), before)
        self.assertEqual(self.count(), 0)

    def test_new_positive_preclick_failure_after_original_authorization_can_recover_once(self):
        payload, _, _ = self.original()
        self.call(payload)
        stale = copy.deepcopy(payload)
        stale['operation_id'] = 'preclick-recovery-000000000002'
        stale['proof']['error_code'] = 'connector_selection_unconfirmed'
        with self.assertRaises(HarnessError):
            self.call(stale)
        self.now[0] += 1
        fresh = copy.deepcopy(stale)
        fresh['proof']['started_at'] = self.now[0] * 1000
        fresh['proof']['at'] = self.now[0] * 1000 + 1
        self.assertTrue(self.call(fresh)['authorized'])
        self.assertEqual(self.count(), 2)
        with self.assertRaises(HarnessError):
            self.call({**fresh, 'operation_id': 'preclick-recovery-000000000003'})

    def test_prepared_prompt_change_does_not_create_an_authorization(self):
        payload, _, _ = self.original()
        with closing(self.f.h.state.connect()) as db:
            db.execute('UPDATE managed_dispatches SET prompt_hash=? WHERE attempt_id=?',
                       ('e' * 64, payload['expected_attempt_id']))
            db.commit()
        with self.assertRaises(HarnessError):
            self.call(payload)
        self.assertEqual(self.count(), 0)

    def test_positive_preclick_authorizations_remain_bounded_to_ten(self):
        payload, _, _ = self.original()
        for ordinal in range(1, 11):
            self.now[0] += 1
            payload['operation_id'] = f'preclick-bounded-recovery-{ordinal:012d}'
            payload['proof']['started_at'] = self.now[0] * 1000
            payload['proof']['at'] = self.now[0] * 1000 + 1
            self.assertTrue(self.call(payload)['authorized'])
        self.now[0] += 1
        payload['operation_id'] = 'preclick-bounded-recovery-000000000011'
        payload['proof']['started_at'] = self.now[0] * 1000
        payload['proof']['at'] = self.now[0] * 1000 + 1
        with self.assertRaises(HarnessError):
            self.call(payload)
        self.assertEqual(self.count(), 10)

    def legacy_reloaded(self):
        payload, grant, context = self.original()
        payload['proof'] = {'legacy_incident': recovery.LEGACY_INCIDENT}
        stable = recovery.sha('managed-public:[CLW:original-failed-attempt]:failed-assistant:无法思考')
        payload['browser'].update(assistant_turn_sha256=stable,
                                  baseline_previous_marker='[CLW:original-failed-attempt]',
                                  baseline_previous_marker_count=1, failure='无法思考', complete=False)
        legacy = {**recovery.LEGACY, 'assistant_sha256': 'd' * 64, 'user_sha256': 'b' * 64,
                  'previous_attempt': 'original-failed-attempt'}
        # The real archive/source fence is exercised separately against the
        # original ledger copy. Here only that fence is stubbed; the original
        # ledger, current public guards and failed-turn rebase logic are real.
        return payload, grant, context, legacy

    def test_legacy_failed_turn_reload_rebases_only_prepared_assistant_with_audit(self):
        payload, grant, _, legacy = self.legacy_reloaded()
        before = self.facts(payload)
        with patch.object(recovery, 'LEGACY', legacy), patch.object(recovery, '_legacy',
                return_value=('f' * 64, self.now[0] * 1000)):
            result = self.call(payload)
            self.assertTrue(result['authorized'])
            self.assertTrue(result['assistant_baseline_rebased'])
            self.assertEqual(result['assistant_before_hash_previous'], 'd' * 64)
            self.assertEqual(result['assistant_before_hash'], payload['browser']['assistant_turn_sha256'])
            self.assertEqual(result['prompt'], grant['prompt'])
            self.assertFalse(self.call(payload)['authorized'])
        after = self.facts(payload)
        expected = copy.deepcopy(before)
        expected['managed_dispatches'] = [
            (row[0], payload['browser']['assistant_turn_sha256'], row[2])
            if row[0] == payload['expected_attempt_id'] else row
            for row in before['managed_dispatches']]
        self.assertEqual(after, expected)
        self.assertEqual(self.count(), 1)

    def test_legacy_reload_rejects_foreign_user_marker_complete_or_failure(self):
        payload, _, _, legacy = self.legacy_reloaded()
        before = self.facts(payload)
        changes = ({'user_turn_sha256': 'c' * 64}, {'baseline_previous_marker': '[CLW:foreign]'},
                   {'baseline_previous_marker_count': 0}, {'baseline_previous_marker_count': True},
                   {'failure': ''}, {'failure': 'access denied'}, {'complete': True}, {'complete': None},
                   {'assistant_turn_sha256': 'e' * 64},
                   {'assistant_turn_sha256': '58141b873d2ecd968e043f4077885a800b0315834a608045683fe114a5a7ff61'})
        with patch.object(recovery, 'LEGACY', legacy), patch.object(recovery, '_legacy',
                return_value=('f' * 64, self.now[0] * 1000)):
            for change in changes:
                with self.subTest(change=change), self.assertRaises(HarnessError):
                    self.call({**payload, 'browser': {**payload['browser'], **change}})
        self.assertEqual(self.facts(payload), before)
        self.assertEqual(self.count(), 0)

    def test_structured_failed_turn_marker_never_authorizes_assistant_rebase(self):
        payload, _, _ = self.original()
        payload['browser'].update(assistant_turn_sha256='e' * 64,
                                  baseline_previous_marker='[CLW:original-failed-attempt]',
                                  baseline_previous_marker_count=1, failure='无法思考', complete=False)
        payload['proof']['assistant_turn_sha256'] = 'e' * 64
        before = self.facts(payload)
        with self.assertRaises(HarnessError):
            self.call(payload)
        self.assertEqual(self.facts(payload), before)
        self.assertEqual(self.count(), 0)


if __name__ == '__main__':
    unittest.main()
