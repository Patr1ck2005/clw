"""Attach a local operator to an existing Harness journal without starting it.

This facade admits only ``team.reconcile-attention`` / ``retire-paused`` for
one explicitly identified controller and run. It reuses HarnessService.command
and TeamRuntime.handle, including their BEGIN IMMEDIATE and durable receipts.
It does not initialize providers, migrate a schema, create keys, recover other
operations, run an observer, or start/stop/connect a service.

Prepare an identity JSON from the current loopback harness info and
``process_start_marker(pid)``. Required fields are the AttachIdentity fields.
The state path must be the absolute ROOT/.local/harness/harness.sqlite3 and
already contain the complete existing schema.

Usage::

    python scripts/harness_operator_attach.py --identity ABSOLUTE_IDENTITY_JSON \
        command --request ABSOLUTE_ORIGINAL_COMMAND_JSON
    python scripts/harness_operator_attach.py --identity ABSOLUTE_IDENTITY_JSON \
        receipt --request-id ORIGINAL_ID

Command JSON is the original public command, including confirm=true; no IDs,
permissions, evidence, jobs, or model messages are invented here. Reuse that
same command/request ID after a lost response. A new contract is checked anew.
Identity is rechecked before each operation. Existing GET /api/harness/info
has its normal service liveness semantics; this module never calls service.info.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from dataclasses import dataclass, fields
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from harness_collaboration import HostCollaboration
from harness_host import HostBridge, PROVIDER
from harness_service import HarnessService
from harness_state import HarnessError, HarnessState, require
from harness_team import TeamRuntime
from harness_team_maintenance import Maintenance
from harness_team_scopes import Scopes


@dataclass(frozen=True)
class AttachIdentity:
    root: str
    state_path: str
    store_id: str
    controller_thread: str
    controller_session: str
    run_id: str
    origin: str
    harness_instance_id: str
    pid: int
    process_start: str

    @classmethod
    def from_dict(cls, value):
        require(isinstance(value, dict) and set(value) == {f.name for f in fields(cls)},
                'operator_attach_identity_fields')
        return cls(**value)


# Validate the columns used by the admitted path before it can reserve an
# operation. Absence/incompatibility is refused; no migrations are run here.
REQUIRED_SCHEMA = {
    'metadata': 'key value',
    'threads': 'id provider native_id parent_id title cwd model effort status active_turn created_at updated_at',
    'operations': 'id fingerprint action thread_id state response created_at',
    'events': 'seq thread_id kind data at',
    'host_bindings': 'target_id thread_id spec enabled wait_key wait_until',
    'host_requests': 'id thread_id text phase claim_id cancel_requested created_at finished_at',
    'host_replies': 'id request_id fingerprint response',
    'host_delegations': 'id parent_request_id parent_thread_id child_target_id child_thread_id child_request_id fingerprint created_at',
    'host_unread_notes': 'note_id request_id',
    'host_notes': 'id request_id text created_at',
    'host_team_receipts': 'operation_id actor operation fingerprint response',
    'host_runs': 'id controller_thread controller_request goal_ref constraints_text state deadline max_dispatches max_parallel dispatches final_granted revision wait_mode after_seq created reason',
    'host_team_work': 'request_id run_id dependencies resources scope_fingerprint',
    'host_team_signals': 'seq run_id source_event request_id kind',
    'host_team_scopes': 'thread_id project root access write_paths resources fingerprint granted_by device inode',
    'host_team_leases': 'request_id run_id thread_id root access resources acquired',
    'host_team_dispatches': 'attempt_id run_id request_id is_final at',
    'host_team_maintenance': 'run_id state',
    'managed_pages': 'page_id target_id thread_id parent_target phase paused bootstrap_state url model effort settings',
    'managed_pause_owners': 'page_id source attempt_id',
    'managed_stops': 'page_id resumed',
    'managed_page_issues': 'page_id kind detail',
    'managed_attention': 'request_id attempt_id',
    'managed_handoffs': 'source_thread state',
    'managed_recovery_contexts': 'request_id attempt_id snapshot',
    'managed_artifacts': 'id request_id path sha256 bytes source',
    'managed_text_artifact_turns': 'attempt_id assistant_turn_hash',
    'control_attempts': 'id request_id thread_id state offered dispatched acknowledged',
    'control_browser_receipts': 'attempt_id request_id thread_id claim_id sent_user_hash result_turn_hash result_hash completed',
}
REQUIRED_KEYS = {'metadata': 'key', 'threads': 'id', 'operations': 'id',
                 'host_team_receipts': 'operation_id', 'host_replies': 'id'}
PAYLOAD_FIELDS = {'confirm', 'mode', 'run_id', 'request_id', 'attempt_id',
                  'offered_attempt_id', 'continue_operation_id', 'evidence_path',
                  'evidence_sha256', 'reason'}


def _plain(path, *, directory=False):
    path = Path(path)
    require(path.is_absolute(), 'operator_attach_absolute_path_required')
    require(path.is_dir() if directory else path.is_file(), 'operator_attach_existing_path_required', 409)
    for p in (path, *path.parents):
        require(not p.is_symlink() and not (getattr(p.lstat(), 'st_file_attributes', 0) & 0x400),
                'operator_attach_link_forbidden', 403)
    return path.resolve()


def _file_identity(path):
    s = path.stat()
    return s.st_dev, s.st_ino


def process_start_marker(pid):
    """Read one exact PID's OS creation identity; no process discovery or launch."""
    require(type(pid) is int and pid > 0, 'operator_attach_pid_required')
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)]
        kernel.GetProcessTimes.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        require(bool(handle), 'operator_attach_process_not_observed', 409)
        try:
            created, ended, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
            require(bool(kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(ended),
                                               ctypes.byref(kernel_time), ctypes.byref(user_time))),
                    'operator_attach_process_not_observed', 409)
            require(not ended.dwHighDateTime and not ended.dwLowDateTime,
                    'operator_attach_process_ended', 409)
            return 'windows-filetime:' + str((created.dwHighDateTime << 32) | created.dwLowDateTime)
        finally:
            kernel.CloseHandle(handle)
    if os.name == 'posix' and Path('/proc').is_dir():
        try:
            boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            stat = Path('/proc') / str(pid) / 'stat'
            parts = stat.read_text().rsplit(')', 1)[1].split()
            require(parts[0] != 'Z', 'operator_attach_process_ended', 409)
            return 'linux-start:' + boot + ':' + parts[19]
        except (OSError, IndexError):
            raise HarnessError('operator_attach_process_not_observed', 409) from None
    raise HarnessError('operator_attach_process_identity_unsupported', 409)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise HarnessError('operator_attach_redirect_forbidden', 403)


