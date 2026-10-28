"""Application identity, verified code snapshots and exclusive product-data ownership.
No Runner control, model dispatch, project-specific scheduler or credential discovery.
"""
from __future__ import annotations
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import subprocess
import threading
import time
import uuid

PRODUCT = 'clw-control-center'
DATA_EPOCH = 1  # Compatibility fence, not a database migration implementation.
MANIFEST = '_clw_release.json'
MAX_FILE = 2 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_FILES = 512
SHA = re.compile(r'[0-9a-f]{64}\Z')
COMMIT = re.compile(r'[0-9a-f]{40}\Z')
REQUIRED = {'package.json', 'scripts/serve_control_center.py', 'scripts/product_runtime.py', 'scripts/workbench_release.py', 'apps/control-center/index.html'}


class ProductError(ValueError):
    """Only bounded static error codes are returned to a browser."""


def utc():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def digest(data: bytes):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')


def atomic_json(path: Path, value):
    path = Path(path)
    if path.is_symlink():
        raise ProductError('link_not_allowed')
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('xb') as f:
            f.write(json_bytes(value)); f.flush(); os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_json(path: Path, maximum=MAX_FILE):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise ProductError('invalid_metadata_file')
    with path.open('rb') as f:
        data = f.read(maximum + 1)
    if len(data) > maximum:
        raise ProductError('metadata_too_large')
    try:
        return json.loads(data)
    except (ValueError, UnicodeError, RecursionError):
        raise ProductError('invalid_metadata_json') from None


def payload_path(name):
    if not isinstance(name, str) or len(name) > 240 or '\\' in name or ':' in name:
        return False
    parts = name.split('/')
    if any(p in ('', '.', '..') or not re.fullmatch(r'[A-Za-z0-9_.-]+', p) for p in parts):
        return False
    if name in ('package.json', 'config/pilots.json'):
        return True
    p = PurePosixPath(name)
    if len(parts) == 2 and parts[0] == 'scripts' and p.suffix == '.py':
        return not parts[1].startswith(('verify_', 'test_'))
    return name.startswith('apps/control-center/') and p.suffix in ('.mjs', '.html', '.css', '.json')


def plain_file(root: Path, name: str):
    if not payload_path(name):
        raise ProductError('unexpected_payload_path')
    current = root
    for part in name.split('/'):
        current = current / part
        if current.is_symlink() or (hasattr(current, 'is_junction') and current.is_junction()):
            raise ProductError('payload_link_not_allowed')
    if not current.is_file() or not current.resolve().is_relative_to(root.resolve()):
        raise ProductError('payload_file_missing')
    return current


def snapshot_payload(root: Path):
    root = Path(root).resolve()
    paths = ['package.json']
    for folder in ('apps/control-center', 'scripts', 'config'):
        base = root / folder
        if not base.exists():
            continue
        for d, dirs, files in os.walk(base, followlinks=False):
            dirs[:] = [x for x in dirs if x not in ('__pycache__', 'node_modules', '.git')]
            for name in files:
                relative = (Path(d) / name).relative_to(root).as_posix()
                if payload_path(relative):
                    paths.append(relative)
    if len(paths) > MAX_FILES:
        raise ProductError('too_many_payload_files')
    result = {}; total = 0
    for name in sorted(set(paths)):
        path = plain_file(root, name)
        if path.stat().st_size > MAX_FILE:
            raise ProductError('payload_file_too_large')
        with path.open('rb') as f:
            value = f.read(MAX_FILE + 1)
        total += len(value)
        if len(value) > MAX_FILE or total > MAX_TOTAL:
            raise ProductError('payload_too_large')
        result[name] = value
    return result


def hash_payload(files):
    return {name: digest(value) for name, value in sorted(files.items())}


def validate_manifest(raw, files):
    if not isinstance(raw, dict) or set(raw) != {'schema_version', 'product', 'source_commit', 'version', 'data_epoch', 'files', 'payload_sha256'}:
        raise ProductError('invalid_release_manifest')
    if type(raw['schema_version']) is not int or raw['schema_version'] != 1 or raw['product'] != PRODUCT:
        raise ProductError('incompatible_release')
    if not isinstance(raw['source_commit'], str) or not COMMIT.fullmatch(raw['source_commit']):
        raise ProductError('invalid_release_commit')
    if type(raw['data_epoch']) is not int or raw['data_epoch'] != DATA_EPOCH:
        raise ProductError('incompatible_data_epoch')
    hashes = hash_payload(files)
    if not REQUIRED.issubset(hashes) or raw['files'] != hashes or raw['payload_sha256'] != digest(json_bytes(hashes)):
        raise ProductError('release_hash_mismatch')
    try:
        package = json.loads(files['package.json'])
        if package['name'] != PRODUCT or package['version'] != raw['version'] or type(package.get('clw_data_epoch')) is not int or package['clw_data_epoch'] != raw['data_epoch']:
            raise ProductError('release_version_mismatch')
    except (ValueError, KeyError, TypeError):
        raise ProductError('invalid_package') from None
    return raw


