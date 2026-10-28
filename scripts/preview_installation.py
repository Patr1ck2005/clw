"""Independent free-preview installation metadata and private native bootstrap.

Only explicit installation paths are used. No Desktop discovery, inherited
credentials, browser control, remote model request, or business ledger lives here.
"""
from __future__ import annotations

from pathlib import Path
from contextlib import ExitStack
import ctypes
import json
import os
import re
import socket
import subprocess
import time
import tomllib
import uuid
from urllib.parse import urlsplit

from bounded_process import run_bounded
from product_runtime import FileLease, atomic_json, read_json

SCHEMA = 1
BINARY_NAMES = {'cli': 'webcodex.exe', 'server': 'webcodex-server.exe',
                'runner': 'webcodex-runner.exe', 'tunnel': 'tunnel-client.exe'}
PROXY_VARIABLES = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy',
                   'https_proxy', 'all_proxy')
SHELL_BEGIN = '# CLW private Runner shell begin'
SHELL_END = '# CLW private Runner shell end'


class PreviewError(ValueError):
    """A fixed, non-secret code suitable for the local UI."""


def local(root):
    # Installed versions link .local to stable installation data. Persist native
    # paths through that canonical data directory, never a disposable version.
    return (Path(root).resolve() / '.local').resolve()


def private_home(root):
    return local(root) / 'preview-private'


def origin(value):
    try:
        url = urlsplit(value)
        if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
                or url.path or url.query or url.fragment or url.username or url.password):
            raise ValueError()
        return 'http://127.0.0.1:' + str(url.port)
    except (ValueError, TypeError, AttributeError):
        raise PreviewError('preview_origin_invalid') from None


def absolute(value, *, directory=False):
    if not isinstance(value, str) or not value or len(value) > 32700 or any(ord(c) < 32 for c in value):
        raise PreviewError('preview_path_invalid')
    path = Path(value)
    if not path.is_absolute():
        raise PreviewError('preview_path_invalid')
    if directory and not path.is_dir():
        raise PreviewError('preview_project_root_missing')
    return str(path.resolve())


def validate(value, *, require_project_roots=True):
    required = {'schema', 'installation_id', 'backend', 'binaries', 'network', 'accounts', 'projectRoots'}
    if (not isinstance(value, dict) or not required <= set(value) <= required | {'auto_connect'} or type(value.get('schema')) is not int
            or value['schema'] != SCHEMA):
        raise PreviewError('preview_manifest_invalid')
    if 'auto_connect' in value and type(value['auto_connect']) is not bool:
        raise PreviewError('preview_manifest_invalid')
    try:
        ident = str(uuid.UUID(value['installation_id']))
        if value['installation_id'] != ident:
            raise ValueError()
    except (ValueError, AttributeError, TypeError):
        raise PreviewError('preview_installation_id_invalid') from None
    backend = value['backend']
    if not isinstance(backend, dict) or backend.get('mode') not in ('owned', 'external'):
        raise PreviewError('preview_backend_invalid')
    permitted = {'mode', 'origin'} | ({'authorization_file'} if backend['mode'] == 'external' else set())
    if not {'mode', 'origin'} <= set(backend) <= permitted:
        raise PreviewError('preview_backend_invalid')
    checked_backend = {'mode': backend['mode'], 'origin': origin(backend['origin'])}
    if 'authorization_file' in backend:
        checked_backend['authorization_file'] = absolute(backend['authorization_file'])
    binaries = value['binaries']
    if not isinstance(binaries, dict) or set(binaries) != set(BINARY_NAMES):
        raise PreviewError('preview_binaries_invalid')
    checked_binaries = {key: absolute(binaries[key]) for key in BINARY_NAMES}
    for key, name in BINARY_NAMES.items():
        if Path(checked_binaries[key]).name.casefold() != name:
            raise PreviewError('preview_binary_name_invalid')
    network = value['network']
    if not isinstance(network, dict) or network.get('mode') not in ('system', 'proxy', 'direct'):
        raise PreviewError('preview_network_invalid')
    if set(network) != ({'mode', 'proxy_url'} if network['mode'] == 'proxy' else {'mode'}):
        raise PreviewError('preview_network_invalid')
    checked_network = {'mode': network['mode']}
    if network['mode'] == 'proxy':
        try:
            proxy = urlsplit(network['proxy_url'])
            if (proxy.scheme not in ('http', 'https', 'socks5', 'socks5h') or not proxy.hostname
                    or (not proxy.port and proxy.scheme not in ('http', 'https'))
                    or proxy.username or proxy.password or proxy.path not in ('', '/')
                    or proxy.query or proxy.fragment or any(c.isspace() for c in network['proxy_url'])):
                raise ValueError()
            checked_network['proxy_url'] = network['proxy_url'].rstrip('/')
        except (ValueError, TypeError, AttributeError):
            raise PreviewError('preview_proxy_invalid') from None
    accounts = value['accounts']
    if (not isinstance(accounts, list) or not 1 <= len(accounts) <= 2
            or any(not isinstance(item, dict) or set(item) != {'id'} or item['id'] not in ('A', 'B') for item in accounts)
            or len({item['id'] for item in accounts}) != len(accounts)):
        raise PreviewError('preview_accounts_invalid')
    roots = value['projectRoots']
    if not isinstance(roots, list) or len(roots) > 128:
        raise PreviewError('preview_project_roots_invalid')
    roots = [absolute(item, directory=require_project_roots) for item in roots]
    if len({os.path.normcase(item) for item in roots}) != len(roots):
        raise PreviewError('preview_project_roots_invalid')
    return {'schema': SCHEMA, 'installation_id': ident, 'backend': checked_backend,
            'binaries': checked_binaries, 'network': checked_network,
            'accounts': accounts, 'projectRoots': roots, 'auto_connect': value.get('auto_connect', True)}


