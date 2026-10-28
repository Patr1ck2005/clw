"""Read-only native ownership checks for a single canonical browser profile.

Kernel launch/supervisor leases serialize admission. Retained lifecycle PIDs
are checked by exact native creation/image identity without reading foreign argv.
"""
from pathlib import Path
from datetime import datetime
import ctypes
import json
import os
import re
import shlex
import sys
import time

from product_runtime import ProductError, read_json
from windows_process_owner import retained_process_identities, process_identity, OwnershipUnavailable

FOCUS_FLAG = '--clw-focus-existing-only'
FOCUS_TARGET = '--clw-focus-target='
BROWSER_OWNER_NAMES = frozenset(('electron.exe', 'python.exe', 'pythonw.exe'))
OWNERSHIP_READ_DELAYS = (.025, .075)


def command_argv(command):
    if not isinstance(command, str) or not 0 < len(command) <= 65536:
        raise ProductError('web_workspace_ownership_unverified')
    if os.name != 'nt':
        return shlex.split(command)  # Isolated portable tests only.
    shell = ctypes.WinDLL('shell32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype = ctypes.POINTER(ctypes.c_wchar_p)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]; kernel.LocalFree.restype = ctypes.c_void_p
    count = ctypes.c_int(); argv = shell.CommandLineToArgvW(command, ctypes.byref(count))
    if not argv: raise ProductError('web_workspace_ownership_unverified')
    try:
        if not 1 <= count.value <= 256: raise ProductError('web_workspace_ownership_unverified')
        return [argv[index] for index in range(count.value)]
    finally: kernel.LocalFree(argv)


def normalized(path):
    return os.path.abspath(str(path)).replace('\\', '/').casefold().rstrip('/')


def creation(value):
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,31}', value):
        raise ProductError('web_workspace_ownership_unverified')
    return value


def native_identity(pid, name=None):
    try:
        value = process_identity(pid)
        if value.get('ProcessId') != pid or name and value.get('ProcessName') != name:
            raise ProductError('web_workspace_ownership_unverified')
        return {'pid': pid, 'creationFiletime': creation(value.get('CreationFiletime'))}
    except (OSError, ValueError, RuntimeError, KeyError, TypeError):
        raise ProductError('web_workspace_ownership_unverified') from None


