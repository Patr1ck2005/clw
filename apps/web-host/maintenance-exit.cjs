'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const freshReads=new WeakMap();
function sameReadOwner(root,original,read){
 return read.root===root&&original.runtime===read.runtime&&original.child===read.child&&original.child?.pid===read.hostPid&&
   original.store===read.store&&original.instance===read.instance&&original.runtime?.ready===true&&
   original.runtime.child===read.child&&(original.runtime.store||original.runtime.info?.store_id)===read.store&&original.runtime.info?.instance_id===read.instance;
}
async function readProof(root,original,payload){
 // Bind freshness to this exact response from the original private pipe.
 // Python's precise UTC and Node's Windows wall clock need not share a tick.
 const read={root,runtime:original.runtime,child:original.child,hostPid:original.child?.pid,store:original.store,instance:original.instance,startedAt:performance.now()};
 if(!sameReadOwner(root,original,read))throw Error('maintenance_original_execution_unresolved');
 if(!Number.isFinite(read.startedAt)||read.startedAt<0)throw Error('maintenance_exit_requires_original_receipt');
 const proof=await read.runtime.call('maintenance-readiness',payload);
 const receivedAt=performance.now();
 if(!sameReadOwner(root,original,read))throw Error('maintenance_original_execution_unresolved');
 if(!Number.isFinite(receivedAt)||receivedAt<read.startedAt||!proof||typeof proof!=='object')throw Error('maintenance_exit_requires_original_receipt');
 const freshRead=Object.freeze({kind:'original_host_maintenance_fresh_read'});
 freshReads.set(freshRead,{...read,receivedAt,proof});return {proof,freshRead};
}
function ledgerFingerprint(root){
 const home=path.join(root,'.local/harness');
 const rows=['harness.sqlite3','harness.sqlite3-wal'].map(name=>{try{const s=fs.statSync(path.join(home,name),{bigint:true});if(!s.isFile())throw Error('maintenance_ledger_unavailable');return [name,...['dev','ino','size','mtimeNs'].map(k=>String(s[k]))];}catch(e){if(e.code==='ENOENT')return [name,'absent'];throw e;}});
 return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
function workspaceRevision(driver,pool,workspace){
 return JSON.stringify({records:[...driver.records].map(([id,r])=>[id,r.thread_id,r.url,r.paused,r.phase,r.bootstrap_state,r.latest_request?.id,r.latest_request?.phase,r.latest_request?.attempt_id,r.latest_request?.sent_user_hash,r.attempt,r.maintenance?.run_id,r.maintenance?.state,r.maintenance?.revision]),
 pages:[...pool.pages].map(([id,p])=>[id,p.kind,p.account,p.closed,p.view?.webContents?.id,p.view?.webContents?.getURL?.()]),tasks:[...workspace.tasks].map(([id,t])=>[id,t.kind,t.account,t.model]),pending:workspace.pendingStarts});
}
function pageBindings(driver,pool){return [...pool.pages.values()].flatMap(p=>{const r=driver.records.get(p.id);return r?.thread_id?[{page_id:p.id,thread_id:r.thread_id,url:r.url||null,request_id:r.latest_request?.id||null,request_phase:r.latest_request?.phase||null,attempt_id:r.latest_request?.attempt_id||null}]:[];});}
function observerWaitingResult(record,pending){
 const request=record?.latest_request,attempt=record?.attempt;
 return record?.paused===true&&pending&&pending.attempt===request?.attempt_id&&!pending.state&&
  attempt?.id===request.attempt_id&&attempt.state==='acknowledged'&&Number.isFinite(attempt.acknowledged)&&
  /^[a-f0-9]{64}$/.test(request.sent_user_hash||'');
}
function pendingQuitIds(driver,ordinary=false){return [...(driver?.pending||[])].filter(([id,p])=>{
 const r=driver.records.get(id);
 // A retained send/result entry is not an executing RPC. Actual driver busy,
 // private-pipe calls and fresh renderer activity are checked independently.
 return !ordinary||!(r?.paused===true&&p?.attempt&&p.attempt===r.latest_request?.attempt_id&&
   (!r.attempt||r.attempt.id===p.attempt));
}).map(([id])=>id);}
function pageBlocked(page,snapshot,code){
 const reasons=[];
 for(const [field,reason] of [['generating','browser_generating'],['rawStopPresent','browser_stop_present'],['draft','browser_draft'],['composing','browser_composing'],['approvalRequired','browser_confirmation']])if(snapshot?.[field]===true)reasons.push(reason);
 if(!reasons.length)reasons.push(code||'browser_identity_unverified');
 return Object.assign(Error('原网页仍在工作或状态待核对：'+(page.title||page.id)),{code:reasons[0],blockedReasons:reasons.map(code=>({code,page_id:page.id,title:page.title||page.id}))});
}
function ordinaryCarrier(page,record,snapshot,{now=Date.now(),allowDeliveryWitness=true}={}){
 const request=record?.latest_request,attempt=record?.attempt,active=['queued','processing','suspended'].includes(request?.phase);
 if(record?.paused!==true||snapshot?.generating!==false||snapshot.composing!==false||snapshot.approvalRequired!==false||snapshot.rawStopPresent!==false||snapshot.error||snapshot.unknown||snapshot.known===false)throw pageBlocked(page,snapshot);
 let marker=null,expected=null,observed=null;
 if(active&&request.attempt_id&&allowDeliveryWitness){
  if(attempt&&attempt.id!==request.attempt_id)throw pageBlocked(page,snapshot,'original_attempt_unverified');
  const saved='[CLW:'+request.attempt_id+']',hash=crypto.createHash('sha256').update(snapshot.userId||'').digest('hex');
  if(attempt?.state==='acknowledged'&&Number.isFinite(attempt.acknowledged)&&/^[a-f0-9]{64}$/.test(request.sent_user_hash||'')&&
     snapshot.attemptMarker===saved&&snapshot.attemptMarkerCount===1&&snapshot.historyAtLatest===true&&snapshot.userId&&hash===request.sent_user_hash){
   marker=saved;expected=request.sent_user_hash;observed=hash;
  }
  // Ordinary exit certifies this owned page is quiet, not that a historical
  // send succeeded. Unknown/dispatching records and any original ACK stay as-is.
 }
 return {page_id:page.id,thread_id:record.thread_id,request_id:request?.id||null,attempt_id:request?.attempt_id||null,observed_at:now/1000,paused:true,generating:false,draft:snapshot.draft===true,composing:false,raw_stop_present:false,confirmation:false,identity_verified:true,marker,expected_user_hash:expected,observed_user_hash:observed};
}
function assertProof(root,proof,original={}){
 const {store,instance,child,ledgerFingerprint:originalFingerprint,now=Date.now(),allowElapsed=false}=original;
 let age,validTime;
 if(Object.hasOwn(original,'freshRead')){
   const read=freshReads.get(original.freshRead),current=performance.now();
   age=read?current-read.startedAt:NaN;
   validTime=!!read&&read.proof===proof&&sameReadOwner(root,original,read)&&Number.isFinite(current)&&current>=read.receivedAt&&Number.isFinite(age)&&age>=0;
 }else{age=now-proof?.observedAt*1000;validTime=Number.isFinite(age)&&age>=0;}
 const inventoryVerified=proof.jobs?.ownedActiveJobs===0&&proof.jobs?.inventoryComplete===true&&typeof proof.jobs?.clientId==='string'&&!!proof.jobs.clientId;
 const jobsVerified=original.ordinaryExit===true?
   proof.jobs?.source==='independent_execution_retained'&&proof.jobs.desktopShutdownBlocked===false&&proof.jobs.remoteInventoryRead===false||inventoryVerified:
   inventoryVerified;
 if(proof?.version!==1||proof.source!=='original_host_maintenance_readonly'||proof.idle!==true||original.ordinaryExit===true&&proof.exitMode!=='ordinary'||original.ordinaryExit!==true&&proof.exitMode&&proof.exitMode!=='maintenance'||proof.root!==root||proof.storeId!==store||!(/^[a-f0-9]{32}$/).test(proof.permitId||'')||!(/^[a-f0-9]{32}$/).test(instance||'')||proof.instanceId!==instance||!Number.isSafeInteger(child?.pid)||proof.hostPid!==child.pid||!Number.isFinite(proof.observedAt)||!validTime||!allowElapsed&&age>30000||!jobsVerified)throw Error('maintenance_exit_requires_original_receipt');
 if(originalFingerprint!==proof.ledgerFingerprint||proof.ledgerFingerprint!==ledgerFingerprint(root))throw Error('maintenance_original_store_changed');
}
function assertNativeExit(receipt,proof){
 const exited=row=>row&&Number.isSafeInteger(row.pid)&&row.pid>0&&row.code===0&&row.signal===null;
 if(receipt?.version!==1||receipt.kind!=='native_maintenance_exit'||receipt.state!=='exited'||receipt.runtimePid!==proof.runtimePid||receipt.ownerEpoch!==proof.ownerEpoch||receipt.fenceId!==proof.fenceId||receipt.shutdownDispatched!==true||!exited(receipt.runtimeExit)||receipt.runtimeExit.pid!==proof.runtimePid||receipt.listenerExit!==null&&!exited(receipt.listenerExit)||receipt.tunnelExit!==null)throw Error('maintenance_original_native_exit_unverified');
 return receipt;
}
function assertHostExit(receipt,original){
 if(receipt?.version!==1||receipt.kind!=='original_host_maintenance_exit'||receipt.state!=='exited'||receipt.hostPid!==original.child.pid||receipt.instanceId!==original.instance||receipt.storeId!==original.store||receipt.permitId!==original.hostProof.permitId||receipt.shutdownDispatched!==true||receipt.runtimeExit?.pid!==original.child.pid||receipt.runtimeExit.code!==0||receipt.runtimeExit.signal!==null)throw Error('maintenance_original_host_exit_unverified');
 return receipt;
}
function originalRefusal(error,original){
 const value=error?.maintenanceClose;if(value?.version!==1||value.state!=='refused'||value.stage!=='before_shutdown'||value.shutdownDispatched!==false)return false;
 if(value.kind==='native_maintenance_exit')return !original.nativeDisabled&&!original.nativeExit&&value.runtimePid===original.nativeProof.runtimePid&&value.ownerEpoch===original.nativeProof.ownerEpoch&&value.fenceId===original.nativeProof.fenceId;
 return (original.nativeDisabled||!!original.nativeExit)&&value.kind==='original_host_maintenance_exit'&&value.hostPid===original.child.pid&&value.instanceId===original.instance&&value.storeId===original.store&&value.permitId===original.hostProof.permitId;
}
function originalHostDisconnect(original,runtime){return !!original&&original.runtime===runtime&&original.hostCloseDispatched===true&&runtime.closed===true&&runtime.maintenanceCloseChild===original.child&&(runtime.store||runtime.info?.store_id)===original.store&&runtime.info?.instance_id===original.instance;}
module.exports={ledgerFingerprint,workspaceRevision,pageBindings,readProof,assertProof,assertNativeExit,assertHostExit,originalRefusal,originalHostDisconnect,observerWaitingResult,pendingQuitIds,pageBlocked,ordinaryCarrier};
