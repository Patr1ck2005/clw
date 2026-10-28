"""Actual isolated Managed SQLite fixtures; no live SQL/browser/model actions."""
from contextlib import closing
from pathlib import Path
import hashlib
import json
import sqlite3
import sys
import unittest
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'scripts'), str(Path(__file__).parent)]
import test_harness_managed_first_task as fixture
from harness_bootstrap_query_reset import candidate
from harness_state import canonical


class BootstrapQueryResetTests(unittest.TestCase):
    def setUp(self):
        self.first = fixture.FirstTaskTests()
        self.first.setUp()
        self.f, self.m = self.first.f, self.first.m
        self.h = self.f.h
        self.parent, _ = self.first.receive(account='A', access='write', write_paths=['.'])
        self.started = self.f.private(self.parent, 'first-task', {})
        self.page, _ = self.f.reserve(self.parent, first_turn_mode='task_v1',
                                     first_turn_instructions='Implement and verify the original complete worker task.')
        self.m.browser('page-issue', {'page_id': self.page, 'kind': 'control_failed', 'detail': 'Original app query found no menu.'})

    def tearDown(self):
        self.first.tearDown()

    def mutate(self, sql, args=()):
        with closing(self.h.state.connect()) as db:
            db.execute(sql, args)
            db.commit()

    def settings(self, **updates):
        with closing(self.h.state.connect()) as db:
            value = json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?', (self.page,)).fetchone()[0])
            value.update(updates)
            db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?', (canonical(value), self.page))
            db.commit()

    @staticmethod
    def snapshot(db):
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        counts = {name: db.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in tables}
        digest = hashlib.sha256('\n'.join(db.iterdump()).encode()).hexdigest()
        return counts, digest

    def check(self, page_id=None):
        with closing(self.h.state.connect()) as db:
            before = self.snapshot(db)
            queries = []
            db.set_trace_callback(queries.append)
            result = candidate(self.m, db, self.page if page_id is None else page_id)
            db.set_trace_callback(None)
            self.assertEqual(self.snapshot(db), before)
            self.assertTrue(queries)
            self.assertTrue(all(sql.lstrip().upper().startswith('SELECT ') for sql in queries), queries)
            self.assertFalse(any('IS NULL' in sql.upper() for sql in queries))
            return result

    def test_original_reserved_worker_is_eligible_with_bounded_digest_only_projection(self):
        result = self.check()
        self.assertTrue(result['eligible'])
        self.assertEqual(result['code'], 'bootstrap_query_reset_eligible')
        self.assertEqual(set(result), {'eligible', 'code', 'page_id', 'account', 'root', 'phase', 'bootstrap_state',
                                       'thread_id', 'own_paused', 'issue_kind', 'budget_admitted', 'contract_sha256'})
        self.assertEqual(result['page_id'], self.page)
        self.assertEqual(result['account'], 'A')
        self.assertEqual(result['phase'], 'reserved')
        self.assertEqual(result['bootstrap_state'], 'pending')
        self.assertIsNone(result['thread_id'])
        self.assertTrue(result['own_paused'])
        self.assertFalse(result['budget_admitted'])
        self.assertRegex(result['contract_sha256'], r'^[0-9a-f]{64}$')
        self.assertNotIn('original complete worker task', canonical(result))
        self.assertNotIn('clwm_', canonical(result))
        # The active parent's original Host request is deliberately not this
        # reserved child's request and must not become a NULL-wide denial.
        self.assertTrue(self.started['request']['id'])

    def test_select_only_authorizer_accepts_the_check(self):
        with closing(self.h.state.connect()) as db:
            allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION}
            db.set_authorizer(lambda action, *_: sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY)
            self.assertTrue(candidate(self.m, db, self.page)['eligible'])

    def test_formal_browser_router_calls_candidate_without_changing_database(self):
        with closing(self.h.state.connect()) as db:
            before = self.snapshot(db)
            expected = candidate(self.m, db, self.page)
            with patch('harness_bootstrap_query_reset.candidate', wraps=candidate) as checked:
                actual = self.m.browser('bootstrap-query-reset-check', {'page_id': self.page})
            checked.assert_called_once()
            self.assertIs(checked.call_args.args[0], self.m)
            self.assertEqual(checked.call_args.args[2], self.page)
            self.assertEqual(actual, expected)
            self.assertTrue(actual['eligible'])
            self.assertEqual(self.snapshot(db), before)

    def test_critical_contract_changes_but_seen_and_parent_phase_do_not(self):
        original = self.check()['contract_sha256']
        self.mutate('UPDATE managed_pages SET seen=seen+100 WHERE page_id=?', (self.page,))
        self.mutate("UPDATE managed_pages SET phase='receiver_enrolled',paused=1 WHERE page_id=?", (self.parent,))
        self.mutate("UPDATE host_requests SET phase='suspended' WHERE id=?", (self.started['request']['id'],))
        self.assertEqual(self.check()['contract_sha256'], original)
        changes = [({'first_turn_instructions': 'Changed complete task.'}, None),
                   ({'write_paths': ['notes']}, None), ({'resources': ['renderer']}, None),
                   ({'first_task_parent': {'request_id': 'other-request', 'claim_id': 'other-claim', 'run_id': 'other-run'}}, None),
                   ({'bootstrap_model_selection': {'model': 'Other', 'effort': 'Pro'}}, None),
                   ({'account': 'B'}, None), ({'duration_seconds': 200}, None),
                   (None, ('UPDATE managed_pages SET bootstrap_text=bootstrap_text||? WHERE page_id=?', ('changed', self.page))),
                   (None, ('UPDATE managed_pages SET model=? WHERE page_id=?', ('other-model', self.page))),
                   (None, ('UPDATE managed_pages SET parent_target=? WHERE page_id=?', ('other-parent', self.page)))]
        for settings, sql in changes:
            with self.subTest(settings=settings, sql=sql):
                before = self.check()['contract_sha256']
                self.settings(**settings) if settings else self.mutate(*sql)
                self.assertNotEqual(self.check()['contract_sha256'], before)

    def test_normalized_settings_order_does_not_change_hash(self):
        before = self.check()['contract_sha256']
        with closing(self.h.state.connect()) as db:
            settings = json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?', (self.page,)).fetchone()[0])
            db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?', (json.dumps(dict(reversed(list(settings.items()))), indent=2), self.page))
            db.commit()
        self.assertEqual(self.check()['contract_sha256'], before)

    def test_missing_page_has_no_authority(self):
        result = self.check('web-missing')
        self.assertFalse(result['eligible'])
        self.assertEqual(result['code'], 'page_missing')
        self.assertIsNone(result['contract_sha256'])

    def test_phase_pause_issue_and_thread_guards(self):
        cases = [("UPDATE managed_pages SET phase='bound' WHERE page_id=?", 'reservation_not_reserved'),
                 ("UPDATE managed_pages SET paused=0 WHERE page_id=?", 'reservation_not_paused'),
                 ("UPDATE managed_pages SET bootstrap_state='sent' WHERE page_id=?", 'bootstrap_not_pending'),
                 ("UPDATE managed_pages SET thread_id='original-thread' WHERE page_id=?", 'original_thread_present'),
                 ("UPDATE managed_page_issues SET kind='user_stopped' WHERE page_id=?", 'issue_not_control_failed')]
        for sql, code in cases:
            with self.subTest(code=code):
                with closing(self.h.state.connect()) as db:
                    db.execute('BEGIN')
                    db.execute(sql, (self.page,))
                    result = candidate(self.m, db, self.page)
                    self.assertFalse(result['eligible'])
                    self.assertEqual(result['code'], code)
                    db.rollback()
        self.mutate('DELETE FROM managed_page_issues WHERE page_id=?', (self.page,))
        self.assertEqual(self.check()['code'], 'issue_not_control_failed')

    def test_budget_admission_and_each_timestamp_block_reset_even_zero_or_null(self):
        self.mutate('INSERT INTO managed_bootstrap_budget VALUES(?,?)', (self.page, self.started['run']['id']))
        self.assertEqual(self.check()['code'], 'bootstrap_budget_admitted')
        self.assertTrue(self.check()['budget_admitted'])
        self.mutate('DELETE FROM managed_bootstrap_budget WHERE page_id=?', (self.page,))
        for key in ('bootstrap_sending_at', 'bootstrap_sent_at', 'bootstrap_unknown_at'):
            for value in (None, 0, 1):
                with self.subTest(key=key, value=value), closing(self.h.state.connect()) as db:
                    settings = json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?', (self.page,)).fetchone()[0])
                    settings[key] = value
                    db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?', (canonical(settings), self.page))
                    self.assertEqual(candidate(self.m, db, self.page)['code'], 'bootstrap_send_evidence_present')
                    db.rollback()

    def test_original_stop_is_blocking_until_explicitly_resumed(self):
        self.mutate('INSERT INTO managed_stops VALUES(?,?,?,0)', (self.page, 'a' * 64, 'b' * 64))
        self.assertEqual(self.check()['code'], 'original_stop_not_resumed')
        self.mutate('UPDATE managed_stops SET resumed=1 WHERE page_id=?', (self.page,))
        self.assertTrue(self.check()['eligible'])

    def test_handoff_from_or_to_original_page_is_blocking(self):
        for direction in ('source', 'successor'):
            with self.subTest(direction=direction), closing(self.h.state.connect()) as db:
                source, successor = (self.page, 'other') if direction == 'source' else ('other', self.page)
                db.execute('INSERT INTO managed_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                           ('handoff', source, 'source-request', 'source-thread', 'source-attempt', 'source-claim',
                            successor, 'successor-request', 'run', '{}', 'enrolling', 1))
                self.assertEqual(candidate(self.m, db, self.page)['code'], 'original_handoff_present')
                db.rollback()

    def test_exact_partial_target_or_recorded_request_blocks_without_a_thread(self):
        self.mutate('INSERT INTO host_bindings VALUES(?,?,?,?,?,?)', (self.page, 'partial-thread', '{}', 1, None, 0))
        self.mutate('INSERT INTO host_requests VALUES(?,?,?,?,?,?,?,?)', ('partial-request', 'partial-thread', 'private body', 'queued', None, 0, 'date', None))
        self.assertEqual(self.check()['code'], 'original_host_request_present')
        self.mutate('DELETE FROM host_bindings WHERE target_id=?', (self.page,))
        self.assertTrue(self.check()['eligible'])
        self.settings(first_task_request_id='partial-request')
        self.assertEqual(self.check()['code'], 'original_host_request_present')

    def test_invalid_settings_and_bounded_projection_fail_closed(self):
        for value in ('not-json', '[]', '{"first_turn_instructions":[]}'):
            with self.subTest(value=value), closing(self.h.state.connect()) as db:
                db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?', (value, self.page))
                result = candidate(self.m, db, self.page)
                self.assertFalse(result['eligible'])
                self.assertEqual(result['code'], 'invalid_settings')
                db.rollback()
        self.mutate('UPDATE managed_pages SET root=? WHERE page_id=?', ('r' * 9000, self.page))
        self.assertEqual(len(self.check()['root']), 4096)


if __name__ == '__main__':
    unittest.main()
