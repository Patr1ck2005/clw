"""Small local deployment helper. Not an MCP server or an execution backend."""
from __future__ import annotations
import ctypes
from ctypes import wintypes as W
import json
import hashlib
import os
from pathlib import Path
import socket
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / 'vendor/webcodex-v0.4.1'
PORTS = {'workspace': 18791}
K = ctypes.WinDLL('kernel32', use_last_error=True)
K.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
K.OpenProcess.restype = W.HANDLE
K.CloseHandle.argtypes = [W.HANDLE]
K.QueryFullProcessImageNameW.argtypes = [W.HANDLE, W.DWORD, W.LPWSTR, ctypes.POINTER(W.DWORD)]
K.GetProcessTimes.argtypes = [W.HANDLE, ctypes.POINTER(W.FILETIME), ctypes.POINTER(W.FILETIME), ctypes.POINTER(W.FILETIME), ctypes.POINTER(W.FILETIME)]
K.WaitForSingleObject.argtypes = [W.HANDLE, W.DWORD]
K.TerminateProcess.argtypes = [W.HANDLE, W.UINT]

def clean_env() -> dict[str, str]:
    keep = {'PATH','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA',
            'LOCALAPPDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','HOMEDRIVE','HOMEPATH','PATHEXT'}
    return {k:v for k,v in os.environ.items() if k.upper() in keep}

