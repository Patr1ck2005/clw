import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import preview_installation as installation
import preview_connections as connections
import preview_connection_watch as watch
from product_runtime import atomic_json


class PreviewFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='clw-preview-unit-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manifest = installation.defaults(self.root)
        self.manifest['auto_connect'] = False
        self.manifest['projectRoots'] = [str(self.root)]
        (self.root / '.local').mkdir()
        (self.root / '.local/web-host').mkdir()
        atomic_json(self.root / '.local/preview-installation.json', self.manifest)

    def owner(self, role, pid=100):
        executable = self.manifest['binaries'][role if role in ('server', 'runner') else 'tunnel']
        return {'pid': pid, 'creation_filetime': '123456789', 'executable': executable}

    def row(self, role, pid=100, **extra):
        owner = self.owner(role, pid)
        command = subprocess.list2cmdline([owner['executable']])
        if role == 'runner':
            command = subprocess.list2cmdline([owner['executable'], '--config', str(self.root / 'runner.toml')])
        if role in ('A', 'B'):
            command = subprocess.list2cmdline([owner['executable'], 'run', '--profile-file',
                                              str(installation.private_home(self.root) / ('account-' + role + '.yaml'))])
        return {'ProcessId': pid, 'CreationFiletime': owner['creation_filetime'],
                'ExecutablePath': owner['executable'], 'CommandLine': command, **extra}


