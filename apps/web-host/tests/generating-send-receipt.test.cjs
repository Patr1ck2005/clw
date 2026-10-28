'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),{createHash}=require('node:crypto');
const {WebDriver}=require('../web-driver.cjs');
const hash=s=>createHash('sha256').update(s).digest('hex');
const attempt='control_'+'a'.repeat(32),other='control_'+'b'.repeat(32),url='https://chatgpt.com/c/original';
function fixture(t,{paused=false,mode='managed',hooks={},receiptState='original_attempt_requires_reconciliation'}={}){
  const record={page_id:'original-page',thread_id:'original-thread',account:'A',phase:'bound',url,paused,
    model:'GPT-6 · 最新',effort:'高',conversation_mode:mode,latest_request:{id:'original-request',phase:'queued',attempt_id:attempt,cancel_requested:0,sent_user_hash:null}};
  const snapshot={url,editor:true,controlKnown:true,historyAtLatest:true,generating:true,rawStopPresent:true,
    draft:false,composing:false,stopped:false,blocked:false,approvalRequired:false,loginRequired:false,accessLimited:false,
    userId:'original-sent-user',assistantId:'thinking-assistant',attemptMarker:`[CLW:${attempt}]`,attemptMarkerCount:1,
    complete:false,failure:''};
  const page={id:record.page_id,account:'A',documentGeneration:1,domReady:true,view:{webContents:{getURL:()=>snapshot.url,isDestroyed:()=>false}}};
  const calls=[],runtime=new EventEmitter();runtime.ready=true;runtime.child={pid:1};let acknowledged=false;
  const prepared={attempt_id:attempt,previous_user_hash:hash('previous-user'),assistant_before_hash:hash('previous-assistant'),prompt_hash:hash('original-prompt')};
  let driver;
  runtime.call=async(op,payload)=>{
    calls.push({op,payload});hooks[op]?.({record,page,snapshot,driver,prepared});
    if(op==='bind-direct')return {state:'bound',url:payload.url};
    if(op==='pending-receipt')return {state:acknowledged?'browser_result_pending':receiptState,attempt_id:attempt,
      ...(receiptState==='model_received_browser_confirmation_pending'?{assistant_before_hash:prepared.assistant_before_hash}:{})};
    if(op==='prepared')return {...prepared};
    assert.equal(op,'wire');assert.equal(payload.data.action,'sent','no pulse, offer, dispatch or result is allowed during long generation');
    assert.equal(payload.data.attempt_id,attempt);acknowledged=true;
    if(hooks.lostReply)throw Error('runtime_receipt_unknown_reconcile_original');
    record.latest_request.phase='processing';record.latest_request.sent_user_hash=hash(snapshot.userId);
    return {state:'browser_result_pending',attempt_id:attempt,sent_user_hash:record.latest_request.sent_user_hash};
  };
  driver=new WebDriver({runtime,pool:{pages:new Map([[page.id,page]]),running(){}},onNotice(){},
    dom:async(_wc,action)=>{assert.equal(action,'snapshot','receipt collection does not inspect menus or touch input');return snapshot;}});
  driver.records.set(page.id,record);t.after(()=>driver.dispose());return {driver,runtime,record,page,snapshot,prepared,calls};
}

test('a long generating original turn is acknowledged once without Send, offer, next round or completion',async t=>{
  const f=fixture(t);await f.driver.tick(f.record);await f.driver.tick(f.record);
  assert.deepEqual(f.calls.map(c=>c.op),['pending-receipt','prepared','wire']);
  assert.equal(f.calls.at(-1).payload.data.page.generating,true);assert.equal(f.record.latest_request.id,'original-request');
  assert.equal(f.record.latest_request.phase,'processing');assert.equal(f.snapshot.complete,false);assert.equal(f.snapshot.generating,true);
  assert.equal(f.driver.completed.size,0);assert.equal(f.driver.resultCandidates.size,0);
});