def defaults(root):
    root = Path(root).resolve()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    return {'schema': SCHEMA, 'installation_id': str(uuid.uuid4()),
            'backend': {'mode': 'owned', 'origin': 'http://127.0.0.1:' + str(port)},
            'binaries': {key: str(root / 'runtime/native' / name) for key, name in BINARY_NAMES.items()},
            'network': {'mode': 'system'}, 'accounts': [{'id': 'A'}], 'projectRoots': [], 'auto_connect': True}


def initialize(root, binaries, *, maintenance=False):
    """Installer-only metadata creation; no native execution or service start."""
    if (local(root) / 'preview-installation.json').exists():
        current = load(root)
        pending = local(root) / 'preview-runtime-rebind.json'
        recovery = read_json(pending) if pending.exists() else {}
        if (all(Path(path).is_file() for path in current['binaries'].values())
                and recovery.get('state') != 'prepared'
                and (not maintenance or current['binaries'] == binaries)):
            return read(root)
        if current['backend']['mode'] != 'owned':
            return read(root)
        # Ordinary initialization retains existing owners. Explicit installer
        # maintenance may rebind an idle owned runtime through this same journal.
        with ExitStack() as leases:
            for relative in ('preview-installation.lock', 'preview-bootstrap.lock',
                             'preview-connect.lock', 'preview-watch/start.lock',
                             'preview-watch/watch.lock'):
                leases.enter_context(FileLease(local(root) / relative))
            current = load(root)
            recovery = read_json(pending) if pending.exists() else {}
            if recovery.get('state') == 'prepared':
                if (recovery.get('schema') != 1 or recovery.get('installation_id') != current['installation_id']
                        or current['binaries'] not in (recovery.get('previous_binaries'), recovery.get('binaries'))):
                    raise PreviewError('preview_runtime_rebind_identity_changed')
                if maintenance and binaries != recovery.get('binaries'):
                    raise PreviewError('preview_runtime_rebind_original_operation_pending')
                binaries = recovery['binaries']
                previous = recovery['previous_binaries']
            else:
                if (all(Path(path).is_file() for path in current['binaries'].values())
                        and (not maintenance or current['binaries'] == binaries)):
                    return read(root)
                previous = current['binaries']
            changed = validate({**current, 'binaries': binaries}, require_project_roots=False)
            if not all(Path(path).is_file() for path in changed['binaries'].values()):
                raise PreviewError('preview_bundled_binary_missing')
            _require_runtime_absent(root, {**current, 'binaries': previous})
            config_path = local(root) / 'web-host/backend-launch.json'
            config = read_json(config_path) if config_path.exists() else None
            marker = private_home(root) / 'bootstrap.json'
            if marker.exists() and read_json(marker).get('installation_id') != current['installation_id']:
                raise PreviewError('preview_installation_identity_changed')
            if marker.exists() and config is None:
                raise PreviewError('preview_backend_configuration_invalid')
            if config is not None:
                for key in ('cli', 'server', 'runner'):
                    if config.get(key) not in (previous[key], changed['binaries'][key]):
                        raise PreviewError('preview_backend_configuration_invalid')
                # These are stable physical data paths in every public preview.
                # Resolve legacy internal junction spelling without changing data.
                for key in ('env_file', 'runner_config'):
                    path = Path(config.get(key, '')).resolve()
                    if not path.is_file() or not path.is_relative_to(local(root)):
                        raise PreviewError('preview_backend_configuration_invalid')
                    config[key] = str(path)
            startup = recovery.get('startup') if recovery.get('state') == 'prepared' else None
            if maintenance and recovery.get('state') != 'prepared':
                from preview_connection_watch import startup_rebind_plan
                startup = startup_rebind_plan(root, changed)
            transaction = {'schema': 1,
                'installation_id': current['installation_id'], 'previous_binaries': previous,
                'binaries': changed['binaries']}
            if startup is not None:transaction['startup']=startup
            atomic_json(pending, {**transaction,'state':'prepared'})
            if config is not None:
                for path in {Path(config['runner_config']), private_home(root) / 'runner-initial.toml'}:
                    if path.is_file() and SHELL_BEGIN in path.read_text(encoding='utf8'):
                        configure_runner_shell(root, changed, path)
                atomic_json(config_path, {**config, **{key: changed['binaries'][key]
                                                     for key in ('cli', 'server', 'runner')}})
            atomic_json(local(root) / 'preview-installation.json', changed)
            if startup is not None:
                from preview_connection_watch import configure_startup
                configure_startup(root, changed, rebind=startup)
            atomic_json(pending, {**transaction,'state':'completed'})
        return read(root)
    manifest = defaults(root)
    manifest['binaries'] = binaries
    return save(root, {'manifest': manifest})


