'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const {writePrivateFileAtomic}=require('../codex-web-bridge/upstream/launcher/electron/atomic-file.cjs');

// Diagnostic snapshots are derived data. A locked file must not stop another
// task, break the UI timer, or replace a valid snapshot with a partial write.
function writeStatusFiles(folder,snapshots,write=writePrivateFileAtomic){
  const failures=[];
  for(const [name,value] of Object.entries(snapshots)){
    try{write(path.join(folder,name),JSON.stringify(value));}
    catch(error){failures.push({file:name,code:error.code||'snapshot_write_failed'});}
  }
  return failures;
}
let temporarySequence=0;
const renameDelays=[25,50,100,150,250,350,500];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Derived snapshots do not authorize execution. Their atomic replacement may
// wait for a Windows file reader, but must never block Electron's main thread.
async function writePrivateStatusAtomic(file,content,{rename=fs.rename,platform=process.platform,sleep=wait}={}){
  const directory=path.dirname(file),temporary=file+'.tmp-'+process.pid+'-'+Date.now()+'-'+(++temporarySequence);
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  try{await fs.chmod(directory,0o700);}catch{}
  try{
    await fs.writeFile(temporary,content,{flag:'wx',mode:0o600});
    for(let attempt=0;;attempt++){
      try{await rename(temporary,file);break;}
      catch(error){
        const delay=renameDelays[attempt];
        if(platform!=='win32'||!['EBUSY','EPERM','EACCES'].includes(error.code)||delay===undefined)throw error;
        await sleep(delay);
      }
    }
    try{await fs.chmod(file,0o600);}catch{}
  }finally{try{await fs.rm(temporary,{force:true});}catch{}}
}
function snapshotSignature(value){
  const {at,...metadata}=value;
  if(Array.isArray(metadata.pages))metadata.pages=metadata.pages.map(page=>{
    if(!page.observation)return page;
    const {at,modelCheckedAt,...observation}=page.observation;return {...page,observation};
  });
  return JSON.stringify(metadata);
}
class StatusFileWriter {
  constructor(folder,{write=writePrivateStatusAtomic,onFailures=()=>{},now=Date.now,heartbeatMs=10000,
    heartbeatByFile={'health.json':5000}}={}){
    Object.assign(this,{folder,write,onFailures,now,heartbeatMs,heartbeatByFile});
    this.files=new Map();this.failures=new Map();this.active=new Set();this.closed=false;
    this.metrics={requested:0,written:0,unchanged:0,coalesced:0,failed:0};
  }
  request(snapshots){
    if(this.closed)return;
    for(const [name,value]of Object.entries(snapshots)){
      if(!/^[a-z][a-z0-9-]*\.json$/.test(name))throw Error('status_snapshot_name_invalid');
      this.metrics.requested++;
      let entry=this.files.get(name);if(!entry){entry={};this.files.set(name,entry);}
      const signature=snapshotSignature(value),heartbeat=this.heartbeatByFile[name]??this.heartbeatMs;
      if(!entry.running&&!entry.pending&&signature===entry.signature&&this.now()-(entry.writtenAt??-Infinity)<heartbeat&&!this.failures.has(name)){
        this.metrics.unchanged++;continue;
      }
      if(entry.pending)this.metrics.coalesced++;
      entry.pending={value,signature};
      if(!entry.running){entry.running=true;const draining=this.drain(name,entry);this.active.add(draining);
        draining.finally(()=>this.active.delete(draining));}
    }
  }
  async drain(name,entry){
    try{
      while(entry.pending){
        const pending=entry.pending;entry.pending=null;
        const heartbeat=this.heartbeatByFile[name]??this.heartbeatMs;
        if(pending.signature===entry.signature&&this.now()-(entry.writtenAt??-Infinity)<heartbeat&&!this.failures.has(name)){
          this.metrics.unchanged++;continue;
        }
        try{
          await this.write(path.join(this.folder,name),JSON.stringify(pending.value));
          entry.signature=pending.signature;entry.writtenAt=this.now();this.metrics.written++;
          if(this.failures.delete(name))this.reportFailures();
        }catch(error){
          this.metrics.failed++;const code=error.code||'snapshot_write_failed';
          if(this.failures.get(name)!==code){this.failures.set(name,code);this.reportFailures();}
          // Keep the old complete snapshot. Only a new request/heartbeat retries
          // the latest projection; no recursive retry or task command exists.
        }
      }
    }finally{entry.running=false;}
  }
  reportFailures(){try{this.onFailures([...this.failures].map(([file,code])=>({file,code})));}catch{}}
  async idle(){while(this.active.size)await Promise.allSettled([...this.active]);}
  async close(){this.closed=true;await this.idle();}
}
module.exports={writeStatusFiles,writePrivateStatusAtomic,snapshotSignature,StatusFileWriter};
