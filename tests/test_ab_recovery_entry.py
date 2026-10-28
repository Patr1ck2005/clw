"""Isolated real PowerShell contracts; fixtures never operate production services."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import web_host_launcher as launcher
from windows_process_owner import process_identity


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


@unittest.skipUnless(os.name == 'nt' and launcher.resolve_powershell7(), 'Existing Windows PS7 required')
class RecoveryEntryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shell = launcher.resolve_powershell7()
        cls.source = (ROOT / 'scripts/recover_local_mcp.ps1').read_text('utf-8-sig')

    def run_ps(self, root, body, *, shell=None, timeout=20):
        driver = root / 'scripts/driver.ps1'
        driver.write_text(body, encoding='utf-8-sig')
        result = launcher.run_bounded([shell or self.shell, '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                                      '-File', str(driver)], timeout=timeout, capture_stdout=True, capture_stderr=True)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        return result

    def function_loader(self):
        # Load the original definitions directly into the isolated driver so
        # function parameters and its real PSScriptRoot retain normal PS scope.
        return self.source[:self.source.index("\ntry {\n    if ($PSVersionTable.PSVersion.Major")]

    def fixture(self, root):
        scripts = root / 'scripts'; scripts.mkdir()
        (scripts/'local_mcp_credentials.ps1').write_bytes((ROOT/'scripts/local_mcp_credentials.ps1').read_bytes())
        bridge = root / '.local/codex-web-bridge'; bridge.mkdir(parents=True)
        auth = root / 'fixture-auth.txt'; auth.write_text('fixture-only')
        health = scripts / 'health.ps1'
        health.write_text("'{\"result\":\"ok\",\"readyz\":{\"ok\":true},\"control_plane_poll\":{\"ok\":true}}'\n$global:LASTEXITCODE=0\n")
        (bridge / 'settings.json').write_text(json.dumps({'tunnel': {'binaryPath': str(health)}}))
        (bridge / 'union-config.json').write_text(json.dumps({'port': 18945, 'authorizationFile': str(auth)}))
        (bridge / 'shared-entry.json').write_text(json.dumps({'unionPid': 11}))
        (scripts / 'webcodex_backend.py').write_text(
            "from pathlib import Path\ndef prepare(root):\n (Path(root)/'backend-prepared').touch()\n return {'started':[]}\n"
            "def failure_code(error):\n return 'fixture_error'\n"
            "def wait_mcp_ready(root, timeout=30, require_runner=False):\n"
            " assert timeout==180 and require_runner is True\n"
            " if (Path(root)/'mcp-not-ready').exists():raise RuntimeError('mcp_startup_not_ready')\n"
            " (Path(root)/'runner-ready').touch()\n"
            " return {'state':'ready'}\n")
        (scripts / 'windows_process_owner.py').write_bytes((ROOT / 'scripts/windows_process_owner.py').read_bytes())
        (scripts / 'local_mcp_watch.py').write_text("def boot_identity():\n return {'boot_id':'a'*32,'boot_filetime':'1'}\ndef preboot_service_evidence(root):\n return None\n"
            "def backend_port_readiness(root):\n return (False,'backend_port_waiting') if (root/'backend-port-blocked').exists() else (True,'backend_port_ready')\n")
        for account in ('a', 'b'):
            (scripts / ('start_local_mcp_' + account + '.ps1')).write_text(
                "param([string]$PythonExecutable,[switch]$TakeOverDesktopTunnel,[int]$HealthWaitAttempts)\n"
                "if(!(Test-Path -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'runner-ready'))){throw 'Runner gate was skipped'}\n"
                "[IO.File]::AppendAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'calls.jsonl'),"
                "(@{account='" + account + "';takeover=[bool]$TakeOverDesktopTunnel;health_attempts=$HealthWaitAttempts}|ConvertTo-Json -Compress)+\"`n\")\nexit 0\n")
        return scripts, health

    def test_real_ps5_forwards_once_to_ps7_and_full_entry_preserves_original_receipts(self):
        with tempfile.TemporaryDirectory(prefix='clw-ab-entry-') as raw:
            root = Path(raw); scripts, health = self.fixture(root)
            # Network and launches are fixture boundaries, while the entry,
            # backend call, child shell forwarding, and receipt writes are real.
            source = self.source.replace("    Wait-VpnProxy\n", "    $null=$true\n")
            source = source.replace("$ABinary = Join-Path $env:LOCALAPPDATA 'WebCodex\\tools\\tunnel-client\\0.0.12\\windows-amd64\\tunnel-client.exe'", "$ABinary = " + quote(health))
            mock = '''
function Invoke-RestMethod {param($Uri,$Method,$Headers,$Body,$ContentType,[switch]$NoProxy,$TimeoutSec)
 if($Uri -like '*/healthz'){return @{service='clw-mcp-union';pid=11}}
 if($Headers['mcp-method'] -eq 'tools/list'){return @{result=@{tools=@(@{name='runtime_status'})}}}
 return @{result=@{structuredContent=@{success=$true;output=@{connection_layers=@{runner_process=@{status='ready'};server_transport=@{status='connected';age_secs=2};project_registry=@{online_projects=1}};agents=@{online_count=1}}}}}
}
'''
            source = source.replace("$ErrorActionPreference = 'Stop'", mock + "\n$ErrorActionPreference = 'Stop'", 1)
            target = scripts / 'recover_local_mcp.ps1'; target.write_text(source, encoding='utf-8-sig')
            old = root / '.local/ab-recovery-original.json'; old.write_text('{"launch_unknown":true}')
            win5 = str(Path(os.environ['WINDIR']) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
            body = '& ' + quote(target) + ' -PythonExecutable ' + quote(sys.executable) + ' -WaitForVpnSeconds 120\nexit $LASTEXITCODE\n'
            self.run_ps(root, body, shell=win5)
            calls = [json.loads(line) for line in (root / 'calls.jsonl').read_text().splitlines()]
            self.assertEqual([value['account'] for value in calls], ['b', 'a'])
            self.assertEqual(calls[0]['health_attempts'], 3)
            self.assertTrue(calls[1]['takeover'])
            receipt = json.loads((root / '.local/ab-recovery.json').read_text())
            self.assertEqual(receipt['state'], 'completed')
            self.assertEqual(receipt['wait_for_vpn_seconds'], 120)
            self.assertEqual(receipt['started'], [])
            self.assertEqual(receipt['entry_completed'], {'backend': True, 'B': True, 'A': True})
            self.assertFalse(receipt['launch_unknown'])
            self.assertEqual(old.read_text(), '{"launch_unknown":true}')
            self.assertEqual(receipt, json.loads((root / ('.local/ab-recovery-' + receipt['run_id'] + '.json')).read_text()))
            self.assertNotIn('fixture-only', json.dumps(receipt))

    def test_mcp_not_ready_does_not_start_either_tunnel_or_mark_unknown_launch(self):
        with tempfile.TemporaryDirectory(prefix='clw-ab-mcp-gate-') as raw:
            root=Path(raw);scripts,_=self.fixture(root)
            (root/'mcp-not-ready').touch()
            source=self.source.replace("    try { Wait-VpnProxy }", "    try { $null=$true }")
            target=scripts/'recover_local_mcp.ps1';target.write_text(source,encoding='utf-8-sig')
            result=launcher.run_bounded([self.shell,'-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
                '-File',str(target),'-PythonExecutable',sys.executable],timeout=20,
                capture_stdout=True,capture_stderr=True)
            self.assertNotEqual(result.returncode,0)
            receipt=json.loads((root/'.local/ab-recovery.json').read_text())
            self.assertEqual(receipt['error_code'],'mcp_startup_not_ready')
            self.assertEqual(receipt['entry_completed'],{'backend':True,'B':False,'A':False})
            self.assertFalse(receipt['launch_unknown'])
            self.assertEqual(receipt['started'],[])
            self.assertFalse((root/'calls.jsonl').exists())

    def test_blocked_backend_port_retains_watch_without_prepare_or_tunnel_launch(self):
        for start_watch in (False,True):
            with self.subTest(start_watch=start_watch),tempfile.TemporaryDirectory(prefix='clw-ab-bind-wait-') as raw:
                root=Path(raw);scripts,_=self.fixture(root);(root/'backend-port-blocked').touch()
                source=self.source.replace("    try { Wait-VpnProxy }", "    try { $null=$true }")
                mocks="\nfunction Start-VerifiedWatch {$Receipt.watch=@{state='retained';pid=77;source_sha=('a'*64)}}\n"
                main=source.index("\ntry {\n    if ($PSVersionTable.PSVersion.Major")
                source=source[:main]+mocks+source[main:]
                target=scripts/'recover_local_mcp.ps1';target.write_text(source,encoding='utf-8-sig')
                self.run_ps(root,'& '+quote(target)+' -PythonExecutable '+quote(sys.executable)+(' -StartWatch' if start_watch else '')+'\nexit $LASTEXITCODE\n')
                receipt=json.loads((root/'.local/ab-recovery.json').read_text())
                self.assertEqual(receipt['state'],'waiting_backend');self.assertEqual(receipt['error_code'],'backend_port_waiting')
                self.assertFalse(receipt['launch_unknown']);self.assertEqual(receipt['started'],[])
                self.assertEqual(receipt['entry_completed'],{'backend':False,'A':False,'B':False})
                self.assertEqual(receipt['watch']['state'] if start_watch else receipt['watch'],'retained' if start_watch else None)
                self.assertFalse((root/'backend-prepared').exists());self.assertFalse((root/'calls.jsonl').exists())

    def test_vpn_wait_is_bounded_and_uses_only_proxy_observations(self):
        with tempfile.TemporaryDirectory(prefix='clw-ab-vpn-') as raw:
            root = Path(raw); (root / 'scripts').mkdir()
            body = self.function_loader() + '''
$WaitForVpnSeconds=1;$VpnProbeIntervalSeconds=1;$global:Reads=0
function Test-VpnProxy {$global:Reads++;return ($global:Reads -ge 2)}
Wait-VpnProxy
if($global:Reads -ne 2){throw 'VPN waiting did not retry'}
$WaitForVpnSeconds=0;$global:Reads=0
function Test-VpnProxy {$global:Reads++;return $false}
try {Wait-VpnProxy;throw 'unexpected success'} catch {if($_.Exception.Message -notlike '*17890*'){throw}}
if($global:Reads -ne 1){throw 'Immediate VPN failure retried'}
'''
            self.run_ps(root, body)

    def test_authentication_refusal_waits_for_changed_keys_without_network_or_launch(self):
        import hashlib
        with tempfile.TemporaryDirectory(prefix='clw-ab-auth-wait-') as raw:
            root=Path(raw);scripts,_=self.fixture(root)
            local_home=root/'local-app-data'
            secret=local_home/'dev.webcodex.desktop/secrets/tunnel-config.json'
            secret.parent.mkdir(parents=True)
            a_key='fixture-rejected-a';b_key='fixture-rejected-b'
            secret.write_text(json.dumps({'tunnel_id':'tunnel_'+'a'*32,'api_key':a_key}))
            b_file=root/'fixture-key-b.txt';b_file.write_text(b_key)
            (root/'.local/codex-web-bridge/settings.json').write_text(json.dumps({'tunnel':{'runtimeKeyFile':str(b_file)}}))
            (root/'.local/ab-authentication-wait.json').write_text(json.dumps({'protocol':1,'rejected_key_sha256':{
                'A':hashlib.sha256(a_key.encode()).hexdigest(),'B':hashlib.sha256(b_key.encode()).hexdigest()}}))
            body=self.function_loader()+"\n$ProjectRoot="+quote(root)+"\n$env:LOCALAPPDATA="+quote(local_home)+'''
function Invoke-RestMethod {throw 'No network request allowed while authentication is rejected'}
function Start-Process {throw 'No launch allowed while authentication is rejected'}
try {Assert-NoRejectedTunnelCredentials;throw 'unchanged credentials admitted'} catch {if($_.Exception.Message -notlike '*401*'){throw}}
$APath=Join-Path $env:LOCALAPPDATA 'dev.webcodex.desktop/secrets/tunnel-config.json'
[IO.File]::WriteAllText($APath,'{"schema_version":2,"profiles":[{"id":"default","credentials":{"tunnel_id":"tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","api_key":"fixture-new-a"}}]}')
try {Assert-NoRejectedTunnelCredentials;throw 'unchanged B admitted'} catch {if($_.Exception.Message -notlike '*B*401*'){throw}}
[IO.File]::WriteAllText('''+quote(b_file)+''','fixture-new-b')
Assert-NoRejectedTunnelCredentials
'''
            result=self.run_ps(root,body)
            self.assertNotIn(a_key,result.stdout or '')
            self.assertNotIn(b_key,result.stdout or '')

    def test_tunnel_health_allows_delayed_poll_without_restarting_the_owner(self):
        for ready_at,reads,failed in [(4,4,False),(8,8,False),(99,10,True)]:
            with self.subTest(ready_at=ready_at),tempfile.TemporaryDirectory(prefix='clw-ab-poll-') as raw:
                root=Path(raw);scripts=root/'scripts';scripts.mkdir()
                binary=scripts/'health.ps1'
                binary.write_text("$global:ProbeReads++;$ok=$global:ProbeReads -ge $global:ReadyAt\n"
                    "@{result=$(if($ok){'ok'}else{'not_ready'});readyz=@{ok=$ok};control_plane_poll=@{ok=$ok}}|ConvertTo-Json -Compress\n"
                    "$global:LASTEXITCODE=$(if($ok){0}else{1})\n")
                body=self.function_loader()+"\n$ProjectRoot="+quote(root)+"\n$global:ReadyAt="+str(ready_at)+"\n"+'''
$global:ProbeReads=0;$global:Waited=0
function Start-Sleep {param($Seconds);$global:Waited+=$Seconds}
function Start-Process {throw 'health wait must not start a service'}
function Stop-Process {throw 'health wait must not stop a service'}
$failed=$false
try {Wait-TunnelHealth 'A' '''+quote(binary)+'''} catch {$failed=$true}
if($global:ProbeReads -ne '''+str(reads)+''' -or $failed -ne $'''+str(failed).lower()+'''){throw 'incorrect delayed poll outcome'}
if($global:Waited -gt 48){throw 'health wait exceeded bounded backoff'}
'''
                self.run_ps(root,body)

    def watch_case(self, scenario):
        with tempfile.TemporaryDirectory(prefix='clw-ab-watch-') as raw:
            root = Path(raw); (root / 'scripts').mkdir(); trace = root / 'trace.json'
            body = self.function_loader() + '''
$ProjectRoot=''' + quote(root) + '''
$WatchHome=Join-Path $ProjectRoot '.local/local-mcp-watch';$WatchScript='fixture-watch.py';$Python='fixture-python'
$WatchIntervalSeconds=30;$Utf8=[Text.UTF8Encoding]::new($false);$Receipt=@{run_id='fixture';watch=$null}
$global:Scenario=''' + quote(scenario) + '''
$global:Stopped=0;$global:Spawned=0;$global:ExistingReads=0;$global:Signatures=0
$VerifiedWatchSourceSha='a'*64
if($global:Scenario -eq 'wrong_pin'){$VerifiedWatchSourceSha='d'*64}
if($global:Scenario -eq 'changed_unpinned'){$VerifiedWatchSourceSha=$null}
function Get-WatchSignature {$global:Signatures++;if($global:Scenario -eq 'source_race' -and $global:Signatures -gt 1){return ('c'*64)};return ('a'*64)}
function Get-ExistingWatch {
 $global:ExistingReads++
 if($global:Spawned){if($global:Scenario -eq 'launch_unknown'){return @{active=$false}};return @{active=$true;pid=101;source_sha=('a'*64)}}
 if($global:Stopped){if($global:Scenario -eq 'replacement_race'){return @{active=$true;pid=88;source_sha=('b'*64)}};return @{active=$false}}
 if($global:Scenario -eq 'new') {return @{active=$false}}
 return @{active=$true;pid=77;source_sha=$(if($global:Scenario -eq 'same'){'a'*64}else{'b'*64})}
}
function Stop-OriginalWatch {$global:Stopped++;if($global:Scenario -eq 'stop_unknown'){throw 'original exit unknown'}}
function Start-Process {param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError);$global:Spawned++;return @{Id=101}}
function Start-Sleep {param($Milliseconds)}
function Save-RecoveryReceipt {param($State,$Step)}
if($global:Scenario -eq 'new'){$VerifiedWatchSourceSha=$null}
$failed=$false
try {Start-VerifiedWatch} catch {$failed=$true}
[IO.File]::WriteAllText(''' + quote(trace) + ''',(@{stopped=$global:Stopped;spawned=$global:Spawned;failed=$failed;watch=$Receipt.watch}|ConvertTo-Json -Depth 8))
'''
            self.run_ps(root, body)
            return json.loads(trace.read_text())

    def test_watch_source_handoff_reuses_or_stops_exact_original_before_one_launch(self):
        cases = {'same': (0, 0, False), 'new': (0, 1, False), 'changed': (1, 1, False),
                 'changed_unpinned': (1, 1, False), 'wrong_pin': (0, 0, True), 'stop_unknown': (1, 0, True),
                 'source_race': (1, 0, True), 'replacement_race': (1, 0, True), 'launch_unknown': (1, 1, True)}
        for scenario, expected in cases.items():
            with self.subTest(scenario=scenario):
                result = self.watch_case(scenario)
                self.assertEqual((result['stopped'], result['spawned'], result['failed']), expected)
                if scenario == 'launch_unknown':
                    self.assertEqual(result['watch']['state'], 'launch_unknown')

    def test_formal_watch_stop_holds_creation_identity_and_waits_for_real_fixture_exit(self):
        with tempfile.TemporaryDirectory(prefix='clw-ab-watch-stop-') as raw:
            root = Path(raw); scripts = root / 'scripts'; scripts.mkdir()
            home = root / '.local/local-mcp-watch'; home.mkdir(parents=True)
            # Minimal imports for the embedded stop code, using the real native
            # owner implementation and an isolated cooperative watch process.
            (scripts / 'windows_process_owner.py').write_bytes((ROOT / 'scripts/windows_process_owner.py').read_bytes())
            (scripts / 'local_mcp_watch.py').write_text("import json\ndef read_json(path):\n return json.loads(path.read_text())\n")
            (scripts / 'product_runtime.py').write_text("import json\ndef atomic_json(path,value):\n path.write_text(json.dumps(value))\n")
            child = subprocess.Popen([sys.executable, '-B', '-c',
                "from pathlib import Path;import sys,time;home=Path(sys.argv[1]);\nwhile not (home/'stop.json').exists():time.sleep(.02)", str(home)],
                creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                identity = process_identity(child.pid)
                status = {'pid': child.pid, 'creation_filetime': identity['CreationFiletime'],
                          'run_id': 'original-fixture-run', 'source_sha': 'b' * 64}
                (home / 'status.json').write_text(json.dumps(status))
                body = self.function_loader() + '$ProjectRoot=' + quote(root) + '\n$Python=' + quote(sys.executable) + '\n' + \
                    'Stop-OriginalWatch ([pscustomobject]@{pid=' + str(child.pid) + ";source_sha=('b'*64)})\n"
                self.run_ps(root, body)
                self.assertEqual(child.wait(timeout=3), 0)
                self.assertEqual(json.loads((home / 'stop.json').read_text()), {'run_id': 'original-fixture-run'})
            finally:
                if child.poll() is None:
                    (home / 'stop.json').write_text('{"run_id":"original-fixture-run"}')
                    child.wait(timeout=3)

    def test_watch_owner_query_distinguishes_absent_reused_and_unknown_identity(self):
        for scenario, expected in [('absent', False), ('reused', False), ('alive', True), ('unknown', None), ('malformed', None)]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory(prefix='clw-ab-watch-owner-') as raw:
                root=Path(raw); scripts=root/'scripts';scripts.mkdir();home=root/'.local/local-mcp-watch';home.mkdir(parents=True)
                (scripts/'local_mcp_watch.py').write_text("import json\ndef read_json(path):\n return json.loads(path.read_text())\n")
                native="""class _NativeApi:
 def snapshot(self):return %s
