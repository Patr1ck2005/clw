"""Configure adapter tests use only isolated receipts; no app or model starts."""
import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import configure_codex_web_bridge as configure
import web_host_control


class WorkspaceConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.root_patch=patch.object(configure,'ROOT',self.root);self.root_patch.start();self.addCleanup(self.root_patch.stop)
        self.calls=[];self.next_state='completed';self.raise_error=False
        owner=self
        class Control:
            def __init__(self,profile,expected_root):
                owner.assertEqual(profile,owner.root/'.local/web-host');owner.assertEqual(expected_root,owner.root)
            def state(self):return {'app_instance_id':'original-instance','root':str(owner.root),'runtime_generation':7,'selected':'original-task'}
            def command(self,envelope,wait_seconds):
                owner.assertEqual(wait_seconds,20)
                file=owner.root/'.local/codex-web-bridge/connection-operations'/(envelope['operation_id']+'.json')
                owner.assertEqual(json.loads(file.read_text(encoding='utf8')),{'request':envelope,'receipt':None})
                owner.calls.append(envelope)
                if owner.raise_error:raise web_host_control.ControlError('app_control_transport_unknown_query_original_operation')
                result=({'etag':'old-etag','enabled':True,'webAccount':'A','appName':'Local-MCP-WKR','transport':'shared-mcp','sharedExisting':True,
                         'tunnel':{'tunnelId':'fixture','runtimeKeyFile':'fixture-key','binaryPath':'fixture-binary'}}
                        if envelope['action']=='connection-read' else {'state':'connection_settings_saved','reopenRequired':True,'modelSends':0})
                return {'operation_id':envelope['operation_id'],'state':owner.next_state,'result':result}
        self.control_patch=patch.object(web_host_control,'AppControl',Control);self.control_patch.start();self.addCleanup(self.control_patch.stop)
        self.process_patch=patch.object(configure.subprocess,'run',side_effect=AssertionError('offline subprocess must not run'))
        self.process_patch.start();self.addCleanup(self.process_patch.stop)

    def cli(self,args):
        output=io.StringIO()
        with patch.object(sys,'argv',['configure']+args),contextlib.redirect_stdout(output):configure.main()
        return json.loads(output.getvalue())

    def test_inspect_uses_workspace_identity_without_bun_or_settings_changes(self):
        result=self.cli(['--through-workspace','--inspect-json'])
        self.assertEqual(result['webAccount'],'A');self.assertEqual(len(self.calls),1)
        self.assertEqual(self.calls[0]['action'],'connection-read')
        self.assertEqual(self.calls[0]['expected_identity'],{'app_instance_id':'original-instance','root':str(self.root),'runtime_generation':7,'selected':'original-task'})
        file=Path(result['controlOperation']['receipt_file'])
        self.assertEqual(json.loads(file.read_text(encoding='utf8'))['receipt']['state'],'completed')
        self.assertFalse((self.root/'.local/codex-web-bridge/settings.json').exists())

    def test_shared_switch_uses_original_read_etag_and_returns_reopen_without_quitting(self):
        result=self.cli(['--through-workspace','--reuse-local-mcp','--web-account','B'])
        self.assertTrue(result['reopenRequired']);self.assertEqual([call['action'] for call in self.calls],['connection-read','connection-save'])
        self.assertEqual(self.calls[1]['payload'],{'expected_etag':'old-etag','enabled':True,'transport':'shared-mcp','webAccount':'B',
                                               'tunnel':{'tunnelId':'fixture','runtimeKeyFile':'fixture-key','binaryPath':'fixture-binary'}})
        self.assertNotEqual(self.calls[0]['operation_id'],self.calls[1]['operation_id'])

    def test_shared_explicit_app_name_is_forwarded_without_changing_account_or_transport_refs(self):
        result=self.cli(['--through-workspace','--reuse-local-mcp','--app-name','CLW-WKR'])
        self.assertEqual(result['modelSends'],0)
        self.assertEqual([call['action'] for call in self.calls],['connection-read','connection-save'])
        self.assertEqual(self.calls[1]['payload'],{'expected_etag':'old-etag','enabled':True,'transport':'shared-mcp',
            'webAccount':'A','appName':'CLW-WKR','tunnel':{'tunnelId':'fixture','runtimeKeyFile':'fixture-key','binaryPath':'fixture-binary'}})
        self.assertEqual(self.calls[1]['expected_identity'],self.calls[0]['expected_identity'])

    def test_inspection_never_saves_an_explicit_app_name(self):
        result=self.cli(['--through-workspace','--inspect-json','--app-name','CLW-WKR'])
        self.assertEqual(result['appName'],'Local-MCP-WKR');self.assertEqual(len(self.calls),1)
        self.assertEqual(self.calls[0]['action'],'connection-read')

    def test_offline_shared_cli_forwards_app_name_only_when_explicit(self):
        bun=self.root/'.local/runtimes/bun-1.4.0/bun.exe';bun.parent.mkdir(parents=True);bun.touch()
        current={'etag':'original-etag','webAccount':'B','appName':'Local-MCP-WKR','sharedExisting':True,
                 'tunnel':{'tunnelId':'fixture','runtimeKeyFile':'fixture-key','binaryPath':'fixture-binary'}}
        for extra in ([],['--app-name','CLW-WKR']):
            requests=[]
            def offline(command,**kwargs):
                self.assertEqual(command[0],str(bun));self.assertEqual(kwargs['cwd'],self.root)
                request=json.loads(kwargs['input']);requests.append(request)
                value=current if request['action']=='read' else {'state':'connection_settings_saved','modelSends':0}
                return SimpleNamespace(stdout=json.dumps({'ok':True,'result':value}),returncode=0)
            with self.subTest(extra=extra),patch.object(configure.subprocess,'run',side_effect=offline):
                self.assertEqual(self.cli(['--reuse-local-mcp']+extra)['modelSends'],0)
            self.assertEqual(len(requests),2);saved=requests[1]['payload']
            self.assertEqual(saved['webAccount'],'B');self.assertEqual(saved['tunnel'],current['tunnel'])
            self.assertEqual(saved['expected_etag'],'original-etag')
            if extra:self.assertEqual(saved['appName'],'CLW-WKR')
            else:self.assertNotIn('appName',saved)

    def test_unknown_returns_original_receipt_and_never_retries(self):
        self.next_state='unknown';output=io.StringIO()
        with contextlib.redirect_stdout(output),self.assertRaises(SystemExit) as stopped:
            configure.workspace_call({'action':'save','payload':{'webAccount':'B'}})
        self.assertEqual(stopped.exception.code,1);self.assertEqual(len(self.calls),1)
        result=json.loads(output.getvalue());self.assertEqual(result['state'],'unknown');self.assertFalse(result['replayed'])
        self.assertEqual(result['controlOperation']['operation_id'],self.calls[0]['operation_id'])
        self.assertEqual(json.loads(Path(result['controlOperation']['receipt_file']).read_text(encoding='utf8'))['receipt']['state'],'unknown')

    def test_transport_exception_keeps_intent_and_original_id(self):
        self.raise_error=True;output=io.StringIO()
        with contextlib.redirect_stdout(output),self.assertRaises(SystemExit):configure.workspace_call({'action':'save','payload':{}})
        result=json.loads(output.getvalue());self.assertEqual(result['state'],'unknown');self.assertEqual(len(self.calls),1)
        self.assertEqual(result['receipt']['operation_id'],self.calls[0]['operation_id'])

    def test_offline_entry_still_requires_packaged_runtime(self):
        with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit) as stopped:self.cli(['--inspect-json'])
        self.assertEqual(stopped.exception.code,2);self.assertEqual(self.calls,[])


if __name__=='__main__':unittest.main()
