import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

type Terminal='released'|'refused';
const revision=(stat:fs.BigIntStats)=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].map(String).join(':');
/** Exact original-key tombstones. History is never loaded into the active fence. */
export function createMaintenanceOperationHistory(pid:number,ownerEpoch:string,base?:string){
 const epoch=createHash('sha256').update(JSON.stringify([pid,ownerEpoch])).digest('hex');
 const directory=join(base??join(tmpdir(),'clw-native-maintenance-operations'),epoch);
 const pending=new Map<string,Terminal>();
 const file=(key:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key))throw Error('native_maintenance_fence_invalid');return join(directory,key.toLowerCase()+'.json');};
 const read=(key:string):Terminal|null=>{
  const target=file(key);let before:fs.BigIntStats;
  try{before=fs.statSync(target,{bigint:true});}catch(error:any){if(error.code==='ENOENT')return pending.get(key)||null;throw Error('native_maintenance_operation_history_unknown');}
  if(!before.isFile()||before.size<1n||before.size>4096n)throw Error('native_maintenance_operation_history_unknown');
  const fd=fs.openSync(target,'r');let value:any;
  try{if(revision(fs.fstatSync(fd,{bigint:true}))!==revision(before))throw Error();value=JSON.parse(fs.readFileSync(fd,'utf8'));
   if(revision(fs.fstatSync(fd,{bigint:true}))!==revision(before)||revision(fs.statSync(target,{bigint:true}))!==revision(before))throw Error();
  }catch{throw Error('native_maintenance_operation_history_unknown');}finally{fs.closeSync(fd);}
  if(value.version!==1||value.pid!==pid||value.ownerEpoch!==ownerEpoch||value.operationId!==key||!['released','refused'].includes(value.state))throw Error('native_maintenance_operation_history_unknown');
  if(pending.has(key)&&pending.get(key)!==value.state)throw Error('native_maintenance_operation_history_unknown');
  return value.state;
 };
 const save=(key:string,state:Terminal)=>{
  // Save before clearing the current fence. A failed write retains original state.
  pending.set(key,state);const prior=read(key);if(prior!==state)throw Error('native_maintenance_operation_history_unknown');
  const target=file(key),record=JSON.stringify({version:1,pid,ownerEpoch,operationId:key,state})+'\n';
  fs.mkdirSync(directory,{recursive:true});let fd:number|undefined;
  try{fd=fs.openSync(target,'wx',0o600);fs.writeFileSync(fd,record);fs.fsyncSync(fd);}
  catch(error:any){if(error.code!=='EEXIST'||read(key)!==state)throw Error('native_maintenance_operation_history_unknown');}
  finally{if(fd!==undefined)fs.closeSync(fd);}
  if(read(key)!==state)throw Error('native_maintenance_operation_history_unknown');pending.delete(key);
 };
 return {read,save,pendingCount:()=>pending.size};
}