def verify_release(root):
    root = Path(root)
    files = snapshot_payload(root)
    seen = set()
    for folder, dirs, names in os.walk(root, followlinks=False):
        for d in dirs:
            p = Path(folder) / d
            if p.is_symlink() or (hasattr(p, 'is_junction') and p.is_junction()):
                raise ProductError('release_directory_link')
        for name in names:
            p = Path(folder) / name
            if p.is_symlink():raise ProductError('release_file_link')
            seen.add(p.relative_to(root).as_posix())
            if len(seen) > MAX_FILES + 1:raise ProductError('unexpected_release_files')
    if seen != set(files) | {MANIFEST}:raise ProductError('unexpected_release_files')
    return validate_manifest(read_json(root / MANIFEST), files)


class FileLease:
    """Kernel-held lock: an old PID file or elapsed time never releases ownership."""
    def __init__(self, path):
        self.path = Path(path); self.file = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.is_symlink():
            raise ProductError('lease_link_not_allowed')
        f = self.path.open('a+b')
        try:
            if f.seek(0, 2) == 0:
                f.write(b'0'); f.flush()
            f.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            f.close(); raise ProductError('data_in_use_no_process_stopped') from None
        self.file = f
        return self

    def __exit__(self, *args):
        if self.file:
            try:
                self.file.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
            finally:
                self.file.close(); self.file = None


class StateLease(FileLease):
    def __init__(self, directory, expected_identity=None):
        if expected_identity is not None and (not isinstance(expected_identity, str) or not re.fullmatch(r'[0-9a-f]{32}', expected_identity)):
            raise ProductError('invalid_expected_state_identity')
        self.directory = Path(directory).resolve(); self.identity = None
        self.expected_identity = expected_identity
        super().__init__(self.directory / '.instance.lock')

    def __enter__(self):
        super().__enter__()
        try:
            path = self.directory / '_clw_state.json'
            if not path.exists():
                if self.expected_identity is not None:
                    raise ProductError('state_replaced_relink_explicitly')
                atomic_json(path, {'schema_version': 1, 'product': PRODUCT, 'data_epoch': DATA_EPOCH, 'state_id': uuid.uuid4().hex})
            raw = read_json(path, 4096)
            if not isinstance(raw, dict) or type(raw.get('schema_version')) is not int or raw.get('schema_version') != 1 or raw.get('product') != PRODUCT or type(raw.get('data_epoch')) is not int or raw['data_epoch'] != DATA_EPOCH or not re.fullmatch(r'[0-9a-f]{32}', str(raw.get('state_id', ''))):
                raise ProductError('incompatible_state_no_migration')
            if self.expected_identity is not None and raw['state_id'] != self.expected_identity:
                raise ProductError('state_replaced_relink_explicitly')
            self.identity = raw['state_id']
            return self
        except BaseException:
            super().__exit__(None, None, None); raise


class RuntimeIdentity:
    """Reports startup identity, not today's Git HEAD pretending to be loaded code."""
    def __init__(self, root, channel='development', state_id=None):
        if channel not in ('development', 'candidate', 'stable', 'test'):
            raise ProductError('invalid_channel')
        self.root = Path(root).resolve(); self.files = snapshot_payload(self.root)
        manifest = None
        if (self.root / MANIFEST).exists():
            manifest = verify_release(self.root)
            validate_manifest(manifest, self.files)  # Reject a change between the two startup observations.
        if channel in ('stable', 'candidate') and manifest is None:
            raise ProductError('fixed_channel_requires_release')
        package = json.loads(self.files['package.json'])
        if package.get('name') != PRODUCT or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?', str(package.get('version', ''))):
            raise ProductError('invalid_product_package')
        commit = manifest['source_commit'] if manifest else None
        if not manifest:
            try:
                p = subprocess.run(['git', '-C', str(self.root), 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=3)
                if p.returncode == 0 and COMMIT.fullmatch(p.stdout.strip()):
                    commit = p.stdout.strip()
            except (OSError, subprocess.TimeoutExpired):
                pass
        self.hashes = hash_payload(self.files)
        self.base = {'schema_version': 1, 'product': PRODUCT, 'version': package['version'], 'channel': channel,
                     'source_commit': commit, 'payload_sha256': digest(json_bytes(self.hashes)),
                     'fixed_release': manifest is not None, 'commit_describes_payload': manifest is not None,
                     'verified_at_start': manifest is not None, 'validation': 'not_inferred_from_manifest',
                     'instance_id': uuid.uuid4().hex, 'pid': os.getpid(), 'started_at': utc(),
                     'state_id': state_id, 'data_epoch': DATA_EPOCH, 'python_version': platform.python_version(),
                     'automatic_restart': False, 'automatic_model_calls': False, 'static_assets': 'startup_snapshot'}
        self._lock = threading.Lock(); self._until = 0; self._disk = None

    def info(self):
        with self._lock:
            if time.monotonic() >= self._until:
                try:
                    current = hash_payload(snapshot_payload(self.root))
                    equal = current == self.hashes
                    self._disk = {'disk_status': 'unchanged' if equal else 'changed', 'restart_required': not equal}
                except (OSError, ValueError):
                    self._disk = {'disk_status': 'unavailable', 'restart_required': True}
                self._until = time.monotonic() + 3
            return {**deepcopy(self.base), **self._disk, 'observed_at': utc()}
