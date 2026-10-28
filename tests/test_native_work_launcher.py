"""Offline PowerShell package launch through real admission and a fake Codex."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import closing
from pathlib import Path
from threading import Thread
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

from tests.test_native_work_admission import journal


ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which('powershell.exe')


@unittest.skipUnless(POWERSHELL, 'Windows PowerShell 5 fixture')
class NativeLauncherTests(unittest.TestCase):
    def test_prompt_file_waits_for_admission_then_executes_one_original_turn(self):
        self._run_queued_launch()

    def test_restart_during_queue_uses_verified_new_endpoint_once(self):
        self._run_queued_launch(restart=True)

    def test_account_change_during_queue_cancels_without_invoking_codex(self):
        self._run_queued_launch(restart=True, change_account=True)

    def test_installed_private_python_executes_package_without_host_python_on_path(self):
        self._run_queued_launch(installed_no_path=True)

    def _run_queued_launch(self, restart=False, change_account=False, installed_no_path=False):
        class Health(BaseHTTPRequestHandler):
            requests = []

            def do_GET(self):
                self.requests.append((self.server.server_port, self.path))
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"pid":5678,"accepting_turns":true,'
                                 b'"service":"clw-mcp-union","pendingNative":1}')
            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Health)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        replacement = None
        try:
            with tempfile.TemporaryDirectory(prefix='clw-native-launcher-') as folder:
                root = Path(folder)
                scripts = root / 'scripts'; scripts.mkdir()
                for name in ('start_codex_web.ps1', 'native_work_admission.py',
                             'harness_user_authorization.py', 'native_work_interruption.py',
                             'native_work_terminal.py', 'harness_job_inventory.py', 'native_work_completion.py', 'read_codex_web_task.py'):
                    shutil.copyfile(ROOT / 'scripts' / name, scripts / name)
                config = root / 'config'; config.mkdir()
                authorization = 'Fixture authorization: 已授权。'
                (config / 'web-user-authorization.json').write_text(json.dumps({
                    'version': 1, 'enabled': True, 'text': authorization,
                }), encoding='utf8')
                state = root / '.local/harness'; state.mkdir(parents=True)
                journal(state / 'harness.sqlite3')
                bridge = root / '.local/codex-web-bridge'; bridge.mkdir(parents=True)
                endpoint = f'http://127.0.0.1:{server.server_port}/v1'
                (bridge / 'status.json').write_text(json.dumps({
                    'state': 'ready', 'pid': 1234, 'runtimePid': 5678, 'endpoint': endpoint,
                }), encoding='utf8')
                (bridge / 'connector-proof.json').write_text(json.dumps({
                    'result': {'ok': True}, 'ownerPid': 1234,
                    'runtimePid': 5678, 'endpoint': endpoint,
                }), encoding='utf8')
                environment = os.environ.copy()
                if installed_no_path:
                    private_python = root / 'runtime/python'; private_python.mkdir(parents=True)
                    # Isolated executable/DLL copies; fixture stdlib comes from
                    # PYTHONHOME so PATH contains neither Python nor Codex.
                    shutil.copyfile(sys.executable, private_python / 'python.exe')
                    for dll in Path(sys.executable).parent.glob('*.dll'):
                        shutil.copyfile(dll, private_python / dll.name)
                    (root / '.local/preview-installation.json').write_text(json.dumps({
                        'schema': 1, 'binaries': {'cli': str(root / 'runtime/native/webcodex.exe')},
                        'network': {'mode': 'system'}}), encoding='utf8')
                    # Admission also needs the user's Git, independently of
                    # the bundled Python and the supplied Codex command.
                    environment.update(PATH=str(Path(shutil.which('git')).parent), PYTHONHOME=sys.prefix)

                def write_union_identity(runtime):
                    # The fake native executor is still active. Hold its claim via
                    # a real identity check, rather than absent fixture modules/files.
                    base = f'http://127.0.0.1:{runtime.server_port}'
                    (bridge / 'union-config.json').write_text(json.dumps({
                        'port': runtime.server_port,
                    }), encoding='utf8')
                    (bridge / 'shared-entry.json').write_text(json.dumps({
                        'url': base + '/mcp', 'unionPid': 5678,
                    }), encoding='utf8')

                write_union_identity(server)
                workspace = root / 'work'; workspace.mkdir()
                with closing(sqlite3.connect(state / 'harness.sqlite3')) as db:
                    db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?)',
                               ('active-pure', str(workspace), 'write', '["."]', '[]'))
                    db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?)',
                               ('active-pure', '[]', str(workspace), 'write'))
                    db.commit()
                prompt = root / 'prompt.md'; prompt.write_text('Fixture: respond once.', encoding='utf8')
                result_path = root / 'result'
                marker = root / 'fake-codex-called.txt'
                wrapper = root / 'wrapper.ps1'
                wrapper.write_text(
                    "param([string]$Launcher,[string]$Workspace,[string]$Prompt,[string]$Result,[string]$Marker)\n"
                    "function global:codex {\n"
                    "  [IO.File]::WriteAllText($Marker,($args -join [Environment]::NewLine))\n"
                    "  [IO.File]::WriteAllText($Marker+'.prompt',($input -join [Environment]::NewLine))\n"
                    "  $index=[Array]::IndexOf($args,'-o')\n"
                    "  [IO.File]::WriteAllText($args[$index+1],'Fixture completed.')\n"
                    "  Write-Output '{\"type\":\"thread.started\",\"thread_id\":\"fixture\"}'\n"
                    "  Write-Output '{\"type\":\"turn.completed\"}'\n"
                    "  $global:LASTEXITCODE=0\n"
                    "}\n"
                    "& $Launcher -Model extra-high -WorkingDirectory $Workspace -PromptFile $Prompt -ResultDirectory $Result\n",
                    encoding='utf8')
                command = [POWERSHELL, '-NoProfile', '-NonInteractive', '-File', str(wrapper),
                           '-Launcher', str(scripts / 'start_codex_web.ps1'), '-Workspace', str(workspace),
                           '-Prompt', str(prompt), '-Result', str(result_path), '-Marker', str(marker)]
                process = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    deadline = time.monotonic() + 15
                    observed = None
                    while time.monotonic() < deadline:
                        receipt_file = result_path / 'execution.json'
                        if receipt_file.is_file():
                            try: observed = json.loads(receipt_file.read_text('utf-8-sig'))
                            except (OSError, ValueError): pass
                            if observed and observed.get('state') == 'queued_local': break
                        if process.poll() is not None: break
                        time.sleep(.1)
                    diagnostics = ''
                    if observed is None or observed.get('state') != 'queued_local':
                        if process.poll() is None: process.terminate()
                        stdout, stderr = process.communicate(timeout=5)
                        diagnostics = (f'\nlauncher exit: {process.returncode}\n'
                                       f'stdout: {stdout.decode("utf8", errors="replace")}\n'
                                       f'stderr: {stderr.decode("utf8", errors="replace")}')
                    self.assertIsNotNone(observed, 'original package did not write a queue receipt' + diagnostics)
                    self.assertEqual(observed['state'], 'queued_local', diagnostics)
                    self.assertFalse(marker.exists(), 'Codex was invoked before the pure-Web lease released')
                    if restart:
                        replacement = ThreadingHTTPServer(('127.0.0.1', 0), Health)
                        Thread(target=replacement.serve_forever, daemon=True).start()
                        old_endpoint = endpoint
                        endpoint = f'http://127.0.0.1:{replacement.server_port}/v1'
                        account = 'A' if change_account else 'B'
                        (bridge / 'status.json').write_text(json.dumps({
                            'state': 'ready', 'account': account, 'pid': 1235,
                            'runtimePid': 5678, 'endpoint': endpoint}), encoding='utf8')
                        (bridge / 'connector-proof.json').write_text(json.dumps({
                            'result': {'ok': True}, 'account': account, 'ownerPid': 1235,
                            'runtimePid': 5678, 'endpoint': endpoint}), encoding='utf8')
                        write_union_identity(replacement)
                        server.shutdown()
                        server.server_close()
                    with closing(sqlite3.connect(state / 'harness.sqlite3')) as db:
                        db.execute('DELETE FROM host_team_leases WHERE thread_id=?', ('active-pure',))
                        db.commit()
                    stdout, stderr = process.communicate(timeout=40)
                    done = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
                finally:
                    if process.poll() is None:
                        process.terminate()
                    process.communicate(timeout=5)
                if change_account:
                    self.assertNotEqual(done.returncode, 0)
                    self.assertFalse(marker.exists())
                    with closing(sqlite3.connect(state / 'harness.sqlite3')) as db:
                        self.assertEqual(db.execute('SELECT state FROM native_work_claims').fetchone()[0], 'released')
                    self.assertFalse((result_path / 'events.jsonl').exists())
                    return
                self.assertEqual(done.returncode, 0, done.stderr.decode('utf8', errors='replace'))
                self.assertTrue(marker.is_file(), done.stdout.decode('utf8', errors='replace'))
                arguments = marker.read_text('utf8')
                sent_prompt = Path(str(marker) + '.prompt').read_text('utf8')
                self.assertEqual(sent_prompt.strip(), authorization + '\nFixture: respond once.')
                self.assertEqual(done.stderr, b'', done.stderr.decode('utf8', errors='replace'))
                self.assertIn('CLW write domain remains held until original native tools and owned Workflow Jobs',
                              done.stdout.decode('utf8', errors='replace'))
                current_port = replacement.server_port if restart else server.server_port
                self.assertEqual(Health.requests, [(server.server_port, '/healthz'),
                                                  (current_port, '/healthz')])
                self.assertIn(endpoint, arguments)
                if restart:
                    self.assertNotIn(old_endpoint, arguments)
                receipt = json.loads((result_path / 'execution.json').read_text('utf-8-sig'))
                self.assertEqual(receipt['state'], 'turn_completed')
                self.assertEqual(receipt['model'], 'chatgpt-web/extra-high')
                self.assertTrue(receipt['writeDomainIsCooperative'])
                with closing(sqlite3.connect(state / 'harness.sqlite3')) as db:
                    claim = db.execute('SELECT state FROM native_work_claims WHERE claim_id=?',
                                       (receipt['admissionId'],)).fetchone()
                    self.assertEqual(claim[0], 'terminal_pending')
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)
            if replacement:
                replacement.shutdown(); replacement.server_close()


if __name__ == '__main__':
    unittest.main()