def _require_runtime_absent(root, manifest):
    """A complete census and saved creation identities fence missing-image repair."""
    from windows_process_owner import process_inventory, process_identity, SUPPORTED_TARGET_NAMES
    home = local(root)
    for path in (home / 'preview-launch.json', private_home(root) / 'enrollment-attempt.json'):
        if path.exists():
            attempt = read_json(path)
            if (attempt.get('completion_unknown') is True or
                    (path.name == 'enrollment-attempt.json' and attempt.get('state') != 'completed')):
                raise PreviewError('preview_runtime_rebind_completion_unknown')
    saved = {}
    owners_path = home / 'preview-owners.json'
    if owners_path.exists():
        record = read_json(owners_path)
        if record.get('installation_id') != manifest['installation_id'] or not isinstance(record.get('owners'), dict):
            raise PreviewError('preview_owner_metadata_invalid')
        saved.update(record['owners'])
    watch_path = home / 'preview-watch/owner.json'
    if watch_path.exists():
        watch = read_json(watch_path)
        if watch.get('installation_id') != manifest['installation_id']:
            raise PreviewError('preview_owner_metadata_invalid')
        saved['watch'] = watch
    norm = lambda value: os.path.abspath(str(value).removeprefix('\\\\?\\')).replace('\\', '/').casefold().rstrip('/')
    images = {norm(path) for path in manifest['binaries'].values()}
    # The physical data parent is the installation root. Include old watch and
    # native Job descendants; a reused PID is distinguished by creation time.
    prefix = norm(home.parent / 'versions') + '/'
    identities = {}
    for owner in saved.values():
        if (not isinstance(owner, dict) or type(owner.get('pid')) is not int
                or not str(owner.get('creation_filetime', '')).isdigit()):
            raise PreviewError('preview_owner_metadata_invalid')
        identities[owner['pid']] = owner['creation_filetime']
    def located(row):
        image = norm(row.get('ExecutablePath', ''))
        command = str(row.get('CommandLine') or '').replace('\\', '/').casefold()
        return (image in images or image.startswith(prefix) or prefix in command
                or row.get('ParentProcessId') in identities)
    def candidate(row):
        return row['ProcessId'] in identities or located(row)
    for delay in (0, .025, .075):
        if delay:
            time.sleep(delay)
        try:
            rows = process_inventory(target_names=SUPPORTED_TARGET_NAMES, candidate_filter=candidate)
            for row in rows:
                if row['ProcessId'] == os.getpid():
                    continue
                pid = row['ProcessId']
                if pid in identities:
                    identity = row if row.get('CreationFiletime') else process_identity(pid)
                    if identity['CreationFiletime'] == identities[pid]:
                        raise PreviewError('preview_runtime_rebind_owner_running')
                if row.get('ExecutablePath') and located(row):
                    raise PreviewError('preview_runtime_rebind_owner_running')
            return
        except PreviewError:
            raise
        except (OSError, ValueError, RuntimeError):
            pass
    raise PreviewError('preview_runtime_rebind_observation_unavailable') from None


