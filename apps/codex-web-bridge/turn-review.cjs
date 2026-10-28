'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readSource}=require('./turn-source.cjs');
const {writePrivateFileAtomic}=require('./upstream/launcher/electron/atomic-file.cjs');
const rules=require('./reported-blockers.json');
const displayCache=new Map(),metadataCache=new Map(),sourceCache=new Map();
const MAX_DISPLAY_BYTES=16*1024*1024,MAX_DISPLAY_ENTRIES=100;
let displayBytes=0;
function removeDisplay(file){const entry=displayCache.get(file);if(entry){displayBytes-=entry.bytes;displayCache.delete(file);}}
function cacheDisplay(file,key,text){
  // Account for the encoded bytes plus the JS string's conservative UTF-16
  // storage. The cache retains neither replay events nor their JSON source.
  const bytes=Buffer.byteLength(text,'utf8')+text.length*2;
  removeDisplay(file);
  if(bytes>MAX_DISPLAY_BYTES)return;
  while(displayCache.size>=MAX_DISPLAY_ENTRIES||displayBytes+bytes>MAX_DISPLAY_BYTES)removeDisplay(displayCache.keys().next().value);
  displayCache.set(file,{key,text,bytes});displayBytes+=bytes;
}
function finalDisplayCacheStats(){return {entries:displayCache.size,bytes:displayBytes,maxBytes:MAX_DISPLAY_BYTES,maxEntries:MAX_DISPLAY_ENTRIES};}
const statKey=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
function sourceForReview(home,traceId){
  if(!/^[a-f0-9]{12}$/.test(traceId||''))return null;
  const file=path.join(home,'turn-sources',traceId+'.json');
  try{
    const key=statKey(fs.statSync(file)),cached=sourceCache.get(file);
    if(cached?.key===key)return cached.row;
    const row=readSource(home,traceId);
    if(statKey(fs.statSync(file))!==key)return null;
    if(sourceCache.size>=2048)sourceCache.delete(sourceCache.keys().next().value);
    sourceCache.set(file,{key,row});return row;
  }catch{sourceCache.delete(file);return null;}
}
function finalForDisplay(home,row){
  // Display only the final already saved by the original adapter. No context
  // reconstruction, browser send, identity renewal, or execution authority.
  const file=path.join(home,'runtime','native-final-replay',row.traceId+'.json');
  try{
    const stat=fs.statSync(file);if(!stat.isFile()||stat.size>8*1024*1024){removeDisplay(file);return null;}
    const key=[statKey(stat),row.traceId,row.threadId,row.turnId,row.finalSha256].join(':');
    const cached=displayCache.get(file);
    if(cached?.key===key){displayCache.delete(file);displayCache.set(file,cached);return cached.text;}
    removeDisplay(file);
    const replay=JSON.parse(fs.readFileSync(file,'utf8'));
    if(statKey(fs.statSync(file))!==statKey(stat))return null;
    if(replay.traceId!==row.traceId||replay.threadId!==row.threadId||replay.turnId!==row.turnId||!Array.isArray(replay.events))return null;
    const end=replay.events.at(-1);if(end?.type!=='done'||end.endTurn!==true||end.stopReason!=='stop')return null;
    let text='';for(const event of replay.events){
      if(event.type==='assistant_boundary')text='';
      if(event.type==='text_delta'&&event.phase==='final_answer'&&typeof event.text==='string')text+=event.text;
      if(text.length>4*1024*1024)return null;
    }
    if(!text||crypto.createHash('sha256').update(text.trim()).digest('hex')!==row.finalSha256)return null;
    cacheDisplay(file,key,text);return text;
  }catch{removeDisplay(file);return null;}
}
function classify(text){
  const searchable=String(text).replaceAll('\\_','_');
  return rules.filter(rule=>new RegExp(rule.pattern,'i').test(searchable)).map(({code,label,note})=>({code,label,note,source:'assistant_final',evidence:'reported_not_independently_verified',automaticRetry:false}));
}
function saveReview(home,traceId,text,{sourceFile,sourceSha256,nativeProof}={}){
  const source=readSource(home,traceId);if(!source||typeof text!=='string'||text.length>4*1024*1024)return false;
  if(nativeProof&&(nativeProof.version!==1||nativeProof.threadId!==source.threadId||nativeProof.turnId!==source.turnId||
    nativeProof.terminal!=='task_complete_with_matching_final'||!/^[a-f0-9]{64}$/.test(nativeProof.eventSha256)))return false;
  const row={traceId,threadId:source.threadId,turnId:source.turnId,finalSha256:crypto.createHash('sha256').update(text.trim()).digest('hex'),
    reportedBlockers:classify(text),taskAcceptance:'unverified',
    observedAt:new Date().toISOString(),...(sourceFile?{sourceFile,sourceSha256}:{}),...(nativeProof?{nativeProof}:{})};
  const dir=path.join(home,'turn-reviews');fs.mkdirSync(dir,{recursive:true});
  writePrivateFileAtomic(path.join(dir,traceId+'.json'),JSON.stringify(row)+'\n');return true;
}
function readReview(home,traceId,{includeText=true}={}){
  const source=sourceForReview(home,traceId);if(!source)return null;
  try{
    const file=path.join(home,'turn-reviews',traceId+'.json'),stat=fs.statSync(file);if(stat.size>16384)return null;
    const key=[statKey(stat),source.traceId,source.threadId,source.turnId].join(':');
    let row=metadataCache.get(file)?.key===key?metadataCache.get(file).row:null;
    if(!row){
      row=JSON.parse(fs.readFileSync(file,'utf8'));
      if(statKey(fs.statSync(file))!==statKey(stat))return null;
      if(metadataCache.size>=2048)metadataCache.delete(metadataCache.keys().next().value);
      metadataCache.set(file,{key,row});
    }
    if(row.traceId!==traceId||row.threadId!==source.threadId||row.turnId!==source.turnId)return null;
    // Render fixed local wording only; persisted data cannot inject UI copy.
    const {finalText:ignored,...storedMetadata}=row;
    const metadata=includeText?storedMetadata:Object.fromEntries(['traceId','threadId','turnId','finalSha256','taskAcceptance','observedAt','sourceFile','sourceSha256','nativeProof']
      .filter(key=>Object.hasOwn(storedMetadata,key)).map(key=>[key,storedMetadata[key]]));
    return {...metadata,...(includeText?{finalText:finalForDisplay(home,row)}:{}),reportedBlockers:rules.filter(rule=>row.reportedBlockers?.some(b=>b.code===rule.code)).map(rule=>({...rule,pattern:undefined,source:'assistant_final',evidence:'reported_not_independently_verified',automaticRetry:false}))};
  }catch{return null;}
}
module.exports={classify,saveReview,readReview,finalDisplayCacheStats};
