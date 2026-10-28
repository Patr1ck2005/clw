'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createSessionScan}=require('./native-session-stream.cjs');
const {writePrivateFileAtomic}=require('./upstream/launcher/electron/atomic-file.cjs');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revision=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
const MAX_RECORD=256*1024,PART_BYTES=128*1024,fields=new Set(['sources','physical','diagnostics']);
function rawRecord(file,max=MAX_RECORD){
 const before=fs.statSync(file,{bigint:true}),key=revision(before);
 if(!before.isFile()||before.size<1n||before.size>BigInt(max))throw Error('compaction_failure_evidence_size');
 const fd=fs.openSync(file,'r');let raw;
 try{if(revision(fs.fstatSync(fd,{bigint:true}))!==key)throw Error('compaction_failure_evidence_changed');
  raw=fs.readFileSync(fd,'utf8');
  if(revision(fs.fstatSync(fd,{bigint:true}))!==key||revision(fs.statSync(file,{bigint:true}))!==key)throw Error('compaction_failure_evidence_changed');
 }finally{fs.closeSync(fd);}
 return raw;
}
const partFile=(file,field,index)=>path.join(file+'.parts',field+'-'+index+'.json');
function read(file,max=MAX_RECORD){
 const initialRevision=revision(fs.statSync(file,{bigint:true})),raw=rawRecord(file,max);let manifest;
 if(revision(fs.statSync(file,{bigint:true}))!==initialRevision)throw Error('compaction_failure_evidence_changed');
 try{manifest=JSON.parse(raw);}catch{return raw;}
 if(manifest?.kind!=='native_compaction_group_manifest')return raw;
 if(manifest.version!==2||!Array.isArray(manifest.order)||!manifest.metadata||!manifest.arrays||!/^[a-f0-9]{64}$/.test(manifest.recordSha256||''))throw Error('compaction_failure_group_unknown');
 const arrays={},fingerprints=[[file,initialRevision]];
 for(const [field,entry]of Object.entries(manifest.arrays)){
  if(!fields.has(field)||!Number.isSafeInteger(entry.count)||entry.count<0||!Number.isSafeInteger(entry.parts)||entry.parts<1||!/^[a-f0-9]{64}$/.test(entry.partsSha256||''))throw Error('compaction_failure_group_unknown');
  const hash=crypto.createHash('sha256'),items=[];
  for(let index=0;index<entry.parts;index++){
   const target=partFile(file,field,index),before=revision(fs.statSync(target,{bigint:true}));
   const rawPart=rawRecord(target),part=JSON.parse(rawPart);hash.update(rawPart);
   if(revision(fs.statSync(target,{bigint:true}))!==before)throw Error('compaction_failure_group_changed');fingerprints.push([target,before]);
   if(part.version!==1||part.kind!=='native_compaction_group_part'||part.field!==field||part.index!==index||!Array.isArray(part.items))throw Error('compaction_failure_group_unknown');
   for(const item of part.items)items.push(item);
  }
  if(items.length!==entry.count||hash.digest('hex')!==entry.partsSha256)throw Error('compaction_failure_group_changed');arrays[field]=items;
 }
 const record={};
 for(const field of manifest.order){
  if(typeof field!=='string'||Object.hasOwn(record,field))throw Error('compaction_failure_group_unknown');
  if(Object.hasOwn(arrays,field))record[field]=arrays[field];
  else if(Object.hasOwn(manifest.metadata,field))record[field]=manifest.metadata[field];
  else throw Error('compaction_failure_group_unknown');
 }
 if(Object.keys(record).length!==Object.keys(manifest.metadata).length+Object.keys(arrays).length||digest(record)!==manifest.recordSha256)throw Error('compaction_failure_group_changed');
 for(const [target,key]of fingerprints)if(revision(fs.statSync(target,{bigint:true}))!==key)throw Error('compaction_failure_group_changed');
 return JSON.stringify(record);
}
function save(file,record){
 const raw=JSON.stringify(record)+'\n';
 if(Buffer.byteLength(raw)<=MAX_RECORD){writePrivateFileAtomic(file,raw);return;}
 const manifest={version:2,kind:'native_compaction_group_manifest',order:Object.keys(record),metadata:{},arrays:{},recordSha256:digest(record)};
 for(const [field,value]of Object.entries(record)){
  if(!fields.has(field)||!Array.isArray(value)){manifest.metadata[field]=value;continue;}
  const hash=crypto.createHash('sha256');let index=0,items=[],size=0;
  const flush=()=>{
   const part=JSON.stringify({version:1,kind:'native_compaction_group_part',field,index,items})+'\n',target=partFile(file,field,index);
   if(Buffer.byteLength(part)>MAX_RECORD)throw Error('compaction_failure_evidence_size');
   fs.mkdirSync(path.dirname(target),{recursive:true});
   if(fs.existsSync(target)){if(rawRecord(target)!==part)throw Error('compaction_failure_group_changed');}
   else writePrivateFileAtomic(target,part);
   hash.update(part);index++;items=[];size=0;
  };
  for(const item of value){const bytes=Buffer.byteLength(JSON.stringify(item))+1;if(items.length&&size+bytes>PART_BYTES)flush();items.push(item);size+=bytes;}
  if(items.length||!index)flush();manifest.arrays[field]={count:value.length,parts:index,partsSha256:hash.digest('hex')};
 }
 const body=JSON.stringify(manifest)+'\n';if(Buffer.byteLength(body)>MAX_RECORD)throw Error('compaction_failure_evidence_size');
 // Full parts first; the original proof stays unresolved until the manifest is durable.
 writePrivateFileAtomic(file,body);if(digest(JSON.parse(read(file)))!==digest(record))throw Error('compaction_failure_group_changed');
}
function* turnNames(directory,pattern){
 const dir=fs.opendirSync(directory);
 try{let entry;while((entry=dir.readSync()))if(pattern.test(entry.name)){if(!entry.isFile())throw Error('compaction_failure_turn_unknown');yield entry.name;}}
 finally{dir.closeSync();}
}
function* activity(home){
 // The complete original activity is stable and hashed while read. Only the
 // original group's events are retained by its caller; history has no byte cap.
 const scan=createSessionScan(path.join(home,'activity.jsonl'),{prefix:'compaction_activity'});
 for(const line of scan)yield JSON.parse(line);
}
module.exports={read,save,turnNames,activity};