def process_identity(pid):
 %s
""" % ('{}' if scenario=='absent' else '{42:{}}',
                         "raise RuntimeError('identity unavailable')" if scenario=='unknown' else
                         "return {'CreationFiletime':'"+('999' if scenario=='reused' else '123')+"','ProcessName':'python.exe'}")
                (scripts/'windows_process_owner.py').write_text(native)
                status={'pid':42,'creation_filetime':'123','run_id':'original','source_sha':'b'*64,'state':'healthy'}
                if scenario=='malformed':status.pop('run_id')
                (home/'status.json').write_text(json.dumps(status));trace=root/'trace.json'
                body=self.function_loader()+'\n$Python='+quote(sys.executable)+'\n$result=$null\ntry {$result=(Get-ExistingWatch).active}catch{}\n'+ \
                    '[IO.File]::WriteAllText('+quote(trace)+',(@{active=$result}|ConvertTo-Json))\n'
                self.run_ps(root,body)
                self.assertEqual(json.loads(trace.read_text())['active'],expected)

    def test_entry_keeps_independent_watch_when_vpn_wait_expires_before_any_service_action(self):
        with tempfile.TemporaryDirectory(prefix='clw-ab-offline-entry-') as raw:
            root=Path(raw);scripts,_=self.fixture(root)
            source=self.source
            # The original main flow and receipt are real; only offline probe
            # and independent watch process boundaries are fixture functions.
            mocks='''
function Start-VerifiedWatch {$Receipt.watch=@{state='retained';pid=77;source_sha=('a'*64)}}
function Wait-VpnProxy {throw 'fixture VPN still offline after waiting'}
'''
            main=source.index("\ntry {\n    if ($PSVersionTable.PSVersion.Major")
            source=source[:main]+mocks+source[main:]
            target=scripts/'recover_local_mcp.ps1';target.write_text(source,encoding='utf-8-sig')
            self.run_ps(root,'& '+quote(target)+' -PythonExecutable '+quote(sys.executable)+' -StartWatch -WaitForVpnSeconds 300\nexit $LASTEXITCODE\n')
            receipt=json.loads((root/'.local/ab-recovery.json').read_text())
            self.assertEqual(receipt['state'],'waiting_vpn');self.assertEqual(receipt['watch']['state'],'retained')
            self.assertEqual(receipt['entry_completed'],{'backend':False,'A':False,'B':False})
            self.assertFalse((root/'calls.jsonl').exists())

    def test_watch_observes_existing_real_entry_mutex_without_starting_recovery(self):
        with tempfile.TemporaryDirectory(prefix='clw-ab-lock-entry-') as raw:
            root=Path(raw);(root/'scripts').mkdir()
            body=self.function_loader()+'''
$LockName='Local\CLW-LocalMCP-Recovery-'+[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Utf8.GetBytes($ProjectRoot.ToLowerInvariant()))).Substring(0,16)
$mutex=[Threading.Mutex]::new($false,$LockName);$null=$mutex.WaitOne(0)
$code='import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from local_mcp_watch import recovery_idle;print(recovery_idle(Path(sys.argv[2])))'
try {
 $busy=& '''+quote(sys.executable)+''' -B -c $code '''+quote(ROOT/'scripts')+''' $ProjectRoot
 if($busy -ne 'False'){throw 'Held original entry mutex was not observed'}
}finally{$mutex.ReleaseMutex();$mutex.Dispose()}
$idle=& '''+quote(sys.executable)+''' -B -c $code '''+quote(ROOT/'scripts')+''' $ProjectRoot
if($idle -ne 'True'){throw 'Released original entry mutex stayed busy'}
'''
            self.run_ps(root,body)

    def test_duplicate_entry_preserves_original_unknown_receipt_before_any_new_launch(self):
        with tempfile.TemporaryDirectory(prefix='clw-ab-unknown-entry-') as raw:
            root=Path(raw);scripts,_=self.fixture(root)
            original=json.dumps({'protocol':1,'run_id':'e'*32,'launch_unknown':True,'state':'needs_attention'})
            latest=root/'.local/ab-recovery.json';latest.write_text(original)
            source=self.source;main=source.index("\ntry {\n    if ($PSVersionTable.PSVersion.Major")
            source=source[:main]+"\nfunction Test-VpnProxy {return $false}\n"+source[main:]
            target=scripts/'recover_local_mcp.ps1';target.write_text(source,encoding='utf-8-sig')
            self.run_ps(root,'& '+quote(target)+' -PythonExecutable '+quote(sys.executable)+' -StartWatch\nif($LASTEXITCODE -ne 1){throw "Unknown original entry was repeated"}\n')
            self.assertEqual(latest.read_text(),original)
            self.assertFalse((root/'calls.jsonl').exists())
            self.assertFalse(list((root/'.local').glob('ab-recovery-*.json')))

    def test_true_cold_entry_keeps_old_unknown_and_starts_watch_while_same_boot_is_refused(self):
        for new_boot in (False,True):
            with self.subTest(new_boot=new_boot),tempfile.TemporaryDirectory(prefix='clw-ab-preboot-entry-') as raw:
                root=Path(raw);scripts,_=self.fixture(root)
                original=json.dumps({'protocol':1,'run_id':'e'*32,'launch_unknown':True,'model_sends':0,'business_state_changed':False,
                    'boot':{'boot_id':'b'*32 if new_boot else 'a'*32},'coordinator':{'ProcessId':42,'CreationFiletime':'123'},'started_at':'2025-01-01T00:00:00+00:00'})
                latest=root/'.local/ab-recovery.json';latest.write_text(original)
                old=root/('.local/ab-recovery-'+('e'*32)+'.json');old.write_text(original)
                # Run the real decision helper and main PS entry. Only native
                # boot/owner/port observations have fixture values.
                fake='''import importlib.util,json,sys
from pathlib import Path
sys.path.insert(0,'''+repr(str(ROOT/'scripts'))+''')
spec=importlib.util.spec_from_file_location('clw_watch_contract','''+repr(str(ROOT/'scripts/local_mcp_watch.py'))+''')
implementation=importlib.util.module_from_spec(spec);spec.loader.exec_module(implementation)
def boot_identity():return {'boot_id':'a'*32,'boot_filetime':'134046144000000000'}
def preboot_service_evidence(root):
 return implementation.preboot_service_evidence(root,boot_fn=boot_identity,owners_fn=lambda _:{},backend_fn=lambda _:{},listener_fn=lambda *_:True,snapshot_fn=lambda:{},origin_fn=lambda _:'http://127.0.0.1:50842')
'''
                (scripts/'local_mcp_watch.py').write_text(fake)
                source=self.source;main=source.index("\ntry {\n    if ($PSVersionTable.PSVersion.Major")
                source=source[:main]+"\nfunction Test-VpnProxy {return $false}\nfunction Start-VerifiedWatch {$Receipt.watch=@{state='started';pid=77}}\nfunction Wait-VpnProxy {throw 'fixture VPN offline'}\n"+source[main:]
                target=scripts/'recover_local_mcp.ps1';target.write_text(source,encoding='utf-8-sig')
                self.run_ps(root,'& '+quote(target)+' -PythonExecutable '+quote(sys.executable)+' -StartWatch\nif($LASTEXITCODE -ne '+('0' if new_boot else '1')+'){throw "Wrong boot decision"}\n')
                receipt=json.loads(latest.read_text())
                self.assertEqual(old.read_text(),original)
                self.assertFalse((root/'calls.jsonl').exists())
                if new_boot:
                    self.assertEqual(receipt['state'],'waiting_vpn')
                    self.assertEqual(receipt['prior_service_startup']['run_id'],'e'*32)
                    self.assertEqual(receipt['coordinator']['ProcessName'],'pwsh.exe')
                else:self.assertEqual(latest.read_text(),original)


if __name__ == '__main__':
    unittest.main()
