'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const {PassThrough,Writable}=require('node:stream');
const {RuntimeBridge}=require('../runtime-bridge.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await delay(2);}throw Error('reconnect did not settle');}
function fakeChildren(){const children=[];return {children,spawn:()=>{
 const c=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),exitCode:null});
 c.exit=()=>{if(c.exitCode!==null)return;c.exitCode=1;c.emit('exit',1);};c.stdin.on('finish',c.exit);
 children.push(c);queueMicrotask(()=>c.stdout.write('CLW_MANAGED_READY '+JSON.stringify({protocol:'clw.managed-browser.v1',store_id:'original-store'})+'\n'));return c;
}};}
test('reconnection preserves an uncertain call, resets only after stability, and explicit close never restarts',async()=>{
 const f=fakeChildren(),r=new RuntimeBridge('test',{spawnProcess:f.spawn,restartDelays:[2,2,2],stableAfterMs:12});await r.start();
 const unknown=r.call('start',{operation_id:'original'}).then(()=>assert.fail('accepted result was invented'),e=>assert.match(e.message,/disconnected_reconcile_original/));
 f.children[0].exit();await unknown;await until(()=>f.children.length===2&&r.ready);
 assert.equal(r.restarts,1);await delay(20);assert.equal(r.restarts,0);
 for(let n=0;n<4;n++){const before=f.children.length;f.children.at(-1).exit();await until(()=>f.children.length===before+1&&r.ready);await delay(20);}
 const count=f.children.length;await r.close();await delay(15);assert.equal(f.children.length,count);
});
test('a continuous crash loop is still bounded to three retries',async()=>{
 const f=fakeChildren(),r=new RuntimeBridge('test',{spawnProcess:f.spawn,restartDelays:[2,2,2],stableAfterMs:60000});await r.start();
 for(let n=0;n<3;n++){f.children.at(-1).exit();await until(()=>f.children.length===n+2&&r.ready);}
 f.children.at(-1).exit();await delay(20);assert.equal(f.children.length,4);assert.equal(r.ready,false);await r.close();
});

test('close fences a late poll before stdin ends and retains an accepted unknown request',async()=>{
 const f=fakeChildren(),r=new RuntimeBridge('test',{spawnProcess:f.spawn});await r.start();
 let input='';f.children[0].stdin.on('data',chunk=>{input+=chunk;});
 const accepted=assert.rejects(r.call('start',{operation_id:'original'}),/disconnected_reconcile_original/);
 const closing=r.close();assert.equal(r.ready,false);
 await assert.rejects(r.call('pending-receipt',{page_id:'original-page'}),/runtime_not_connected/);
 await Promise.all([accepted,closing,r.close()]);await delay(5);
 assert.deepEqual(input.trim().split('\n').map(line=>JSON.parse(line).op),['start','shutdown']);
 assert.equal(r.pending.size,0);assert.equal(f.children.length,1);
});

test('an asynchronous pipe write error rejects the original call without an uncaught stream error or replay',async()=>{
 const f=fakeChildren();let writes=0;
 const r=new RuntimeBridge('test',{spawnProcess:()=>{
  const child=f.spawn();child.stdin=new Writable({write(_chunk,_encoding,callback){writes++;setImmediate(()=>callback(Object.assign(Error('pipe ended'),{code:'ERR_STREAM_WRITE_AFTER_END'})));}});
  return child;
 }});await r.start();
 await assert.rejects(r.call('start',{operation_id:'original'}),/disconnected_reconcile_original/);
 await delay(5);await assert.rejects(r.call('start',{operation_id:'another'}),/runtime_not_connected/);
 assert.equal(writes,1);assert.equal(r.pending.size,0);await r.close();
});

test('concurrent startup callers share one child and one readiness receipt',async()=>{
 const f=fakeChildren(),r=new RuntimeBridge('test',{spawnProcess:f.spawn});
 try { await Promise.all([r.start(),r.start(),r.start()]);assert.equal(f.children.length,1); }
 finally { await r.close();for(const child of f.children)child.exit(); }
});