def load(root):
    # A previously granted directory may be moved or removed. Keep its history
    # readable so settings can repair it and uninstall can retain the data.
    return validate(read_json(local(root) / 'preview-installation.json', maximum=65536),
                    require_project_roots=False)


def secure_private(path):
    """Protect a new private directory before a native tool writes credentials."""
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
        raise PreviewError('preview_private_directory_invalid')
    if os.name != 'nt':
        path.chmod(0o700)
        return
    # Owner Rights and SYSTEM only, inherited by native-created children.
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    convert = advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    convert.restype = ctypes.c_int
    apply = advapi.SetFileSecurityW
    apply.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_void_p]
    apply.restype = ctypes.c_int
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    descriptor = ctypes.c_void_p()
    if not convert('D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OW)', 1, ctypes.byref(descriptor), None):
        raise PreviewError('preview_private_acl_unavailable')
    try:
        if not apply(str(path), 0x80000004, descriptor):
            raise PreviewError('preview_private_acl_unavailable')
    finally:
        kernel.LocalFree(descriptor)


class _Blob(ctypes.Structure):
    _fields_ = [('size', ctypes.c_uint32), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def _dpapi(data, *, decrypt=False):
    if os.name != 'nt':
        raise PreviewError('preview_windows_private_storage_required')
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source = _Blob(len(data), buffer)
    target = _Blob()
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    if decrypt:
        fn = crypt.CryptUnprotectData
        fn.argtypes = [ctypes.POINTER(_Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                       ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(_Blob)]
        ok = fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target))
    else:
        fn = crypt.CryptProtectData
        fn.argtypes = [ctypes.POINTER(_Blob), ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_void_p,
                       ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(_Blob)]
        ok = fn(ctypes.byref(source), 'CLW preview account', None, None, None, 1, ctypes.byref(target))
    if not ok:
        raise PreviewError('preview_private_storage_unavailable')
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel.LocalFree(target.data)


def credential_path(root, account):
    if account not in ('A', 'B'):
        raise PreviewError('preview_account_invalid')
    return private_home(root) / ('account-' + account + '.dpapi')


