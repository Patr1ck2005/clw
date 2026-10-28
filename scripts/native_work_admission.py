"""Cooperative write-domain admission for background Codex + Web packages.

Only this launcher's PromptFile packages participate. This journal does not
restrict Codex's full filesystem access or certify a package's business result.
Unknown claims remain held; a process death or timeout never releases one.
"""
from __future__ import annotations

import argparse
from contextlib import closing, contextmanager
import ctypes
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
import uuid

# CLI execution must share its exception and transaction helpers with the
# interruption module, which imports this module by its canonical name.
if __name__ == '__main__':
    sys.modules['native_work_admission'] = sys.modules[__name__]


ACTIVE_THREADS = ('working', 'stopping', 'unknown', 'processing', 'web_waiting', 'web_processing')
HELD = ('queued', 'reserved', 'running', 'terminal_pending', 'unknown')
TERMINAL = ('turn_completed', 'needs_attention')
REQUIRED_TABLES = ('threads', 'operations', 'control_attempts', 'host_requests',
                   'host_team_scopes', 'host_team_leases', 'host_team_git_scopes')
UNKNOWN_GIT = '<unrecorded-pure-web-git>'


class AdmissionError(RuntimeError):
    pass


def _require(test, code):
    if not test:
        raise AdmissionError(code)


def _canonical(path):
    return os.path.normcase(os.path.normpath(str(path)))


def _plain_existing_directory(raw):
    path = Path(raw)
    _require(path.is_absolute() and path.is_dir(), 'workspace_directory_required')
    for part in (path, *path.parents):
        _require(not part.is_symlink() and not (getattr(part.lstat(), 'st_file_attributes', 0) & 0x400),
                 'linked_workspace_path_requires_review')
    return _canonical(path.resolve())


def _result_path(raw):
    path = Path(raw)
    _require(path.is_absolute(), 'absolute_result_directory_required')
    for part in (path, *path.parents):
        if part.exists():
            _require(not part.is_symlink() and not (getattr(part.lstat(), 'st_file_attributes', 0) & 0x400),
                     'linked_result_path_requires_review')
    return _canonical(path.resolve())


def _under(child, parent):
    child, parent = _canonical(child), _canonical(parent)
    try:
        return os.path.commonpath((child, parent)) == parent
    except ValueError:  # different Windows volumes
        return False


def overlaps(left, right):
    return _under(left, right) or _under(right, left)


def _write_paths(root, values):
    _require(isinstance(values, list) and 1 <= len(values) <= 64, 'write_paths_required')
    if values == ['.']:
        return [root]
    result = []
    for raw in values:
        _require(isinstance(raw, str) and 0 < len(raw) <= 1024 and '\x00' not in raw,
                 'invalid_write_path')
        item = Path(raw)
        _require(not item.is_absolute() and not item.drive and raw not in ('.', '..') and
                 all(part not in ('.', '..', '') for part in item.parts), 'invalid_write_path')
        # Existing symlinks/junctions cannot silently alias another write domain.
        candidate = Path(root) / item
        for part in (candidate, *candidate.parents):
            if part.exists():
                _require(not part.is_symlink() and not (getattr(part.lstat(), 'st_file_attributes', 0) & 0x400),
                         'linked_write_path_requires_review')
            if _canonical(part) == root:
                break
        resolved = _canonical(candidate.resolve())
        _require(_under(resolved, root), 'write_path_outside_workspace')
        result.append(resolved)
    _require(len(set(result)) == len(result), 'duplicate_write_path')
    return sorted(result)


def _resources(values):
    _require(isinstance(values, list) and len(values) <= 64, 'invalid_resources')
    for value in values:
        _require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}', value),
                 'invalid_resource_name')
    _require(len(set(values)) == len(values), 'duplicate_resource')
    return sorted(values)


def resource_keys(values):
    """Compare resource names across routes without changing their receipts."""
    result = set()
    for value in values:
        key = value.casefold().replace('_', '-')
        if key == 'unity' or key.startswith('unity-') or key.startswith('unity:') or key == 'unityeditor':
            key = 'unity'
        result.add(key)
    return result


def _git_common_dir(root, timeout=8):
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0')
    try:
        done = subprocess.run(['git', '-C', root, 'rev-parse', '--is-inside-work-tree',
                               '--show-toplevel', '--git-common-dir'], capture_output=True,
                              text=True, encoding='utf-8', errors='strict', timeout=timeout, env=env)
    except (OSError, subprocess.SubprocessError, UnicodeError):
        raise AdmissionError('git_identity_probe_unavailable') from None
    if done.returncode:
        _require('not a git repository' in done.stderr.lower(), 'git_identity_probe_failed')
        return None
    lines = done.stdout.splitlines()
    _require(len(lines) == 3 and lines[0] == 'true', 'git_identity_probe_incomplete')
    common = Path(lines[2])
    if not common.is_absolute():
        common = Path(root) / common
    return _canonical(common.resolve())


def stable_git_marker(root, common_dir):
    """Filesystem-only identity fence for an out-of-lock Git probe.

    Walk the same ancestor chain used by Git discovery, including nested
    workspace roots. Linked/unusual layouts stay conservative. The nearest
    metadata entry and directory identities must still match the earlier probe.
    """
    path = Path(root)
    chain = []
    for parent in (path, *path.parents):
        directory = parent.lstat()
        if (not parent.is_dir() or parent.is_symlink() or
                (getattr(directory, 'st_file_attributes', 0) & 0x400)):
            return None
        chain.append((_canonical(parent), directory.st_dev, directory.st_ino))
        entry = parent / '.git'
        try:
            observed = entry.lstat()
        except FileNotFoundError:
            continue
        if (not entry.is_dir() or entry.is_symlink() or
                (getattr(observed, 'st_file_attributes', 0) & 0x400) or
                (entry / 'commondir').exists() or (entry / 'commondir').is_symlink() or
                common_dir is None or _canonical(entry.resolve()) != _canonical(common_dir)):
            return None
        return ('primary-directory', tuple(chain), observed.st_dev, observed.st_ino,
                observed.st_mtime_ns, observed.st_ctime_ns)
    return ('absent', tuple(chain)) if common_dir is None else None


def _unity_resource(root, paths):
    # The editor and Library are not safe shared writes between packages.
    for raw in paths:
        path = Path(raw)
        for part in (path, *path.parents):
            if not _under(_canonical(part), root):
                break
            if (part / 'ProjectSettings' / 'ProjectVersion.txt').is_file():
                return 'unity'
    return None


