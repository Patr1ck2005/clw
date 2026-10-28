"""Read one original Native turn and only its identified Workflow execution.

This releases a cooperative write claim after tracked execution ends. It does
not accept the work or certify the absence of arbitrary detached shell code.
"""
import hashlib
import json
from pathlib import Path
import re

from native_work_admission import (AdmissionError, _canonical, _require,
                                   _result_path, local_runtime_read)
from harness_job_inventory import (JobInventoryError, checked_inventory,
                                   read_session_inventory, job_terminal)

WORKFLOW_CALL = re.compile(
    r'\b(?:run_process|run_job|work_on_project)\s*(?:\(|["\']?\s*[:,])|'
    r'\b(?:harness_mcp_tool|workflow_client|webcodex_client)\.(?:py|ps1)\b', re.I)
REFERENCE = re.compile(
    r'["\'](?P<key>job_id|jobId|session_id|sessionId)["\']\s*:\s*'
    r'["\'](?P<id>[A-Za-z0-9][A-Za-z0-9_-]{0,127})["\']')
JOB_STATES = {'completed', 'failed', 'cancelled'}


def _output(reply):
    _require(isinstance(reply, dict) and reply.get('isError') is not True,
             'original_workflow_jobs_unverified')
    content = reply.get('structuredContent', {})
    _require(isinstance(content, dict) and content.get('success') is True
             and content.get('error') is None and isinstance(content.get('output'), dict),
             'original_workflow_jobs_unverified')
    return content['output']


def _job_terminal(job):
    return job_terminal(job)


def _workflow_jobs(root, sessions, jobs, runtime_read):
    """Session filters precede the server limit; exact Job reads never wait."""
    observed = set()
    for session in sorted(sessions):
        try:
            output = checked_inventory(read_session_inventory(root, session, runtime_read), session)
        except JobInventoryError as error:
            raise AdmissionError('original_workflow_jobs_incomplete') from error
        rows = output.get('jobs')
        _require(isinstance(rows, list) and output.get('truncated') is False
                 and type(output.get('count')) is int and output['count'] == len(rows)
                 and type(output.get('matched_count')) is int and output['matched_count'] == len(rows),
                 'original_workflow_jobs_incomplete')
        _require(all(isinstance(row, dict) and row.get('session_id') == session
                     and isinstance(row.get('job_id'), str) and _job_terminal(row) for row in rows),
                 'original_workflow_jobs_active_or_unknown')
        observed.update(row['job_id'] for row in rows)
    remaining = sorted(jobs - observed)
    for offset in range(0, len(remaining), 8):
        batch = remaining[offset:offset + 8]
        output = _output(runtime_read(root, 'observe_jobs', {
            'items': [{'job_id': job} for job in batch], 'tail_lines': 1,
        }))
        rows = output.get('items')
        _require(isinstance(rows, list) and len(rows) == len(batch), 'original_workflow_jobs_incomplete')
        for index, row in enumerate(rows):
            _require(isinstance(row, dict) and row.get('index') == index
                     and row.get('job_id') == batch[index] and row.get('success') is True,
                     'original_workflow_jobs_active_or_unknown')
            job = row.get('output')
            _require(_job_terminal(job) and job.get('terminal') is True,
                     'original_workflow_jobs_active_or_unknown')
            observed.add(batch[index])
    return len(observed)


def terminal_work_evidence(row, *, sessions=None, runtime_read=None):
    """Full original receipts, complete native tools, then owned Workflow Jobs.

    Counts or a different project's Job are never proof about this claim.
    Unknown native tools and incomplete command sessions stay held.
    """
    from native_work_completion import completed_tools_evidence
    from read_codex_web_task import native_evidence
    directory = Path(row['result_path'])
    record = json.loads((directory / 'execution.json').read_text('utf-8-sig'))
    _require(isinstance(record, dict) and record.get('admissionId') == row['claim_id']
             and record.get('ownerPid') == row['owner_pid']
             and _result_path(record.get('resultDirectory', '')) == row['result_path']
             and isinstance(record.get('workspace'), str) and record['workspace']
             and _canonical(record.get('workspace', '')) == row['workspace'],
             'original_native_execution_identity_unverified')
    proof = completed_tools_evidence(directory, record, sessions=sessions)
    _require(proof.get('state') == 'verified', 'original_native_tools_terminal_unverified')
    native = native_evidence(proof['threadId'], record, sessions=sessions)
    _require(native.get('state') == 'observed', 'original_native_session_unverified')
    source = Path(native['source']); raw = source.read_bytes()
    _require(hashlib.sha256(raw).hexdigest() == proof['sessionSha256'], 'original_native_execution_changed')
    workflow = False; owned_sessions = set(); owned_jobs = set(); active = False
    for line in raw.decode('utf-8-sig').splitlines():
        entry = json.loads(line); payload = entry.get('payload', {})
        event = payload if entry.get('type') == 'event_msg' else {}
        if event.get('type') == 'task_started':
            active = event.get('turn_id') == proof['turnId']
        if active:
            texts = []
            if entry.get('type') == 'response_item' and payload.get('type') == 'function_call':
                arguments = json.loads(payload['arguments'])
                if payload.get('name') == 'exec_command':
                    texts.append(arguments['cmd'])
            if event.get('type') == 'item_completed' and event.get('item', {}).get('type') == 'CommandExecution':
                texts.append(event['item']['aggregated_output'])
            for text in texts:
                workflow |= bool(WORKFLOW_CALL.search(text))
                for match in REFERENCE.finditer(text):
                    key, value = match.group('key', 'id')
                    if key in ('session_id', 'sessionId'):
                        # Integer native PTY session IDs are not Workflow Sessions.
                        if value.startswith('wc_sess_'):
                            owned_sessions.add(value)
                    else:
                        owned_jobs.add(value)
        if event.get('type') == 'task_complete' and event.get('turn_id') == proof['turnId']:
            active = False
    _require(not workflow or owned_sessions or owned_jobs, 'original_workflow_execution_unattributed')
    jobs = _workflow_jobs(Path(__file__).resolve().parents[1], owned_sessions, owned_jobs,
                          runtime_read or local_runtime_read)
    _require(source.read_bytes() == raw, 'original_native_execution_changed')
    evidence = {**proof, 'source': str(source), 'workflowSessions': sorted(owned_sessions),
                'workflowJobCount': jobs, 'workflowJobsTerminal': True,
                'originalNativeTerminal': True, 'nativeToolsTerminal': True,
                'claimReleaseAuthorized': True, 'automaticReplay': False}
    verify_terminal_work_evidence(row, evidence)
    return evidence


def verify_terminal_work_evidence(row, evidence):
    paths = [(Path(evidence['source']), evidence['sessionSha256']),
             (Path(row['result_path']) / 'events.jsonl', evidence['eventsSha256']),
             (Path(row['result_path']) / 'execution.json', evidence['executionSha256'])]
    final = Path(row['result_path']) / 'final.md'
    _require(all(hashlib.sha256(path.read_bytes()).hexdigest() == expected for path, expected in paths)
             and hashlib.sha256(final.read_text('utf-8-sig').strip().encode('utf8')).hexdigest()
             == evidence['finalSha256'], 'original_native_execution_changed')
