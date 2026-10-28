'use strict';
// Canonical proofs read the original fd, never the display append cache. The
// per-record limit bounds one tool envelope; file lifetime has no byte limit.
const fs=require('node:fs'),crypto=require('node:crypto');
const CHUNK_BYTES=64*1024,MAX_RECORD_BYTES=16*1024*1024;
const revision=stat=>['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(stat[key])).join(':');
function sessionRevision(file){return revision(fs.statSync(file,{bigint:true}));}
function createSessionScan(file,{prefix='native_receipt',preserveCarriageReturn=false,includeEmpty=false}={}){
 const before=fs.statSync(file,{bigint:true}),key=revision(before);
 if(!before.isFile()||before.size<1n)throw Error(prefix+'_session_size_invalid');
 const scan={revision:key,sessionSha256:null,size:before.size,
  assertUnchanged(){if(sessionRevision(file)!==key)throw Error(prefix+'_session_changed');},
  *[Symbol.iterator](){
   const fd=fs.openSync(file,'r'),hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(CHUNK_BYTES);
   let pending=[],pendingBytes=0,position=0n,first=true;
   const decode=bytes=>{let line=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(first){line=line.replace(/^\uFEFF/,'');first=false;}return !preserveCarriageReturn&&line.endsWith('\r')?line.slice(0,-1):line;};
   try{
    if(revision(fs.fstatSync(fd,{bigint:true}))!==key)throw Error(prefix+'_session_changed');
    while(position<before.size){
     const length=Number(before.size-position>BigInt(CHUNK_BYTES)?BigInt(CHUNK_BYTES):before.size-position);
     const count=fs.readSync(fd,buffer,0,length,Number(position));if(!count)throw Error(prefix+'_session_changed');
     position+=BigInt(count);const chunk=buffer.subarray(0,count);hash.update(chunk);let offset=0,end;
     while((end=chunk.indexOf(10,offset))>=0){
      const part=chunk.subarray(offset,end);if(pendingBytes+part.length>MAX_RECORD_BYTES)throw Error(prefix+'_record_size_invalid');
      const line=decode(pending.length?Buffer.concat([...pending,part],pendingBytes+part.length):part);pending=[];pendingBytes=0;
      if(line||includeEmpty)yield line;offset=end+1;
     }
     if(offset<count){const tail=Buffer.from(chunk.subarray(offset));pendingBytes+=tail.length;if(pendingBytes>MAX_RECORD_BYTES)throw Error(prefix+'_record_size_invalid');pending.push(tail);}
    }
    if(pendingBytes){const line=decode(Buffer.concat(pending,pendingBytes));if(line)yield line;}
    if(revision(fs.fstatSync(fd,{bigint:true}))!==key)throw Error(prefix+'_session_changed');scan.assertUnchanged();
    scan.sessionSha256=hash.digest('hex');
   }finally{fs.closeSync(fd);}
  }};
 return scan;
}
module.exports={createSessionScan,sessionRevision,MAX_RECORD_BYTES};
