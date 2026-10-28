'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Worker}=require('node:worker_threads');
const {cleanSource}=require('./turn-source.cjs');
const blockerRules=require('./reported-blockers.json');
const FIELDS=['traceId','tabId','startedAt','endedAt','interruptedAt','status','account','url','submission','publicState','observationUnavailable','reason','automaticReplay'];
const select=(value,fields)=>value&&typeof value==='object'?Object.fromEntries(fields.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]])):null;
function eventMetadata(row){const metadata=select(row,FIELDS)||{};
  if(metadata.publicState){metadata.publicState=select(metadata.publicState,['loginRequired','usageLimited','userTurns','assistantTurns','alerts']);
    if(Array.isArray(metadata.publicState.alerts))metadata.publicState.alerts=metadata.publicState.alerts.filter(text=>typeof text==='string').slice(-5).map(text=>text.slice(0,500));
  }return metadata;
}
const eventSignature=row=>JSON.stringify(eventMetadata(row));
const order=(a,b)=>String(b.startedAt||'').localeCompare(String(a.startedAt||''))||String(b.traceId).localeCompare(String(a.traceId));
function staleDisplay(row,code){return {...row,last_observed_status:row.last_observed_status||row.status,
  status:'needs_reconciliation',nativeState:{state:'unavailable'},display_read:{stale:true,unavailable:true,code}};}
function cleanCachedDisplay(value){
  if(!value||typeof value.traceId!=='string')return null;
  const row={...eventMetadata(value),...select(value,['browserStatus','bodyAvailable','bodyRevision','last_observed_status'])};
  row.source=cleanSource(value.source);
  row.nativeState=select(value.nativeState,['state','threadId','turnId','endedAt','source','reason'])||{state:'unavailable'};
  row.failure=select(value.failure,['kind','source','submissionObserved','beforeSend']);
  row.review=select(value.review,['traceId','threadId','turnId','finalSha256','taskAcceptance','observedAt','sourceFile','sourceSha256','nativeProof']);
  if(row.review){row.review.nativeProof=select(row.review.nativeProof,['version','threadId','turnId','terminal','eventSha256']);
    row.review.reportedBlockers=blockerRules.filter(rule=>value.review.reportedBlockers?.some(blocker=>blocker.code===rule.code))
      .map(({pattern,...rule})=>({...rule,source:'assistant_final',evidence:'reported_not_independently_verified',automaticRetry:false}));}
  row.display_read=select(value.display_read,['stale','loading','unavailable','code']);return row;
}

