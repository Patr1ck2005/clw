'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {RuntimeBridge}=require('../runtime-bridge.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let n=0;n<200;n++){if(predicate())return;await delay(2);}throw Error('fixture recovery deadline');}
function fixture(options={}){
  const children=[],inputs=[],notices=[];
  const runtime=new RuntimeBridge('fixture-runtime-only',{restartDelays:[2,2,2],stableAfterMs:60000,recoveryCooldownMs:25,startupTimeoutMs:100,closeTimeoutMs:5,
    spawnProcess:()=>{
      const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),exitCode:null});
      child.stdin.on('data',line=>inputs.push(JSON.parse(String(line))));
      child.exit=()=>{if(child.exitCode!==null)return;child.exitCode=1;child.emit('exit',1);};child.stdin.on('finish',child.exit);
      children.push(child);if(options.automaticReady!==false)queueMicrotask(()=>child.stdout.write('CLW_MANAGED_READY '+JSON.stringify({protocol:'clw.managed-browser.v1',store_id:'same-owned-ledger'})+'\n'));return child;
    },...options});runtime.on('notice',message=>notices.push(message));return {runtime,children,inputs,notices};
}
test('confirmed Host exits recover in bounded batches separated by cooldown without replaying an accepted call',async t=>{
  const f=fixture();t.after(()=>f.runtime.close());await f.runtime.start();
  const accepted=assert.rejects(f.runtime.call('start',{operation_id:'original-accepted-operation'}),/disconnected_reconcile_original/);
  f.children[0].exit();await accepted;await until(()=>f.children.length===2&&f.runtime.ready);
  for(let n=2;n<=3;n++){f.children.at(-1).exit();await until(()=>f.children.length===n+1&&f.runtime.ready);}
  f.children.at(-1).exit();const count=f.children.length;await delay(5);assert.equal(f.children.length,count,'no unbounded immediate retry');
  await until(()=>f.children.length===5&&f.runtime.ready);assert.equal(f.runtime.store,'same-owned-ledger');assert.equal(f.runtime.pending.size,0);
  assert.equal(f.inputs.filter(input=>input.op==='start').length,1);assert.equal(f.notices.filter(message=>/冷却/.test(message)).length,1);
  await f.runtime.close();const stopped=f.children.length;await delay(35);assert.equal(f.children.length,stopped);
});
test('a broken original response pipe never recovers through a late READY from its live Host',async t=>{
  const f=fixture({automaticReady:false,startupTimeoutMs:5});t.after(()=>f.runtime.close());
  await assert.rejects(f.runtime.start(),/启动超时/);f.children[0].stdout.end();await delay(2);
  await assert.rejects(f.runtime.start(),/runtime_previous_process_not_exited/);assert.equal(f.runtime.ready,false);assert.equal(f.children.length,1);
});
test('a late READY after deadline cannot change the original store and protocol rejection never loops',async t=>{
  const f=fixture({automaticReady:false,startupTimeoutMs:5,recoveryCooldownMs:5});t.after(()=>f.runtime.close());f.runtime.store='original-ledger';
  await assert.rejects(f.runtime.start(),/启动超时/);
  f.children[0].stdout.write('CLW_MANAGED_READY '+JSON.stringify({protocol:'clw.managed-browser.v1',store_id:'foreign-ledger'})+'\n');
  assert.equal(f.runtime.ready,false);assert.equal(f.runtime.store,'original-ledger');assert.equal(f.runtime.snapshot().code,'managed_protocol_store_changed');
  f.children[0].exit();await delay(35);assert.equal(f.children.length,1);
});
test('receipt timeout settles once and its late frame cannot acknowledge another original receipt lookup',async t=>{
  const f=fixture({receiptTimeoutMs:5});t.after(()=>f.runtime.close());await f.runtime.start();
  const accepted=f.runtime.call('start',{operation_id:'same-original'}),oldId=[...f.runtime.pending.keys()][0];
  await assert.rejects(accepted,/runtime_receipt_unknown_reconcile_original/);assert.equal(f.runtime.pending.size,0);
  const receipt=f.runtime.call('receipt',{operation_id:'same-original'}),currentId=[...f.runtime.pending.keys()][0];
  f.children[0].stdout.write('CLW_MANAGED '+JSON.stringify({id:oldId,ok:true,result:{request_id:'wrong-old'}})+'\n');assert.equal(f.runtime.pending.size,1);
  f.children[0].stdout.write('CLW_MANAGED '+JSON.stringify({id:currentId,ok:true,result:{request_id:'same-original',state:'completed'}})+'\n');
  assert.equal((await receipt).request_id,'same-original');assert.deepEqual(f.inputs.map(input=>input.op),['start','receipt']);assert.equal(f.runtime.pending.size,0);
});
