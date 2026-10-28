"""Opt-in isolated native Job proof using only bundled Python and PowerShell.

No model, platform, tunnel, user configuration or live browser is contacted.
Every accepted/unknown execution is journaled before dispatch; an unknown Job
keeps its exact isolated owners alive for investigation, never a blind replay.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import tomllib
import uuid
from urllib.request import Request, build_opener, ProxyHandler
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import preview_installation as installation
import preview_connections as connections
from product_runtime import atomic_json
from windows_process_owner import process_inventory


def nodes(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from nodes(child)


def prepare(root, args):
    if args.resume:
        prior = json.loads((root / 'verification.json').read_text(encoding='utf8'))
        if (prior.get('unknown_execution') or not prior.get('all_direct_children_exited')
                or prior.get('state') != 'failed'
                or any(item.get('state') != 'terminal' or item.get('terminal', {}).get('exit_code') != 0
                       or item.get('terminal', {}).get('job_id') != item.get('job_id') for item in prior['executions'])):
            raise SystemExit('Only known completed original Jobs with exited owned processes may resume acceptance')
        for name, expected in prior['payload_sha256'].items():
            path = (root / name).resolve()
            if not path.is_relative_to(root / 'runtime') or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise SystemExit('Original isolated runtime bytes changed')
        atomic_json(root / ('verification-before-resume-' + uuid.uuid4().hex + '.json'), prior)
        return prior['payload_sha256'], installation.load(root), root / 'project 空间', prior
    if root.exists() or not root.parent.is_dir():
        raise SystemExit('A fresh isolated directory on an available volume is required')
    root.mkdir()
    (root / 'write-probe').write_bytes(b'verified available volume')
    payload = json.loads(args.payload.read_text(encoding='utf-8-sig'))
    copied = {}
    for component in payload['components']:
        for name, source in component.get('files', {}).items():
            if not name.startswith(('runtime/python/', 'runtime/powershell/')):
                continue
            target = root / name
            if not target.resolve().is_relative_to(root):
                raise SystemExit('Payload path escaped isolated directory')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            copied[name] = hashlib.sha256(target.read_bytes()).hexdigest()
    native = root / 'runtime/native'
    native.mkdir(parents=True)
    tunnel = next(component['files']['runtime/native/tunnel-client.exe']
                  for component in payload['components'] if 'runtime/native/tunnel-client.exe' in component.get('files', {}))
    for role, name in installation.BINARY_NAMES.items():
        source = Path(tunnel) if role == 'tunnel' else args.binary_dir / name
        shutil.copy2(source, native / name)
        copied['runtime/native/' + name] = hashlib.sha256((native / name).read_bytes()).hexdigest()
    project = root / 'project 空间'
    project.mkdir()
    (project / 'AGENTS.md').write_text('Only isolated private-runtime verification.\n')
    probe = project / 'probe.py'
    probe.write_text('import json,os,sys,time\nfrom PIL import Image\ntime.sleep(3)\n'
                     'print(json.dumps({"python":sys.executable,"version":sys.version.split()[0],'
                     '"pillow":Image.__version__,"powershell_telemetry_optout":os.environ.get("POWERSHELL_TELEMETRY_OPTOUT"),'
                     '"do_not_track":os.environ.get("DO_NOT_TRACK")}))\n', encoding='utf8')
    manifest = installation.defaults(root)
    manifest.update(projectRoots=[str(project)], auto_connect=False, network={'mode': 'direct'})
    return copied, manifest, project, None


def verify_runtime(root, record):
    samples = record.get('stdout_samples') or [record['terminal']['stdout_tail']]
    identities = []
    for sample in samples:
        for line in sample.splitlines():
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    identities.append(value)
            except ValueError:
                pass
    norm = lambda value: str(value).removeprefix('\\\\?\\').replace('\\', '/').casefold()
    python = next((value for value in identities if value.get('python')), {})
    if (norm(python.get('python')) != norm(root / 'runtime/python/python.exe')
            or python.get('version') != '3.11.9' or python.get('pillow') != '12.2.0'):
        raise AssertionError('native Job did not return private Python/Pillow identity')
    if any(python.get(key) != '1' for key in ('powershell_telemetry_optout', 'do_not_track')):
        raise AssertionError('native Python Job did not inherit private telemetry opt-outs')
    if record['tool'] == 'run_shell':
        shell = next((value for value in identities if value.get('powershell')), {})
        if (norm(shell.get('powershell')) != norm(root / 'runtime/powershell/pwsh.exe')
                or shell.get('ps_version') != '7.6.5'):
            raise AssertionError('native Job did not return private PowerShell identity')
        if any(shell.get(key) != '1' for key in ('powershell_telemetry_optout', 'do_not_track')):
            raise AssertionError('native PowerShell Job did not inherit private telemetry opt-outs')
    record['verified_runtime_identities'] = identities
    record['runtime_verified'] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--payload', type=Path, required=True)
    parser.add_argument('--binary-dir', type=Path, required=True)
    parser.add_argument('--work-dir', type=Path, required=True)
    parser.add_argument('--resume', action='store_true', help='Recheck completed original Jobs and run only undispatched checks')
    args = parser.parse_args()
    root = args.work_dir.resolve()
    copied, manifest, project, prior = prepare(root, args)
    # Preserve OS basics while explicitly proving no host runtime is on PATH.
    inherited = {key: value for key, value in os.environ.items()
                 if key.upper() not in ('PATH', 'PYTHONHOME', 'PYTHONPATH', 'PSMODULEPATH')}
    inherited['PATH'] = str(Path(os.environ['SystemRoot']) / 'System32')
    absent = {name: shutil.which(name, path=inherited['PATH']) for name in ('python.exe', 'pwsh.exe', 'webcodex.exe')}
    if any(absent.values()):
        raise SystemExit('Restricted PATH unexpectedly resolved a host runtime')
    report = {'schema': 1, 'state': 'running', 'model_calls': 0, 'platform_calls': 0,
              'host_path': inherited['PATH'], 'host_runtime_resolution': absent, 'payload_sha256': copied,
              'executions': prior['executions'] if prior else [], 'unknown_execution': False}
    created = []
    original_popen = subprocess.Popen
    output = root / 'verification.json'
    def capture(*argv, **options):
        child = original_popen(*argv, **options)
        created.append(child)
        return child
    def save():
        atomic_json(output, report)
    save()
    try:
        with patch.dict(os.environ, inherited, clear=True), patch.object(subprocess, 'Popen', side_effect=capture):
            installation.initialize(root, manifest['binaries'])
            if not prior:
                installation.save(root, {'manifest': {**manifest, 'installation_id': installation.load(root)['installation_id']}})
            manifest = installation.load(root)
            connections.connect(root)
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                status = connections.check(root)
                if status['components'] == {'server': 'ready', 'runner': 'ready'}:
                    break
                time.sleep(.3)
            if status['components'] != {'server': 'ready', 'runner': 'ready'}:
                raise AssertionError('isolated native backend did not become ready')
            report['owners'] = status['owners']
            config = connections._backend_config(root)
            shell = tomllib.loads(Path(config['runner_config']).read_text(encoding='utf8'))['shell']
            report['configured_shell'] = shell
            token = connections.backend._mcp_server_token(config)
            opener = build_opener(ProxyHandler({}), connections.backend.NoRedirect())
            transport = [None]
            def rpc(method, params):
                request_id = uuid.uuid4().hex
                headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                           'Accept': 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2025-06-18',
                           'Mcp-Method': method}
                if transport[0]:
                    headers['Mcp-Session-Id'] = transport[0]
                if method == 'tools/call':
                    headers['Mcp-Name'] = params['name']
                request = Request(config['origin'] + '/mcp', method='POST', headers=headers,
                                  data=json.dumps({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params}).encode())
                with opener.open(request, timeout=60) as response:
                    raw = connections.backend._mcp_initialize_response(response, request_id, time.monotonic() + 60)
                    if method == 'initialize':
                        transport[0] = response.headers.get('Mcp-Session-Id')
                if raw.get('id') != request_id or raw.get('error'):
                    raise AssertionError('native RPC identity or success mismatch')
                return raw['result']
            def call(name, arguments):
                result = rpc('tools/call', {'name': name, 'arguments': arguments})
                value = result.get('structuredContent')
                if not isinstance(value, dict):
                    value = next((json.loads(item['text']) for item in result.get('content', [])
                                  if item.get('type') == 'text'), {})
                if value.get('success') is False or result.get('isError'):
                    raise AssertionError('native tool failed: ' + name + ' ' + json.dumps(value, ensure_ascii=True)[:3000])
                return value.get('output', value)
            rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {},
                               'clientInfo': {'name': 'isolated-private-runtime-jobs', 'version': '1'}})
            discovery = rpc('tools/list', {})
            atomic_json(root / 'tools-list.json', discovery)
            tools = {item['name']: item for item in discovery['tools']}
            for name in ('work_on_project', 'run_shell', 'run_process', 'observe_jobs'):
                if name not in tools:
                    raise AssertionError('required native execution tool missing: ' + name)
            request = Request(config['origin'] + '/api/runtime-console/projects', data=b'{"limit":100}',
                              headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
            with opener.open(request, timeout=5) as response:
                projects = json.loads(response.read(262144)).get('projects', [])
            project_id = next((item.get('project_id') or item.get('id') for item in projects), None)
            if prior:
                if prior.get('project_id') != project_id:
                    raise AssertionError('original native Project identity changed')
                session_id = prior['session_id']
            else:
                session = call('work_on_project', {'project': project_id,
                               'instruction': 'Verify bundled Python and PowerShell by running only probe.py and shell version checks in this isolated test project.'})
                session_id = session['session_id']
            report.update(project_id=project_id, session_id=session_id)
            command = ("$ErrorActionPreference = 'Stop'; Start-Sleep -Seconds 3; "
                       "$shell = @{powershell=(Get-Process -Id $PID).Path; ps_version=$PSVersionTable.PSVersion.ToString(); "
                       "powershell_telemetry_optout=$env:POWERSHELL_TELEMETRY_OPTOUT; do_not_track=$env:DO_NOT_TRACK; "
                       "python_command=(Get-Command python).Source}; $shell | ConvertTo-Json -Compress; "
                       "python './probe.py'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; "
                       "pwsh -NoProfile -NonInteractive -Command '$PSHOME'")
            executions = [('run_shell', {'command': command}),
                          ('run_process', {'executable': 'python', 'args': ['probe.py']})]
            for name, arguments in executions:
                original = next((record for record in report['executions'] if record['tool'] == name), None)
                if original:
                    verify_runtime(root, original)
                    save()
                    continue
                properties = tools[name]['inputSchema']['properties']
                arguments = {**arguments, 'project': project_id, 'session_id': session_id,
                             'timeout_secs': 45, 'sync_wait_secs': 1}
                arguments = {key: value for key, value in arguments.items() if key in properties}
                record = {'tool': name, 'state': 'dispatching', 'arguments': arguments, 'stdout_samples': []}
                report['executions'].append(record)
                report['unknown_execution'] = True
                save()
                started = call(name, arguments)
                record['accepted'] = started
                job_ids = {node['job_id'] for node in nodes(started) if isinstance(node.get('job_id'), str)}
                if len(job_ids) != 1:
                    raise AssertionError('execution did not return one stable native Job identity')
                job_id = job_ids.pop()
                record.update(job_id=job_id, state='accepted')
                save()
                deadline = time.monotonic() + 75
                while time.monotonic() < deadline:
                    observed = call('observe_jobs', {'items': [{'job_id': job_id}], 'tail_lines': 100, 'wait_secs': 2})
                    record['observed'] = observed
                    record['stdout_samples'].extend(node['stdout_tail'] for node in nodes(observed)
                                                    if isinstance(node.get('stdout_tail'), str) and node['stdout_tail'])
                    save()
                    terminals = [node for node in nodes(observed) if node.get('job_id') == job_id and
                                 (node.get('terminal') is True or node.get('status') in ('completed', 'failed', 'canceled', 'cancelled', 'timed_out'))]
                    if terminals:
                        record['terminal'] = terminals[0]
                        record['state'] = 'terminal'
                        report['unknown_execution'] = False
                        save()
                        if any(node.get('exit_code') not in (None, 0) for node in nodes(terminals[0])):
                            raise AssertionError('native Job returned a nonzero exit code')
                        break
                else:
                    raise AssertionError('original native Job terminal state remains unknown')
                verify_runtime(root, record)
            if connections.check(root)['owners'] != report['owners']:
                raise AssertionError('native owner identity changed during isolated Jobs')
            report['state'] = 'passed'
    except Exception as error:
        report.update(state='failed', failure_type=type(error).__name__, code=str(error)[:3500])
    finally:
        stopped = []
        owners = connections._owners(root, manifest)['owners'] if connections._owner_file(root).exists() else {}
        if not report['unknown_execution']:
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
        save()
    print(json.dumps({key: value for key, value in report.items() if key not in ('payload_sha256', 'executions')}, ensure_ascii=True))
    return 0 if report['state'] == 'passed' and report['all_direct_children_exited'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
