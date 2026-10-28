"""Local, fixed-commit application releases. Never updates WebCodex or any Tunnel.
Stable selects a verified code bundle, candidate/development always use separate data.
There is no automatic checkout, reset, migration, process kill, or model invocation.
"""
from __future__ import annotations
import argparse
from contextlib import closing
from io import BytesIO
import json
import os
import re
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import uuid
import webbrowser
from product_runtime import (PRODUCT, DATA_EPOCH, MANIFEST, COMMIT, REQUIRED, MAX_FILES, MAX_FILE, MAX_TOTAL,
    ProductError, FileLease, StateLease, atomic_json, read_json, json_bytes, digest, payload_path,
    hash_payload, verify_release, utc)

ROOT = Path(__file__).resolve().parents[1]
STORES = {
    'tasks.sqlite3': (0x434C5754, 'schema_version'),
    'accounts.sqlite3': (0x434C5741, 'schema'),
    'usage.sqlite3': (0x434C5755, 'schema'),
    'assets.sqlite3': (0x434C574D, 'schema'),
}


def git(repo, *args):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS='0')
    p = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, env=env, timeout=30)
    if p.returncode:
        raise ProductError('git_read_failed')
    return p.stdout


def resolve_commit(repo, value):
    # A name is user input, never concatenated into a shell command.
    if not isinstance(value, str) or not value or len(value) > 160 or value.startswith('-') or any(ord(c) < 33 for c in value):
        raise ProductError('invalid_revision')
    commit = git(repo, 'rev-parse', '--verify', value + '^{commit}').decode('ascii').strip()
    if not COMMIT.fullmatch(commit):
        raise ProductError('invalid_resolved_commit')
    return commit


def port_busy(port):
    if not 0 < port <= 65535:
        raise ProductError('invalid_port')
    with socket.socket() as s:
        s.settimeout(.4)
        return s.connect_ex(('127.0.0.1', port)) == 0


def unpack_payload(archive):
    if len(archive) > MAX_TOTAL + 2 * 1024 * 1024:
        raise ProductError('archive_too_large')
    files = {}; total = 0
    with tarfile.open(fileobj=BytesIO(archive), mode='r:') as tf:
        for member in tf:
            if member.isdir():
                continue
            if not payload_path(member.name):
                continue
            if not member.isfile() or member.name in files or member.size > MAX_FILE or member.size < 0:
                raise ProductError('invalid_archive_member')
            total += member.size
            if total > MAX_TOTAL or len(files) >= MAX_FILES:
                raise ProductError('archive_payload_too_large')
            with tf.extractfile(member) as f:
                data = f.read(MAX_FILE + 1)
            if len(data) != member.size:
                raise ProductError('incomplete_archive_member')
            files[member.name] = data
    if not REQUIRED.issubset(files):
        raise ProductError('revision_has_no_fixed_runtime_support')
    return files


