"""Stopped connection failures release leases without manufacturing task success."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch

from tests import test_native_work_admission as fixture
from native_work_admission import (AdmissionError, cancel_before_start, conflicts_pure_scope,
                                   start, status)
from native_work_interruption import connection_failure_evidence, recover_interrupted


class InterruptedAdmissionTests(unittest.TestCase):
    setUp = fixture.NativeAdmissionTests.setUp
    package = fixture.NativeAdmissionTests.package

    def running_package(self):
        directory, claim = self.package('network')
        start(self.db, claim['claim_id'], 1001)
        return directory, claim

    def recover(self, directory, **overrides):
        arguments = dict(owner_probe=lambda _: False, process_probe=lambda *_: True,
                         runtime_probe=lambda: True,
                         evidence_probe=lambda _: {'thread': 'same-original', 'eventsSha256': 'same'})
        arguments.update(overrides)
        return recover_interrupted(self.db, directory, **arguments)

    def test_games_scope_remains_blocked_until_stopped_diagnostic_is_reconciled(self):
        directory, claim = self.running_package()
        games = {'root': str(self.root), 'access': 'write', 'write_paths': '["."]',
                 'resources': '[]', 'git': {'common_dir': None}}
        with closing(sqlite3.connect(self.db)) as db:
            db.row_factory = sqlite3.Row
            self.assertTrue(conflicts_pure_scope(db, games))
        result = self.recover(directory)
        self.assertEqual(result['taskOutcome'], 'interrupted_unverified')
        self.assertFalse(result['automaticReplay'])
        self.assertFalse((directory / 'final.md').exists())
        with closing(sqlite3.connect(self.db)) as db:
            db.row_factory = sqlite3.Row
            self.assertFalse(conflicts_pure_scope(db, games))
            audit = db.execute('SELECT kind,evidence FROM native_work_recoveries').fetchone()
            self.assertEqual(audit['kind'], 'interrupted_connection_failure')
            self.assertEqual(json.loads(audit['evidence'])['taskOutcome'], 'interrupted_unverified')

    def test_live_or_unknown_executor_and_active_tools_keep_original_lease(self):
        directory, _ = self.running_package()
        for overrides in ({'owner_probe': lambda _: True}, {'owner_probe': lambda _: None},
                          {'process_probe': lambda *_: False}, {'runtime_probe': lambda: False}):
            with self.subTest(overrides=overrides), self.assertRaises(AdmissionError):
                self.recover(directory, **overrides)
            self.assertEqual(status(self.db, directory)['state'], 'running')

    def test_changed_evidence_does_not_release(self):
        directory, _ = self.running_package()
        counter = iter(['before', 'after'])
        with self.assertRaisesRegex(AdmissionError, 'evidence_changed'):
            self.recover(directory, evidence_probe=lambda _: {'thread': 'same', 'hash': next(counter)})
        self.assertEqual(status(self.db, directory)['state'], 'running')

    def test_running_owner_cannot_use_pre_send_cancellation(self):
        directory, claim = self.running_package()
        with self.assertRaisesRegex(AdmissionError, 'original_pre_send_owner_required'):
            cancel_before_start(self.db, claim['claim_id'], 1001)
        self.assertEqual(status(self.db, directory)['state'], 'running')

    def test_real_event_parser_rejects_tools_refusal_or_missing_native_start(self):
        directory, claim = self.running_package()
        record = {'admissionId': claim['claim_id'], 'ownerPid': 1001,
                  'resultDirectory': str(directory), 'state': 'running',
                  'sourceThread': 'original', 'startedAt': '2026-09-28T00:00:00Z'}
        (directory / 'execution.json').write_text(json.dumps(record), encoding='utf8')
        events = [{'type': 'thread.started', 'thread_id': 'original'}, {'type': 'turn.started'},
                  {'type': 'error', 'message': 'Reconnecting... waiting for network (Connection failed: error sending request)'}]
        source = self.root / 'native.jsonl'
        native_rows = [{'type': 'session_meta', 'payload': {'id': 'original', 'cwd': str(self.a)}},
                       {'timestamp': '2026-09-28T00:00:01Z', 'type': 'event_msg',
                        'payload': {'type': 'task_started'}}]
        source.write_text('\n'.join(map(json.dumps, native_rows))+'\n', encoding='utf8')
        def write(items):
            (directory / 'events.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in items), encoding='utf8')
        with closing(sqlite3.connect(self.db)) as db:
            db.row_factory = sqlite3.Row
            row = dict(db.execute('SELECT * FROM native_work_claims').fetchone())
        with patch('read_codex_web_task.native_evidence', return_value={
                'state': 'observed', 'tools': {}, 'source': str(source)}):
            write(events)
            self.assertEqual(connection_failure_evidence(row)['connectionErrors'], 1)
            source.write_text('\n'.join(map(json.dumps, native_rows + [{
                'timestamp': '2026-09-28T00:00:02Z', 'type': 'response_item',
                'payload': {'type': 'future_action'},
            }]))+'\n', encoding='utf8')
            with self.assertRaisesRegex(AdmissionError, 'tools_require_terminal'):
                connection_failure_evidence(row)
            source.write_text('\n'.join(map(json.dumps, native_rows + [{
                'timestamp': '2026-09-28T00:00:02Z', 'type': 'event_msg',
                'payload': {'type': 'item_completed', 'item': {'type': 'CommandExecution'}},
            }]))+'\n', encoding='utf8')
            with self.assertRaisesRegex(AdmissionError, 'tools_require_terminal'):
                connection_failure_evidence(row)
            source.write_text('\n'.join(map(json.dumps, native_rows))+'\n', encoding='utf8')
            for item in ({'type': 'item.completed', 'item': {'type': 'command_execution'}},
                         {'type': 'error', 'message': 'This tool call was blocked by OpenAI'}):
                write(events + [item])
                with self.assertRaises(AdmissionError):
                    connection_failure_evidence(row)
            write(events)
            with patch('native_work_admission.zero_local_jobs', side_effect=AssertionError('unrelated Runner')):
                recovered = recover_interrupted(self.db, directory, owner_probe=lambda _: False,
                                                process_probe=lambda *_: True)
            self.assertEqual(recovered['state'], 'released')
            with closing(sqlite3.connect(self.db)) as database:
                audit = json.loads(database.execute('SELECT evidence FROM native_work_recoveries').fetchone()[0])
            self.assertTrue(audit['nativeToolsVerifiedAbsent'])
            self.assertNotIn('runtimeQuiet', audit)
            source.write_text('', encoding='utf8')
            with self.assertRaisesRegex(AdmissionError, 'turn_start_unverified'):
                connection_failure_evidence(row)


if __name__ == '__main__':
    unittest.main()
