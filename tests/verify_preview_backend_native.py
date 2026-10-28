"""Opt-in fresh preview bootstrap/login/registration acceptance, no platform key.

Caller selects an isolated work directory and read-only native binary sources.
Only directly created Popen handles are stopped, after exact native identity
checks. There is no model call, tunnel credential, production config or browser.
"""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
import secrets
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, build_opener, ProxyHandler
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import preview_installation as installation
import preview_connections as connections
from windows_process_owner import process_inventory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary-dir', type=Path, required=True)
    parser.add_argument('--tunnel-binary', type=Path, required=True)
    parser.add_argument('--work-dir', type=Path, required=True)
    parser.add_argument('--empty-initial-roots', action='store_true')
    parser.add_argument('--concurrent-read', action='store_true')
    args = parser.parse_args()
    root = args.work_dir.resolve()
    if root.exists():
        raise SystemExit('A fresh isolated directory is required')
    if not root.parent.is_dir():
        raise SystemExit('The selected parent directory must already be available')
    root.mkdir()
    native = root / 'runtime/native'
    native.mkdir(parents=True)
    hashes = {}
    for role, name in installation.BINARY_NAMES.items():
        source = args.tunnel_binary if role == 'tunnel' else args.binary_dir / name
        if not source.is_file():
            raise SystemExit('Missing explicitly selected binary')
        hashes[role] = hashlib.sha256(source.read_bytes()).hexdigest()
        shutil.copy2(source, native / name)
    project = root / 'project-one'
    project.mkdir()
    (project / 'AGENTS.md').write_text('Independent free-preview native acceptance only.\n')
    expected = {(lane, item): 'CLW_NATIVE_READ_' + secrets.token_hex(20)
                for lane in range(10) for item in range(10)} if args.concurrent_read else {}
    def write_fixtures(folder):
        for (lane, item), marker in expected.items():
            target = folder / ('read-lane-' + str(lane)) / ('item-' + str(item) + '.txt')
            target.parent.mkdir(exist_ok=True)
            target.write_text(marker + '\n', encoding='utf8')
    write_fixtures(project)
    manifest = installation.defaults(root)
    manifest['projectRoots'] = [] if args.empty_initial_roots else [str(project)]
    manifest['auto_connect'] = False
    created = []
    checks = []
    report = {'schema': 1, 'model_calls': 0, 'platform_calls': 0, 'production_config_reads': 0,
              'checks': checks, 'native_binary_sha256': hashes}
    original_popen = subprocess.Popen
    def capture(*argv, **options):
        child = original_popen(*argv, **options)
        created.append(child)
        return child
    def require(name, condition):
        checks.append({'name': name, 'passed': bool(condition)})
        if not condition:
            raise AssertionError(name)
    try:
        installation.save(root, {'manifest': manifest})
        with patch.object(subprocess, 'Popen', side_effect=capture):
            boot = installation.bootstrap(root)
            require('native initialization does not start backend', boot['backendStarted'] is False)
            result = connections.connect(root)
            for _ in range(30):
                result = connections.check(root)
                if result['components'] == {'server': 'ready', 'runner': 'ready'}:
                    break
                time.sleep(.3)
            require('owned native MCP and exact managed Runner ready', result['components'] == {'server': 'ready', 'runner': 'ready'})
            require('single A is valid with explicit credentials-required state', result['accounts'] == [
                {'id': 'A', 'state': 'credentials_required', 'credentialConfigured': False, 'has_key': False}])
            require('no tunnel started without credentials', set(result['owners']) == {'server', 'runner'})
            if args.empty_initial_roots:
                selected = connections.backend._runner_values(Path(connections._backend_config(root)['runner_config']))
                require('no initial roots grants only the explicit empty installation sandbox',
                        selected.get('policy', {}).get('allowed_roots') == [str(installation.private_home(root) / 'unconfigured-projects')]
                        and selected.get('policy', {}).get('allow_cwd_anywhere') is False)
            before = result['owners']
            second = root / 'project-two'
            second.mkdir()
            (second / 'AGENTS.md').write_text('Independent second root hot-activation acceptance only.\n')
            write_fixtures(second)
            manifest['projectRoots'].append(str(second))
            if args.empty_initial_roots:
                manifest['projectRoots'].append(str(project))
            installation.save(root, {'manifest': manifest})
            connections.connect(root)
            require('adding a project preserves exact backend and Runner owners', connections.check(root)['owners'] == before)
            require('new root activated with no pending additions', 'project_roots_to_activate' not in connections.check(root)['pendingChanges'])
            token = connections.backend._mcp_server_token(connections._backend_config(root))
            projects = []
            for _ in range(20):
                request = Request(manifest['backend']['origin'] + '/api/runtime-console/projects',
                    data=b'{"limit":100}', headers={'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'}, method='POST')
                with build_opener(ProxyHandler({}), connections.backend.NoRedirect()).open(request, timeout=5) as response:
                    projects = json.loads(response.read(262144)).get('projects', [])
                if len(projects) == 2:
                    break
                time.sleep(.3)
            require('both actual registered native projects visible', len(projects) == 2)
            if args.concurrent_read:
                selected_project = next((item.get('project_id') or item.get('id') for item in projects
                                         if isinstance(item, dict) and (item.get('project_id') or item.get('id'))), None)
                require('native published project identity obtained', isinstance(selected_project, str))
                transport_session = [None]
                def rpc(method, params):
                    request_id = uuid.uuid4().hex
                    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                               'Accept': 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2025-06-18',
                               'Mcp-Method': method}
                    if transport_session[0]:
                        headers['Mcp-Session-Id'] = transport_session[0]
                    request = Request(manifest['backend']['origin'] + '/mcp', method='POST', headers=headers,
                        data=json.dumps({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params}).encode())
                    deadline = time.monotonic() + 60
                    with build_opener(ProxyHandler({}), connections.backend.NoRedirect()).open(request, timeout=60) as response:
                        reply = connections.backend._mcp_initialize_response(response, request_id, deadline)
                        if method == 'initialize':
                            transport_session[0] = response.headers.get('Mcp-Session-Id')
                    if not isinstance(reply, dict) or reply.get('error'):
                        raise AssertionError('native concurrent read RPC failed')
                    return reply.get('result', {})
                rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {},
                    'clientInfo': {'name': 'preview-isolated-10-lane-acceptance', 'version': '1'}})
                def call(tool, params):
                    reply = rpc('tools/call', {'name': tool, 'arguments': params})
                    value = reply.get('structuredContent')
                    if not isinstance(value, dict):
                        for content in reply.get('content', []):
                            if content.get('type') == 'text':
                                try:
                                    value = json.loads(content['text'])
                                    break
                                except ValueError:
                                    pass
                    if not isinstance(value, dict) or value.get('success') is False:
                        raise AssertionError('native concurrent read tool failed')
                    return value.get('output', value)
                def lane_read(lane):
                    session = call('work_on_project', {'project': selected_project,
                        'instruction': 'Isolated native file-read acceptance lane ' + str(lane) + '. Only read the ten read-lane files in this test project.'})
                    session_id = session.get('session_id')
                    verified = 0
                    for items in (range(8), range(8, 10)):
                        # clean6d67 published tools/list caps one read_files
                        # batch at eight items and names the fence session_id.
                        arguments = {'project': selected_project,
                            'items': [{'path': 'read-lane-' + str(lane) + '/item-' + str(item) + '.txt', 'limit': 5}
                                      for item in items], 'session_id': session_id, 'with_line_numbers': False}
                        result = call('read_files', arguments)
                        serialized = json.dumps(result, ensure_ascii=False)
                        matched = sum(expected[lane, item] in serialized for item in items)
                        if matched != len(items) or result.get('succeeded_count') != len(items):
                            raise AssertionError('native file content did not match every random receipt in this batch')
                        verified += matched
                    if verified != 10:
                        raise AssertionError('native file content did not match all ten random receipts')
                    return {'lane': lane, 'session_id': session_id, 'files_verified': verified,
                            'expected_content_sha256': hashlib.sha256(''.join(expected[lane, item] for item in range(10)).encode()).hexdigest()}
                with ThreadPoolExecutor(max_workers=10) as executor:
                    receipts = list(executor.map(lane_read, range(10)))
                report['concurrent_read_receipts'] = receipts
                require('ten concurrent native lanes each returned all ten exact file contents',
                        len(receipts) == 10 and sum(item['files_verified'] for item in receipts) == 100)
            manifest['accounts'].append({'id': 'B'})
            installation.save(root, {'manifest': manifest})
            result = connections.connect(root)
            require('optional B can be added without disturbing original owners', result['owners'] == before and len(result['accounts']) == 2)
            exported = connections.export_status(root)
            require('support export excludes native bootstrap credential', token not in json.dumps(exported))
            require('no automatic startup registered without credentials', not (installation.private_home(root) / 'startup.json').exists())
            observed_watch = subprocess.run([sys.executable, '-B', str(Path(connections.__file__).parent /
                'preview_connection_watch.py'), '--root', str(root), '--once'], capture_output=True, timeout=15)
            require('native lightweight watch exits cleanly when automatic connection disabled', observed_watch.returncode == 0)
        report['state'] = 'passed'
        report['status'] = result
    except Exception as error:
        report['state'] = 'failed'
        report['failure_type'] = type(error).__name__
        report['code'] = str(error) if isinstance(error, (installation.PreviewError, AssertionError)) else 'native_acceptance_failed'
    finally:
        stopped = []
        # Popen owns the actual process handle. A new native snapshot verifies
        # image and creation against the saved owner before that handle is used.
        owners = connections._owners(root, manifest)['owners'] if connections._owner_file(root).exists() else {}
        for child in reversed(created):
            if child.poll() is not None:
                continue
            expected = [owner for owner in owners.values() if owner['pid'] == child.pid]
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
        (root / 'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=True))
    return 0 if report['state'] == 'passed' and report['all_direct_children_exited'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
