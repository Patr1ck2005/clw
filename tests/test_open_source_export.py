"""Isolated source-export tests. No browser, service, model, or real config is used."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('open_source_export', ROOT / 'scripts/export_open_source.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='clw-export-test-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.repo = self.base / 'source'
        self.repo.mkdir()
        self.out = self.base / 'public-export'
        self.git('init', '-q')
        self.git('config', 'user.name', 'Isolated Export Test')
        self.git('config', 'user.email', 'export-test@example.invalid')
        self.sample = {
            'schema_version': 1,
            'source': {'kind': 'tool_observation', 'observed_at': '2025-01-01T00:00:00Z',
                       'scope': 'Private old observation', 'live': False},
            'runtime': {'id': 'private-runtime', 'version': '0.4.1', 'runner_id': 'private-runner',
                        'runner_state': 'online', 'job_capacity': 4},
            'projects': [{'id': 'agent:private-runner:private-project', 'name': 'Private Project',
                          'path': 'D:/Private/Owner/Project', 'enabled': True}],
            'sessions': [{'id': 'wc_sess_private_example', 'project_id': 'agent:private-runner:private-project',
                          'title': 'Private session title', 'lifecycle': 'active',
                          'events': [{'id': 'evt_private_12345678', 'logical_id': 'wc_inv_private_12345678',
                                      'session_id': 'wc_sess_private_example', 'role': 'business',
                                      'kind': 'finished', 'tool': 'read_file', 'timestamp': 1735689600,
                                      'status': 'succeeded', 'duration_ms': 1, 'exit_code': 0}],
                          'counts': {'tool_calls': 1, 'succeeded': 1, 'failed': 0},
                          'events_total': 1, 'events_truncated': False}], 'jobs': []}
        self.legacy = {
            'store_id': 'private_store_12345678', 'page_id': 'web-private_12345678',
            'thread_id': 'hthr_private_12345678', 'request_id': 'private_request_12345678',
            'attempt_id': 'control_private_12345678', 'previous_attempt': 'control_previous_12345678',
            'url': 'https://chatgpt.com/c/private_conversation', 'account': 'A',
            'run_id': 'clw-run-private_12345678', 'root': r'd:\private\owner\project',
            'session_id': 'wc_sess_private_legacy', 'app_instance_id': 'private_app_12345678',
            'user_sha256': 'a' * 64, 'assistant_sha256': 'b' * 64, 'error_at': 1700000000000}
        self.put('LICENSE', 'MIT test license\n')
        self.put('README.md', 'Committed readme\n')
        self.put('AGENTS.md', 'Personal developer instructions and history\n')
        self.put('.gitignore', '*.ignored\n')
        self.put('START.cmd', '@echo off\n')
        self.put('package-lock.json', '{"lockfileVersion":3}\n')
        self.put('apps/example/source.js', 'export const useful = true;\n')
        self.put('ops/bootstrap-source/START.cmd', '@echo off\n')
        self.put('packaging/setup.iss', '[Setup]\n')
        self.put('scripts/example.py', 'VALUE = 1\n')
        self.put('tests/example.py', 'assert True\n')
        for path in ['evidence/private.json', 'checkpoints/DEV.md', 'CURRENT.md', 'PLAN.json',
                     'legacy-reference/README.md', 'docs/handoffs/private.md',
                     'docs/parallel/private.md', 'docs/harness/history/private.md',
                     'docs/harness/MATH_CONTEXT_HANDOFF.md', 'docs/requirements/private.md',
                     'docs/UNREVIEWED.md']:
            self.put(path, 'Do not publish this private fixture.\n')
        for path in ['docs/SOURCE.md', 'docs/ARCHITECTURE_REVIEW.md', 'docs/architecture/README.md',
                     'docs/WEB_WORKSPACE_START.md', 'docs/harness/APP_CONTROL.md',
                     'docs/licenses/third-party.txt']:
            self.put(path, 'Reviewed public documentation\n')
        for target, source in exporter.RECEIVERS.items():
            self.put(target, 'Private original receiver history\n')
            self.put(source, 'Reviewed public receiver protocol\n')
        self.put(exporter.OBSERVED, exporter.json_bytes(self.sample))
        self.put(exporter.OBSERVATION_BUILDER, '# Old generator with private observation\n')
        assignments = {'LEGACY_INCIDENT': 'private-incident-12345678', 'LEGACY': self.legacy,
                       'LEGACY_FILES': {'observation.json': 'c' * 64}}
        self.put(exporter.LEGACY_SOURCE, '\n'.join(k + ' = ' + repr(v) for k, v in assignments.items()) + '\n')
        self.put('apps/example/legacy-test.cjs', "const incident='private-incident-12345678'; const request='private_request_12345678';\n")
        self.put('tests/control-center.test.mjs', "const logical='wc_inv_private_12345678'; const runner='private-runtime';\n")
        self.put('config/harness-web-targets.json', '{"schema_version":1,"targets":[{"id":"private-target"}]}')
        self.put('config/web-user-authorization.json', '{"version":1,"enabled":true,"text":"Private blanket approval"}')
        self.pilots = {
            'schema_version': 2, 'source_baseline': 'e' * 40, 'rollout_document': 'docs/private.md',
            'pilots': [{'id': 'private', 'root': 'D:/Private/Project', 'project_id': 'agent:private:project',
                        'handover': {'entry': 'private.json', 'required': True, 'completed': False},
                        'resources': [{'scope': 'Private execution phase'}],
                        'sources': [{'path': 'private.json', 'sha256': 'd' * 64}]}]}
        self.put('config/pilots.json', exporter.json_bytes(self.pilots))
        # These bytes deliberately contain exact fixture identities. They must not change.
        self.protected_files = [
            'vendor/native-runtime/source-git-example.zip', 'vendor/native-runtime/patches/example.patch',
            'vendor/native-runtime/manifest.json', 'apps/bridge/upstream/file.ts',
            'apps/bridge/vendor-overlays/manifest.json', 'apps/bridge/vendor-overlays/clw.patch',
            'apps/web-host/vendor/library/manifest.json']
        for name in self.protected_files:
            self.put(name, b'\x00private_request_12345678\r\nprivate-runtime\xff')
        self.git('add', '--all')
        self.git('commit', '-qm', 'Isolated fixture')
        self.commit = self.git('rev-parse', 'HEAD').decode().strip()

    def put(self, name, content):
        target = self.repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content.encode('utf-8') if isinstance(content, str) else content)

    def git(self, *args, input=None):
        return subprocess.run(['git', '-C', str(self.repo), *args], input=input,
                              capture_output=True, check=True,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout

    def export(self):
        return exporter.export_source(self.repo, self.commit, self.out)

    def test_export_reads_commit_without_touching_worktree_index_or_ignored_files(self):
        self.put('README.md', 'Uncommitted working content\n')
        self.git('add', 'README.md')
        self.put('README.md', 'Later unstaged content\n')
        self.put('secret.ignored', 'Ignored credential sentinel\n')
        self.put('untracked.txt', 'Untracked private sentinel\n')
        before = self.git('status', '--porcelain=v1', '--untracked-files=all')
        index_before = self.git('write-tree')
        manifest = self.export()
        self.assertEqual((self.out / 'README.md').read_text(), 'Committed readme\n')
        self.assertFalse((self.out / 'secret.ignored').exists())
        self.assertFalse((self.out / 'untracked.txt').exists())
        self.assertEqual(before, self.git('status', '--porcelain=v1', '--untracked-files=all'))
        self.assertEqual(index_before, self.git('write-tree'))
        self.assertEqual(manifest['source_commit'], self.commit)
        self.assertEqual((self.repo / 'config/harness-web-targets.json').read_text(),
                         '{"schema_version":1,"targets":[{"id":"private-target"}]}')

    def test_scope_projection_configuration_and_manifest_hashes(self):
        manifest = self.export()
        for name in ['evidence/private.json', 'checkpoints/DEV.md', 'PLAN.json',
                     'legacy-reference/README.md', 'docs/handoffs/private.md', 'docs/parallel/private.md',
                     'docs/harness/history/private.md', 'docs/harness/MATH_CONTEXT_HANDOFF.md',
                     'docs/requirements/private.md', 'docs/UNREVIEWED.md']:
            self.assertNotIn(name, manifest['files'])
        for name in ['apps/example/source.js', 'scripts/example.py', 'tests/example.py',
                     'ops/bootstrap-source/START.cmd', 'packaging/setup.iss', 'START.cmd',
                     'package-lock.json', 'docs/SOURCE.md', 'docs/ARCHITECTURE_REVIEW.md']:
            self.assertIn(name, manifest['files'])
        for target, source in exporter.RECEIVERS.items():
            self.assertEqual((self.out / target).read_bytes(), (self.repo / source).read_bytes())
            self.assertEqual(manifest['files'][target]['source_path'], source)
        self.assertEqual(json.loads((self.out / 'config/harness-web-targets.json').read_bytes())['targets'], [])
        policy = json.loads((self.out / 'config/web-user-authorization.json').read_bytes())
        for key in ['enabled', 'auto_approve_tools', 'auto_approve_returned_files', 'recover_ended_turns']:
            self.assertIs(policy[key], False)
        self.assertNotIn('Personal developer', (self.out / 'AGENTS.md').read_text())
        self.assertIn('docs/SOURCE.md', (self.out / 'AGENTS.md').read_text())
        self.assertEqual((self.out / 'CURRENT.md').read_bytes(), exporter.PUBLIC_CURRENT)
        self.assertIsNone(manifest['files']['CURRENT.md']['source_path'])
        self.assertIsNone(manifest['files']['CURRENT.md']['source_sha256'])
        self.assertEqual(manifest, json.loads((self.out / 'SOURCE_EXPORT.json').read_bytes()))
        for name, info in manifest['files'].items():
            self.assertEqual(info['sha256'], exporter.digest((self.out / name).read_bytes()), name)
        self.assertIn('original_requirements', manifest['excluded_categories'])

    def test_vendor_source_archives_patches_and_manifests_are_byte_exact(self):
        manifest = self.export()
        for name in self.protected_files:
            self.assertEqual((self.out / name).read_bytes(), (self.repo / name).read_bytes(), name)
            self.assertEqual(manifest['files'][name]['transformations'], [])

    def test_synthetic_fixture_references_and_generator_are_consistent(self):
        self.export()
        sample = json.loads((self.out / exporter.OBSERVED).read_bytes())
        self.assertEqual(sample['schema_version'], self.sample['schema_version'])
        self.assertEqual(sample['source']['kind'], 'demo')
        self.assertFalse(sample['source']['live'])
        self.assertTrue(sample['projects'][0]['path'].startswith('C:/CLW-Examples/'))
        self.assertEqual(sample['sessions'][0]['project_id'], sample['projects'][0]['id'])
        self.assertEqual(sample['sessions'][0]['id'], sample['sessions'][0]['events'][0]['session_id'])
        logical = sample['sessions'][0]['events'][0]['logical_id']
        self.assertIn(logical, (self.out / 'tests/control-center.test.mjs').read_text())
        before = (self.out / exporter.OBSERVED).read_bytes()
        subprocess.run([sys.executable, '-B', str(self.out / exporter.OBSERVATION_BUILDER)],
                       check=True, capture_output=True,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(before, (self.out / exporter.OBSERVED).read_bytes())
        values = exporter.literal_assignments((self.out / exporter.LEGACY_SOURCE).read_text())
        self.assertEqual(values['LEGACY_INCIDENT'], 'example-send-preparation')
        self.assertEqual(values['LEGACY']['account'], 'A')
        reference = (self.out / 'apps/example/legacy-test.cjs').read_text()
        self.assertIn(values['LEGACY']['request_id'], reference)
        self.assertNotIn('private_request_12345678', reference)
        self.assertNotIn('private_store', (self.out / exporter.LEGACY_SOURCE).read_text())
        self.assertEqual(len(values['LEGACY']['user_sha256']), 64)
        pilot = json.loads((self.out / 'config/pilots.json').read_bytes())
        self.assertEqual(pilot['schema_version'], self.pilots['schema_version'])
        self.assertEqual(pilot['source_baseline'], '0' * 40)
        self.assertIn('Synthetic', pilot['source'])
        self.assertNotIn('D:/Private', json.dumps(pilot))

    def test_only_exact_fixture_strings_change_in_owned_source(self):
        untouched_uuid = '12345678-1234-4123-8123-123456789abc'
        self.put('scripts/other.py', f"VALUE = '{untouched_uuid}'\nDEFAULT = 'D:/Dev/Example'\n")
        self.git('add', 'scripts/other.py')
        self.git('commit', '-qm', 'Unrelated identifier')
        self.commit = self.git('rev-parse', 'HEAD').decode().strip()
        self.export()
        self.assertEqual((self.out / 'scripts/other.py').read_bytes(), (self.repo / 'scripts/other.py').read_bytes())

    def test_rejects_nonempty_relative_inside_and_invalid_ref_before_writing(self):
        self.out.mkdir()
        (self.out / 'keep.txt').write_text('Existing public repository must be preserved')
        with self.assertRaises(exporter.ExportError):
            self.export()
        self.assertEqual([p.name for p in self.out.iterdir()], ['keep.txt'])
        for target in [Path('relative-output'), self.repo / 'inside']:
            with self.assertRaises(exporter.ExportError):
                exporter.export_source(self.repo, self.commit, target)
        missing = self.base / 'missing-ref-output'
        with self.assertRaises(exporter.ExportError):
            exporter.export_source(self.repo, 'no-such-ref', missing)
        self.assertFalse(missing.exists())

    def test_missing_receiver_projection_refuses_before_output_creation(self):
        missing = next(iter(exporter.RECEIVERS.values()))
        self.git('rm', missing)
        self.git('commit', '-qm', 'Missing public projection')
        self.commit = self.git('rev-parse', 'HEAD').decode().strip()
        with self.assertRaisesRegex(exporter.ExportError, 'Missing reviewed public receiver'):
            self.export()
        self.assertFalse(self.out.exists())

    def test_selected_symlink_is_refused(self):
        oid = self.git('hash-object', '-w', '--stdin', input=b'../../private').decode().strip()
        self.git('update-index', '--add', '--cacheinfo', f'120000,{oid},apps/unsafe-link')
        self.git('commit', '-qm', 'Synthetic symlink entry')
        self.commit = self.git('rev-parse', 'HEAD').decode().strip()
        with self.assertRaisesRegex(exporter.ExportError, 'symlink'):
            self.export()
        self.assertFalse(self.out.exists())

    def test_real_pilot_schema_survives_synthetic_projection(self):
        # Reads the existing tracked fixture only; validation does not query its projects.
        raw = json.loads((ROOT / 'config/pilots.json').read_bytes())
        spec = importlib.util.spec_from_file_location('export_pilot_validator', ROOT / 'scripts/validate_pilot_plan.py')
        validator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(validator)
        before = deepcopy(raw)
        result = validator.validate_plan(exporter.synthetic_pilots(raw))
        self.assertEqual(result['pilot_count'], 2)
        self.assertTrue(result['plan_consistent'])
        self.assertFalse(result['dispatch_performed'])
        self.assertEqual(raw, before)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is unavailable')
    def test_real_observation_and_navigation_tests_survive_projection(self):
        # Execute the existing pure Node tests against only the projected fixture
        # and its view-model, in an isolated directory without an application host.
        sample, mapping = exporter.observation_fixture(json.loads((ROOT / exporter.OBSERVED).read_bytes()))
        isolated = self.base / 'observation-tests'
        files = {
            exporter.OBSERVED: exporter.json_bytes(sample),
            'apps/control-center/model.mjs': exporter.apply_known_strings(
                (ROOT / 'apps/control-center/model.mjs').read_text(encoding='utf-8-sig'), mapping).encode(),
            'apps/control-center/annotations.mjs': (ROOT / 'apps/control-center/annotations.mjs').read_bytes(),
            'tests/control-center.test.mjs': exporter.apply_known_strings(
                (ROOT / 'tests/control-center.test.mjs').read_text(encoding='utf-8-sig'), mapping).encode(),
        }
        for name, data in files.items():
            target = isolated / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        result = subprocess.run([shutil.which('node'), '--test', str(isolated / 'tests/control-center.test.mjs')],
                                capture_output=True, text=True, encoding='utf-8',
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
