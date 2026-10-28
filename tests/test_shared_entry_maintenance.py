"""Execute the formal PowerShell maintenance path with isolated owned-process fixtures."""
from pathlib import Path
import json
import socket
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import web_host_launcher as launcher

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(launcher.resolve_powershell7(), 'Existing PowerShell 7 required')
class SharedEntryMaintenanceTests(unittest.TestCase):
    shell = launcher.resolve_powershell7()

    @staticmethod
    def quote(value):
        return "'" + str(value).replace("'", "''") + "'"

    def run_case(self, scenario, restart=True):
        with tempfile.TemporaryDirectory(prefix='clw-maintenance-fixture-') as raw:
            root = Path(raw)
            scripts = root / 'scripts'
            scripts.mkdir()
            bridge = root / '.local/codex-web-bridge'
            bridge.mkdir(parents=True)
            local = root / 'localapp'
            auth = root / 'auth.txt'
            auth.write_text('private-fixture-credential')
            (bridge / 'union-config.json').write_text(json.dumps({'port': 18945, 'authorizationFile': str(auth)}))
            (bridge / 'shared-entry.json').write_text(json.dumps({'at': '2026-10-10T00:00:00Z', 'url': 'http://127.0.0.1:18945/mcp', 'unionPid': 111, 'tunnelPid': 444}))
            (bridge / 'settings.json').write_text(json.dumps({'tunnel': {'binaryPath': str(root / 'b-tunnel.exe'), 'tunnelId': 'tunnel_' + 'b' * 32}}))
            live = scenario.startswith('live_')
            status = {'state': 'ready' if live else 'stopped', 'runtimePid': 555 if live else None,
                      'endpoint': 'http://127.0.0.1:49269/v1',
                      'browser': {'status': 'ready', 'loading': False, 'tabs': [{'status': 'ready', 'loading': False}]} if live else None}
            if scenario == 'live_browser_busy':
                status['browser']['tabs'][0]['loading'] = True
            (bridge / 'status.json').write_text(json.dumps(status))
            if live:
                database = root / '.local/harness/harness.sqlite3'
                database.parent.mkdir()
                database.touch()
            for account, pid, port in [('a', 333, 58590), ('b', 444, 58560)]:
                home = root / '.local' / ('account-' + account + '-tunnel')
                home.mkdir()
                (home / 'health-url.txt').write_text('http://127.0.0.1:' + str(port))
                (home / 'owner.json').write_text(json.dumps({'pid': pid, 'tunnelId': 'tunnel_' + account * 32}))
            if scenario == 'invalid_health_origin':
                (root / '.local/account-a-tunnel/health-url.txt').write_text('http://example.invalid:58590')
            source = (ROOT / 'scripts/maintain_shared_entry.ps1').read_text('utf8')
            start = source.index('function Test-ClwEndpointListening {')
            end = source.index('function Get-ClwTunnelIdle {', start)
            source = source[:start] + '''function Test-ClwEndpointListening {
 param([Uri]$Endpoint)
 $global:NativePresenceReads++
 if($global:Scenario -eq 'endpoint_unknown'){throw 'fixture presence unknown'}
 return ($global:Scenario -eq 'stopped_endpoint_alive' -or ($global:Scenario -eq 'native_appeared' -and $global:NativePresenceReads -gt 1))
}
''' + source[end:]
            target = scripts / 'maintain_shared_entry.ps1'
            target.write_text(source, encoding='utf8')
            trace = root / 'trace.json'
            driver = scripts / 'driver.ps1'
            header = "$global:FixtureRoot=" + self.quote(root) + "\n$env:LOCALAPPDATA=" + self.quote(local) + "\n$global:Scenario=" + self.quote(scenario) + "\n$global:Trace=" + self.quote(trace) + "\n"
            driver.write_text(header + '''$global:Events=[Collections.Generic.List[object]]::new();$global:Spawned=0;$global:OwnerReads=0;$global:NativePresenceReads=0;$global:RuntimeReads=0;$global:AMetrics=0;$global:BMetrics=0
function Save-Event {param($Kind,$EventPid);$global:Events.Add(@{kind=$Kind;pid=$EventPid});[IO.File]::WriteAllText($global:Trace,(@{events=@($global:Events)}|ConvertTo-Json -Depth 8))}
function Get-CimInstance {param($ClassName,$Filter)
 $bun=Join-Path $global:FixtureRoot '.local/runtimes/bun-1.4.0/bun.exe'
 $service=Join-Path $global:FixtureRoot 'apps/codex-web-bridge/serve-union.cjs'
 $config=Join-Path $global:FixtureRoot '.local/codex-web-bridge/union-config.json'
 if($Filter -eq 'ParentProcessId=111'){return @(@{ProcessId=222;CreationDate='child-original';ExecutablePath=$bun;CommandLine=((Join-Path $global:FixtureRoot 'apps/codex-web-bridge/upstream/src/cli.ts')+' mcp --contract native --broker-socket fixture')})}
 if($Filter -eq 'ProcessId=111'){$global:OwnerReads++;return @{ProcessId=111;CreationDate=$(if($global:Scenario -eq 'owner_reused' -and $global:OwnerReads -gt 1){'replacement'}else{'original'});ExecutablePath=$bun;CommandLine=($service+' '+$config)}}
 if($Filter -eq 'ProcessId=222'){return @{ProcessId=222;CreationDate='child-original';ExecutablePath=$bun;CommandLine=((Join-Path $global:FixtureRoot 'apps/codex-web-bridge/upstream/src/cli.ts')+' mcp --contract native --broker-socket fixture')}}
 if($Filter -eq 'ProcessId=333'){return @{ProcessId=333;CreationDate='a-original';ExecutablePath=(Join-Path $env:LOCALAPPDATA 'WebCodex/tools/tunnel-client/0.0.12/windows-amd64/tunnel-client.exe');CommandLine=$(if($global:Scenario -eq 'wrong_a_owner'){'other profile'}else{Join-Path $global:FixtureRoot '.local/account-a-tunnel/profile.yaml'})}}
 if($Filter -eq 'ProcessId=444'){return @{ProcessId=444;CreationDate='b-original';ExecutablePath=(Join-Path $global:FixtureRoot 'b-tunnel.exe');CommandLine=('run --profile webcodex-account-b --profile-dir '+(Join-Path $global:FixtureRoot '.local/account-b-tunnel/profiles')+' ')}}
 return $null
}
function Invoke-RestMethod {param($Uri,$Method,$Headers,$Body,$ContentType,[switch]$NoProxy,$TimeoutSec)
 if($Uri -like '*/mcp'){$global:RuntimeReads++;$jobs=if($global:Scenario -eq 'runner_busy' -or ($global:Scenario -eq 'runner_became_busy' -and $global:RuntimeReads -gt 1)){1}else{0};return @{result=@{structuredContent=@{success=$true;output=@{jobs=@{active_count=$jobs}}}}}}
 if($Uri -like '*49269*'){return @{pid=555;active_http_turns=$(if($global:Scenario -eq 'live_http_busy'){1}else{0});active_browser_turns=$(if($global:Scenario -eq 'live_native_busy'){1}else{0})}}
 return @{service='clw-mcp-union';pid=$(if($global:Spawned){999}else{111});pendingNative=$(if($global:Scenario -eq 'union_native_busy'){1}else{0});activeRequests=$(if($global:Scenario -eq 'union_request_busy'){1}else{0});activeUpstream=$(if($global:Scenario -eq 'union_upstream_busy'){1}else{0})}
}
function Invoke-WebRequest {param($Uri,[switch]$NoProxy,$TimeoutSec,$MaximumRedirection)
 if($Uri -like '*/readyz'){return @{StatusCode=200;Content='ready'}}
 $account=if($Uri -like '*58590*'){'a'}else{'b'}
 if($account -eq 'a'){$global:AMetrics++}else{$global:BMetrics++}
 $busy=($global:Scenario -eq 'a_busy' -and $account -eq 'a') -or ($global:Scenario -eq 'b_busy' -and $account -eq 'b') -or ($global:Scenario -eq 'a_became_busy' -and $account -eq 'a' -and $global:AMetrics -gt 1)
 $id='tunnel_'+($account*32)
 if($global:Scenario -eq 'metrics_identity_changed'){$id='tunnel_'+('c'*32)}
 $content='dispatcher_worker_pool_occupancy '+$(if($busy){1}else{0})+"`n"+'command_end_to_end_latency_milliseconds_count{tunnel_id="'+$id+'"} 1'
 if($global:Scenario -eq 'occupancy_missing'){$content='command_end_to_end_latency_milliseconds_count{tunnel_id="'+$id+'"} 1'}
 return @{StatusCode=200;Content=$content}
}
function python {$global:LASTEXITCODE=0;return '{"activeRuns":0,"preservedPausedRuns":3,"unsettledMaintenance":0}'}
function Start-Process {param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError);Save-Event 'spawn' 999;$global:Spawned=999;return @{Id=999}}
function Stop-Process {param($Id,$ErrorAction);Save-Event 'stop' $Id}
function Wait-Process {param($Id,$Timeout,$ErrorAction)}
function Start-Sleep {param($Milliseconds)}
try { & ''' + self.quote(target) + (' -Restart -ExpectedOwnerPid 111' if restart else '') + '''
 Save-Event 'success' 0
}catch{Save-Event 'refused' 0;Write-Output $_.Exception.Message}
''', encoding='utf8')
            result = launcher.run_bounded([self.shell, '-NoProfile', '-File', str(driver)], timeout=15, capture_stdout=True, capture_stderr=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('private-fixture-credential', result.stdout)
            events = json.loads(trace.read_text())['events'] if trace.exists() else []
            return result.stdout, events

    def test_closed_application_does_not_block_idle_shared_update(self):
        output, events = self.run_case('closed_idle')
        self.assertEqual([e['pid'] for e in events if e['kind'] == 'stop'], [111, 222])
        self.assertEqual([e['pid'] for e in events if e['kind'] == 'spawn'], [999])
        self.assertIn('"nativeOwnerAbsent": true', output)
        self.assertIn('"historicalRequestsPreserved": true', output)
        self.assertFalse(any(e['kind'] == 'refused' for e in events))

    def test_live_idle_application_keeps_native_browser_and_ledger_checks(self):
        output, events = self.run_case('live_idle')
        self.assertEqual([e['pid'] for e in events if e['kind'] == 'stop'], [111, 222])
        self.assertIn('"nativeOwnerAbsent": false', output)
        self.assertIn('"preservedPausedRuns": 3', output)

    def test_actual_or_unknown_activity_never_stops_any_owner(self):
        scenarios = ['a_busy', 'b_busy', 'a_became_busy', 'runner_busy', 'runner_became_busy',
                     'union_native_busy', 'union_request_busy', 'union_upstream_busy',
                     'live_native_busy', 'live_http_busy', 'live_browser_busy',
                     'stopped_endpoint_alive', 'endpoint_unknown', 'native_appeared',
                     'wrong_a_owner', 'metrics_identity_changed', 'invalid_health_origin',
                     'occupancy_missing', 'owner_reused']
        for scenario in scenarios:
            with self.subTest(scenario=scenario):
                _, events = self.run_case(scenario)
                self.assertTrue(any(e['kind'] == 'refused' for e in events))
                self.assertFalse(any(e['kind'] in ('stop', 'spawn') for e in events))

    def test_default_inspection_never_mutates(self):
        output, events = self.run_case('closed_idle', restart=False)
        self.assertIn('"canRestart": true', output)
        self.assertFalse(any(e['kind'] in ('stop', 'spawn') for e in events))

    def test_native_presence_uses_actual_loopback_connection_and_refusal(self):
        source = (ROOT / 'scripts/maintain_shared_entry.ps1').read_text('utf8')
        start = source.index('function Test-ClwEndpointListening {')
        end = source.index('function Get-ClwTunnelIdle {', start)
        with tempfile.TemporaryDirectory(prefix='clw-native-presence-fixture-') as raw:
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            live_port = listener.getsockname()[1]
            absent = socket.socket()
            absent.bind(('127.0.0.1', 0))
            absent_port = absent.getsockname()[1]
            absent.close()
            script = Path(raw) / 'presence.ps1'
            script.write_text(source[start:end] + f"\n@{{live=(Test-ClwEndpointListening ([Uri]'http://127.0.0.1:{live_port}/v1'));absent=(Test-ClwEndpointListening ([Uri]'http://127.0.0.1:{absent_port}/v1'))}} | ConvertTo-Json -Compress\n", encoding='utf8')
            try:
                result = launcher.run_bounded([self.shell, '-NoProfile', '-File', str(script)], timeout=10, capture_stdout=True, capture_stderr=True)
            finally:
                listener.close()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'live': True, 'absent': False})


if __name__ == '__main__':
    unittest.main()
