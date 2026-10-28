"""Exercise Windows PowerShell 5 admission with UTF-8 state, without network/model calls."""
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("powershell.exe")


@unittest.skipUnless(POWERSHELL, "Windows PowerShell 5 fixture")
class LauncherEncodingTests(unittest.TestCase):
    def test_process_local_app_scope_reaches_actual_codex_invocation(self):
        class Health(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
                self.wfile.write(b'{"pid":5678,"accepting_turns":true}')
            def log_message(self, *_):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Health)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix='clw-launch-apps-') as folder:
                root=Path(folder);script=root/'scripts/start_codex_web.ps1';script.parent.mkdir()
                shutil.copyfile(ROOT/'scripts/start_codex_web.ps1',script)
                endpoint=f'http://127.0.0.1:{server.server_port}/v1'
                home=root/'.local/codex-web-bridge';home.mkdir(parents=True)
                (home/'status.json').write_text(json.dumps({'state':'ready','pid':1234,'runtimePid':5678,'endpoint':endpoint}),encoding='utf8')
                (home/'connector-proof.json').write_text(json.dumps({'result':{'ok':True},'ownerPid':1234,'runtimePid':5678,'endpoint':endpoint}),encoding='utf8')
                # A fake command captures exactly what PowerShell invokes, after
                # exercising the real admission and local health check. No model.
                wrapper=root/'capture.ps1'
                wrapper.write_text("param([string]$Launcher,[string]$Workspace,[string]$OutputFile,[switch]$Apps)\n"
                    "function global:codex { $args | ConvertTo-Json -Compress | Set-Content -LiteralPath $OutputFile -Encoding UTF8; & python -c \"print(chr(0x590d)+chr(0x6838))\"; $global:LASTEXITCODE=$LASTEXITCODE }\n"
                    "& $Launcher -Model extra-high -WorkingDirectory $Workspace -AppServer -IncludeConnectedApps:$Apps\n",encoding='utf8')
                for enabled in (False,True):
                    output=root/f'args-{enabled}.json'
                    command=[POWERSHELL,'-NoProfile','-NonInteractive','-File',str(wrapper),'-Launcher',str(script),'-Workspace',str(root),'-OutputFile',str(output)]
                    if enabled:command.append('-Apps')
                    result=subprocess.run(command,capture_output=True,timeout=20)
                    self.assertEqual(result.returncode,0,result.stderr.decode('utf8',errors='replace'))
                    self.assertIn('复核',result.stdout.decode('utf8',errors='strict'))
                    arguments=json.loads(output.read_text(encoding='utf-8-sig'))
                    self.assertIn('features.apps='+str(enabled).lower(),arguments)
                    self.assertIn('model="chatgpt-web/extra-high"',arguments)
                    self.assertIn('app-server',arguments)
                self.assertFalse((root/'config.toml').exists())
        finally:
            server.shutdown();server.server_close();thread.join(timeout=2)

    def run_gate(self, files, expected):
        with tempfile.TemporaryDirectory(prefix="clw-launch-utf8-") as folder:
            root = Path(folder)
            script = root / "scripts/start_codex_web.ps1"
            script.parent.mkdir()
            shutil.copyfile(ROOT / "scripts/start_codex_web.ps1", script)
            for relative, value in files.items():
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            # Each fixture stops before the health request or Codex process.
            result = subprocess.run(
                [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(script), "-Model", "extra-high", "-WorkingDirectory", str(root)],
                cwd=root, capture_output=True, timeout=20,
            )
            output = (result.stdout + result.stderr).decode("utf-8", errors="replace")
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("ConvertFrom-Json", output)
            self.assertNotIn("Invalid object passed in", output)
            self.assertIn(expected, output)

    def test_account_cooldown_utf8_stops_before_status(self):
        self.run_gate({".local/web-host/account-access-B.json": {
            "version": 1, "account": "B", "blocked": True, "message": "连接受限。",
        }}, "ChatGPT conversation access is temporarily limited")

    def test_tool_gate_reads_actual_utf8_status(self):
        self.run_gate({".local/codex-web-bridge/status.json": {
            "state": "ready", "tools": {"ready": False, "message": "本机工具目录与查询合同一致。"},
        }}, "CLW local tool discovery is not ready")

    def test_connector_proof_utf8_stops_before_network(self):
        self.run_gate({
            ".local/codex-web-bridge/status.json": {"state": "ready"},
            ".local/codex-web-bridge/connector-proof.json": {"result": {"ok": False, "message": "连接尚未核验。"}},
        }, "Codex Web")


if __name__ == "__main__":
    unittest.main()
