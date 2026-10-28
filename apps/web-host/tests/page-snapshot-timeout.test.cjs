'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runDom}=require('../page-dom.cjs');
const {WebDriver}=require('../web-driver.cjs');
const {EventEmitter}=require('node:events');
function stalledRead(){
 let finish;const calls=[],wait=new Promise(resolve=>{finish=resolve;});
 const wc={getURL:()=> 'https://chatgpt.com/c/original',isDestroyed:()=>false,debugger:{isAttached:()=>true,async sendCommand(method){calls.push(method);if(method==='Page.getFrameTree'){await wait;return {frameTree:{frame:{id:'frame'}}};}if(method==='Page.createIsolatedWorld')return {executionContextId:1};return {result:{value:{editor:true,generating:false}}};}}};
 return {wc,calls,finish};
}
test('a stalled readonly snapshot ends without another browser command or input',async()=>{
 const f=stalledRead();await assert.rejects(runDom(f.wc,'snapshot',{}, {snapshotTimeoutMs:10}),/page_snapshot_timeout/);
 assert.deepEqual(f.calls,['Page.getFrameTree']);
});
test('concurrent and later stalled observations retain just the one original underlying read',async()=>{
 const f=stalledRead();
 const original=await Promise.allSettled(Array.from({length:20},()=>runDom(f.wc,'snapshot',{}, {snapshotTimeoutMs:10})));
 assert.ok(original.every(r=>r.status==='rejected'&&r.reason.message==='page_snapshot_timeout'));
 const later=await Promise.allSettled(Array.from({length:50},()=>runDom(f.wc,'snapshot',{}, {snapshotTimeoutMs:10})));
 assert.ok(later.every(r=>r.status==='rejected'&&r.reason.message==='page_snapshot_timeout'));
 assert.deepEqual(f.calls,['Page.getFrameTree']);
 f.finish();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(f.calls,['Page.getFrameTree','Page.createIsolatedWorld','Runtime.evaluate']);
 const fresh=await runDom(f.wc,'snapshot',{}, {snapshotTimeoutMs:10});assert.equal(fresh.editor,true);assert.equal(f.calls.length,6);
});
test('the timeout releases only the observer busy flag and preserves original execution',async()=>{
 const f=stalledRead(),page={id:'original',documentGeneration:1,view:{webContents:f.wc}},record={page_id:'original',phase:'bound',url:f.wc.getURL(),paused:true,latest_request:{id:'same-original',phase:'processing'}},before=JSON.stringify(record),runtime=new EventEmitter();
 runtime.call=()=>assert.fail('a stalled read cannot change or replay execution');
 const d=new WebDriver({runtime,pool:{pages:new Map([[page.id,page]])},dom:(wc,action)=>runDom(wc,action,{}, {snapshotTimeoutMs:10})});
 await assert.rejects(d.tick(record),/page_snapshot_timeout/);assert.equal(d.busy.has(page.id),false);assert.equal(JSON.stringify(record),before);assert.deepEqual(f.calls,['Page.getFrameTree']);
});
test('successful snapshot and original failure keep their values and are never replayed',async()=>{
 for(const failure of [false,true]){
  const calls=[],value={editor:true,generating:false};
  const wc={getURL:()=> 'https://chatgpt.com/',debugger:{isAttached:()=>true,async sendCommand(method){calls.push(method);if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame'}}};if(method==='Page.createIsolatedWorld')return {executionContextId:1};if(failure)throw Error('original_snapshot_failure');return {result:{value}};}}};
  if(failure)await assert.rejects(runDom(wc,'snapshot',{}, {snapshotTimeoutMs:20}),/original_snapshot_failure/);
  else assert.equal(await runDom(wc,'snapshot',{}, {snapshotTimeoutMs:20}),value);
  assert.deepEqual(calls,['Page.getFrameTree','Page.createIsolatedWorld','Runtime.evaluate']);
 }
});