def _origin(value):
    require(isinstance(value, str), 'operator_attach_loopback_required')
    try:
        p = urlsplit(value)
        valid = (p.scheme == 'http' and p.hostname == '127.0.0.1' and p.port is not None
                 and 0 < p.port < 65536 and not p.username and not p.password
                 and not p.path and not p.query and not p.fragment)
    except ValueError:
        valid = False
    require(valid, 'operator_attach_loopback_required', 403)
    return value


def read_live_identity(origin):
    """Only the existing loopback harness identity GET; no proxy or redirects."""
    origin = _origin(origin)
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    result = {}
    for name in ('harness',):
        req = Request(origin + '/api/' + name + '/info', headers={'Origin': origin})
        with opener.open(req, timeout=2) as response:
            raw = response.read(131073)
        require(len(raw) <= 131072, 'operator_attach_info_too_large', 413)
        value = json.loads(raw)
        require(isinstance(value, dict) and value.get('success') is True,
                'operator_attach_live_info_required', 409)
        result[name] = value
    return result


class _ExistingState(HarnessState):
    def __init__(self, path, store_id):
        self.path, self.id = path, store_id
        self.lock = threading.RLock()
        self._identity = _file_identity(path)

    def checked_path(self):
        require(_plain(self.path) == self.path and _file_identity(self.path) == self._identity,
                'operator_attach_state_replaced', 409)
        return self.path

    def connect(self):
        # mode=rw must never create a missing database. The inherited operation
        # methods are the only route that requests a writable connection.
        db = sqlite3.connect(self.checked_path().as_uri() + '?mode=rw', uri=True, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def readonly(self):
        db = sqlite3.connect(self.checked_path().as_uri() + '?mode=ro', uri=True, timeout=2)
        db.row_factory = sqlite3.Row
        return db


def _unavailable(*args, **kwargs):
    raise HarnessError('operator_attach_runtime_action_forbidden', 403)


class _ExistingCollaboration(HostCollaboration):
    def __init__(self, host):
        self.host, self.state = host, host.state


class _ExistingTeam(TeamRuntime):
    def __init__(self, host):
        self.host, self.state = host, host.state
        self.changed = threading.Event()
        self._settling_dependencies = False
        self.scopes = Scopes(self)
        self.maintenance = Maintenance(self)

    start = close = tick = _unavailable


class _ExistingHost(HostBridge):
    def __init__(self, state, root):
        self.state, self.root = state, root
        self.lock, self.clock = threading.RLock(), time.time
        self.maintenance_exit_fence = None
        self.active_business_operations = 0
        self.collaboration = _ExistingCollaboration(self)
        # Keep TeamRuntime.handle's existing handoff-source read-only guard.
        # No ManagedPages methods are used or constructed by this path.
        self.managed = object()
        self.team = _ExistingTeam(self)

    private = send = register = pause = _unavailable


class _ExistingService(HarnessService):
    def __init__(self, root, state):
        self.root, self.state = root, state
        self.host_bridge = _ExistingHost(state, root)

    connect = close = start_web_observer = _attach = _unavailable


class OperatorAttach:
    """Narrow local facade. Use attach_existing, never a normal service startup."""
    def __init__(self, identity, live_probe, process_probe):
        require(isinstance(identity, AttachIdentity), 'operator_attach_identity_required')
        self.identity = identity
        self._live_probe, self._process_probe = live_probe, process_probe
        require(type(identity.pid) is int and identity.pid > 0, 'operator_attach_pid_required')
        for field in fields(identity):
            if field.name != 'pid':
                require(isinstance(getattr(identity, field.name), str) and bool(getattr(identity, field.name)),
                        'operator_attach_identity_required')
        self.root = _plain(identity.root, directory=True)
        self.state_path = _plain(identity.state_path)
        require(self.state_path == self.root / '.local' / 'harness' / 'harness.sqlite3',
                'operator_attach_root_state_mismatch', 409)
        _origin(identity.origin)
        self._state = _ExistingState(self.state_path, identity.store_id)
        self._validate_existing()
        self._service = _ExistingService(self.root, self._state)

    def _validate_existing(self):
        i = self.identity
        require(self._process_probe(i.pid) == i.process_start,
                'operator_attach_process_changed', 409)
        live = self._live_probe(i.origin)
        h = live.get('harness', {})
        require(h.get('root') == str(self.root) and h.get('store_id') == i.store_id
                and h.get('instance_id') == i.harness_instance_id,
                'operator_attach_harness_identity_mismatch', 409)
        require(self._process_probe(i.pid) == i.process_start,
                'operator_attach_process_changed', 409)
        with closing(self._state.readonly()) as db:
            for table, columns in REQUIRED_SCHEMA.items():
                info = db.execute('PRAGMA table_info(' + table + ')').fetchall()
                require(set(columns.split()) <= {r['name'] for r in info},
                        'operator_attach_schema_missing:' + table, 409)
                if table in REQUIRED_KEYS:
                    require([r['name'] for r in info if r['pk']] == [REQUIRED_KEYS[table]],
                            'operator_attach_schema_key_mismatch:' + table, 409)
            store = db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()
            require(store and store[0] == i.store_id, 'operator_attach_store_mismatch', 409)
            binding = db.execute('SELECT * FROM host_bindings WHERE thread_id=?', (i.controller_thread,)).fetchone()
            run = db.execute('SELECT controller_thread FROM host_runs WHERE id=?', (i.run_id,)).fetchone()
            actor = db.execute('SELECT provider,native_id FROM threads WHERE id=?', (i.controller_thread,)).fetchone()
            require(binding and actor and actor['provider'] == PROVIDER
                    and actor['native_id'] == 'mcp-host/' + i.controller_session
                    and json.loads(binding['spec']).get('session_id') == i.controller_session
                    and run and run[0] == i.controller_thread,
                    'operator_attach_controller_mismatch', 403)

    def command(self, raw):
        # Every excluded action/actor is rejected before HarnessState.begin.
        require(isinstance(raw, dict) and set(raw) == {'request_id', 'action', 'thread_id', 'data'},
                'operator_attach_command_fields')
        require(raw['action'] == 'team.reconcile-attention', 'operator_attach_action_forbidden', 403)
        p = raw['data']
        require(isinstance(p, dict) and set(p) == PAYLOAD_FIELDS
                and p.get('mode') == 'retire-paused' and p.get('confirm') is True,
                'operator_attach_retire_paused_only', 403)
        require(raw['thread_id'] == self.identity.controller_thread and p['run_id'] == self.identity.run_id,
                'operator_attach_controller_mismatch', 403)
        self._validate_existing()
        return self._service.command(raw)

    def receipt(self, key):
        HostBridge.identifier(key)
        self._validate_existing()
        with closing(self._state.readonly()) as db:
            row = db.execute('SELECT action,thread_id FROM operations WHERE id=?', (key,)).fetchone()
            require(row and row['action'] == 'team.reconcile-attention'
                    and row['thread_id'] == self.identity.controller_thread,
                    'operator_attach_receipt_not_owned', 403)
            team = db.execute('SELECT actor FROM host_team_receipts WHERE operation_id=?', (key,)).fetchone()
            require(not team or team[0] == self.identity.controller_session,
                    'operator_attach_receipt_not_owned', 403)
        # A generic outer exception can leave a nonempty ``unknown`` response
        # after the inner team transaction already committed. Prefer that
        # existing same-operation receipt; never dispatch or change its state.
        known = self._service.host_bridge.team.completed_public_receipt(key)
        if known:
            return {'operation_id': key, 'state': 'completed', 'result': known,
                    'derived_from_original_team_receipt': True}
        return self._service.receipt(key)


def attach_existing(identity, *, live_probe=read_live_identity, process_probe=process_start_marker):
    return OperatorAttach(identity, live_probe, process_probe)


def _read_json(path):
    path = _plain(path)
    require(path.stat().st_size <= 131072, 'operator_attach_input_too_large', 413)
    return json.loads(path.read_bytes())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--identity', type=Path, required=True)
    actions = parser.add_subparsers(dest='action', required=True)
    cmd = actions.add_parser('command'); cmd.add_argument('--request', type=Path, required=True)
    receipt = actions.add_parser('receipt'); receipt.add_argument('--request-id', required=True)
    args = parser.parse_args(argv)
    try:
        operator = attach_existing(AttachIdentity.from_dict(_read_json(args.identity)))
        result = operator.command(_read_json(args.request)) if args.action == 'command' else operator.receipt(args.request_id)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0 if result.get('state') in ('completed', 'paused_branch_retired') else 1
    except (HarnessError, OSError, ValueError, sqlite3.Error) as exc:
        print(json.dumps({'state': 'rejected', 'code': exc.code if isinstance(exc, HarnessError)
                          else 'operator_attach_identity_or_store_unavailable', 'model_sends': 0}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
