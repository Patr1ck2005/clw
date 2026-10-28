// Only the active fence is resident; exact ended operation keys remain archived.
import {createMaintenanceOperationHistory} from './native-maintenance-history';
export interface NativeMaintenanceAuthority {ownerEpoch:string;operationHistoryDirectory?:string;read():{admitted:unknown[];historyAttention:unknown[];admissionSha256:string};verifySessions?:(admitted:unknown[],expected:unknown[])=>void;}
export function createNativeMaintenanceFence({pid,authority,readCounters,isDraining,setDraining,setBrokerFence}:{
 pid:number;authority:NativeMaintenanceAuthority;readCounters:()=>Record<string,number>;
 isDraining:()=>boolean;setDraining:(value:boolean)=>void;setBrokerFence:(value:boolean)=>void;
}){
 let fence:{operationId:string;priorDraining:boolean;admissionSha256:string;shutdownAccepted?:boolean}|null=null;
 const operations=createMaintenanceOperationHistory(pid,authority.ownerEpoch,authority.operationHistoryDirectory);
 const identity=(input:any)=>{if(input?.expectedPid!==pid||input?.expectedOwnerEpoch!==authority.ownerEpoch)throw Error('native_maintenance_owner_changed');
  if(typeof input.operationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.operationId))throw Error('native_maintenance_fence_invalid');};
 const snapshot=()=>{
  const counts=readCounters();if(Object.values(counts).some(value=>!Number.isSafeInteger(value)||value<0))throw Error('native_maintenance_execution_unknown');
  const records=authority.read();
  return {version:1,pid,ownerEpoch:authority.ownerEpoch,acceptingTurns:!isDraining(),fenceId:fence?.operationId||null,
   priorDraining:fence?.priorDraining??null,...counts,...records};
 };
 const idle=()=>{const value=snapshot();if(Object.values(readCounters()).some(value=>value!==0))throw Error('native_maintenance_execution_active');if(fence&&value.admissionSha256!==fence.admissionSha256)throw Error('native_maintenance_admission_changed');return value;};
 return {snapshot,
  action(input:any){
   identity(input);const key=input.operationId;
   if(input.action==='acquire'){
    if(operations.read(key))throw Error('native_maintenance_original_operation_ended');
    if(fence){if(fence.operationId!==key)throw Error('native_maintenance_fence_owned');return {...idle(),state:'native_owner_fenced'};}
    let original;try{original=idle();}catch(error){operations.save(key,'refused');throw error;}
    fence={operationId:key,priorDraining:isDraining(),admissionSha256:original.admissionSha256};setDraining(true);setBrokerFence(true);
    return {...idle(),state:'native_owner_fenced'};
   }
   if(input.action==='release'&&fence?.operationId!==key&&operations.read(key)==='released')return {version:1,pid,ownerEpoch:authority.ownerEpoch,fenceId:key,state:'native_fence_released',replayed:true};
   if(!fence||fence.operationId!==key)throw Error('native_maintenance_fence_owned');
   if(input.action==='verify')return {...idle(),state:'native_owner_fenced'};
   if(input.action==='release'){
    if(fence.shutdownAccepted)throw Error('native_maintenance_shutdown_original_unresolved');
    const prior=fence.priorDraining;operations.save(key,'released');fence=null;setBrokerFence(false);setDraining(prior);
    return {version:1,pid,ownerEpoch:authority.ownerEpoch,fenceId:key,state:'native_fence_released',acceptingTurns:!prior};
   }
   throw Error('native_maintenance_fence_invalid');
  },
  ownsDrain:()=>fence!==null,
  sealShutdown(input:any){identity(input);if(!fence||fence.operationId!==input.operationId)throw Error('native_maintenance_original_fence_required');fence.shutdownAccepted=true;},
  ownership:(key?:string)=>{let state:string|null=null;try{state=key?(fence?.operationId===key?'fenced':operations.read(key)):null;}catch{state='unknown';}return {fenceId:fence?.operationId||null,operationState:state};},
  preserveDrain:()=>{if(fence)fence.priorDraining=true;},
 };
}
