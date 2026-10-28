'use strict';
// All historical filesystem/Session reads happen in this metadata-only worker.
// Its rows are display data. Canonical reads and launch authority never use it.
const fs=require('node:fs'),path=require('node:path'),{parentPort,workerData}=require('node:worker_threads');
const {writePrivateFileAtomic}=require('./upstream/launcher/electron/atomic-file.cjs');
const {createTurnDisplay}=require('./turn-journal.cjs');
const {eventSignature,staleDisplay}=require('./turn-journal-cache.cjs');
const {home,batchSize}=workerData,directory=path.join(home,'turns'),{display}=createTurnDisplay(home,{sessionsRoot:workerData.sessionsRoot});
const cache=new Map(),watchers=new Map(),dirty=new Set();let watchFull=false,notification=null,busy=false,persistenceFault=null;
for(const row of workerData.initialRows||[])cache.set(row.traceId,{row,signature:eventSignature(row)});
const fileName=name=>typeof name==='string'&&/^[A-Za-z0-9_-]+\.json$/.test(name);
const statKey=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
function revision(file){try{const stat=fs.statSync(file);return stat.isFile()?statKey(stat):null;}
  catch(error){if(error.code==='ENOENT')return null;throw error;}}
function notify(){if(notification)return;notification=setTimeout(()=>{
  notification=null;parentPort.postMessage({type:'dirty',traces:[...dirty],full:watchFull});dirty.clear();watchFull=false;
},50);notification.unref?.();}
function watch(folder,kind){if(watchers.has(folder)||!fs.existsSync(folder))return;
  try{const watcher=fs.watch(folder,kind==='diagnostics'?{recursive:true}:{},(_event,name)=>{
    name=String(name||'');const base=path.basename(name);
    if(kind==='home'){
      if(!name||['turns','turn-sources','turn-reviews','runtime','diagnostics'].includes(base))watchFull=true;
      else return;
    }else if(kind==='runtime'){
      if(!name||base==='thread-environments.json'||base==='native-final-replay')watchFull=true;else return;
    }
    else if(fileName(base))dirty.add(base.slice(0,-5));
    else if(kind==='diagnostics'){const trace=name.split(/[\\/]/)[0].split('-')[0];if(/^[a-f0-9]{12}$/.test(trace))dirty.add(trace);}
    else watchFull=true;
    notify();
  });watcher.on('error',()=>{watchers.delete(folder);watcher.close();watchFull=true;notify();});watchers.set(folder,watcher);
  }catch{/* The periodic full pass remains the bounded fallback. */}}
function installWatches(){watch(home,'home');watch(directory,'turns');watch(path.join(home,'turn-sources'),'sources');
  watch(path.join(home,'turn-reviews'),'reviews');watch(path.join(home,'runtime'),'runtime');
  watch(path.join(home,'runtime','native-final-replay'),'final');watch(path.join(home,'diagnostics/browser-turns'),'diagnostics');}
function readRecord(traceId){const file=path.join(directory,traceId+'.json'),before=revision(file);
  if(!before)throw Error('turn_record_unavailable');const stat=fs.statSync(file);
  if(stat.size>1024*1024)throw Error('turn_record_size_invalid');
  const record=JSON.parse(fs.readFileSync(file,'utf8'));
  if(record.traceId!==traceId||revision(file)!==before)throw Error('turn_record_changed');return {record,before};}
function dependencies(traceId,environment){return [revision(path.join(home,'turn-sources',traceId+'.json')),
  revision(path.join(home,'turn-reviews',traceId+'.json')),revision(path.join(home,'runtime','native-final-replay',traceId+'.json')),environment].join('|');}
function isBadMetadata(previous,row,traceId){
  const sourceChanged=row.source&&previous?.row?.source&&
    (row.source.threadId!==previous.row.source.threadId||row.source.turnId!==previous.row.source.turnId);
  return previous?.row?.source&&!row.source&&revision(path.join(home,'turn-sources',traceId+'.json'))||
    !sourceChanged&&previous?.row?.review&&!row.review&&revision(path.join(home,'turn-reviews',traceId+'.json'));
}
async function refresh(message){
  if(busy)return;busy=true;let unavailable=false,errorCode=null,changed=false;
  try{
    installWatches();const names=fs.readdirSync(directory).filter(fileName),known=new Set(names.map(name=>name.slice(0,-5)));
    const environment=revision(path.join(home,'runtime','thread-environments.json'));
    const priority=new Set(message.priority||[]),queue=[...priority].filter(id=>known.has(id));
    if(message.full){for(const traceId of known)if(!priority.has(traceId))queue.push(traceId);}
    else{for(const traceId of known)if(!cache.has(traceId)&&!priority.has(traceId))queue.push(traceId);}
    const removed=[];
    for(const traceId of cache.keys())if(!known.has(traceId)){cache.delete(traceId);removed.push({traceId,version:message.versions[traceId]||0});changed=true;}
    if(removed.length)parentPort.postMessage({type:'batch',request:message.request,rows:[],removed});
    for(let offset=0;offset<queue.length;offset+=batchSize){const entries=[];
      for(const traceId of queue.slice(offset,offset+batchSize)){
        const previous=cache.get(traceId);let row;
        try{
          const {record,before}=readRecord(traceId),dependency=dependencies(traceId,environment);
          // Ordinary polls refresh the live/recent window. Other historical
          // rows are recomputed only on changed dependencies or the full pass.
          const force=priority.has(traceId)||message.full;
          if(!force&&previous?.revision===before&&previous.dependency===dependency)continue;
          row=display(record);
          if(revision(path.join(directory,traceId+'.json'))!==before||
            dependencies(traceId,revision(path.join(home,'runtime','thread-environments.json')))!==dependency)
            throw Error('turn_display_metadata_changed');
          if(isBadMetadata(previous,row,traceId))throw Error('turn_display_metadata_unavailable');
          const entry={row,signature:eventSignature(record),revision:before,dependency};
          const same=JSON.stringify(previous?.row)===JSON.stringify(row);
          cache.set(traceId,entry);if(same)continue;changed=true;
        }catch(error){unavailable=true;errorCode=error.code||'turn_display_metadata_unavailable';
          if(!previous)continue;row=staleDisplay(previous.row,errorCode);cache.set(traceId,{...previous,row});changed=true;
        }
        entries.push({traceId,row,version:message.versions[traceId]||0});
      }
      if(entries.length)parentPort.postMessage({type:'batch',request:message.request,rows:entries});
      await new Promise(resolve=>setImmediate(resolve));
    }
    if(changed||persistenceFault)try{writePrivateFileAtomic(path.join(home,'turn-display-index.json'),JSON.stringify({version:1,rows:[...cache.values()].map(entry=>({row:entry.row,signature:entry.signature}))})+'\n');persistenceFault=null;}
      catch(error){unavailable=true;persistenceFault=error.code||'turn_display_index_write_failed';errorCode=persistenceFault;}
  }catch(error){unavailable=true;errorCode=error.code||'turn_display_index_read_failed';
    const entries=[...cache].map(([traceId,entry])=>({traceId,row:staleDisplay(entry.row,errorCode),version:message.versions[traceId]||0}));
    for(let offset=0;offset<entries.length;offset+=batchSize)parentPort.postMessage({type:'batch',request:message.request,rows:entries.slice(offset,offset+batchSize)});
  }finally{busy=false;parentPort.postMessage({type:'done',request:message.request,status:{stale:unavailable,unavailable,errorCode}});}
}
parentPort.on('message',message=>{if(message.type==='refresh')void refresh(message);});