test('a lost original ACK reply only rechecks its receipt on the next observation',async t=>{
  const f=fixture(t,{hooks:{lostReply:true}});await assert.rejects(f.driver.tick(f.record),/runtime_receipt_unknown/);
  await f.driver.tick(f.record);assert.deepEqual(f.calls.map(c=>c.op),['pending-receipt','prepared','wire','pending-receipt']);
  assert.equal(f.calls.filter(c=>c.op==='wire').length,1);assert.equal(f.snapshot.generating,true);assert.equal(f.record.latest_request.id,'original-request');
});

test('pausing future dispatch still collects the original generating receipt without resuming it',async t=>{
  const f=fixture(t,{paused:true});await f.driver.tick(f.record);assert.equal(f.record.paused,true);
  assert.deepEqual(f.calls.map(c=>c.op),['pending-receipt','prepared','wire']);
});

test('the exact direct carrier binds once then acknowledges the same original request while generating',async t=>{
  const f=fixture(t,{mode:'direct'});f.record.url='https://chatgpt.com/';
  await f.driver.tick(f.record);assert.deepEqual(f.calls.map(c=>c.op),['bind-direct','pending-receipt','prepared','wire']);
  assert.equal(f.driver.records.get(f.page.id).url,url);assert.equal(f.driver.records.get(f.page.id).latest_request.id,'original-request');
});

test('a tool-received turn confirms its matching browser baseline while still generating',async t=>{
  const f=fixture(t,{receiptState:'model_received_browser_confirmation_pending'});f.record.latest_request.phase='processing';
  await f.driver.tick(f.record);assert.deepEqual(f.calls.map(c=>c.op),['pending-receipt','prepared','wire']);
});

for(const change of ['foreign-marker','duplicate-marker','no-user','draft','composing','cancelled'])
  test('no ACK or Host admission for '+change,async t=>{
    const f=fixture(t);
    if(change==='foreign-marker')f.snapshot.attemptMarker=`[CLW:${other}]`;
    if(change==='duplicate-marker')f.snapshot.attemptMarkerCount=2;
    if(change==='no-user')f.snapshot.userId='';
    if(change==='draft')f.snapshot.draft=true;
    if(change==='composing')f.snapshot.composing=true;
    if(change==='cancelled')f.record.latest_request.cancel_requested=1;
    await f.driver.tick(f.record);assert.deepEqual(f.calls,[]);
  });

for(const stage of ['pending-receipt','prepared'])for(const change of ['request','attempt','account','document','connection','owner'])
  test(stage+' identity change in '+change+' prevents the original ACK',async t=>{
    const f=fixture(t,{hooks:{[stage]:({record,page,driver})=>{
      if(change==='request')record.latest_request.id='replacement-request';
      if(change==='attempt')record.latest_request.attempt_id=other;
      if(change==='account')page.account='B';
      if(change==='document')page.documentGeneration++;
      if(change==='connection')driver.connectionGeneration++;
      if(change==='owner')driver.runtime.child={pid:2};
    }}});
    await f.driver.tick(f.record);assert.equal(f.calls.some(c=>c.op==='wire'),false);assert.equal(f.snapshot.generating,true);
  });

for(const change of ['attempt','previous-user','assistant','prompt','local-pending'])
  test('a mismatched prepared '+change+' retains the original receipt without ACK or Send',async t=>{
    const f=fixture(t);
    if(change==='attempt')f.prepared.attempt_id=other;
    if(change==='previous-user')f.prepared.previous_user_hash=hash(f.snapshot.userId);
    if(change==='assistant')f.prepared.assistant_before_hash='not-a-digest';
    if(change==='prompt')f.prepared.prompt_hash='not-a-digest';
    if(change==='local-pending')f.driver.pending.set(f.page.id,{attempt,assistantBefore:hash('foreign-assistant')});
    await f.driver.tick(f.record);assert.deepEqual(f.calls.map(c=>c.op),['pending-receipt','prepared']);
    assert.equal(f.record.latest_request.phase,'queued');assert.equal(f.snapshot.generating,true);
  });
