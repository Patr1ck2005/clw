'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {RuntimeBridge}=require('../runtime-bridge.cjs');
const {presentation,notice}=require('../runtime-availability.js');
const diagnostic='CLW Harness port is in use. No process was stopped. Keep the original app or close only its terminal.';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(options={}){
 const children=[],notices=[];const runtime=new RuntimeBridge('fixture-only',{startupTimeoutMs:20,closeTimeoutMs:5,restartDelays:[30],spawnProcess:()=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),exitCode:null});
  child.exit=()=>{child.exitCode=1;child.emit('exit',1);};children.push(child);return child;
 },...options});runtime.on('notice',message=>notices.push(message));return {runtime,children,notices};
}
test('known split startup diagnostic stops recovery without exposing stderr or changing the endpoint',async()=>{
 const f=fixture();const failure=assert.rejects(f.runtime.start(),/runtime_port_in_use/),child=f.children[0];
 child.stderr.write(diagnostic.slice(0,44));child.stderr.write(diagnostic.slice(44)+'\r\n'+'private-fixture-trailer'.repeat(1000));child.exit();await failure;await wait(40);
 assert.deepEqual(f.runtime.snapshot(),{state:'unavailable',code:'runtime_port_in_use'});assert.equal(f.children.length,1);
 assert.deepEqual(f.notices,['runtime_port_in_use','runtime_port_in_use']);await f.runtime.close();
});
test('stdout EOF and exit before the original stderr diagnostic still cancel that recovery timer',async()=>{
 const f=fixture();const failure=assert.rejects(f.runtime.start(),/disconnected_reconcile_original/),child=f.children[0];
 child.stdout.end();await failure;child.exit();child.stderr.write(diagnostic+'\n');await wait(40);
 assert.equal(f.runtime.snapshot().code,'runtime_port_in_use');assert.equal(f.children.length,1);await f.runtime.close();
});
test('stderr inspection is limited to 4 KiB and unknown output never enters public status',async()=>{
 for(const output of ['private-fixture-message\n'+diagnostic+'-not-the-static-diagnostic\n','x'.repeat(4096)+'\n'+diagnostic+'\n','\n'.repeat(4096-diagnostic.length)+diagnostic+'-uninspected-suffix']){
  const f=fixture({restartDelays:[]});const failure=assert.rejects(f.runtime.start()),child=f.children[0];
  child.stderr.end(output);child.stdout.end();await failure;child.exit();
  assert.notEqual(f.runtime.snapshot().code,'runtime_port_in_use');assert.doesNotMatch(JSON.stringify([f.runtime.snapshot(),f.notices]),/private-fixture-message|x{20}/);await f.runtime.close();
 }
});
test('a partial final static line is recognized only when stderr ends',async()=>{
 const f=fixture();const failure=assert.rejects(f.runtime.start(),/runtime_port_in_use/);f.children[0].stderr.end(diagnostic);await failure;
 f.children[0].exit();await wait(40);assert.equal(f.children.length,1);await f.runtime.close();
});
test('a ready original service cannot be relabelled by later startup-looking stderr',async()=>{
 const f=fixture();const started=f.runtime.start(),child=f.children[0];child.stdout.write('CLW_MANAGED_READY '+JSON.stringify({protocol:'clw.managed-browser.v1',store_id:'original'})+'\n');await started;
 child.stderr.write(diagnostic+'\n');assert.deepEqual(f.runtime.snapshot(),{state:'ready',code:null});assert.deepEqual(f.notices,[]);await f.runtime.close();
});
test('a previous child stderr cannot poison a replacement service identity',async()=>{
 const f=fixture({restartDelays:[1],startupTimeoutMs:100});const started=f.runtime.start(),original=f.children[0];
 original.stdout.end();await assert.rejects(started);original.exit();await wait(8);assert.equal(f.children.length,2);
 const replacement=f.children[1];replacement.stdout.write('CLW_MANAGED_READY '+JSON.stringify({protocol:'clw.managed-browser.v1',store_id:'original'})+'\n');await wait(2);
 original.stderr.write(diagnostic+'\n');assert.deepEqual(f.runtime.snapshot(),{state:'ready',code:null});await f.runtime.close();
});
test('timeout stops the loading state without declaring the original process exited',async()=>{
 const f=fixture({startupTimeoutMs:5});await assert.rejects(f.runtime.start(),/启动超时/);
 assert.deepEqual(f.runtime.snapshot(),{state:'unavailable',code:'runtime_startup_timeout'});assert.equal(presentation({connected:false,runtime:f.runtime.snapshot()}).loading,false);
 await assert.rejects(f.runtime.start(),/previous_process_not_exited/);assert.equal(f.children.length,1);await f.runtime.close();
});
test('records or VPN unavailable remain independent from task and optional activity state',()=>{
 for(const code of ['runtime_task_state_unavailable','runtime_network_unavailable']){
  const state={connected:true,taskStateReady:false,runtime:{state:'ready'},taskStateRead:{state:'unavailable',code},pages:[{latest_request:{id:'original',phase:'processing'},paused:true}]},before=JSON.stringify(state);
  assert.equal(presentation(state).loading,false);assert.equal(presentation(state).detail,notice(code));assert.equal(JSON.stringify(state),before);
 }
 assert.equal(presentation({connected:true,taskStateReady:true,view:{session_activity:{unavailable:true}}}).blocked,false);
});
