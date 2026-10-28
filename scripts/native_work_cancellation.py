"""Withdraw an exited native executor after exact tools and owned Jobs settle.

No process termination, browser navigation, prompt send, or success synthesis.
The original native turn remains unresolved and cannot be replayed by the gate.
Cancellation intent and its one control delivery live in the existing audit.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import time
import uuid

from native_work_admission import (AdmissionError, _audit, _canonical, _read_claim,
    _read_json, _require, _result_path, _transaction, claim_owner_live)
from native_work_completion import (_StreamRows, _file_hash, _instant,
    _owned_tool_work_evidence, verify_failed_terminal_work_evidence, UUID_V7)


def stopped_tools(row, identity):
    directory=Path(row['result_path'])
    raw=(directory/'execution.json').read_bytes()
    _require(len(raw)<=65536,'native_receipt_too_large')
    record=json.loads(raw.decode('utf-8-sig'))
    _require(record.get('admissionId')==row['claim_id'] and record.get('ownerPid')==row['owner_pid']
        and _result_path(record.get('resultDirectory',''))==row['result_path']
        and _canonical(record.get('workspace',''))==row['workspace']
        and record.get('state')=='needs_attention' and type(record.get('exitCode')) is int
        and record['exitCode']!=0 and not (directory/'final.md').exists(), 'original_stopped_receipt_required')
    begin,end=_instant(record.get('startedAt')),_instant(record.get('endedAt'))
    _require(begin is not None and end is not None and begin<=end,'original_execution_window_unverified')
    events=_StreamRows(directory/'events.jsonl');threads=[];starts=0
    for item in events:
        if item.get('type')=='thread.started':threads.append(item.get('thread_id'))
        if item.get('type')=='turn.started':starts+=1
        _require(item.get('type') not in ('turn.completed','turn.failed'),'ordinary_terminal_recovery_required')
    _require(threads==[identity['threadId']] and starts==1,'original_native_thread_unverified')
    from read_codex_web_task import native_evidence
    native=native_evidence(identity['threadId'],record)
    _require(native.get('state')=='observed','original_native_session_unverified')
    source=Path(native['source']);rows=_StreamRows(source);metadata=[];turns=[]
    for item in rows:
        payload=item.get('payload',{})
        if item.get('type')=='session_meta':metadata.append(payload)
        if item.get('type')=='event_msg' and payload.get('type')=='task_started':turns.append(payload.get('turn_id'))
    _require(len(metadata)==1 and metadata[0].get('id')==identity['threadId']
        and _canonical(metadata[0].get('cwd',''))==row['workspace']
        and turns==[identity['turnId']],'original_native_turn_unverified')
    helper=Path(__file__).resolve().parents[1]/'apps/codex-web-bridge/native-terminal-receipt.cjs'
    code="try{process.stdout.write(JSON.stringify(require(process.argv[1]).verifyNativeStoppedToolsReceipt(JSON.parse(process.argv[2]))))}catch(e){process.stdout.write(JSON.stringify({error:e.message}));process.exitCode=1}"
    checked=subprocess.run(['node','-e',code,str(helper),json.dumps({**identity,'startedAt':record['startedAt'],
        'endedAt':record['endedAt']})],capture_output=True,encoding='utf8',timeout=30)
    _require(checked.returncode==0,'original_stopped_tools_unverified')
    proof=json.loads(checked.stdout)
    _require(proof.get('kind')=='native_stopped_with_terminal_tools' and proof.get('threadId')==identity['threadId']
        and proof.get('turnId')==identity['turnId'] and proof.get('sessionSha256')==rows.sha256,
        'original_stopped_tools_unverified')
    return record,{**proof,'state':'verified','stopped':True,'source':str(source),
        'executionSha256':hashlib.sha256(raw).hexdigest(),'eventsSha256':events.sha256}


def original_exited(row, record, *, revoked=False):
    _require(claim_owner_live(row) is False,'original_launcher_alive_or_unknown')
    pid=record.get('bridgeRuntimePid')
    _require(type(pid) is int and pid>0 and (revoked or claim_owner_live({'owner_pid':pid,
        'created':_instant(record['startedAt']).timestamp()}) is False),'original_bridge_alive_or_unknown')


def request_cancel(database,result_path,*,operation_id,thread_id,turn_id,trace_id):
    """Revoke only one original running turn; never release its write claim."""
    _require(str(uuid.UUID(operation_id))==operation_id,'cancellation_operation_id_required')
    import re
    _require(re.fullmatch(r'[a-f0-9]{12}',trace_id),'original_trace_required')
    row=_read_claim(database,result_path=result_path);root=Path(__file__).resolve().parents[1]
    identity={'threadId':thread_id,'turnId':turn_id}
    source=json.loads((root/'.local/codex-web-bridge/turn-sources'/f'{trace_id}.json').read_text('utf-8-sig'))
    _require(UUID_V7.fullmatch(thread_id) and UUID_V7.fullmatch(turn_id) and
        all(source.get(k)==v for k,v in {**identity,'traceId':trace_id}.items()) and
        _canonical(source.get('workingDirectory',''))==row['workspace'],'original_trace_identity_unverified')
    binding={'operationId':operation_id,'claimId':row['claim_id'],**identity,'traceId':trace_id}
    with _transaction(database) as db:
        prior=db.execute("SELECT evidence FROM native_work_recoveries WHERE claim_id=? AND kind='cancel_running_requested'",(row['claim_id'],)).fetchone()
        if prior:
            _require(json.loads(prior[0])==binding,'original_cancellation_operation_required')
            ack=db.execute("SELECT evidence FROM native_work_recoveries WHERE claim_id=? AND kind='cancel_running_acknowledged'",(row['claim_id'],)).fetchone()
            return json.loads(ack[0]) if ack else {**binding,'state':'unknown','modelSends':0,'automaticReplay':False}
    _require(row['state'] in ('running','unknown'),'original_running_claim_required')
    record=json.loads((Path(row['result_path'])/'execution.json').read_text('utf-8-sig'))
    _require(record.get('admissionId')==row['claim_id'] and record.get('ownerPid')==row['owner_pid'] and
        record.get('state')=='running' and claim_owner_live(row) is True,'original_live_launcher_required')
    from read_codex_web_task import native_evidence
    native=native_evidence(thread_id,record)
    _require(native.get('state')=='observed' and all(t['invocations']==t['returned'] for t in native['tools'].values()),
        'original_tools_in_flight_or_unknown')
    endpoint,token,pid=current_control(root,identity)
    _require(pid==record.get('bridgeRuntimePid'),'original_bridge_owner_changed')
    with _transaction(database) as db:
        current=_owned_cancel_claim(db,row)
        _require(not db.execute("SELECT 1 FROM native_work_recoveries WHERE claim_id=? AND kind='cancel_running_requested'",(row['claim_id'],)).fetchone(),
            'original_cancellation_delivery_requires_inspection_no_replay')
        _audit(db,current,'cancel_running_requested',binding)
    reply=_read_json(endpoint+'/admin/interrupt-turn',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},body=json.dumps(identity).encode())
    _require(reply.get('status')=='ok' and all(type(reply.get(k)) is int and reply[k]>=0 for k in
        ('cancelled_http_turns','cancelled_browser_turns','cancelled_compaction_runs')),'original_cancellation_acknowledgement_unverified')
    result={**binding,'state':'cancellation_requested','runtimePid':pid,'revocation':reply,'claimReleased':False,'modelSends':0,'automaticReplay':False}
    with _transaction(database) as db:_audit(db,_owned_cancel_claim(db,row),'cancel_running_acknowledged',result)
    return result


def _owned_cancel_claim(db,snapshot):
    row=db.execute('SELECT * FROM native_work_claims WHERE claim_id=?',(snapshot['claim_id'],)).fetchone()
    _require(row and row['state']==snapshot['state'] and row['updated']==snapshot['updated'],'original_claim_changed_reconcile')
    return row


def current_control(root, identity):
    status=json.loads((root/'.local/codex-web-bridge/status.json').read_text('utf-8-sig'))
    config=json.loads((root/'.local/codex-web-bridge/config.json').read_text('utf-8-sig'))
    _require(status.get('state')=='ready' and config.get('host')=='127.0.0.1'
        and type(config.get('port')) is int and 1024<=config['port']<=65535,'current_bridge_not_ready')
    endpoint=f"http://127.0.0.1:{config['port']}"
    health=_read_json(endpoint+'/healthz')
    _require(health.get('pid')==status.get('runtimePid'),'current_bridge_owner_changed')
    return endpoint,config['controlToken'],status['runtimePid']


def cancel_stopped(database,result_path,*,operation_id,thread_id,turn_id,trace_id):
    _require(str(uuid.UUID(operation_id))==operation_id,'cancellation_operation_id_required')
    _require(UUID_V7.fullmatch(thread_id) and UUID_V7.fullmatch(turn_id),'original_native_identity_required')
    import re
    _require(re.fullmatch(r'[a-f0-9]{12}',trace_id),'original_trace_required')
    root=Path(__file__).resolve().parents[1];home=root/'.local/codex-web-bridge'
    row=_read_claim(database,result_path=result_path);identity={'threadId':thread_id,'turnId':turn_id}
    source=json.loads((home/'turn-sources'/f'{trace_id}.json').read_text('utf-8-sig'))
    _require(all(source.get(k)==v for k,v in {**identity,'traceId':trace_id}.items())
        and _canonical(source.get('workingDirectory',''))==row['workspace'],'original_trace_identity_unverified')
    binding={'operationId':operation_id,'claimId':row['claim_id'],**identity,'traceId':trace_id}
    with _transaction(database) as db:
        prior=db.execute("SELECT evidence FROM native_work_recoveries WHERE claim_id=? AND kind='cancel_stopped_requested'",
            (row['claim_id'],)).fetchone()
        if prior:
            _require(json.loads(prior[0])==binding,'original_cancellation_operation_required')
            done=db.execute("SELECT evidence FROM native_work_recoveries WHERE claim_id=? AND kind='cancelled_stopped_execution'",
                (row['claim_id'],)).fetchone()
            if done:return json.loads(done[0])
            raise AdmissionError('original_cancellation_delivery_requires_inspection_no_replay')
    _require(row['state'] in ('running','unknown'),'original_running_claim_required')
    record,proof=stopped_tools(row,identity)
    with _transaction(database) as db:
        ack=db.execute("SELECT evidence FROM native_work_recoveries WHERE claim_id=? AND kind='cancel_running_acknowledged'",(row['claim_id'],)).fetchone()
    acknowledged=json.loads(ack[0]) if ack else None
    revoked=bool(acknowledged and all(acknowledged.get(k)==v for k,v in identity.items()) and
        acknowledged.get('runtimePid')==record.get('bridgeRuntimePid') and acknowledged.get('state')=='cancellation_requested')
    original_exited(row,record,revoked=revoked)
    from native_work_interruption import stopped_processes
    _require(stopped_processes(row,thread_id) is True,'original_executor_alive_or_unknown')
    proof=_owned_tool_work_evidence(row,proof)
    endpoint,token,current_pid=current_control(root,identity)
    with _transaction(database) as db:
        current=db.execute('SELECT * FROM native_work_claims WHERE claim_id=?',(row['claim_id'],)).fetchone()
        _require(current and current['state']==row['state'] and current['updated']==row['updated'],
            'original_claim_changed_reconcile')
        _require(not db.execute("SELECT 1 FROM native_work_recoveries WHERE claim_id=? AND kind='cancel_stopped_requested'",
            (row['claim_id'],)).fetchone(),'original_cancellation_delivery_requires_inspection_no_replay')
        _audit(db,current,'cancel_stopped_requested',binding)
    # One exact scoped revocation. An uncertain delivery is never submitted again.
    reply=_read_json(endpoint+'/admin/interrupt-turn',headers={'Authorization':'Bearer '+token,
        'Content-Type':'application/json'},body=json.dumps(identity).encode())
    _require(reply.get('status')=='ok' and all(type(reply.get(k)) is int and reply[k]==0 for k in
        ('cancelled_http_turns','cancelled_browser_turns','cancelled_compaction_runs')),
        'unexpected_current_execution_requires_settlement')
    _require(current_control(root,identity)[2]==current_pid,'current_bridge_owner_changed')
    original_exited(row,record,revoked=revoked)
    _require(stopped_processes(row,thread_id) is True,'original_executor_alive_or_unknown')
    verify_failed_terminal_work_evidence(row,proof)
    result={**binding,'state':'released','recovery':'cancelled_stopped_execution','taskOutcome':'cancelled_unverified',
        'originalNativeTerminal':False,'originalExecutorGone':True,'originalBridgeGone':not revoked,'originalTurnRevoked':revoked,
        'nativeToolsTerminal':True,'workflowJobsTerminal':True,'nativeTools':proof['tools'],
        'workflowJobCount':proof['workflowJobCount'],'sessionSha256':proof['sessionSha256'],
        'originalTurnHistory':'unchanged_unknown','modelSends':0,'automaticReplay':False}
    with _transaction(database) as db:
        current=db.execute('SELECT * FROM native_work_claims WHERE claim_id=?',(row['claim_id'],)).fetchone()
        _require(current and current['state']==row['state'] and current['updated']==row['updated'],
            'original_claim_changed_reconcile')
        verify_failed_terminal_work_evidence(row,proof)
        db.execute("UPDATE native_work_claims SET state='released',updated=? WHERE claim_id=?",(time.time(),row['claim_id']))
        _audit(db,current,'cancelled_stopped_execution',result)
    return result
