"""Real Node receipt verification with isolated claims and owned Job metadata."""
from contextlib import closing
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from native_work_admission import (AdmissionError, local_runtime_read, mark_terminal,
                                   poll, recover, request, settle, start, status)
from native_work_terminal import terminal_work_evidence
from tests.test_native_work_admission import journal

THREAD = '01a0dc7b-2a50-7140-a55b-eed50ff96b02'
TURN = '01a0dc7b-2a50-7140-a55b-eed50ff96b03'
SESSION = 'wc_sess_original'
JOB = 'wc_job_original'


def reply(output):
    return {'structuredContent': {'success': True, 'error': None, 'output': output}}


class NativeTerminalSettlementTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='clw-native-terminal-')
        self.addCleanup(temp.cleanup); self.root = Path(temp.name)
        self.workspace = self.root / 'project'; self.workspace.mkdir()
        self.db = self.root / 'harness.sqlite3'; journal(self.db)
        self.result = self.root / 'result'; self.result.mkdir()
        self.claim = request(self.db, workspace=str(self.workspace), result_path=str(self.result), owner_pid=1001)
        start(self.db, self.claim['claim_id'], 1001)
        self.home = self.root / 'codex'
        self.source = self.home / 'sessions/2026/09/26' / ('rollout-fixture-' + THREAD + '.jsonl')
        self.source.parent.mkdir(parents=True)
        self.environment = patch.dict(os.environ, {'CODEX_HOME': str(self.home)})
        self.environment.start(); self.addCleanup(self.environment.stop)
        self.network = patch('native_work_terminal.local_runtime_read',
                             side_effect=AssertionError('fixture must supply its owned Job response'))
        self.network.start(); self.addCleanup(self.network.stop)
        self.record = {'admissionId': self.claim['claim_id'], 'resultDirectory': str(self.result),
                       'ownerPid': 1001, 'workspace': str(self.workspace), 'sourceThread': THREAD,
                       'state': 'turn_completed', 'exitCode': 0,
                       'startedAt': '2026-09-26T10:00:00Z', 'endedAt': '2026-09-26T10:00:03Z'}
        (self.result / 'execution.json').write_text(json.dumps(self.record), encoding='utf8')
        (self.result / 'events.jsonl').write_text('\n'.join(map(json.dumps, [
            {'type': 'thread.started', 'thread_id': THREAD}, {'type': 'turn.started'}, {'type': 'turn.completed'},
        ])), encoding='utf8')
        (self.result / 'final.md').write_text(' Saved result \n', encoding='utf8')
        self.native()
        mark_terminal(self.db, self.claim['claim_id'], 1001)

    def row(self):
        with closing(sqlite3.connect(self.db)) as database:
            database.row_factory = sqlite3.Row
            return dict(database.execute('SELECT * FROM native_work_claims WHERE claim_id=?',
                                         (self.claim['claim_id'],)).fetchone())

    def native(self, *, command='python -c "print(123)"', output='123\n', no_tools=False,
               unfinished=False, unknown=False):
        def row(kind, payload, at):
            return {'type': kind, 'timestamp': at, 'payload': payload}
        rows = [row('session_meta', {'id': THREAD, 'cwd': str(self.workspace)}, '2026-09-26T10:00:00Z'),
                row('event_msg', {'type': 'task_started', 'turn_id': TURN}, '2026-09-26T10:00:00Z')]
        if not no_tools:
            rows.append(row('response_item', {'type': 'function_call', 'name': 'future_tool' if unknown else 'exec_command',
                        'call_id': 'original-call', 'arguments': json.dumps({'cmd': command, 'workdir': str(self.workspace)})},
                        '2026-09-26T10:00:00.100Z'))
            begin = int(datetime.fromisoformat('2026-09-26T10:00:00.200+00:00').timestamp() * 1000)
            end = begin + 100
            rows.append(row('event_msg', {'type': 'item_completed', 'thread_id': THREAD, 'turn_id': TURN,
                'started_at_ms': begin, 'completed_at_ms': end, 'item': {
                    'type': 'CommandExecution', 'id': 'original-call', 'process_id': 'original-process',
                    'command': ['powershell.exe', '-Command', command], 'cwd': str(self.workspace),
                    'status': 'in_progress' if unfinished else 'completed', 'exit_code': None if unfinished else 0,
                    'aggregated_output': output}}, '2026-09-26T10:00:00.300Z'))
            result = ('Chunk ID: original\nWall time: 0.1 seconds\n' +
                      ('Process running with session ID 44\n' if unfinished else 'Process exited with code 0\n') +
                      'Output:\n' + output)
            rows.append(row('response_item', {'type': 'function_call_output', 'call_id': 'original-call',
                                              'output': result}, '2026-09-26T10:00:00.400Z'))
        rows += [row('response_item', {'type': 'message', 'role': 'assistant', 'phase': 'final_answer',
                     'content': [{'type': 'output_text', 'text': 'Saved result'}]}, '2026-09-26T10:00:01Z'),
                 row('event_msg', {'type': 'task_complete', 'turn_id': TURN, 'last_agent_message': 'Saved result'},
                     '2026-09-26T10:00:02Z')]
        self.source.write_text('\n'.join(map(json.dumps, rows)), encoding='utf8')

    def test_sync_native_turn_releases_without_global_runner_or_union_idle(self):
        waiting = self.root / 'waiting'; waiting.mkdir()
        queued = request(self.db, workspace=str(self.workspace), result_path=str(waiting), owner_pid=1002)
        with (patch('native_work_admission.zero_local_jobs', side_effect=AssertionError('global idle')),
              patch('native_work_terminal.local_runtime_read', side_effect=AssertionError('unrelated Runner'))):
            result = settle(self.db, self.result)
        self.assertTrue(result['originalNativeTerminal']); self.assertTrue(result['nativeToolsTerminal'])
        self.assertNotIn('localJobsVerifiedZero', result)
        self.assertEqual(poll(self.db, queued['claim_id'], 1002)['state'], 'reserved')
        with closing(sqlite3.connect(self.db)) as database:
            evidence = json.loads(database.execute('SELECT evidence FROM native_work_recoveries').fetchone()[0])
        self.assertEqual(evidence['executionScope'], 'tracked_native_turn_tools')
        self.assertEqual(evidence['workflowJobCount'], 0)
        self.assertFalse(evidence['executionAbsenceProven'])
        self.assertFalse(evidence['workflowJobAbsenceProven'])

    def test_normal_no_tool_success_releases_without_global_job_probe(self):
        self.native(no_tools=True)
        with patch('native_work_terminal.local_runtime_read', side_effect=AssertionError('unrelated jobs')):
            self.assertEqual(settle(self.db, self.result)['state'], 'released')

    def test_actual_polled_command_and_image_complete_through_python_claim_settlement(self):
        rows = [json.loads(line) for line in self.source.read_text('utf8').splitlines()]
        def row(at, kind, payload):
            return {'timestamp': '2026-09-26T10:00:00.' + at + 'Z', 'type': kind, 'payload': payload}
        yielded = row('200', 'response_item', {'type': 'function_call_output', 'call_id': 'original-call',
            'output': 'Chunk ID: original\nWall time: 0.1 seconds\nProcess running with session ID 77\nOutput:\nbegin\n'})
        poll_call = row('400', 'response_item', {'type': 'function_call', 'name': 'write_stdin',
            'call_id': 'original-poll', 'arguments': json.dumps({'session_id': 77, 'chars': ''})})
        command_item = rows[3]
        command_item['timestamp'] = '2026-09-26T10:00:00.500Z'
        command_item['payload']['completed_at_ms'] += 200
        command_item['payload']['item'].update(process_id='77', aggregated_output='begin\nend\n')
        polled = row('600', 'response_item', {'type': 'function_call_output', 'call_id': 'original-poll',
            'output': 'Chunk ID: poll\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nend\n'})
        image_path = str(self.workspace / 'render.png')
        image_call = row('700', 'response_item', {'type': 'function_call', 'name': 'view_image',
            'call_id': 'original-image', 'arguments': json.dumps({'path': image_path})})
        image_at = int(datetime.fromisoformat('2026-09-26T10:00:00.800+00:00').timestamp() * 1000)
        image_item = row('800', 'event_msg', {'type': 'item_completed', 'thread_id': THREAD, 'turn_id': TURN,
            'started_at_ms': image_at - 100, 'completed_at_ms': image_at,
            'item': {'type': 'ImageView', 'id': 'original-image', 'path': image_path}})
        image_output = row('900', 'response_item', {'type': 'function_call_output', 'call_id': 'original-image',
            'output': [{'type': 'input_image', 'image_url': 'data:image/png;base64,YQ=='}]})
        original = rows[:3] + [yielded, poll_call, command_item, polled, image_call, image_item, image_output] + rows[-2:]
        self.source.write_text('\n'.join(map(json.dumps, original)), encoding='utf8')
        result = settle(self.db, self.result)
        self.assertTrue(result['nativeToolsTerminal'])
        with closing(sqlite3.connect(self.db)) as database:
            evidence = json.loads(database.execute('SELECT evidence FROM native_work_recoveries').fetchone()[0])
        self.assertEqual(evidence['returnedTools'], 3)
        self.assertEqual(evidence['tools']['write_stdin'], {'invocations': 1, 'terminal': 1})
        self.assertEqual(evidence['tools']['view_image'], {'invocations': 1, 'terminal': 1})
        self.assertFalse(evidence['executionAbsenceProven'])

    def test_owned_workflow_session_uses_complete_session_filter_and_ignores_other_jobs(self):
        self.native(command='python -c "run_process()"', output=json.dumps({'session_id': SESSION, 'job_id': JOB}))
        jobs = [{'job_id': JOB, 'session_id': SESSION, 'project': 'agent:original:project',
                 'status': 'completed', 'command_execution_state': 'completed'}]
        def probe(root, name, arguments):
            self.assertEqual(name, 'list_jobs')
            self.assertEqual(arguments, {'session_id': SESSION, 'limit': 100})
            return reply({'jobs': jobs, 'count': 1, 'matched_count': 1, 'truncated': False})
        with patch('native_work_terminal.local_runtime_read', side_effect=probe) as read:
            self.assertEqual(settle(self.db, self.result)['state'], 'released')
        self.assertEqual(read.call_count, 1)

    def test_own_running_unknown_incomplete_or_wrong_session_job_keeps_original_claim(self):
        self.native(output=json.dumps({'session_id': SESSION, 'job_id': JOB}))
        variations = [({'status': 'running'}, {}), ({'command_execution_state': None}, {}),
                      ({'session_id': 'wc_sess_other'}, {}), ({}, {'truncated': True}),
                      ({}, {'matched_count': 2})]
        for change, summary in variations:
            job = {'job_id': JOB, 'session_id': SESSION, 'status': 'completed',
                   'command_execution_state': 'completed', **change}
            with self.subTest(change=change, summary=summary), patch('native_work_terminal.local_runtime_read',
                    return_value=reply({'jobs': [job], 'count': 1, 'matched_count': 1, 'truncated': False, **summary})):
                with self.assertRaisesRegex(AdmissionError, 'workflow_jobs'):
                    settle(self.db, self.result)
                self.assertEqual(status(self.db, self.result)['state'], 'terminal_pending')

    def test_job_without_session_is_observed_by_its_original_id_without_wait_or_global_inventory(self):
        self.native(command='python -c "run_process()"', output=json.dumps({'job_id': JOB}))
        def probe(root, name, arguments):
            self.assertEqual(name, 'observe_jobs')
            self.assertEqual(arguments['items'], [{'job_id': JOB}]); self.assertNotIn('wait_secs',arguments)
            return reply({'items': [{'index': 0, 'job_id': JOB, 'success': True, 'output': {
                'status': 'completed', 'terminal': True, 'command_execution_state': 'completed'}}]})
        with patch('native_work_terminal.local_runtime_read', side_effect=probe):
            self.assertEqual(settle(self.db, self.result)['state'], 'released')

    def test_actual_http_transport_observes_owned_job_while_union_has_unrelated_native_calls(self):
        self.native(output=json.dumps({'job_id': JOB}))
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(handler):
                self.assertEqual(handler.path, '/healthz')
                handler.send({'service': 'clw-mcp-union', 'pid': 12345, 'pendingNative': 5})
            def do_POST(handler):
                payload = json.loads(handler.rfile.read(int(handler.headers['content-length'])))
                name, arguments = payload['params']['name'], payload['params']['arguments']
                calls.append((name, arguments))
                self.assertEqual(name, 'observe_jobs'); self.assertNotIn('wait_secs',arguments)
                self.assertEqual(arguments['items'], [{'job_id': JOB}])
                handler.send({'jsonrpc': '2.0', 'id': payload['id'], 'result': reply({'items': [
                    {'index': 0, 'job_id': JOB, 'success': True, 'output': {
                        'status': 'completed', 'terminal': True, 'command_execution_state': 'completed'}}]})})
            def send(handler, value):
                body = json.dumps(value).encode('utf8')
                handler.send_response(200); handler.send_header('content-type', 'application/json')
                handler.send_header('content-length', str(len(body))); handler.end_headers(); handler.wfile.write(body)
            def log_message(handler, *_):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            bridge = self.root / '.local/codex-web-bridge'; bridge.mkdir(parents=True)
            authorization = bridge / 'fixture-auth'; authorization.write_text('fixture-only', encoding='utf8')
            base = f'http://127.0.0.1:{server.server_port}'
            (bridge / 'union-config.json').write_text(json.dumps({'port': server.server_port,
                'authorizationFile': str(authorization)}), encoding='utf8')
            (bridge / 'shared-entry.json').write_text(json.dumps({'url': base + '/mcp', 'unionPid': 12345}), encoding='utf8')
            with patch('native_work_terminal.local_runtime_read',
                       side_effect=lambda root, name, arguments: local_runtime_read(self.root, name, arguments)):
                self.assertEqual(settle(self.db, self.result)['state'], 'released')
            self.assertEqual(len(calls), 1)
            with self.assertRaisesRegex(AdmissionError, 'without_wait'):
                local_runtime_read(self.root, 'observe_jobs', {'items': [{'job_id': JOB}], 'wait_secs': 1})
            self.assertEqual(len(calls), 1)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_expired_unknown_or_still_running_original_job_never_releases(self):
        self.native(output=json.dumps({'job_id': JOB}))
        for output in [{'index': 0, 'job_id': JOB, 'success': False, 'error_kind': 'unknown_job'},
                       {'index': 0, 'job_id': JOB, 'success': True, 'output': {'status': 'running', 'terminal': False}},
                       {'index': 0, 'job_id': 'wc_job_other', 'success': True}]:
            with self.subTest(output=output), patch('native_work_terminal.local_runtime_read',
                                                   return_value=reply({'items': [output]})):
                with self.assertRaisesRegex(AdmissionError, 'workflow_jobs'):
                    settle(self.db, self.result)
                self.assertEqual(status(self.db, self.result)['state'], 'terminal_pending')

    def test_workflow_called_without_actual_ownership_stays_held(self):
        self.native(command='python -c "run_process()"', output='accepted without a receipt')
        with patch('native_work_terminal.local_runtime_read', side_effect=AssertionError('global idle cannot prove ownership')):
            with self.assertRaisesRegex(AdmissionError, 'workflow_execution_unattributed'):
                settle(self.db, self.result)
        self.assertEqual(status(self.db, self.result)['state'], 'terminal_pending')

    def test_unfinished_native_command_or_unknown_tool_stays_held_even_with_all_runner_jobs_idle(self):
        for options in ({'unfinished': True}, {'unknown': True}):
            self.native(**options)
            with self.subTest(options=options), patch('native_work_admission.zero_local_jobs', return_value=True):
                with self.assertRaisesRegex(AdmissionError, 'native_tools_terminal_unverified'):
                    settle(self.db, self.result)
                self.assertEqual(status(self.db, self.result)['state'], 'terminal_pending')

    def test_changed_original_execution_or_session_and_claim_cas_remain_enforced(self):
        proof = terminal_work_evidence(self.row())
        self.source.write_text(self.source.read_text('utf8') + '\n', encoding='utf8')
        with patch('native_work_terminal.terminal_work_evidence', return_value=proof):
            with self.assertRaisesRegex(AdmissionError, 'execution_changed'):
                settle(self.db, self.result)
        self.native()
        def changed(row):
            proof = terminal_work_evidence(row)
            with closing(sqlite3.connect(self.db)) as database:
                database.execute('UPDATE native_work_claims SET updated=updated+1 WHERE claim_id=?', (self.claim['claim_id'],))
                database.commit()
            return proof
        with patch('native_work_terminal.terminal_work_evidence', side_effect=changed):
            with self.assertRaisesRegex(AdmissionError, 'claim_changed'):
                settle(self.db, self.result)
        self.assertEqual(status(self.db, self.result)['state'], 'terminal_pending')

    def test_owned_job_reads_and_full_receipt_verification_do_not_hold_shared_db_write_lock(self):
        self.native(output=json.dumps({'job_id': JOB}))
        def probe(root, name, arguments):
            with closing(sqlite3.connect(self.db, timeout=.2)) as database:
                database.execute("INSERT INTO operations(action,state) VALUES('owned-job-read','completed')")
                database.commit()
            return reply({'items': [{'index': 0, 'job_id': JOB, 'success': True, 'output': {
                'status': 'completed', 'terminal': True, 'command_execution_state': 'completed'}}]})
        with patch('native_work_terminal.local_runtime_read', side_effect=probe):
            self.assertEqual(settle(self.db, self.result)['state'], 'released')

    def test_dead_owner_terminal_recovery_has_same_owned_execution_contract(self):
        with closing(sqlite3.connect(self.db)) as database:
            database.execute("UPDATE native_work_claims SET state='unknown' WHERE claim_id=?", (self.claim['claim_id'],))
            database.commit()
        with patch('native_work_terminal.local_runtime_read', side_effect=AssertionError('unrelated Runner')):
            result = recover(self.db, self.result, owner_probe=lambda _: False)
        self.assertEqual(result['recovery'], 'original_terminal_observed')
        self.assertTrue(result['nativeToolsTerminal']); self.assertNotIn('localJobsVerifiedZero', result)

    def failed_native(self, *, command='python -c "print(123)"', output='123\n', prior_final=False):
        self.native(command=command, output=output)
        error = 'Error running remote compact task: original replay unavailable'
        rows = [json.loads(line) for line in self.source.read_text('utf8').splitlines()]
        rows = rows[:-1 if prior_final else -2] + [{**rows[-1], 'payload': {'type': 'task_complete', 'turn_id': TURN,
                                                 'last_agent_message': None, 'error': {'message': error}}}]
        self.source.write_text('\n'.join(map(json.dumps, rows)), encoding='utf8')
        self.record.update(state='needs_attention', exitCode=1)
        (self.result / 'execution.json').write_text(json.dumps(self.record), encoding='utf8')
        (self.result / 'events.jsonl').write_text('\n'.join(map(json.dumps, [
            {'type': 'thread.started', 'thread_id': THREAD}, {'type': 'turn.started'},
            {'type': 'turn.failed', 'error': {'message': error}},
        ])), encoding='utf8')
        (self.result / 'final.md').unlink()
        with closing(sqlite3.connect(self.db)) as database:
            database.execute("UPDATE native_work_claims SET state='running' WHERE claim_id=?", (self.claim['claim_id'],))
            database.commit()
        mark_terminal(self.db, self.claim['claim_id'], 1001)
        return rows

    def test_failed_native_tools_release_as_failure_and_keep_all_original_receipts(self):
        self.failed_native()
        originals = {p: p.read_bytes() for p in (self.source, self.result / 'events.jsonl', self.result / 'execution.json')}
        with patch('native_work_admission.local_runtime_read', side_effect=AssertionError('unrelated Runner')):
            result = settle(self.db, self.result)
        self.assertEqual((result['state'], result['nativeTurnState']), ('released', 'failed'))
        self.assertEqual(result['taskAcceptance'], 'unverified'); self.assertFalse(result['automaticReplay'])
        self.assertEqual({p: p.read_bytes() for p in originals}, originals)
        self.assertFalse((self.result / 'final.md').exists())
        with closing(sqlite3.connect(self.db)) as database:
            kind, raw = database.execute('SELECT kind,evidence FROM native_work_recoveries').fetchone()
        self.assertEqual(kind, 'original_native_failed_tools_terminal')
        proof = json.loads(raw)
        self.assertEqual(proof['kind'], 'native_compaction_failed_with_terminal_tools')
        self.assertEqual(proof['nativeTurnState'], 'failed'); self.assertEqual(proof['workflowJobCount'], 0)

    def test_prior_final_with_terminal_tools_releases_only_the_failed_claim(self):
        self.failed_native(prior_final=True)
        originals={p:p.read_bytes() for p in (self.source,self.result/'events.jsonl',self.result/'execution.json')}
        result=settle(self.db,self.result)
        self.assertEqual((result['state'],result['nativeTurnState']),('released','failed'))
        self.assertEqual(result['taskAcceptance'],'unverified');self.assertFalse(result['automaticReplay'])
        self.assertEqual({p:p.read_bytes() for p in originals},originals)
        with closing(sqlite3.connect(self.db)) as database:
            kind,raw=database.execute('SELECT kind,evidence FROM native_work_recoveries').fetchone()
        proof=json.loads(raw)
        self.assertEqual(kind,'original_native_failed_tools_terminal')
        self.assertEqual(proof['kind'],'native_failed_with_terminal_tools')
        self.assertEqual(len(proof['priorFinalSha256']),64);self.assertNotIn('finalSha256',proof)

    def test_failed_tools_unknown_or_changed_receipts_stay_held_even_with_a_legacy_idle_probe(self):
        rows = self.failed_native()
        for change in ('running', 'missing', 'foreign-output', 'foreign-call'):
            changed = json.loads(json.dumps(rows))
            if change == 'running': changed[3]['payload']['item']['status'] = 'in_progress'
            elif change == 'missing': changed.pop(3)
            elif change == 'foreign-output': changed[4]['payload']['output'] += 'foreign'
            else: changed[2]['payload']['name'] = 'unknown_tool'
            self.source.write_text('\n'.join(map(json.dumps, changed)), encoding='utf8')
            with self.subTest(change=change), self.assertRaisesRegex(AdmissionError, 'failed_tools_terminal_unverified'):
                settle(self.db, self.result, job_probe=lambda: True)
            self.assertEqual(status(self.db, self.result)['state'], 'terminal_pending')

    def test_failure_uses_only_its_owned_workflow_jobs_and_rejects_running_jobs(self):
        self.failed_native(command='python -c "run_process()"', output=json.dumps({'job_id': JOB}))
        def probe(root, name, args):
            self.assertEqual(name, 'observe_jobs'); self.assertEqual(args['items'], [{'job_id': JOB}])
            return reply({'items': [{'index': 0, 'job_id': JOB, 'success': True,
                                    'output': {'status': 'running', 'terminal': False}}]})
        with patch('native_work_admission.local_runtime_read', side_effect=probe):
            with self.assertRaisesRegex(AdmissionError, 'workflow_jobs_active_or_unknown'):
                settle(self.db, self.result)
        self.assertEqual(status(self.db, self.result)['state'], 'terminal_pending')
        with patch('native_work_admission.local_runtime_read', return_value=reply({'items': [
                {'index': 0, 'job_id': JOB, 'success': True, 'output': {
                    'status': 'failed', 'terminal': True, 'command_execution_state': 'completed'}}]})):
            self.assertEqual(settle(self.db, self.result)['nativeTurnState'], 'failed')

    def test_failed_claim_cas_and_changed_session_are_rechecked_before_release(self):
        self.failed_native()
        from native_work_completion import failed_terminal_work_evidence
        proof = failed_terminal_work_evidence(self.row())
        self.source.write_text(self.source.read_text('utf8') + '\n', encoding='utf8')
        with patch('native_work_completion.failed_terminal_work_evidence', return_value=proof):
            with self.assertRaisesRegex(AdmissionError, 'execution_changed'):
                settle(self.db, self.result)
        self.source.write_text(self.source.read_text('utf8').rstrip('\n'), encoding='utf8')
        def changed(row):
            result = failed_terminal_work_evidence(row)
            with closing(sqlite3.connect(self.db)) as database:
                database.execute('UPDATE native_work_claims SET updated=updated+1 WHERE claim_id=?', (self.claim['claim_id'],))
                database.commit()
            return result
        with patch('native_work_completion.failed_terminal_work_evidence', side_effect=changed):
            with self.assertRaisesRegex(AdmissionError, 'claim_changed'):
                settle(self.db, self.result)
        self.assertEqual(status(self.db, self.result)['state'], 'terminal_pending')

    def test_proven_pre_send_recovery_does_not_need_runner_globally_idle(self):
        other = self.root / 'pre-send'; other.mkdir()
        claim = request(self.db, workspace=str(self.workspace), result_path=str(other), owner_pid=1002)
        with patch('native_work_admission.zero_local_jobs', side_effect=AssertionError('unrelated Runner')):
            result = recover(self.db, other, owner_probe=lambda _: False)
        self.assertEqual(result['claim_id'], claim['claim_id']); self.assertTrue(result['nativeExecutionNotStarted'])
        self.assertNotIn('localJobsVerifiedZero', result)


if __name__ == '__main__':
    unittest.main()
