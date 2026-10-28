'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {startExistingTask}=require('../task-submission.cjs');
test('send uses its explicit owner without implicit resume even when selected page changes',async()=>{
  let selected='chaos';const pages={games:{id:'games'},chaos:{id:'chaos'}},calls=[];
  const dependencies={pageById:id=>pages[id||selected],
    driver:{resume:async(p,request)=>{calls.push(['resume',p.id,request]);selected='chaos';}},
    submissions:{start:async(id,text)=>{calls.push(['send',id,text]);selected='chaos';await Promise.resolve();return {state:'queued_for_web_host'};}}};
  await assert.rejects(startExistingTask(dependencies,{id:'games',objective:'Game work',resume:true}),/须单独操作/);
  assert.deepEqual(calls,[]);
  await startExistingTask(dependencies,{id:'games',objective:'Game work'});
  assert.deepEqual(calls,[['send','games','Game work']]);
});
test('missing target cannot silently send to current sidebar selection',async()=>{
  await assert.rejects(()=>startExistingTask({pageById:()=>assert.fail('resolved implicit target')},{objective:'work'}),/未指定/);
});
test('paused active append retains the captured task and original request without recovery',async()=>{
  const calls=[];
  await startExistingTask({pageById:id=>({id}),submissions:{start:async(...args)=>{calls.push(args);return {state:'note_saved_not_native_interrupt'};}},
    driver:{records:new Map([['chaos',{paused:true}]]),resume:async()=>assert.fail('append resumed automation')}},
    {id:'chaos',objective:'Corrected remaining work',expected_request_id:'original'});
  assert.deepEqual(calls,[['chaos','Corrected remaining work','original']]);
});
