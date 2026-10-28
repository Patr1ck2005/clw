'use strict';
const counters=['activeHttp','activeBrowser','brokerPending','externalOwners','physicalCleanup','pendingCompactions'];
/** Initialization failure is not permission to cancel or kill accepted work. */
async function settleNativeStartupFailure(error,{owner,serverChild,host,cleanupUnstarted,prepare,close,release}){
 const failure=error instanceof Error?error:Error('native_startup_failed');
 if(!serverChild&&!host){
  try{await cleanupUnstarted();failure.nativeStartup=Object.freeze({state:'not_started',ownerStarted:false,reason:'execution_owner_never_started'});return failure;}
  catch{failure.nativeStartup=Object.freeze({state:'cleanup_unknown',ownerStarted:true,reason:'native_startup_local_cleanup_unknown'});failure.nativeOwner=owner;return failure;}
 }
 failure.nativeOwner=owner;
 let proof,closeAttempted=false;
 try{
  if(!serverChild)throw Error('native_maintenance_owner_unavailable');
  proof=await prepare();
  if(proof?.kind!=='native_owner_maintenance'||proof.runtimePid!==serverChild.pid||!Array.isArray(proof.nativeTurns)||proof.nativeTurns.length!==0||counters.some(key=>proof[key]!==0))throw Error('native_maintenance_startup_admission_present');
  closeAttempted=true;const receipt=await close();
  if(receipt?.kind!=='native_maintenance_exit'||receipt.state!=='exited'||receipt.runtimePid!==proof.runtimePid||receipt.ownerEpoch!==proof.ownerEpoch||receipt.fenceId!==proof.fenceId||receipt.shutdownDispatched!==true||receipt.runtimeExit?.pid!==proof.runtimePid||receipt.runtimeExit.code!==0||receipt.runtimeExit.signal!==null)throw Error('native_maintenance_startup_exit_unknown');
  failure.nativeStartup=Object.freeze({state:'cleaned',ownerStarted:false,receipt});return failure;
 }catch(cleanupError){
  // A dispatched shutdown retains its exact operation and late-exit observer.
  // Before dispatch, only this controller's original caller fence can release.
  const refusedBeforeDispatch=cleanupError?.maintenanceClose?.shutdownDispatched===false&&cleanupError.maintenanceClose.stage==='before_shutdown';
  if(!closeAttempted||refusedBeforeDispatch){try{await release(proof);}catch{}}
  const code=cleanupError?.message;
  failure.nativeStartup=Object.freeze({state:'cleanup_unknown',ownerStarted:true,
   reason:/^native_[a-z_]+$/.test(code||'')?code:'native_startup_cleanup_unknown',
   ...(cleanupError?.maintenanceClose?{maintenanceClose:cleanupError.maintenanceClose}:{})});return failure;
 }
}
module.exports={settleNativeStartupFailure};
