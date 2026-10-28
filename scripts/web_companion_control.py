"""Local, explicitly paired Codex -> Edge Companion command broker.

No browser is opened, model is called, or server is started on import. Runtime
files are private metadata/receipts; a claimed command is never delivered again.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import ctypes
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import secrets
import socket
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import uuid

from product_runtime import FileLease

DEFAULT_PORT = 18946
DEFAULT_RUNTIME = Path(__file__).resolve().parents[1] / '.local' / 'web-companion-control'
TYPES = frozenset(('inspect', 'watch', 'unwatch', 'continue', 'send', 'reload', 'stop_generation', 'reload_extension', 'approve_tool'))
TERMINAL = frozenset(('completed', 'failed', 'unknown'))
ORIGIN_RE = re.compile(r'chrome-extension://[a-p]{32}\Z')
UUID_PART = r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
URL_RE = re.compile(r'https://chatgpt\.com/(?:g/[A-Za-z0-9_-]{1,128}/)?c/' + UUID_PART + r'\Z')
MAX_BODY = 524288
MAX_RESULT = 65536
MAX_STATE = 2097152
MAX_RECORD = 1048576  # Original request and pinned envelope both retain literal text.
MAX_PEERS = 32
MAX_INSTANCES = 32
MAX_QUEUED = 256
TTL_SECONDS = 600


class ControlError(ValueError):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')


def object_fields(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= value.keys() or value.keys() - set(required) - set(optional):
        raise ControlError('invalid_fields')
    return value


def bounded_string(value, maximum, code='invalid_string', empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value):
        raise ControlError(code)
    try:
        value.encode('utf-8')
    except UnicodeError:
        raise ControlError(code) from None
    return value


def identifier(value):
    bounded_string(value, 36, 'invalid_uuid')
    try:
        normalized = str(uuid.UUID(value))
    except ValueError:
        raise ControlError('invalid_uuid') from None
    if normalized != value.lower() or len(value) != 36:
        raise ControlError('invalid_uuid')
    return normalized


def chat_url(value):
    if not isinstance(value, str) or not URL_RE.fullmatch(value):
        raise ControlError('invalid_chat_url')
    return value


def tab_id(value):
    if type(value) is not int or value < 0 or value > 2147483647:
        raise ControlError('invalid_tab_id')
    return value


def document_id(value):
    return None if value is None else bounded_string(value, 128, 'invalid_document_id')


def page_snapshot(value):
    if not isinstance(value, list) or len(value) > 32:
        raise ControlError('invalid_pages')
    result, seen = [], set()
    for page in value:
        object_fields(page, ('tabId', 'url', 'documentId', 'enabled'))
        tid = tab_id(page['tabId'])
        if tid in seen or type(page['enabled']) is not bool:
            raise ControlError('invalid_pages')
        seen.add(tid)
        result.append(dict(tabId=tid, url=chat_url(page['url']),
                           documentId=document_id(page['documentId']), enabled=page['enabled']))
    return result


def bounded_result(value):
    # Limit both serialized size and depth/node count before recursive encoding.
    stack, nodes = [(value, 0)], 0
    while stack:
        item, depth = stack.pop()
        nodes += 1
        if depth > 16 or nodes > 8192:
            raise ControlError('invalid_result')
        if isinstance(item, dict):
            if any(not isinstance(key, str) or len(key) > 256 for key in item):
                raise ControlError('invalid_result')
            stack.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            stack.extend((child, depth + 1) for child in item)
        elif item is None or type(item) in (str, bool, int):
            pass
        elif type(item) is float and math.isfinite(item):
            pass
        else:
            raise ControlError('invalid_result')
    try:
        if len(encoded(value)) > MAX_RESULT:
            raise ControlError('result_too_large')
    except (ValueError, UnicodeError):
        raise ControlError('invalid_result') from None
    return value


def token_matches(actual, expected):
    return isinstance(actual, str) and len(actual) <= 128 and bool(expected) and hmac.compare_digest(actual.encode('utf-8'), expected.encode('utf-8'))


def private_directory(path):
    """Restrict the broker directory to the current user (and Windows SYSTEM)."""
    path = Path(path)
    if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
        raise ControlError('runtime_link_rejected')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != 'nt':
        path.chmod(0o700)
        return
    from ctypes import wintypes
    adv = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    adv.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    adv.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    adv.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    adv.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p]
    token, sid_string, descriptor = wintypes.HANDLE(), wintypes.LPWSTR(), ctypes.c_void_p()
    try:
        if not adv.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
            raise OSError('private directory token unavailable')
        size = wintypes.DWORD()
        adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        buf = ctypes.create_string_buffer(size.value)
        if not adv.GetTokenInformation(token, 1, buf, size, ctypes.byref(size)):
            raise OSError('private directory identity unavailable')
        sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
        if not adv.ConvertSidToStringSidW(sid, ctypes.byref(sid_string)):
            raise OSError('private directory identity unavailable')
        sddl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;' + sid_string.value + ')'
        if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise OSError('private directory ACL unavailable')
        if not adv.SetFileSecurityW(str(path), 0x80000004, descriptor):
            raise OSError('private directory ACL unavailable')
    finally:
        if token:
            kernel.CloseHandle(token)
        if sid_string:
            kernel.LocalFree(ctypes.cast(sid_string, ctypes.c_void_p))
        if descriptor:
            kernel.LocalFree(descriptor)


def atomic_write(path, value):
    if path.is_symlink():
        raise ControlError('runtime_link_rejected')
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    # Failed temporary files are intentionally retained for diagnosis.
    with os.fdopen(fd, 'wb') as stream:
        stream.write(encoded(value))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    if os.name != 'nt':
        directory = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def read_json(path, limit):
    if path.is_symlink() or path.stat().st_size > limit:
        raise ControlError('invalid_runtime_file')
    with path.open('rb') as stream:
        return json.loads(stream.read(limit + 1), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))


class Broker:
    def __init__(self, runtime_dir, poll_seconds=20):
        self.root = Path(runtime_dir).absolute()
        private_directory(self.root)
        self.lease = FileLease(self.root / '.owner.lock')
        self.lease.__enter__()
        try:
            self.condition = threading.Condition(threading.RLock())
            self.stopping = False
            self.poll_seconds = max(0, min(float(poll_seconds), 20))
            self.secret_path = self.root / 'operator-secret.json'
            if not self.secret_path.exists():
                atomic_write(self.secret_path, {'token': secrets.token_urlsafe(48)})
            secret = read_json(self.secret_path, 256)
            object_fields(secret, ('token',))
            self.operator_token = bounded_string(secret['token'], 128, 'invalid_operator_secret')
            if len(self.operator_token) < 32:
                raise ControlError('invalid_operator_secret')
            self.state_path = self.root / 'peers.json'
            self.state = read_json(self.state_path, MAX_STATE) if self.state_path.exists() else {'version': 1, 'peers': {}}
            migrated = self._validate_state()
            self.receipt_dir = self.root / 'receipts'
            private_directory(self.receipt_dir)
            self.commands = {}
            for path in self.receipt_dir.glob('*.json'):
                cid = identifier(path.stem)
                record = read_json(path, MAX_RECORD)
                self._validate_record(cid, record)
                self.commands[cid] = record
            if migrated:
                atomic_write(self.state_path, self.state)
        except BaseException:
            self.lease.__exit__(None, None, None)
            raise

    def _validate_state(self):
        object_fields(self.state, ('version', 'peers'))
        if self.state['version'] != 1 or not isinstance(self.state['peers'], dict) or len(self.state['peers']) > MAX_PEERS:
            raise ControlError('invalid_peer_state')
        migrated, identities = False, set()
        for pid, peer in self.state['peers'].items():
            if identifier(pid) != pid:
                raise ControlError('invalid_peer_state')
            object_fields(peer, ('origin', 'pairing_nonce', 'approved', 'allow_chats', 'instances',
                                 'active_instance', 'extension_version', 'pages', 'last_seen'), ('profile_id',))
            if not isinstance(peer['origin'], str) or not ORIGIN_RE.fullmatch(peer['origin']):
                raise ControlError('invalid_peer_state')
            identifier(peer['pairing_nonce'])
            if type(peer['approved']) is not bool or not isinstance(peer['allow_chats'], list) or len(peer['allow_chats']) > 128:
                raise ControlError('invalid_peer_state')
            for url in peer['allow_chats']:
                chat_url(url)
            page_snapshot(peer['pages'])
            bounded_string(peer['extension_version'], 32)
            identifier(peer['active_instance'])
            if 'profile_id' not in peer:
                # Legacy peers retain their exact identity, tokens, bindings and
                # receipt ownership. A new profile may then inherit origin trust.
                peer['profile_id'] = peer['active_instance']
                migrated = True
            profile_id = identifier(peer['profile_id'])
            identity = (peer['origin'], profile_id)
            if identity in identities:
                raise ControlError('duplicate_profile_identity')
            identities.add(identity)
            if not isinstance(peer['instances'], dict) or not 1 <= len(peer['instances']) <= MAX_INSTANCES:
                raise ControlError('invalid_peer_state')
            for nonce, token in peer['instances'].items():
                identifier(nonce)
                if token is not None and (not isinstance(token, str) or not 32 <= len(token) <= 128):
                    raise ControlError('invalid_peer_state')
            if peer['active_instance'] not in peer['instances']:
                raise ControlError('invalid_peer_state')
        return migrated

    @staticmethod
    def _request(body):
        object_fields(body, ('id', 'type', 'chatUrl', 'payload'), ('tabId', 'peer_id'))
        request = {'id': identifier(body['id']), 'type': body['type'], 'chatUrl': chat_url(body['chatUrl'])}
        if not isinstance(request['type'], str) or request['type'] not in TYPES:
            raise ControlError('invalid_command_type')
        payload = object_fields(body['payload'], (), ('text',))
        if 'text' in payload:
            bounded_string(payload['text'], 65536, 'invalid_text', empty=True)
            if request['type'] not in ('send', 'continue'):
                raise ControlError('text_not_supported')
        if request['type'] == 'send' and not payload.get('text'):
            raise ControlError('text_required')
        request['payload'] = deepcopy(payload)
        if 'tabId' in body:
            request['tabId'] = tab_id(body['tabId'])
        if 'peer_id' in body:
            request['peer_id'] = identifier(body['peer_id'])
        return request

    def _validate_record(self, cid, record):
        object_fields(record, ('request', 'command', 'peer_id', 'instance_nonce', 'state', 'created_at', 'expires_at'),
                      ('claimed_at', 'finished_at', 'result', 'error'))
        request = self._request(record['request'])
        if request['id'] != cid or record['state'] not in {'enqueued', 'claimed', *TERMINAL}:
            raise ControlError('invalid_receipt')
        command = object_fields(record['command'], ('id', 'type', 'tabId', 'chatUrl', 'documentId', 'payload'))
        if any(command[key] != request[key] for key in ('id', 'type', 'chatUrl', 'payload')):
            raise ControlError('invalid_receipt')
        tab_id(command['tabId'])
        document_id(command['documentId'])
        identifier(record['peer_id'])
        identifier(record['instance_nonce'])
        for key in ('created_at', 'expires_at', 'claimed_at', 'finished_at'):
            if key in record and (type(record[key]) not in (int, float) or not math.isfinite(record[key])):
                raise ControlError('invalid_receipt')
        if 'result' in record:
            bounded_result(record['result'])

    def close(self):
        with self.condition:
            self.stopping = True
            self.condition.notify_all()
        self.lease.__exit__(None, None, None)

    def _ensure_running(self):
        if self.stopping:
            raise ControlError('broker_state_unavailable', 503)

    def _save_state(self, state):
        try:
            atomic_write(self.state_path, state)
        except OSError:
            # os.replace may already have succeeded. Reconcile the original file
            # before accepting any further work rather than replaying a write.
            try:
                if self.state_path.exists():
                    actual = read_json(self.state_path, MAX_STATE)
                    if actual not in (state, self.state):
                        raise ControlError('unexpected_peer_state')
                    self.state = actual
            except (OSError, ValueError):
                self.stopping = True
                self.condition.notify_all()
            raise
        self.state = state

    def _save_record(self, record):
        cid = record['command']['id']
        path = self.receipt_dir / (cid + '.json')
        try:
            atomic_write(path, record)
        except OSError:
            try:
                if path.exists():
                    actual = read_json(path, MAX_RECORD)
                    self._validate_record(cid, actual)
                    if actual not in (record, self.commands.get(cid)):
                        raise ControlError('unexpected_receipt_state')
                    self.commands[cid] = actual
            except (OSError, ValueError):
                self.stopping = True
                self.condition.notify_all()
            raise
        self.commands[cid] = record

    def _expire(self):
        now = time.time()
        for record in list(self.commands.values()):
            if record['state'] == 'enqueued' and now >= record['expires_at']:
                updated = deepcopy(record)
                updated.update(state='failed', finished_at=now, error='expired_before_claim')
                self._save_record(updated)

    def _redact(self, value):
        tokens = [self.operator_token]
        tokens.extend(token for peer in self.state['peers'].values() for token in peer['instances'].values() if token)
        def walk(item):
            if isinstance(item, str):
                for token in tokens:
                    item = item.replace(token, '[redacted]')
                return item
            if isinstance(item, dict):
                return {walk(key): ('[redacted]' if key.lower() in {'peer_token', 'operator_token', 'authorization', 'x-clw-peer', 'x-clw-operator'} else walk(child)) for key, child in item.items()}
            if isinstance(item, list):
                return [walk(child) for child in item]
            return item
        return walk(value)

    def _public_receipt(self, record):
        command = record['command']
        public = {key: command[key] for key in ('id', 'type', 'tabId', 'chatUrl', 'documentId')}
        public.update({key: record[key] for key in ('state', 'created_at', 'expires_at', 'claimed_at', 'finished_at', 'error', 'result') if key in record})
        public['peer_id'] = record['peer_id']
        return self._redact(public)

    @staticmethod
    def _public_peer(pid, peer, pairing=False):
        public = {key: deepcopy(peer[key]) for key in ('origin', 'profile_id', 'approved', 'allow_chats', 'extension_version', 'pages', 'last_seen')}
        public['peer_id'] = pid
        public['ready'] = bool(peer['approved'] and peer['instances'].get(peer['active_instance']))
        if pairing:
            public['pairing_nonce'] = peer['pairing_nonce']
        return public

    def register(self, origin, body):
        object_fields(body, ('extension_version', 'profile_id', 'instance_nonce', 'pages'))
        version = bounded_string(body['extension_version'], 32, 'invalid_extension_version')
        profile = identifier(body['profile_id'])
        nonce, pages = identifier(body['instance_nonce']), page_snapshot(body['pages'])
        with self.condition:
            self._ensure_running()
            state = deepcopy(self.state)
            matches = [(pid, peer) for pid, peer in state['peers'].items()
                       if peer['origin'] == origin and peer['profile_id'] == profile]
            trusted = [peer for peer in state['peers'].values() if peer['origin'] == origin and peer['approved']]
            inherited_chats = sorted({url for peer in trusted for url in peer['allow_chats']})
            if len(inherited_chats) > 128:
                raise ControlError('chat_allowlist_limit', 409)
            previous_instance = None
            if not matches:
                if len(state['peers']) >= MAX_PEERS:
                    raise ControlError('peer_limit', 409)
                pid = str(uuid.uuid4())
                peer = {'origin': origin, 'profile_id': profile, 'pairing_nonce': str(uuid.uuid4()), 'approved': bool(trusted),
                        'allow_chats': inherited_chats, 'instances': {}, 'active_instance': nonce,
                        'extension_version': version, 'pages': pages, 'last_seen': time.time()}
                state['peers'][pid] = peer
            else:
                pid, peer = matches[0]
                previous_instance = peer['active_instance']
                # Profiles that registered before the first local approval can
                # acquire the same durable origin trust on their next register.
                if not peer['approved'] and trusted:
                    peer.update(approved=True, allow_chats=inherited_chats)
            fresh_instance = nonce not in peer['instances']
            if fresh_instance:
                if len(peer['instances']) >= MAX_INSTANCES:
                    raise ControlError('instance_limit', 409)
                peer['instances'][nonce] = None
            peer.update(active_instance=nonce, extension_version=version, pages=pages, last_seen=time.time())
            if peer['approved'] and not peer['instances'][nonce]:
                peer['instances'][nonce] = secrets.token_urlsafe(48)
            if previous_instance is not None and previous_instance != nonce and fresh_instance:
                # The same origin/profile has now actually presented another
                # worker instance. This proves restart, not source-code identity.
                # Persist that evidence before replacing the active instance so
                # an uncertain write cannot discard the original reconciliation.
                for record in list(self.commands.values()):
                    if (record['peer_id'] == pid and record['instance_nonce'] == previous_instance
                            and record['command']['type'] == 'reload_extension'
                            and record['state'] in ('claimed', 'unknown') and 'claimed_at' in record):
                        verified = deepcopy(record)
                        verified.update(state='completed', finished_at=time.time(), result={
                            'extension_restart_verified': True, 'extension_version': version,
                            'evidence_source': 'extension_registration'})
                        self._save_record(verified)
            self._save_state(state)
            response = {'success': True, 'approved': peer['approved'], 'peer_id': pid}
            if peer['approved']:
                response['peer_token'] = peer['instances'][nonce]
            else:
                response['pairing_nonce'] = peer['pairing_nonce']
            self.condition.notify_all()
            return response

    def _authenticate_peer(self, origin, token, pid):
        pid = identifier(pid)
        peer = self.state['peers'].get(pid)
        if not peer or not peer['approved'] or peer['origin'] != origin:
            raise ControlError('peer_not_authorized', 403)
        nonce = peer['active_instance']
        expected = peer['instances'].get(nonce)
        if not token_matches(token, expected):
            raise ControlError('peer_not_authorized', 403)
        return pid, peer, nonce

    def poll(self, origin, token, body):
        object_fields(body, ('peer_id', 'pages'))
        pages = page_snapshot(body['pages'])
        with self.condition:
            self._ensure_running()
            pid, _, nonce = self._authenticate_peer(origin, token, body['peer_id'])
            state = deepcopy(self.state)
            state['peers'][pid].update(pages=pages, last_seen=time.time())
            self._save_state(state)
            deadline = time.monotonic() + self.poll_seconds
            while not self.stopping:
                _, peer, active_nonce = self._authenticate_peer(origin, token, pid)
                if active_nonce != nonce:
                    raise ControlError('peer_instance_changed', 409)
                self._expire()
                for record in sorted(self.commands.values(), key=lambda item: (item['created_at'], item['command']['id'])):
                    if record['state'] != 'enqueued' or record['peer_id'] != pid or record['instance_nonce'] != nonce:
                        continue
                    command = record['command']
                    matching = any(page['url'] == command['chatUrl'] and page['tabId'] == command['tabId']
                                   and page['documentId'] == command['documentId'] for page in peer['pages'])
                    if not matching:
                        updated = deepcopy(record)
                        updated.update(state='failed', finished_at=time.time(), error='page_binding_changed_before_claim')
                        self._save_record(updated)
                        continue
                    updated = deepcopy(record)
                    updated.update(state='claimed', claimed_at=time.time())
                    self._save_record(updated)  # Durable BEFORE anything is returned.
                    self.condition.notify_all()
                    return {'success': True, 'command': deepcopy(command)}
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.condition.wait(remaining)
            return {'success': True, 'command': None}

    def result(self, origin, token, body):
        object_fields(body, ('peer_id', 'command_id', 'state', 'result'))
        cid = identifier(body['command_id'])
        if not isinstance(body['state'], str) or body['state'] not in TERMINAL:
            raise ControlError('invalid_result_state')
        result = bounded_result(body['result'])
        with self.condition:
            self._ensure_running()
            pid, _, nonce = self._authenticate_peer(origin, token, body['peer_id'])
            record = self.commands.get(cid)
            if not record or record['peer_id'] != pid or record['instance_nonce'] != nonce or 'claimed_at' not in record:
                raise ControlError('command_not_owned', 409)
            if record['state'] in TERMINAL:
                same_result = json.dumps(record.get('result'), ensure_ascii=False, allow_nan=False, sort_keys=True) == json.dumps(result, ensure_ascii=False, allow_nan=False, sort_keys=True)
                if record['state'] != body['state'] or not same_result:
                    raise ControlError('result_conflict', 409)
            elif record['state'] == 'claimed':
                record = deepcopy(record)
                record.update(state=body['state'], result=deepcopy(result), finished_at=time.time())
                self._save_record(record)
            else:
                raise ControlError('command_not_claimed', 409)
            self.condition.notify_all()
            return {'success': True, 'receipt': self._public_receipt(record)}

    def status(self):
        with self.condition:
            self._ensure_running()
            self._expire()
            counts = {state: sum(record['state'] == state for record in self.commands.values()) for state in ('enqueued', 'claimed', 'completed', 'failed', 'unknown')}
            return self._redact({'success': True, 'peers': [self._public_peer(pid, peer) for pid, peer in self.state['peers'].items()], 'commands': counts})

    def pending(self):
        with self.condition:
            self._ensure_running()
            return self._redact({'success': True, 'peers': [self._public_peer(pid, peer, True) for pid, peer in self.state['peers'].items() if not peer['approved']]})

    def approve(self, body):
        object_fields(body, ('peer_id', 'pairing_nonce', 'allow_chat'))
        pid, nonce = identifier(body['peer_id']), identifier(body['pairing_nonce'])
        urls = body['allow_chat'] if isinstance(body['allow_chat'], list) else [body['allow_chat']]
        if not 1 <= len(urls) <= 128:
            raise ControlError('invalid_allow_chats')
        urls = [chat_url(url) for url in urls]
        with self.condition:
            self._ensure_running()
            peer = self.state['peers'].get(pid)
            if not peer or not hmac.compare_digest(peer['pairing_nonce'], nonce):
                raise ControlError('pairing_not_found', 409)
            state = deepcopy(self.state)
            peer = state['peers'][pid]
            combined = sorted(set(peer['allow_chats']) | set(urls))
            if len(combined) > 128:
                raise ControlError('chat_allowlist_limit', 409)
            peer.update(approved=True, allow_chats=combined)
            self._save_state(state)
            self.condition.notify_all()
            return {'success': True, 'peer': self._public_peer(pid, peer, True)}

    def command(self, body):
        request = self._request(body)
        with self.condition:
            self._ensure_running()
            self._expire()
            prior = self.commands.get(request['id'])
            if prior:
                if prior['request'] != request:
                    raise ControlError('operation_id_conflict', 409)
                return {'success': True, 'receipt': self._public_receipt(prior)}
            candidates = []
            for pid, peer in self.state['peers'].items():
                if not peer['approved'] or ('peer_id' in request and pid != request['peer_id']):
                    continue
                if not peer['instances'].get(peer['active_instance']):
                    continue
                for page in peer['pages']:
                    # Only the authenticated local operator can enqueue work.
                    # allow_chats records initial pairing; approval covers any
                    # registered exact ChatGPT conversation, including unbound
                    # monitors that the operator explicitly chooses to start.
                    if page['url'] == request['chatUrl'] and ('tabId' not in request or page['tabId'] == request['tabId']):
                        candidates.append((pid, peer, page))
            if len(candidates) != 1:
                raise ControlError('no_authorized_page' if not candidates else 'ambiguous_page_use_tab_or_peer_id', 409)
            if sum(record['state'] == 'enqueued' for record in self.commands.values()) >= MAX_QUEUED:
                raise ControlError('queue_limit', 409)
            pid, peer, page = candidates[0]
            command = {key: deepcopy(request[key]) for key in ('id', 'type', 'chatUrl', 'payload')}
            command.update(tabId=page['tabId'], documentId=page['documentId'])
            now = time.time()
            record = {'request': request, 'command': command, 'peer_id': pid, 'instance_nonce': peer['active_instance'],
                      'state': 'enqueued', 'created_at': now, 'expires_at': now + TTL_SECONDS}
            self._save_record(record)
            self.condition.notify_all()
            return {'success': True, 'receipt': self._public_receipt(record)}

    def receipt(self, cid):
        cid = identifier(cid)
        with self.condition:
            self._ensure_running()
            self._expire()
            if cid not in self.commands:
                raise ControlError('receipt_not_found', 404)
            return {'success': True, 'receipt': self._public_receipt(self.commands[cid])}


class ControlServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def server_close(self):
        super().server_close()
        if getattr(self, 'broker', None):
            self.broker.close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    server_version = 'CLWCompanionControl/1'

    def log_message(self, *_):
        pass  # Never log tokens, request bodies, or page content.

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def _host(self):
        port = self.server.server_address[1]
        if self.headers.get_all('Host', []) not in ([f'127.0.0.1:{port}'], [f'localhost:{port}']):
            raise ControlError('invalid_host', 403)

    def _extension(self):
        self._host()
        origins = self.headers.get_all('Origin', [])
        if len(origins) != 1 or not ORIGIN_RE.fullmatch(origins[0]):
            raise ControlError('invalid_extension_origin', 403)
        return origins[0]

    def _operator(self):
        self._host()
        if 'Origin' in self.headers:
            raise ControlError('operator_browser_origin_rejected', 403)
        tokens = self.headers.get_all('X-CLW-Operator', [])
        if len(tokens) != 1 or not token_matches(tokens[0], self.server.broker.operator_token):
            raise ControlError('operator_not_authorized', 403)

    def _body(self):
        if self.headers.get_all('Content-Type', []) != ['application/json'] or 'Transfer-Encoding' in self.headers:
            raise ControlError('json_required', 415)
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) != 1 or not lengths[0].isdigit() or not 0 < int(lengths[0]) <= MAX_BODY:
            raise ControlError('invalid_body_length', 413)
        data = self.rfile.read(int(lengths[0]))
        if len(data) != int(lengths[0]):
            raise ControlError('incomplete_body')
        try:
            return json.loads(data, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError, RecursionError):
            raise ControlError('invalid_json') from None

    def _respond(self, code, value, cors=None, preflight=False):
        data = encoded(value) if value is not None else b''
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cors:
            self.send_header('Access-Control-Allow-Origin', cors)
            self.send_header('Vary', 'Origin')
            if preflight:
                self.send_header('Access-Control-Allow-Methods', 'POST')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-CLW-Peer')
                self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _run(self, method):
        cors = None
        try:
            path = urlsplit(self.path)
            if path.scheme or path.netloc or path.fragment:
                raise ControlError('invalid_path', 404)
            extension_routes = ('/extension/register', '/extension/poll', '/extension/result')
            if path.path in extension_routes:
                cors = self._extension()
                if path.query:
                    raise ControlError('invalid_path', 404)
                if method == 'OPTIONS':
                    requested = self.headers.get('Access-Control-Request-Method')
                    headers = {part.strip().lower() for part in self.headers.get('Access-Control-Request-Headers', '').split(',') if part.strip()}
                    if requested != 'POST' or headers - {'content-type', 'x-clw-peer'}:
                        raise ControlError('preflight_rejected', 403)
                    self._respond(204, None, cors, True)
                    return
                if method != 'POST':
                    raise ControlError('method_not_allowed', 405)
                body = self._body()
                broker = self.server.broker
                if path.path == '/extension/register':
                    result = broker.register(cors, body)
                else:
                    tokens = self.headers.get_all('X-CLW-Peer', [])
                    if len(tokens) != 1:
                        raise ControlError('peer_not_authorized', 403)
                    action = broker.poll if path.path.endswith('/poll') else broker.result
                    result = action(cors, tokens[0], body)
            else:
                self._operator()
                broker = self.server.broker
                if method == 'GET' and not path.query and path.path == '/operator/status':
                    result = broker.status()
                elif method == 'GET' and not path.query and path.path == '/operator/pending':
                    result = broker.pending()
                elif method == 'GET' and path.path == '/operator/receipt':
                    query = parse_qs(path.query, keep_blank_values=True)
                    if set(query) != {'id'} or len(query['id']) != 1:
                        raise ControlError('invalid_fields')
                    result = broker.receipt(query['id'][0])
                elif method == 'POST' and not path.query and path.path in ('/operator/approve', '/operator/command'):
                    action = broker.approve if path.path.endswith('/approve') else broker.command
                    result = action(self._body())
                else:
                    raise ControlError('route_not_found', 404)
            self._respond(200, result, cors)
        except ControlError as exc:
            self._respond(exc.status, {'success': False, 'error': exc.code}, cors)
        except (OSError, ValueError, TypeError, KeyError, RecursionError):
            self._respond(500, {'success': False, 'error': 'broker_state_unavailable'}, cors)

    def do_GET(self):
        self._run('GET')

    def do_POST(self):
        self._run('POST')

    def do_OPTIONS(self):
        self._run('OPTIONS')


def create_server(port=DEFAULT_PORT, runtime_dir=DEFAULT_RUNTIME, poll_seconds=20):
    if type(port) is not int or not 0 <= port <= 65535:
        raise ControlError('invalid_port')
    broker = Broker(runtime_dir, poll_seconds)
    try:
        server = ControlServer(('127.0.0.1', port), Handler)
        server.broker = broker
        return server
    except BaseException:
        broker.close()
        raise


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ControlError('redirect_rejected')


def operator_request(runtime_dir, port, path, body=None, timeout=10):
    # Secret never crosses a redirect, proxy, browser page, or console output.
    secret = read_json(Path(runtime_dir) / 'operator-secret.json', 256)['token']
    headers = {'X-CLW-Operator': secret}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    request = Request(f'http://127.0.0.1:{port}{path}', data=None if body is None else encoded(body), headers=headers)
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            data = response.read(400001)
        if len(data) > 400000:
            raise ControlError('response_too_large')
        return json.loads(data)
    except HTTPError as exc:
        # Only expose the broker's static error code, never arbitrary HTTP data.
        try:
            code = json.loads(exc.read(1024)).get('error', '')
        except (ValueError, UnicodeError):
            code = ''
        raise ControlError(code if re.fullmatch(r'[a-z_]{1,80}', code) else 'http_request_failed', exc.code) from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', type=Path, default=DEFAULT_RUNTIME)
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('serve')
    sub.add_parser('status')
    sub.add_parser('pending')
    approve = sub.add_parser('approve')
    approve.add_argument('--peer-id', required=True)
    approve.add_argument('--pairing-nonce', required=True)
    approve.add_argument('--allow-chat', action='append', required=True)
    command = sub.add_parser('command')
    command.add_argument('--url', required=True)
    command.add_argument('--type', choices=sorted(TYPES), required=True)
    command.add_argument('--id')
    command.add_argument('--tab-id', type=int)
    command.add_argument('--peer-id')
    text = command.add_mutually_exclusive_group()
    text.add_argument('--text')
    text.add_argument('--text-file', type=Path)
    command.add_argument('--wait-seconds', type=float, default=0)
    receipt = sub.add_parser('receipt')
    receipt.add_argument('--id', required=True)
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.port <= 65535:
            raise ControlError('invalid_port')
        if args.action == 'serve':
            server = create_server(args.port, args.runtime_dir)
            print(json.dumps({'success': True, 'state': 'listening', 'port': args.port}), flush=True)
            try:
                server.serve_forever(poll_interval=0.25)
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
            return 0
        path, body = '/operator/' + args.action, None
        if args.action == 'approve':
            body = {'peer_id': args.peer_id, 'pairing_nonce': args.pairing_nonce, 'allow_chat': args.allow_chat}
        elif args.action == 'receipt':
            path += '?id=' + identifier(args.id)
        elif args.action == 'command':
            if not math.isfinite(args.wait_seconds) or not 0 <= args.wait_seconds <= 30:
                raise ControlError('invalid_wait_seconds')
            payload = {}
            if args.text_file is not None:
                if args.text_file.stat().st_size > 262144:
                    raise ControlError('invalid_text')
                with args.text_file.open('rb') as stream:
                    contents = stream.read(262145)
                if len(contents) > 262144:
                    raise ControlError('invalid_text')
                payload['text'] = contents.decode('utf-8')
            elif args.text is not None:
                payload['text'] = args.text
            body = {'id': identifier(args.id) if args.id else str(uuid.uuid4()), 'type': args.type, 'chatUrl': args.url, 'payload': payload}
            if args.tab_id is not None:
                body['tabId'] = args.tab_id
            if args.peer_id is not None:
                body['peer_id'] = args.peer_id
        response = operator_request(args.runtime_dir, args.port, path, body)
        if args.action == 'command' and args.wait_seconds:
            deadline = time.monotonic() + args.wait_seconds
            while response['receipt']['state'] not in TERMINAL and time.monotonic() < deadline:
                time.sleep(min(0.2, max(0, deadline - time.monotonic())))
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                response = operator_request(args.runtime_dir, args.port, '/operator/receipt?id=' + body['id'], timeout=min(10, remaining))
        print(json.dumps(response, ensure_ascii=False, allow_nan=False))
        return 0
    except (ControlError, OSError, ValueError, KeyError, URLError) as exc:
        code = exc.code if isinstance(exc, ControlError) else 'local_broker_unavailable'
        print(json.dumps({'success': False, 'error': code}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
