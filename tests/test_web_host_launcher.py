from pathlib import Path
from datetime import datetime,timezone
import sys,tempfile,json,unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from web_host_launcher import supervise,explicit_exit,VERIFIED_VPN_STATE
import web_host_launcher as launcher


class FakeClock:
    def __init__(self):self.value=1_700_000_000
    def now(self):return self.value
    def monotonic(self):return self.value
    def advance(self,seconds):self.value+=seconds


class PreviewLauncherTests(unittest.TestCase):
    def test_preview_without_credentials_never_enters_legacy_ab_start(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);(root/'.local').mkdir();(root/'.local/preview-installation.json').write_text('{}')
            with patch('preview_installation.read',return_value={'manifest':{'auto_connect':True},'accounts':[{'id':'A','credentialConfigured':False}]}),patch.object(launcher,'run_bounded') as run,patch('webcodex_backend.prepare') as legacy:
                launcher.prepare_shared_entry(root);run.assert_not_called();legacy.assert_not_called()

    def test_preview_a_only_starts_only_its_one_hidden_watch(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);(root/'.local').mkdir();(root/'.local/preview-installation.json').write_text('{}')
            with patch('preview_installation.read',return_value={'manifest':{'auto_connect':True},'accounts':[{'id':'A','credentialConfigured':True}]}),patch.object(launcher,'run_bounded') as run,patch('webcodex_backend.prepare') as legacy:
                launcher.prepare_shared_entry(root);legacy.assert_not_called();run.assert_called_once()
                args=run.call_args.args[0];self.assertEqual(args[0],sys.executable);self.assertIn('--start',args)
                self.assertEqual(Path(args[4]),root/'scripts/preview_connection_watch.py')

    def test_explicit_private_powershell_does_not_silently_fall_back_to_path(self):
        with tempfile.TemporaryDirectory() as raw:
            binary=Path(raw)/'pwsh.exe';binary.touch()
            with patch.dict(launcher.os.environ,{'CLW_POWERSHELL':str(binary)}),patch.object(launcher.shutil,'which') as system:
                self.assertEqual(launcher.resolve_powershell7(),str(binary));system.assert_not_called()
            with patch.dict(launcher.os.environ,{'CLW_POWERSHELL':str(binary)+'-missing'}),patch.object(launcher.shutil,'which') as system:
                self.assertIsNone(launcher.resolve_powershell7());system.assert_not_called()


def connected_health(pid,started,ended):
    return {'pid':pid,'connected':True,'network':VERIFIED_VPN_STATE,
            'at':datetime.fromtimestamp(ended,timezone.utc).isoformat()}

