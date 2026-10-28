'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {WebDriver}=require('../web-driver.cjs');
function fixture(){
  const calls=[],runtime=new EventEmitter();runtime.call=async(op,p)=>{calls.push([op,p]);return op==='configure-model'?{effort:'pro',paused:true}:{};};
  const r={page_id:'math',model:'GPT-5.6 · 最新',effort:'极高',url:'https://chatgpt.com/c/original',paused:true};
  const p={id:r.page_id,view:{webContents:{}}};
  const d=new WebDriver({runtime,pool:{},onNotice(){},dom:async()=>({url:r.url,editor:true,controlKnown:true})});d.records.set(p.id,r);
  d.inspect=async()=>({model:r.model,effort:r.effort,selection:['最新']});
  return {d,p,r,runtime,calls,payload:{effort:'Pro',expected_model:r.model,expected_effort:r.effort}};
}
test('record composer switches verified Pro without Send or resume and releases its page lock',async()=>{
  const {d,p,r,calls,payload}=fixture();
  d.selectModel=async(_p,expected)=>{assert.ok(d.busy.has(p.id));assert.equal(expected.effort,'Pro');return {model:r.model,effort:'Pro',slider:{min:0,max:4,value:4}};};
  const result=await d.setWorkModel(p,payload);
  assert.deepEqual(calls.map(c=>c[0]),['model-change-check','configure-model']);
  assert.equal(result.paused,true);assert.equal(result.model_sends,0);assert.equal(d.busy.has(p.id),false);
});
test('already executing/unknown request blocks model controls before the first browser action',async()=>{
  const {d,p,runtime,payload}=fixture();runtime.call=async()=>{throw Error('managed_original_send_unconfirmed');};
  d.dom=async()=>assert.fail('must not touch live model controls');
  await assert.rejects(()=>d.setWorkModel(p,payload),/managed_original_send_unconfirmed/);
  assert.equal(d.busy.has(p.id),false);
});

test('operator chooses Pro on the actual public model selection and saves its verified name, retaining record CAS',async()=>{
  const {d,p,r,calls,payload}=fixture();
  d.inspect=async()=>({model:'GPT-6 · 最新',effort:'极高',selection:['最新']});
  d.selectModel=async(_p,expected,options)=>{
    assert.equal(expected.model,'GPT-6 · 最新');assert.equal(expected.effort,'Pro');
    assert.equal(options.followPageSelection,true);
    return {model:'GPT-6 · 最新',effort:'Pro',selection:['最新']};
  };
  await d.setWorkModel(p,payload);
  const saved=calls.find(c=>c[0]==='configure-model')[1];
  assert.equal(saved.model,'GPT-6 · 最新');assert.equal(saved.expected_model,r.model);
});
test('a model save failure after selection pauses dispatch and never substitutes or sends work',async()=>{
  const {d,p,r,runtime,calls,payload}=fixture();
  d.selectModel=async()=>({model:r.model,effort:'Pro'});
  runtime.call=async(op,args)=>{calls.push([op,args]);if(op==='configure-model')throw Error('disconnected');return {};};
  await assert.rejects(()=>d.setWorkModel(p,payload),/disconnected/);
  assert.deepEqual(calls.map(c=>c[0]),['model-change-check','configure-model','page-issue']);
  assert.equal(calls.at(-1)[1].kind,'model_mismatch');
});
test('withdrawing an unsent message does not require a loaded browser or an empty work-record draft',async()=>{
  const {d,p,calls}=fixture();d.busy.add(p.id);d.dom=async()=>assert.fail('withdraw should only use the ledger');
  await d.withdraw(p,{request_id:'original'});
  assert.deepEqual(calls,[['withdraw',{page_id:p.id,request_id:'original'}]]);
});
test('partial public turn retirement uses the current DOM identity and never clicks Send',async()=>{
  const {d,p,r,calls}=fixture();r.collaboration_protocol='text_v1';d.reconcileAll=async()=>{};
  d.dom=async(_wc,action)=>{
    assert.equal(action,'snapshot');
    return {url:r.url,complete:true,historyAtLatest:true,generating:false,draft:false,
      composing:false,userTextComplete:true,userId:'current-user-turn',
      assistantId:'current-assistant-turn',userText:'only first line',
      html:'<div class="markdown"><p>Worker acknowledged.</p></div>'};
  };
  const result=await d.retirePartial(p,{request_id:'original',attempt_id:'control_123',
    observation_hash:'a'.repeat(64),reason:'Reviewed original turn',confirm:true});
  assert.deepEqual(result,{});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'retire-partial');
  assert.equal(calls[0][1].user_text,'only first line');
  assert.equal(calls[0][1].assistant_text,'Worker acknowledged.');
  assert.equal(calls[0][1].confirm,true);
  assert.equal(calls[0][1].user_hash.length,64);
  assert.equal(d.busy.has(p.id),false);
});
