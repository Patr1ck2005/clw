"""Offline tests only. Never start servers, pair identities or call the network."""
from pathlib import Path
import importlib.util
import json
import os
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
OPS = ROOT

def module(name, path):
    spec = importlib.util.spec_from_file_location(name,path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded

host = module('host_process',OPS/'scripts/host_process.py')

class BootstrapTests(unittest.TestCase):
    def test_current_process_identity(self):
        row = host.inspect(os.getpid())
        self.assertEqual(row['pid'],os.getpid())
        self.assertGreater(row['created_filetime'],0)
        self.assertTrue(Path(row['image']).is_file())

    def test_environment_not_inherit_credentials(self):
        with patch.dict(os.environ,{'OPENAI_API_KEY':'synthetic-only','WEBCODEX_TOKEN':'synthetic-only','PATH':'test-path'}):
            env = host.clean_env()
        self.assertNotIn('OPENAI_API_KEY',env)
        self.assertNotIn('WEBCODEX_TOKEN',env)
        self.assertEqual(env['PATH'],'test-path')

    def test_nonvendor_execution_refused(self):
        with self.assertRaises(ValueError):
            host.spawn('workspace','server',[str(ROOT/'not-a-vendor.exe')])

    def test_unknown_component_refused(self):
        with self.assertRaises(ValueError):
            host.spawn('workspace','other',[str(host.BIN/'webcodex.exe')])

    def test_atomic_json(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/'receipt.json'
            host.write_json(path,{'value':'中文'})
            self.assertEqual(json.loads(path.read_text(encoding='utf-8')),{'value':'中文'})
            host.write_json(path,{'value':2})
            self.assertEqual(json.loads(path.read_text()),{'value':2})

    def test_unfinished_atomic_write_not_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'receipt.json'
            path.with_suffix('.json.tmp').write_text('unfinished')
            with self.assertRaises(FileExistsError):
                host.write_json(path,{'value':3})
            self.assertFalse(path.exists())

    def test_general_purpose_profile_only(self):
        self.assertEqual(host.PORTS, {'workspace':18791})
        host.require_profile('workspace')

    def test_old_role_profiles_cannot_launch(self):
        with patch.object(host.subprocess,'Popen') as launch:
            for profile in ['code','math','all','../code']:
                with self.assertRaises(ValueError):
                    host.spawn(profile,'server',[str(host.BIN/'webcodex-server.exe')])
            launch.assert_not_called()

    def test_missing_generic_configuration_never_launches(self):
        with tempfile.TemporaryDirectory() as d, patch.object(host,'ROOT',Path(d)), patch.object(host.subprocess,'Popen') as launch:
            with self.assertRaisesRegex(RuntimeError,'not initialized'):
                host.start('workspace')
            launch.assert_not_called()

if __name__=='__main__':
    unittest.main()