class ManifestTests(PreviewFixture):
    def test_read_defaults_does_not_create_manifest(self):
        other = self.root / 'new'
        value = installation.read(other)
        self.assertFalse(value['configured'])
        self.assertEqual(value['manifest']['accounts'], [{'id': 'A'}])
        self.assertTrue(value['manifest']['auto_connect'])
        self.assertFalse((other / '.local').exists())

    def test_manifest_rejects_secrets_unknown_accounts_and_proxy_credentials(self):
        for changed in ({'api_key': 'never-public'}, {'accounts': [{'id': 'C'}]}, {'accounts': [{'id': 'A'}, {'id': 'A'}]},
                        {'network': {'mode': 'proxy', 'proxy_url': 'http://user:secret@localhost:1234'}},
                        {'auto_connect': 1}, {'backend': {'mode': 'owned', 'origin': 'http://localhost:1234'}}):
            with self.subTest(changed=list(changed)):
                with self.assertRaises(installation.PreviewError):
                    installation.validate({**self.manifest, **changed})

    def test_either_account_can_be_first_without_adding_another_slot(self):
        for accounts in ([{'id': 'B'}], [{'id': 'B'}, {'id': 'A'}], [{'id': 'A'}, {'id': 'B'}]):
            with self.subTest(accounts=accounts):
                self.assertEqual(installation.validate({**self.manifest, 'accounts': accounts})['accounts'], accounts)

    def test_credentials_are_dpapi_not_plaintext_and_read_never_returns_them(self):
        if os.name != 'nt':
            self.skipTest('Windows DPAPI contract')
        key = 'preview-unit-secret-' + 'z' * 32
        value = installation.save(self.root, {'manifest': self.manifest, 'credentials': {
            'A': {'tunnel_id': 'tunnel_' + 'a' * 32, 'api_key': key}}})
        self.assertNotIn(key, json.dumps(value))
        self.assertNotIn(key.encode(), installation.credential_path(self.root, 'A').read_bytes())
        self.assertNotIn(key, (self.root / '.local/preview-installation.json').read_text())
        self.assertEqual(installation.read_credential(self.root, 'A')['api_key'], key)
        self.assertTrue(value['accounts'][0]['has_key'])

    def test_invalid_credentials_do_not_write_manifest(self):
        original = (self.root / '.local/preview-installation.json').read_bytes()
        with self.assertRaises(installation.PreviewError):
            installation.save(self.root, {'manifest': self.manifest, 'credentials': {
                'A': {'tunnel_id': 'invalid', 'api_key': 'x' * 32}}})
        self.assertEqual(original, (self.root / '.local/preview-installation.json').read_bytes())

    def test_same_tunnel_cannot_be_started_as_both_accounts(self):
        if os.name != 'nt':
            self.skipTest('Windows DPAPI contract')
        changed = copy.deepcopy(self.manifest)
        changed['accounts'].append({'id': 'B'})
        credential = {'tunnel_id': 'tunnel_' + 'a' * 32, 'api_key': 'preview-key-' + 'q' * 32}
        with self.assertRaisesRegex(installation.PreviewError, 'preview_duplicate_account_tunnel'):
            installation.save(self.root, {'manifest': changed, 'credentials': {'A': credential, 'B': credential}})
        self.assertFalse(installation.credential_path(self.root, 'A').exists())

    def test_direct_proxy_and_system_environments_are_distinct_and_remove_inherited_authority(self):
        inherited = {'HTTP_PROXY': 'http://existing:1234', 'OPENAI_API_KEY': 'private',
                     'CONTROL_PLANE_API_KEY': 'private', 'WEBCODEX_TOKEN': 'private', 'PATH': 'unchanged'}
        with patch.dict(os.environ, inherited, clear=True):
            self.manifest['network'] = {'mode': 'system'}
            self.assertEqual(installation.environment(self.manifest)['HTTP_PROXY'], inherited['HTTP_PROXY'])
            self.manifest['network'] = {'mode': 'direct'}
            direct = installation.environment(self.manifest)
            self.assertNotIn('HTTP_PROXY', direct)
            for name in ('OPENAI_API_KEY', 'CONTROL_PLANE_API_KEY', 'WEBCODEX_TOKEN'):
                self.assertNotIn(name, direct)
            self.manifest['network'] = {'mode': 'proxy', 'proxy_url': 'http://127.0.0.1:3128'}
            self.assertEqual(installation.environment(self.manifest)['HTTP_PROXY'], 'http://127.0.0.1:3128')
            self.assertNotIn('17890', json.dumps(installation.environment(self.manifest)))

    def test_native_children_prefer_the_manifest_private_runtimes_without_changing_host_path(self):
        inherited = {'Path': 'host-tools', 'PYTHONHOME': 'host-python', 'PYTHONPATH': 'host-modules',
                     'PYTHONUSERBASE': 'host-site', 'PYTHONSTARTUP': 'host-startup'}
        with patch.dict(os.environ, inherited, clear=True):
            original = dict(os.environ)
            selected = installation.environment(self.manifest)
            self.assertEqual(dict(os.environ), original)
        runtime = self.root / 'runtime'
        self.assertEqual(selected['PATH'].split(os.pathsep),
                         [str(runtime / 'python'), str(runtime / 'powershell'), str(runtime / 'native'), 'host-tools'])
        self.assertNotIn('Path', selected)
        self.assertEqual(selected['PYTHONNOUSERSITE'], '1')
        self.assertTrue(all(name not in selected for name in inherited if name.startswith('PYTHON')))

    def test_selected_code_does_not_replace_the_manifest_retained_runtime(self):
        retained = self.root / 'retained version/runtime/native'
        manifest = {**self.manifest, 'binaries': {key: str(retained / name)
                                               for key, name in installation.BINARY_NAMES.items()}}
        self.assertEqual(installation.private_runtimes(manifest)['powershell'],
                         self.root / 'retained version/runtime/powershell/pwsh.exe')

    def test_private_children_disable_telemetry_without_changing_inherited_user_environment(self):
        for inherited in ({}, {'POWERSHELL_TELEMETRY_OPTOUT': '0', 'DO_NOT_TRACK': '0'}):
            for mode in ('system', 'direct', 'proxy'):
                with self.subTest(inherited=inherited, mode=mode), patch.dict(os.environ, inherited, clear=True):
                    original = dict(os.environ)
                    self.manifest['network'] = ({'mode': 'proxy', 'proxy_url': 'http://127.0.0.1:3128'}
                                                if mode == 'proxy' else {'mode': mode})
                    selected = installation.environment(self.manifest)
                    self.assertEqual(selected['POWERSHELL_TELEMETRY_OPTOUT'], '1')
                    self.assertEqual(selected['DO_NOT_TRACK'], '1')
                    self.assertEqual(dict(os.environ), original)