class LauncherTests(unittest.TestCase):
    def setUp(self):
        # Existing lifecycle tests own synthetic Popen handles only. The new
        # native admission boundary is exercised separately below.
        probe=patch.object(launcher,'existing_browser',return_value=None)
        probe.start();self.addCleanup(probe.stop)
        identity=patch.object(launcher,'native_identity',side_effect=lambda pid,name=None:{'pid':pid,'creationFiletime':str(100000+pid)})
        identity.start();self.addCleanup(identity.stop)
    def simulate(self,runs):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);exe=root/'apps/web-host/node_modules/electron/dist/electron.exe'
            exe.parent.mkdir(parents=True);exe.touch()
            clock=FakeClock();calls=[];delays=[]
            health_file=root/'.local/web-host/health.json'
            class Process:
                def __init__(self,index):
                    self.pid=1200+index;self.run=runs[index];self.started=clock.now()
                def wait(self):
                    clock.advance(self.run.get('duration',1))
                    if 'health' in self.run:
                        payload=self.run['health'](self.pid,self.started,clock.now())
                        health_file.write_text(payload if isinstance(payload,str) else json.dumps(payload),encoding='utf-8')
                    return self.run.get('code',1)
            def spawn(args,**_kwargs):
                index=len(calls)
                if index>=len(runs):raise AssertionError('unexpected browser restart')
                calls.append(args)
                return Process(index)
            def sleep(seconds):delays.append(seconds);clock.advance(seconds)
            result=supervise(root,spawn,sleep,clock.now,clock.monotonic)
            state=json.loads((root/'.local/web-host/supervisor.json').read_text(encoding='utf-8'))
            return result,calls,delays,state

    def test_crash_retry_is_bounded_and_explicit_stop_ends_supervisor(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);exe=root/'apps/web-host/node_modules/electron/dist/electron.exe';exe.parent.mkdir(parents=True);exe.touch();calls=[];delays=[]
            class Process:
                pid=1234
                def wait(self):return 1
            def spawn(*a,**kw):calls.append(a);return Process()
            self.assertEqual(supervise(root,spawn,delays.append),1);self.assertEqual(len(calls),4);self.assertEqual(delays,[1,4,15])
            self.assertNotIn('--clw-recovered',calls[0][0])
            self.assertTrue(all('--clw-recovered' in call[0] for call in calls[1:]))
            (root/'.local/web-host/exit-record.json').write_text(json.dumps({'explicit':True,'pid':1234}),encoding='utf-8')
            calls.clear();self.assertEqual(supervise(root,spawn,delays.append),1);self.assertEqual(len(calls),1)
            self.assertFalse(explicit_exit(root/'.local/web-host/exit-record.json',5678))
    def test_successful_exit_is_not_restarted(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);exe=root/'apps/web-host/node_modules/electron/dist/electron.exe';exe.parent.mkdir(parents=True);exe.touch()
            class Process:
                pid=4321
                def wait(self):return 0
            self.assertEqual(supervise(root,lambda *a,**kw:Process(),lambda _:self.fail('normal exit restarted')),0)

    def test_explicit_interrupt_waits_for_original_child_before_releasing_supervisor_lock(self):
        from product_runtime import FileLease,ProductError
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);exe=root/'apps/web-host/node_modules/electron/dist/electron.exe';exe.parent.mkdir(parents=True);exe.touch()
            calls=[];lock=root/'.local/web-host/supervisor.lock'
            class Process:
                pid=4321
                def wait(inner):
                    calls.append('wait')
                    if len(calls)==1:raise KeyboardInterrupt()
                    with self.assertRaises(ProductError):
                        with FileLease(lock):pass
                    return 0
                def terminate(inner):calls.append('terminate')
            self.assertEqual(supervise(root,lambda *a,**kw:Process()),0)
            self.assertEqual(calls,['wait','terminate','wait'])
            self.assertEqual(json.loads((lock.parent/'supervisor.json').read_text())['state'],'stopped')
            self.assertEqual(json.loads((lock.parent/'user-exit.json').read_text()),{'explicit':True,'pid':4321})
            with FileLease(lock):pass

    def test_maintenance_exit_is_intentional_only_for_exact_current_owner(self):
        with tempfile.TemporaryDirectory() as raw:
            path=Path(raw)/'exit.json'
            path.write_text(json.dumps({'explicit':False,'reason':'maintenance','pid':1234}),encoding='utf8')
            self.assertTrue(explicit_exit(path,1234));self.assertFalse(explicit_exit(path,1235))
            path.write_text(json.dumps({'explicit':False,'pid':1234}),encoding='utf8')
            self.assertFalse(explicit_exit(path,1234))

    def test_startup_recovers_transient_readiness_and_clears_old_failure(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);delays=[];attempts=[]
            def prepare(_root):
                attempts.append(_root)
                if len(attempts)==1:raise RuntimeError('backend_server_not_ready')
                launcher.record_shared_entry(_root,'ready')
            launcher.prepare_shared_entry_bounded(root,delays.append,prepare)
            self.assertEqual(len(attempts),2);self.assertEqual(delays,[1])
            saved=json.loads((root/'.local/web-host/shared-entry-start.json').read_text(encoding='utf8'))
            self.assertEqual(saved['state'],'ready');self.assertNotIn('reason',saved)
            self.assertFalse(saved['automatic_fallback'])

    def test_startup_failure_is_bounded_before_opening_browser_once(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);exe=root/'apps/web-host/node_modules/electron/dist/electron.exe'
            exe.parent.mkdir(parents=True);exe.touch();delays=[];spawned=[]
            class Process:
                pid=4321
                def wait(self):return 0
            def spawn(*args,**kwargs):spawned.append(args);return Process()
            with patch.object(launcher,'prepare_shared_entry',side_effect=RuntimeError('backend_server_not_ready')) as prepare:
                self.assertEqual(supervise(root,spawn,delays.append),0)
            self.assertEqual(prepare.call_count,3);self.assertEqual(delays,[1,4]);self.assertEqual(len(spawned),1)
            saved=json.loads((root/'.local/web-host/shared-entry-start.json').read_text(encoding='utf8'))
            self.assertEqual((saved['state'],saved['stage'],saved['reason'],saved['attempts']),
                ('needs_attention','backend','backend_server_not_ready',3))

    def test_unverified_or_unknown_startup_never_retries_or_records_raw_errors(self):
        cases=[RuntimeError('backend_endpoint_has_unverified_owner'),RuntimeError('backend_multiple_owners:runner'),
            RuntimeError('backend_launch_manifest_missing'),PermissionError('fixture-private'),
            launcher.subprocess.TimeoutExpired(['fixture-private'],60,stderr='fixture-private'),
            launcher.SharedEntryStartupError('tunnel_a','startup_jobs_not_idle'),RuntimeError('fixture-private')]
        for error in cases:
            with self.subTest(error=type(error).__name__),tempfile.TemporaryDirectory() as raw:
                root=Path(raw)
                with patch.object(launcher,'prepare_shared_entry',side_effect=error) as prepare:
                    launcher.prepare_shared_entry_bounded(root,lambda _:self.fail('unknown startup retried'))
                self.assertEqual(prepare.call_count,1)
                saved=(root/'.local/web-host/shared-entry-start.json').read_text(encoding='utf8')
                self.assertNotIn('fixture-private',saved);self.assertEqual(json.loads(saved)['state'],'needs_attention')

    def test_powershell_path_precedes_explicit_installations(self):
        bundled=launcher.ROOT/'runtime/powershell/pwsh.exe'
        def only_bundled(path):
            self.assertEqual(path,bundled);return False
        with patch.object(launcher.shutil,'which',return_value='path-pwsh') as which,\
             patch.object(launcher.Path,'is_file',autospec=True,side_effect=only_bundled):
            self.assertEqual(launcher.resolve_powershell7(),'path-pwsh')
        which.assert_called_once_with('pwsh')

    def test_powershell_standard_installation_precedes_bundled_runtime(self):
        for variable in ('ProgramW6432','ProgramFiles','ProgramFiles(x86)'):
            with self.subTest(variable=variable),tempfile.TemporaryDirectory() as raw:
                home=Path(raw);installed=home/'installed/PowerShell/7/pwsh.exe'
                bundled=home/'.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe'
                for path in (installed,bundled):path.parent.mkdir(parents=True);path.touch()
                environ={name:str(home/name) for name in ('ProgramW6432','ProgramFiles','ProgramFiles(x86)')}
                environ[variable]=str(home/'installed')
                with patch.object(launcher.shutil,'which',return_value=None),\
                     patch.dict(launcher.os.environ,environ,clear=True),patch.object(launcher.Path,'home',return_value=home):
                    self.assertEqual(launcher.resolve_powershell7(),str(installed))

    def test_startup_without_path_uses_existing_bundled_shell_and_original_tunnel_contract(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);folder=root/'.local/codex-web-bridge';folder.mkdir(parents=True)
            (folder/'settings.json').write_text(json.dumps({'enabled':True,'transport':'shared-mcp','webAccount':'A'}))
            bundled=root/'.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe'
            bundled.parent.mkdir(parents=True);bundled.touch()
            environ={name:str(root/name) for name in ('ProgramW6432','ProgramFiles','ProgramFiles(x86)')}
            with patch('webcodex_backend.prepare') as backend,patch.object(launcher.shutil,'which',return_value=None),\
                 patch.dict(launcher.os.environ,environ,clear=True),patch.object(launcher.Path,'home',return_value=root),\
                 patch.object(launcher,'run_bounded') as run:
                launcher.prepare_shared_entry_bounded(root,lambda _:self.fail('resolved startup retried'))
            backend.assert_called_once_with(root)
            self.assertEqual([call.args[0] for call in run.call_args_list],[
                [str(bundled),'-NoProfile','-File',str(root/'scripts/start_local_mcp_b.ps1'),'-PythonExecutable',launcher.sys.executable],
                [str(bundled),'-NoProfile','-File',str(root/'scripts/start_local_mcp_a.ps1'),'-PythonExecutable',launcher.sys.executable,'-TakeOverDesktopTunnel']])
            self.assertEqual([call.kwargs['timeout'] for call in run.call_args_list],[60,30])
            self.assertTrue(all(call.kwargs['cwd']==root and call.kwargs['check'] for call in run.call_args_list))
            saved=json.loads((root/'.local/web-host/shared-entry-start.json').read_text(encoding='utf8'))
            self.assertEqual(saved['state'],'ready');self.assertFalse(saved['automatic_fallback'])

    def test_missing_powershell_preserves_shell_failure_without_starting_tunnels(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);folder=root/'.local/codex-web-bridge';folder.mkdir(parents=True)
            (folder/'settings.json').write_text(json.dumps({'enabled':True,'transport':'shared-mcp','webAccount':'A'}))
            environ={name:str(root/name) for name in ('ProgramW6432','ProgramFiles','ProgramFiles(x86)')}
            with patch('webcodex_backend.prepare') as backend,patch.object(launcher.shutil,'which',return_value=None),\
                 patch.dict(launcher.os.environ,environ,clear=True),patch.object(launcher.Path,'home',return_value=root),\
                 patch.object(launcher,'run_bounded') as run:
                self.assertIsNone(launcher.resolve_powershell7())
                launcher.prepare_shared_entry_bounded(root,lambda _:self.fail('missing shell retried'))
            backend.assert_called_once_with(root);run.assert_not_called()
            saved=json.loads((root/'.local/web-host/shared-entry-start.json').read_text(encoding='utf8'))
            self.assertEqual((saved['state'],saved['stage'],saved['reason'],saved['attempts']),
                ('needs_attention','shell','startup_shell_missing',1))

    def test_tunnel_failure_retains_safe_cause_and_does_not_repeat_start(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);folder=root/'.local/codex-web-bridge';folder.mkdir(parents=True)
            (folder/'settings.json').write_text(json.dumps({'enabled':True,'transport':'shared-mcp','webAccount':'A'}))
            error=launcher.subprocess.CalledProcessError(1,['fixture-private'],stderr='A tunnel owner changed. fixture-private')
            with patch('webcodex_backend.prepare'),patch.object(launcher.shutil,'which',return_value='pwsh'),\
                 patch.object(launcher,'run_bounded',side_effect=error) as run:
                launcher.prepare_shared_entry_bounded(root,lambda _:self.fail('ownership failure retried'))
            self.assertEqual(run.call_count,1)
            saved=(root/'.local/web-host/shared-entry-start.json').read_text(encoding='utf8')
            self.assertNotIn('fixture-private',saved)
            self.assertEqual((json.loads(saved)['stage'],json.loads(saved)['reason']),('tunnel_b','startup_owner_unverified'))

    def test_a_deadline_replaces_stale_ready_and_does_not_replay_either_tunnel(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);folder=root/'.local/codex-web-bridge';folder.mkdir(parents=True)
            (folder/'settings.json').write_text(json.dumps({'enabled':True,'transport':'shared-mcp','webAccount':'A'}))
            launcher.record_shared_entry(root,'ready')
            phases=[]
            def start(args,**kwargs):
                phases.append(json.loads((root/'.local/web-host/shared-entry-start.json').read_text())['stage'])
                if len(phases)==2:raise launcher.subprocess.TimeoutExpired(args,kwargs['timeout'],stderr='private-fixture')
            with patch('webcodex_backend.prepare'),patch.object(launcher,'resolve_powershell7',return_value='pwsh'),\
                 patch.object(launcher,'run_bounded',side_effect=start) as run:
                launcher.prepare_shared_entry_bounded(root,lambda _:self.fail('deadline retried'))
            self.assertEqual(phases,['tunnel_b','tunnel_a']);self.assertEqual(run.call_count,2)
            saved=(root/'.local/web-host/shared-entry-start.json').read_text()
            self.assertNotIn('private-fixture',saved)
            state=json.loads(saved)
            self.assertEqual((state['state'],state['stage'],state['reason']),('needs_attention','tunnel_a','startup_timeout'))
            self.assertTrue(state['completion_unknown'])

    def test_accepted_backend_launch_failure_is_not_retried(self):
        import webcodex_backend as backend
        error=backend.BackendStartupError('backend_server_not_ready',[{'role':'server','pid':321}])
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);folder=root/'.local/codex-web-bridge';folder.mkdir(parents=True)
            (folder/'settings.json').write_text(json.dumps({'enabled':True,'transport':'shared-mcp'}))
            with patch.object(backend,'prepare',side_effect=error) as prepare:
                launcher.prepare_shared_entry_bounded(root,lambda _:self.fail('accepted launch retried'))
            self.assertEqual(prepare.call_count,1)
            state=json.loads((root/'.local/web-host/shared-entry-start.json').read_text())
            self.assertEqual(state['reason'],'backend_server_not_ready')
            self.assertTrue(state['completion_unknown'])

    def test_partial_launch_oserror_keeps_unknown_through_fixed_error_translation(self):
        import webcodex_backend as backend
        error=OSError('private-fixture')
        error.started=[{'role':'server','pid':321}];error.completion_unknown=True
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);folder=root/'.local/codex-web-bridge';folder.mkdir(parents=True)
            (folder/'settings.json').write_text(json.dumps({'enabled':True,'transport':'shared-mcp'}))
            with patch.object(backend,'prepare',side_effect=error) as prepare:
                launcher.prepare_shared_entry_bounded(root,lambda _:self.fail('partial launch retried'))
            self.assertEqual(prepare.call_count,1)
            saved=(root/'.local/web-host/shared-entry-start.json').read_text()
            self.assertNotIn('private-fixture',saved)
            state=json.loads(saved)
            self.assertEqual((state['state'],state['reason']),('needs_attention','startup_unavailable'))
            self.assertTrue(state['completion_unknown'])

    def test_verified_stable_run_renews_one_bounded_crash_burst(self):
        runs=[{}, {}, {'duration':70,'health':connected_health}, {}, {}, {}]
        result,calls,delays,state=self.simulate(runs)
        self.assertEqual(result,1)
        self.assertEqual(delays,[1,4,1,4,15])
        self.assertEqual(len(calls),6)
        self.assertTrue(all('--clw-recovered' in args for args in calls[1:]))
        self.assertEqual({key:state[key] for key in ('pid','restarts','state','reason')},{'pid':1205,'restarts':5,'state':'needs_attention','reason':'browser_crash_limit'})
        self.assertRegex(state['owner_epoch'],r'^[a-f0-9]{32}$')
        self.assertEqual(state['child_creation_filetime'],'101205')
        self.assertEqual(state['supervisor_pid'],launcher.os.getpid())

    def test_unverified_health_does_not_renew_crash_budget(self):
        def change(**fields):
            return lambda pid,started,ended:{**connected_health(pid,started,ended),**fields}
        cases={
            'missing':{'duration':70},
            'wrong_pid':{'duration':70,'health':lambda pid,start,end:change(pid=pid+1)(pid,start,end)},
            'disconnected':{'duration':70,'health':change(connected=False)},
            'unverified_vpn':{'duration':70,'health':change(network='VPN 不可用 · 直连已禁用')},
            'not_long_lived':{'duration':59,'health':connected_health},
            'before_stable_interval':{'duration':70,'health':lambda pid,start,end:{**connected_health(pid,start,end),'at':datetime.fromtimestamp(start+59,timezone.utc).isoformat()}},
            'stale_heartbeat':{'duration':100,'health':lambda pid,start,end:{**connected_health(pid,start,end),'at':datetime.fromtimestamp(end-16,timezone.utc).isoformat()}},
            'future_heartbeat':{'duration':70,'health':lambda pid,start,end:{**connected_health(pid,start,end),'at':datetime.fromtimestamp(end+1,timezone.utc).isoformat()}},
            'naive_timestamp':{'duration':70,'health':lambda pid,start,end:{**connected_health(pid,start,end),'at':datetime.fromtimestamp(end,timezone.utc).replace(tzinfo=None).isoformat()}},
            'malformed_json':{'duration':70,'health':lambda pid,start,end:'{bad'},
        }
        for name,last_run in cases.items():
            with self.subTest(name=name):
                result,calls,delays,state=self.simulate([{}, {}, {}, last_run])
                self.assertEqual(result,1)
                self.assertEqual(len(calls),4)
                self.assertEqual(delays,[1,4,15])
                self.assertEqual(state['state'],'needs_attention')

