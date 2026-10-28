'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createResultStore}=require('../result-store.cjs');
const {createResultTransport}=require('../result-transport.cjs');
const {createCallDetailsReader}=require('../mcp-activity-details.cjs');
const CALL='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const PRINCIPAL='Bearer isolated-details-principal';
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-call-details-')),home=path.join(root,'results'),auth=path.join(root,'authorization');
  fs.writeFileSync(auth,PRINCIPAL);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {home,auth,store:createResultStore({home,...options})};
}
const ctx=(part,extra={})=>({principal:PRINCIPAL,callId:CALL,part,tool:'read_files',activityOnly:true,...extra});

test('activity cache is evicted before delivery results and cannot evict protected delivery',async t=>{
  const f=fixture(t,{maxEntries:3});
  const delivery=await f.store.put('original delivery',ctx('response',{activityOnly:false}));
  const args=await f.store.put('{"path":"fixture.md"}',ctx('arguments'));
  const response=await f.store.put('inline reply',ctx('response'));
  await f.store.put('next protected delivery',ctx('response',{activityOnly:false,callId:OTHER}));
  assert.equal(fs.existsSync(path.join(f.home,args.result_id)),false);
  assert.equal(fs.existsSync(path.join(f.home,response.result_id)),true);
  assert.equal(fs.existsSync(path.join(f.home,delivery.result_id)),true);
  const protectedOnly=fixture(t,{maxEntries:1});
  const keep=await protectedOnly.store.put('still required delivery',ctx('response',{activityOnly:false}));
  await assert.rejects(protectedOnly.store.put('optional activity',ctx('arguments')),{code:'RESULT_STORE_FULL'});
  assert.equal(fs.existsSync(path.join(protectedOnly.home,keep.result_id)),true);
});

test('owner detail pages require original call and part and do not acknowledge model delivery',async t=>{
  const f=fixture(t),data='真实回复🟣'.repeat(30),result=await f.store.put(data,ctx('response',{activityOnly:false}));
  const events=[{callId:CALL,event:'mcp_call_details',part:'response',resultId:result.result_id}];
  const reader=createCallDetailsReader({resultHome:f.home,authorizationFile:f.auth,readActivity:async()=>({events})});
  let offset=0,assembled='';
  do{
    const page=await reader({callId:CALL,part:'response',offset,max_bytes:17});
    assert.equal(page.available,true);assert.equal(page.originalExecutionReplayed,false);
    assembled+=page.data;offset=page.next_offset;if(page.eof)break;
  }while(true);
  assert.equal(assembled,data);
  const state=JSON.parse(await fsp.readFile(path.join(f.home,result.result_id,'read.json'),'utf8'));
  assert.equal(state.fully_read,false);assert.deepEqual(state.text,[]);
  await assert.rejects(f.store.read({result_id:result.result_id},PRINCIPAL,{expectedCallId:OTHER,expectedPart:'response'}),{code:'RESULT_NOT_FOUND'});
  assert.equal((await reader({callId:OTHER,part:'response'})).available,false);
  assert.equal((await reader({callId:CALL,part:'arguments'})).reason,'original_call_details_not_recorded');
  fs.writeFileSync(f.auth,'Bearer different-owner');
  assert.equal((await reader({callId:CALL,part:'response'})).available,false);
});

test('activity writes are asynchronous and bounded and storage failure does not alter delivery',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;}),events=[],puts=[];
  const transport=createResultTransport({store:{put:async(raw,context)=>{puts.push(context);await held;throw Error('fixture disk unavailable');}},
    inlineBytes:1024,onEvent:row=>events.push(row),maxObservationBytes:2048,maxObservations:1});
  const context={principal:PRINCIPAL,callId:CALL,part:'arguments',tool:'read_files',method:'tools/call'};
  assert.equal(transport.observe(Buffer.from('{"path":"original"}'),context),undefined);
  transport.observe(Buffer.from('{}'),{...context,callId:OTHER});
  const raw=Buffer.from('actual unchanged outcome');
  const delivered=await transport.protect(raw,{principal:PRINCIPAL});
  assert.deepEqual(delivered.raw,raw);assert.equal(delivered.stored,false);
  assert.ok(events.some(row=>row.callId===OTHER&&row.code==='call_details_observer_busy'));
  release();await transport.flushObserved();
  assert.equal(puts.length,1);assert.ok(events.some(row=>row.callId===CALL&&row.code==='call_details_storage_unavailable'));
});

test('large preserved response reuses the original result reference without another write',async()=>{
  const events=[];let writes=0;
  const descriptor={result_id:'result_'+'a'.repeat(32),complete:true};
  const transport=createResultTransport({store:{put:async()=>{writes++;return descriptor;}},inlineBytes:1024,onEvent:row=>events.push(row)});
  const delivered=await transport.protect(Buffer.alloc(2048,97),{principal:PRINCIPAL,callId:CALL,part:'response',method:'tools/call',tool:'read_files'});
  assert.equal(delivered.stored,true);await transport.flushObserved();assert.equal(writes,1);
  assert.ok(events.some(row=>row.event==='mcp_call_details'&&row.part==='response'&&row.resultId===descriptor.result_id));
});

test('unexpected observer rejection cannot escape or turn an observation into execution failure',async()=>{
  const events=[],transport=createResultTransport({store:{put:()=>Promise.reject()},onEvent:row=>events.push(row)});
  transport.observe(Buffer.from('{}'),{principal:PRINCIPAL,callId:CALL,part:'arguments',tool:'read_files'});
  assert.equal(await transport.flushObserved(),true);
  assert.equal(events[0].code,'call_details_storage_unavailable');
});
