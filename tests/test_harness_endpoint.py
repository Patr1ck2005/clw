from pathlib import Path
import json
import sys
import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import harness_endpoint as endpoint
from harness_goal_watch import Operator, Goals
from product_runtime import ProductError


class EndpointTests(unittest.TestCase):
    @unittest.skipUnless(os.name=='nt','native Windows identity check')
    def test_real_process_identity_shape_publishes_and_resolves_live_python(self):
        from windows_process_owner import process_identity
        with tempfile.TemporaryDirectory() as temporary:
            owner=process_identity(os.getpid());self.assertNotIn('ExecutablePath',owner)
            row=endpoint.publish(Path(temporary),'http://127.0.0.1:41003','real','real-store',owner)
            self.assertEqual(Path(row['executable']).resolve(),Path(sys.executable).resolve())
            self.assertEqual(endpoint.resolve(Path(temporary)),'http://127.0.0.1:41003')

    def test_goal_health_accepts_new_network_modes_but_not_stale_or_disconnected_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);folder=root/'.local/web-host';folder.mkdir(parents=True)
            goals=object.__new__(Goals);goals.root=root
            for mode in ['系统网络设置已应用','直连设置已应用','代理设置已应用']:
                health={'at':datetime.now(timezone.utc).isoformat(),'connected':True,'networkReady':True,'network':mode}
                (folder/'health.json').write_text(json.dumps(health));self.assertTrue(goals.health())
                (folder/'health.json').write_text(json.dumps({**health,'connected':False}));self.assertFalse(goals.health())
                (folder/'health.json').write_text(json.dumps({**health,'at':'2000-01-01T00:00:00+00:00'}));self.assertFalse(goals.health())

    def test_installations_discover_their_own_listener_and_reject_reused_pid(self):
        with tempfile.TemporaryDirectory() as temporary:
            first, second = Path(temporary) / 'first', Path(temporary) / 'second'
            owner = {'ProcessId': 123, 'CreationFiletime': 1000, 'ExecutablePath': str(first / 'python.exe')}
            endpoint.publish(first, 'http://127.0.0.1:41001', 'one', 'store-one', owner)
            endpoint.publish(second, 'http://127.0.0.1:41002', 'two', 'store-two', owner)
            self.assertEqual(endpoint.resolve(first, inspect_process=lambda pid: owner), 'http://127.0.0.1:41001')
            self.assertEqual(endpoint.resolve(second, inspect_process=lambda pid: owner), 'http://127.0.0.1:41002')
            with self.assertRaisesRegex(ValueError, 'owner_changed'):
                endpoint.resolve(first, inspect_process=lambda pid: {**owner, 'CreationFiletime': 2000})
            copied = second / '.local/harness/endpoint.json'
            copied.write_bytes((first / '.local/harness/endpoint.json').read_bytes())
            with self.assertRaisesRegex(ValueError, 'endpoint_invalid'):
                endpoint.resolve(second, inspect_process=lambda pid: owner)

    def test_preview_with_missing_owner_never_falls_back_to_legacy_listener(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / '.local').mkdir()
            (root / '.local/preview-installation.json').write_text('{}')
            with patch('urllib.request.urlopen') as legacy:
                with self.assertRaises(ProductError): Operator(root=root).request('status')
                legacy.assert_not_called()

    def test_remote_and_credential_origins_are_rejected_before_process_lookup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for origin in ['https://example.com:41001', 'http://user@127.0.0.1:41001', 'http://127.0.0.1:41001/path']:
                endpoint.publish(root, origin, 'one', 'store', {'ProcessId': 123, 'CreationFiletime': 1, 'ExecutablePath': 'python.exe'})
                with self.assertRaisesRegex(ValueError, 'endpoint_invalid'):
                    endpoint.resolve(root, inspect_process=lambda pid: self.fail('invalid endpoint was used'))


if __name__ == '__main__': unittest.main()