class SupervisorOwnershipTests(unittest.TestCase):
    def setUp(self):
        import web_host_supervisor_owner as owner
        from product_runtime import FileLease,ProductError,atomic_json
        self.owner=owner;self.FileLease=FileLease;self.ProductError=ProductError;self.atomic_json=atomic_json
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.exe=self.root/'apps/web-host/node_modules/electron/dist/electron.exe'
        self.exe.parent.mkdir(parents=True);self.exe.touch()
        self.folder=self.root/'.local/web-host';self.folder.mkdir(parents=True)
        self.state=self.folder/'supervisor.json';self.original=b'{"pid":999,"state":"stopped"}'
        self.state.write_bytes(self.original);self.pid=9123;self.token='a'*32
        self.created=str(116444736000000000+int(launcher.time.time()*10000000)-10000000)
        self.rows={self.pid:{'ProcessId':self.pid,'ProcessName':'electron.exe','ExecutablePath':str(self.exe),'CreationFiletime':self.created}}
        self.health={'pid':self.pid,'at':datetime.now(timezone.utc).isoformat(),'focusExistingProtocol':1,'focusInstanceId':self.token}
        probe=patch.object(owner,'retained_process_identities',side_effect=lambda pids:{pid:row for pid,row in self.rows.items() if pid in pids})
        self.probe=probe.start();self.addCleanup(probe.stop)
        identity=patch.object(owner,'process_identity',side_effect=lambda pid:{'ProcessId':pid,'ProcessName':'electron.exe','CreationFiletime':self.created})
        identity.start();self.addCleanup(identity.stop)
        prepare=patch.object(launcher,'prepare_shared_entry_bounded')
        self.prepare=prepare.start();self.addCleanup(prepare.stop)
        watcher=patch('harness_goal_watch.start_if_enabled')
        self.watcher=watcher.start();self.addCleanup(watcher.stop)

    def save_health(self):self.atomic_json(self.folder/'health.json',self.health)
    def save_owner(self,**extra):
        self.atomic_json(self.state,{'pid':self.pid,'state':'running','child_creation_filetime':self.created,**extra})
        self.original=self.state.read_bytes()
    def focus_spawn(self,calls):
        class Child:
            def wait(self,timeout):self.timeout=timeout;return 0
        def spawn(args,**kwargs):calls.append((args,kwargs));return Child()
        return spawn
    def unchanged(self):
        self.assertEqual(self.state.read_bytes(),self.original);self.prepare.assert_not_called();self.watcher.assert_not_called()

    def test_kernel_busy_duplicate_only_uses_advertised_focus_protocol_and_preserves_lifecycle(self):
        self.save_health();self.save_owner();calls=[]
        with self.FileLease(self.folder/'supervisor.lock'):
            self.assertEqual(supervise(self.root,spawn=self.focus_spawn(calls)),0)
        self.unchanged();self.assertEqual(len(calls),1)
        self.assertIn(self.owner.FOCUS_FLAG,calls[0][0]);self.assertIn(self.owner.FOCUS_TARGET+self.token,calls[0][0])
        self.assertTrue(calls[0][1]['close_fds'])

    def test_verified_legacy_health_primary_is_focused_without_shared_start(self):
        self.save_health();calls=[]
        self.assertEqual(supervise(self.root,spawn=self.focus_spawn(calls)),0)
        self.unchanged();self.assertEqual(len(calls),1)
        self.assertEqual(self.probe.call_args.args[0],{999,self.pid})

    def test_missing_or_invalid_protocol_stale_or_missing_health_never_spawns_known_live_child(self):
        self.save_owner()
        for value in [{key:value for key,value in self.health.items() if key!='focusExistingProtocol'},
                      {**self.health,'focusInstanceId':'bad'},{**self.health,'at':'2000-01-01T00:00:00Z'},
                      {**self.health,'pid':self.pid+1}]:
            with self.subTest(value=value):
                self.atomic_json(self.folder/'health.json',value)
                with self.assertRaises(self.ProductError):supervise(self.root,spawn=lambda *_args,**_kwargs:self.fail('unverified focus'))
                self.unchanged()
        (self.folder/'health.json').unlink()
        with self.assertRaises(self.ProductError):supervise(self.root,spawn=lambda *_args,**_kwargs:self.fail('missing health focus'))
        self.unchanged()

    def test_starting_kernel_owner_with_no_browser_cannot_be_replaced_or_write_status(self):
        self.rows={}
        with self.FileLease(self.folder/'supervisor.lock'):
            with self.assertRaisesRegex(self.ProductError,'original_owner_unverified'):
                supervise(self.root,spawn=lambda *_args,**_kwargs:self.fail('starting owner replaced'))
        self.unchanged()

    def test_live_retained_supervisor_without_child_refuses_new_start(self):
        self.rows[41]={'ProcessId':41,'ProcessName':'python.exe','ExecutablePath':launcher.sys.executable,'CreationFiletime':'1234'}
        self.save_owner(supervisor_pid=41,supervisor_creation_filetime='1234',canonical_profile=str(self.folder))
        self.rows.pop(self.pid)
        with self.assertRaisesRegex(self.ProductError,'original_owner_unverified'):self.owner.existing_browser(self.root,self.folder)
        self.unchanged()
    def test_old_supervisor_pid_reused_by_same_python_does_not_own_profile(self):
        self.save_owner(supervisor_pid=41,supervisor_creation_filetime='1234')
        self.rows={41:{'ProcessId':41,'ProcessName':'python.exe','ExecutablePath':launcher.sys.executable,'CreationFiletime':'5678'}}
        self.assertIsNone(self.owner.existing_browser(self.root,self.folder));self.unchanged()

    def test_pid_creation_change_refuses_focus_and_does_not_mutate_original(self):
        self.save_health()
        with patch.object(self.owner,'process_identity',return_value={'ProcessId':self.pid,'ProcessName':'electron.exe','CreationFiletime':'654321'}):
            with self.assertRaisesRegex(self.ProductError,'original_owner_unverified'):
                supervise(self.root,spawn=lambda *_args,**_kwargs:self.fail('reused PID focus'))
        self.unchanged()

    def test_fresh_previous_holder_heartbeat_and_new_same_image_child_are_not_adopted(self):
        self.save_health()
        self.rows[self.pid]['CreationFiletime']=str(116444736000000000+int(launcher.time.time()*10000000)+10000000)
        with self.assertRaisesRegex(self.ProductError,'original_owner_unverified'):self.owner.existing_browser(self.root,self.folder)
        self.save_owner();self.rows[self.pid]['CreationFiletime']=str(int(self.created)-1)
        with self.assertRaisesRegex(self.ProductError,'original_owner_unverified'):self.owner.existing_browser(self.root,self.folder)
        self.unchanged()

    def test_foreign_state_write_cannot_be_overwritten_and_original_child_is_waited(self):
        self.rows={};calls=[];foreign=b'{"owner_epoch":"foreign","state":"running"}'
        class Child:
            pid=8123
            def wait(inner):calls.append('wait');self.state.write_bytes(foreign);return 0
        with self.assertRaisesRegex(self.ProductError,'supervisor_state_changed'):
            supervise(self.root,spawn=lambda *_args,**_kwargs:Child())
        self.assertEqual(calls,['wait']);self.assertEqual(self.state.read_bytes(),foreign)
        with self.FileLease(self.folder/'supervisor.lock'):pass

    def test_only_retained_pids_are_requested_without_global_inventory_or_argv(self):
        self.rows={}
        with patch('windows_process_owner.process_inventory',side_effect=AssertionError('global argv inventory')):
            self.assertIsNone(self.owner.existing_browser(self.root,self.folder,own_pid=999))
        self.assertEqual(self.probe.call_args.args[0],set())
        self.state.unlink()
        self.assertIsNone(self.owner.existing_browser(self.root,self.folder))
        self.assertEqual(self.probe.call_args.args[0],set())

    def test_native_read_race_retries_only_observation_then_focuses_original(self):
        self.save_health();delays=[]
        with patch.object(self.owner,'retained_process_identities',side_effect=[self.owner.OwnershipUnavailable(),self.rows]) as probe:
            browser=self.owner.existing_browser(self.root,self.folder,sleep=delays.append)
        self.assertEqual(browser['pid'],self.pid);self.assertEqual(delays,[.025]);self.assertEqual(probe.call_count,2)
        self.unchanged()

    def test_denied_retained_pid_never_becomes_absent_after_bounded_reads(self):
        self.save_health();delays=[]
        with patch.object(self.owner,'retained_process_identities',side_effect=self.owner.OwnershipUnavailable()) as probe:
            with self.assertRaisesRegex(self.ProductError,'^web_workspace_ownership_unverified$'):
                self.owner.existing_browser(self.root,self.folder,sleep=delays.append)
        self.assertEqual(probe.call_count,3);self.assertEqual(delays,[.025,.075]);self.unchanged()

    def test_old_child_pid_reused_by_foreign_image_is_proven_absent_without_rewriting_metadata(self):
        self.save_owner();self.save_health()
        self.rows[self.pid]={**self.rows[self.pid],'ExecutablePath':'C:/foreign/python.exe','CreationFiletime':'8888'}
        before=(self.folder/'health.json').read_bytes()
        self.assertIsNone(self.owner.existing_browser(self.root,self.folder))
        self.assertEqual((self.folder/'health.json').read_bytes(),before);self.unchanged()

    def test_unknown_receipt_malformed_metadata_and_generation_change_refuse_without_spawn(self):
        for name in ['shared-entry-start.json','../preview-launch.json']:
            path=self.folder/name;self.atomic_json(path,{'completion_unknown':True})
            with self.assertRaisesRegex(self.ProductError,'completion_unknown'):self.owner.existing_browser(self.root,self.folder)
            path.unlink()
        health=self.folder/'health.json';health.write_bytes(b'interrupted metadata')
        with self.assertRaises(self.ProductError):self.owner.existing_browser(self.root,self.folder)
        health.unlink()
        def changed(pids):self.atomic_json(self.state,{'pid':42});return {}
        with patch.object(self.owner,'retained_process_identities',side_effect=changed):
            with self.assertRaisesRegex(self.ProductError,'ownership_unverified'):self.owner.existing_browser(self.root,self.folder)

    def test_different_saved_profile_is_not_adopted(self):
        self.save_owner(canonical_profile=str(self.folder/'foreign'))
        with self.assertRaisesRegex(self.ProductError,'original_owner_unverified'):self.owner.existing_browser(self.root,self.folder)
        self.unchanged()

    def test_focus_timeout_retains_unknown_without_retry_or_lifecycle_change(self):
        self.save_health();calls=[]
        class Child:
            def wait(inner,timeout):raise launcher.subprocess.TimeoutExpired('private-fixture',timeout)
        def spawn(*args,**kwargs):calls.append(1);return Child()
        with self.assertRaisesRegex(self.ProductError,'^web_workspace_focus_completion_unknown$'):supervise(self.root,spawn=spawn)
        self.assertEqual(calls,[1]);self.unchanged()

if __name__=='__main__':unittest.main()
