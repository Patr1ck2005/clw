"""Use the actual native verifier to separate native failure from Workflow Jobs."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from native_work_admission import AdmissionError, mark_terminal, poll, request, settle, start, status
from test_native_work_admission import journal

THREAD = '01a0f330-0000-7000-8000-000000000001'
TURN = '01a0f330-0001-7000-8000-000000000002'


class ToolFreeSettlementTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='clw-tool-free-')
        self.addCleanup(temp.cleanup); self.root = Path(temp.name)
        self.workspace = self.root / 'game'; self.workspace.mkdir()
        self.db = self.root / 'harness.sqlite3'; journal(self.db)
        self.result = self.root / 'result'; self.result.mkdir()
        self.claim = request(self.db, workspace=str(self.workspace), result_path=str(self.result), owner_pid=1001)
        start(self.db, self.claim['claim_id'], 1001)
        (self.result / 'execution.json').write_text(json.dumps({
            'admissionId': self.claim['claim_id'], 'resultDirectory': str(self.result),
            'ownerPid': 1001, 'sourceThread': THREAD, 'state': 'needs_attention', 'exitCode': 1,
            'startedAt': '2026-09-30T17:02:00Z', 'endedAt': '2026-09-30T17:03:00Z',
        }), encoding='utf8')
        (self.result / 'events.jsonl').write_text('\n'.join(map(json.dumps, [
            {'type': 'thread.started', 'thread_id': THREAD}, {'type': 'turn.failed', 'error': {'message': 'model unavailable'}},
        ])) + '\n', encoding='utf8')
        self.home = self.root / 'codex'; self.session = self.home / 'sessions/2026/09/30' / ('rollout-' + THREAD + '.jsonl')
        self.session.parent.mkdir(parents=True)
        self.native()
        mark_terminal(self.db, self.claim['claim_id'], 1001)
        self.environment = patch.dict(os.environ, {'CODEX_HOME': str(self.home)})
        self.environment.start(); self.addCleanup(self.environment.stop)
        self.owner = patch('native_work_interruption._owner_live', return_value=False)
        self.owner.start(); self.addCleanup(self.owner.stop)

    def native(self, *, action=None, cwd=None, ended='2026-09-30T17:02:08Z', final=False):
        def row(kind, payload, second):
            return {'type': kind, 'timestamp': second, 'payload': payload}
        rows = [row('session_meta', {'id': THREAD, 'cwd': str(cwd or self.workspace)}, '2026-09-30T17:01:00Z'),
                row('event_msg', {'type': 'task_started', 'turn_id': TURN}, '2026-09-30T17:02:05Z')]
        if action:
            rows.append(row('response_item', action, '2026-09-30T17:02:06Z'))
        rows.append(row('event_msg', {'type': 'task_complete', 'turn_id': TURN,
                    'last_agent_message': 'done' if final else None,
                    'error': None if final else {'message': 'model unavailable'}}, ended))
        self.session.write_text('\n'.join(map(json.dumps, rows)) + '\n', encoding='utf8')

    def test_tool_free_failure_releases_queue_without_probing_unrelated_jobs(self):
        waiting = self.root / 'waiting'; waiting.mkdir()
        queued = request(self.db, workspace=str(self.workspace), result_path=str(waiting), owner_pid=1002)
        self.assertEqual(queued['state'], 'queued')
        result = settle(self.db, self.result, job_probe=lambda: self.fail('unrelated Workflow Jobs were queried'))
        self.assertTrue(result['nativeToolsVerifiedAbsent'])
        self.assertNotIn('localJobsVerifiedZero', result)
        self.assertEqual(poll(self.db, queued['claim_id'], 1002)['state'], 'reserved')
        with closing(sqlite3.connect(self.db)) as db:
            kind, evidence = db.execute('SELECT kind,evidence FROM native_work_recoveries').fetchone()
            self.assertEqual(kind, 'native_failed_without_tools')
            self.assertEqual(json.loads(evidence)['observedToolCalls'], 0)

    def test_actual_or_future_native_actions_keep_the_lease_when_jobs_are_busy(self):
        for action in [{'type': 'function_call', 'name': 'exec_command', 'call_id': 'call1', 'arguments': '{}'},
                       {'type': 'custom_tool_call', 'name': 'apply_patch', 'call_id': 'call2', 'input': 'patch'},
                       {'type': 'future_action'}]:
            with self.subTest(action=action['type']):
                self.native(action=action)
                with self.assertRaisesRegex(AdmissionError, 'local_jobs_active_or_unknown'):
                    settle(self.db, self.result, job_probe=lambda: False)
                self.assertEqual(status(self.db, self.result)['state'], 'terminal_pending')

    def test_prior_final_followed_by_error_releases_as_tool_free_failure_without_overwriting_receipts(self):
        self.native(action={'type': 'message', 'role': 'assistant', 'phase': 'final_answer',
                            'content': [{'type': 'output_text', 'text': 'An earlier assistant result'}]})
        originals={path:path.read_bytes() for path in (self.session,self.result/'execution.json',self.result/'events.jsonl')}
        result=settle(self.db,self.result,job_probe=lambda:self.fail('unrelated Workflow Jobs were queried'))
        self.assertEqual(result['state'],'released');self.assertTrue(result['nativeToolsVerifiedAbsent'])
        self.assertEqual({path:path.read_bytes() for path in originals},originals)
        self.assertEqual(json.loads((self.result/'execution.json').read_text('utf8'))['state'],'needs_attention')
        self.assertFalse((self.result/'final.md').exists())
        with closing(sqlite3.connect(self.db)) as db:
            kind,evidence=db.execute('SELECT kind,evidence FROM native_work_recoveries').fetchone()
        self.assertEqual(kind,'native_failed_without_tools')
        self.assertEqual(json.loads(evidence)['observedToolCalls'],0);self.assertFalse(json.loads(evidence)['automaticReplay'])

    def test_wrong_workspace_or_terminal_window_cannot_release(self):
        for options in [{'cwd': self.root / 'other'}, {'ended': '2026-09-30T17:04:00Z'}, {'final': True}]:
            with self.subTest(options=options):
                self.native(**options)
                with self.assertRaisesRegex(AdmissionError, 'local_jobs_active_or_unknown'):
                    settle(self.db, self.result, job_probe=lambda: False)

    def test_live_original_owner_cannot_use_tool_free_release(self):
        with patch('native_work_interruption._owner_live', return_value=True):
            with self.assertRaisesRegex(AdmissionError, 'local_jobs_active_or_unknown'):
                settle(self.db, self.result, job_probe=lambda: False)


if __name__ == '__main__':
    unittest.main()
