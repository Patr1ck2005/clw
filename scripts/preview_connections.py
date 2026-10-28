"""Local IPC/CLI control for an independent free-preview backend and A/B tunnels.

JSON input is consumed from stdin. Output is a fixed safe projection; native
stdout, environment values, authentication headers and runtime keys stay private.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

from bounded_process import run_bounded
from product_runtime import FileLease, atomic_json, read_json, utc
import preview_installation as installation
from preview_installation import PreviewError
from web_host_supervisor_owner import command_argv
from windows_process_owner import process_inventory, tcp_listeners
import webcodex_backend as backend

NAMES = frozenset(('webcodex-server.exe', 'webcodex-runner.exe', 'tunnel-client.exe'))
TIMELINE_LIMIT = 40
TIMELINE_TAIL_BYTES = 128 * 1024
PUBLIC_STATES = frozenset(('ready', 'healthy', 'needs_attention', 'awaiting_credentials', 'disabled',
    'waiting_proxy', 'recovery_backoff', 'recovering', 'bootstrapped', 'not_configured'))
PUBLIC_REASONS = frozenset(('credentials_required', 'live_owner_or_credentials_wait',
    'configured_proxy_unavailable', 'original_preview_connect_completion_unknown',
    'source_changed_restart_watch_after_verification', 'recovery_retry_limit',
    'original_preview_launch_completion_unknown'))


def _norm(value):
    return os.path.abspath(str(value).removeprefix('\\\\?\\')).replace('\\', '/').casefold()


def _owner_file(root):
    return installation.local(root) / 'preview-owners.json'


def _owners(root, manifest):
    path = _owner_file(root)
    if not path.exists():
        return {'installation_id': manifest['installation_id'], 'owners': {}}
    data = read_json(path, maximum=65536)
    if (not isinstance(data, dict) or data.get('installation_id') != manifest['installation_id']
            or not isinstance(data.get('owners'), dict)):
        raise PreviewError('preview_owner_metadata_invalid')
    return data


def _inventory(manifest):
    paths = {_norm(path) for key, path in manifest['binaries'].items() if key != 'cli'}
    for delay in (0, .025, .075):
        if delay:
            time.sleep(delay)
        try:
            return process_inventory(target_names=NAMES,
                candidate_filter=lambda row: _norm(row['ExecutablePath']) in paths)
        except (OSError, ValueError, RuntimeError):
            pass
    raise PreviewError('preview_process_observation_unavailable') from None


def _arguments(row, flag):
    argv = command_argv(row['CommandLine'])
    return [argv[index + 1] for index, value in enumerate(argv[:-1]) if value == flag] + [
        value[len(flag) + 1:] for value in argv if value.startswith(flag + '=')]


def observed_owners(root, manifest, *, observe=None):
    """An exact saved PID/creation/image/argv is required for every live owner."""
    saved = _owners(root, manifest)['owners']
    rows = (observe or _inventory)(manifest)
    result = {}
    selected = {key: [] for key in ('server', 'runner', 'A', 'B')}
    launch_path = installation.local(root) / 'web-host/backend-launch.json'
    launch = read_json(launch_path) if launch_path.exists() else {}
    profiles = {account: installation.private_home(root) / ('account-' + account + '.yaml')
                for account in ('A', 'B')}
    for row in rows:
        exe = row.get('ExecutablePath')
        if not exe:
            continue
        role = None
        if _norm(exe) == _norm(manifest['binaries']['server']):
            role = 'server'
        elif _norm(exe) == _norm(manifest['binaries']['runner']):
            configs = _arguments(row, '--config')
            if configs and configs != [launch.get('runner_config')]:
                # Compare Windows native extended paths without changing scope.
                if len(configs) != 1 or _norm(configs[0]) != _norm(launch.get('runner_config', '')):
                    continue
            elif not configs:
                continue
            role = 'runner'
        elif _norm(exe) == _norm(manifest['binaries']['tunnel']):
            profiles_in_argv = _arguments(row, '--profile-file')
            for account, profile in profiles.items():
                if len(profiles_in_argv) == 1 and _norm(profiles_in_argv[0]) == _norm(profile):
                    role = account
        if role:
            selected[role].append(row)
    for role, matches in selected.items():
        if len(matches) > 1:
            raise PreviewError('preview_process_owner_ambiguous')
        if not matches:
            # Complete exact-image/config absence proves the original is gone.
            # An unrelated process reusing its old PID is retained untouched.
            continue
        row = matches[0]
        expected = saved.get(role, {})
        if (row.get('ProcessId') != expected.get('pid')
                or row.get('CreationFiletime') != expected.get('creation_filetime')
                or _norm(row.get('ExecutablePath', '')) != _norm(expected.get('executable', ''))):
            raise PreviewError('preview_process_owner_unverified')
        result[role] = expected
    return result


def _record_owner(root, manifest, role, child, *, observe=None, sleep=time.sleep):
    for _ in range(6):
        rows = (observe or _inventory)(manifest)
        matches = [row for row in rows if row.get('ProcessId') == child.pid and row.get('ExecutablePath')]
        if len(matches) == 1:
            row = matches[0]
            expected = manifest['binaries'][role if role in ('server', 'runner') else 'tunnel']
            if _norm(row['ExecutablePath']) != _norm(expected) or not str(row.get('CreationFiletime', '')).isdigit():
                raise PreviewError('preview_process_owner_unverified')
            owner = {'pid': child.pid, 'creation_filetime': row['CreationFiletime'],
                     'executable': row['ExecutablePath'], 'network': manifest['network']}
            data = _owners(root, manifest)
            data['owners'][role] = owner
            atomic_json(_owner_file(root), data)
            return owner
        if child.poll() is not None:
            raise PreviewError('preview_child_exited')
        sleep(.1)
    raise PreviewError('preview_launch_completion_unknown')


def _launch(root, manifest, role, argv, *, env=None):
    state_path = installation.local(root) / 'preview-launch.json'
    if state_path.exists() and read_json(state_path).get('completion_unknown') is True:
        raise PreviewError('preview_launch_completion_unknown')
    atomic_json(state_path, {'installation_id': manifest['installation_id'], 'role': role,
                            'state': 'launching', 'completion_unknown': True})
    try:
        child = subprocess.Popen(argv, cwd=str(installation.private_home(root)),
            env=env if env is not None else installation.environment(manifest), stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        owner = _record_owner(root, manifest, role, child)
        atomic_json(state_path, {'installation_id': manifest['installation_id'], 'role': role,
                                'state': 'started', 'completion_unknown': False, **owner})
        return owner
    except PreviewError:
        raise
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        raise PreviewError('preview_launch_completion_unknown') from None


def _listener(origin, owner):
    try:
        listeners = tcp_listeners(urlsplit(origin).port)
        usable = [row for row in listeners if row['LocalAddress'] in ('127.0.0.1', '0.0.0.0', '::', '::1')]
        if owner is None:
            return not usable
        return bool(usable) and all(row['OwningProcess'] == owner['pid'] for row in usable)
    except (OSError, RuntimeError, ValueError):
        raise PreviewError('preview_listener_observation_unavailable') from None


def _backend_config(root):
    try:
        return backend.read_config(installation.local(root) / 'web-host/backend-launch.json')
    except (OSError, ValueError, RuntimeError, KeyError, TypeError):
        raise PreviewError('preview_backend_configuration_invalid') from None


def _server(root, manifest, *, sleep=time.sleep, now=time.monotonic):
    config = _backend_config(root)
    owners = observed_owners(root, manifest)
    if 'server' not in owners:
        if not _listener(manifest['backend']['origin'], None):
            raise PreviewError('preview_backend_port_occupied')
        env = installation.environment(manifest)
        env['WEBCODEX_ENV_FILE'] = config['env_file']
        _launch(root, manifest, 'server', [manifest['binaries']['server']], env=env)
    deadline = now() + 25
    while now() < deadline:
        owners = observed_owners(root, manifest)
        owner = owners.get('server')
        if not owner:
            raise PreviewError('preview_server_exited')
        if _listener(config['origin'], owner) and backend.ready(config, timeout=min(4, max(.1, deadline - now()))):
            return config
        sleep(.25)
    raise PreviewError('preview_server_not_ready')


def _enroll(root, manifest, config):
    home = installation.private_home(root)
    marker = read_json(home / 'bootstrap.json')
    if marker.get('enrolled') is True:
        return config
    client_id = marker['client_id']
    attempt = home / 'enrollment-attempt.json'
    # A successful login writes server.toml before returning. If output was
    # lost, recover exactly that device/config instead of redeeming twice.
    connections = home / 'connections'
    if attempt.exists():
        matches = list(connections.glob('*/preview/runner.toml')) if connections.exists() else []
        if len(matches) == 1:
            runner_config = matches[0]
        else:
            raise PreviewError('preview_enrollment_completion_unknown')
    else:
        pairing = installation.native(root, manifest, ['pairing', 'create', '--server-url', config['origin'],
            '--env-file', config['env_file'], '--username', 'preview', '--client-id', client_id,
            '--no-system-proxy', '--json'])
        code = pairing.get('pairing_code')
        if not isinstance(code, str) or not code.startswith('wc_pair_'):
            raise PreviewError('preview_pairing_unavailable')
        atomic_json(attempt, {'installation_id': manifest['installation_id'], 'client_id': client_id,
                             'state': 'accepted_login_pending'})
        args = ['login', config['origin'], '--code-stdin', '--dir', str(connections), '--device', client_id,
                '--no-system-proxy', '--json']
        unconfigured = home / 'unconfigured-projects'
        unconfigured.mkdir(exist_ok=True)
        for project in manifest['projectRoots'] or [str(unconfigured)]:
            args += ['--allowed-root', project]
        logged = installation.native(root, manifest, args, stdin=code + '\n')
        runner_config = Path(str(logged.get('runner_config', '')).removeprefix('\\\\?\\'))
    try:
        if not runner_config.resolve().is_relative_to(connections.resolve()) or not runner_config.is_file():
            raise ValueError()
    except (OSError, ValueError):
        raise PreviewError('preview_enrollment_path_invalid') from None
    values = backend._runner_values(runner_config)
    if values.get('client_id') != client_id or values.get('server_url') != config['origin']:
        raise PreviewError('preview_enrollment_identity_invalid')
    installation.configure_runner_shell(root, manifest, runner_config)
    # Registration is native and idempotent; no Session or Job is created.
    for project in manifest['projectRoots']:
        installation.native(root, manifest, ['project', 'register', '--config', str(runner_config), project, '--json'])
    config = {**config, 'runner_config': str(runner_config)}
    atomic_json(installation.local(root) / 'web-host/backend-launch.json', config)
    atomic_json(home / 'bootstrap.json', {**marker, 'enrolled': True,
                                        'applied_projectRoots': manifest['projectRoots']})
    atomic_json(attempt, {'installation_id': manifest['installation_id'], 'client_id': client_id,
                         'state': 'completed'})
    return config


def _apply_projects(root, manifest, config):
    home = installation.private_home(root)
    marker = read_json(home / 'bootstrap.json')
    prior = marker.get('applied_projectRoots', [])
    added = [path for path in manifest['projectRoots'] if path not in prior]
    if not added:
        return
    token_file = Path(config['runner_config']).parent / 'webcodex-user-token'
    if not token_file.is_file() or not token_file.resolve().is_relative_to((home / 'connections').resolve()):
        raise PreviewError('preview_local_user_authority_missing')
    owners = observed_owners(root, manifest)
    if owners.get('runner'):
        # Native activation grants exactly this canonical root and preserves
        # Runner identity/active Jobs using its policy-generation CAS contract.
        for project in added:
            installation.native(root, manifest, ['project', 'activate', '--config', config['runner_config'],
                '--user-token-file', str(token_file), project, '--json'], timeout=45)
    else:
        values = backend._runner_values(Path(config['runner_config']))
        transport_token = values.get('token')
        if not isinstance(transport_token, str) or not transport_token.startswith('wc_agent_'):
            raise PreviewError('preview_runner_authority_invalid')
        selected = home / 'runner-transport-token'
        selected.write_text(transport_token, encoding='utf8')
        selected.chmod(0o600)
        args = ['runner', 'init', '--server-url', config['origin'], '--token-file', str(selected),
                '--client-id', marker['client_id'], '--owner', 'preview', '--display-name', 'CLW Free Preview',
                '--project-registry-dir', str(values['project_registry_dir']), '--allow-cwd-anywhere', 'false',
                '--output', config['runner_config'], '--overwrite']
        for project in dict.fromkeys([*prior, *manifest['projectRoots']]):
            args += ['--allowed-root', project]
        installation.native(root, manifest, args, json_output=False)
        installation.configure_runner_shell(root, manifest, config['runner_config'])
        for project in added:
            installation.native(root, manifest, ['project', 'register', '--config', config['runner_config'], project, '--json'])
    atomic_json(home / 'bootstrap.json', {**marker, 'applied_projectRoots': list(dict.fromkeys([*prior, *added]))})


def pending_changes(root, manifest, owners):
    pending = []
    marker_path = installation.private_home(root) / 'bootstrap.json'
    if marker_path.exists():
        marker = read_json(marker_path)
        previous = marker.get('applied_projectRoots', [])
        if any(path not in previous for path in manifest['projectRoots']):
            pending.append('project_roots_to_activate')
        if any(path not in manifest['projectRoots'] for path in previous):
            pending.append('project_root_removal_requires_safe_reload')
    if any(owner.get('network', manifest['network']) != manifest['network'] for owner in owners.values()):
        pending.append('network_applies_after_owned_process_restart')
    if any(role in ('A', 'B') and role not in {item['id'] for item in manifest['accounts']} for role in owners):
        pending.append('removed_account_retains_live_owner')
    return pending


def operation_state(root, manifest, healthy):
    """Reconcile only our existing native lifecycle receipts, never aliveness."""
    home = installation.private_home(root)
    bootstrap_complete = False
    enrolled = manifest['backend']['mode'] == 'external'
    if (home / 'bootstrap.json').exists():
        marker = read_json(home / 'bootstrap.json')
        bootstrap_complete = (marker.get('installation_id') == manifest['installation_id']
                              and (home / 'server.env').is_file() and (home / 'runner-initial.toml').is_file()
                              and (installation.local(root) / 'web-host/backend-launch.json').is_file())
        attempt_path = home / 'enrollment-attempt.json'
        attempt = read_json(attempt_path) if attempt_path.exists() else {}
        if marker.get('enrolled') is True and attempt.get('state') == 'completed':
            values = backend._runner_values(Path(_backend_config(root)['runner_config']))
            enrolled = (attempt.get('installation_id') == manifest['installation_id']
                        and attempt.get('client_id') == marker.get('client_id') == values.get('client_id'))
    launch_path = installation.local(root) / 'preview-launch.json'
    launch = read_json(launch_path) if launch_path.exists() else {}
    launch_known = (launch.get('installation_id') == manifest['installation_id']
                    and launch.get('completion_unknown') is False and launch.get('state') == 'started')
    complete = (healthy and launch_known and enrolled and
                (bootstrap_complete or manifest['backend']['mode'] == 'external'))
    return {'operation_reconciled': bool(complete), 'bootstrap_complete': bootstrap_complete}


def settings_application(pending):
    """State the actual detached-runtime capability without promising a reload.

    A zero-Job observation is not an admission fence. These detached Windows
    owners have no retained stdin/normal shutdown channel; retain them rather
    than race a new Job or disguise TerminateProcess as graceful shutdown.
    """
    if not pending:
        return {'state': 'applied'}
    result = {'state': 'pending', 'reason': 'existing_detached_native_owners_retained'}
    if 'network_applies_after_owned_process_restart' in pending:
        result['network'] = 'next_windows_boot'
    if 'project_root_removal_requires_safe_reload' in pending:
        result['projectRoots'] = 'offline_native_policy_reload_required'
    elif 'project_roots_to_activate' in pending:
        result['projectRoots'] = 'explicit_connect_hot_activation'
    if 'removed_account_retains_live_owner' in pending:
        result['accounts'] = 'existing_live_account_retained'
    return result


def _tunnel_profile(root, manifest, account, config):
    credential = installation.read_credential(root, account)
    home = installation.private_home(root)
    auth = home / 'mcp-authorization'
    if manifest['backend']['mode'] == 'owned':
        authorization = 'Bearer ' + backend._mcp_server_token(config)
    else:
        selected = manifest['backend'].get('authorization_file')
        if not selected:
            raise PreviewError('preview_external_authorization_required')
        path = Path(selected)
        if not path.is_file() or path.stat().st_size > 8192:
            raise PreviewError('preview_external_authorization_invalid')
        authorization = path.read_text(encoding='utf-8-sig').strip()
    if not authorization.startswith('Bearer ') or any(ord(c) < 32 or ord(c) > 126 for c in authorization):
        raise PreviewError('preview_external_authorization_invalid')
    if auth.exists() and auth.read_text(encoding='utf8') != authorization:
        raise PreviewError('preview_authorization_changed')
    if not auth.exists():
        auth.write_text(authorization, encoding='utf8')
        auth.chmod(0o600)
    profile = home / ('account-' + account + '.yaml')
    quote = lambda value: json.dumps(str(value).replace('\\', '/'))
    content = '\n'.join(['config_version: 1', 'control_plane:', '  base_url: "https://api.openai.com"',
        '  tunnel_id: ' + quote(credential['tunnel_id']), '  api_key: "env:CLW_PREVIEW_TUNNEL_KEY"',
        'health:', '  listen_addr: "127.0.0.1:0"',
        '  url_file: ' + quote(home / ('account-' + account + '-health-url.txt')),
        'admin_ui:', '  open_browser: false', 'mcp:', '  server_urls:', '    - channel: main',
        '      url: ' + quote(manifest['backend']['origin'] + '/mcp'), '  extra_headers:',
        '    Authorization: ' + quote('file:' + str(auth)), ''])
    if profile.exists() and profile.read_text(encoding='utf8') != content:
        raise PreviewError('preview_tunnel_configuration_changed')
    if not profile.exists():
        profile.write_text(content, encoding='utf8')
    env = installation.environment(manifest)
    env['CLW_PREVIEW_TUNNEL_KEY'] = credential['api_key']
    argv = [manifest['binaries']['tunnel'], 'run', '--profile-file', str(profile)]
    if manifest['network']['mode'] == 'proxy':
        argv += ['--control-plane.http-proxy', manifest['network']['proxy_url'],
                 '--harpoon.http-proxy', manifest['network']['proxy_url']]
    return argv, env


def _account_health(root, manifest, account, owner):
    health_file = installation.private_home(root) / ('account-' + account + '-health-url.txt')
    if not owner or not health_file.is_file() or health_file.stat().st_size > 512:
        return False
    try:
        endpoint = installation.origin(health_file.read_text(encoding='utf8').strip())
        if not _listener(endpoint, owner):
            return False
        result = run_bounded([manifest['binaries']['tunnel'], 'health', '--json', '--url', endpoint,
            '--pid', str(owner['pid']), '--require-control-plane-poll'], capture_stdout=True, timeout=8,
            env=installation.environment(manifest), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return result.returncode == 0 and not result.stdout_truncated and _listener(endpoint, owner)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        return False


def check(root, *, manifest=None):
    manifest = installation.load(root) if manifest is None else manifest
    owners = observed_owners(root, manifest)
    components = {}
    if manifest['backend']['mode'] == 'owned':
        server = False
        runner = False
        if owners.get('server'):
            config = _backend_config(root)
            server = _listener(config['origin'], owners['server']) and backend.mcp_ready(config, timeout=3)
            if server and owners.get('runner'):
                marker = read_json(installation.private_home(root) / 'bootstrap.json')
                runner = backend.runner_ready(config, marker['client_id'], timeout=3)
        components = {'server': 'ready' if server else ('unavailable' if owners.get('server') else 'absent'),
                      'runner': 'ready' if runner else ('connection_wait' if owners.get('runner') else 'absent')}
    else:
        components['backend'] = 'external'
    accounts = []
    for item in manifest['accounts']:
        account = item['id']
        has_key = installation.credential_path(root, account).is_file()
        ready = _account_health(root, manifest, account, owners.get(account)) if has_key else False
        state = 'ready' if ready else ('credentials_required' if not has_key else
                                      ('connection_wait' if account in owners else 'absent'))
        accounts.append({'id': account, 'state': state, 'credentialConfigured': has_key, 'has_key': has_key})
    configured_accounts = [account for account in accounts if account['has_key']]
    healthy = (bool(configured_accounts) and all(value in ('ready', 'external') for value in components.values())
               and all(account['state'] == 'ready' for account in configured_accounts))
    result = {'state': 'ready' if healthy else ('awaiting_credentials' if not configured_accounts
              else 'needs_attention'), 'healthy': healthy, 'components': components, 'accounts': accounts,
              'owners': {role: {'pid': owner['pid'], 'creation_filetime': owner['creation_filetime']}
                         for role, owner in owners.items()}, 'checked_at': utc(), 'model_calls': 0,
              'pendingChanges': pending_changes(root, manifest, owners)}
    if observed_owners(root, manifest) != owners:
        raise PreviewError('preview_process_owner_changed')
    result.update(operation_state(root, manifest, healthy))
    result['settingsApplication'] = settings_application(result['pendingChanges'])
    atomic_json(installation.local(root) / 'preview-status.json', result)
    return result


def connect(root):
    manifest = installation.load(root)
    installation.bootstrap(root)
    with FileLease(installation.local(root) / 'preview-connect.lock'):
        if manifest['backend']['mode'] == 'owned':
            config = _server(root, manifest)
            config = _enroll(root, manifest, config)
            _apply_projects(root, manifest, config)
            if 'runner' not in observed_owners(root, manifest):
                _launch(root, manifest, 'runner', [manifest['binaries']['runner'], '--config', config['runner_config']])
        else:
            config = {}
        owners = observed_owners(root, manifest)
        for item in manifest['accounts']:
            account = item['id']
            if account in owners or not installation.credential_path(root, account).is_file():
                continue
            argv, env = _tunnel_profile(root, manifest, account, config)
            _launch(root, manifest, account, argv, env=env)
    result = check(root, manifest=manifest)
    from preview_connection_watch import configure_startup, ensure_started
    result['startup'] = configure_startup(root, manifest)
    result['watch'] = ensure_started(root, manifest)
    return result


def public_timeline(root):
    """At most forty original public event projections; never raw log rows."""
    folder = installation.local(root) / 'preview-watch'
    rows = []
    found = 0
    skipped = 0
    truncated = False
    unavailable = False
    for name in ('events.previous.jsonl', 'events.jsonl'):
        path = folder / name
        if not path.exists():
            continue
        found += 1
        try:
            if path.is_symlink():
                raise ValueError()
            with path.open('rb') as stream:
                size = os.fstat(stream.fileno()).st_size
                offset = max(0, size - TIMELINE_TAIL_BYTES)
                stream.seek(offset)
                data = stream.read(TIMELINE_TAIL_BYTES)
            if offset:
                truncated = True
                data = data.split(b'\n', 1)[1] if b'\n' in data else b''
            # The size and row limits are independent, including malformed
            # files with many tiny lines or one giant non-JSON fragment.
            lines = data.splitlines()
            if len(lines) > 256:
                truncated = True
                lines = lines[-256:]
            for line in lines:
                if not line.strip():
                    continue
                try:
                    if len(line) > 8192:
                        raise ValueError()
                    event = json.loads(line)
                    if not isinstance(event, dict) or event.get('state') not in PUBLIC_STATES:
                        raise ValueError()
                    stamp = event.get('at', event.get('time'))
                    if not isinstance(stamp, str) or len(stamp) > 40:
                        raise ValueError()
                    observed = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
                    if observed.tzinfo is None:
                        raise ValueError()
                    row = {'at': observed.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
                           'state': event['state']}
                    for key in ('stage', 'reason', 'error_code', 'code'):
                        value = event.get(key)
                        if not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,95}', value):
                            continue
                        if key in ('reason', 'error_code', 'code') and not (
                                value.startswith('preview_') or value in PUBLIC_REASONS):
                            continue
                        if key == 'stage' and value not in ('backend', 'server', 'runner', 'tunnel', 'watch', 'settings', 'connect'):
                            continue
                        row['error_code' if key == 'code' else key] = value
                    rows.append(row)
                    if len(rows) > TIMELINE_LIMIT:
                        truncated = True
                        rows = rows[-TIMELINE_LIMIT:]
                except (ValueError, UnicodeError, TypeError, OverflowError):
                    skipped += 1
        except (OSError, ValueError):
            unavailable = True
    state = ('not_recorded' if not found else 'available' if rows and not skipped and not unavailable
             else 'partial' if rows else 'unavailable')
    return {'state': state, 'rows': rows, 'limit': TIMELINE_LIMIT,
            'truncated': truncated, 'skipped_records': skipped}


def export_status(root):
    """A support projection without config paths, tunnel IDs, secrets or logs."""
    value = installation.read(root)
    try:
        status = check(root) if value['configured'] else {'state': 'not_configured'}
    except PreviewError as error:
        status = {'state': 'needs_attention', 'code': str(error), 'operation_reconciled': False}
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError):
        status = {'state': 'needs_attention', 'code': 'preview_observation_unavailable', 'operation_reconciled': False}
    return {'schema': 1, 'installation_id': value['manifest']['installation_id'],
            'backend_mode': value['manifest']['backend']['mode'],
            'network_mode': value['manifest']['network']['mode'], 'status': status,
            'timeline': public_timeline(root), 'exported_at': utc()}


def control(root, action, payload=None):
    payload = {} if payload is None else payload
    if not isinstance(payload, dict):
        raise PreviewError('preview_request_invalid')
    actions = {'read': lambda: installation.read(root), 'save': lambda: installation.save(root, payload),
               'bootstrap': lambda: installation.bootstrap(root), 'connect': lambda: connect(root),
               'check': lambda: check(root), 'export': lambda: export_status(root)}
    if action not in actions:
        raise PreviewError('preview_action_invalid')
    if action != 'save' and payload:
        raise PreviewError('preview_request_invalid')
    return actions[action]()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', nargs='?', choices=('read', 'save', 'bootstrap', 'connect', 'check', 'export'))
    parser.add_argument('--action', choices=('read', 'save', 'bootstrap', 'connect', 'check', 'export'))
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if not (args.action or args.command) or args.action and args.command and args.action != args.command:
            raise PreviewError('preview_action_invalid')
        raw = sys.stdin.buffer.read(131073) if not sys.stdin.isatty() else b''
        if len(raw) > 131072:
            raise PreviewError('preview_request_too_large')
        try:
            payload = json.loads(raw) if raw.strip() else {}
        except (ValueError, UnicodeError):
            raise PreviewError('preview_request_invalid') from None
        result = control(args.root, args.action or args.command, payload)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=True, allow_nan=False))
        return 0
    except PreviewError as error:
        print(json.dumps({'ok': False, 'code': str(error)}))
        return 1
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError):
        print(json.dumps({'ok': False, 'code': 'preview_control_unavailable'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