def existing_browser(root, profile, *, own_pid=None, now=time.time, sleep=time.sleep):
    """Use only this profile's retained owners; caller holds/probes its kernel lease.

    A free lease admits a new supervisor only after every retained PID is absent
    or proven to be a different image/creation. A busy lease is handled by the
    caller, which may only focus the returned, freshly proven browser.
    """
    try:
        expected_exe = normalized(root / 'apps/web-host/node_modules/electron/dist/electron.exe')
        python = root / 'runtime/python/python.exe'
        expected_python = normalized(python if python.is_file() else sys.executable)
        paths = [profile / 'supervisor.json', profile / 'health.json',
                 profile / 'shared-entry-start.json', profile.parent / 'preview-launch.json']
        records = {}; snapshots = {}
        for path in paths:
            if path.is_symlink():raise ProductError('web_workspace_ownership_unverified')
            if not path.exists():
                snapshots[path] = None
                continue
            value = read_json(path, 32768)
            before = path.read_bytes()
            if not isinstance(value, dict) or len(before)>32768 or json.loads(before)!=value or path.read_bytes() != before:
                raise ProductError('web_workspace_ownership_unverified')
            records[path.name] = value; snapshots[path] = before
        for name in ('preview-launch.json', 'shared-entry-start.json'):
            if records.get(name, {}).get('completion_unknown') is True:
                raise ProductError('web_workspace_original_start_completion_unknown')
        state = records.get('supervisor.json', {})
        health = records.get('health.json')
        if state.get('canonical_profile') is not None and normalized(state['canonical_profile']) != normalized(profile):
            raise ProductError('web_workspace_original_owner_unverified')
        retained = set()
        for value, field in ((state, 'pid'), (state, 'supervisor_pid'), (health or {}, 'pid')):
            if field in value:
                pid = value[field]
                if type(pid) is not int or not 1 <= pid <= 0xffffffff:
                    raise ProductError('web_workspace_ownership_unverified')
                if pid != own_pid: retained.add(pid)
        for attempt in range(len(OWNERSHIP_READ_DELAYS) + 1):
            try:
                rows = retained_process_identities(retained)
                break
            except OwnershipUnavailable:
                if attempt == len(OWNERSHIP_READ_DELAYS): raise
                sleep(OWNERSHIP_READ_DELAYS[attempt])
        if not isinstance(rows, dict) or not rows.keys() <= retained:
            raise ProductError('web_workspace_ownership_unverified')
        # An atomic lifecycle replacement during the observation invalidates
        # the sample; do not admit startup from mixed owner generations.
        if any((path.read_bytes() if path.exists() else None) != before for path, before in snapshots.items()):
            raise ProductError('web_workspace_ownership_unverified')
        for pid, row in rows.items():
            if row.get('ProcessId') != pid or not row.get('ExecutablePath'):
                raise ProductError('web_workspace_ownership_unverified')
            creation(row.get('CreationFiletime'))
        browser = None
        child = rows.get(state.get('pid'))
        if child:
            recorded = state.get('child_creation_filetime')
            if recorded is not None: creation(recorded)
            if normalized(child['ExecutablePath']) == expected_exe:
                if recorded is not None and recorded != child['CreationFiletime']:
                    raise ProductError('web_workspace_original_owner_unverified')
                browser = child
            elif recorded is not None and recorded == child['CreationFiletime']:
                raise ProductError('web_workspace_original_owner_unverified')
        if health and health.get('pid') in rows:
            row = rows[health['pid']]
            if normalized(row['ExecutablePath']) == expected_exe:
                if browser and browser['ProcessId'] != row['ProcessId']:
                    raise ProductError('web_workspace_original_owner_unverified')
                browser = row
        owner = rows.get(state.get('supervisor_pid'))
        if owner:
            recorded = creation(state.get('supervisor_creation_filetime'))
            if owner['CreationFiletime'] == recorded:
                if normalized(owner['ExecutablePath']) != expected_python or not browser:
                    raise ProductError('web_workspace_original_owner_unverified')
        if browser:
            if not health or health.get('pid') != browser['ProcessId']:
                raise ProductError('web_workspace_original_owner_unverified')
            observed = datetime.fromisoformat(health.get('at', '').replace('Z', '+00:00'))
            created_100ns = int(browser['CreationFiletime']) - 116444736000000000
            if observed.tzinfo is None or created_100ns <= 0 or int(observed.timestamp()*10000000) < created_100ns or not 0 <= now() - observed.timestamp() <= 15:
                raise ProductError('web_workspace_original_owner_unverified')
            return {'pid': browser['ProcessId'], 'creationFiletime': browser['CreationFiletime'], 'health': health}
        return None
    except ProductError: raise
    except (OSError, ValueError, RuntimeError, TypeError, KeyError, AttributeError):
        raise ProductError('web_workspace_ownership_unverified') from None


def focus_existing(browser, root, spawn):
    """Only the advertised no-takeover protocol may create a focus child."""
    health = browser['health']; token = health.get('focusInstanceId')
    if type(health.get('focusExistingProtocol')) is not int or health['focusExistingProtocol'] != 1 or not isinstance(token, str) or not re.fullmatch('[a-f0-9]{32}', token):
        raise ProductError('web_workspace_focus_unverified')
    if native_identity(browser['pid'], 'electron.exe') != {key: browser[key] for key in ('pid', 'creationFiletime')}:
        raise ProductError('web_workspace_original_owner_unverified')
    import subprocess
    args = [str(root / 'apps/web-host/node_modules/electron/dist/electron.exe'), str(root / 'apps/web-host'), FOCUS_FLAG, FOCUS_TARGET + token]
    child = spawn(args, cwd=str(root), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                  stderr=subprocess.DEVNULL, close_fds=True,
                  creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        if child.wait(timeout=5) != 0: raise ProductError('web_workspace_focus_unverified')
    except subprocess.TimeoutExpired:
        # Never retry, kill another owner, or reinterpret this as a new startup.
        raise ProductError('web_workspace_focus_completion_unknown') from None
    return 0