def validate_credentials(value, accounts):
    if not isinstance(value, dict) or not set(value) <= {item['id'] for item in accounts}:
        raise PreviewError('preview_credentials_invalid')
    result = {}
    for account, credential in value.items():
        if (not isinstance(credential, dict) or set(credential) != {'tunnel_id', 'api_key'}
                or not isinstance(credential['tunnel_id'], str)
                or not re.fullmatch(r'tunnel_[a-f0-9]{32}', credential['tunnel_id'])
                or not isinstance(credential['api_key'], str) or not 20 <= len(credential['api_key']) <= 4096
                or any(ord(c) < 33 or ord(c) > 126 for c in credential['api_key'])):
            raise PreviewError('preview_credentials_invalid')
        result[account] = credential
    return result


def read_credential(root, account):
    path = credential_path(root, account)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 16384:
        raise PreviewError('preview_credentials_missing')
    try:
        result = json.loads(_dpapi(path.read_bytes(), decrypt=True))
        return validate_credentials({account: result}, [{'id': account}])[account]
    except (ValueError, UnicodeError):
        raise PreviewError('preview_credentials_unavailable') from None


def read(root):
    path = local(root) / 'preview-installation.json'
    manifest = load(root) if path.exists() else defaults(root)
    status = {}
    try:
        saved = read_json(local(root) / 'preview-status.json', maximum=65536)
        # Only this module's fixed status projection is returned, never raw CLI JSON.
        if isinstance(saved, dict):
            status = {key: saved[key] for key in ('state', 'healthy', 'components', 'accounts', 'owners',
                       'checked_at', 'model_calls', 'pendingChanges', 'settingsApplication',
                       'operation_reconciled', 'bootstrap_complete') if key in saved}
    except (OSError, ValueError):
        pass
    return {'configured': path.exists(), 'manifest': manifest,
            'accounts': [{'id': item['id'], 'credentialConfigured': credential_path(root, item['id']).is_file(),
                          'has_key': credential_path(root, item['id']).is_file()} for item in manifest['accounts']],
            'status': status}


def disable_auto_connect(root):
    """Lifecycle-only update: preserve historical roots and encrypted accounts."""
    with FileLease(local(root) / 'preview-installation.lock'):
        manifest = {**load(root), 'auto_connect': False}
        atomic_json(local(root) / 'preview-installation.json', manifest)
        if (private_home(root) / 'startup.json').exists():
            from preview_connection_watch import configure_startup
            configure_startup(root, manifest)
    return read(root)