def snapshot_handle(h, pid: int) -> dict | None:
    if K.WaitForSingleObject(h, 0) != 258:
        return None
    buf = ctypes.create_unicode_buffer(32768)
    n = W.DWORD(len(buf))
    times = [W.FILETIME() for _ in range(4)]
    if not K.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
        raise OSError('Cannot inspect process image')
    if not K.GetProcessTimes(h, *(ctypes.byref(t) for t in times)):
        raise OSError('Cannot inspect process creation time')
    return {'pid': pid, 'image': str(Path(buf.value).resolve()),
            'created_filetime': (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime}

def inspect(pid: int) -> dict | None:
    h = K.OpenProcess(0x1000 | 0x100000, False, pid)
    if not h:
        if ctypes.get_last_error() == 87:
            return None
        raise OSError('Cannot open recorded process; no replacement started')
    try:
        return snapshot_handle(h, pid)
    finally:
        K.CloseHandle(h)

def write_json(path: Path, value: dict) -> None:
    temp = path.with_suffix(path.suffix + '.tmp')
    with temp.open('x', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)

def require_profile(profile: str) -> None:
    if profile not in PORTS:
        raise ValueError('Unknown or retired profile. Use general-purpose workspace; no account-specific editions.')

def spawn(profile: str, component: str, args: list[str], extra_env: dict | None = None) -> dict:
    require_profile(profile)
    base = ROOT / 'profiles' / profile
    receipt = base / (component + '-process.json')
    exe = Path(args[0]).resolve()
    if not exe.is_relative_to(ROOT / 'vendor'):
        raise ValueError('Only the pinned local vendor executables may be started')
    if component in {'server','runner'}:
        expected_name = 'webcodex-' + component + '.exe'
        lock_data = json.loads((ROOT/'upstream-lock.json').read_text(encoding='utf-8'))
        expected = lock_data['files'][expected_name]
        if exe != BIN/expected_name or hashlib.sha256(exe.read_bytes()).hexdigest() != expected:
            raise ValueError('Pinned executable mismatch; do not execute')
    elif component == 'tunnel':
        lock_data = json.loads((ROOT/'tunnel-lock.json').read_text(encoding='utf-8'))
        if hashlib.sha256(exe.read_bytes()).hexdigest() != lock_data['binary_sha256']:
            raise ValueError('Tunnel executable mismatch')
    else:
        raise ValueError('Unknown managed component')
    if receipt.exists():
        old = json.loads(receipt.read_text(encoding='utf-8'))
        actual = inspect(old['pid'])
        if actual is not None:
            if actual != {k: old[k] for k in actual} or Path(actual['image']) != exe:
                raise RuntimeError('Recorded PID is not the owned process; inspect locally')
            return old
    if component == 'server':
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', PORTS[profile])) == 0:
                raise RuntimeError('Port already occupied without a matching process receipt')
    lock = base / (component + '-launch.lock')
    # An interrupted launch is intentionally not retried automatically.
    with lock.open('x', encoding='utf-8') as f:
        f.write(str(time.time()))
    env = clean_env()
    env.update(extra_env or {})
    with (ROOT / 'logs' / f'{profile}-{component}.log').open('ab') as log:
        p = subprocess.Popen(args, cwd=base, env=env, stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT, close_fds=True,
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
    row = inspect(p.pid)
    if row is None:
        raise RuntimeError('Process exited during launch; examine local log')
    write_json(receipt, {**row, 'argv': args, 'started_at_unix': time.time()})
    lock.unlink()
    time.sleep(0.25)
    if inspect(p.pid) != row:
        raise RuntimeError('Process did not remain running; see local log')
    return json.loads(receipt.read_text(encoding='utf-8'))

def start(profile: str) -> None:
    require_profile(profile)
    p = ROOT / 'profiles' / profile
    if not (p/'server.env').is_file():
        raise RuntimeError('General workspace not initialized. Follow GENERAL_SETUP.md locally; old profiles are not reused.')
    server = spawn(profile, 'server', [str(BIN/'webcodex-server.exe')],
                   {'WEBCODEX_ENV_FILE': str(p/'server.env')})
    print(profile, 'server PID', server['pid'])
    until = time.monotonic() + 10
    while time.monotonic() < until:
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', PORTS[profile])) == 0:
                break
        time.sleep(0.2)
    else:
        raise RuntimeError('Server not listening; not starting a second instance')
    receipt = p / 'login-summary.json'
    if receipt.exists():
        login = json.loads(receipt.read_text(encoding='utf-8-sig'))
        config = Path(login['runner_config'])
        if not config.resolve().is_relative_to(p):
            raise ValueError('Runner config is outside this profile')
        runner = spawn(profile, 'runner', [str(BIN/'webcodex-runner.exe'),'--config',str(config)])
        print(profile, 'runner PID', runner['pid'])
    else:
        print(profile, 'PAIRING_REQUIRED: server started only; follow GENERAL_SETUP.md')

def stop(profile: str) -> None:
    require_profile(profile)
    # Local emergency stop: compare identity and terminate using the SAME open handle.
    # This is not graceful application shutdown and does not certify all descendants exited.
    for name in ['tunnel', 'runner', 'server']:
        file = ROOT / 'profiles' / profile / (name + '-process.json')
        if not file.exists():
            continue
        old = json.loads(file.read_text(encoding='utf-8'))
        h = K.OpenProcess(0x1000 | 0x100000 | 0x1, False, old['pid'])
        if not h:
            if ctypes.get_last_error() == 87:
                continue
            raise OSError('Cannot open process for stop; refusing PID-only fallback')
        try:
            now = snapshot_handle(h, old['pid'])
            if now is None:
                continue
            if now != {k:old[k] for k in now}:
                raise RuntimeError('PID identity mismatch; not stopping foreign process')
            if not K.TerminateProcess(h, 1) or K.WaitForSingleObject(h, 8000) != 0:
                raise RuntimeError('Stop unconfirmed; inspect the same process')
            print(profile, name, 'stopped; jobs and external effects still need review')
        finally:
            K.CloseHandle(h)

def status(profile: str) -> None:
    require_profile(profile)
    for name in ['server','runner','tunnel']:
        f = ROOT / 'profiles' / profile / (name + '-process.json')
        if not f.exists():
            print(profile, name, 'NOT_CONFIGURED')
            continue
        old = json.loads(f.read_text(encoding='utf-8'))
        actual = inspect(old['pid'])
        print(profile, name, 'RUNNING' if actual and actual == {k:old[k] for k in actual} else 'NOT_OWNED_OR_EXITED', old['pid'])

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start','status','stop'])
    parser.add_argument('profile', choices=['workspace'], nargs='?', default='workspace')
    opt = parser.parse_args()
    globals()[opt.action](opt.profile)
