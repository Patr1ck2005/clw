'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const captureName=/^capture-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/i;
// Shell snapshots are a recent-view cache. Callers copy a returned file into
// their evidence directory when they want to keep it beyond this cache.
function createCaptureStore(directory,{limit=32,io=fs}={}){
  if(!Number.isSafeInteger(limit)||limit<1)throw Error('capture_retention_invalid');
  let tail=Promise.resolve();
  function capture(bytes){
    const operation=tail.then(async()=>{
      const file=path.join(directory,'capture-'+randomUUID()+'.png');
      await io.writeFile(file,bytes,{flag:'wx',mode:0o600});
      let cleanupPending=false;
      try{
        const files=await Promise.all((await io.readdir(directory)).filter(name=>captureName.test(name)).map(async name=>{
          const target=path.join(directory,name),stat=await io.lstat(target);
          return stat.isFile()&&!stat.isSymbolicLink()?{target,time:stat.mtimeMs}:null;
        }));
        const ordered=files.filter(Boolean).filter(entry=>entry.target!==file).sort((a,b)=>b.time-a.time||a.target.localeCompare(b.target));
        for(const old of ordered.slice(limit-1)){
          try{await io.unlink(old.target);}catch(error){if(error.code!=='ENOENT')cleanupPending=true;}
        }
      }catch{cleanupPending=true;}
      return {path:file,capture_retention:limit,cleanup_pending:cleanupPending};
    });
    tail=operation.catch(()=>{});return operation;
  }
  return {capture};
}
module.exports={createCaptureStore};