def save(root, payload):
    if not isinstance(payload, dict) or not set(payload) <= {'manifest', 'credentials'} or 'manifest' not in payload:
        raise PreviewError('preview_save_invalid')
    manifest = validate(payload['manifest'])
    credentials = validate_credentials(payload.get('credentials', {}), manifest['accounts'])
    home = local(root)
    home.mkdir(parents=True, exist_ok=True)
    with FileLease(home / 'preview-installation.lock'):
        current = load(root) if (home / 'preview-installation.json').exists() else None
        if current and current['installation_id'] != manifest['installation_id']:
            raise PreviewError('preview_installation_identity_changed')
        if (current and any(current[key] != manifest[key] for key in ('backend', 'binaries'))
                and (private_home(root) / 'bootstrap.json').exists()):
            raise PreviewError('preview_backend_identity_locked')
        secure_private(private_home(root))
        tunnel_ids = []
        for item in manifest['accounts']:
            account = item['id']
            credential = credentials.get(account)
            if credential is None and credential_path(root, account).is_file():
                credential = read_credential(root, account)
            if credential is not None:
                tunnel_ids.append(credential['tunnel_id'])
        if len(set(tunnel_ids)) != len(tunnel_ids):
            raise PreviewError('preview_duplicate_account_tunnel')
        # Encrypt/validate all inputs before replacing any account file.
        encrypted = {key: _dpapi(json.dumps(value).encode('utf8')) for key, value in credentials.items()}
        for account, data in encrypted.items():
            target = credential_path(root, account)
            if target.is_symlink():
                raise PreviewError('preview_private_directory_invalid')
            temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.tmp')
            try:
                with temporary.open('xb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, target)
            finally:
                if temporary.exists():
                    temporary.unlink()
        atomic_json(home / 'preview-installation.json', manifest)
        if not manifest['auto_connect'] and (private_home(root) / 'startup.json').exists():
            from preview_connection_watch import configure_startup
            configure_startup(root, manifest)
    return read(root)


def private_runtimes(manifest):
    # The manifest retains the runtime belonging to its installed version even
    # when a newer application version is selected. Never discover host tools.
    runtime = Path(manifest['binaries']['cli']).resolve().parent.parent
    return {'python': runtime / 'python/python.exe',
            'powershell': runtime / 'powershell/pwsh.exe',
            'native': runtime / 'native'}


def configure_runner_shell(root, manifest, path):
    """Bind a native-generated, installation-owned config to its private PS7."""
    path = Path(path).resolve()
    if not path.is_relative_to(local(root)) or not path.is_file():
        raise PreviewError('preview_runner_configuration_invalid')
    text = path.read_text(encoding='utf8')
    try:
        values = tomllib.loads(text)
    except ValueError:
        raise PreviewError('preview_runner_configuration_invalid') from None
    runtimes = private_runtimes(manifest)
    shell = {'program': str(runtimes['powershell']),
             'args': ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'],
             'dialect': 'powershell',
             'path_prepend': [str(runtimes['python'].parent), str(runtimes['powershell'].parent),
                              str(runtimes['native'])]}
    if values.get('shell') == shell:
        return
    if SHELL_BEGIN in text or SHELL_END in text:
        pattern = re.escape(SHELL_BEGIN) + r'\n.*?\n' + re.escape(SHELL_END)
        if text.count(SHELL_BEGIN) != 1 or text.count(SHELL_END) != 1:
            raise PreviewError('preview_runner_configuration_invalid')
        text, count = re.subn(pattern, '', text, flags=re.S)
        if count != 1:
            raise PreviewError('preview_runner_configuration_invalid')
    elif 'shell' in values:
        # A foreign/custom section is not an installation-owned bootstrap.
        raise PreviewError('preview_runner_configuration_invalid')
    block = '\n'.join([SHELL_BEGIN, '[shell]',
        *[key + ' = ' + json.dumps(value, ensure_ascii=False) for key, value in shell.items()], SHELL_END])
    updated = text.rstrip() + '\n\n' + block + '\n'
    try:
        if tomllib.loads(updated)['shell'] != shell:
            raise ValueError()
    except ValueError:
        raise PreviewError('preview_runner_configuration_invalid') from None
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf8', newline='\n') as output:
            output.write(updated)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def environment(manifest):
    # Start from OS basics, stripping every inherited WebCodex/tunnel/provider
    # authority. Explicit installation files are the only source of credentials.
    denied = ('WEBCODEX_', 'CLW_', 'CONTROL_PLANE_', 'OPENAI_', 'TUNNEL_', 'MCP_',
              'HARPOON_', 'CLOUDFLARED_', 'HEALTH_', 'ADMIN_UI_')
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith(denied)}
    runtimes = private_runtimes(manifest)
    inherited_path = next((value for key, value in env.items() if key.upper() == 'PATH'), '')
    for key in tuple(env):
        if key.upper() in ('PATH', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONUSERBASE',
                           'POWERSHELL_TELEMETRY_OPTOUT', 'DO_NOT_TRACK'):
            env.pop(key)
    env['PATH'] = os.pathsep.join([str(runtimes['python'].parent), str(runtimes['powershell'].parent),
                                 str(runtimes['native']), *([inherited_path] if inherited_path else [])])
    env['PYTHONNOUSERSITE'] = '1'
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env['POWERSHELL_TELEMETRY_OPTOUT'] = '1'
    env['DO_NOT_TRACK'] = '1'
    mode = manifest['network']['mode']
    if mode != 'system':
        for key in PROXY_VARIABLES:
            env.pop(key, None)
    if mode == 'proxy':
        for key in PROXY_VARIABLES:
            env[key] = manifest['network']['proxy_url']
    for key in ('NO_PROXY', 'no_proxy'):
        env[key] = '127.0.0.1,localhost,::1'
    return env


