'use strict';
// An isolated, reproducible load fixture. These timings are not production or
// service guarantees. No live project, browser profile, ledger or model is read.
const {performance}=require('node:perf_hooks');
const {projectWorkspaceState,StatePublisher}=require('../state-pipeline.cjs');
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
const encode=value=>{const at=performance.now(),text=JSON.stringify(value);return {ms:performance.now()-at,bytes:Buffer.byteLength(text)};};
const work='w'.repeat(24000);
const state={connected:true,selected:'page-0',pages:Array.from({length:120},(_,n)=>({id:'page-'+n,title:'Task '+n,account:n%2?'A':'B',
  parent:n?'original-controller':null,bound:true,paused:false,firstTurnDraft:work,first_turn_instructions:work,
  latest_request:{id:'accepted-'+n,phase:'processing',attempt_id:'control-'+n},observation:{at:1,generating:true,attemptId:'control-'+n}})),
  view:{page_id:'page-0',thread_id:'original-thread',events:[{seq:1,body_loaded:false,body_revision:'original-body',data:{text:'preview'}}],record_history:{total:2201}},
  codexWeb:{recent:[]},recordHistory:{web:true,codex:true}};
const before=[],after=[];
for(let n=0;n<7;n++){
  before.push(encode(state));const start=performance.now(),projection=projectWorkspaceState(state),encoded=encode(projection);
  after.push({...encoded,ms:performance.now()-start});
}
const raw={...state,pages:state.pages.map(page=>({...page,observation:{...page.observation,html:'h'.repeat(200000),publicText:'p'.repeat(100000)}}))};
const rawBytes=encode(raw).bytes,projectedRawBytes=encode(projectWorkspaceState(raw)).bytes;
let now=0,current=projectWorkspaceState(state);current.codexWeb.recent=Array.from({length:3000},(_,n)=>({traceId:'trace-'+n,status:'completed',startedAt:'2026-10-04T12:00:00Z',
  source:{threadId:'thread-'+n,turnId:'turn-'+n,workingDirectory:'D:/fixture/'+n,model:'original-native'},bodyRevision:'saved-'+n,review:{finalSha256:'a'.repeat(64)}}));
const packets=[],jobs=[];
const publisher=new StatePublisher({collect:()=>current,send:packet=>packets.push(packet),now:()=>now,
  schedule:callback=>{jobs.push(callback);return jobs.length;},cancel:()=>{}});
for(let n=0;n<1000;n++)publisher.request();jobs.shift()();
current={...current,pages:current.pages.map((page,n)=>n? page:{...page,paused:true,pause_origin:{source:'operator'}})};now=1;publisher.flush();
const firstBytes=encode(packets[0]).bytes,patchBytes=encode(packets[1]).bytes;
const result={fixture:true,liveInstancesTouched:false,packages:120,packageCharacters:24000,nativeCatalogRows:3000,
  workPackageProjection:{beforeBytes:before[0].bytes,afterBytes:after[0].bytes,reductionPercent:100*(1-after[0].bytes/before[0].bytes),
    beforeSerializeMedianMs:median(before.map(row=>row.ms)),projectAndSerializeMedianMs:median(after.map(row=>row.ms))},
  rawObservationProjection:{beforeBytes:rawBytes,afterBytes:projectedRawBytes,reductionPercent:100*(1-projectedRawBytes/rawBytes)},
  unchangedCatalogPatch:{fullBytes:firstBytes,changedPagesPatchBytes:patchBytes,reductionPercent:100*(1-patchBytes/firstBytes)},
  sameTurnBurst:{requests:1000,collectionsAfterBurst:1,publishedAfterBurst:1},metrics:publisher.metrics};
publisher.close();process.stdout.write(JSON.stringify(result,null,2)+'\n');