class Releases:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.directory = self.root / '.local/workbench-releases'
        self.payloads = self.directory / 'payloads'
        self.pointer = self.directory / 'stable.json'
        self.state = self.root / '.local/control-center'

    def prepare(self, revision='HEAD'):
        commit = resolve_commit(self.root, revision)
        # Only committed application paths. No .local, credentials, databases, logs or tests.
        archive = git(self.root, 'archive', '--format=tar', commit, '--', 'package.json', 'scripts', 'apps/control-center', 'config')
        files = unpack_payload(archive)
        try:
            package = json.loads(files['package.json'])
            version = package['version']
            if type(package.get('clw_data_epoch')) is not int or package['clw_data_epoch'] != DATA_EPOCH:
                raise ProductError('target_data_epoch_not_supported')
        except (ValueError, KeyError, TypeError):
            raise ProductError('invalid_release_package') from None
        hashes = hash_payload(files)
        manifest = {'schema_version': 1, 'product': PRODUCT, 'source_commit': commit,
                    'version': version, 'data_epoch': DATA_EPOCH, 'files': hashes,
                    'payload_sha256': digest(json_bytes(hashes))}
        self.payloads.mkdir(parents=True, exist_ok=True)
        with FileLease(self.directory / '.release.lock'):
            target = self.payloads / commit
            if target.exists():
                if verify_release(target) != manifest:
                    raise ProductError('existing_release_differs_not_overwritten')
                return manifest
            pending = self.payloads / ('preparing-' + uuid.uuid4().hex)
            pending.mkdir()
            try:
                for name, data in files.items():
                    path = pending / name; path.parent.mkdir(parents=True, exist_ok=True)
                    with path.open('xb') as f:
                        f.write(data)
                atomic_json(pending / MANIFEST, manifest)
                verify_release(pending)
                os.replace(pending, target)
            finally:
                if pending.exists():
                    shutil.rmtree(pending)  # Only our exact incomplete creation.
        return manifest

    def release(self, commit):
        if not isinstance(commit, str) or not COMMIT.fullmatch(commit):
            raise ProductError('exact_prepared_commit_required')
        target = self.payloads / commit
        if target.is_symlink() or (hasattr(target, 'is_junction') and target.is_junction()):
            raise ProductError('release_directory_link')
        manifest = verify_release(target)
        if manifest['source_commit'] != commit:
            raise ProductError('release_directory_identity_mismatch')
        return target, manifest

    def selected(self):
        if not self.pointer.exists():
            return None
        raw = read_json(self.pointer, 8192)
        keys = {'schema_version', 'product', 'commit', 'previous', 'payload_sha256', 'state_id', 'selected_at', 'backup', 'selection_id'}
        if not isinstance(raw, dict) or set(raw) != keys or type(raw['schema_version']) is not int or raw['schema_version'] != 1 or raw['product'] != PRODUCT:
            raise ProductError('invalid_selection_pointer')
        target, manifest = self.release(raw['commit'])
        if raw['payload_sha256'] != manifest['payload_sha256'] or not isinstance(raw['state_id'], str) or not re.fullmatch(r'[a-f0-9]{32}', raw['state_id']):
            raise ProductError('selection_identity_mismatch')
        return raw

    def listing(self):
        rows = []
        if self.payloads.exists():
            for path in sorted(self.payloads.iterdir()):
                if not COMMIT.fullmatch(path.name):
                    continue
                try:
                    _, manifest = self.release(path.name)
                    rows.append({'commit': path.name, 'version': manifest['version'], 'verified': True})
                except (OSError, ValueError):
                    rows.append({'commit': path.name, 'verified': False})
        current = self.selected()
        return {'product': PRODUCT, 'current': current, 'releases': rows, 'running_version': 'query /api/product/info; not inferred from selection'}

    def _backup(self, state_id, task_schema_max=1):
        # Caller holds state lease. Back up only identified product databases, never credentials.
        # Refuse an unrecognized database layout instead of silently taking a
        # partial backup. Inspect filenames only; do not open unrelated files.
        for path in self.state.iterdir():
            if path.suffix.lower() in ('.db', '.sqlite', '.sqlite3') and path.name not in STORES:
                raise ProductError('unrecognized_database_layout_no_switch')
        checked = []
        for name, (app, schema_key) in STORES.items():
            path = self.state / name
            if not path.exists():
                continue
            if path.is_symlink():
                raise ProductError('state_database_link')
            try:
                with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=3)) as db:
                    if db.execute('PRAGMA application_id').fetchone()[0] != app:
                        raise ProductError('foreign_state_database')
                    row = db.execute('SELECT value FROM metadata WHERE key=?', (schema_key,)).fetchone()
                    accepted = {str(v) for v in range(1,task_schema_max+1)} if name == 'tasks.sqlite3' else {'1'}
                    if not row or row[0] not in accepted:
                        raise ProductError('incompatible_database_no_migration')
                    checked.append(name)
            except sqlite3.Error:
                raise ProductError('state_database_unreadable') from None
        destination = self.directory / 'backups' / uuid.uuid4().hex
        destination.mkdir(parents=True)
        report = {'schema_version': 1, 'state_id': state_id, 'at': utc(), 'files': {}, 'config_or_credentials_copied': False}
        for name in checked:
            path, out = self.state / name, destination / name
            with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=3)) as db, closing(sqlite3.connect(out)) as backup:
                db.backup(backup)
                if backup.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise ProductError('backup_check_failed')
            report['files'][name] = {'sha256': digest(out.read_bytes()), 'bytes': out.stat().st_size}
        atomic_json(destination / 'backup.json', report)
        return destination.relative_to(self.directory).as_posix()

    def select(self, commit, expected_current, port=18940):
        """Offline CAS switch. A switch never starts/stops services or replaces live data."""
        self.directory.mkdir(parents=True, exist_ok=True)
        with FileLease(self.directory / '.release.lock'):
            code, manifest = self.release(commit)
            task_schema_max = read_json(code / 'package.json').get('clw_task_schema_max',1)
            if type(task_schema_max) is not int or task_schema_max not in (1,2,3,4):
                raise ProductError('invalid_target_task_schema')
            current = self.selected()
            actual = current['commit'] if current else None
            if actual == commit:
                return current  # Desired state already persisted; no second backup.
            if actual != expected_current:
                raise ProductError('selection_changed_reobserve')
            # Legacy processes have no state lease: occupied stable port is an additional fence.
            if port_busy(port):
                raise ProductError('stop_only_current_control_center_first')
            with StateLease(self.state, expected_identity=current['state_id'] if current else None) as owner:
                if current and owner.identity != current['state_id']:
                    raise ProductError('state_replaced_relink_explicitly')
                backup = self._backup(owner.identity,task_schema_max)
                value = {'schema_version': 1, 'product': PRODUCT, 'commit': commit, 'previous': actual,
                         'payload_sha256': manifest['payload_sha256'], 'state_id': owner.identity,
                         'selected_at': utc(), 'backup': backup, 'selection_id': uuid.uuid4().hex}
                atomic_json(self.pointer, value)
                return value

    def rollback(self, port=18940):
        current = self.selected()
        if not current or not current['previous']:
            raise ProductError('no_previous_fixed_release')
        return self.select(current['previous'], current['commit'], port)

    def launch_args(self, mode, revision=None, port=None):
        """Produces native argv, no shell and no account-dependent model routing."""
        if mode == 'stable':
            current = self.selected()
            if current is None:
                raise ProductError('prepare_and_select_a_release_first')
            code, _ = self.release(current['commit']); state = self.state
            saved = read_json(state / '_clw_state.json', 4096)
            if saved.get('state_id') != current['state_id']:
                raise ProductError('state_replaced_relink_explicitly')
            chosen_port = 18940 if port is None else port
        elif mode == 'candidate':
            code, _ = self.release(revision)
            state = self.directory / 'candidates' / revision / 'state'
            chosen_port = 18942 if port is None else port
        elif mode == 'development':
            code = self.root; state = self.root / '.local/development-control-center'
            chosen_port = 18941 if port is None else port
        else:
            raise ProductError('unknown_channel')
        if type(chosen_port) is not int or not 0 <= chosen_port <= 65535:
            raise ProductError('invalid_port')
        if mode != 'stable' and state.resolve() == self.state.resolve():
            raise ProductError('candidate_may_not_use_stable_data')
        command = [sys.executable, '-B', str(code / 'scripts/serve_control_center.py'), '--channel', mode,
                   '--state-dir', str(state), '--port', str(chosen_port)]
        if mode == 'stable':
            # The child must check this after acquiring the actual data lease.
            command.extend(['--expected-state-id', current['state_id']])
        return command


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare'); p.add_argument('--ref', default='HEAD')
    sub.add_parser('list')
    p = sub.add_parser('select'); p.add_argument('commit'); p.add_argument('--expected-current', default='none'); p.add_argument('--port', type=int, default=18940)
    p = sub.add_parser('rollback'); p.add_argument('--port', type=int, default=18940)
    p = sub.add_parser('start'); p.add_argument('--mode', choices=['stable','candidate','development'], default='stable'); p.add_argument('--commit'); p.add_argument('--port', type=int); p.add_argument('--bootstrap', action='store_true'); p.add_argument('--open', action='store_true'); p.add_argument('--choose-runner-config', action='store_true'); p.add_argument('--connect', action='store_true')
    p.add_argument('--enable-workflow-routing',action='store_true',help='Explicit local interactive notification opt-in; no implicit model dispatch')
    sub.add_parser('manage')
    args = parser.parse_args(); releases = Releases(args.root)
    try:
        if args.command == 'prepare':
            manifest = releases.prepare(args.ref)
            print(json.dumps({'prepared': manifest['source_commit'], 'version': manifest['version'], 'selected': False, 'payload_sha256': manifest['payload_sha256']})); return 0
        if args.command == 'list':
            print(json.dumps(releases.listing(), ensure_ascii=True, indent=2)); return 0
        if args.command == 'select':
            print(json.dumps(releases.select(args.commit, None if args.expected_current == 'none' else args.expected_current, args.port))); return 0
        if args.command == 'rollback':
            print(json.dumps(releases.rollback(args.port))); return 0
        if args.command == 'manage':
            if not sys.stdin.isatty():
                raise ProductError('interactive_local_selection_required')
            print('Control Center only. Stop its terminal first; do NOT stop WebCodex or either Tunnel.')
            print('P = prepare current committed version; R = switch to previous fixed version; Enter = inspect only')
            choice = input('Operation: ').strip().upper()
            if choice == 'P':
                manifest = releases.prepare()
                print('Prepared:', manifest['source_commit'])
                if input('Select this for NEXT start? Type SELECT: ').strip() == 'SELECT':
                    current = releases.selected()
                    releases.select(manifest['source_commit'], current['commit'] if current else None)
            elif choice == 'R':
                if input('Switch CODE only; preserve current data. Type ROLLBACK: ').strip() == 'ROLLBACK':
                    releases.rollback()
            print(json.dumps(releases.listing(), ensure_ascii=True, indent=2)); return 0
        port = args.port if args.port is not None else {'stable':18940,'candidate':18942,'development':18941}[args.mode]
        if port and port_busy(port):
            raise ProductError('port_occupied_no_existing_service_stopped')
        if args.bootstrap and args.mode == 'stable' and releases.selected() is None:
            if git(releases.root, 'status', '--porcelain=v1').strip():
                raise ProductError('first_bootstrap_requires_clean_committed_source')
            manifest = releases.prepare()
            releases.select(manifest['source_commit'], None, port)
        cmd = releases.launch_args(args.mode, args.commit, args.port)
        if args.choose_runner_config:cmd.append('--choose-runner-config')
        if args.connect:cmd.append('--connect')
        if args.enable_workflow_routing:cmd.append('--enable-workflow-routing')
        if args.open:
            cmd.append('--open')
        print('Starting fixed application' if args.mode != 'development' else 'Starting isolated development application', flush=True)
        return subprocess.call(cmd, cwd=str(releases.root))
    except KeyboardInterrupt:
        return 130
    except (ProductError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        code = str(exc) if isinstance(exc, ProductError) else type(exc).__name__
        print('CLW release action stopped:', code, file=sys.stderr)
        print('No WebCodex/Runner/Tunnel was stopped. Check current application terminal and inspect releases.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
