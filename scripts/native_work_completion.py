"""Bounded, read-only proof of one native turn's tracked tool completion.

This supplements a transport receipt. It does not release an admission claim,
prove that arbitrary commands left no background work, or accept the result.
"""
from datetime import timedelta, timezone, datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess

UUID_V7 = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', re.I)
SHA256 = re.compile(r'[0-9a-f]{64}')
MAX_RECORD_CHARS = 16 * 1024 * 1024


def _require(value, code):
    if not value:
        raise ValueError(code)


def _instant(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except (AttributeError, ValueError):
        return None


def _bytes(path, limit):
    before = path.stat()
    _require(path.is_file() and 0 < before.st_size <= limit, 'native_work_receipt_size_invalid')
    raw = path.read_bytes()
    after = path.stat()
    _require((before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns)
             and len(raw) == before.st_size, 'native_work_receipt_changed')
    return raw


def _rows(raw):
    encoding = 'utf-16' if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
    rows = [json.loads(line) for line in raw.decode(encoding).splitlines() if line.strip()]
    _require(all(isinstance(row, dict) for row in rows), 'native_work_receipt_invalid')
    return rows



def _revision(stat):
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


def _file_hash(path):
    before = path.stat()
    _require(path.is_file() and before.st_size > 0, 'native_work_receipt_size_invalid')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        _require(_revision(os.fstat(stream.fileno())) == _revision(before), 'native_work_receipt_changed')
        for chunk in iter(lambda: stream.read(65536), b''):
            digest.update(chunk)
        _require(_revision(os.fstat(stream.fileno())) == _revision(before)
                 and _revision(path.stat()) == _revision(before), 'native_work_receipt_changed')
    return digest.hexdigest()


class _StreamRows:
    """Stable original fd, bounded individual record, no file lifetime limit."""
    def __init__(self, path):
        self.path = path
        self.sha256 = None

    def __iter__(self):
        before = self.path.stat()
        _require(self.path.is_file() and before.st_size > 0, 'native_work_receipt_size_invalid')
        with self.path.open('rb') as raw:
            _require(_revision(os.fstat(raw.fileno())) == _revision(before), 'native_work_receipt_changed')
            digest = hashlib.sha256()
            for chunk in iter(lambda: raw.read(65536), b''):
                digest.update(chunk)
            raw.seek(0)
            encoding = 'utf-16' if raw.read(2) in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
            raw.seek(0)
            text = io.TextIOWrapper(raw, encoding=encoding, errors='strict')
            try:
                while line := text.readline(MAX_RECORD_CHARS + 1):
                    _require(len(line) <= MAX_RECORD_CHARS, 'native_work_record_size_invalid')
                    if line.strip():
                        row = json.loads(line)
                        _require(isinstance(row, dict), 'native_work_receipt_invalid')
                        yield row
                _require(_revision(os.fstat(raw.fileno())) == _revision(before)
                         and _revision(self.path.stat()) == _revision(before), 'native_work_receipt_changed')
                self.sha256 = digest.hexdigest()
            finally:
                text.detach()

def completed_tools_evidence(directory, record, *, sessions=None):
    return _tools_evidence(directory, record, sessions=sessions)


def failed_tools_evidence(directory, record, *, sessions=None):
    """Exact native compaction failure with terminal tools; never a task success."""
    return _tools_evidence(directory, record, sessions=sessions, failed=True)


def _tools_evidence(directory, record, *, sessions=None, failed=False, cancelled=False):
    """No tool arguments, output bodies, prompts, or other Session paths leave here."""
    unknown = {'state': 'unavailable', 'executionAbsenceProven': False,
               'claimReleaseAuthorized': False, 'taskAcceptance': 'unverified'}
    if type(record.get('exitCode')) is not int or (record.get('state') != 'needs_attention' or record['exitCode'] == 0
            if failed else record.get('state') not in ('completed', 'turn_completed') or record['exitCode'] != 0):
        return unknown
    try:
        directory = Path(directory)
        execution_raw = _bytes(directory / 'execution.json', 65536)
        execution = json.loads(execution_raw.decode('utf-8-sig'))
        _require(isinstance(execution, dict), 'native_work_execution_invalid')
        normalize_state = lambda value: 'turn_completed' if value == 'completed' else value
        _require(normalize_state(execution.get('state')) == normalize_state(record.get('state'))
                 and all(execution.get(key) == record.get(key) for key in
                         ('startedAt', 'endedAt', 'ownerPid', 'exitCode', 'workspace', 'sourceThread',
                          'admissionId', 'bridgeRuntimePid', 'model', 'webAccount')),
                 'native_work_execution_mismatch')
        begin, end = _instant(record.get('startedAt')), _instant(record.get('endedAt'))
        _require(begin is not None and end is not None and begin <= end, 'native_work_window_invalid')
        events = _StreamRows(directory / 'events.jsonl')
        threads, markers, failures = [], [], []
        for event in events:
            kind = event.get('type')
            if kind == 'thread.started':
                threads.append(event.get('thread_id'))
            if kind in ('thread.started', 'turn.started', 'turn.completed', 'turn.failed'):
                markers.append(kind)
                _require(len(markers) <= 3, 'native_work_cli_terminal_invalid')
            if kind == 'turn.failed':
                error = event.get('error', {})
                _require(isinstance(error, dict) and isinstance(error.get('message'), str) and error['message'],
                         'native_work_cli_failure_invalid')
                failures.append(hashlib.sha256(error['message'].encode('utf8')).hexdigest())
        _require(len(threads) == 1 and UUID_V7.fullmatch(threads[0] or ''), 'native_work_thread_invalid')
        thread = threads[0]
        _require(not record.get('sourceThread') or record['sourceThread'] == thread, 'native_work_thread_mismatch')
        _require(markers == ['thread.started', 'turn.started', 'turn.failed' if failed else 'turn.completed']
                 and len(failures) == int(failed), 'native_work_cli_terminal_order_invalid')
        created = datetime.fromtimestamp(int(thread.replace('-', '')[:12], 16) / 1000, timezone.utc)
        home = Path(sessions) if sessions is not None else Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'sessions'
        sources = [path for offset in (-1, 0, 1)
                   for path in (home / (created + timedelta(days=offset)).strftime('%Y/%m/%d')).glob('rollout-*' + thread + '.jsonl')]
        _require(len(sources) == 1, 'native_work_session_not_unique')
        rows = _StreamRows(sources[0])
        metadata, turns = [], []
        for row in rows:
            payload = row.get('payload', {})
            _require(isinstance(payload, dict), 'native_work_session_identity_invalid')
            if row.get('type') == 'session_meta':
                metadata.append({'id': payload.get('id'), 'cwd': payload.get('cwd')})
                _require(len(metadata) == 1, 'native_work_session_identity_invalid')
            if (row.get('type') == 'event_msg' and payload.get('type') == 'task_started'
                    and (at := _instant(row.get('timestamp'))) is not None and begin <= at <= end):
                turns.append(payload.get('turn_id'))
                _require(len(turns) == 1, 'native_work_turn_invalid')
        _require(len(metadata) == 1 and metadata[0].get('id') == thread, 'native_work_session_identity_invalid')
        canonical = lambda path: os.path.normcase(os.path.normpath(str(path)))
        _require(record.get('workspace') and canonical(metadata[0].get('cwd', '')) == canonical(record['workspace']),
                 'native_work_workspace_mismatch')
        _require(len(turns) == 1 and UUID_V7.fullmatch(turns[0] or ''), 'native_work_turn_invalid')
        final_raw = None
        if failed:
            _require(not (directory / 'final.md').exists(), 'native_work_failed_final_requires_review')
        else:
            final_raw = _bytes(directory / 'final.md', 4 * 1024 * 1024)
        final_hash = hashlib.sha256(final_raw.decode('utf-8-sig').strip().encode('utf8')).hexdigest() if final_raw else None
        helper = Path(__file__).resolve().parents[1] / 'apps/codex-web-bridge/native-terminal-receipt.cjs'
        arguments = {'helper': str(helper), 'threadId': thread, 'turnId': turns[0],
                     **({'expectedFinalSha256': final_hash} if not failed else {}),
                     'startedAt': record['startedAt'], 'endedAt': record['endedAt'],
                     **({'expectedCancellationFailureSha256':failures[0]} if cancelled else {}),
                     **({'sessionsRoot': str(home)} if sessions is not None else {})}
        helper_method = 'verifyNativeCompactionFailureReceipt' if failed else 'verifyNativeCompletedToolsReceipt'
        command = f"const p=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(require(p.helper).{helper_method}(p)));"
        checked = subprocess.run(['node', '-e', command, json.dumps(arguments)], capture_output=True,
                                 timeout=15, encoding='utf8', errors='strict')
        _require(checked.returncode == 0 and len(checked.stdout) <= 65536, 'native_work_tools_unverified')
        proof = json.loads(checked.stdout)
        _require(proof.get('version') == 1 and proof.get('kind') in
                 ({'native_cancelled_with_terminal_tools'} if cancelled else {'native_compaction_failed_with_terminal_tools', 'native_failed_with_terminal_tools'} if failed else {'native_completed_tools_terminal'})
                 and proof.get('threadId') == thread and proof.get('turnId') == turns[0]
                 and (proof.get('failureSha256') == failures[0] if failed else proof.get('finalSha256') == final_hash)
                 and proof.get('sessionSha256') == rows.sha256
                 and SHA256.fullmatch(proof.get('receiptSha256', ''))
                 and SHA256.fullmatch(proof.get('toolEventSha256', '')),
                 'native_work_proof_identity_invalid')
        if failed:
            native_begin, native_end = _instant(proof.get('startedAt')), _instant(proof.get('endedAt'))
            _require(native_begin is not None and native_end is not None and begin <= native_begin <= native_end <= end
                     and type(proof.get('uncollectedCommandOutputs')) is int and proof['uncollectedCommandOutputs'] >= 0,
                     'native_work_failure_window_invalid')
            if proof['kind'] == 'native_failed_with_terminal_tools':
                _require(SHA256.fullmatch(proof.get('priorFinalSha256', ''))
                         and proof.get('nativeTurnState') == 'failed' and proof.get('automaticReplay') is False,
                         'native_work_failure_identity_invalid')
        tools = proof.get('tools')
        _require(isinstance(tools, dict) and {'exec_command', 'apply_patch'} <= set(tools)
                 and set(tools) <= {'exec_command', 'apply_patch', 'write_stdin', 'view_image'} | ({'mcp'} if failed else set())
                 and all(isinstance(value, dict) and set(value) == {'invocations', 'terminal'}
                         and type(value['invocations']) is int and type(value['terminal']) is int
                         and value['invocations'] >= 0 and value['invocations'] == value['terminal']
                         for value in tools.values())
                 and type(proof.get('returnedTools')) is int
                 and proof['returnedTools'] == sum(value['terminal'] for value in tools.values()),
                 'native_work_tool_projection_invalid')
        _require(_file_hash(sources[0]) == rows.sha256 and _file_hash(directory / 'events.jsonl') == events.sha256
                 and (not (directory / 'final.md').exists() if failed else (directory / 'final.md').read_bytes() == final_raw)
                 and (directory / 'execution.json').read_bytes() == execution_raw, 'native_work_receipt_changed')
        # Explicit projection prevents an accidental helper change from exposing arguments.
        keys = ('version', 'kind', 'threadId', 'turnId', 'receiptSha256',
                'toolEventSha256', 'sessionSha256', 'returnedTools', 'tools')
        return {**{key: proof[key] for key in keys},
                **({'priorFinalSha256': proof['priorFinalSha256']} if failed and 'priorFinalSha256' in proof else {}),
                **({key: proof[key] for key in ('failureSha256', 'startedAt', 'endedAt', 'uncollectedCommandOutputs')}
                   if failed else {'finalSha256': proof['finalSha256']}), 'state': 'verified',
                'eventsSha256': events.sha256,
                'executionSha256': hashlib.sha256(execution_raw).hexdigest(),
                'executionScope': 'tracked_native_turn_tools', 'executionAbsenceProven': False,
                'workflowJobAbsenceProven': False, 'claimReleaseAuthorized': False,
                'taskAcceptance': 'unverified'}
    except (OSError, UnicodeError, ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError, subprocess.SubprocessError):
        return unknown


def failed_terminal_work_evidence(row, *, sessions=None, runtime_read=None, cancellation=None):
    """Use the existing owned-Workflow inventory for an exact failed native turn."""
    from native_work_admission import _canonical, _require, _result_path, local_runtime_read
    from native_work_terminal import _workflow_jobs, WORKFLOW_CALL, REFERENCE
    from read_codex_web_task import native_evidence
    directory = Path(row['result_path'])
    record = json.loads((directory / 'execution.json').read_text('utf-8-sig'))
    _require(isinstance(record, dict) and record.get('admissionId') == row['claim_id']
             and record.get('ownerPid') == row['owner_pid']
             and _result_path(record.get('resultDirectory', '')) == row['result_path']
             and record.get('workspace') and _canonical(record['workspace']) == row['workspace'],
             'original_native_execution_identity_unverified')
    if cancellation:
        _require(cancellation.get('claimId')==row['claim_id'] and cancellation.get('state')=='cancellation_requested'
            and cancellation.get('runtimePid')==record.get('bridgeRuntimePid'),'original_cancellation_acknowledgement_unverified')
    proof = _tools_evidence(directory,record,sessions=sessions,failed=True,cancelled=True) if cancellation else failed_tools_evidence(directory, record, sessions=sessions)
    _require(proof.get('state') == 'verified', 'original_native_failed_tools_terminal_unverified')
    if cancellation:
        _require(all(proof.get(k)==cancellation.get(k) for k in ('threadId','turnId')),
            'original_cancellation_identity_changed')
    return _owned_tool_work_evidence(row, proof, sessions=sessions, runtime_read=runtime_read)


def _owned_tool_work_evidence(row, proof, *, sessions=None, runtime_read=None):
    from native_work_admission import _require, local_runtime_read
    from native_work_terminal import _workflow_jobs, WORKFLOW_CALL, REFERENCE
    from read_codex_web_task import native_evidence
    directory = Path(row['result_path'])
    record = json.loads((directory / 'execution.json').read_text('utf-8-sig'))
    native = native_evidence(proof['threadId'], record, sessions=sessions)
    _require(native.get('state') == 'observed', 'original_native_session_unverified')
    source = Path(native['source'])
    _require(_file_hash(source) == proof['sessionSha256'], 'original_native_execution_changed')
    active = False; workflow = False; owned_sessions = set(); owned_jobs = set()
    def texts_in(value):
        pending = [value]
        while pending:
            item = pending.pop()
            if isinstance(item, str):
                yield item
            elif isinstance(item, dict):
                yield json.dumps(item, ensure_ascii=False)
                pending.extend(item.values())
            elif isinstance(item, list):
                pending.extend(item)
    rows = _StreamRows(source)
    for entry in rows:
        payload = entry.get('payload', {})
        event = payload if entry.get('type') == 'event_msg' else {}
        if event.get('type') == 'task_started':
            active = event.get('turn_id') == proof['turnId']
        if active:
            texts = []
            if entry.get('type') == 'response_item' and payload.get('type') == 'function_call':
                # Includes MCP JS arguments: nested Workflow calls must not
                # disappear merely because the native call itself returned.
                texts.append(payload.get('name', ''))
                texts.extend(texts_in(json.loads(payload['arguments'])))
            item = event.get('item', {})
            if event.get('type') == 'item_completed':
                if item.get('type') == 'CommandExecution':
                    texts.append(item['aggregated_output'])
                elif item.get('type') == 'McpToolCall':
                    texts.extend(texts_in(item['result']))
            for text in texts:
                workflow |= bool(WORKFLOW_CALL.search(text) or re.search(r'(?:^|__)(?:run_process|run_job|work_on_project)\b', text))
                for match in REFERENCE.finditer(text):
                    key, value = match.group('key', 'id')
                    if key in ('session_id', 'sessionId'):
                        if value.startswith('wc_sess_'):
                            owned_sessions.add(value)
                    else:
                        owned_jobs.add(value)
        if event.get('type') == 'task_complete' and event.get('turn_id') == proof['turnId']:
            active = False
    _require(rows.sha256 == proof['sessionSha256'], 'original_native_execution_changed')
    _require(not workflow or owned_sessions or owned_jobs, 'original_workflow_execution_unattributed')
    jobs = _workflow_jobs(Path(__file__).resolve().parents[1], owned_sessions, owned_jobs,
                          runtime_read or local_runtime_read)
    evidence = {**proof, 'source': str(source), 'workflowSessions': sorted(owned_sessions),
                'workflowJobCount': jobs, 'workflowJobsTerminal': True, 'originalNativeTerminal': not proof.get('stopped',False),
                'nativeToolsTerminal': True, 'claimReleaseAuthorized': True, 'automaticReplay': False,
                'nativeTurnState': 'cancelled_unverified' if proof.get('stopped') else 'failed'}
    verify_failed_terminal_work_evidence(row, evidence)
    return evidence


def verify_failed_terminal_work_evidence(row, evidence):
    from native_work_admission import _require
    paths = [(Path(evidence['source']), evidence['sessionSha256']),
             (Path(row['result_path']) / 'events.jsonl', evidence['eventsSha256']),
             (Path(row['result_path']) / 'execution.json', evidence['executionSha256'])]
    _require(all(_file_hash(path) == expected for path, expected in paths)
             and not (Path(row['result_path']) / 'final.md').exists(), 'original_native_execution_changed')
