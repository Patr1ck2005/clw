import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from native_work_completion import completed_tools_evidence, failed_tools_evidence

THREAD = '01a10714-bd83-7830-87b6-3d663d9f8ba2'
TURN = '01a10714-c266-7e91-9feb-a6049a761218'


class CompletedToolsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.packet = self.root / 'packet'; self.packet.mkdir()
        self.sessions = self.root / 'sessions'
        day = self.sessions / '2026/10/04'; day.mkdir(parents=True)
        self.source = day / ('rollout-fixture-' + THREAD + '.jsonl')
        self.record = {'state': 'turn_completed', 'exitCode': 0, 'workspace': str(self.root),
                       'startedAt': '2026-10-04T13:22:38Z', 'endedAt': '2026-10-04T13:27:08Z'}
        (self.packet / 'execution.json').write_text(json.dumps(self.record),encoding='utf8')
        self.rows = [{'type': 'session_meta', 'payload': {'id': THREAD, 'cwd': str(self.root)}},
                     {'timestamp': '2026-10-04T13:22:40Z', 'type': 'event_msg',
                      'payload': {'type': 'task_started', 'turn_id': TURN}}]
        self.write_source()
        self.events = [{'type': 'thread.started', 'thread_id': THREAD}, {'type': 'turn.started'}, {'type': 'turn.completed'}]
        self.write_events()
        (self.packet / 'final.md').write_text(' Saved final \n', encoding='utf8')

    def write_source(self):
        self.source.write_text('\n'.join(json.dumps(row) for row in self.rows), encoding='utf8')

    def write_events(self):
        (self.packet / 'events.jsonl').write_text('\n'.join(json.dumps(row) for row in self.events), encoding='utf8')

    def proof(self):
        return {'version': 1, 'kind': 'native_completed_tools_terminal', 'threadId': THREAD, 'turnId': TURN,
                'finalSha256': hashlib.sha256(b'Saved final').hexdigest(), 'receiptSha256': 'a' * 64,
                'toolEventSha256': 'b' * 64, 'sessionSha256': hashlib.sha256(self.source.read_bytes()).hexdigest(),
                'returnedTools': 1, 'tools': {'exec_command': {'invocations': 1, 'terminal': 1},
                                             'apply_patch': {'invocations': 0, 'terminal': 0}}}

    def check(self):
        return completed_tools_evidence(self.packet, self.record, sessions=self.sessions)

    def test_exact_proof_is_redacted_and_never_authorizes_release_or_result_acceptance(self):
        proof = self.proof(); proof['privateExtra'] = 'PRIVATE_TOOL_ARGUMENTS'
        original = self.source.read_bytes()
        with patch('native_work_completion.subprocess.run', return_value=subprocess.CompletedProcess([], 0, json.dumps(proof))) as run:
            result = self.check()
        self.assertEqual(result['state'], 'verified')
        self.assertFalse(result['claimReleaseAuthorized'])
        self.assertFalse(result['executionAbsenceProven'])
        self.assertFalse(result['workflowJobAbsenceProven'])
        self.assertEqual(result['taskAcceptance'], 'unverified')
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertNotIn(str(self.source), json.dumps(result))
        args = json.loads(run.call_args.args[0][-1])
        self.assertEqual(args['threadId'], THREAD); self.assertEqual(args['turnId'], TURN)
        self.assertEqual(args['expectedFinalSha256'], result['finalSha256'])
        self.assertEqual(self.source.read_bytes(), original)

    def test_cli_failure_boolean_exit_and_multiple_turns_do_not_reach_the_helper(self):
        with patch('native_work_completion.subprocess.run') as run:
            for value in (False, 1, None):
                self.record['exitCode'] = value
                self.assertEqual(self.check()['state'], 'unavailable')
            self.record['exitCode'] = 0
            self.events.append({'type': 'turn.started'}); self.write_events()
            self.assertEqual(self.check()['state'], 'unavailable')
            run.assert_not_called()

    def test_wrong_workspace_wrong_source_thread_and_window_are_unknown(self):
        with patch('native_work_completion.subprocess.run') as run:
            for name, value in [('workspace', str(self.root / 'foreign')), ('sourceThread', TURN),
                                ('startedAt', '2026-10-04T13:25:00Z')]:
                before = dict(self.record); self.record[name] = value
                self.assertEqual(self.check()['state'], 'unavailable'); self.record = before
            run.assert_not_called()

    def test_malformed_session_and_payload_are_unknown_without_falling_back_to_counts(self):
        with patch('native_work_completion.subprocess.run') as run:
            self.source.write_text('{partial', encoding='utf8')
            self.assertEqual(self.check()['state'], 'unavailable')
            self.rows[0]['payload'] = 'invalid'; self.write_source()
            self.assertEqual(self.check()['state'], 'unavailable')
            run.assert_not_called()

    def test_helper_rejects_missing_terminal_and_timeout_without_exposing_stderr(self):
        with patch('native_work_completion.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'PRIVATE_ERROR')):
            self.assertNotIn('PRIVATE', json.dumps(self.check()))
            self.assertEqual(self.check()['state'], 'unavailable')
        with patch('native_work_completion.subprocess.run', side_effect=subprocess.TimeoutExpired(['node'], 15)):
            self.assertEqual(self.check()['state'], 'unavailable')

    def test_helper_identity_and_tool_projection_must_match_original(self):
        changes = [{'turnId': THREAD}, {'sessionSha256': 'c' * 64}, {'returnedTools': 2},
                   {'tools': {'exec_command': {'invocations': 1, 'terminal': 1, 'args': 'PRIVATE'}}}]
        for change in changes:
            with patch('native_work_completion.subprocess.run', return_value=subprocess.CompletedProcess([], 0, json.dumps({**self.proof(), **change}))):
                self.assertEqual(self.check()['state'], 'unavailable')

    def test_completed_native_poll_and_image_projections_remain_content_free(self):
        proof = self.proof()
        proof['tools']['write_stdin'] = {'invocations': 2, 'terminal': 2}
        proof['tools']['view_image'] = {'invocations': 1, 'terminal': 1}
        proof['returnedTools'] = 4
        with patch('native_work_completion.subprocess.run',
                   return_value=subprocess.CompletedProcess([], 0, json.dumps(proof))):
            result = self.check()
        self.assertEqual(result['state'], 'verified')
        self.assertEqual(result['returnedTools'], 4)
        self.assertFalse(result['claimReleaseAuthorized'])
        self.assertFalse(result['workflowJobAbsenceProven'])
        self.assertNotIn(str(self.source), json.dumps(result))

    def test_receipts_changed_during_verification_cannot_produce_a_verified_proof(self):
        for changed in ('source', 'events', 'final', 'execution'):
            self.setUp()
            proof = self.proof()
            def mutate(*args, **kwargs):
                if changed == 'source': self.source.write_bytes(self.source.read_bytes() + b'\n')
                elif changed == 'events': (self.packet / 'events.jsonl').write_bytes(b'changed')
                elif changed == 'final': (self.packet / 'final.md').write_text('Changed final', encoding='utf8')
                else: (self.packet / 'execution.json').write_text('{}', encoding='utf8')
                return subprocess.CompletedProcess([], 0, json.dumps(proof))
            with patch('native_work_completion.subprocess.run', side_effect=mutate):
                self.assertEqual(self.check()['state'], 'unavailable')

    def test_large_original_session_and_cli_events_stream_through_actual_native_helper(self):
        padding = (json.dumps({'timestamp': self.record['startedAt'], 'type': 'token_usage_record',
                               'payload': {'detail': 'x' * 8192}}) + '\n').encode()
        with self.source.open('wb') as stream:
            stream.write((json.dumps(self.rows[0]) + '\n').encode())
            for _ in range(8400):
                stream.write(padding)
            stream.write((json.dumps(self.rows[1]) + '\n').encode())
            for row in [
                {'timestamp': '2026-10-04T13:26:00Z', 'type': 'response_item',
                 'payload': {'type': 'message', 'role': 'assistant', 'phase': 'final_answer',
                             'content': [{'type': 'output_text', 'text': 'Saved final'}]}},
                {'timestamp': '2026-10-04T13:26:01Z', 'type': 'event_msg',
                 'payload': {'type': 'task_complete', 'turn_id': TURN, 'last_agent_message': 'Saved final'}},
            ]:
                stream.write((json.dumps(row) + '\n').encode())
        event_file = self.packet / 'events.jsonl'
        with event_file.open('wb') as stream:
            for event in self.events[:2]:
                stream.write((json.dumps(event) + '\n').encode())
            for _ in range(8400):
                stream.write((json.dumps({'type': 'item.completed', 'item': {'detail': 'x' * 8192}}) + '\n').encode())
            stream.write((json.dumps(self.events[-1]) + '\n').encode())
        self.assertGreater(self.source.stat().st_size, 64 * 1024 * 1024)
        self.assertGreater(event_file.stat().st_size, 64 * 1024 * 1024)
        original = Path.read_bytes
        def bounded_read(path):
            self.assertNotIn(path, (self.source, event_file), 'whole original history cannot be read into memory')
            return original(path)
        with patch.object(Path, 'read_bytes', bounded_read):
            result = self.check()
        self.assertEqual(result['state'], 'verified')
        self.assertEqual(result['returnedTools'], 0)
        self.assertFalse(result['claimReleaseAuthorized'])

    def failure(self):
        error = 'Error running remote compact task: original failure'
        self.record.update(state='needs_attention', exitCode=1)
        (self.packet / 'execution.json').write_text(json.dumps(self.record), encoding='utf8')
        (self.packet / 'final.md').unlink()
        self.events[-1] = {'type': 'turn.failed', 'error': {'message': error}}
        self.write_events()
        self.rows.append({'timestamp': '2026-10-04T13:26:01Z', 'type': 'event_msg',
                          'payload': {'type': 'task_complete', 'turn_id': TURN, 'error': {'message': error}, 'last_agent_message': None}})
        self.write_source()
        return error

    def test_real_failed_terminal_is_redacted_and_never_turns_the_original_error_into_success(self):
        error = self.failure()
        original = {path: path.read_bytes() for path in (self.source, self.packet / 'events.jsonl', self.packet / 'execution.json')}
        proof = failed_tools_evidence(self.packet, self.record, sessions=self.sessions)
        self.assertEqual(proof['state'], 'verified')
        self.assertEqual(proof['kind'], 'native_compaction_failed_with_terminal_tools')
        self.assertEqual(proof['failureSha256'], hashlib.sha256(error.encode()).hexdigest())
        self.assertFalse(proof['claimReleaseAuthorized'])
        self.assertEqual(proof['taskAcceptance'], 'unverified')
        self.assertNotIn('finalSha256', proof)
        self.assertEqual(completed_tools_evidence(self.packet, self.record, sessions=self.sessions)['state'], 'unavailable')
        self.assertEqual({path: path.read_bytes() for path in original}, original)

    def test_wrong_cli_failure_final_file_or_failure_window_never_produces_a_proof(self):
        self.failure()
        self.events[-1]['error']['message'] = 'foreign failure'; self.write_events()
        self.assertEqual(failed_tools_evidence(self.packet, self.record, sessions=self.sessions)['state'], 'unavailable')
        self.events[-1]['error']['message'] = self.rows[-1]['payload']['error']['message']; self.write_events()
        (self.packet / 'final.md').write_text('a prior result', encoding='utf8')
        self.assertEqual(failed_tools_evidence(self.packet, self.record, sessions=self.sessions)['state'], 'unavailable')
        (self.packet / 'final.md').unlink()
        self.rows[-1]['timestamp'] = '2026-10-04T13:28:00Z'; self.write_source()
        self.assertEqual(failed_tools_evidence(self.packet, self.record, sessions=self.sessions)['state'], 'unavailable')


if __name__ == '__main__':
    unittest.main()
