'use strict';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
/** Observe this exact child object. Timeout never kills or substitutes a PID probe. */
function waitNormalChildExit(child,timeoutMs=10000){
 if(!child||!Number.isSafeInteger(child.pid)||child.pid<1)return Promise.reject(Error('native_maintenance_child_unknown'));
 const result=()=>({pid:child.pid,code:child.exitCode,signal:child.signalCode??null});
 const validate=value=>{if(value.code!==0||value.signal!==null)throw Error('native_maintenance_child_exit_failed');return value;};
 if(child.exitCode!==null||child.signalCode)return Promise.resolve().then(()=>validate(result()));
 return new Promise((resolve,reject)=>{
  let timer;const finish=error=>{clearTimeout(timer);child.removeListener('exit',onExit);child.removeListener('error',onError);error?reject(error):resolve(result());};
  const onExit=(code,signal)=>{if(code!==0||signal!==null)finish(Error('native_maintenance_child_exit_failed'));else finish();};
  const onError=()=>finish(Error('native_maintenance_child_exit_unknown'));
  child.once('exit',onExit);child.once('error',onError);
  if(timeoutMs!==null)timer=setTimeout(()=>finish(Error('native_maintenance_child_exit_unknown')),timeoutMs);
  // An exit between the first check and attaching the event must still be read.
  if(child.exitCode!==null||child.signalCode){try{validate(result());finish();}catch(e){finish(e);}}
 });
}
function createNativeMaintenanceExit({child,listener,hasOwnedTunnel=()=>false,getProof,verify,finalVerify,shutdown,timeoutMs=10000}){
 let original=null,dispatched=false,receipt=null,inflight=null,listenerPid=null,settlement=null;
 const observers=new Set();
 const failure=(code,state='unknown')=>{
  const error=Error(code);error.maintenanceClose={version:1,kind:'native_maintenance_exit',state,
   runtimePid:original?.runtimePid??child?.pid??null,ownerEpoch:original?.ownerEpoch??null,fenceId:original?.fenceId??null,
   stage:dispatched?'shutdown_dispatched':'before_shutdown',shutdownDispatched:dispatched};return error;
 };
 const emit=value=>{for(const observer of observers)try{observer(value);}catch{}};
 function observe(){
  if(settlement)return settlement;
  // This program-owned wait is not cancelled by a caller's UI timeout. It can
  // finish the original listener even if the server exits after that timeout.
  settlement=(async()=>{
   let runtimeExit,listenerExit;
   try{runtimeExit=await waitNormalChildExit(child,null);if(runtimeExit.pid!==original.runtimePid)throw Error('native_maintenance_child_exit_unknown');
    listenerExit=listener?await listener.stopMaintenance({ownerPid:original.runtimePid,operationId:original.fenceId,timeoutMs:null}):null;
    if(listener&&(listenerExit?.pid!==listenerPid||listenerExit.code!==0||listenerExit.signal!==null))throw Error('native_maintenance_child_exit_failed');
   }catch(error){throw failure(/^native_maintenance_[a-z_]+$/.test(error.message||'')?error.message:'native_maintenance_child_exit_unknown',error.message==='native_maintenance_child_exit_failed'?'failed':'unknown');}
   receipt=Object.freeze({version:1,kind:'native_maintenance_exit',state:'exited',...original,shutdownDispatched:true,runtimeExit,listenerExit,tunnelExit:null});emit(receipt);return receipt;
  })();
  settlement.catch(error=>{emit(error.maintenanceClose);});return settlement;
 }
 async function close(){
  if(receipt)return receipt;
  if(!dispatched){
   const proof=getProof();
   if(!proof||proof.runtimePid!==child?.pid||!uuid(proof.ownerEpoch)||!uuid(proof.fenceId))throw failure('native_maintenance_original_fence_required','refused');
   original={runtimePid:proof.runtimePid,ownerEpoch:proof.ownerEpoch,fenceId:proof.fenceId};
   if(hasOwnedTunnel())throw failure('native_maintenance_tunnel_graceful_unavailable','refused');
   if(child.exitCode!==null||child.signalCode)throw failure('native_maintenance_child_exited_before_shutdown','refused');
   try{if(listener){const pinned=listener.prepareMaintenance({ownerPid:original.runtimePid,operationId:original.fenceId});if(!Number.isSafeInteger(pinned?.pid)||pinned.pid<1)throw Error();listenerPid=pinned.pid;}}catch{throw failure('native_maintenance_listener_unknown','refused');}
   let fresh;try{fresh=await verify(proof);finalVerify(fresh);}catch{throw failure('native_maintenance_close_verification_refused','refused');}
   if(fresh.runtimePid!==original.runtimePid||fresh.ownerEpoch!==original.ownerEpoch||fresh.fenceId!==original.fenceId)throw failure('native_maintenance_original_fence_required','refused');
   // Pin before transport: a lost reply may have accepted shutdown. Never POST again.
   dispatched=true;
   try{
    const ack=await shutdown(original);
    const matches=ack?.pid===original.runtimePid&&ack.ownerEpoch===original.ownerEpoch&&ack.operationId===original.fenceId;
    if(matches&&ack.status==='refused'&&ack.shutdownDispatched===false){dispatched=false;throw failure('native_maintenance_shutdown_refused','refused');}
    if(!matches||ack.state!=='native_shutdown_accepted'||ack.shutdownDispatched!==true){observe();throw failure('native_maintenance_shutdown_unknown');}
   }catch(error){
    if(error.maintenanceClose)throw error;
    // The original child's exit remains observable after a transport failure.
   }
  }
  const originalSettlement=observe();let timer;
  try{return await Promise.race([originalSettlement,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('native_maintenance_child_exit_unknown')),timeoutMs);})]);}finally{clearTimeout(timer);}
 }
 return {close(){if(inflight)return inflight;inflight=close().finally(()=>{inflight=null;});return inflight;},
  onSettlement(callback){if(typeof callback!=='function')throw Error('native_maintenance_observer_invalid');observers.add(callback);if(receipt)queueMicrotask(()=>{if(observers.has(callback))callback(receipt);});return ()=>observers.delete(callback);},
  get shutdownDispatched(){return dispatched;}};
}
module.exports={createNativeMaintenanceExit,waitNormalChildExit};