def native(root, manifest, args, *, stdin=None, timeout=25, json_output=True):
    """Capture native output privately; exceptions never carry credential argv."""
    argv = [manifest['binaries']['cli'], *args]
    options = {'cwd': str(private_home(root)), 'env': environment(manifest),
               'creationflags': getattr(subprocess, 'CREATE_NO_WINDOW', 0)}
    try:
        if stdin is None:
            result = run_bounded(argv, timeout=timeout, capture_stdout=True, max_output_bytes=262144, **options)
            if result.returncode or result.stdout_truncated:
                raise PreviewError('preview_native_command_failed')
            raw = result.stdout
        else:
            child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, **options)
            try:
                raw, _ = child.communicate(stdin.encode('utf8'), timeout=timeout)
            except BaseException:
                child.kill()
                child.wait(timeout=2)
                raise
            if child.returncode or len(raw) > 262144:
                raise PreviewError('preview_native_command_failed')
        return (json.loads(raw) if raw else {}) if json_output else {}
    except subprocess.TimeoutExpired:
        raise PreviewError('preview_native_completion_unknown') from None
    except (OSError, UnicodeError, json.JSONDecodeError, subprocess.SubprocessError):
        raise PreviewError('preview_native_command_failed') from None


def bootstrap(root):
    manifest = load(root)
    if manifest['backend']['mode'] == 'external':
        return {'state': 'external', 'backendStarted': False}
    home = private_home(root)
    secure_private(home)
    marker = home / 'bootstrap.json'
    folder = local(root) / 'web-host'
    folder.mkdir(parents=True, exist_ok=True)
    with FileLease(local(root) / 'preview-bootstrap.lock'):
        if marker.exists():
            record = read_json(marker)
            if record.get('installation_id') != manifest['installation_id']:
                raise PreviewError('preview_installation_identity_changed')
            return {'state': 'bootstrapped', 'backendStarted': False}
        for binary in manifest['binaries'].values():
            if not Path(binary).is_file():
                raise PreviewError('preview_bundled_binary_missing')
        server_env = home / 'server.env'
        runner = home / 'runner-initial.toml'
        # Never overwrite an accepted/unknown native init. A partial bootstrap
        # is resumed from its exact generated env file, not a second identity.
        if not server_env.exists():
            native(root, manifest, ['server', 'init', '--listen', '127.0.0.1:' + str(urlsplit(manifest['backend']['origin']).port),
                   '--data-dir', str(home / 'server-data'), '--env-file', str(server_env), '--json'])
        from webcodex_backend import _mcp_server_token
        token = _mcp_server_token({'env_file': str(server_env)})
        token_file = home / 'bootstrap-token'
        if not token_file.exists():
            token_file.write_text(token, encoding='utf8')
            token_file.chmod(0o600)
        client_id = 'preview-' + manifest['installation_id'].replace('-', '')
        if not runner.exists():
            args = ['runner', 'init', '--server-url', manifest['backend']['origin'], '--token-file', str(token_file),
                    '--client-id', client_id, '--owner', 'preview', '--display-name', 'CLW Free Preview',
                    '--project-registry-dir', str(home / 'project-registry'), '--allow-cwd-anywhere', 'false',
                    '--output', str(runner)]
            unconfigured = home / 'unconfigured-projects'
            unconfigured.mkdir(exist_ok=True)
            for path in manifest['projectRoots'] or [str(unconfigured)]:
                args += ['--allowed-root', path]
            native(root, manifest, args, json_output=False)
        configure_runner_shell(root, manifest, runner)
        launch = {'version': 1, **{key: manifest['binaries'][key] for key in ('cli', 'server', 'runner')},
                  'origin': manifest['backend']['origin'], 'env_file': str(server_env), 'runner_config': str(runner),
                  'network': manifest['network']}
        atomic_json(folder / 'backend-launch.json', launch)
        atomic_json(marker, {'schema': 1, 'installation_id': manifest['installation_id'],
                            'client_id': client_id, 'enrolled': False,
                            'applied_projectRoots': manifest['projectRoots']})
    return {'state': 'bootstrapped', 'backendStarted': False}
