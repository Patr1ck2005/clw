"""Continue the exact ten isolated native Sessions for 100 one-file HTTP reads.

The earlier acceptance proof remains immutable. Captured successful responses
are reusable evidence: a resumed verifier does not repeat accepted read calls.
No browser, platform request, model request, or production configuration.
"""
from pathlib import Path
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import re
import subprocess
import sys
import threading
import time
import uuid
from unittest.mock import patch
from urllib.request import Request, build_opener, ProxyHandler

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import preview_connections as connections
import preview_installation as installation
from product_runtime import atomic_json
from windows_process_owner import process_inventory


def walk(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', required=True, type=Path)
    parser.add_argument('--round', default='')
    args = parser.parse_args()
    root = args.work_dir.resolve()
    original = json.loads((root / 'verification.json').read_text())
    prior = original.get('concurrent_read_receipts', [])
    if original.get('state') != 'passed' or len(prior) != 10 or sorted(item['lane'] for item in prior) != list(range(10)):
        raise SystemExit('The original successful ten-Session proof is required')
    if args.round and not re.fullmatch('[a-z0-9-]{1,32}', args.round):
        raise SystemExit('Invalid acceptance round name')
    suffix = '-' + args.round if args.round else ''
    output = root / ('100requests' + suffix + '.json')
    if output.exists() and json.loads(output.read_text()).get('state') == 'passed':
        raise SystemExit('The completed proof is immutable; inspect 100requests.json')
    manifest = installation.load(root)
    if manifest.get('auto_connect') is not False or any(installation.credential_path(root, item['id']).exists()
                                                      for item in manifest['accounts']):
        raise SystemExit('This verifier requires the isolated no-platform-key setup')
    evidence = installation.private_home(root) / ('acceptance-100-replies' + suffix)
    evidence.mkdir(exist_ok=True)
    created = []
    original_popen = subprocess.Popen
    report = {'schema': 1, 'model_calls': 0, 'platform_calls': 0, 'production_config_reads': 0,
              'installation_id': manifest['installation_id'], 'original_proof': 'verification.json',
              'original_proof_sha256': hashlib.sha256((root / 'verification.json').read_bytes()).hexdigest(),
              'lanes': 10, 'requests_per_lane': 10, 'files_per_request': 1}
    def capture(*arguments, **options):
        child = original_popen(*arguments, **options)
        created.append(child)
        return child
    try:
        with patch.object(subprocess, 'Popen', side_effect=capture):
            connections.connect(root)
        for _ in range(30):
            status = connections.check(root)
            if status['components'] == {'server': 'ready', 'runner': 'ready'}:
                break
            time.sleep(.3)
        if status['components'] != {'server': 'ready', 'runner': 'ready'}:
            raise AssertionError('the original isolated backend did not become ready')
        report['owners_before'] = status['owners']
        config = connections._backend_config(root)
        token = connections.backend._mcp_server_token(config)
        def post(path, payload, *, headers=None, request_id=None):
            selected = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                        'Accept': 'application/json, text/event-stream', **(headers or {})}
            request = Request(config['origin'] + path, data=json.dumps(payload).encode(), headers=selected, method='POST')
            with build_opener(ProxyHandler({}), connections.backend.NoRedirect()).open(request, timeout=60) as response:
                value = connections.backend._mcp_initialize_response(response, request_id, time.monotonic() + 60)
                return value, response.headers.get('Mcp-Session-Id'), response.status
        projects, _, _ = post('/api/runtime-console/projects', {'limit': 100})
        mappings = {}
        for project in projects.get('projects', []):
            project_id = project.get('project_id') or project.get('id')
            sessions, _, _ = post('/api/runtime-console/workflow-sessions', {'project': project_id, 'limit': 50})
            for session in sessions.get('sessions', []):
                mappings[session['session_id']] = project_id
        if any(item['session_id'] not in mappings for item in prior):
            raise AssertionError('an original exact native Session is missing')
        initialize_id = uuid.uuid4().hex
        initialized, transport_session, _ = post('/mcp', {'jsonrpc': '2.0', 'id': initialize_id, 'method': 'initialize',
            'params': {'protocolVersion': '2025-06-18', 'capabilities': {},
                       'clientInfo': {'name': 'preview-original-session-100requests', 'version': '1'}}},
            headers={'Mcp-Protocol-Version': '2025-06-18', 'Mcp-Method': 'initialize'}, request_id=initialize_id)
        if initialized.get('id') != initialize_id or initialized.get('error'):
            raise AssertionError('native MCP initialization identity failed')
        barrier = threading.Barrier(10)
        def lane_read(prior_lane):
            lane = prior_lane['lane']
            session_id = prior_lane['session_id']
            project_id = mappings[session_id]
            verified = []
            barrier.wait(timeout=20)
            for item in range(10):
                relative = 'read-lane-' + str(lane) + '/item-' + str(item) + '.txt'
                expected = (root / 'project-one' / relative).read_text(encoding='utf8').strip()
                path = evidence / ('lane-' + str(lane) + '-item-' + str(item) + '.json')
                if path.exists():
                    receipt = json.loads(path.read_text())
                    if receipt.get('session_id') != session_id or receipt.get('project_id') != project_id or receipt.get('path') != relative:
                        raise AssertionError('a prior read receipt has changed identity')
                else:
                    request_id = uuid.uuid4().hex
                    arguments = {'project': project_id, 'session_id': session_id,
                        'items': [{'path': relative, 'limit': 5}], 'with_line_numbers': False}
                    headers = {'Mcp-Protocol-Version': '2025-06-18', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'read_files'}
                    if transport_session:
                        headers['Mcp-Session-Id'] = transport_session
                    started = time.monotonic()
                    raw, _, http_status = post('/mcp', {'jsonrpc': '2.0', 'id': request_id, 'method': 'tools/call',
                        'params': {'name': 'read_files', 'arguments': arguments}}, headers=headers, request_id=request_id)
                    receipt = {'request_id': request_id, 'session_id': session_id, 'project_id': project_id,
                        'path': relative, 'http_status': http_status, 'elapsed_ms': round((time.monotonic() - started) * 1000, 3),
                        'response': raw}
                    atomic_json(path, receipt)
                raw = receipt['response']
                if raw.get('id') != receipt['request_id'] or raw.get('error') or receipt['http_status'] != 200:
                    raise AssertionError('native response RPC identity did not match its exact read request')
                result = raw.get('result', {})
                value = result.get('structuredContent')
                if not isinstance(value, dict):
                    for content in result.get('content', []):
                        if content.get('type') == 'text':
                            try:
                                value = json.loads(content['text'])
                                break
                            except ValueError:
                                pass
                if not isinstance(value, dict) or value.get('success') is False:
                    raise AssertionError('native one-file read did not succeed')
                body = value.get('output', value)
                nodes = list(walk(body))
                serialized = json.dumps(body, ensure_ascii=False)
                revisions = [node['read_revision'] for node in nodes if type(node.get('read_revision')) is int and node['read_revision'] > 0]
                result_ids = [node['result_id'] for node in nodes if isinstance(node.get('result_id'), str) and node['result_id']]
                returned_path = any(relative == node.get('path') and node.get('index') == 0 for node in nodes)
                texts = [node['text'] for node in nodes if isinstance(node.get('text'), str) and node['text'].strip() == expected]
                if (body.get('succeeded_count') != 1 or body.get('project') != project_id or not texts or not revisions or not returned_path):
                    report['sample_output_keys'] = list(body)
                    report['sample_nested_keys'] = sorted({key for node in nodes for key in node})
                    raise AssertionError('native content/project/path/read_revision/RPC-result identity verification failed')
                verified.append({'lane': lane, 'item': item, 'session_id': session_id, 'project_id': project_id,
                    'request_id': receipt['request_id'], 'http_status': 200, 'path': relative,
                    'read_revision': revisions[0], 'rpc_result_id': raw['id'],
                    'native_result_id': result_ids[0] if result_ids else None,
                    'content_sha256': hashlib.sha256(texts[0].strip().encode()).hexdigest(),
                    'expected_content_sha256': hashlib.sha256(expected.encode()).hexdigest(),
                    'elapsed_ms': receipt['elapsed_ms'], 'response_sha256': hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()})
            return verified
        with ThreadPoolExecutor(max_workers=10) as executor:
            lanes = list(executor.map(lane_read, prior))
        receipts = [item for lane in lanes for item in lane]
        if len(receipts) != 100 or len({item['request_id'] for item in receipts}) != 100:
            raise AssertionError('one hundred independent exact requests were not verified')
        report['owners_after'] = connections.check(root)['owners']
        if report['owners_after'] != report['owners_before']:
            raise AssertionError('an isolated backend owner changed during the hundred reads')
        report['receipts'] = receipts
        report['requests_verified'] = 100
        report['original_sessions_reused'] = [item['session_id'] for item in prior]
        report['state'] = 'passed'
    except Exception as error:
        report['state'] = 'failed'
        report['failure_type'] = type(error).__name__
        report['code'] = str(error) if isinstance(error, (AssertionError, installation.PreviewError)) else 'native_read_verification_failed'
    finally:
        owners = connections._owners(root, manifest)['owners']
        stopped = []
        for child in reversed(created):
            if child.poll() is not None:
                continue
            expected = [value for value in owners.values() if value['pid'] == child.pid]
            rows = process_inventory(target_names=connections.NAMES, candidate_filter=lambda row: row['ProcessId'] == child.pid)
            exact = [row for row in rows if row['ProcessId'] == child.pid and row.get('ExecutablePath')]
            if (len(expected) != 1 or len(exact) != 1 or exact[0]['CreationFiletime'] != expected[0]['creation_filetime']
                    or connections._norm(exact[0]['ExecutablePath']) != connections._norm(expected[0]['executable'])):
                report['cleanup_unverified_owner_retained'] = True
                continue
            child.terminate()
            child.wait(timeout=10)
            stopped.append({'pid': child.pid, 'creation_filetime': expected[0]['creation_filetime']})
        report['stopped_owned_children'] = stopped
        report['all_direct_children_exited'] = all(child.poll() is not None for child in created)
        atomic_json(output, report)
    print(json.dumps({key: value for key, value in report.items() if key != 'receipts'}, ensure_ascii=True))
    return 0 if report['state'] == 'passed' and report['all_direct_children_exited'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