class PrivateRunnerShellTests(PreviewFixture):
    def test_native_config_keeps_identity_and_policy_and_binds_private_shell_with_unicode_paths(self):
        config = self.root / '.local' / 'runner 空间.toml'
        original = 'client_id = "original-device"\n[policy]\nallowed_roots = ["test"]\n'
        config.write_text(original, encoding='utf8')
        installation.configure_runner_shell(self.root, self.manifest, config)
        saved = config.read_bytes()
        values = tomllib.loads(saved.decode('utf8'))
        self.assertEqual(values['client_id'], 'original-device')
        self.assertEqual(values['policy'], {'allowed_roots': ['test']})
        self.assertEqual(values['shell']['program'], str(self.root / 'runtime/powershell/pwsh.exe'))
        self.assertEqual(values['shell']['dialect'], 'powershell')
        self.assertEqual(values['shell']['path_prepend'][0], str(self.root / 'runtime/python'))
        installation.configure_runner_shell(self.root, self.manifest, config)
        self.assertEqual(config.read_bytes(), saved)
        changed = {**self.manifest, 'binaries': {key: str(self.root / 'new version 空间/runtime/native' / name)
                                               for key, name in installation.BINARY_NAMES.items()}}
        installation.configure_runner_shell(self.root, changed, config)
        values = tomllib.loads(config.read_text(encoding='utf8'))
        self.assertEqual(values['shell']['program'], str(self.root / 'new version 空间/runtime/powershell/pwsh.exe'))
        self.assertEqual(config.read_text(encoding='utf8').count('[shell]'), 1)
        self.assertEqual(values['policy'], {'allowed_roots': ['test']})

    def test_foreign_shell_configuration_is_retained_and_reported(self):
        config = self.root / '.local/runner.toml'
        original = '[shell]\nprogram = "custom-shell.exe"\n'
        config.write_text(original, encoding='utf8')
        with self.assertRaisesRegex(installation.PreviewError, 'preview_runner_configuration_invalid'):
            installation.configure_runner_shell(self.root, self.manifest, config)
        self.assertEqual(config.read_text(encoding='utf8'), original)

    def test_directory_rebuild_reapplies_private_shell_after_native_overwrite(self):
        home = installation.private_home(self.root)
        connection = home / 'connections/server/preview'
        connection.mkdir(parents=True)
        config_path = connection / 'runner.toml'
        config_path.write_text('client_id = "preview-test"\n')
        (connection / 'webcodex-user-token').write_text('test-private-user-token')
        atomic_json(home / 'bootstrap.json', {'installation_id': self.manifest['installation_id'],
                                             'applied_projectRoots': [], 'client_id': 'preview-test'})
        def native(_root, _manifest, args, **options):
            if args[:2] == ['runner', 'init']:
                config_path.write_text('client_id = "preview-test"\n')
            return {}
        with patch.object(connections, 'observed_owners', return_value={}), \
             patch.object(connections.backend, '_runner_values', return_value={
                 'token': 'wc_agent_fixture', 'project_registry_dir': str(connection / 'project-registry')}), \
             patch.object(installation, 'native', side_effect=native):
            connections._apply_projects(self.root, self.manifest, {
                'runner_config': str(config_path), 'origin': self.manifest['backend']['origin']})
        self.assertEqual(tomllib.loads(config_path.read_text())['shell']['program'],
                         str(self.root / 'runtime/powershell/pwsh.exe'))


