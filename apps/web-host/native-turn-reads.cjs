'use strict';
const {cleanSource}=require('../codex-web-bridge/turn-source.cjs');
// Display snapshots are never evidence that maintenance is safe. This read is
// deliberately invoked only by the explicit low-frequency maintenance action.
function nativeMaintenanceTurns(bridge){
  if(!bridge)return [];
  if(typeof bridge.turns!=='function')throw Error('maintenance_exit_requires_original_receipt');
  let rows;try{rows=bridge.turns();}catch{throw Error('maintenance_exit_requires_original_receipt');}
  const terminal=status=>['completed','aborted','failed'].includes(status);
  const proofTerminal={completed:'task_complete_with_matching_final',failed:'task_complete_with_error',aborted:'turn_aborted'};
  const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
  const settled=row=>{
    if(!row||!terminal(row.status)||!terminal(row.browserStatus))return false;
    if(row.source){
      const source=cleanSource(row.source),native=row.nativeState,proof=native?.nativeProof;
      return !!source?.workingDirectory&&source.traceId===row.traceId&&terminal(native?.state)&&
        native.threadId===source.threadId&&native.turnId===source.turnId&&
        native.source==='native_session_canonical'&&native.threadActive===false&&native.activeTurnId===null&&
        Number.isFinite(Date.parse(native.endedAt))&&proof?.version===1&&proof.kind==='canonical_full_session'&&
        proof.threadId===source.threadId&&proof.turnId===source.turnId&&proof.terminal===proofTerminal[native.state]&&
        sha(proof.sessionSha256)&&sha(proof.eventSha256);
    }
    // A missing source is not proof of an idle CLI. Only the original,
    // explicitly observed pre-Send browser failure proves no CLI work began.
    return row.status==='failed'&&row.browserStatus==='failed'&&row.submission==='not-observed'&&
      row.failure?.beforeSend===true&&row.failure.submissionObserved===false;
  };
  if(!Array.isArray(rows)||rows.some(row=>!settled(row)))
    throw Error('maintenance_exit_requires_original_receipt');
  return rows;
}
function verifyNativeMaintenanceReceipt(proof){
 const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
 const v7=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value),sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
 const fail=()=>{throw Error('maintenance_exit_requires_original_receipt');};
 if(proof?.version!==1||proof.kind!=='native_owner_maintenance'||!Number.isSafeInteger(proof.runtimePid)||proof.runtimePid<1||!uuid(proof.ownerEpoch)||!uuid(proof.fenceId)||
  proof.acceptingTurns!==false||!sha(proof.admissionSha256)||proof.claimsVerified!==false||proof.claimReleaseAuthorized!==false||proof.taskAcceptance!=='unverified'||
  ['activeHttp','activeBrowser','brokerPending','externalOwners','physicalCleanup','pendingCompactions'].some(key=>proof[key]!==0)||!Array.isArray(proof.nativeTurns)||!Array.isArray(proof.historyAttention))fail();
 const seen=new Set();
 for(const row of proof.nativeTurns){
  const p=row?.nativeProof,terminal={completed:'task_complete',failed:'task_complete_with_error',aborted:'turn_aborted'};
  if(!/^[a-f0-9]{12}$/.test(row?.traceId||'')||seen.has(row.traceId)||!v7(row.threadId)||!v7(row.turnId)||row.threadId===row.turnId||!terminal[row.state]||
   !Number.isFinite(Date.parse(row.endedAt))||row.threadActive!==false||row.activeTurnId!==null||p?.version!==1||p.kind!=='canonical_native_maintenance_session'||
   p.threadId!==row.threadId||p.turnId!==row.turnId||p.terminal!==terminal[row.state]||!sha(p.sessionSha256)||!sha(p.eventSha256)||
   row.taskAcceptance!=='unverified'||row.claimReleaseAuthorized!==false||row.workflowJobAbsenceProven!==false)fail();seen.add(row.traceId);
 }
 return proof;
}
module.exports={nativeMaintenanceTurns,verifyNativeMaintenanceReceipt};
