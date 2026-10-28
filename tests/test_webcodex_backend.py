from pathlib import Path
from types import SimpleNamespace
import io,json,sys,tempfile,threading,unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.error import HTTPError
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import webcodex_backend as backend
import web_host_launcher as launcher


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.config = {'server': 'C:/runtime/webcodex-server.exe',
                       'runner': 'C:/runtime/webcodex-runner.exe',
                       'runner_config': 'C:/original/runner.toml',
                       'env_file': 'C:/original/webcodex.env'}
        self.server = {'Name': 'webcodex-server.exe', 'ProcessId': 1,
                       'ExecutablePath': self.config['server'], 'CommandLine': 'server'}
        self.runner = {'Name': 'webcodex-runner.exe', 'ProcessId': 2,
                       'ExecutablePath': self.config['runner'],
                       'CommandLine': 'runner --config C:/original/runner.toml'}
        self.started = []

    def spawn(self, args, config, role):
        self.started.append((args, role))
        return SimpleNamespace(pid=10+len(self.started), poll=lambda: None)

    def run_case(self, rows, checks):
        probes = iter(checks)
        return backend.ensure(self.config, lambda: rows, self.spawn,
                              lambda _: next(probes), lambda _: None)

    def test_existing_desktop_services_are_reused_without_launching_anything(self):
        result = self.run_case([self.server, self.runner], [True])
        self.assertEqual(self.started, [])
        self.assertTrue(result['reusedServer'] and result['reusedRunner'])
        self.assertFalse(result['desktopLaunched'])

    def test_cold_start_uses_only_installed_background_binaries_and_original_config(self):
        result = self.run_case([], [False, False, True])
        self.assertEqual(self.started, [([self.config['server']], 'server'),
            ([self.config['runner'], '--config', self.config['runner_config']], 'runner')])
        self.assertEqual(len(result['started']), 2)

    def test_existing_server_only_starts_missing_runner(self):
        self.run_case([self.server], [True])
        self.assertEqual([role for _, role in self.started], ['runner'])

    def test_unknown_endpoint_owner_is_not_replaced(self):
        with self.assertRaisesRegex(RuntimeError, 'unverified_owner'):
            self.run_case([], [True])
        self.assertEqual(self.started, [])

    def test_unknown_or_multiple_processes_do_not_launch(self):
        for rows in ([self.server, self.server], [{**self.server, 'ExecutablePath': None}]):
            with self.assertRaises(RuntimeError):
                self.run_case(rows, [])
        self.assertEqual(self.started, [])

    def test_server_failure_never_starts_runner_or_repeats_server_launch(self):
        with self.assertRaisesRegex(RuntimeError, 'server_not_ready'):
            self.run_case([], [False] * 31)
        self.assertEqual([role for _, role in self.started], ['server'])

    def test_background_environment_uses_original_env_and_vpn_without_tunnel_keys(self):
        with patch.object(backend.subprocess, 'Popen') as popen, patch.dict(backend.os.environ, {
            'OPENAI_API_KEY': 'test-secret', 'CONTROL_PLANE_API_KEY': 'test-secret'}, clear=True):
            backend.launch([self.config['server']], self.config, 'server')
        kwargs = popen.call_args.kwargs
        self.assertEqual(kwargs['env']['WEBCODEX_ENV_FILE'], self.config['env_file'])
        self.assertEqual(kwargs['env']['HTTPS_PROXY'], 'http://127.0.0.1:17890')
        self.assertNotIn('OPENAI_API_KEY', kwargs['env'])
        self.assertNotIn('CONTROL_PLANE_API_KEY', kwargs['env'])
        self.assertEqual(kwargs['stdin'], backend.subprocess.DEVNULL)

    def test_launcher_prepares_backend_before_tunnels_and_clears_stale_error(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / '.local/codex-web-bridge').mkdir(parents=True)
            (root / '.local/web-host').mkdir(parents=True)
            (root / '.local/codex-web-bridge/settings.json').write_text(json.dumps({
                'enabled': True, 'transport': 'shared-mcp', 'webAccount': 'A'}))
            order = []
            with patch.object(backend, 'prepare', side_effect=lambda _: order.append('backend')), \
                 patch.object(launcher.shutil, 'which', return_value='pwsh'), \
                 patch.object(launcher, 'run_bounded', side_effect=lambda args, **_: order.append(args)):
                launcher.prepare_shared_entry(root)
            self.assertEqual(order[0], 'backend')
            self.assertTrue(order[1][3].endswith('start_local_mcp_b.ps1'))
            self.assertTrue(order[2][3].endswith('start_local_mcp_a.ps1'))
            self.assertIn('-TakeOverDesktopTunnel', order[2])
            state = json.loads((root / '.local/web-host/shared-entry-start.json').read_text())
            self.assertEqual(state['state'], 'ready')

    def native_rows(self):
        return [{**row, 'ProcessName': row['Name'], 'CreationFiletime': str(100 + row['ProcessId'])}
                for row in (self.server, self.runner)]

    def test_process_query_uses_only_two_native_service_names_without_cim(self):
        values = self.native_rows() + [
            {'ProcessId': 0, 'ProcessName': '[system process]', 'CommandLine': None},
            {'ProcessId': 3, 'ProcessName': 'python.exe', 'CommandLine': None}]
        with patch.object(backend, 'process_inventory', return_value=values) as observe, \
             patch.object(backend, 'run_bounded') as wrapper:
            rows = backend.processes()
        observe.assert_called_once_with(target_names=frozenset(('webcodex-server.exe', 'webcodex-runner.exe')))
        wrapper.assert_not_called()
        self.assertEqual([row['ProcessId'] for row in rows], [1, 2])
        self.assertEqual([row['Name'] for row in rows], ['webcodex-server.exe', 'webcodex-runner.exe'])
        self.assertEqual([row['CreationFiletime'] for row in rows], ['101', '102'])

    def test_native_query_retries_read_races_and_recovers_without_service_launch(self):
        sleeps = []
        with patch.object(backend, 'process_inventory', side_effect=[
                backend.OwnershipUnavailable(), OSError('private-fixture'), self.native_rows()]) as observe:
            rows = backend.processes(sleep=sleeps.append)
        self.assertEqual(observe.call_count, 3)
        self.assertEqual(sleeps, list(backend.PROCESS_READ_DELAYS))
        self.assertEqual(len(rows), 2)
        self.assertEqual(self.started, [])

    def test_native_query_definite_empty_is_empty_without_retry(self):
        with patch.object(backend, 'process_inventory', return_value=[]) as observe:
            self.assertEqual(backend.processes(sleep=lambda _: self.fail('unexpected retry')), [])
        observe.assert_called_once()

    def test_recovered_original_services_are_reused_without_probe_or_launch_replay(self):
        sleeps = []; probes = []
        def probe(_):
            probes.append(True); return True
        with patch.object(backend, 'process_inventory', side_effect=[
                backend.OwnershipUnavailable(), self.native_rows()]) as observe:
            result = backend.ensure(self.config,
                observe=lambda: backend.processes(sleep=sleeps.append), spawn=self.spawn,
                probe=probe, sleep=lambda _: self.fail('service wait is unexpected'))
        self.assertEqual(observe.call_count, 2)
        self.assertEqual(sleeps, [backend.PROCESS_READ_DELAYS[0]])
        self.assertEqual(probes, [True])
        self.assertEqual(self.started, [])
        self.assertEqual(result['started'], [])
        self.assertTrue(result['reusedServer'] and result['reusedRunner'])

    def test_native_query_unknown_or_incomplete_is_never_empty(self):
        invalid = [None, False, {}, [{'ProcessId': True, 'ProcessName': 'webcodex-server.exe'}],
                   [{**self.native_rows()[0], 'ProcessId': 0}],
                   [{**self.native_rows()[0], 'ExecutablePath': None}],
                   [{**self.native_rows()[0], 'CommandLine': ''}],
                   [{**self.native_rows()[0], 'CreationFiletime': '0'}],
                   [self.native_rows()[0], self.native_rows()[0]],
                   [{'ProcessId': 7, 'ProcessName': None}]]
        for value in invalid:
            with self.subTest(value=value), patch.object(backend, 'process_inventory', return_value=value) as observe:
                with self.assertRaisesRegex(RuntimeError, 'backend_process_identity_unknown') as caught:
                    backend.processes(sleep=lambda _: None)
                self.assertEqual(observe.call_count, 3)
                self.assertEqual(caught.exception.process_observation_attempts, 3)
        self.assertEqual(self.started, [])

    def test_native_query_final_error_is_sanitized_and_prepare_cannot_spawn(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); folder = root / '.local/web-host'; folder.mkdir(parents=True)
            (folder / 'backend-launch.json').write_text('{}')
            with patch.object(backend, 'read_config', return_value=self.config), \
                 patch.object(backend, 'process_inventory', side_effect=OSError('private-fixture')) as observe, \
                 patch.object(backend, 'launch') as spawn:
                with self.assertRaisesRegex(RuntimeError, 'backend_process_identity_unknown'):
                    backend.prepare(root)
            spawn.assert_not_called()
            self.assertEqual(observe.call_count, 3)
            saved = (folder / 'backend-start.json').read_text()
            self.assertNotIn('private-fixture', saved)
            state = json.loads(saved)
            self.assertEqual(state['started'], [])
            self.assertEqual(state['process_observation_attempts'], 3)
            self.assertEqual(state['reason'], 'backend_process_identity_unknown')
            self.assertFalse(state['completion_unknown'])

    def test_runner_config_is_exact_argument_not_substring(self):
        for command in ('runner --config=C:/original/runner.toml',
                        'runner --config "C:/original/runner.toml"'):
            with self.subTest(command=command):
                result = self.run_case([self.server, {**self.runner, 'CommandLine': command}], [True])
                self.assertTrue(result['reusedRunner'])
                self.assertEqual(self.started, [])
        result = self.run_case([self.server, {**self.runner,
            'CommandLine': 'runner --config C:/original/runner.toml.other'}], [True])
        self.assertFalse(result['reusedRunner'])
        self.assertEqual([role for _, role in self.started], ['runner'])

    def test_runner_unknown_argv_or_ambiguous_config_does_not_launch(self):
        for command in (None, '', 'runner --config', 'runner --config=',
                        'runner --config --foreground',
                        'runner --config C:/original/runner.toml --config C:/original/runner.toml'):
            with self.subTest(command=command):
                with self.assertRaisesRegex(RuntimeError, 'backend_process_identity_unknown'):
                    self.run_case([self.server, {**self.runner, 'CommandLine': command}], [])
        self.assertEqual(self.started, [])

    def test_readiness_refuses_truncated_output_and_propagates_deadline(self):
        config={**self.config,'cli':'fixture-cli','origin':'http://127.0.0.1:18900'}
        with patch.object(backend, 'run_bounded', return_value=SimpleNamespace(
            stdout='{}', stdout_truncated=True, returncode=0)):
            self.assertFalse(backend.ready(config))
        error=backend.subprocess.TimeoutExpired(['private-fixture'],5,stderr='private-fixture')
        with patch.object(backend,'run_bounded',side_effect=error):
            with self.assertRaises(backend.subprocess.TimeoutExpired):backend.ready(config)

    def test_probe_deadline_after_server_launch_preserves_original_launch(self):
        calls=[]
        def probe(_):
            calls.append(True)
            if len(calls)>1:raise backend.subprocess.TimeoutExpired(['private-fixture'],5)
            return False
        with self.assertRaises(backend.subprocess.TimeoutExpired) as caught:
            backend.ensure(self.config,lambda:[],self.spawn,probe,lambda _:None)
        self.assertEqual(len(calls),2)
        self.assertEqual([role for _,role in self.started],['server'])
        self.assertEqual(caught.exception.started,[{'role':'server','pid':11}])
        self.assertTrue(caught.exception.completion_unknown)

    def test_runner_spawn_oserror_keeps_accepted_server_identity_and_unknown(self):
        def spawn(args,config,role):
            if role=='runner':raise OSError('private-fixture')
            return self.spawn(args,config,role)
        probes=iter([False,True])
        with self.assertRaises(OSError) as caught:
            backend.ensure(self.config,lambda:[],spawn,lambda _:next(probes),lambda _:None)
        self.assertEqual(caught.exception.started,[{'role':'server','pid':11}])
        self.assertTrue(caught.exception.completion_unknown)

    def test_readiness_aggregate_deadline_stops_false_probes_without_relaunch(self):
        tick=[0];calls=[]
        def probe(_):
            calls.append(tick[0]);tick[0]+=3;return False
        def sleep(seconds):tick[0]+=seconds
        with self.assertRaises(backend.BackendStartupError) as caught:
            backend.ensure(self.config,lambda:[],self.spawn,probe,sleep,
                now=lambda:tick[0],readiness_timeout=8)
        self.assertEqual([role for _,role in self.started],['server'])
        self.assertLess(len(calls),5)
        self.assertTrue(caught.exception.completion_unknown)

    def test_builtin_probe_timeout_uses_remaining_aggregate_budget(self):
        tick=[0];calls=[]
        def probe(_config,timeout):
            calls.append(timeout);tick[0]+=.5;return len(calls)>1
        def observe():tick[0]+=3;return [self.server,self.runner]
        with patch.object(backend,'ready',side_effect=probe):
            backend.ensure(self.config,observe,self.spawn,sleep=lambda _:None,
                now=lambda:tick[0],readiness_timeout=5)
        self.assertEqual(calls,[2,1.5])
        self.assertEqual(self.started,[])

    def test_failed_prepare_replaces_stale_ready_with_safe_partial_state(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);folder=root/'.local/web-host';folder.mkdir(parents=True)
            (folder/'backend-launch.json').write_text('{}')
            (folder/'backend-start.json').write_text(json.dumps({'state':'ready'}))
            error=backend.subprocess.TimeoutExpired(['private-fixture'],5,stderr='private-fixture')
            error.started=[{'role':'server','pid':11}]
            with patch.object(backend,'read_config',return_value=self.config),\
                 patch.object(backend,'ensure',side_effect=error):
                with self.assertRaises(backend.subprocess.TimeoutExpired):backend.prepare(root)
            saved=(folder/'backend-start.json').read_text()
            self.assertNotIn('private-fixture',saved)
            state=json.loads(saved)
            self.assertEqual(state['state'],'needs_attention')
            self.assertEqual(state['reason'],'startup_timeout')
            self.assertEqual(state['started'],[{'role':'server','pid':11}])
            self.assertTrue(state['completion_unknown'])


class McpReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);folder=self.root/'.local/web-host';folder.mkdir(parents=True)
        self.secret='wck_original_backend_private_credential_12345'
        self.config={'version':1,'origin':'http://127.0.0.1:18900'}
        for field in ('server','runner','cli','env_file','runner_config'):
            target=self.root/(field+'.fixture');target.write_text('')
            self.config[field]=str(target.resolve())
        Path(self.config['env_file']).write_text('WEBCODEX_TOKEN='+json.dumps(self.secret)+'\n')
        self.manifest=folder/'backend-launch.json';self.manifest.write_text(json.dumps(self.config))
        self.clock=0
    def sleep(self,seconds):self.clock+=seconds
    def wait(self,**kwargs):return backend.wait_mcp_ready(self.root,now=lambda:self.clock,sleep=self.sleep,**kwargs)
    def reply(self,**extra):
        return {'jsonrpc':'2.0','id':'clw-backend-readiness','result':{
            'protocolVersion':'2025-06-18','capabilities':{'tools':{}},
            'serverInfo':{'name':'webcodex','version':'0.4.1'}},**extra}
    def response(self,value,content_type='application/json'):
        stream=io.BytesIO(json.dumps(value).encode() if isinstance(value,dict) else value)
        return SimpleNamespace(status=200,headers={'Content-Type':content_type},read=stream.read,read1=stream.read)
    def opener(self,values):
        class Opener:
            def __init__(self):self.requests=[];self.values=iter(values)
            def open(self,request,timeout):
                self.requests.append((request,timeout));value=next(self.values)
                if isinstance(value,Exception):raise value
                class Response:
                    def __enter__(self):return value
                    def __exit__(self,*args):return False
                return Response()
        return Opener()
    def union_scope(self,**changes):
        folder=self.root/'.local/codex-web-bridge';folder.mkdir(parents=True)
        auth=(self.root/'original-union-auth').resolve();auth.write_text('Bearer '+self.secret)
        config={'port':18945,'target':self.config['origin']+'/mcp','authorizationFile':str(auth),**changes}
        shared={'url':'http://127.0.0.1:18945/mcp','upstream':self.config['origin']+'/mcp','unionPid':1234}
        (folder/'union-config.json').write_text(json.dumps(config))
        (folder/'shared-entry.json').write_text(json.dumps(shared))
        return folder,auth

    def test_cold_mcp_wait_reuses_exact_config_and_does_not_prepare_or_spawn(self):
        calls=[];checks=iter([False,False,True]);before=self.manifest.read_text()
        def probe(config,timeout):calls.append((config,timeout));return next(checks)
        with patch.object(backend,'prepare') as prepare,patch.object(backend,'ensure') as ensure,patch.object(backend,'launch') as spawn:
            result=self.wait(probe=probe)
        self.assertEqual(result,{'state':'ready','mcpReady':True,'attempts':3,'service_start_requested':False})
        self.assertTrue(all(config==self.config and 0<timeout<=5 for config,timeout in calls))
        self.assertEqual(self.manifest.read_text(),before);prepare.assert_not_called();ensure.assert_not_called();spawn.assert_not_called()

    def runner_scope(self):
        Path(self.config['runner_config']).write_text('server_url = '+json.dumps(self.config['origin'])+
            '\nclient_id = "original-runner"\n')
        return [{'Name':'webcodex-server.exe','ProcessId':4,'CreationFiletime':'123',
            'ExecutablePath':self.config['server']}]

    def runner_reply(self, *, connected=True, age=2, client_id='original-runner'):
        return {'success':True,'output':{'focus':{'client_id':client_id,'connected':connected},
            'agents':{'online_count':1 if connected else 0,'clients':[
                {'client_id':client_id,'connected':connected,'last_seen_age_secs':age}]}}}

    def test_recovery_runner_gate_waits_through_95_second_cold_registration(self):
        rows=self.runner_scope();probes=[]
        def runner(config,client_id,timeout):
            probes.append((client_id,timeout));return self.clock>=95
        with patch.object(backend,'processes',return_value=rows),patch.object(backend,'mcp_ready',return_value=True) as mcp, \
                patch.object(backend,'runner_ready',side_effect=runner),patch.object(backend,'launch') as launch:
            result=self.wait(timeout=180,require_runner=True)
        self.assertTrue(result['runnerReady']);self.assertEqual(self.clock,96)
        self.assertTrue(all(client=='original-runner' and 0<timeout<=5 for client,timeout in probes))
        mcp.assert_called_once();launch.assert_not_called()

    def test_recovery_runner_gate_remains_bounded_when_client_never_registers(self):
        with patch.object(backend,'processes',return_value=self.runner_scope()), \
                patch.object(backend,'mcp_ready',return_value=True),patch.object(backend,'runner_ready',return_value=False) as runner:
            with self.assertRaisesRegex(RuntimeError,'^mcp_startup_not_ready$'):
                self.wait(timeout=180,require_runner=True)
        self.assertEqual(self.clock,180);self.assertEqual(runner.call_count,90)

    def test_recovery_runner_gate_stops_when_original_server_exits_at_thirty_seconds(self):
        rows=self.runner_scope()
        def runner(*args,**kwargs):self.clock+=5;return False
        with patch.object(backend,'processes',side_effect=lambda:rows if self.clock<30 else []), \
                patch.object(backend,'mcp_ready',return_value=True),patch.object(backend,'runner_ready',side_effect=runner) as read:
            with self.assertRaisesRegex(RuntimeError,'^mcp_startup_not_ready$'):
                self.wait(timeout=180,require_runner=True)
        self.assertLessEqual(self.clock,35);self.assertEqual(read.call_count,5)

    def test_recovery_runner_gate_rejects_server_creation_change_after_ready(self):
        rows=self.runner_scope();replacement=[{**rows[0],'CreationFiletime':'456'}]
        with patch.object(backend,'processes',side_effect=[rows,rows,replacement]), \
                patch.object(backend,'mcp_ready',return_value=True),patch.object(backend,'runner_ready',return_value=True):
            with self.assertRaisesRegex(RuntimeError,'^mcp_startup_not_ready$'):
                self.wait(timeout=180,require_runner=True)

    def test_runner_status_uses_exact_client_and_waits_only_exact_unregistered_error(self):
        unknown={'success':False,'error':'unknown_client_id: no caller-visible Runner matches the exact client_id',
            'output':{'error_kind':'unknown_client_id','client_id':'original-runner'}}
        opener=self.opener([HTTPError(self.config['origin'],400,'bad request',{'Content-Type':'application/json'},
            io.BytesIO(json.dumps(unknown).encode())),self.response(self.runner_reply())])
        with patch.object(backend,'build_opener',return_value=opener):
            self.assertFalse(backend.runner_ready(self.config,'original-runner'))
            self.assertTrue(backend.runner_ready(self.config,'original-runner'))
        request,_=opener.requests[0]
        self.assertEqual(request.full_url,self.config['origin']+'/api/runtime/status')
        self.assertEqual(json.loads(request.data),{'client_id':'original-runner','compact':False})

    def test_runner_status_authentication_and_foreign_unknown_errors_do_not_retry(self):
        rows=self.runner_scope()
        for code in (400,401,403,429):
            body={'success':False,'error':'unknown_client_id: no caller-visible Runner matches the exact client_id',
                'output':{'error_kind':'unknown_client_id','client_id':'foreign-runner'}}
            opener=self.opener([HTTPError(self.config['origin'],code,self.secret,
                {'Content-Type':'application/json'},io.BytesIO(json.dumps(body).encode()))])
            with self.subTest(code=code),patch.object(backend,'processes',return_value=rows), \
                    patch.object(backend,'mcp_ready',return_value=True),patch.object(backend,'build_opener',return_value=opener):
                with self.assertRaisesRegex(RuntimeError,'^mcp_startup_not_ready$') as caught:
                    self.wait(timeout=180,require_runner=True)
            self.assertEqual(len(opener.requests),1);self.assertEqual(self.clock,0)
            self.assertNotIn(self.secret,str(caught.exception))

    def test_runner_status_needs_current_exact_connected_client_and_recent_heartbeat(self):
        for value,expected in [(self.runner_reply(),True),(self.runner_reply(connected=False),False),
                (self.runner_reply(age=61),False),(self.runner_reply(age=True),False)]:
            with self.subTest(value=value),patch.object(backend,'build_opener',return_value=self.opener([self.response(value)])):
                self.assertEqual(backend.runner_ready(self.config,'original-runner'),expected)
        for value in (self.runner_reply(client_id='foreign-runner'),{'success':True,'output':{'focus':[]}}):
            with patch.object(backend,'build_opener',return_value=self.opener([self.response(value)])):
                with self.assertRaisesRegex(RuntimeError,'^mcp_startup_not_ready$'):
                    backend.runner_ready(self.config,'original-runner')

    def test_runner_gate_refuses_different_config_origin_before_any_request(self):
        self.runner_scope();Path(self.config['runner_config']).write_text(
            'server_url="http://127.0.0.1:18901"\nclient_id="original-runner"\n')
        with patch.object(backend,'mcp_ready') as mcp,patch.object(backend,'runner_ready') as runner:
            with self.assertRaisesRegex(RuntimeError,'^mcp_startup_not_ready$'):
                self.wait(timeout=180,require_runner=True)
        mcp.assert_not_called();runner.assert_not_called()

    def test_finite_deadline_never_repeats_prepare_or_clears_old_services(self):
        calls=[]
        def probe(config,timeout):calls.append(timeout);self.clock+=timeout;return False
        with patch.object(backend,'prepare') as prepare,patch.object(backend,'launch') as spawn:
            with self.assertRaisesRegex(RuntimeError,'^mcp_startup_not_ready$'):self.wait(timeout=7,probe=probe)
        self.assertEqual(calls,[5,1.5]);prepare.assert_not_called();spawn.assert_not_called()
        self.assertEqual(backend.failure_code(RuntimeError('mcp_startup_not_ready')),'mcp_startup_not_ready')
        self.assertFalse((self.root/'.local/web-host/backend-start.json').exists())

    def test_default_wait_is_thirty_seconds_and_each_read_uses_remaining_budget(self):
        calls=[]
        def probe(config,timeout):calls.append(timeout);self.clock+=timeout;return False
        with self.assertRaisesRegex(RuntimeError,'mcp_startup_not_ready'):self.wait(probe=probe)
        self.assertEqual(self.clock,30);self.assertTrue(all(0<value<=5 for value in calls))
        for timeout in (0,-1,301,float('inf'),float('nan')):
            with self.assertRaisesRegex(RuntimeError,'mcp_startup_not_ready'):self.wait(timeout=timeout,probe=lambda **kw:True)

    def test_initialize_is_real_read_only_and_ignores_environment_proxies(self):
        values=[self.response(self.reply())];opener=self.opener(values)
        with patch.object(backend,'build_opener',return_value=opener) as build,patch.dict(backend.os.environ,{'HTTP_PROXY':'http://private-fixture.invalid'}):
            result=self.wait()
        request,timeout=opener.requests[0];payload=json.loads(request.data)
        self.assertEqual(request.full_url,self.config['origin']+'/mcp');self.assertEqual(payload['method'],'initialize')
        self.assertEqual(payload['params']['protocolVersion'],'2025-06-18');self.assertEqual(request.get_header('Authorization'),'Bearer '+self.secret)
        self.assertEqual(request.get_header('Mcp-protocol-version'),'2025-06-18');self.assertEqual(request.get_header('Mcp-method'),'initialize')
        self.assertEqual(build.call_args.args[0].proxies,{});self.assertLessEqual(timeout,5)
        self.assertNotIn(self.secret,json.dumps(result));self.assertEqual(result['state'],'ready')

    def test_authentication_error_is_not_ready_and_is_sanitized_without_retry(self):
        for status in (401,403):
            opener=self.opener([HTTPError(self.config['origin']+'/mcp',status,self.secret,{},None)])
            with patch.object(backend,'build_opener',return_value=opener):
                with self.assertRaisesRegex(RuntimeError,'^mcp_startup_not_ready$') as caught:self.wait()
            self.assertEqual(len(opener.requests),1);self.assertNotIn(self.secret,str(caught.exception))

    def test_aliveness_json_errors_truncation_and_wrong_protocol_cannot_pass_initialize(self):
        invalid=[{'status':'alive'},self.reply(id='foreign'),self.reply(jsonrpc='1.0'),self.reply(error={'message':self.secret}),
            {'jsonrpc':'2.0','id':'clw-backend-readiness','result':{'protocolVersion':'2025-06-18','capabilities':{}}},
            self.reply(result={'protocolVersion':'2026-07-28','capabilities':{},'serverInfo':{'name':'webcodex','version':'0.4.1'}}),
            b'not-json',b'x'*(backend.MCP_READY_MAX_BODY+1)]
        for value in invalid:
            with patch.object(backend,'build_opener',return_value=self.opener([self.response(value)])):
                self.assertFalse(backend.mcp_ready(self.config))
        with patch.object(backend,'build_opener',return_value=self.opener([backend.ObservationError('redirect_rejected')])):
            self.assertFalse(backend.mcp_ready(self.config))

    def test_sse_keepalive_and_unrelated_events_are_not_the_ready_reply(self):
        body=(b': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":"other","result":{}}\n\n'+
              b'data: '+json.dumps(self.reply()).encode()+b'\n\n')
        with patch.object(backend,'build_opener',return_value=self.opener([self.response(body,'text/event-stream')])):
            self.assertTrue(backend.mcp_ready(self.config))
        with patch.object(backend,'build_opener',return_value=self.opener([self.response(b': ping\n\n','text/event-stream')])):
            self.assertFalse(backend.mcp_ready(self.config))

    def test_total_stream_read_deadline_does_not_accept_a_late_initialize(self):
        clock=[0];pieces=iter([b': ping\n\n',b'data: '+json.dumps(self.reply()).encode()+b'\n\n'])
        def read(_):clock[0]+=4;return next(pieces)
        response=SimpleNamespace(status=200,headers={'Content-Type':'text/event-stream'},read=read,read1=read)
        with patch.object(backend.time,'monotonic',side_effect=lambda:clock[0]),patch.object(backend,'build_opener',return_value=self.opener([response])):
            self.assertFalse(backend.mcp_ready(self.config,timeout=5))

    def test_token_and_manifest_format_failures_never_issue_a_request(self):
        for text in ('', 'WEBCODEX_TOKEN=short\n', 'WEBCODEX_TOKEN="bad\n',
                     'WEBCODEX_TOKEN='+self.secret+'\nWEBCODEX_TOKEN='+self.secret+'\n'):
            Path(self.config['env_file']).write_text(text);opener=self.opener([])
            with patch.object(backend,'build_opener',return_value=opener):self.assertFalse(backend.mcp_ready(self.config))
            self.assertEqual(opener.requests,[])
        self.manifest.write_text(json.dumps({**self.config,'origin':'https://private-fixture.invalid'}))
        with patch.object(backend,'mcp_ready') as probe:
            with self.assertRaisesRegex(RuntimeError,'^mcp_startup_not_ready$'):self.wait()
        probe.assert_not_called()

    def test_union_scope_uses_original_authorization_and_initialize_protocol_not_stateless_call_version(self):
        folder,auth=self.union_scope();before=(folder/'shared-entry.json').read_text();opener=self.opener([self.response(self.reply())])
        Path(self.config['env_file']).write_text('WEBCODEX_TOKEN=must-not-be-used\n')
        with patch.object(backend,'build_opener',return_value=opener):result=self.wait(union=True)
        request,_=opener.requests[0]
        self.assertEqual(request.full_url,'http://127.0.0.1:18945/mcp');self.assertEqual(request.get_header('Authorization'),auth.read_text())
        self.assertEqual(json.loads(request.data)['params']['protocolVersion'],'2025-06-18')
        self.assertEqual(request.get_header('Mcp-protocol-version'),'2025-06-18')
        self.assertEqual((folder/'shared-entry.json').read_text(),before);self.assertNotIn(self.secret,json.dumps(result))

    def test_union_wrong_target_port_shared_identity_or_auth_reference_rejects_before_network(self):
        folder,auth=self.union_scope();original=json.loads((folder/'union-config.json').read_text());shared=json.loads((folder/'shared-entry.json').read_text())
        cases=[({**original,'port':18946},shared),({**original,'port':True},shared),
            ({**original,'target':'http://127.0.0.1:18901/mcp'},shared),
            (original,{**shared,'url':'http://127.0.0.1:18946/mcp'}),(original,{**shared,'upstream':'http://private-fixture.invalid/mcp'}),
            ({**original,'authorizationFile':'relative-auth'},shared)]
        for union,metadata in cases:
            (folder/'union-config.json').write_text(json.dumps(union));(folder/'shared-entry.json').write_text(json.dumps(metadata))
            with patch.object(backend,'mcp_ready') as probe:
                with self.assertRaisesRegex(RuntimeError,'^mcp_startup_not_ready$'):self.wait(union=True)
            probe.assert_not_called()

    def test_isolated_real_http_initialize_waits_for_cold_handler_readiness_without_business_calls(self):
        owner=self;calls=[]
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])));calls.append(payload['method'])
                if self.path!='/mcp' or self.headers.get('Authorization')!='Bearer '+owner.secret:
                    self.send_error(403);return
                if len(calls)==1:self.send_error(503);return
                body=json.dumps(owner.reply()).encode();self.send_response(200);self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
            def log_message(self,*args):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            self.config['origin']='http://127.0.0.1:'+str(server.server_address[1]);self.manifest.write_text(json.dumps(self.config))
            with patch.dict(backend.os.environ,{'HTTP_PROXY':'http://127.0.0.1:1','ALL_PROXY':'http://127.0.0.1:1','NO_PROXY':''}),patch.object(backend,'prepare') as prepare,patch.object(backend,'launch') as spawn:
                result=self.wait(timeout=2)
            self.assertEqual(result['state'],'ready');self.assertEqual(calls,['initialize','initialize'])
            prepare.assert_not_called();spawn.assert_not_called()
        finally:server.shutdown();server.server_close();thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
