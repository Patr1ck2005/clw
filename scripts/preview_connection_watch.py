"""Independent preview connection waiting using the existing bounded watch rules.

Only absent owned components may be recreated. Live unavailable owners are
retained. No browser, model dispatch, scheduled business task, or process stop.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import socket
from urllib.parse import urlsplit

from local_mcp_watch import DELAYS, record
from product_runtime import FileLease, atomic_json, read_json, utc
import preview_installation as installation
from preview_installation import PreviewError
from web_host_supervisor_owner import command_argv
from windows_process_owner import process_inventory


def source_signature():
    digest = hashlib.sha256()
    for name in ('preview_installation.py', 'preview_connections.py', 'preview_connection_watch.py'):
        digest.update((Path(__file__).parent / name).read_bytes())
    return digest.hexdigest()


def _norm(value):
    return os.path.abspath(str(value).removeprefix('\\\\?\\')).replace('\\', '/').casefold()


def startup_contents(root, *, version_root=None):
    # VBS runs Python without a console/focus change; no shell interpolation.
    if version_root is None:
        python,script=sys.executable,str(Path(__file__).resolve())
    else:
        version=Path(version_root).resolve();python=str(version/'runtime/python/python.exe');script=str(version/'scripts/preview_connection_watch.py')
        if (installation.local(version)!=installation.local(root) or not Path(python).is_file() or not Path(script).is_file()):
            raise PreviewError('preview_startup_target_unavailable')
    argv = [python, '-B', script, '--root', str(Path(version_root or root).resolve())]
    command = subprocess.list2cmdline(argv).replace('"', '""')
    return 'CreateObject("WScript.Shell").Run "' + command + '", 0, False\r\n'


def startup_rebind_plan(root, manifest):
    """Bind an already registered startup update into the existing rebind journal."""
    receipt_path=installation.private_home(root)/'startup.json'
    if not receipt_path.exists():return None
    prior=read_json(receipt_path);path=Path(prior.get('path',''))
    appdata=os.environ.get('APPDATA')
    expected=Path(appdata or '')/'Microsoft/Windows/Start Menu/Programs/Startup'/('CLW-Preview-'+manifest['installation_id']+'.vbs')
    if (not appdata or path!=expected or path.is_symlink() or not path.is_file()
            or prior.get('installation_id')!=manifest['installation_id']
            or prior.get('sha256')!=hashlib.sha256(path.read_bytes()).hexdigest()):
        raise PreviewError('preview_startup_owner_changed')
    enabled=manifest.get('auto_connect',True) and any(installation.credential_path(root,item['id']).is_file() for item in manifest['accounts'])
    content=startup_contents(root,version_root=root) if enabled else "' CLW preview automatic connection disabled.\r\n"
    encoded=b'\xff\xfe'+content.encode('utf-16-le')
    return {'installation_id':manifest['installation_id'],'path':str(path),'version_root':str(Path(root).resolve()),
            'previous_sha256':prior['sha256'],'target_sha256':hashlib.sha256(encoded).hexdigest()}


def configure_startup(root, manifest, *, rebind=None):
    """Own one installation-specific startup file, never the personal AB entry."""
    if os.name != 'nt':
        return {'enabled': False, 'reason': 'preview_windows_startup_required'}
    home = installation.private_home(root)
    receipt_path = home / 'startup.json'
    enabled = manifest.get('auto_connect', True)
    configured = any(installation.credential_path(root, item['id']).is_file() for item in manifest['accounts'])
    if not configured and not receipt_path.exists():
        return {'enabled': False, 'reason': 'credentials_required'}
    appdata = os.environ.get('APPDATA')
    if not appdata:
        raise PreviewError('preview_startup_directory_unavailable')
    startup = Path(appdata) / 'Microsoft/Windows/Start Menu/Programs/Startup'
    if not startup.is_dir():
        raise PreviewError('preview_startup_directory_unavailable')
    path = startup / ('CLW-Preview-' + manifest['installation_id'] + '.vbs')
    if enabled and configured:
        content=startup_contents(root,version_root=rebind['version_root']) if rebind is not None else startup_contents(root)
    else:content="' CLW preview automatic connection disabled.\r\n"
    encoded = b'\xff\xfe' + content.encode('utf-16-le')
    if rebind is not None:
        pending=read_json(installation.local(root)/'preview-runtime-rebind.json')
        if (pending.get('state')!='prepared' or pending.get('installation_id')!=manifest['installation_id']
                or pending.get('binaries')!=manifest['binaries'] or pending.get('startup')!=rebind
                or rebind.get('installation_id')!=manifest['installation_id'] or rebind.get('path')!=str(path)
                or rebind.get('target_sha256')!=hashlib.sha256(encoded).hexdigest()):
            raise PreviewError('preview_startup_rebind_identity_changed')
    if rebind is not None and not path.exists():raise PreviewError('preview_startup_owner_changed')
    if path.exists():
        prior = read_json(receipt_path) if receipt_path.exists() else {}
        if path.is_symlink():raise PreviewError('preview_startup_owner_changed')
        actual=hashlib.sha256(path.read_bytes()).hexdigest()
        continued=(rebind is not None and actual==rebind['target_sha256']
                   and prior.get('path')==str(path) and prior.get('sha256') in (rebind['previous_sha256'],rebind['target_sha256']))
        if (path.is_symlink() or prior.get('installation_id') != manifest['installation_id']
                or (rebind is not None and prior.get('sha256') not in (rebind['previous_sha256'],rebind['target_sha256']))
                or (prior.get('sha256') != actual and not continued)):
            raise PreviewError('preview_startup_owner_changed')
    # WSH reliably reads UTF-16LE with BOM, including Chinese installation
    # paths. UTF-8 without BOM would be interpreted using the machine ANSI page.
    if not path.exists() or path.read_bytes() != encoded:
        temporary = path.with_suffix('.vbs.' + manifest['installation_id'] + '.tmp')
        if temporary.exists() or temporary.is_symlink():
            raise PreviewError('preview_startup_update_pending')
        try:
            with temporary.open('xb') as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()
    atomic_json(receipt_path, {'installation_id': manifest['installation_id'], 'path': str(path),
        'sha256': hashlib.sha256(encoded).hexdigest(), 'enabled': enabled and configured})
    return {'enabled': enabled and configured}


def ensure_started(root, manifest):
    if not manifest.get('auto_connect', True) or not any(
            installation.credential_path(root, item['id']).is_file() for item in manifest['accounts']):
        return {'state': 'disabled'}
    folder = installation.local(root) / 'preview-watch'
    folder.mkdir(parents=True, exist_ok=True)
    expected_script = _norm(Path(__file__).resolve())
    expected_root = _norm(Path(root).resolve())
    prior = read_json(folder / 'owner.json') if (folder / 'owner.json').exists() else {}
    def candidate(row):
        args = command_argv(row['CommandLine'])
        if '--start' in args or '--once' in args:
            return False
        roots = [args[i + 1] for i, value in enumerate(args[:-1]) if value == '--root']
        if len(roots) != 1:
            return False
        exact_current = (expected_script in [_norm(arg) for arg in args[1:]] and _norm(roots[0]) == expected_root)
        if exact_current:
            return True
        # A selected new version may reuse the exact old watch for this same
        # stable data home. Only the already recorded PID is considered, so
        # unrelated Python tasks/installations never become candidates.
        return (row['ProcessId'] == prior.get('pid') and prior.get('installation_id') == manifest['installation_id']
                and isinstance(prior.get('script'), str) and _norm(prior['script']) in [_norm(arg) for arg in args[1:]]
                and _norm(roots[0]) == _norm(prior.get('root', ''))
                and _norm(prior.get('data_home', '')) == _norm(installation.local(root))
                and _norm(installation.local(Path(roots[0]))) == _norm(installation.local(root)))
    rows = process_inventory(target_names=frozenset(('python.exe', 'pythonw.exe')), candidate_filter=candidate)
    matches = [row for row in rows if row.get('ExecutablePath') and candidate(row)]
    if matches:
        if (len(matches) != 1 or prior.get('pid') != matches[0]['ProcessId'] or
                prior.get('creation_filetime') != matches[0]['CreationFiletime'] or
                _norm(prior.get('executable', '')) != _norm(matches[0]['ExecutablePath'])):
            raise PreviewError('preview_watch_owner_unverified')
        return {'state': 'running', 'pid': prior['pid']}
    # Startup uses this same lease; no duplicate is accepted while one is
    # entering main(). There is no PID-based stop/restart fallback.
    with FileLease(folder / 'start.lock'):
        child = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()), '--root', str(Path(root).resolve())],
            cwd=str(Path(root).resolve()), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=installation.environment(manifest), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        for _ in range(20):
            if (folder / 'owner.json').exists():
                owner = read_json(folder / 'owner.json')
                if owner.get('pid') == child.pid:
                    return {'state': 'running', 'pid': child.pid}
            if child.poll() is not None:
                raise PreviewError('preview_watch_exited')
            time.sleep(.1)
    raise PreviewError('preview_watch_launch_unknown')


class PreviewWatch:
    def __init__(self, root, *, inspect=None, recover=None, now=time.monotonic, signature=None, network_ready=None):
        from preview_connections import check, connect
        self.root = root
        self.inspect = inspect or check
        self.recover = recover or connect
        self.now = now
        self.signature = signature or source_signature()
        self.attempts = 0
        self.next_attempt = 0
        self.completion_unknown = False
        self.network_ready = network_ready or proxy_ready

    def tick(self):
        manifest = installation.load(self.root)
        if not manifest.get('auto_connect', True):
            return {'state': 'disabled', 'healthy': False}
        try:
            if not self.network_ready(manifest):
                return {'state': 'waiting_proxy', 'healthy': False, 'reason': 'configured_proxy_unavailable',
                        'attempts': self.attempts}
            health = self.inspect(self.root)
            if health.get('healthy') is True:
                self.attempts = 0
                self.next_attempt = 0
                return {**health, 'attempts': 0}
            # This is the original watch's key rule: keep a live unready owner.
            components = health.get('components', {})
            accounts = health.get('accounts', [])
            configured = [item for item in accounts if item.get('has_key') is True]
            if not configured:
                return {**health, 'reason': 'credentials_required', 'attempts': self.attempts}
            missing = ('absent' in components.values() or any(item.get('state') == 'absent' for item in configured))
            if any(state not in ('ready', 'absent', 'external', 'connection_wait') for state in components.values()) or not missing:
                return {**health, 'reason': 'live_owner_or_credentials_wait', 'attempts': self.attempts}
            if self.completion_unknown:
                return {**health, 'reason': 'original_preview_connect_completion_unknown', 'attempts': self.attempts}
            if source_signature() != self.signature:
                return {**health, 'reason': 'source_changed_restart_watch_after_verification', 'attempts': self.attempts}
            if self.attempts >= len(DELAYS):
                return {**health, 'reason': 'recovery_retry_limit', 'attempts': self.attempts}
            if self.now() < self.next_attempt:
                return {**health, 'state': 'recovery_backoff', 'attempts': self.attempts}
            pending = installation.local(self.root) / 'preview-launch.json'
            if pending.exists() and read_json(pending).get('completion_unknown') is True:
                self.completion_unknown = True
                return {**health, 'reason': 'original_preview_launch_completion_unknown', 'attempts': self.attempts}
            self.attempts += 1
            self.next_attempt = self.now() + DELAYS[self.attempts - 1]
            result = self.recover(self.root)
            return {**result, 'attempts': self.attempts}
        except PreviewError as error:
            code = str(error)
            if code.endswith('completion_unknown'):
                self.completion_unknown = True
            return {'state': 'needs_attention', 'healthy': False, 'reason': code, 'attempts': self.attempts}
        except (OSError, ValueError, RuntimeError, KeyError, TypeError):
            return {'state': 'needs_attention', 'healthy': False,
                    'reason': 'preview_observation_unavailable', 'attempts': self.attempts}


def proxy_ready(manifest):
    if manifest['network']['mode'] != 'proxy':
        return True
    proxy = urlsplit(manifest['network']['proxy_url'])
    try:
        with socket.create_connection((proxy.hostname, proxy.port or (443 if proxy.scheme == 'https' else 80)), timeout=1):
            return True
    except OSError:
        return False


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--start', action='store_true', help='Start/reuse only the lightweight independent watch, then return')
    args = parser.parse_args(argv)
    root = args.root.resolve()
    folder = installation.local(root) / 'preview-watch'
    folder.mkdir(parents=True, exist_ok=True)
    try:
        if args.start:
            manifest = installation.load(root)
            result = {'startup': configure_startup(root, manifest), 'watch': ensure_started(root, manifest)}
            print(json.dumps({'ok': True, 'result': result}))
            return 0
        with FileLease(folder / 'watch.lock'):
            rows = process_inventory(target_names=frozenset(('python.exe', 'pythonw.exe')),
                                     candidate_filter=lambda row: row['ProcessId'] == os.getpid())
            own = [row for row in rows if row['ProcessId'] == os.getpid() and row.get('ExecutablePath')]
            if len(own) != 1:
                raise PreviewError('preview_watch_owner_unverified')
            atomic_json(folder / 'owner.json', {'pid': os.getpid(), 'creation_filetime': own[0]['CreationFiletime'],
                'executable': own[0]['ExecutablePath'], 'source_sha256': source_signature(),
                'installation_id': installation.load(root)['installation_id'], 'root': str(root),
                'data_home': str(installation.local(root)), 'script': str(Path(__file__).resolve())})
            watcher = PreviewWatch(root)
            previous = None
            while True:
                result = {**watcher.tick(), 'at': utc()}
                previous = record(folder, result, previous)
                if args.once or result['state'] == 'disabled':
                    return 0
                time.sleep(30)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError):
        if args.start:
            print(json.dumps({'ok': False, 'code': 'preview_watch_unavailable'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
