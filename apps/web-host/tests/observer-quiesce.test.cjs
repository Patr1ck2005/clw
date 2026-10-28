'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {WebDriver}=require('../web-driver.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture({domGate,readGate}={}){
  const calls=[],runtime=new EventEmitter();runtime.ready=true;
  const row={page_id:'original',thread_id:'same-thread',phase:'bound',paused:true,url:'https://chatgpt.com/c/original',latest_request:{id:'original-request',phase:'processing'}};
  const wc={getURL:()=>row.url,isDestroyed:()=>false},page={id:row.page_id,domReady:true,documentGeneration:1,view:{webContents:wc}};
  const pool={pages:new Map([[row.page_id,page]]),selected:row.page_id,running(){},work(){},emit(){}};
  runtime.call=async(op,args)=>{calls.push(op);if(op==='list'){if(readGate)await readGate.promise;return {pages:[row]};}
    if(op==='pending-receipt')return {state:'paused_no_pending_receipt'};assert.fail(`quiesce dispatched ${op}`);};
  const driver=new WebDriver({runtime,pool,onNotice(){},observeIntervalMs:5,dom:async(_,op)=>{
    calls.push('dom:'+op);assert.equal(op,'snapshot');if(domGate)await domGate.promise;
    return {url:row.url,editor:true,controlKnown:true,userId:'same-user',historyAtLatest:true,generating:false,draft:false,composing:false,approvalRequired:false};
  }});driver.records.set(row.page_id,row);
  return {driver,row,page,pool,runtime,calls};
}
test('quiesce joins an original DOM read, freezes later ticks and preserves original pending results',async()=>{
  const gate=deferred(),f=fixture({domGate:gate});const tick=f.driver.tick(f.row);
  assert.equal(f.driver.busy.size,1);f.driver.pending.set('original',{attempt:'original-accepted'});
  f.driver.resultCandidates.set('same-attempt',{signature:'original-result'});
  let done=false;const quiescing=f.driver.quiesceObservation().then(r=>{done=true;return r;});await wait(5);assert.equal(done,false);
  await f.driver.tick(f.row);assert.equal(f.calls.filter(x=>x==='dom:snapshot').length,1);
  gate.resolve();assert.equal((await quiescing).remaining,0);await tick;
  assert.equal(f.driver.busy.size,0);assert.equal(f.driver.pending.get('original').attempt,'original-accepted');
  assert.equal(f.driver.resultCandidates.get('same-attempt').signature,'original-result');assert.deepEqual(f.calls,['dom:snapshot']);f.driver.dispose();
});
test('quiesced reconciliation refreshes the original ledger without starting another page read',async()=>{
  const f=fixture();await f.driver.quiesceObservation();await f.driver.reconcileAll();
  assert.equal(f.driver.recordsLoaded,true);assert.deepEqual(f.calls,['list']);assert.equal(f.driver.busy.size,0);f.driver.dispose();
});
test('deadline retains the original read and resume recreates one observer after the old cycle settles',async()=>{
  const gate=deferred(),f=fixture({readGate:gate});f.driver.monitorEnabled=true;f.driver.scheduleObservation();await wait(10);
  assert.ok(f.driver.monitorCycle);await assert.rejects(f.driver.quiesceObservation({timeoutMs:5}),/web_observer_drain_timeout/);
  assert.equal(f.driver.timer,null);assert.equal(f.driver.observationQuiesced,true);assert.ok(f.driver.recordsRefresh);
  assert.equal(f.driver.resumeObservation(),true);gate.resolve();
  const resumedDeadline=Date.now()+1000;
  while(f.calls.filter(x=>x==='list').length<2&&Date.now()<resumedDeadline)await wait(5);
  assert.ok(f.calls.filter(x=>x==='list').length>=2,'the prior cycle finalizer restores observation after resume');
  assert.ok(f.driver.timer||f.driver.monitorCycle);f.driver.dispose();await wait(10);assert.equal(f.driver.timer,null);
});
test('a successful temporary quiesce resumes observation but an explicit stop remains stopped',async()=>{
  const f=fixture();await f.driver.restore();await f.driver.quiesceObservation();assert.equal(f.driver.timer,null);
  f.driver.resumeObservation();await wait(15);assert.ok(f.calls.filter(x=>x==='list').length>=2);
  await f.driver.quiesceObservation();f.driver.stop();assert.equal(f.driver.resumeObservation(),false);
  const count=f.calls.length;await wait(15);assert.equal(f.calls.length,count);assert.equal(f.driver.stopped,true);f.driver.dispose();
});
test('quiescing while an original dispatch is accepted keeps that grant pending and never sends it',async()=>{
  const gate=deferred(),entered=deferred(),f=fixture();f.row.paused=false;f.page.modelRestorePending=false;
  f.row.model='GPT-6';f.row.effort='Pro';f.driver.inspect=async()=>({model:'GPT-6',effort:'Pro'});
  f.driver.send=async()=>assert.fail('quiescing must not send a newly returned grant');
  f.runtime.call=async(op,args)=>{
    assert.equal(op,'wire');f.calls.push('wire:'+args.data.action);
    if(args.data.action==='pulse')return {state:'offer',attempt_id:'accepted-original'};
    assert.equal(args.data.action,'dispatch');entered.resolve();await gate.promise;return {dispatch:true,prompt:'Original grant'};
  };
  const tick=f.driver.tick(f.row);await entered.promise;const join=f.driver.quiesceObservation();gate.resolve();await join;await tick;
  assert.equal(f.driver.pending.get('original').attempt,'accepted-original');
  assert.deepEqual(f.calls,['dom:snapshot','wire:pulse','dom:snapshot','wire:dispatch']);assert.equal(f.driver.busy.size,0);f.driver.dispose();
});
test('one hundred restore and temporary pause cycles drain their original tasks without orphan observers',async()=>{
  const f=fixture();
  for(let n=0;n<100;n++){
    await f.driver.restore();await f.driver.quiesceObservation();
    assert.equal(f.driver.observationTasks.size,0);assert.equal(f.driver.pageReconciliations.size,0);
    assert.equal(f.driver.busy.size,0);assert.equal(f.driver.timer,null);f.driver.resumeObservation();
  }
  f.driver.dispose();const before=f.calls.length;await wait(15);
  assert.equal(f.calls.length,before);assert.equal(f.driver.observationTasks.size,0);
  assert.equal(f.runtime.listenerCount('ready'),0);assert.equal(f.runtime.listenerCount('disconnected'),0);assert.equal(f.driver.timer,null);
});
