"""Explicit loopback worker handoff. No service discovery, secrets, jobs or model calls.
Prepare an exclusive on-disk envelope before sending; reconcile unknown replies by
its original request id. Only listed files inside an explicit root are inspected.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from task_domain import TaskError, absolute, bounded, obj, fingerprint, encoded
from task_collaboration import artifact_path, artifacts, MAX_ARTIFACT, MAX_ARTIFACT_TOTAL

MAX_DOCUMENT = 2 * 1024 * 1024


class WorkerError(ValueError):
    pass


def linked(path):
    s = path.lstat()
    return stat.S_ISLNK(s.st_mode) or bool(getattr(s, 'st_file_attributes', 0) & 0x400)


def explicit_root(value):
    path = Path(value)
    if not path.is_absolute(): raise WorkerError('explicit_absolute_root_required')
    chain = [path, *path.parents]
    if any(linked(p) for p in chain if p.exists()): raise WorkerError('linked_root_rejected')
    if not path.is_dir(): raise WorkerError('root_directory_missing')
    return path.resolve()


def confined(root, relative, new=False):
    relative = artifact_path(relative)
    path = root
    for part in relative.split('/'):
        path = path / part
        if path.is_symlink() or (path.exists() and linked(path)):
            raise WorkerError('linked_path_rejected')
    if not path.resolve().is_relative_to(root): raise WorkerError('path_outside_explicit_root')
    if new:
        if not path.parent.is_dir(): raise WorkerError('output_parent_missing')
    elif not path.is_file(): raise WorkerError('listed_file_missing')
    return path


def file_bytes(root, relative, maximum=MAX_ARTIFACT):
    path = confined(root, relative)
    before = path.stat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > maximum:
        raise WorkerError('not_a_bounded_plain_file')
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino): raise WorkerError('file_changed_before_open')
        data = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    if len(data) > maximum or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise WorkerError('file_changed_while_reading')
    return data


def load(root, relative):
    data = json.loads(file_bytes(root, relative, MAX_DOCUMENT))
    bounded(data)
    return data


def save_new(root, relative, value):
    path = confined(root, relative, new=True)
    data = (encoded(value) + '\n').encode('utf-8')
    if len(data) > MAX_DOCUMENT: raise WorkerError('document_too_large')
    # Never overwrite a prior assignment or accepted/unknown request envelope.
    with path.open('xb') as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    return path


def hash_files(root, names):
    if not isinstance(names, list) or not 1 <= len(names) <= 32: raise WorkerError('invalid_artifact_list')
    seen = set(); rows = []; total = 0
    for name in names:
        name = artifact_path(name)
        if name.casefold() in seen: raise WorkerError('duplicate_artifact')
        seen.add(name.casefold())
        data = file_bytes(root, name)
        total += len(data)
        if total > MAX_ARTIFACT_TOTAL: raise WorkerError('artifact_total_too_large')
        rows.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    return artifacts(rows)


def check_files(root, rows):
    expected = artifacts(rows)
    current = hash_files(root, [a['path'] for a in expected])
    return {'passed': current == expected, 'files': current, 'source': 'local_file_check_not_test_or_quality_verdict'}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise WorkerError('redirect_rejected')


class Client:
    def __init__(self, origin, store_id):
        if not isinstance(origin, str) or not re.fullmatch(r'http://127\.0\.0\.1:([0-9]{1,5})', origin):
            raise WorkerError('explicit_loopback_origin_required')
        if not 1 <= int(origin.rsplit(':', 1)[1]) <= 65535: raise WorkerError('invalid_port')
        if not isinstance(store_id, str) or not re.fullmatch(r'[0-9a-f]{32}', store_id): raise WorkerError('exact_store_id_required')
        self.origin, self.store_id = origin, store_id
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        self.info = self.get('info')
        if self.info.get('structured_deliveries') is not True: raise WorkerError('structured_delivery_not_loaded')

    def request(self, path, params=None, body=None):
        if path not in {'info', 'get', 'assignment', 'inbox', 'receipt', 'command', 'list', 'events', 'sessions', 'export', 'resources', 'communication-target'}: raise WorkerError('unsupported_product_route')
        url = self.origin + '/api/tasks/' + path + ('?' + urlencode(params) if params else '')
        headers = {'Origin': self.origin}
        if body is not None:
            headers.update({'Content-Type': 'application/json', 'X-CLW-Intent': self.info['intent']})
        request = Request(url, data=(encoded(body).encode('utf-8') if body is not None else None), headers=headers)
        try:
            with self.opener.open(request, timeout=12) as response:
                data = response.read(5 * 1024 * 1024 + 1)
        except HTTPError as exc:
            code = exc.code; exc.close()
            raise WorkerError('http_rejected_' + str(code) + '_retain_original_envelope') from None
        except (OSError, URLError):
            raise WorkerError('transport_unknown_reconcile_original_request') from None
        if len(data) > 5 * 1024 * 1024: raise WorkerError('oversized_response_reconcile_original_request')
        result = json.loads(data)
        if result.get('success') is not True: raise WorkerError('unconfirmed_result_reconcile_original_request')
        observed_store = result.get('store_id', result.get('assignment', {}).get('store_id'))
        if observed_store != self.store_id: raise WorkerError('wrong_store_no_send')
        return result

    def get(self, path, params=None):
        return self.request(path, params)

    def reconcile(self, envelope):
        validate_envelope(envelope, self.origin, self.store_id)
        command = envelope['command']
        reply = self.get('receipt', {'request_id': command['request_id']})
        if reply['found']:
            receipt = reply['receipt']
            if (receipt.get('request_fingerprint') != envelope['command_sha256'] or
                    receipt.get('store_id') != self.store_id or receipt.get('request_id') != command['request_id']):
                raise WorkerError('original_request_conflict_no_send')
        return reply

    def send(self, envelope, root):
        reply = self.reconcile(envelope)
        if reply['found']: return reply  # A later local file change cannot invalidate an existing receipt.
        if absolute(str(root)) != envelope['worktree']: raise WorkerError('explicit_root_mismatch')
        if not check_files(root, envelope['command']['data']['artifacts'])['passed']:
            raise WorkerError('artifacts_changed_no_send')
        result = self.request('command', body=envelope['command'])
        if result.get('request_fingerprint') != envelope['command_sha256']: raise WorkerError('unconfirmed_receipt_keep_envelope')
        return result


def validate_envelope(envelope, origin, store_id):
    obj(envelope, {'format', 'origin', 'store_id', 'worktree', 'command', 'command_sha256'},
        {'format', 'origin', 'store_id', 'worktree', 'command', 'command_sha256'})
    if envelope['format'] != 'clw.delivery-envelope.v1' or envelope['origin'] != origin or envelope['store_id'] != store_id:
        raise WorkerError('envelope_target_mismatch')
    command = envelope['command']
    if not isinstance(command, dict) or command.get('action') != 'deliver' or fingerprint(command) != envelope['command_sha256']:
        raise WorkerError('envelope_corrupt_or_not_delivery')


def prepare(packet, result, root, origin, actor):
    if packet.get('format') != 'clw.assignment.v1': raise WorkerError('unsupported_assignment')
    if absolute(str(root)) != packet['role']['worktree']: raise WorkerError('explicit_root_mismatch')
    required = {'summary', 'changes', 'tests', 'limitations', 'artifacts', 'original_jobs', 'stopped_writing', 'input_baseline', 'head_commit', 'account_label'}
    obj(result, required, required)
    if result['stopped_writing'] is not True: raise WorkerError('stop_writing_before_delivery')
    rows = hash_files(root, result['artifacts'])
    data = {**result, 'artifacts': rows, 'role_id': packet['role']['id'], 'assignment_fence': packet['assignment_fence'],
            'session_id': (packet['binding'] or {}).get('session_id'), 'project_id': packet['role']['project_id']}
    command = {'request_id': 'delivery-' + uuid.uuid4().hex, 'action': 'deliver', 'task_id': packet['task_id'],
               'expected_version': packet['task_version'], 'actor': actor, 'data': data}
    bounded(command)
    envelope = {'format': 'clw.delivery-envelope.v1', 'origin': origin, 'store_id': packet['store_id'],
                'worktree': packet['role']['worktree'], 'command': command, 'command_sha256': fingerprint(command)}
    return envelope


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for name in ('assignment', 'inbox', 'prepare-delivery', 'send', 'receipt', 'check-artifacts'):
        p = sub.add_parser(name)
        if name != 'check-artifacts':
            p.add_argument('--origin', required=True); p.add_argument('--store-id', required=True)
        if name not in {'inbox'}: p.add_argument('--root', required=True)
        if name == 'assignment':
            p.add_argument('--task', required=True); p.add_argument('--role', required=True); p.add_argument('--out', required=True)
        elif name == 'inbox': p.add_argument('--after', type=int, default=0)
        elif name == 'prepare-delivery':
            p.add_argument('--packet', required=True); p.add_argument('--result', required=True); p.add_argument('--actor', required=True); p.add_argument('--out', required=True)
        else: p.add_argument('--envelope', required=True)
    args = parser.parse_args()
    try:
        root = explicit_root(args.root) if hasattr(args, 'root') else None
        if args.action == 'prepare-delivery':
            packet = load(root, args.packet)
            if packet['store_id'] != args.store_id: raise WorkerError('wrong_store_no_prepare')
            # Preparation is offline and never sends a request.
            if not re.fullmatch(r'http://127\.0\.0\.1:[0-9]{1,5}', args.origin): raise WorkerError('explicit_loopback_origin_required')
            envelope = prepare(packet, load(root, args.result), root, args.origin, args.actor)
            save_new(root, args.out, envelope)
            result = {'prepared': True, 'request_id': envelope['command']['request_id'], 'sent': False, 'output': args.out}
        elif args.action == 'check-artifacts':
            envelope = load(root, args.envelope)
            validate_envelope(envelope, envelope['origin'], envelope['store_id'])
            if absolute(str(root)) != envelope['worktree']: raise WorkerError('explicit_root_mismatch')
            result = check_files(root, envelope['command']['data']['artifacts'])
        else:
            client = Client(args.origin, args.store_id)
            if args.action == 'inbox': result = client.get('inbox', {'after': args.after})
            elif args.action == 'assignment':
                packet = client.get('assignment', {'id': args.task, 'role': args.role})['assignment']
                if absolute(str(root)) != packet['role']['worktree']: raise WorkerError('explicit_root_mismatch')
                save_new(root, args.out, packet)
                result = {'saved': args.out, 'assignment_fence': packet['assignment_fence'], 'model_started': False}
            else:
                envelope = load(root, args.envelope)
                result = client.reconcile(envelope) if args.action == 'receipt' else client.send(envelope, root)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 1 if result.get('passed') is False else 0
    except (TaskError, WorkerError, OSError, ValueError, KeyError, TypeError, RecursionError) as exc:
        code = str(exc) if isinstance(exc, WorkerError) else exc.code if isinstance(exc, TaskError) else type(exc).__name__
        print(json.dumps({'success': False, 'error_code': code, 'instruction': 'Keep the original envelope; no automatic retry, model call or service change.'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
