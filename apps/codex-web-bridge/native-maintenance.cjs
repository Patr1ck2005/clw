'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
const {readMaintenanceSessions}=require('./native-maintenance-session.cjs');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const counters=['activeHttp','activeBrowser','brokerPending','externalOwners','physicalCleanup','pendingCompactions'];
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function createNativeMaintenanceController({runtimePid,request,account,sessionsRoot,home}){
 let intent=null;const issued=new WeakSet(),released=new Map(),bindings=new WeakMap();
 const read=async()=>{
  const value=await request('/admin/maintenance-state');
  if(value?.version!==1||value.pid!==runtimePid||!uuid(value.ownerEpoch)||typeof value.acceptingTurns!=='boolean'||!Array.isArray(value.admitted)||!Array.isArray(value.historyAttention)||!sha(value.admissionSha256)||counters.some(key=>!Number.isSafeInteger(value[key])||value[key]<0))throw Error('native_maintenance_owner_unknown');
  return value;
 };
 const action=(kind)=>request('/admin/maintenance-fence','POST',{action:kind,operationId:intent.operationId,expectedPid:runtimePid,expectedOwnerEpoch:intent.ownerEpoch});
 const projection=value=>{
  if(value?.state!=='native_owner_fenced'||value.pid!==runtimePid||value.ownerEpoch!==intent?.ownerEpoch||value.fenceId!==intent?.operationId||value.acceptingTurns!==false||counters.some(key=>value[key]!==0)||!sha(value.admissionSha256)||!Array.isArray(value.historyAttention))throw Error('native_maintenance_fence_unknown');
  const nativeTurns=readMaintenanceSessions(value.admitted,{sessionsRoot,account});
  const proof={version:1,kind:'native_owner_maintenance',runtimePid,ownerEpoch:value.ownerEpoch,fenceId:value.fenceId,acceptingTurns:false,
   priorDraining:value.priorDraining,admissionSha256:value.admissionSha256,...Object.fromEntries(counters.map(key=>[key,0])),nativeTurns,
   historyAttention:value.historyAttention.map(row=>({traceId:row.traceId,state:row.state,reason:'previous_runtime_owner'})),
   claimsVerified:false,taskAcceptance:'unverified',claimReleaseAuthorized:false};issued.add(proof);bindings.set(proof,value.admitted);return proof;
 };
 const owns=proof=>{if(!issued.has(proof)||proof.runtimePid!==runtimePid||proof.ownerEpoch!==intent?.ownerEpoch||proof.fenceId!==intent?.operationId)throw Error('native_maintenance_original_fence_required');};
 async function release(){
  const value=await action('release');if(value?.state!=='native_fence_released'||value.pid!==runtimePid||value.ownerEpoch!==intent.ownerEpoch||value.fenceId!==intent.operationId)throw Error('native_maintenance_release_unknown');released.set(intent.operationId,value);intent=null;return value;
 }
 async function prepare({requireNoAdmissions=false}={}){
   const original=await read();
   if(requireNoAdmissions&&original.admitted.length!==0)throw Error('native_maintenance_startup_admission_present');
   if(intent&&original.ownerEpoch!==intent.ownerEpoch)throw Error('native_maintenance_owner_changed');
   if(!intent)intent={operationId:crypto.randomUUID(),ownerEpoch:original.ownerEpoch};
   if(original.fenceId&&original.fenceId!==intent.operationId)throw Error('native_maintenance_fence_owned');
   // The original key survives any transport failure. A retry can only inspect
   // or repeat this same idempotent fence; it can never create another intent.
   const accepted=await action('acquire');
   if(accepted?.status==='refused'&&accepted.pid===runtimePid&&accepted.ownerEpoch===intent.ownerEpoch&&accepted.operationId===intent.operationId){
    const code=accepted.code;if(accepted.operationState==='refused'&&accepted.fenceId!==intent.operationId)intent=null;
    throw Error(/^native_maintenance_[a-z_]+$/.test(code)?code:'native_maintenance_fence_unknown');
   }
   try{if(requireNoAdmissions&&(!Array.isArray(accepted?.admitted)||accepted.admitted.length!==0))throw Error('native_maintenance_startup_admission_present');return projection(accepted);}catch(error){
    if(accepted?.pid===runtimePid&&accepted.ownerEpoch===intent.ownerEpoch&&accepted.fenceId===intent.operationId){
     try{await release();}catch{throw Error('native_maintenance_original_fence_unresolved');}
    }
    throw Error(/^native_maintenance_[a-z_]+$/.test(error.message||'')?error.message:'native_maintenance_session_unavailable');
   }
 }
 return {
  prepareMaintenance:()=>prepare(),
  prepareStartupCleanup:()=>prepare({requireNoAdmissions:true}),
  async verifyMaintenance(proof){owns(proof);const value=await action('verify');if(value.admissionSha256!==proof.admissionSha256)throw Error('native_maintenance_admission_changed');
   const fresh=projection(value);if(JSON.stringify(fresh.nativeTurns)!==JSON.stringify(proof.nativeTurns))throw Error('native_maintenance_session_changed');return fresh;},
  finalVerifyMaintenance(proof){
   owns(proof);const admitted=bindings.get(proof);if(typeof home!=='string'||!path.isAbsolute(home))throw Error('native_maintenance_source_unknown');
   for(const row of admitted){
    const file=path.join(home,'turn-sources',row.traceId+'.json'),before=fs.statSync(file,{bigint:true}),key=s=>['dev','ino','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
    if(!before.isFile()||before.size<1n||before.size>16384n||!sha(row.sourceSha256))throw Error('native_maintenance_source_unknown');
    const fd=fs.openSync(file,'r');let raw;try{if(key(fs.fstatSync(fd,{bigint:true}))!==key(before))throw Error('native_maintenance_source_changed');raw=fs.readFileSync(fd);
     if(key(fs.fstatSync(fd,{bigint:true}))!==key(before)||key(fs.statSync(file,{bigint:true}))!==key(before))throw Error('native_maintenance_source_changed');}finally{fs.closeSync(fd);}
    if(crypto.createHash('sha256').update(raw).digest('hex')!==row.sourceSha256)throw Error('native_maintenance_source_changed');
   }
   const fresh=readMaintenanceSessions(admitted,{sessionsRoot,account});
   if(JSON.stringify(fresh)!==JSON.stringify(proof.nativeTurns))throw Error('native_maintenance_session_changed');return proof;
  },
  async resumeMaintenance(proof){
   if(proof===undefined){
    if(!intent)return {state:'native_fence_not_requested'};
    // Release is identity-only CAS on this retained caller key. A read fault
    // must not erase the key or require a fabricated idle/Session proof.
    return release();
   }
   if(issued.has(proof)&&released.has(proof.fenceId))return released.get(proof.fenceId);owns(proof);return release();
  },
  assertOriginalProof(proof){owns(proof);},
 };
}
module.exports={createNativeMaintenanceController};