test('close during startup settles the original waiter and ignores late readiness',async()=>{
 const f=fakeChildren(),r=new RuntimeBridge('test',{spawnProcess:f.spawn,startupTimeoutMs:25});
 const started=assert.rejects(r.start(),/runtime_closed/);
 await r.close();await started;assert.equal(r.ready,false);assert.equal(f.children.length,1);
});

test('invalid startup frames are contained and never reopen the send path',async()=>{
 for(const frame of ['{broken','null',JSON.stringify({protocol:'wrong',store_id:'store'})]){
  const f=fakeChildren(),r=new RuntimeBridge('test',{spawnProcess:()=>{
   const c=f.spawn();c.stdout.write('CLW_MANAGED_READY '+frame+'\n');return c;
  },restartDelays:[],startupTimeoutMs:25});
  try { await assert.rejects(r.start(),/managed_protocol/);assert.equal(r.ready,false); }
  finally { await r.close(); }
 }
});

test('a timed out startup recovers only a verified late READY from the same owned process',async()=>{
 const c=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),exitCode:null});
 let spawns=0;const r=new RuntimeBridge('test',{spawnProcess:()=>{spawns++;return c;},startupTimeoutMs:5,closeTimeoutMs:5});
  await assert.rejects(r.start(),/启动超时/);
  await assert.rejects(r.start(),/runtime_previous_process_not_exited/);
  c.stdout.write('CLW_MANAGED_READY '+JSON.stringify({protocol:'clw.managed-browser.v1',store_id:'late'})+'\n');
  assert.equal(r.ready,true);assert.equal((await r.start()).store_id,'late');assert.equal(spawns,1);await r.close();
});

test('losing the response pipe fences sending without spawning over a live process',async()=>{
 const f=fakeChildren(),r=new RuntimeBridge('test',{spawnProcess:f.spawn,restartDelays:[1]});await r.start();
 const pending=assert.rejects(r.call('start',{operation_id:'original'}),/disconnected_reconcile_original/);
 f.children[0].stdout.end();await pending;
 await assert.rejects(r.call('start',{operation_id:'second'}),/runtime_not_connected/);
 await assert.rejects(r.start(),/runtime_previous_process_not_exited/);
 assert.equal(f.children.length,1);await r.close();
});

test('a previous child cannot acknowledge a replacement child call',async()=>{
 const f=fakeChildren(),r=new RuntimeBridge('test',{spawnProcess:f.spawn,restartDelays:[1]});await r.start();
 const previous=f.children[0];previous.exit();await until(()=>f.children.length===2&&r.ready);
 const received=r.call('receipt',{operation_id:'original'});const id=[...r.pending.keys()][0];
 previous.stdout.write('CLW_MANAGED '+JSON.stringify({id,ok:true,result:'foreign'})+'\n');
 assert.equal(r.pending.size,1);
 f.children[1].stdout.write('CLW_MANAGED '+JSON.stringify({id,ok:true,result:'original receipt'})+'\n');
 assert.equal(await received,'original receipt');await r.close();
});

test('reconnection cannot silently switch the task ledger',async()=>{
 const f=fakeChildren(),r=new RuntimeBridge('test',{spawnProcess:()=>{
  const c=f.spawn();if(f.children.length>1)c.stdout.write('CLW_MANAGED_READY '+JSON.stringify({protocol:'clw.managed-browser.v1',store_id:'different-ledger'})+'\n');return c;
 },restartDelays:[1]});await r.start();
 f.children[0].exit();await until(()=>f.children.length===2&&!r.starting);
 assert.equal(r.ready,false);assert.equal(r.store,'original-store');
 await assert.rejects(r.call('list'),/runtime_not_connected/);await r.close();
});
