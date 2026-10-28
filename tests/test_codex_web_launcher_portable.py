"""Offline launcher checks: installation runtimes and process-local network policy."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which('powershell.exe')
NODE = shutil.which('node')


@unittest.skipUnless(POWERSHELL, 'Windows PowerShell launcher')
class PortableLauncherTests(unittest.TestCase):
    @contextmanager
    def fixture(self, network=None):
        class Health(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"pid":5678,"accepting_turns":true}')

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Health)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix='clw-portable-') as folder:
                root = Path(folder)
                script = root / 'scripts/start_codex_web.ps1'
                script.parent.mkdir()
                shutil.copyfile(ROOT / 'scripts/start_codex_web.ps1', script)
                bridge = root / '.local/codex-web-bridge'
                bridge.mkdir(parents=True)
                endpoint = f'http://127.0.0.1:{server.server_port}/v1'
                (bridge / 'status.json').write_text(json.dumps({
                    'state': 'ready', 'account': 'B', 'pid': 1234,
                    'runtimePid': 5678, 'endpoint': endpoint}), encoding='utf8')
                (bridge / 'connector-proof.json').write_text(json.dumps({
                    'result': {'ok': True}, 'account': 'B', 'ownerPid': 1234,
                    'runtimePid': 5678, 'endpoint': endpoint}), encoding='utf8')
                if network is not None:
                    native = root / 'runtime/native'; native.mkdir(parents=True)
                    python = root / 'runtime/python'; python.mkdir()
                    # AppServer mode only resolves Python; package tests below
                    # exercise the real private executable with PATH cleared.
                    (python / 'python.exe').touch()
                    (root / '.local/preview-installation.json').write_text(json.dumps({
                        'schema': 1, 'binaries': {'cli': str(native / 'webcodex.exe')},
                        'network': network}), encoding='utf8')
                yield root, script
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def capture(self, root, script, *, no_path=False, extra=()):
        marker = root / 'capture.json'
        wrapper = root / 'capture.ps1'
        wrapper.write_text(
            "param([string]$Launcher,[string]$Workspace,[string]$Marker)\n"
            "function global:codex {\n"
            "  @{arguments=@($args);http=$env:HTTP_PROXY;https=$env:HTTPS_PROXY;all=$env:ALL_PROXY;no=$env:NO_PROXY;python=[string]$PythonCommand} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $Marker -Encoding UTF8\n"
            "  $global:LASTEXITCODE=0\n"
            "}\n"
            "& $Launcher -Model extra-high -WorkingDirectory $Workspace -AppServer @args\n",
            encoding='utf8')
        env = dict(os.environ, HTTP_PROXY='http://127.0.0.1:29999',
                   HTTPS_PROXY='http://127.0.0.1:29998', ALL_PROXY='socks5://127.0.0.1:29997')
        if no_path:
            env['PATH'] = ''
        result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-File',
                                 str(wrapper), '-Launcher', str(script), '-Workspace', str(root),
                                 '-Marker', str(marker), *extra], env=env, capture_output=True, timeout=20)
        return result, json.loads(marker.read_text('utf-8-sig')) if marker.exists() else None

    def test_source_keeps_inherited_network(self):
        with self.fixture() as (root, script):
            result, captured = self.capture(root, script)
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf8', errors='replace'))
            self.assertEqual(captured['http'], 'http://127.0.0.1:29999')
            self.assertEqual(captured['https'], 'http://127.0.0.1:29998')
            self.assertEqual(captured['all'], 'socks5://127.0.0.1:29997')
            self.assertEqual(captured['no'], '127.0.0.1,localhost,::1')

    def test_installed_network_modes_without_path_python(self):
        for network, expected in [({'mode': 'system'}, 'http://127.0.0.1:29999'),
                                  ({'mode': 'proxy', 'proxy_url': 'http://127.0.0.1:18888'}, 'http://127.0.0.1:18888'),
                                  ({'mode': 'direct'}, None)]:
            with self.subTest(network=network), self.fixture(network) as (root, script):
                result, captured = self.capture(root, script, no_path=True)
                self.assertEqual(result.returncode, 0, result.stderr.decode('utf8', errors='replace'))
                self.assertEqual(captured['http'], expected)
                self.assertEqual(captured['no'], '127.0.0.1,localhost,::1')
                if network['mode'] != 'system':
                    self.assertEqual(captured['https'], expected)
                    self.assertEqual(captured['all'], expected)

    def test_invalid_explicit_proxy_stops_before_codex(self):
        for proxy in ['http://user:password@127.0.0.1:18888', 'http://127.0.0.1:18888/path',
                      'file:///C:/proxy', 'socks5://127.0.0.1', 'http://127.0.0.1:18888?fallback=direct']:
            with self.subTest(proxy=proxy), self.fixture({'mode': 'proxy', 'proxy_url': proxy}) as (root, script):
                result, captured = self.capture(root, script)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(captured)
                self.assertIn(b'no direct fallback', result.stderr)
                self.assertFalse((root / '.local/harness').exists())

    def test_installed_missing_private_python_does_not_use_path(self):
        with self.fixture({'mode': 'system'}) as (root, script):
            (root / 'runtime/python/python.exe').unlink()
            result, captured = self.capture(root, script)
            self.assertNotEqual(result.returncode, 0)
            self.assertIsNone(captured)
            self.assertIn(b'private Python', result.stderr)

    @unittest.skipUnless(NODE, 'existing Node runtime for explicit official-CLI shape')
    def test_explicit_node_script_with_no_codex_or_python_on_path(self):
        with self.fixture({'mode': 'system'}) as (root, script):
            target = root / 'capture.json'
            js = root / 'own-cli.js'
            js.write_text('require("node:fs").writeFileSync(' + json.dumps(str(target))
                          + ',JSON.stringify({arguments:process.argv.slice(2),no:process.env.NO_PROXY}));', encoding='utf8')
            result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-File', str(script),
                '-Model', 'extra-high', '-WorkingDirectory', str(root), '-AppServer',
                '-CodexExecutable', NODE, '-CodexScript', str(js)],
                env=dict(os.environ, PATH=''), capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf8', errors='replace'))
            captured = json.loads(target.read_text('utf8'))
            self.assertIn('model="chatgpt-web/extra-high"', captured['arguments'])
            self.assertEqual(captured['arguments'][-3:], ['app-server', '--listen', 'stdio://'])
            self.assertEqual(captured['no'], '127.0.0.1,localhost,::1')


if __name__ == '__main__':
    unittest.main()
