'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ShellControl}=require('../shell-control.cjs');
function fixture(){const sent=[],contents={isDestroyed:()=>false,getURL:()=> 'file:///original/index.html',send:(channel,message)=>sent.push({channel,message})};
  const gate=new ShellControl({contents:()=>contents,timeoutMs:20});return {sent,contents,gate};}
test('typed shell control requires the exact sender and original pending request',async()=>{
  const f=fixture(),pending=f.gate.request('inspect');
  assert.equal(f.sent[0].channel,'clw-ui-control');
  assert.equal(f.gate.respond({sender:{}},{id:f.sent[0].message.id,ok:true,result:{foreign:true}}),false);
  assert.equal(f.gate.respond({sender:f.contents},{id:f.sent[0].message.id,ok:true,result:{selected:'original'}}),true);
  assert.deepEqual(await pending,{selected:'original'});assert.equal(f.gate.pending.size,0);
});
test('reload invalidates old shell receipts without replaying them',async()=>{
  const f=fixture(),pending=f.gate.request('prepare-reload');f.gate.invalidate();
  await assert.rejects(pending,/owner_changed/);
  assert.equal(f.gate.respond({sender:f.contents},{id:f.sent[0].message.id,ok:true,result:{safe:true}}),false);
  assert.equal(f.sent.length,1);
});
test('an absent shell answer is unknown and an explicit refusal remains a refusal',async()=>{
  const f=fixture();await assert.rejects(f.gate.request('inspect'),/response_unknown/);
  const pending=f.gate.request('prepare-reload');
  f.gate.respond({sender:f.contents},{id:f.sent[1].message.id,ok:false,code:'app_shell_draft_not_saved'});
  await assert.rejects(pending,e=>e.accepted===false&&/draft_not_saved/.test(e.message));
});
