"""Explicit recovery of a stopped, tool-free connection failure.

Releases a cooperative directory lease, never certifies task success or replays
the prompt. Unknown tool execution still needs the ordinary terminal recovery.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

from native_work_admission import (AdmissionError, _audit, _owner_live, _read_claim,
                                  _canonical, _require, _result_path, _transaction)


def stopped_processes(row, thread):
    _require(os.name == 'nt', 'interruption_process_probe_unavailable')
    command = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                            capture_output=True, timeout=15, encoding='utf-8', errors='strict')
    _require(result.returncode == 0, 'interruption_process_probe_unavailable')
    processes = json.loads(result.stdout)
    _require(isinstance(processes, list), 'interruption_process_probe_unavailable')
    needles = [row['result_path'].casefold().replace('\\', '/'), thread.casefold()]
    descendants = {row['owner_pid']}
    for _ in range(len(processes)):
        found = {p['ProcessId'] for p in processes if p['ParentProcessId'] in descendants}
        if found <= descendants:
            break
        descendants |= found
    for process in processes:
        _require(process['ProcessId'] not in descendants, 'original_executor_alive_or_unknown')
        name = process['Name'].lower()
        if name not in ('codex.exe', 'node.exe', 'powershell.exe', 'pwsh.exe'):
            continue
        text = process.get('CommandLine')
        _require(isinstance(text, str), 'executor_command_line_unavailable')
        text = text.casefold().replace('\\', '/')
        if any(needle in text for needle in needles):
            # An operator's inspection command is not the original launcher.
            executing = name in ('codex.exe', 'node.exe') or 'start_codex_web.ps1' in text
            _require(not executing, 'original_executor_alive_or_unknown')
    return True


def connection_failure_evidence(row):
    from read_codex_web_task import native_evidence, instant
    directory = Path(row['result_path'])
    raw = (directory / 'execution.json').read_bytes()
    record = json.loads(raw.decode('utf-8-sig'))
    _require(record.get('admissionId') == row['claim_id'] and
             record.get('ownerPid') == row['owner_pid'] and
             _result_path(record.get('resultDirectory', '')) == row['result_path'] and
             record.get('state') == 'running', 'original_interrupted_receipt_required')
    events = (directory / 'events.jsonl').read_bytes()
    encoding = 'utf-16' if events[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
    thread = None
    failures = 0
    for line in events.decode(encoding).splitlines():
        event = json.loads(line)
        kind = event.get('type')
        if kind == 'thread.started':
            _require(thread is None, 'multiple_native_threads_require_review')
            thread = event.get('thread_id')
        elif kind == 'turn.started':
            pass
        elif kind == 'error':
            message = event.get('message', '')
            _require('Connection failed: error sending request' in message or
                     (message.startswith('Reconnecting... ') and '(os error 10061)' in message),
                     'failure_is_not_connection_only')
            failures += 1
        elif kind == 'item.completed' and event.get('item', {}).get('type') == 'error':
            message = event['item'].get('message', '')
            startup_warning = message.startswith((
                'Under-development features enabled:', 'This session was recorded with model ',
                'Model metadata for '))
            connection_failure = ('Connection failed: error sending request' in message or
                (message.startswith('Falling back from WebSockets to HTTPS transport.') and
                 '(os error 10061)' in message))
            _require(startup_warning or connection_failure, 'failure_is_not_connection_only')
            failures += int(connection_failure)
        else:
            raise AdmissionError('native_activity_requires_terminal_reconciliation')
    _require(failures > 0 and thread == record.get('sourceThread'), 'connection_failure_identity_unverified')
    native = native_evidence(thread, record)
    _require(native['state'] == 'observed' and not native['tools'], 'native_tools_require_terminal_reconciliation')
    session = Path(native['source']).read_bytes()
    began = False
    metadata = []
    beginning = instant(record.get('startedAt'))
    _require(beginning is not None, 'original_native_turn_start_unverified')
    for line in session.decode('utf-8-sig').splitlines():
        item = json.loads(line)
        _require(isinstance(item, dict) and isinstance(item.get('payload'), dict),
                 'native_activity_requires_terminal_reconciliation')
        payload = item['payload']
        if item.get('type') == 'session_meta':
            metadata.append(payload)
        at = instant(item.get('timestamp'))
        if item.get('type') == 'response_item':
            _require(at is not None, 'native_activity_requires_terminal_reconciliation')
            if at >= beginning:
                _require(payload.get('type') in ('message', 'reasoning', 'compaction'),
                         'native_tools_require_terminal_reconciliation')
        if at and at >= beginning and item.get('type') == 'event_msg':
            if payload.get('type') == 'item_completed':
                _require(isinstance(payload.get('item'), dict)
                         and payload['item'].get('type') in ('UserMessage', 'AgentMessage', 'Reasoning', 'Error'),
                         'native_tools_require_terminal_reconciliation')
            if payload.get('type') == 'task_started':
                _require(not began, 'multiple_native_turns_require_review')
                began = True
    _require(began, 'original_native_turn_start_unverified')
    _require(len(metadata) == 1 and metadata[0].get('id') == thread
             and isinstance(metadata[0].get('cwd'), str) and metadata[0]['cwd']
             and _canonical(metadata[0].get('cwd', '')) == row['workspace'],
             'original_native_workspace_unverified')
    return {'thread': thread, 'executionSha256': hashlib.sha256(raw).hexdigest(),
            'eventsSha256': hashlib.sha256(events).hexdigest(),
            'sessionSha256': hashlib.sha256(session).hexdigest(),
            'connectionErrors': failures, 'observedToolCalls': 0, 'nativeToolsVerifiedAbsent': True}


def tool_free_failure_evidence(row):
    """A terminal native turn with no action items owns no Workflow Jobs.

    Reuse the bridge's strict native receipt verifier. Global pure-Web Jobs
    from other projects do not keep this tool-free directory lease alive.
    """
    from read_codex_web_task import native_evidence, instant
    directory = Path(row['result_path'])
    record = json.loads((directory / 'execution.json').read_text('utf-8-sig'))
    _require(record.get('admissionId') == row['claim_id'] and
             record.get('ownerPid') == row['owner_pid'] and
             _result_path(record.get('resultDirectory', '')) == row['result_path'] and
             record.get('state') == 'needs_attention' and record.get('exitCode') == 1,
             'original_failed_receipt_required')
    _require(_owner_live(row['owner_pid']) is False, 'original_launcher_alive_or_unknown')
    events = (directory / 'events.jsonl').read_bytes()
    encoding = 'utf-16' if events[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
    threads = [e.get('thread_id') for line in events.decode(encoding).splitlines()
               if (e := json.loads(line)).get('type') == 'thread.started']
    _require(len(threads) == 1, 'original_native_thread_unverified')
    thread = threads[0]
    _require(not record.get('sourceThread') or record['sourceThread'] == thread, 'original_native_thread_unverified')
    native = native_evidence(thread, record)
    _require(native['state'] == 'observed' and not native['tools'], 'native_tools_require_terminal_reconciliation')
    source = Path(native['source']); raw = source.read_bytes()
    begin, end = instant(record.get('startedAt')), instant(record.get('endedAt'))
    _require(begin is not None and end is not None and begin <= end, 'original_execution_window_unverified')
    starts = []; metadata = []
    for line in raw.decode('utf-8-sig').splitlines():
        event = json.loads(line); at = instant(event.get('timestamp')); payload = event.get('payload', {})
        if event.get('type') == 'session_meta':
            metadata.append(payload)
        if (at and begin <= at <= end and event.get('type') == 'event_msg'
                and payload.get('type') == 'task_started'):
            starts.append(payload.get('turn_id'))
    _require(len(starts) == 1, 'original_native_turn_unverified')
    _require(len(metadata) == 1 and metadata[0].get('id') == thread and
             isinstance(metadata[0].get('cwd'), str) and metadata[0]['cwd'] and
             _canonical(metadata[0].get('cwd', '')) == row['workspace'], 'original_native_workspace_unverified')
    helper = Path(__file__).resolve().parents[1] / 'apps/codex-web-bridge/native-terminal-receipt.cjs'
    code = "const p=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(require(p.helper).verifyNativeFailureReceipt(p)));"
    checked = subprocess.run(['node', '-e', code, json.dumps({'helper': str(helper), 'threadId': thread,
                              'turnId': starts[0]})], capture_output=True, timeout=15, encoding='utf8')
    _require(checked.returncode == 0, 'native_tools_require_terminal_reconciliation')
    proof = json.loads(checked.stdout)
    _require(proof.get('kind') == 'native_failed_without_tools' and
             begin <= instant(proof.get('startedAt')) <= instant(proof.get('endedAt')) <= end and
             source.read_bytes() == raw, 'original_native_failure_changed')
    return {'thread': thread, 'turn': starts[0], 'source': str(source),
            'sessionSha256': hashlib.sha256(raw).hexdigest(),
            'eventsSha256': hashlib.sha256(events).hexdigest(),
            'nativeReceiptSha256': proof['receiptSha256'], 'observedToolCalls': 0}


def recover_interrupted(database, result_path, *, owner_probe=None, process_probe=None,
                        evidence_probe=None, runtime_probe=None):
    snapshot = _read_claim(database, result_path=result_path)
    if snapshot['state'] == 'released':
        return {'claim_id': snapshot['claim_id'], 'state': 'released', 'alreadySettled': True}
    _require(snapshot['state'] in ('running', 'unknown'), 'original_running_claim_required')
    _require((owner_probe or _owner_live)(snapshot['owner_pid']) is False,
             'original_launcher_alive_or_unknown')
    evidence = evidence_probe or connection_failure_evidence
    proof = evidence(snapshot)
    probe = process_probe or stopped_processes
    _require(probe(snapshot, proof['thread']) is True, 'original_executor_alive_or_unknown')
    if runtime_probe is not None:
        _require(runtime_probe() is True, 'local_execution_active_or_unknown')
    # This exact stopped failure had no native actions. Other projects' active
    # Native turns or Runner Jobs therefore cannot belong to this claim.
    _require(evidence(snapshot) == proof, 'original_interruption_evidence_changed')
    with _transaction(database) as db:
        row = db.execute('SELECT * FROM native_work_claims WHERE claim_id=?', (snapshot['claim_id'],)).fetchone()
        _require(row and row['updated'] == snapshot['updated'] and row['state'] == snapshot['state'],
                 'original_claim_changed_reconcile')
        db.execute("UPDATE native_work_claims SET state='released',updated=? WHERE claim_id=?",
                   (time.time(), row['claim_id']))
        _audit(db, row, 'interrupted_connection_failure', {**proof, 'executorStopped': True,
               **({'runtimeQuiet': True} if runtime_probe is not None else {}),
               'taskOutcome': 'interrupted_unverified', 'automaticReplay': False})
    return {'claim_id': snapshot['claim_id'], 'state': 'released',
            'recovery': 'interrupted_connection_failure', 'taskOutcome': 'interrupted_unverified',
            'automaticReplay': False, 'modelSends': 0}