def implicit_unity_writer(candidate):
    """Recognize Unity writes even in older pure-Web scopes without resources."""
    candidate = dict(candidate)
    if candidate['access'] != 'write':
        return False
    root = _canonical(candidate['root'])
    try:
        relative_paths = json.loads(candidate.get('write_paths', '["."]'))
    except (TypeError, ValueError):
        raise AdmissionError('pure_web_scope_invalid') from None
    _require(isinstance(relative_paths, list) and relative_paths,
             'pure_web_scope_invalid')
    targets = []
    for relative in relative_paths:
        _require(isinstance(relative, str), 'pure_web_scope_invalid')
        target = root if relative == '.' else _canonical(Path(root) / relative)
        _require(_under(target, root), 'pure_web_scope_invalid')
        targets.append(target)
    if _unity_resource(root, targets):
        return True
    # A granted root may itself be nested inside one Unity checkout.
    return any((parent / 'ProjectSettings' / 'ProjectVersion.txt').is_file()
               for parent in (Path(root), *Path(root).parents))


def scope(workspace, write_paths=None, resources=None, *, git_write=True):
    root = _plain_existing_directory(workspace)
    declared_paths = ['.'] if write_paths is None else write_paths
    declared_resources = [] if resources is None else resources
    paths = _write_paths(root, declared_paths)
    names = _resources(declared_resources)
    unity = _unity_resource(root, paths)
    if not unity:
        # A package can start in Assets or another subdirectory of a Unity
        # checkout. The editor/Library remain shared above its working root.
        unity = next(('unity' for parent in (Path(root), *Path(root).parents)
                      if (parent / 'ProjectSettings' / 'ProjectVersion.txt').is_file()), None)
    if unity:
        names = sorted(set(names + [unity]))
    stat = Path(root).stat()
    return {'workspace': root, 'write_paths': paths, 'resources': names,
            'git_common_dir': _git_common_dir(root), 'declared_write_paths': declared_paths,
            'declared_resources': declared_resources, 'root_device': stat.st_dev,
            'root_inode': stat.st_ino, 'git_write': bool(git_write)}


def _native_conflict(a, b):
    return (bool(resource_keys(a['resources']) & resource_keys(b['resources'])) or
            bool((a.get('git_write',True) or b.get('git_write',True)) and a['git_common_dir'] and b['git_common_dir'] and
                 (UNKNOWN_GIT in (a['git_common_dir'], b['git_common_dir']) or
                  _canonical(a['git_common_dir']) == _canonical(b['git_common_dir']))) or
            any(overlaps(x, y) for x in a['write_paths'] for y in b['write_paths']) or
            (bool(b.get('read_root')) and any(overlaps(x, b['read_root']) for x in a['write_paths'])) or
            (bool(a.get('read_root')) and any(overlaps(x, a['read_root']) for x in b['write_paths'])))


def _pure_scope(row, git=None, resources=None):
    root = row['root']
    _require(isinstance(root, str) and Path(root).is_absolute(), 'pure_web_scope_invalid')
    root = _plain_existing_directory(root)
    _require(row['access'] in ('read', 'write'), 'pure_web_scope_invalid')
    paths = []
    if row['access'] == 'write':
        for relative in json.loads(row['write_paths']):
            _require(isinstance(relative, str), 'pure_web_scope_invalid')
            value = root if relative == '.' else _canonical((Path(root) / relative).resolve())
            _require(_under(value, root), 'pure_web_scope_invalid')
            paths.append(value)
    supplied = json.loads(resources if resources is not None else row['resources'])
    _require(isinstance(supplied, list) and all(isinstance(x, str) for x in supplied),
             'pure_web_scope_invalid')
    if implicit_unity_writer(row):
        supplied.append('unity')
    return {'workspace': root, 'write_paths': paths, 'read_root': root if row['access']=='read' else None,
            'resources': supplied,
            # Older pure-Web scopes record Git identity only when HEAD was
            # frozen. A matching read-only probe may be supplied from before
            # the write lock; otherwise the writer remains conservatively
            # unknown to a native Git writer.
            'git_common_dir': git['common_dir'] if git else (UNKNOWN_GIT if row['access'] == 'write' else None)}


def _load_native(row):
    _require(row['state'] in HELD + ('released',), 'native_claim_state_unknown')
    try:
        result = {'workspace': row['workspace'], 'write_paths': json.loads(row['write_paths']),
                  'resources': json.loads(row['resources']), 'git_common_dir': row['git_common_dir'],
                  'git_write': bool(row['git_write']) if 'git_write' in row.keys() else True}
        _require(isinstance(result['write_paths'], list) and isinstance(result['resources'], list),
                 'native_claim_invalid')
        return result
    except (TypeError, ValueError):
        raise AdmissionError('native_claim_invalid') from None


def _tables(db):
    names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    _require(set(REQUIRED_TABLES) <= names, 'shared_harness_schema_unavailable')


def _schema(db):
    _tables(db)
    db.execute('''CREATE TABLE IF NOT EXISTS native_work_claims(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id TEXT NOT NULL UNIQUE, result_path TEXT NOT NULL UNIQUE,
      workspace TEXT NOT NULL, write_paths TEXT NOT NULL, resources TEXT NOT NULL,
      git_common_dir TEXT, owner_pid INTEGER NOT NULL, state TEXT NOT NULL,
      created REAL NOT NULL, updated REAL NOT NULL, terminal_receipt_hash TEXT,
      declared_write_paths TEXT, declared_resources TEXT, root_device INTEGER, root_inode INTEGER)''')
    # Append-only migration for claims created by an earlier local build. They
    # remain held if the original resolved declaration cannot be verified.
    columns = {row[1] for row in db.execute('PRAGMA table_info(native_work_claims)')}
    for name, kind in (('declared_write_paths', 'TEXT'), ('declared_resources', 'TEXT'),
                       ('root_device', 'INTEGER'), ('root_inode', 'INTEGER'),
                       ('git_write', 'INTEGER NOT NULL DEFAULT 1')):
        if name not in columns:
            db.execute(f'ALTER TABLE native_work_claims ADD COLUMN {name} {kind}')
    db.execute('''CREATE TABLE IF NOT EXISTS native_work_recoveries(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT NOT NULL,
      kind TEXT NOT NULL, evidence TEXT NOT NULL, at REAL NOT NULL,
      UNIQUE(claim_id,kind))''')