class OwnershipTests(PreviewFixture):
    def test_unverified_same_executable_is_never_adopted(self):
        with self.assertRaisesRegex(installation.PreviewError, 'preview_process_owner_unverified'):
            connections.observed_owners(self.root, self.manifest, observe=lambda _: [self.row('server')])

    def test_creation_mismatch_is_never_accepted(self):
        atomic_json(connections._owner_file(self.root), {'installation_id': self.manifest['installation_id'],
                    'owners': {'server': self.owner('server')}})
        with self.assertRaisesRegex(installation.PreviewError, 'preview_process_owner_unverified'):
            connections.observed_owners(self.root, self.manifest,
                observe=lambda _: [self.row('server', CreationFiletime='98765')])

    def test_verified_a_without_b_is_owned_and_other_profiles_ignored(self):
        atomic_json(connections._owner_file(self.root), {'installation_id': self.manifest['installation_id'],
                    'owners': {'A': self.owner('A')}})
        rows = [self.row('A'), self.row('B', pid=200, CommandLine=subprocess.list2cmdline([
            self.manifest['binaries']['tunnel'], 'run', '--profile-file', str(self.root / 'unrelated-profile.yaml')]))]
        result = connections.observed_owners(self.root, self.manifest, observe=lambda _: rows)
        self.assertEqual(set(result), {'A'})

    def test_reused_pid_of_another_executable_proves_original_absent_without_stopping_it(self):
        atomic_json(connections._owner_file(self.root), {'installation_id': self.manifest['installation_id'],
                    'owners': {'A': self.owner('A')}})
        self.assertEqual(connections.observed_owners(self.root, self.manifest,
            observe=lambda _: [{'ProcessId': 100, 'ProcessName': 'unrelated.exe'}]), {})

    def test_unknown_launch_is_not_replayed(self):
        atomic_json(self.root / '.local/preview-launch.json', {'completion_unknown': True})
        with patch.object(connections.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(installation.PreviewError, 'completion_unknown'):
                connections._launch(self.root, self.manifest, 'server', ['unused'])
            spawn.assert_not_called()

    def test_check_works_without_b_and_does_not_start_services(self):
        with patch.object(connections, 'observed_owners', return_value={}), \
             patch.object(connections.subprocess, 'Popen') as spawn:
            result = connections.check(self.root)
            self.assertEqual(result['state'], 'awaiting_credentials')
            self.assertEqual(result['accounts'], [{'id': 'A', 'state': 'credentials_required',
                                                  'credentialConfigured': False, 'has_key': False}])
            spawn.assert_not_called()


class WatchTests(PreviewFixture):
    def setUp(self):
        super().setUp()
        self.manifest['auto_connect'] = True
        atomic_json(self.root / '.local/preview-installation.json', self.manifest)

    def test_live_unready_owner_is_retained(self):
        recover = Mock()
        inspect = Mock(return_value={'healthy': False, 'components': {'server': 'ready', 'runner': 'connection_wait'},
                                     'accounts': [{'id': 'A', 'state': 'ready', 'has_key': True}]})
        result = watch.PreviewWatch(self.root, inspect=inspect, recover=recover).tick()
        self.assertEqual(result['reason'], 'live_owner_or_credentials_wait')
        recover.assert_not_called()

    def test_absence_recovery_has_bounded_backoff(self):
        now = [0]
        recover = Mock(return_value={'state': 'needs_attention', 'healthy': False})
        inspect = lambda _: {'healthy': False, 'components': {'server': 'absent'},
                             'accounts': [{'id': 'A', 'state': 'absent', 'has_key': True}]}
        watcher = watch.PreviewWatch(self.root, inspect=inspect, recover=recover, now=lambda: now[0])
        watcher.tick()
        self.assertEqual(watcher.tick()['state'], 'recovery_backoff')
        for moment in (10, 30, 100):
            now[0] = moment
            result = watcher.tick()
        self.assertEqual(result['reason'], 'recovery_retry_limit')
        self.assertEqual(recover.call_count, 3)

    def test_unknown_recovery_is_not_repeated(self):
        recover = Mock(side_effect=installation.PreviewError('preview_native_completion_unknown'))
        inspect = lambda _: {'healthy': False, 'components': {'server': 'absent'},
                             'accounts': [{'id': 'A', 'state': 'absent', 'has_key': True}]}
        watcher = watch.PreviewWatch(self.root, inspect=inspect, recover=recover)
        watcher.tick()
        self.assertEqual(watcher.tick()['reason'], 'original_preview_connect_completion_unknown')
        recover.assert_called_once()

    def test_unavailable_explicit_proxy_does_not_spend_recovery_budget(self):
        recover = Mock()
        watcher = watch.PreviewWatch(self.root, recover=recover, network_ready=lambda _: False)
        for _ in range(5):
            self.assertEqual(watcher.tick()['state'], 'waiting_proxy')
        self.assertEqual(watcher.attempts, 0)
        recover.assert_not_called()

    def test_watch_reads_the_latest_manifest_without_restarting_live_owners(self):
        modes = []
        recover = Mock()
        watcher = watch.PreviewWatch(self.root, inspect=lambda _: {'healthy': True, 'state': 'ready'},
            recover=recover, network_ready=lambda manifest: modes.append(manifest['network']['mode']) or True)
        watcher.tick()
        self.manifest['network'] = {'mode': 'proxy', 'proxy_url': 'http://127.0.0.1:3128'}
        atomic_json(self.root / '.local/preview-installation.json', self.manifest)
        watcher.tick()
        self.assertEqual(modes, ['system', 'proxy'])
        recover.assert_not_called()

    def test_unconfigured_slots_never_block_another_account_or_backend_recovery(self):
        for configured, missing in (('A', 'B'), ('B', 'A')):
            for component in ('server', 'account'):
                with self.subTest(configured=configured, missing=missing, component=component):
                    recover = Mock(return_value={'healthy': False, 'state': 'needs_attention'})
                    inspect = lambda _: {'healthy': False, 'components': {
                        'server': 'absent' if component == 'server' else 'ready'}, 'accounts': [
                        {'id': configured, 'has_key': True, 'state': 'absent'},
                        {'id': missing, 'has_key': False, 'state': 'credentials_required'}]}
                    watch.PreviewWatch(self.root, inspect=inspect, recover=recover).tick()
                    recover.assert_called_once()

    def test_only_credential_configured_accounts_participate_in_readiness(self):
        self.manifest['accounts'].append({'id': 'B'})
        for configured in ('A', 'B'):
            with self.subTest(configured=configured):
                for account in ('A', 'B'):
                    path = installation.credential_path(self.root, account)
                    path.parent.mkdir(exist_ok=True)
                    if account == configured:
                        path.write_bytes(b'only-presence-needed')
                    elif path.exists():
                        path.unlink()
                owners = {configured: self.owner(configured), 'server': self.owner('server', 200),
                          'runner': self.owner('runner', 300)}
                with patch.object(connections, 'observed_owners', return_value=owners), \
                     patch.object(connections, '_backend_config', return_value={'origin': self.manifest['backend']['origin']}), \
                     patch.object(connections, '_listener', return_value=True), \
                     patch.object(connections.backend, 'mcp_ready', return_value=True), \
                     patch.object(connections.backend, 'runner_ready', return_value=True), \
                     patch.object(connections, 'read_json', return_value={'client_id': 'fixture'}), \
                     patch.object(connections, '_account_health', side_effect=lambda root, manifest, account, owner: account == configured), \
                     patch.object(connections, 'pending_changes', return_value=[]), \
                     patch.object(connections, 'operation_state', return_value={'operation_reconciled': False, 'bootstrap_complete': False}):
                    result = connections.check(self.root, manifest=self.manifest)
                self.assertTrue(result['healthy'])
                self.assertEqual(result['state'], 'ready')

    def test_no_credentials_never_claim_ready_or_try_automatic_connect(self):
        recover = Mock()
        inspect = lambda _: {'healthy': False, 'state': 'awaiting_credentials', 'components': {'server': 'absent'},
                             'accounts': [{'id': 'A', 'has_key': False, 'state': 'credentials_required'}]}
        result = watch.PreviewWatch(self.root, inspect=inspect, recover=recover).tick()
        self.assertEqual(result['state'], 'awaiting_credentials')
        recover.assert_not_called()

    def test_startup_registration_is_install_specific_and_disabled_without_credentials(self):
        with patch.dict(os.environ, {'APPDATA': str(self.root)}):
            result = watch.configure_startup(self.root, self.manifest)
        self.assertFalse(result['enabled'])
        self.assertFalse((installation.private_home(self.root) / 'startup.json').exists())
        content = watch.startup_contents(self.root)
        self.assertIn('preview_connection_watch.py', content)
        self.assertIn(', 0, False', content)
        self.assertNotIn('AB.lnk', content)

    def test_startup_only_replaces_a_file_with_matching_installation_receipt(self):
        if os.name != 'nt':
            self.skipTest('Windows startup contract')
        startup = self.root / 'Microsoft/Windows/Start Menu/Programs/Startup'
        startup.mkdir(parents=True)
        home = installation.private_home(self.root)
        home.mkdir()
        installation.credential_path(self.root, 'A').write_bytes(b'only-presence-is-needed')
        with patch.dict(os.environ, {'APPDATA': str(self.root)}):
            result = watch.configure_startup(self.root, self.manifest)
            self.assertTrue(result['enabled'])
            path = startup / ('CLW-Preview-' + self.manifest['installation_id'] + '.vbs')
            original = path.read_bytes()
            self.manifest['auto_connect'] = False
            self.assertFalse(watch.configure_startup(self.root, self.manifest)['enabled'])
            self.assertNotEqual(original, path.read_bytes())
            path.write_text('different owner content')
            with self.assertRaisesRegex(installation.PreviewError, 'preview_startup_owner_changed'):
                watch.configure_startup(self.root, self.manifest)
            self.assertEqual(path.read_text(), 'different owner content')

    def test_b_only_credentials_can_enable_automatic_connection(self):
        if os.name != 'nt':
            self.skipTest('Windows startup contract')
        self.manifest['accounts'].append({'id': 'B'})
        home = installation.private_home(self.root)
        home.mkdir()
        installation.credential_path(self.root, 'B').write_bytes(b'presence-only')
        startup = self.root / 'Microsoft/Windows/Start Menu/Programs/Startup'
        startup.mkdir(parents=True)
        with patch.dict(os.environ, {'APPDATA': str(self.root)}):
            self.assertTrue(watch.configure_startup(self.root, self.manifest)['enabled'])
        self.assertFalse(installation.credential_path(self.root, 'A').exists())

    def test_upgrade_reuses_exact_old_watch_for_the_same_canonical_data_home(self):
        home = installation.private_home(self.root)
        home.mkdir()
        installation.credential_path(self.root, 'A').write_bytes(b'presence-only')
        folder = self.root / '.local/preview-watch'
        folder.mkdir()
        old_root = self.root / 'old-version'
        old_script = old_root / 'scripts/preview_connection_watch.py'
        owner = {'pid': 404, 'creation_filetime': '1234567', 'executable': str(self.root / 'old-python/python.exe'),
                 'installation_id': self.manifest['installation_id'], 'root': str(old_root),
                 'data_home': str(self.root / '.local'), 'script': str(old_script)}
        atomic_json(folder / 'owner.json', owner)
        row = {'ProcessId': owner['pid'], 'CreationFiletime': owner['creation_filetime'],
               'ExecutablePath': owner['executable'], 'CommandLine': subprocess.list2cmdline([
                   owner['executable'], '-B', str(old_script), '--root', str(old_root)])}
        def inventory(**options):
            self.assertTrue(options['candidate_filter'](row))
            return [row]
        data_home = self.root / '.local'
        with patch.object(watch, 'process_inventory', side_effect=inventory), \
             patch.object(installation, 'local', return_value=data_home), \
             patch.object(watch.subprocess, 'Popen') as spawn:
            self.assertEqual(watch.ensure_started(self.root, self.manifest), {'state': 'running', 'pid': owner['pid']})
            spawn.assert_not_called()

    def test_tunnel_profile_contains_only_key_reference_and_explicit_proxy(self):
        home = installation.private_home(self.root)
        home.mkdir()
        credential = {'tunnel_id': 'tunnel_' + 'a' * 32, 'api_key': 'secret-must-stay-in-environment'}
        self.manifest['network'] = {'mode': 'proxy', 'proxy_url': 'http://127.0.0.1:3128'}
        with patch.object(installation, 'read_credential', return_value=credential), \
             patch.object(connections.backend, '_mcp_server_token', return_value='local-native-token'):
            args, environment = connections._tunnel_profile(self.root, self.manifest, 'A', {})
        profile = (home / 'account-A.yaml').read_text()
        self.assertNotIn(credential['api_key'], profile)
        self.assertIn('env:CLW_PREVIEW_TUNNEL_KEY', profile)
        self.assertEqual(environment['CLW_PREVIEW_TUNNEL_KEY'], credential['api_key'])
        self.assertIn('http://127.0.0.1:3128', args)
        self.assertNotIn('17890', json.dumps(args))


class CliTests(PreviewFixture):
    def test_json_stdin_and_safe_unknown_error(self):
        script = Path(connections.__file__)
        result = subprocess.run([sys.executable, '-B', str(script), '--root', str(self.root), '--action', 'read'],
                                input='{}', capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(json.loads(result.stdout)['ok'])
        secret = 'untrusted-private-key-never-echo'
        failed = subprocess.run([sys.executable, '-B', str(script), '--root', str(self.root), 'save'],
                                input='{"secret":"' + secret + '"}', capture_output=True, text=True, timeout=15)
        self.assertEqual(json.loads(failed.stdout), {'ok': False, 'code': 'preview_save_invalid'})
        self.assertNotIn(secret, failed.stdout + failed.stderr)


class ReconfigurationTests(PreviewFixture):
    def test_pending_detached_settings_do_not_promise_an_app_reopen_reload(self):
        value = connections.settings_application(['network_applies_after_owned_process_restart',
                                                  'project_root_removal_requires_safe_reload'])
        self.assertEqual(value, {'state': 'pending', 'reason': 'existing_detached_native_owners_retained',
                                 'network': 'next_windows_boot', 'projectRoots': 'offline_native_policy_reload_required'})
        self.assertEqual(connections.settings_application([]), {'state': 'applied'})

    def test_reconciliation_requires_completed_original_enrollment_not_only_a_healthy_runner(self):
        home = installation.private_home(self.root)
        home.mkdir()
        (home / 'server.env').write_text('fixture')
        (home / 'runner-initial.toml').write_text('fixture')
        atomic_json(self.root / '.local/web-host/backend-launch.json', {'runner_config': 'fixture'})
        marker = {'installation_id': self.manifest['installation_id'], 'client_id': 'preview-test', 'enrolled': True}
        atomic_json(home / 'bootstrap.json', marker)
        atomic_json(self.root / '.local/preview-launch.json', {'installation_id': self.manifest['installation_id'],
                    'state': 'started', 'completion_unknown': False})
        pending = {'installation_id': self.manifest['installation_id'], 'client_id': 'preview-test',
                   'state': 'accepted_login_pending'}
        atomic_json(home / 'enrollment-attempt.json', pending)
        self.assertEqual(connections.operation_state(self.root, self.manifest, True),
                         {'operation_reconciled': False, 'bootstrap_complete': True})
        atomic_json(home / 'enrollment-attempt.json', {**pending, 'state': 'completed'})
        with patch.object(connections, '_backend_config', return_value={'runner_config': 'fixture'}), \
             patch.object(connections.backend, '_runner_values', return_value={'client_id': 'preview-test'}):
            self.assertTrue(connections.operation_state(self.root, self.manifest, True)['operation_reconciled'])
            atomic_json(self.root / '.local/preview-launch.json', {'installation_id': self.manifest['installation_id'],
                        'state': 'launching', 'completion_unknown': True})
            self.assertFalse(connections.operation_state(self.root, self.manifest, True)['operation_reconciled'])

    def test_bootstrapped_installation_can_add_b_and_project_roots(self):
        home = installation.private_home(self.root)
        home.mkdir()
        atomic_json(home / 'bootstrap.json', {'installation_id': self.manifest['installation_id'],
                                             'applied_projectRoots': [str(self.root)]})
        project = self.root / 'another-project'
        project.mkdir()
        changed = copy.deepcopy(self.manifest)
        changed['accounts'].append({'id': 'B'})
        changed['projectRoots'].append(str(project))
        changed['network'] = {'mode': 'proxy', 'proxy_url': 'http://127.0.0.1:3128'}
        result = installation.save(self.root, {'manifest': changed})
        self.assertEqual(result['manifest']['accounts'], [{'id': 'A'}, {'id': 'B'}])
        pending = connections.pending_changes(self.root, changed,
                                              {'A': {**self.owner('A'), 'network': {'mode': 'system'}}})
        self.assertEqual(pending, ['project_roots_to_activate', 'network_applies_after_owned_process_restart'])
        with self.assertRaisesRegex(installation.PreviewError, 'preview_backend_identity_locked'):
            installation.save(self.root, {'manifest': {**changed, 'backend': {'mode': 'owned',
                'origin': 'http://127.0.0.1:54321'}}})

    def test_live_runner_addition_uses_native_hot_activation_without_spawning(self):
        home = installation.private_home(self.root)
        home.mkdir()
        connection = home / 'connections/server/preview'
        connection.mkdir(parents=True)
        (connection / 'webcodex-user-token').write_text('test-private-user-token')
        atomic_json(home / 'bootstrap.json', {'installation_id': self.manifest['installation_id'],
                                             'applied_projectRoots': [], 'client_id': 'preview-test'})
        config = {'runner_config': str(connection / 'runner.toml')}
        with patch.object(connections, 'observed_owners', return_value={'runner': self.owner('runner')}), \
             patch.object(installation, 'native', return_value={}) as native, \
             patch.object(connections.subprocess, 'Popen') as spawn:
            connections._apply_projects(self.root, self.manifest, config)
            self.assertEqual(native.call_args.args[2][:2], ['project', 'activate'])
            self.assertIn('--user-token-file', native.call_args.args[2])
            spawn.assert_not_called()
        self.assertEqual(json.loads((home / 'bootstrap.json').read_text())['applied_projectRoots'], [str(self.root)])


class ExportTests(PreviewFixture):
    def test_public_timeline_is_bounded_and_excludes_raw_fields_without_mutation(self):
        folder = self.root / '.local/preview-watch'
        folder.mkdir()
        stamp = datetime(2026, 10, 17, tzinfo=timezone.utc)
        secret = 'private-key-and-chat-never-exported'
        events = [{'at': (stamp + timedelta(seconds=index)).isoformat(), 'state': 'needs_attention',
                   'stage': 'backend', 'reason': 'preview_server_not_ready', 'stdout': secret,
                   'authorization': secret, 'chat': secret, 'path': 'C:/private/config.env',
                   'owners': {'executable': 'C:/private/python.exe'}} for index in range(45)]
        payload = ('\n'.join(json.dumps(event) for event in events) + '\n').encode()
        path = folder / 'events.jsonl'
        path.write_bytes(payload)
        result = connections.public_timeline(self.root)
        self.assertEqual(result['state'], 'available')
        self.assertEqual(len(result['rows']), 40)
        self.assertTrue(result['truncated'])
        self.assertEqual(result['rows'][0]['at'], '2026-10-17T00:00:05Z')
        self.assertNotIn(secret, json.dumps(result))
        self.assertNotIn('C:/private', json.dumps(result))
        self.assertTrue(all(set(row) == {'at', 'state', 'stage', 'reason'} for row in result['rows']))
        self.assertEqual(path.read_bytes(), payload)

    def test_unsuitable_or_missing_log_never_blocks_export(self):
        self.assertEqual(connections.public_timeline(self.root)['state'], 'not_recorded')
        folder = self.root / '.local/preview-watch'
        folder.mkdir()
        (folder / 'events.jsonl').write_bytes(b'not JSON\n{"state":"secret raw chat"}\n')
        with patch.object(connections, 'check', side_effect=installation.PreviewError('preview_process_owner_unverified')):
            result = connections.export_status(self.root)
        self.assertEqual(result['timeline']['state'], 'unavailable')
        self.assertEqual(result['timeline']['rows'], [])
        self.assertEqual(result['status'], {'state': 'needs_attention', 'code': 'preview_process_owner_unverified',
                                            'operation_reconciled': False})
        self.assertNotIn('secret raw chat', json.dumps(result))

    def test_malformed_rows_and_non_code_reason_are_skipped_or_dropped(self):
        folder = self.root / '.local/preview-watch'
        folder.mkdir()
        (folder / 'events.jsonl').write_bytes(b'bad JSON\n' + json.dumps({'time': '2026-10-17T00:00:00Z',
            'state': 'disabled', 'reason': 'Bearer secret-body', 'code': 'preview_observation_unavailable',
            'stage': 'C:/private/path'}).encode() + b'\n')
        result = connections.public_timeline(self.root)
        self.assertEqual(result['state'], 'partial')
        self.assertEqual(result['skipped_records'], 1)
        self.assertEqual(result['rows'], [{'at': '2026-10-17T00:00:00Z', 'state': 'disabled',
                                          'error_code': 'preview_observation_unavailable'}])

    def test_timeline_reads_a_bounded_tail_of_oversized_files(self):
        folder = self.root / '.local/preview-watch'
        folder.mkdir()
        (folder / 'events.jsonl').write_bytes(b'{' * (connections.TIMELINE_TAIL_BYTES + 4096) + b'\n' +
            b'{"at":"2026-10-17T00:00:00Z","state":"ready"}\n')
        result = connections.public_timeline(self.root)
        self.assertEqual(result['rows'], [{'at': '2026-10-17T00:00:00Z', 'state': 'ready'}])
        self.assertTrue(result['truncated'])


if __name__ == '__main__':
    unittest.main()
