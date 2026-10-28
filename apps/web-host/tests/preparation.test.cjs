'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {WebDriver}=require('../web-driver.cjs');
const {enrollmentState,workflow}=require('../workflow-state.js');

test('enrolling worker shows actual extra high separately from later Pro; old records do not guess',()=>{
  const p={enrolling:true,model:'GPT-6 · 最新',effort:'Pro',bootstrap_model_selection:{model:'GPT-5.6 · 最新',effort:'极高'}};
  const s=enrollmentState(p,{model:p.model,effort:'Pro'});
  assert.equal(s.selection.effort,'极高');assert.equal(s.label,'本轮接入模型');assert.match(s.next,/Pro/);
  assert.equal(enrollmentState({...p,bootstrap_model_selection:null}).nav,'接入 · 待核对');
  assert.equal(enrollmentState({...p,enrolling:false,bound:true}).selection.effort,'Pro');
});

test('one completed preparation turn binds its exact Markdown without a second send',async()=>{
  const calls=[],runtime=new EventEmitter();runtime.call=async(op,p)=>{calls.push([op,p]);return {};};
  const marker='CLW-MANAGED:own',r={page_id:'one',phase:'receiver_enrolled',marker,first_turn_instructions:'Read HANDOFF.md'};
  const s={url:'https://chatgpt.com/c/own',userId:'first',assistantId:'answer',publicText:'Plan '+marker,
    html:'<h2>Plan</h2><pre><code>const x = 1;</code></pre><p><a href="https://example.com/source">source</a></p><p>'+marker+'</p>',complete:true,editor:true,generating:true};
  const p={id:'one',view:{webContents:{getURL:()=>s.url}}};
  const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:async()=>s});
  d.send=async()=>assert.fail('preparation must not send again');
  await d.tick(r);assert.ok(!calls.some(([op])=>op==='bind'));
  s.generating=false;await d.tick(r);
  const bind=calls.find(([op])=>op==='bind')[1];
  assert.match(bind.preparation_markdown,/## Plan/);assert.match(bind.preparation_markdown,/```[\s\S]*const x = 1;/);
  assert.match(bind.preparation_markdown,/\[source\]\(https:\/\/example.com\/source\)/);assert.match(bind.source_hash,/^[a-f0-9]{64}$/);
  const stage=workflow({...r,enrollment_phase:r.phase,enrolling:true,bootstrap_state:'sent',bootstrap_model_selection:{effort:'Pro'},observation:{editorReady:true}});
  assert.equal(stage.title,'等待／回收 · 首轮结果');
});

test('enroll forwards the optional instruction after verifying the actual selected model',async()=>{
  const calls=[],runtime=new EventEmitter();runtime.call=async(op,p)=>{calls.push([op,p]);return {state:'reserved'};};
  const d=new WebDriver({runtime,pool:{},onNotice(){}});
  d.inspect=async()=>({model:'GPT-6',effort:'Pro'});d.reconcileAll=async()=>{};
  await d.enroll({id:'one'},{model:'GPT-6',effort:'Pro',first_turn_instructions:'Read handoff'});
  assert.equal(calls[0][1].first_turn_instructions,'Read handoff');assert.equal(calls.length,1);
  await assert.rejects(()=>d.enroll({id:'two'},{model:'GPT-6',effort:'极高'}),/模型已变化/);
  assert.equal(calls.length,1);
});