function createTurnDisplayIndex(home,records,{pollMs=2500,fullScanMs=30000,batchSize=64,sessionsRoot,
  workerFactory=(file,options)=>new Worker(file,options),now=Date.now}={}){
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>256||pollMs<100||fullScanMs<pollMs)
    throw Error('turn_display_index_bounds');
  const rows=new Map(),versions=new Map(),dirty=new Set(),metrics={snapshotReads:0,refreshes:0,applied:0,rejectedLate:0,workerRestarts:0};
  let list=[],status={source:'turn_journal_display_index',loading:true,stale:true,unavailable:false,
    lastRefreshAtMs:null,errorCode:null},worker=null,generation=0,inflight=null,queued=null,closed=false,
    lastFull=-Infinity,timer=null,failures=0,nextRestart=0,workerStartedAt=0;
  let saved;
  try{const file=path.join(home,'turn-display-index.json');if(fs.statSync(file).size<=32*1024*1024){
    const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.version===1&&Array.isArray(value.rows))saved=new Map(value.rows.map(entry=>{
      const row=cleanCachedDisplay(entry.row);return [row?.traceId,{row,signature:entry.signature}];}));
  }}catch{}
  for(const [traceId,record]of records){const cached=saved?.get(traceId);
    rows.set(traceId,cached?.row&&cached.signature===eventSignature(record)?
      {...cached.row,display_read:{stale:true,loading:true}}:
      {...eventMetadata(record),browserStatus:record.status,nativeState:{state:'unavailable'},source:null,review:null,
        bodyAvailable:false,bodyRevision:null,display_read:{stale:true,loading:true}});
  }
  function rebuild(){list=[...rows.values()].sort(order);}
  rebuild();
  function fault(code){status={...status,loading:false,stale:true,unavailable:true,errorCode:code};
    for(const [traceId,row]of rows)rows.set(traceId,staleDisplay(row,code));rebuild();}
  function settle(value){const pending=inflight;inflight=null;worker?.unref?.();pending?.resolve(value);}
  function failed(instance,code){if(instance!==worker||closed)return;worker=null;generation++;
    failures++;nextRestart=now()+[1000,4000,15000][Math.min(failures-1,2)];fault(code);settle(false);
    void instance.terminate().catch(()=>{});
  }
  function start(){
    if(worker||closed||failures>=3||now()<nextRestart)return !!worker;
    const epoch=++generation;
    try{const instance=workerFactory(path.join(__dirname,'turn-journal-cache-worker.cjs'),
      {workerData:{home,batchSize,initialRows:list,...(sessionsRoot?{sessionsRoot}:{})},execArgv:[]});worker=instance;workerStartedAt=now();
      instance.on('message',message=>{
        if(worker!==instance||generation!==epoch||closed)return;
        if(message.type==='dirty'){
          if(message.full)queued={...(queued||{}),full:true};
          for(const traceId of message.traces||[])dirty.add(traceId);
          requestSoon();return;
        }
        if(!inflight||message.request!==inflight.request)return;
        if(message.type==='batch'){
          for(const entry of message.rows||[]){
            if((versions.get(entry.traceId)||0)!==(entry.version||0)){metrics.rejectedLate++;continue;}
            rows.set(entry.traceId,entry.row);metrics.applied++;
          }
          for(const entry of message.removed||[])if((versions.get(entry.traceId)||0)===(entry.version||0))rows.delete(entry.traceId);
          rebuild();return;
        }
        if(message.type==='done'){
          metrics.refreshes++;status={...status,...message.status,loading:false,
            lastRefreshAtMs:now()};if(!status.unavailable&&now()-workerStartedAt>=30000)failures=0;
          settle(!status.unavailable);if(queued||dirty.size)requestSoon();
        }
      });
      instance.on('error',()=>failed(instance,'turn_display_worker_failed'));
      instance.on('exit',code=>{if(!closed&&worker===instance)failed(instance,code===0?'turn_display_worker_closed':'turn_display_worker_failed');});
      instance.unref?.();metrics.workerRestarts++;return true;
    }catch{fault('turn_display_worker_unavailable');failures++;nextRestart=now()+1000;return false;}
  }
  let scheduled=false;
  function requestSoon(){if(closed||scheduled)return;scheduled=true;setImmediate(()=>{scheduled=false;if(!closed)void refresh();});}
  let sequence=0;
  function refresh({full=false}={}){
    if(closed)return Promise.resolve(false);
    if(inflight){if(full)queued={...(queued||{}),full:true};return inflight.promise;}
    full=full||queued?.full||now()-lastFull>=fullScanMs;queued=null;
    if(!start())return Promise.resolve(false);
    const priority=new Set(dirty);dirty.clear();
    for(const [index,row]of list.entries())if(index<20||['running','needs_reconciliation'].includes(row.status))priority.add(row.traceId);
    const request=++sequence;let resolve;const promise=new Promise(done=>resolve=done);
    inflight={request,promise,resolve};if(full)lastFull=now();
    try{worker.ref?.();worker.postMessage({type:'refresh',request,full,priority:[...priority],versions:Object.fromEntries(versions)});}
    catch{failed(worker,'turn_display_worker_unavailable');}
    return promise;
  }
  function upsert(record){
    if(closed)return;const traceId=record.traceId,previous=rows.get(traceId);
    versions.set(traceId,(versions.get(traceId)||0)+1);dirty.add(traceId);
    rows.set(traceId,{...previous,...eventMetadata(record),browserStatus:record.status,
      nativeState:{state:'unavailable'},display_read:{stale:true,loading:true}});
    status={...status,stale:true};rebuild();requestSoon();
  }
  function snapshot(){metrics.snapshotReads++;return {rows:list,status:{...status,loadedRows:list.length},metrics:{...metrics}};}
  async function close(){if(closed)return;closed=true;clearInterval(timer);settle(false);
    const instance=worker;worker=null;generation++;if(instance)await instance.terminate();}
  timer=setInterval(()=>{void refresh();},pollMs);timer.unref?.();requestSoon();
  return {snapshot,upsert,refresh,close};
}
module.exports={createTurnDisplayIndex,eventMetadata,eventSignature,staleDisplay,cleanCachedDisplay};
