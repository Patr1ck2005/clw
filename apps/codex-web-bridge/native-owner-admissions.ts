import {createHash} from 'node:crypto';
import fs,{type BigIntStats} from 'node:fs';
import {join} from 'node:path';
import source from './turn-source.cjs';
import {currentNativeOwnerAdmissions,currentNativeOwnerHistory,retireNativeOwnerAdmissions,expandNativeAdmissionRecord} from './native-turn-admission';
import maintenance from './native-maintenance-session.cjs';

const digest=(value: string | Buffer)=>createHash('sha256').update(value).digest('hex');
const revision=(s: BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
const states=new Set(['incomplete','checkpoint','completed','settled_failed']);
/** Canonical pending ownership plus a constant-size verified history digest. */
function readOwner(home: string,ownerEpoch: string,account?: string,{sessionsRoot,threadId,retire=true}:{sessionsRoot?:string;threadId?:string;retire?:boolean}={}){
 const directory=join(home,'runtime/native-turn-admission');
 const admitted:any[]=[],historyAttention:any[]=[],fingerprints:string[]=[],readCache=new Map<string,{value:any;sha256:string}>();let lastReadSha='';
 const read=(file:string):any=>{
  const prior=readCache.get(file);if(prior){lastReadSha=prior.sha256;return prior.value;}
  const before=fs.statSync(file,{bigint:true});if(!before.isFile()||before.size<1n||before.size>256n*1024n)throw Error('native_maintenance_admission_unknown');
  const fd=fs.openSync(file,'r');let bytes:Buffer;
  try{if(revision(fs.fstatSync(fd,{bigint:true}))!==revision(before))throw Error('native_maintenance_admission_changed');bytes=fs.readFileSync(fd);
   if(revision(fs.fstatSync(fd,{bigint:true}))!==revision(before)||revision(fs.statSync(file,{bigint:true}))!==revision(before))throw Error('native_maintenance_admission_changed');
  }finally{fs.closeSync(fd);}
  const fileSha=digest(bytes);fingerprints.push(fileSha);const value=expandNativeAdmissionRecord(file,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),read);lastReadSha=fileSha;readCache.set(file,{value,sha256:fileSha});return value;
 };
 if(account!==undefined&&!['A','B'].includes(account))throw Error('native_maintenance_source_unknown');
 const original=currentNativeOwnerAdmissions(home,ownerEpoch),owned=original.filter(row=>!threadId||row.threadId===threadId);
 for(const accepted of owned){
  const traceId=accepted.traceId,row=read(join(directory,'trace-'+traceId+'.json'));
  if(row.version!==1||typeof row.ownerEpoch!=='string'||!row.ownerEpoch||!states.has(row.state)||!/^[a-f0-9]{64}$/.test(row.identityKey||''))throw Error('native_maintenance_admission_unknown');
  if(row.ownerEpoch!==ownerEpoch)throw Error('native_maintenance_admission_changed');
  if(!/^[a-f0-9]{12}$/.test(traceId))throw Error('native_maintenance_admission_unknown');
  const raw=read(join(home,'turn-sources',traceId+'.json')),clean=source.cleanSource(raw);
  const sourceSha256=lastReadSha;
  if(!clean||!clean.workingDirectory||(!['A','B'].includes(clean.account)||account!==undefined&&clean.account!==account)||clean.traceId!==traceId||clean.threadId!==accepted.threadId||clean.turnId!==accepted.turnId||digest(JSON.stringify([clean.threadId,clean.turnId]))!==row.identityKey)throw Error('native_maintenance_source_unknown');
  const identity=read(join(directory,'identity-'+row.identityKey+'.json'));
  const threadKey=digest(clean.threadId),thread=read(join(directory,'thread-'+threadKey+'.json'));
  let membership=thread.turns?.[row.identityKey];
  if(!membership){const archived=read(join(directory,`thread-${threadKey}-terminal-${row.identityKey}.json`));if(archived.kind==='verified_native_turn_membership'&&archived.threadKey===threadKey&&archived.identityKey===row.identityKey&&archived.threadId===clean.threadId&&archived.turnId===clean.turnId)membership={ownerEpoch:archived.ownerEpoch,state:'completed'};}
  if(identity.version!==1||identity.identityKey!==row.identityKey||identity.traces?.[traceId]?.ownerEpoch!==ownerEpoch||identity.traces?.[traceId]?.state!==row.state||
   thread.version!==1||thread.threadKey!==threadKey||membership?.ownerEpoch!==ownerEpoch||!states.has(membership?.state))throw Error('native_maintenance_admission_changed');
  let finalSha256:string|undefined,reviewSha256:string|undefined;
  if(row.state==='completed'||row.state==='checkpoint'){const review=read(join(home,'turn-reviews',traceId+'.json'));if(review.traceId!==traceId||review.threadId!==clean.threadId||review.turnId!==clean.turnId||!/^[a-f0-9]{64}$/.test(review.finalSha256||''))throw Error('native_maintenance_review_unknown');finalSha256=review.finalSha256;reviewSha256=lastReadSha;}
  admitted.push({traceId,threadId:clean.threadId,turnId:clean.turnId,state:row.state,source:clean,sourceSha256,finalSha256,reviewSha256,admissionSha256:digest(JSON.stringify([row,identity,membership]))});
 }
 if(JSON.stringify(currentNativeOwnerAdmissions(home,ownerEpoch))!==JSON.stringify(original))throw Error('native_maintenance_admission_changed');
 if(retire&&admitted.length){
  const terminals=maintenance.readNativeOwnerTerminals(admitted,{sessionsRoot,account}),ended=admitted.filter(row=>terminals.has(row.traceId)).map(row=>({...terminals.get(row.traceId),sourceSha256:row.sourceSha256,reviewSha256:row.reviewSha256,admissionSha256:row.admissionSha256}));
  if(ended.length){retireNativeOwnerAdmissions(home,ownerEpoch,ended);return readOwner(home,ownerEpoch,account,{sessionsRoot,threadId,retire:false});}
 }
 const terminalHistory=currentNativeOwnerHistory(home,ownerEpoch);
 return {admitted,historyAttention,terminalHistory,admissionSha256:digest(JSON.stringify([fingerprints,terminalHistory]))};
}

export function readNativeOwnerAdmissions(home:string,ownerEpoch:string,account:string,options:{sessionsRoot?:string}={}){if(!['A','B'].includes(account))throw Error('native_maintenance_source_unknown');return readOwner(home,ownerEpoch,account,options);}
// A new native turn is a useful retirement checkpoint. Tool reentry never scans history.
export function reconcileNativeOwnerThread(home:string,ownerEpoch:string,threadId:string,sessionsRoot?:string){return readOwner(home,ownerEpoch,undefined,{threadId,sessionsRoot});}
