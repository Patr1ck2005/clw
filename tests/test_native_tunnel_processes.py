from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import contextlib, ctypes, io, json, socket, struct, sys, tempfile, unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import native_tunnel_processes as reader
import web_host_launcher as launcher

ROOT = Path(__file__).resolve().parents[1]


class NativeTunnelTests(unittest.TestCase):
    def setUp(self):
        self.row = {'ProcessId': 7, 'ProcessName': 'tunnel-client.exe', 'ParentProcessId': 6,
                    'ExecutablePath': 'C:/owned/tunnel-client.exe', 'CommandLine': 'private-fixture', 'CreationFiletime': '1234'}
    def identity(self, pid):
        return {'ProcessId': pid, 'ProcessName': self.row['ProcessName'], 'CreationFiletime': '1234'}
    def query(self, rows, **kwargs):
        return reader.process_rows({'tunnel-client.exe'}, observe=lambda **_: rows, identity=self.identity, sleep=lambda _: None, **kwargs)
    def test_original_creation_parent_and_private_command_are_preserved(self):
        rows = self.query([self.row, {'ProcessId': 0, 'ProcessName': '[system process]'}])
        self.assertEqual(rows[0]['ParentProcessId'], 6); self.assertEqual(rows[0]['CreationFiletime'], '1234')
        self.assertEqual(rows[0]['CommandLine'], 'private-fixture')
    def test_positive_absence_and_exact_missing_pid_are_empty(self):
        self.assertEqual(self.query([]), []); self.assertEqual(self.query([self.row], pid=8), [])
        with self.assertRaises(ValueError): self.query([self.row], pid=0)
    def test_native_race_is_retried_only_as_read(self):
        delays = []
        with patch.object(reader.native, 'process_inventory', side_effect=[reader.native.OwnershipUnavailable(), [self.row]]) as query:
            rows = reader.process_rows({'tunnel-client.exe'}, identity=self.identity, sleep=delays.append)
        self.assertEqual(len(rows), 1); self.assertEqual(query.call_count, 2); self.assertEqual(delays, [.025])
    def test_persistent_unknown_is_three_reads_not_empty(self):
        for value in [None, False, {}, [{**self.row, 'ParentProcessId': None}], [{**self.row, 'CreationFiletime': '0'}],
                      [{**self.row, 'ExecutablePath': 'C:/wrong/node.exe'}], [{**self.row, 'CommandLine': ''}], [self.row, self.row]]:
            with self.subTest(value=value), patch.object(reader.native, 'process_inventory', return_value=value) as query:
                with self.assertRaises(reader.NativeReadUnavailable): reader.process_rows({'tunnel-client.exe'}, identity=self.identity, sleep=lambda _: None)
                self.assertEqual(query.call_count, 3)
    def test_exact_creation_change_never_returns_prior_pid(self):
        with self.assertRaises(reader.NativeReadUnavailable):
            reader.process_rows({'tunnel-client.exe'}, observe=lambda **_: [self.row],
                identity=lambda pid: {**self.identity(pid), 'CreationFiletime': '5678'}, sleep=lambda _: None)
    def test_default_cli_metadata_never_prints_private_argv(self):
        out = io.StringIO()
        with patch.object(reader, 'process_rows', return_value=[{**self.row, 'Name': 'tunnel-client.exe'}]), contextlib.redirect_stdout(out):
            self.assertEqual(reader.main([]), 0)
        self.assertNotIn('private-fixture', out.getvalue()); self.assertNotIn('CommandLine', out.getvalue())
        self.assertTrue(json.loads(out.getvalue())['complete'])
    def test_private_cli_capture_opt_in_and_failure_are_fixed_codes(self):
        out = io.StringIO(); err = io.StringIO()
        with patch.object(reader, 'process_rows', side_effect=OSError('private-fixture')), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(reader.main(['--with-command-line']), 2)
        self.assertEqual(out.getvalue(), ''); self.assertEqual(err.getvalue().strip(), 'native_process_ownership_unavailable')
    def table(self, ports):
        rows = []
        for pid, address, port in ports:
            row = reader.native._Tcp4(); row.state = 2; row.pid = pid; row.local_port = socket.htons(port)
            row.local_address = struct.unpack('<I', socket.inet_pton(socket.AF_INET, address))[0]; rows.append(row)
        return ctypes.create_string_buffer(struct.pack('<I', len(rows)) + b''.join(bytes(row) for row in rows))
    def listeners(self, ports, *, bad=False, change=False):
        row = {**self.row, 'ProcessName': 'webcodex-server.exe', 'ExecutablePath': 'C:/owned/webcodex-server.exe'}
        buffer = self.table(ports); closed = []; marks = []
        def marker(_): marks.append(1); return 5678 if change and len(marks) % 2 == 0 else 1234
        api = SimpleNamespace(open=lambda _: 7, close=closed.append, marker=marker, image=lambda _: row['ExecutablePath'],
                              tcp_table=lambda _: (buffer, 4 if bad else len(buffer)))
        result = reader.backend_listeners(observe=lambda **_: [row], identity=lambda pid: {'ProcessId': pid, 'ProcessName': row['ProcessName'], 'CreationFiletime': '1234'},
            api_factory=lambda: api, sleep=lambda _: None)
        return result, closed
    def test_cold_listener_query_preserves_all_owned_loopback_ports(self):
        result, closed = self.listeners([(7, '127.0.0.1', 50842), (7, '0.0.0.0', 22), (8, '127.0.0.1', 9999)])
        self.assertEqual(result['listeners'], [{'LocalAddress': '127.0.0.1', 'LocalPort': 50842, 'OwningProcess': 7}]); self.assertEqual(closed, [7])
        result, _ = self.listeners([(7, '127.0.0.1', 50842), (7, '127.0.0.1', 50843)])
        self.assertEqual(len(result['listeners']), 2)
    def test_bad_table_or_original_server_exit_is_unknown(self):
        for kwargs in ({'bad': True}, {'change': True}):
            with self.subTest(kwargs=kwargs), self.assertRaises(reader.NativeReadUnavailable): self.listeners([(7, '127.0.0.1', 50842)], **kwargs)
    def test_unknown_server_census_has_only_three_total_reads(self):
        with patch.object(reader.native, 'process_inventory', side_effect=reader.native.OwnershipUnavailable()) as query:
            with self.assertRaises(reader.NativeReadUnavailable): reader.backend_listeners(sleep=lambda _: None)
        self.assertEqual(query.call_count, 3)


class PowerShellTunnelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shell = launcher.resolve_powershell7()
    def quote(self, value): return "'" + str(value).replace("'", "''") + "'"
    def run_case(self, account, scenario, health_wait=1, credentials=None):
        with tempfile.TemporaryDirectory(prefix='clw-tunnel-fixture-') as raw:
            root = Path(raw); scripts = root / 'scripts'; scripts.mkdir(); bridge = root / '.local/codex-web-bridge'; bridge.mkdir(parents=True)
            (scripts/'webcodex_backend.py').write_text(
                "from pathlib import Path\ndef wait_mcp_ready(root,timeout=30,*,union=False):\n"
                " if (Path(root)/'mcp-not-ready').exists():raise RuntimeError('mcp_startup_not_ready')\n"
                " return {'state':'ready'}\n")
            if 'mcp_not_ready' in scenario:(root/'mcp-not-ready').touch()
            home = root / '.local' / ('account-' + account + '-tunnel'); home.mkdir(); (home / 'profiles').mkdir()
            local = root / 'localapp'; desktop = local / 'dev.webcodex.desktop'; (desktop / 'secrets').mkdir(parents=True)
            auth = root / 'auth.txt'; auth.write_text('fixture-auth')
            secret_file = desktop / 'secrets/tunnel-config.json'
            secret_file.write_text(json.dumps(credentials if credentials is not None else
                {'tunnel_id': 'tunnel_' + 'a' * 32, 'api_key': 'fixture-key'}))
            secret_before = secret_file.read_bytes()
            (scripts / 'local_mcp_credentials.ps1').write_bytes((ROOT / 'scripts/local_mcp_credentials.ps1').read_bytes())
            (bridge / 'settings.json').write_text(json.dumps({'enabled': True, 'transport': 'shared-mcp', 'tunnel': {'binaryPath': str(scripts / 'health.ps1')}}))
            (scripts / 'health.ps1').write_text('''if($global:Scenario -like 'warm_health*') {
 $global:HealthReads++;Save-Event 'health' $global:HealthReads
 $global:LASTEXITCODE=if($global:Scenario -eq 'warm_health_exhausted' -or $global:HealthReads -lt 3){1}else{0}
}else{$global:LASTEXITCODE=0}
''')
            (bridge / 'union-config.json').write_text(json.dumps({'port': 18945, 'authorizationFile': str(auth), 'target': 'http://127.0.0.1:50842/mcp'}))
            (bridge / 'shared-entry.json').write_text(json.dumps({'unionPid': 19756, 'tunnelPid': 10676,
                'upstream':'http://127.0.0.1:50842/mcp','url':'http://127.0.0.1:18945/mcp','at':'fixture'}))
            (home / 'owner.json').write_text(json.dumps({'pid': 10676, 'tunnelId': 'tunnel_' + 'a' * 32}))
            profile = home / 'profiles/webcodex-account-b.yaml'; profile.write_text('Authorization: "file:' + str(auth) + '"')
            source = (ROOT / ('scripts/start_local_mcp_' + account + '.ps1')).read_text('utf8')
            start = source.index('function Get-ClwNativeInventory {'); end = source.index("$ErrorActionPreference='Stop'", start)
            mock = '''function Get-ClwNativeInventory {
 param([string[]]$Names=@('tunnel-client.exe'),[int]$ProcessId=0,[switch]$BackendListeners)
 Save-Event 'read' $ProcessId
 if($global:Scenario -eq 'native_unknown'){throw 'Native process ownership is unavailable.'}
 if($Names -contains 'bun.exe'){if($global:Scenario -eq 'warm_dead_owner'){return @{rows=@(@{CommandLine=(Join-Path $ProjectRoot 'apps\\codex-web-bridge\\serve-union.cjs')})}};return @{rows=@()}}
 if($BackendListeners){$ports=@(@{LocalAddress='127.0.0.1';LocalPort=50842;OwningProcess=34972});if($global:Scenario -eq 'cold_ambiguous'){$ports+=@{LocalAddress='127.0.0.1';LocalPort=50843;OwningProcess=34972}};return @{protocol=1;complete=$true;server=@{ProcessId=34972};listeners=$ports}}
 if($ProcessId -eq 31){$global:ParentReads++;$creation=if($global:Scenario -eq 'desktop_changed' -and $global:ParentReads -eq 2){'9999'}else{'1234'};return @{rows=@(@{Name='webcodex.exe';ProcessId=31;CreationFiletime=$creation;CommandLine=('server tunnel '+$DesktopHome+'\\runtime\\local\\webcodex.env')})}}
 if($ProcessId -eq 21){return @{rows=@(@{Name='tunnel-client.exe';ProcessId=21;CreationFiletime='5555'})}}
 if($global:Scenario -like 'desktop*' -and !$global:Stopped.Contains(21)){return @{rows=@(@{Name='tunnel-client.exe';ProcessId=21;ParentProcessId=31;CreationFiletime='5555';CommandLine=($DesktopHome+'\\runtime\\local\\regular-tunnel-runtime\\profile.yaml')})}}
 if($global:Scenario -eq 'warm_busy' -or $global:Scenario -like 'warm_dead*' -or $global:Scenario -like 'warm_health*'){$command=if($global:Account -eq 'a'){$ProfileFile}else{'run --profile webcodex-account-b --profile-dir '+$AccountHome+'\\profiles '};return @{rows=@(@{Name='tunnel-client.exe';ProcessId=10676;CommandLine=$command;CreationFiletime='1234'})}}
 return @{rows=@()}
}
function Assert-ClwUnionAbsent {if($global:Scenario -eq 'warm_dead_listener'){throw 'fixture occupied listener'}}
'''
            source = source[:start] + mock + source[end:]; target = scripts / ('start_local_mcp_' + account + '.ps1'); target.write_text(source, encoding='utf8')
            trace = root / 'trace.json'; driver = scripts / 'driver.ps1'
            header = "$env:LOCALAPPDATA=" + self.quote(local) + "\n$global:Account=" + self.quote(account) + "\n$global:Scenario=" + self.quote(scenario) + "\n$global:Trace=" + self.quote(trace) + "\n"
            if account == 'a':
                header += "$env:CONTROL_PLANE_TUNNEL_ID='tunnel_" + 'c' * 32 + "'\n$env:CONTROL_PLANE_API_KEY='environment-key'\n"
            driver.write_text(header + '''$global:Events=[Collections.Generic.List[object]]::new();$global:Stopped=[Collections.Generic.List[int]]::new();$global:ParentReads=0;$global:LASTEXITCODE=0;$global:UnionStarted=0;$global:HealthReads=0
function Save-Event {param($Kind,$EventPid);$global:Events.Add(@{kind=$Kind;pid=$EventPid});[IO.File]::WriteAllText($global:Trace,(@{events=@($global:Events)}|ConvertTo-Json -Depth 8))}
function Invoke-RestMethod {param($Uri,$Method,$Headers,$Body,$ContentType,[switch]$NoProxy,$TimeoutSec)
 if($Uri -like '*/mcp'){Save-Event 'jobs' 0;$active=if($global:Scenario -eq 'desktop_active'){2}else{0};return @{result=@{structuredContent=@{output=@{jobs=@{active_count=$active}}}}}}
 if(($global:Scenario -eq 'cold_union' -or $global:Scenario -like 'warm_dead*') -and !$global:UnionStarted){throw 'fixture union absent'}
 $pending=if($global:Scenario -in @('warm_busy','cold_busy','desktop_busy')){3}else{0}
 return @{service='clw-mcp-union';pid=$(if($global:UnionStarted){$global:UnionStarted}else{19756});pendingNative=$pending}
}
function Start-Process {param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError,$Environment);Save-Event 'spawn' 303;if($global:Account -eq 'a'){Save-Event 'credentials_match' ([int]($Environment.CLW_ACCOUNT_A_TUNNEL_KEY -ceq 'fixture-key' -and [IO.File]::ReadAllText($ProfileFile).Contains('tunnel_'+'a'*32)))};if($FilePath -like '*bun.exe'){$global:UnionStarted=303};return @{Id=303}}
function Stop-Process {param($Id);Save-Event 'stop' $Id;$global:Stopped.Add([int]$Id)}
function Wait-Process {param($Id,$Timeout,$ErrorAction)}
function Start-Sleep {param($Milliseconds,$Seconds)}
try { & ''' + self.quote(target) + " -PythonExecutable " + self.quote(sys.executable) + (" -TakeOverDesktopTunnel" if account == 'a' else ' -HealthWaitAttempts ' + str(health_wait)) + '''
 Save-Event 'exit' $LASTEXITCODE
 Save-Event 'success' 0
}catch{Save-Event 'refused' 0}
''', encoding='utf8')
            result = launcher.run_bounded([self.shell, '-NoProfile', '-File', str(driver)], timeout=12, capture_stdout=True, capture_stderr=True)
            self.assertEqual(result.returncode, 0, 'isolated PowerShell fixture failed')
            self.assertNotIn('fixture-key', result.stdout + result.stderr)
            self.assertEqual(secret_file.read_bytes(), secret_before)
            return json.loads(trace.read_text())['events']
    @unittest.skipUnless(launcher.resolve_powershell7(), 'Existing PowerShell 7 required')
    def test_a_desktop_migration_keeps_original_default_credentials(self):
        default = {'id': 'default', 'name': 'ChatGPT', 'enabled': True, 'autostart': True, 'revision': 1,
                   'credentials': {'tunnel_id': 'tunnel_' + 'a' * 32, 'api_key': 'fixture-key'}}
        other = {**default, 'id': 'another-profile', 'credentials': {'tunnel_id': 'tunnel_' + 'b' * 32, 'api_key': 'other-key'}}
        migrated = {'schema_version': 2, 'profiles': [other, default]}
        for credentials in (default['credentials'], migrated):
            with self.subTest(migrated='schema_version' in credentials):
                warm = self.run_case('a', 'warm_busy', credentials=credentials)
                self.assertFalse(any(e['kind'] in ('spawn', 'stop', 'refused', 'jobs') for e in warm))
                cold = self.run_case('a', 'cold_busy', credentials=credentials)
                self.assertFalse(any(e['kind'] in ('stop', 'refused') for e in cold))
                self.assertEqual([e['pid'] for e in cold if e['kind'] == 'credentials_match'], [1])
    @unittest.skipUnless(launcher.resolve_powershell7(), 'Existing PowerShell 7 required')
    def test_a_schema2_never_falls_back_from_missing_or_ambiguous_default(self):
        default = {'id': 'default', 'credentials': {'tunnel_id': 'tunnel_' + 'a' * 32, 'api_key': 'fixture-key'}}
        for profiles in ([], [{**default, 'id': 'other'}], [default, default], [{**default, 'credentials': None}]):
            with self.subTest(profiles=profiles):
                events = self.run_case('a', 'cold_busy', credentials={**default['credentials'], 'schema_version': 2, 'profiles': profiles})
                self.assertEqual([e['kind'] for e in events], ['refused'])
    @unittest.skipUnless(launcher.resolve_powershell7(), 'Existing PowerShell 7 required')
    def test_credential_parse_errors_do_not_expose_source_or_emit_credentials(self):
        with tempfile.TemporaryDirectory(prefix='clw-credentials-fixture-') as raw:
            root = Path(raw); secret = root / 'dummy.json'; driver = root / 'driver.ps1'
            driver.write_text('. ' + self.quote(ROOT / 'scripts/local_mcp_credentials.ps1') +
                '\ntry {$pair=Get-ClwDefaultTunnelCredentials -Path ' + self.quote(secret) +
                "; throw 'unexpected success'}catch{[Console]::Write($_.Exception.Message)}", encoding='utf8')
            for invalid in ('{"api_key":"fixture-key",', '{"schema_version":3,"api_key":"fixture-key"}',
                            '{"schema_version":2,"profiles":[],"api_key":"fixture-key"}'):
                with self.subTest(invalid=invalid):
                    secret.write_text(invalid); before = secret.read_bytes()
                    result = launcher.run_bounded([self.shell, '-NoProfile', '-File', str(driver)], timeout=12,
                                                 capture_stdout=True, capture_stderr=True)
                    self.assertEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, 'Existing default tunnel settings unavailable.')
                    self.assertEqual(result.stderr, '')
                    self.assertEqual(secret.read_bytes(), before)
    @unittest.skipUnless(launcher.resolve_powershell7(), 'Existing PowerShell 7 required')
    def test_actual_powershell_warm_cold_handoff_branches_preserve_current_work(self):
        cases = [('a','warm_busy',0,0,False),('b','warm_busy',0,0,False),
                 ('a','cold_busy',1,0,False),('b','cold_busy',1,0,False),('b','cold_union',2,0,False),
                 ('b','warm_dead_union',1,0,False),('b','warm_dead_owner',0,0,True),('b','warm_dead_listener',0,0,True),
                 ('a','desktop_busy',0,0,True),('a','desktop_active',0,0,True),
                 ('a','desktop_changed',0,0,True),('a','desktop_idle',1,2,False),
                 ('a','mcp_not_ready',0,0,True),('b','mcp_not_ready',0,0,True),
                 ('a','desktop_mcp_not_ready',0,0,True),
                 ('b','cold_ambiguous',0,0,True),('a','native_unknown',0,0,True),('b','native_unknown',0,0,True)]
        for account, scenario, spawns, stops, refused in cases:
            with self.subTest(account=account, scenario=scenario):
                events = self.run_case(account,scenario)
                self.assertEqual(sum(e['kind']=='spawn' for e in events),spawns)
                self.assertEqual(sum(e['kind']=='stop' for e in events),stops)
                self.assertEqual(any(e['kind']=='refused' for e in events),refused)
                if scenario=='warm_busy':self.assertFalse(any(e['kind']=='jobs' for e in events))
    @unittest.skipUnless(launcher.resolve_powershell7(), 'Existing PowerShell 7 required')
    def test_b_live_owner_health_wait_is_bounded_without_restart_or_job_reads(self):
        for scenario, exit_code in [('warm_health_late', 0), ('warm_health_exhausted', 1)]:
            with self.subTest(scenario=scenario):
                events = self.run_case('b', scenario, health_wait=3)
                self.assertEqual(sum(e['kind']=='health' for e in events), 3)
                self.assertFalse(any(e['kind'] in ('spawn','stop','jobs') for e in events))
                self.assertEqual([e['pid'] for e in events if e['kind']=='exit'], [exit_code])
    def test_scripts_have_no_cim_or_nettcp_dependency(self):
        for account in ('a','b'):
            source=(ROOT/('scripts/start_local_mcp_'+account+'.ps1')).read_text('utf8')
            self.assertNotIn('Get-CimInstance',source);self.assertNotIn('Get-NetTCPConnection',source)
            self.assertIn('native_tunnel_processes.py',source);self.assertIn('PythonExecutable',source)


if __name__ == '__main__': unittest.main()
