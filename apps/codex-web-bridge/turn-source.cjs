'use strict';
const fs=require('node:fs'),path=require('node:path');
const {writePrivateFileAtomic}=require('./upstream/launcher/electron/atomic-file.cjs');
const {WEB_MODELS}=require('./bridge-config.cjs');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const trace=value=>typeof value==='string'&&/^[a-f0-9]{12}$/.test(value);
const environmentCache=new Map();
const statKey=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
function displayEnvironment(file){
  try{
    const stat=fs.statSync(file);
    if(!stat.isFile()||stat.size>4*1024*1024){environmentCache.delete(file);return null;}
    const key=statKey(stat),cached=environmentCache.get(file);
    if(cached?.key===key)return cached.threads;
    let threads=null;
    try{
      const state=JSON.parse(fs.readFileSync(file,'utf8'));
      if(statKey(fs.statSync(file))!==key)return null;
      if(state.version===1&&state.threads&&typeof state.threads==='object'&&!Array.isArray(state.threads)){
        threads=new Map();
        for(const [id,value] of Object.entries(state.threads))if(uuid(id)&&typeof value?.cwd==='string'&&path.isAbsolute(value.cwd))threads.set(id,value.cwd);
      }
    }catch{}
    if(environmentCache.size>=16)environmentCache.delete(environmentCache.keys().next().value);
    environmentCache.set(file,{key,threads});return threads;
  }catch{environmentCache.delete(file);return null;}
}
function cleanSource(value){
  if(!value||!trace(value.traceId)||!uuid(value.threadId)||!uuid(value.turnId)||!WEB_MODELS.has(value.model))return null;
  return {traceId:value.traceId,threadId:value.threadId,turnId:value.turnId,model:value.model,
    ...(['A','B'].includes(value.account)?{account:value.account}:{}),
    ...(typeof value.workingDirectory==='string'&&path.isAbsolute(value.workingDirectory)?{workingDirectory:value.workingDirectory}:{}),
    ...(['response','compaction'].includes(value.purpose)?{purpose:value.purpose}:{}),
    provenance:'native_request_metadata'};
}
function readSource(home,traceId){
  if(!trace(traceId))return null;
  const file=path.join(home,'turn-sources',traceId+'.json');
  try{if(fs.statSync(file).size>16384)return null;const value=cleanSource(JSON.parse(fs.readFileSync(file,'utf8')));return value?.traceId===traceId?value:null;}catch{return null;}
}
function saveSource(home,value){
  const row=cleanSource(value);if(!row)return false;
  const file=path.join(home,'turn-sources',row.traceId+'.json');
  const previous=readSource(home,row.traceId);
  // An unreadable existing binding is not an empty slot. Do not replace it
  // with a later observation whose ownership cannot be reconciled.
  if(!previous&&fs.existsSync(file))return false;
  // A later metadata observation is not authority, and must never reassign a trace
  // or its original working directory used by the resume control.
  if(previous&&(previous.threadId!==row.threadId||previous.turnId!==row.turnId||previous.model!==row.model||(previous.account||'B')!==(row.account||'B')
    ||(previous.purpose&&row.purpose&&previous.purpose!==row.purpose)))return false;
  if(previous?.workingDirectory&&(!row.purpose||previous.purpose))return true;
  if(previous&&!row.workingDirectory&&(!row.purpose||previous.purpose))return true;
  const directory=path.join(home,'turn-sources');fs.mkdirSync(directory,{recursive:true});
  writePrivateFileAtomic(file,JSON.stringify({...previous,...row})+'\n');return true;
}
function sourceForDisplay(home,traceId){
  const row=readSource(home,traceId);if(!row||row.workingDirectory)return row;
  // Follow-up Responses requests can omit the environment envelope. Read the
  // upstream store for display only; never modify its execution authority.
  try{
    const file=path.join(home,'runtime','thread-environments.json');
    const cwd=displayEnvironment(file)?.get(row.threadId);
    if(typeof cwd==='string'&&path.isAbsolute(cwd))return {...row,workingDirectory:cwd};
  }catch{}
  return row;
}
module.exports={uuid,cleanSource,saveSource,readSource,sourceForDisplay};