@contextmanager
def _transaction(database):
    path = Path(database)
    _require(path.is_file(), 'shared_harness_database_missing')
    db = sqlite3.connect(path.as_uri() + '?mode=rw', uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute('BEGIN IMMEDIATE')
        _schema(db)
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def _legacy_git_overrides(database, candidate):
    """Probe active legacy write roots before taking the shared write lock.

    Missing/failing probes are deliberately omitted, leaving UNKNOWN_GIT as
    the conservative answer when admission checks the current scope.
    """
    if not candidate['git_common_dir']:
        return {}
    path = Path(database)
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
        db.row_factory = sqlite3.Row
        active = {row[0] for row in db.execute('SELECT DISTINCT thread_id FROM host_team_leases')}
        active.update(row[0] for row in db.execute(
            'SELECT id FROM threads WHERE status IN (' + ','.join('?' * len(ACTIVE_THREADS)) + ')',
            ACTIVE_THREADS))
        active.update(row[0] for row in db.execute(
            "SELECT DISTINCT a.thread_id FROM control_attempts a JOIN host_requests r ON r.id=a.request_id "
            "WHERE a.state IN ('dispatching','sent','unknown') "
            "AND r.phase IN ('queued','processing','suspended')"))
        scopes = {}
        for thread_id in active:
            row = db.execute('SELECT * FROM host_team_scopes WHERE thread_id=?', (thread_id,)).fetchone()
            if row is None or row['access'] != 'write':
                continue
            if db.execute('SELECT 1 FROM host_team_git_scopes WHERE thread_id=?', (thread_id,)).fetchone():
                continue
            scopes[thread_id] = dict(row)
    result = {}
    roots = {}
    failed_roots = set()
    deadline = time.monotonic() + 8
    for thread_id, recorded in scopes.items():
        try:
            root = _plain_existing_directory(recorded['root'])
            stat = Path(root).stat()
            # A legacy lease belongs to the directory admitted when its
            # scope was granted. A replaced root must remain UNKNOWN_GIT.
            if (type(recorded.get('device')) is not int or
                    type(recorded.get('inode')) is not int or
                    stat.st_dev != recorded['device'] or stat.st_ino != recorded['inode']):
                continue
            if root in failed_roots:
                continue
            if root not in roots:
                remaining = deadline - time.monotonic()
                if remaining < .05:
                    continue
                try:
                    roots[root] = _git_common_dir(root, timeout=min(2, remaining))
                except (AdmissionError, OSError):
                    failed_roots.add(root)
                    continue
            marker = stable_git_marker(root, roots[root])
            if marker is None:
                continue
            result[thread_id] = {'scope': recorded, 'root': root,
                                 'device': stat.st_dev, 'inode': stat.st_ino,
                                 'common_dir': roots[root], 'git_marker': marker}
        except (AdmissionError, OSError):
            continue
    return result


def _pure_conflict(db, candidate, legacy_gits=None):
    # A lost/legacy active thread with no scope is globally conflicting. A
    # scoped thread/lease is checked by paths, shared Git metadata and resources.
    def check_thread(thread_id, lease_resources=None):
        row = db.execute('SELECT * FROM host_team_scopes WHERE thread_id=?', (thread_id,)).fetchone()
        if row is None:
            return True
        git = db.execute('SELECT common_dir FROM host_team_git_scopes WHERE thread_id=?', (thread_id,)).fetchone()
        if git is None and legacy_gits:
            observed = legacy_gits.get(thread_id)
            if observed and dict(row) == observed['scope']:
                try:
                    root = _plain_existing_directory(row['root'])
                    stat = Path(root).stat()
                    if (root == observed['root'] and stat.st_dev == observed['device'] and
                            stat.st_ino == observed['inode'] and
                            observed.get('git_marker') is not None and
                            stable_git_marker(root, observed['common_dir']) == observed['git_marker']):
                        git = {'common_dir': observed['common_dir']}
                except (AdmissionError, OSError):
                    pass
        return _native_conflict(candidate, _pure_scope(row, git, lease_resources))

    for row in db.execute('SELECT DISTINCT thread_id,resources FROM host_team_leases'):
        if check_thread(row['thread_id'], row['resources']):
            return True
    for row in db.execute('SELECT id FROM threads WHERE status IN (' + ','.join('?' * len(ACTIVE_THREADS)) + ')', ACTIVE_THREADS):
        if check_thread(row['id']):
            return True
    for row in db.execute("SELECT DISTINCT a.thread_id FROM control_attempts a JOIN host_requests r ON r.id=a.request_id WHERE a.state IN ('dispatching','sent','unknown') AND r.phase IN ('queued','processing','suspended')"):
        if check_thread(row['thread_id']):
            return True
    return bool(db.execute("SELECT 1 FROM operations WHERE action='message.send' AND state IN ('reserved','dispatching','unknown') LIMIT 1").fetchone())


def _can_admit(db, candidate, own_seq, legacy_gits=None):
    if _pure_conflict(db, candidate, legacy_gits):
        return False
    for row in db.execute("SELECT * FROM native_work_claims WHERE state<>'released' AND seq<>?", (own_seq,)):
        other = _load_native(row)
        if row['state'] == 'queued' and row['seq'] > own_seq:
            continue
        if _native_conflict(candidate, other):
            return False
    return True


def pure_scope_blocker(db, pure_scope, *, held_request_id=None):
    """Called inside the pure-Web journal transaction; no schema mutation."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_work_claims'").fetchone():
        return None
    rows = db.execute("SELECT * FROM native_work_claims WHERE state<>'released'").fetchall()
    if not rows:
        return None
    # A pure-Web request that already holds its checkout does not lose it to a
    # later native waiter. New pure-Web requests still queue behind that waiter.
    held = None
    if held_request_id and pure_scope is not None and pure_scope.get('thread_id'):
        held = db.execute(
            'SELECT root,access,acquired FROM host_team_leases '
            'WHERE request_id=? AND thread_id=?',
            (held_request_id, pure_scope['thread_id']),
        ).fetchone()
        if held and (held['root'] != pure_scope['root'] or held['access'] != pure_scope['access']):
            held = None
    candidate = None
    if pure_scope is not None:
        candidate = _pure_scope(pure_scope, pure_scope.get('git'))
    for row in rows:
        if (held and row['state'] == 'queued' and 'created' in row.keys()
                and held['acquired'] <= row['created']):
            continue
        other = _load_native(row)
        if candidate is None or _native_conflict(candidate, other):
            return {'kind': 'native_work', 'claim_id': dict(row).get('claim_id'),
                    'workspace': row['workspace'], 'result_path': dict(row).get('result_path'),
                    'state': row['state'], 'owner_pid': dict(row).get('owner_pid')}
    return None


def conflicts_pure_scope(db, pure_scope, *, held_request_id=None):
    return pure_scope_blocker(db, pure_scope, held_request_id=held_request_id) is not None


def request(database, *, workspace, result_path, owner_pid, write_paths=None, resources=None, git_write=True):
    _require(type(owner_pid) is int and owner_pid > 0, 'owner_pid_required')
    _require(type(git_write) is bool,'git_write_declaration_invalid')
    candidate = scope(workspace, write_paths, resources, git_write=git_write)
    legacy_gits = _legacy_git_overrides(database, candidate)
    result = _result_path(result_path)
    now = time.time()
    claim_id = 'native_' + uuid.uuid4().hex
    with _transaction(database) as db:
        _require(not db.execute('SELECT 1 FROM native_work_claims WHERE result_path=?', (result,)).fetchone(),
                 'original_result_directory_already_claimed')
        db.execute('''INSERT INTO native_work_claims(claim_id,result_path,workspace,write_paths,resources,
                      git_common_dir,owner_pid,state,created,updated,declared_write_paths,
                      declared_resources,root_device,root_inode,git_write)
                      VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?)''',
                   (claim_id, result, candidate['workspace'], json.dumps(candidate['write_paths']),
                    json.dumps(candidate['resources']), candidate['git_common_dir'], owner_pid, now, now,
                    json.dumps(candidate['declared_write_paths']), json.dumps(candidate['declared_resources']),
                    candidate['root_device'], candidate['root_inode'], int(git_write)))
        row = db.execute('SELECT seq FROM native_work_claims WHERE claim_id=?', (claim_id,)).fetchone()
        if _can_admit(db, candidate, row['seq'], legacy_gits):
            db.execute("UPDATE native_work_claims SET state='reserved' WHERE claim_id=?", (claim_id,))
            state = 'reserved'
        else:
            state = 'queued'
    return {'claim_id': claim_id, 'state': state, 'cooperativeOnly': True}


def _read_claim(database, *, claim_id=None, result_path=None):
    path = Path(database)
    _require(path.is_file(), 'shared_harness_database_missing')
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
        db.row_factory = sqlite3.Row
        _require(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_work_claims'").fetchone(),
                 'native_claim_missing')
        if claim_id is not None:
            row = db.execute('SELECT * FROM native_work_claims WHERE claim_id=?', (claim_id,)).fetchone()
        else:
            row = db.execute('SELECT * FROM native_work_claims WHERE result_path=?',
                             (_result_path(result_path),)).fetchone()
        _require(row is not None, 'native_claim_missing')
        return dict(row)


def _reprobe(row):
    _require(row.get('declared_write_paths') is not None and row.get('declared_resources') is not None and
             row.get('root_device') is not None and row.get('root_inode') is not None,
             'original_scope_metadata_missing')
    try:
        observed = scope(row['workspace'], json.loads(row['declared_write_paths']),
                         json.loads(row['declared_resources']),git_write=bool(row.get('git_write',1)))
    except (ValueError, TypeError):
        raise AdmissionError('original_scope_metadata_invalid') from None
    fields = ('workspace', 'root_device', 'root_inode', 'git_common_dir')
    _require(all(observed[name] == row[name] for name in fields) and
             observed['write_paths'] == json.loads(row['write_paths']) and
             observed['resources'] == json.loads(row['resources']),
             'original_write_domain_changed_no_send')
    return observed


def poll(database, claim_id, owner_pid):
    snapshot = _read_claim(database, claim_id=claim_id)
    _require(snapshot['owner_pid'] == owner_pid, 'original_claim_owner_required')
    if snapshot['state'] != 'queued':
        return {'claim_id': claim_id, 'state': snapshot['state']}
    candidate = _reprobe(snapshot)  # Git/path probe before BEGIN IMMEDIATE.
    legacy_gits = _legacy_git_overrides(database, candidate)
    with _transaction(database) as db:
        row = _owned(db, claim_id, owner_pid)
        if row['state'] == 'queued':
            _require(row['updated'] == snapshot['updated'], 'original_claim_changed_reconcile')
            if _can_admit(db, candidate, row['seq'], legacy_gits):
                db.execute("UPDATE native_work_claims SET state='reserved',updated=? WHERE claim_id=?",
                           (time.time(), claim_id))
                return {'claim_id': claim_id, 'state': 'reserved'}
        return {'claim_id': claim_id, 'state': row['state']}


def _owned(db, claim_id, owner_pid):
    row = db.execute('SELECT * FROM native_work_claims WHERE claim_id=?', (claim_id,)).fetchone()
    _require(row is not None and row['owner_pid'] == owner_pid, 'original_claim_owner_required')
    return row


def start(database, claim_id, owner_pid):
    snapshot = _read_claim(database, claim_id=claim_id)
    _require(snapshot['owner_pid'] == owner_pid and snapshot['state'] == 'reserved',
             'native_claim_not_reserved_no_send')
    candidate = _reprobe(snapshot)  # Git/path probe before BEGIN IMMEDIATE.
    legacy_gits = _legacy_git_overrides(database, candidate)
    with _transaction(database) as db:
        row = _owned(db, claim_id, owner_pid)
        _require(row['state'] == 'reserved', 'native_claim_not_reserved_no_send')
        _require(row['updated'] == snapshot['updated'], 'original_claim_changed_reconcile')
        # Re-evaluate immediately before Codex starts. A new pure-Web lease
        # cannot slip in between this check and state update in this journal.
        _require(_can_admit(db, candidate, row['seq'], legacy_gits), 'native_claim_conflict_no_send')
        db.execute("UPDATE native_work_claims SET state='running',updated=? WHERE claim_id=?",
                   (time.time(), claim_id))
    return {'claim_id': claim_id, 'state': 'running'}


def _terminal_receipt(row):
    directory = Path(row['result_path'])
    receipt = directory / 'execution.json'
    try:
        raw = receipt.read_bytes()
        _require(len(raw) <= 65536, 'native_receipt_too_large')
        value = json.loads(raw.decode('utf-8-sig'))
        _require(value.get('admissionId') == row['claim_id'] and
                 _result_path(value.get('resultDirectory', '')) == row['result_path'] and
                 value.get('state') in TERMINAL and
                 isinstance(value.get('endedAt'), str) and
                 type(value.get('exitCode')) is int, 'original_terminal_receipt_required')
        events = directory / 'events.jsonl'
        _require(events.is_file(), 'original_native_events_required')
        with events.open('rb') as f:
            encoding = 'utf-16' if f.read(2) in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
        observed = False
        with events.open(encoding=encoding, errors='replace') as f:
            for line in f:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get('type') in ('turn.completed', 'turn.failed'):
                    observed = True
        _require(observed, 'original_native_turn_terminal_unverified')
        return hashlib.sha256(raw).hexdigest()
    except (OSError, UnicodeError, ValueError, TypeError):
        raise AdmissionError('original_terminal_receipt_unavailable') from None


def _receipt_digest(row):
    try:
        raw = (Path(row['result_path']) / 'execution.json').read_bytes()
        _require(len(raw) <= 65536, 'native_receipt_too_large')
        return hashlib.sha256(raw).hexdigest()
    except OSError:
        raise AdmissionError('original_terminal_receipt_unavailable') from None


def mark_terminal(database, claim_id, owner_pid):
    snapshot = _read_claim(database, claim_id=claim_id)
    _require(snapshot['owner_pid'] == owner_pid and snapshot['state'] == 'running',
             'native_claim_not_running')
    receipt_hash = _terminal_receipt(snapshot)  # Event scan before write lock.
    with _transaction(database) as db:
        row = _owned(db, claim_id, owner_pid)
        _require(row['state'] == 'running', 'native_claim_not_running')
        _require(row['updated'] == snapshot['updated'] and _receipt_digest(row) == receipt_hash,
                 'original_terminal_receipt_changed')
        db.execute("UPDATE native_work_claims SET state='terminal_pending',terminal_receipt_hash=?,updated=? WHERE claim_id=?",
                   (receipt_hash, time.time(), claim_id))
    return {'claim_id': claim_id, 'state': 'terminal_pending'}


def _read_json(url, *, headers=None, body=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url, data=body, headers=headers or {},
                                     method='POST' if body is not None else 'GET')
    with opener.open(request, timeout=8) as response:
        return json.load(response)


def local_runtime_read(project_root, name, arguments, *, require_native_idle=False):
    """Existing union's bounded read-only status API. No model or Job action."""
    _require(name in ('runtime_status','list_jobs','observe_jobs') and isinstance(arguments,dict),
             'local_runtime_read_only_operation_required')
    if name == 'observe_jobs':
        _require(arguments.get('wait_secs') in (None,0) and isinstance(arguments.get('items'), list)
                 and 1 <= len(arguments['items']) <= 8
                 and all(isinstance(item, dict) and isinstance(item.get('job_id'), str)
                         and item['job_id'] for item in arguments['items']),
                 'original_job_read_without_wait_required')
        # Current observe_jobs requests an immediate baseline by omitting wait.
        # Normalize the old internal zero spelling before the official API.
        arguments={k:v for k,v in arguments.items() if k!='wait_secs'}
    root = Path(project_root)
    config = json.loads((root / '.local/codex-web-bridge/union-config.json').read_text('utf-8-sig'))
    owner = json.loads((root / '.local/codex-web-bridge/shared-entry.json').read_text('utf-8-sig'))
    port = config['port']
    _require(type(port) is int and 1024 <= port <= 65535, 'local_runtime_identity_unavailable')
    base = f'http://127.0.0.1:{port}'
    _require(owner.get('url') == base + '/mcp', 'local_runtime_identity_changed')
    health = _read_json(base + '/healthz')
    _require(health.get('service') == 'clw-mcp-union' and health.get('pid') == owner.get('unionPid'),
             'local_runtime_identity_changed')
    if require_native_idle:
        _require(type(health.get('pendingNative')) is int and health['pendingNative'] == 0,
                 'native_tool_calls_active_or_unknown')
    authorization = Path(config['authorizationFile']).read_text('utf-8-sig').strip()
    _require(bool(authorization), 'local_runtime_authorization_unavailable')
    payload = {'jsonrpc': '2.0', 'id': 'native-admission-' + uuid.uuid4().hex,
               'method': 'tools/call', 'params': {'name': name, 'arguments': arguments,
               '_meta': {'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                         'io.modelcontextprotocol/clientCapabilities': {}}}}
    reply = _read_json(base + '/mcp', headers={'authorization': authorization,
                       'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28',
                       'mcp-method': 'tools/call', 'mcp-name': name},
                       body=json.dumps(payload).encode('utf-8'))
    _require(isinstance(reply,dict) and isinstance(reply.get('result'),dict),
             'local_runtime_status_unavailable')
    return reply['result']


def zero_local_jobs(project_root):
    """Read the existing Local-MCP-B runtime status; no model or job action."""
    reply=local_runtime_read(project_root,'runtime_status',{'compact':True},require_native_idle=True)
    try:
        output = reply['structuredContent']['output']
        _require(reply['structuredContent']['success'] is True,
                 'local_runtime_status_unavailable')
        jobs = output['jobs']
        _require(all(type(jobs.get(k)) is int and jobs[k] == 0 for k in
                     ('active_count', 'running_count', 'queued_count')),
                 'local_jobs_active_or_unknown')
    except (KeyError, TypeError):
        raise AdmissionError('local_runtime_status_unavailable') from None
    return True


def settle(database, result_path, *, job_probe=None):
    result = _result_path(result_path)
    snapshot = _read_claim(database, result_path=result)
    if snapshot['state'] == 'released':
        return {'claim_id': snapshot['claim_id'], 'state': 'released', 'alreadySettled': True}
    _require(snapshot['state'] == 'terminal_pending', 'original_claim_terminal_unverified')
    _require(_terminal_receipt(snapshot) == snapshot['terminal_receipt_hash'],
             'original_terminal_receipt_changed')
    # Local-MCP HTTP is independent of this SQLite database; hold no shared
    # write transaction while waiting for a bounded read-only status response.
    tool_free = None
    try:
        from native_work_interruption import tool_free_failure_evidence
        tool_free = tool_free_failure_evidence(snapshot)
    except (AdmissionError, OSError, ValueError, TypeError, subprocess.SubprocessError):
        pass
    native_terminal = None
    failed_terminal = None
    cancellation = None
    if tool_free is None:
        if job_probe is not None:
            # Keep legacy offline probe failures visible; a positive result
            # never substitutes for the failed turn's original tool receipts.
            _require(job_probe() is True, 'local_jobs_active_or_unknown')
        execution = json.loads((Path(result) / 'execution.json').read_text('utf-8-sig'))
        if execution.get('state') == 'needs_attention' and type(execution.get('exitCode')) is int and execution['exitCode'] != 0:
            from native_work_completion import failed_terminal_work_evidence
            with closing(sqlite3.connect(Path(database).as_uri()+'?mode=ro',uri=True,timeout=5)) as audit:
                ack=audit.execute("SELECT evidence FROM native_work_recoveries WHERE claim_id=? AND kind='cancel_running_acknowledged'",(snapshot['claim_id'],)).fetchone()
            cancellation=json.loads(ack[0]) if ack else None
            failed_terminal = failed_terminal_work_evidence(snapshot,**({'cancellation':cancellation} if cancellation else {}))
        elif job_probe is None:
            from native_work_terminal import terminal_work_evidence
            native_terminal = terminal_work_evidence(snapshot)
    else:
        _require(hashlib.sha256(Path(tool_free['source']).read_bytes()).hexdigest() == tool_free['sessionSha256'] and
                 hashlib.sha256((Path(result) / 'events.jsonl').read_bytes()).hexdigest() == tool_free['eventsSha256'],
                 'original_native_failure_changed')
    if native_terminal:
        from native_work_terminal import verify_terminal_work_evidence
        verify_terminal_work_evidence(snapshot, native_terminal)
    if failed_terminal:
        from native_work_completion import verify_failed_terminal_work_evidence
        verify_failed_terminal_work_evidence(snapshot, failed_terminal)
    with _transaction(database) as db:
        row = db.execute('SELECT * FROM native_work_claims WHERE result_path=?', (result,)).fetchone()
        _require(row is not None, 'native_claim_missing')
        _require(row['state'] == 'terminal_pending' and row['updated'] == snapshot['updated'],
                 'original_claim_changed_reconcile')
        _require(row['terminal_receipt_hash'] == snapshot['terminal_receipt_hash'] and
                 _receipt_digest(row) == snapshot['terminal_receipt_hash'],
                 'original_terminal_receipt_changed')
        db.execute("UPDATE native_work_claims SET state='released',updated=? WHERE claim_id=?",
                   (time.time(), row['claim_id']))
        if tool_free:
            _audit(db, row, 'native_failed_without_tools', {**tool_free, 'automaticReplay': False})
        elif failed_terminal:
            _audit(db, row, 'cancelled_native_terminal' if cancellation else 'original_native_failed_tools_terminal',
                {**failed_terminal,**({'taskOutcome':'cancelled_unverified','operationId':cancellation['operationId']} if cancellation else {})})
        elif native_terminal:
            _audit(db, row, 'original_native_tools_terminal', native_terminal)
        return {'claim_id': row['claim_id'], 'state': 'released',
                **({'taskOutcome':'cancelled_unverified'} if cancellation else {}),
                **({'nativeToolsVerifiedAbsent': True, 'originalNativeTerminal': True} if tool_free
                   else {'originalNativeTerminal': True, 'nativeToolsTerminal': True, 'workflowJobsTerminal': True,
                         'nativeTurnState': 'failed', 'taskAcceptance': 'unverified', 'automaticReplay': False} if failed_terminal
                   else {'originalNativeTerminal': True, 'nativeToolsTerminal': True,
                         'workflowJobsTerminal': True} if native_terminal
                   else {'localJobsVerifiedZero': True})}


def _owner_live(pid):
    """False means the original PID is proven gone; access errors are unknown."""
    _require(type(pid) is int and pid > 0, 'original_owner_identity_invalid')
    if os.name == 'nt':
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False if ctypes.get_last_error() == 87 else None
        try:
            code = ctypes.c_ulong()
            if not kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code)):
                return None
            return code.value == 259
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return None


def claim_owner_live(row, *, identity_probe=None):
    """Compare a retained launcher PID with its claim's original time fence.

    A Windows PID born after admission was requested cannot be that launcher.
    Older receipts have no creation marker; this fence still proves reuse
    without mistaking an inaccessible process for an exited one.
    """
    if os.name != 'nt' and identity_probe is None:
        return _owner_live(row['owner_pid'])
    try:
        from decimal import Decimal
        from windows_process_owner import retained_process_identities
        rows = (identity_probe or retained_process_identities)([row['owner_pid']])
        current = rows.get(row['owner_pid'])
        if current is None:
            return False
        created = int(current['CreationFiletime'])
        fence = Decimal(str(row['created'])) * 10000000 + 116444736000000000
        if current['ProcessId'] != row['owner_pid'] or created <= 0 or not fence.is_finite():
            return None
        return created <= fence
    except (OSError, RuntimeError, ValueError, TypeError, KeyError, ArithmeticError):
        return None


def _pre_send_evidence(row):
    directory = Path(row['result_path'])
    _require(directory.is_dir() and not any((directory / name).exists() for name in
             ('events.jsonl', 'final.md', 'stderr.log')),
             'pre_send_evidence_incomplete')
    receipt = directory / 'execution.json'
    if not receipt.exists():
        entries = list(directory.iterdir())
        proof = {'receipt': 'absent_before_initial_write', 'events': 'absent'}
        if not entries:
            return proof
        # Some guarded launchers prepare their fixed intent and input prompt
        # before requesting admission. These are not execution receipts. A
        # crash before the initial receipt must remain recoverable without
        # deleting inputs or inventing an execution.json for a dead owner.
        _require({p.name for p in entries} == {'launch-intent.json', 'prompt.txt'},
                 'pre_send_evidence_incomplete')
        prepared = {}
        for item in entries:
            stat = item.lstat()
            _require(item.is_file() and not item.is_symlink() and
                     not (getattr(stat, 'st_file_attributes', 0) & 0x400) and
                     stat.st_mtime <= row['created'] and 0 < stat.st_size <= 1048576,
                     'pre_send_preparation_unverified')
            raw = item.read_bytes()
            _require(len(raw) == stat.st_size, 'pre_send_preparation_changed')
            prepared[item.name] = {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
            if item.name == 'launch-intent.json':
                try:
                    intent = json.loads(raw.decode('utf-8-sig'))
                    at = datetime.fromisoformat(intent['at'].replace('Z', '+00:00'))
                    _require(intent.get('singleLaunch') is True and at.tzinfo is not None and
                             at.timestamp() <= row['created'] and intent.get('account') in ('A', 'B') and
                             re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,128}\.ps1', intent.get('script', '')),
                             'pre_send_preparation_unverified')
                except (UnicodeError, ValueError, KeyError, TypeError, AttributeError):
                    raise AdmissionError('pre_send_preparation_unverified') from None
        return {**proof, 'prepared_files': prepared}
    try:
        raw = receipt.read_bytes()
        _require(len(raw) <= 65536, 'pre_send_receipt_invalid')
        value = json.loads(raw.decode('utf-8-sig'))
    except (OSError, UnicodeError, ValueError):
        raise AdmissionError('pre_send_receipt_invalid') from None
    _require(value.get('admissionId') == row['claim_id'] and
             _result_path(value.get('resultDirectory', '')) == row['result_path'] and
             value.get('ownerPid') == row['owner_pid'] and
             value.get('state') in (('queued_local',) if row['state'] == 'queued' else
                                   ('queued_local', 'starting')) and
             'endedAt' not in value, 'pre_send_receipt_mismatch')
    return {'receipt': hashlib.sha256(raw).hexdigest(), 'events': 'absent'}


def cancel_before_start(database, claim_id, owner_pid):
    """The original live launcher can abandon its queue before native execution."""
    snapshot = _read_claim(database, claim_id=claim_id)
    _require(snapshot['owner_pid'] == owner_pid and snapshot['state'] in ('queued', 'reserved'),
             'original_pre_send_owner_required')
    proof = _pre_send_evidence(snapshot)
    with _transaction(database) as db:
        row = _owned(db, claim_id, owner_pid)
        _require(row['state'] == snapshot['state'] and row['updated'] == snapshot['updated'],
                 'original_claim_changed_reconcile')
        _require(_pre_send_evidence(row) == proof, 'pre_send_evidence_changed')
        db.execute("UPDATE native_work_claims SET state='released',updated=? WHERE claim_id=?",
                   (time.time(), claim_id))
        _audit(db, row, 'cancelled_before_native_start', {**proof, 'modelSends': 0})
    return {'claim_id': claim_id, 'state': 'released', 'modelSends': 0}


def declare_git_read_only(database,result_path,*,owner_pid):
    """Explicit cooperative no-Git-write promise on the original package.

    Only Git-metadata exclusion narrows. Paths/resources/identity and pending
    execution remain unchanged; this is not filesystem permission enforcement.
    """
    snapshot=_read_claim(database,result_path=result_path)
    _require(snapshot['owner_pid']==owner_pid and snapshot['state'] in ('queued','reserved','running'),
        'original_active_claim_owner_required')
    _require(claim_owner_live(snapshot) is True,'original_launcher_alive_or_unknown')
    candidate=_reprobe(snapshot)
    _require(candidate['git_common_dir'] and all(path!=candidate['workspace'] and
        not overlaps(path,candidate['git_common_dir']) for path in candidate['write_paths']),
        'explicit_non_git_write_paths_required')
    if snapshot['state'] in ('queued','reserved'):_pre_send_evidence(snapshot)
    with _transaction(database) as db:
        row=_owned(db,snapshot['claim_id'],owner_pid)
        _require(row['state']==snapshot['state'] and row['updated']==snapshot['updated'],
            'original_claim_changed_reconcile')
        if not row['git_write']:
            return {'claim_id':row['claim_id'],'state':row['state'],'gitWrite':False,'alreadyDeclared':True,'modelSends':0}
        db.execute('UPDATE native_work_claims SET git_write=0,updated=? WHERE claim_id=?',(time.time(),row['claim_id']))
        _audit(db,row,'git_read_only_declared',{'ownerPid':owner_pid,'writePaths':candidate['write_paths'],
            'resources':candidate['resources'],'cooperativeOnly':True,'noCommitCheckoutResetOrIndexWrites':True,'modelSends':0})
    return {'claim_id':snapshot['claim_id'],'state':snapshot['state'],'gitWrite':False,'cooperativeOnly':True,'modelSends':0}


def _audit(db, row, kind, evidence):
    db.execute('INSERT OR IGNORE INTO native_work_recoveries(claim_id,kind,evidence,at) VALUES(?,?,?,?)',
               (row['claim_id'], kind, json.dumps(evidence, sort_keys=True), time.time()))


def recover(database, result_path, *, owner_probe=None, job_probe=None):
    """Explicit reconciliation of a dead launcher. Never sends/restarts work."""
    snapshot = _read_claim(database, result_path=result_path)
    if snapshot['state'] == 'released':
        return {'claim_id': snapshot['claim_id'], 'state': 'released', 'alreadySettled': True}
    _require((owner_probe(snapshot['owner_pid']) if owner_probe else claim_owner_live(snapshot)) is False,
             'original_launcher_alive_or_unknown')
    if snapshot['state'] == 'terminal_pending':
        return settle(database, result_path, job_probe=job_probe)

    kind = None
    proof = None
    if snapshot['state'] in ('queued', 'reserved'):
        proof = _pre_send_evidence(snapshot)
        kind = 'pre_send_cancelled'
    elif snapshot['state'] in ('running', 'unknown'):
        try:
            proof = {'receipt': _terminal_receipt(snapshot), 'events': 'terminal'}
            kind = 'original_terminal_observed'
        except AdmissionError:
            with _transaction(database) as db:
                row = db.execute('SELECT * FROM native_work_claims WHERE claim_id=?',
                                 (snapshot['claim_id'],)).fetchone()
                _require(row and row['state'] in ('running', 'unknown') and
                         row['updated'] == snapshot['updated'], 'original_claim_changed_reconcile')
                db.execute("UPDATE native_work_claims SET state='unknown',updated=? WHERE claim_id=?",
                           (time.time(), row['claim_id']))
                _audit(db, row, 'in_flight_unknown', {'ownerPidDead': True, 'terminal': 'unverified'})
            return {'claim_id': snapshot['claim_id'], 'state': 'unknown',
                    'reason': 'original_turn_terminal_unverified', 'modelSends': 0}
    else:
        raise AdmissionError('original_claim_state_requires_review')

    native_terminal = None
    tool_free = None
    if job_probe is not None:
        _require(job_probe() is True, 'local_jobs_active_or_unknown')
    elif kind == 'original_terminal_observed':
        try:
            from native_work_interruption import tool_free_failure_evidence
            tool_free = tool_free_failure_evidence(snapshot)
        except (AdmissionError, OSError, ValueError, TypeError, subprocess.SubprocessError):
            pass
        if tool_free is None:
            from native_work_terminal import terminal_work_evidence
            native_terminal = terminal_work_evidence(snapshot)
        else:
            _require(hashlib.sha256(Path(tool_free['source']).read_bytes()).hexdigest() == tool_free['sessionSha256']
                     and hashlib.sha256((Path(result_path) / 'events.jsonl').read_bytes()).hexdigest() == tool_free['eventsSha256'],
                     'original_native_failure_changed')
    # Proven pre-send cancellation cannot own a native command or Workflow Job.
    # Do not hold its directory while unrelated projects use the shared Runner.
    if native_terminal:
        from native_work_terminal import verify_terminal_work_evidence
        verify_terminal_work_evidence(snapshot, native_terminal)
    release_flags = ({'localJobsVerifiedZero': True} if job_probe is not None else
                     {'nativeExecutionNotStarted': True} if kind == 'pre_send_cancelled' else
                     {'originalNativeTerminal': True, 'nativeToolsVerifiedAbsent': True} if tool_free else
                     {'originalNativeTerminal': True, 'nativeToolsTerminal': True, 'workflowJobsTerminal': True})
    with _transaction(database) as db:
        row = db.execute('SELECT * FROM native_work_claims WHERE claim_id=?',
                         (snapshot['claim_id'],)).fetchone()
        _require(row and row['state'] == snapshot['state'] and
                 row['updated'] == snapshot['updated'], 'original_claim_changed_reconcile')
        if kind == 'pre_send_cancelled':
            _require(_pre_send_evidence(row) == proof, 'pre_send_evidence_changed')
        else:
            _require(_receipt_digest(row) == proof['receipt'], 'original_terminal_receipt_changed')
        db.execute("UPDATE native_work_claims SET state='released',updated=?,terminal_receipt_hash=? WHERE claim_id=?",
                   (time.time(), proof['receipt'] if kind == 'original_terminal_observed' else None,
                    row['claim_id']))
        _audit(db, row, kind, {**proof, **(native_terminal or tool_free or {}), 'ownerPidDead': True,
                              **({'localJobsZero': True} if job_probe is not None else release_flags), 'modelSends': 0})
    return {'claim_id': snapshot['claim_id'], 'state': 'released',
            'recovery': kind, **release_flags, 'modelSends': 0}


def status(database, result_path):
    result = _result_path(result_path)
    path = Path(database)
    if not path.is_file():
        return {'state': 'unavailable'}
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
        db.row_factory = sqlite3.Row
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_work_claims'").fetchone():
            return {'state': 'legacy_no_claim'}
        columns={r[1] for r in db.execute('PRAGMA table_info(native_work_claims)')}
        git_column='git_write' if 'git_write' in columns else '1 AS git_write'
        row = db.execute('SELECT claim_id,state,owner_pid,created,updated,'+git_column+' FROM native_work_claims WHERE result_path=?',
                         (result,)).fetchone()
        if row is None:
            return {'state': 'legacy_no_claim'}
        result = {'claim_id': row['claim_id'], 'state': row['state'], 'ownerPid': row['owner_pid'],
                  'created': row['created'], 'updated': row['updated'], 'gitWrite':bool(row['git_write']),'cooperativeOnly': True}
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='native_work_recoveries'").fetchone():
            audit = db.execute('SELECT kind FROM native_work_recoveries WHERE claim_id=? ORDER BY at DESC LIMIT 1',
                               (row['claim_id'],)).fetchone()
            if audit:
                result['recovery'] = audit['kind']
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for name in ('request', 'poll', 'start', 'mark-terminal', 'cancel-before-start', 'request-cancel', 'cancel-stopped', 'declare-git-read-only', 'settle', 'recover', 'recover-interrupted', 'status'):
        item = sub.add_parser(name)
        item.add_argument('--database', required=True)
        if name in ('request', 'settle', 'recover', 'recover-interrupted', 'request-cancel', 'cancel-stopped', 'declare-git-read-only', 'status'):
            item.add_argument('--result-path', required=True)
        if name in ('cancel-stopped','request-cancel'):
            for field in ('operation-id','thread-id','turn-id','trace-id'):
                item.add_argument('--'+field,required=True)
        if name == 'request':
            item.add_argument('--workspace', required=True)
            item.add_argument('--owner-pid', type=int, required=True)
            item.add_argument('--write-path', action='append', dest='write_paths')
            item.add_argument('--resource', action='append', dest='resources')
            item.add_argument('--git-read-only',action='store_true')
        if name == 'declare-git-read-only':
            item.add_argument('--owner-pid',type=int,required=True)
        if name in ('poll', 'start', 'mark-terminal', 'cancel-before-start'):
            item.add_argument('--claim-id', required=True)
            item.add_argument('--owner-pid', type=int, required=True)
    args = parser.parse_args(argv)
    try:
        if args.action == 'request':
            result = request(args.database, workspace=args.workspace, result_path=args.result_path,
                             owner_pid=args.owner_pid, write_paths=args.write_paths,
                             resources=args.resources,git_write=not args.git_read_only)
        elif args.action == 'declare-git-read-only':
            result=declare_git_read_only(args.database,args.result_path,owner_pid=args.owner_pid)
        elif args.action == 'poll':
            result = poll(args.database, args.claim_id, args.owner_pid)
        elif args.action == 'start':
            result = start(args.database, args.claim_id, args.owner_pid)
        elif args.action == 'mark-terminal':
            result = mark_terminal(args.database, args.claim_id, args.owner_pid)
        elif args.action == 'cancel-before-start':
            result = cancel_before_start(args.database, args.claim_id, args.owner_pid)
        elif args.action == 'settle':
            result = settle(args.database, args.result_path)
        elif args.action == 'recover-interrupted':
            from native_work_interruption import recover_interrupted
            result = recover_interrupted(args.database, args.result_path)
        elif args.action == 'cancel-stopped':
            from native_work_cancellation import cancel_stopped
            result = cancel_stopped(args.database,args.result_path,operation_id=args.operation_id,
                thread_id=args.thread_id,turn_id=args.turn_id,trace_id=args.trace_id)
        elif args.action == 'request-cancel':
            from native_work_cancellation import request_cancel
            result = request_cancel(args.database,args.result_path,operation_id=args.operation_id,
                thread_id=args.thread_id,turn_id=args.turn_id,trace_id=args.trace_id)
        elif args.action == 'recover':
            result = recover(args.database, args.result_path)
        else:
            result = status(args.database, args.result_path)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (AdmissionError, sqlite3.Error, OSError, UnicodeError, ValueError) as exc:
        print(json.dumps({'state': 'blocked', 'reason': str(exc), 'modelSends': 0}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    raise SystemExit(main())
