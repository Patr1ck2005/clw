from contextlib import contextmanager
import hashlib,json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from product_runtime import RuntimeIdentity,StateLease,ProductError
from web_workspace_runtime import WebWorkspaceRuntimeIdentity,runtime_identity

class WorkspaceIdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.write('package.json',json.dumps({'name':'clw-web-workspace','version':'0.7.0-alpha.1','clw_data_epoch':1}))
        self.write('apps/control-center/harness.html','saved harness UI')
        self.write('apps/web-host/shell.js','original desktop source')
        self.write('scripts/serve_harness.py','original Harness source')
    def tearDown(self):self.tmp.cleanup()
    def write(self,name,value):
        p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value,encoding='utf8');return p
    def test_workspace_identity_accepts_new_product_without_weakening_legacy_validator(self):
        current=runtime_identity(self.root,'test')
        self.assertIsInstance(current,WebWorkspaceRuntimeIdentity)
        self.assertEqual(current.base['product'],'clw-web-workspace');self.assertFalse(current.base['fixed_release'])
        self.assertFalse(current.base['automatic_model_calls']);self.assertFalse(current.base['commit_describes_payload'])
        with self.assertRaisesRegex(ProductError,'invalid_product_package'):RuntimeIdentity(self.root,'test')
    def test_static_snapshot_is_frozen_and_source_edit_requires_restart(self):
        current=runtime_identity(self.root,'test');before=current.files['apps/control-center/harness.html']
        self.write('apps/control-center/harness.html','changed after start')
        self.assertEqual(current.files['apps/control-center/harness.html'],before)
        self.assertEqual(current.info()['disk_status'],'changed');self.assertTrue(current.info()['restart_required'])
    def test_desktop_adapter_edits_are_part_of_source_observation(self):
        current=runtime_identity(self.root,'test');self.write('apps/web-host/shell.js','changed desktop source')
        self.assertTrue(current.info()['restart_required'])
        current=runtime_identity(self.root,'test');self.write('apps/codex-web-bridge/upstream/src/cli.ts','new adapter source')
        self.assertTrue(current.info()['restart_required'])
    def test_fixed_channel_cannot_claim_unpackaged_worktree(self):
        for channel in ['candidate','stable']:
            with self.subTest(channel=channel),self.assertRaisesRegex(ProductError,'fixed_channel_requires_release'):
                runtime_identity(self.root,channel)
    def test_legacy_package_retains_original_product_identity(self):
        self.write('package.json',json.dumps({'name':'clw-control-center','version':'0.6.0'}))
        current=runtime_identity(self.root,'test');self.assertIsInstance(current,RuntimeIdentity)
        self.assertEqual(current.base['product'],'clw-control-center')
    def test_existing_harness_state_owner_is_preserved_without_migration(self):
        state=self.root/'retained-data'
        with StateLease(state) as owner:original=owner.identity
        before=(state/'_clw_state.json').read_bytes()
        current=runtime_identity(self.root,'test',original)
        with StateLease(state,original) as owner:self.assertEqual(owner.identity,current.base['state_id'])
        self.assertEqual((state/'_clw_state.json').read_bytes(),before)
    @contextmanager
    def candidate(self):
        from test_web_workspace_release import CandidateTests
        fixture=CandidateTests();fixture.setUp()
        try:
            item=fixture.selected();yield fixture,item,fixture.install_root/'versions'/item['build_id']
        finally:
            try:fixture.tearDown()
            finally:fixture.doCleanups()
    def test_actual_installed_manifest_is_verified_and_dirty_source_not_described_by_commit(self):
        with self.candidate() as (fixture,item,code):
            current=runtime_identity(code)
            self.assertEqual(current.base['build_id'],item['build_id']);self.assertTrue(current.base['verified_at_start'])
            self.assertEqual(current.base['channel'],'candidate');self.assertFalse(current.base['commit_describes_payload'])
            self.assertEqual(current.base['source_kind'],'frozen_current_worktree')
            self.assertEqual(current.base['payload_sha256'],item['payload_sha256'])
    def test_candidate_file_corruption_fails_before_harness_can_start(self):
        with self.candidate() as (fixture,item,code):
            (code/'apps/web-host/main.cjs').write_bytes(b'corrupted')
            with self.assertRaisesRegex(ProductError,'candidate_version_file_changed'):runtime_identity(code)
    def test_manifest_edit_after_start_requires_restart(self):
        with self.candidate() as (fixture,item,code):
            current=runtime_identity(code)
            marker=code/'_clw_web_release.json';marker.write_bytes(marker.read_bytes()+b' ')
            self.assertTrue(current.info()['restart_required'])

if __name__=='__main__':unittest.main()
