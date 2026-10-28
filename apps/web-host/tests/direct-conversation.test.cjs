'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {WebDriver}=require('../web-driver.cjs');
const id='web-11111111-1111-4111-8111-111111111111',home='https://chatgpt.com/',url='https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
function fixture(t){
 const calls=[],page={id,account:'A',view:{webContents:{getURL:()=>home,isDestroyed:()=>false}}};
 let registered;
 const runtime=new EventEmitter();runtime.ready=true;runtime.call=async(op,payload)=>{
  calls.push([op,payload]);if(op==='list')return {pages:registered?[registered]:[]};
  if(op==='register-direct'){registered={...payload,phase:'bound',thread_id:'original-thread',conversation_mode:'direct',account:'A'};return {state:'bound',thread_id:registered.thread_id};}
  if(op==='bind-direct')return {state:'bound',url:payload.url};
  assert.fail('unexpected operation '+op);
 };
 const driver=new WebDriver({runtime,pool:{pages:new Map([[id,page]])},onNotice(){},dom:async()=>({url:home,editor:true,controlKnown:true,generating:false,draft:false,composing:false,approvalRequired:false})});
 driver.inspect=async()=>({model:'gpt-6 · latest',effort:'high'});driver.selectModel=async()=>({model:'gpt-6 · latest',effort:'high'});
 driver.reconcileAll=async()=>{if(registered)driver.records.set(id,registered);};
 t.after(()=>driver.dispose());return {driver,page,calls,get registered(){return registered;},set registered(value){registered=value;}};
}
test('new single conversation registers its original ledger with no project or Session enrollment and no default budgets',async t=>{
 const f=fixture(t),result=await f.driver.startFirstTurn(f.page,{root:'',title:'New conversation',instructions:'A full task',effort:'高',conversation_mode:'direct'});
 assert.equal(result.state,'direct_ready');assert.equal(result.thread_id,'original-thread');
 const register=f.calls.find(([op])=>op==='register-direct')[1];assert.equal(register.root,'');assert.equal(register.account,'A');assert.equal(register.collaboration_enabled,false);
 assert.equal(register.duration_seconds,null);assert.equal(register.max_dispatches,null);assert.deepEqual(f.calls.map(([op])=>op),['list','register-direct']);
});
test('restart after registering but before first send reuses the same conversation while an accepted request cannot be repeated',async t=>{
 const f=fixture(t);f.registered={page_id:id,thread_id:'original',phase:'bound',conversation_mode:'direct'};
 const result=await f.driver.startFirstTurn(f.page,{conversation_mode:'direct',effort:'高'});assert.equal(result.state,'direct_ready');assert.deepEqual(f.calls.map(([op])=>op),['list']);
 f.registered.latest_request={id:'accepted-original',phase:'processing'};
 await assert.rejects(f.driver.startFirstTurn(f.page,{conversation_mode:'direct',effort:'高'}),/首次任务已提交/);assert.equal(f.calls.filter(([op])=>op==='register-direct').length,0);
});
test('only the unique original attempt may bind the owned new web address without changing thread or request identity',async t=>{
 const f=fixture(t),attempt='control_'+'a'.repeat(32),record={page_id:id,thread_id:'original',account:'A',url:home,conversation_mode:'direct',latest_request:{id:'accepted-original',attempt_id:attempt}};
 f.page.view.webContents.getURL=()=>url;f.driver.records.set(id,record);
 const snapshot={url,userId:'original-user',attemptMarker:'[CLW:'+attempt+']',attemptMarkerCount:1};
 assert.equal(await f.driver.bindDirectCarrier(f.page,record,{...snapshot,attemptMarkerCount:2}),null);assert.equal(f.calls.length,0);
 const result=await f.driver.bindDirectCarrier(f.page,record,snapshot);assert.equal(result.thread_id,'original');assert.equal(result.latest_request.id,'accepted-original');assert.equal(result.url,url);
 assert.deepEqual(f.calls.map(([op])=>op),['bind-direct']);
});
