'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createPreviewSetup}=require('../preview-setup.cjs');
function fake(){const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.stdin=new EventEmitter();child.stdin.end=value=>{child.input=value;};return child;}
test('preview controller credentials use stdin, never argv or observable snapshot',async()=>{
  const child=fake();let args;
  const setup=createPreviewSetup('C:/CLW',{python:'C:/CLW/runtime/python.exe',spawnProcess:(exe,argv)=>{args=[exe,...argv];return child;}});
  const pending=setup.call('save',{credentials:{A:{api_key:'private-example'}}});
  assert(!args.join(' ').includes('private-example'));assert(child.input.includes('private-example'));
  assert(!JSON.stringify(setup.snapshot()).includes('private-example'));
  child.stdout.emit('data',Buffer.from(JSON.stringify({ok:true,result:{configured:true,manifest:{schema:1}}})));child.emit('close',0);
  assert.equal((await pending).configured,true);assert.equal(setup.snapshot().busy,null);
});
test('in-flight connect is not replayed by another click or status refresh',async()=>{
  const child=fake();let starts=0;const setup=createPreviewSetup('C:/CLW',{spawnProcess:()=>{starts++;return child;}});
  const pending=setup.call('connect');await assert.rejects(setup.call('connect'),/preview_operation_in_progress/);
  assert.equal((await setup.call('check')).status.stage,'connect');assert.equal(starts,1);
  child.stdout.emit('data',Buffer.from('{"ok":true,"result":{"state":"ready"}}'));child.emit('close',0);await pending;
});
test('unparseable accepted controller result remains unknown and raw output is not surfaced',async()=>{
  const child=fake();const setup=createPreviewSetup('C:/CLW',{spawnProcess:()=>child});const pending=setup.call('bootstrap');
  child.stdout.emit('data',Buffer.from('private native output'));child.emit('close',0);
  await assert.rejects(pending,/preview_controller_result_unknown/);assert(!JSON.stringify(setup.snapshot()).includes('private native output'));
  await assert.rejects(setup.call('bootstrap'),/preview_previous_operation_unknown/);
  assert.equal(setup.snapshot().completionUnknown,'bootstrap');
});
test('only original controller reconciliation clears an unknown mutation',async()=>{
  const children=[];const setup=createPreviewSetup('C:/CLW',{spawnProcess:()=>{const child=fake();children.push(child);return child;}});
  const first=setup.call('connect');children[0].stdout.emit('data',Buffer.from('not-json'));children[0].emit('close',0);await assert.rejects(first);
  const check=setup.call('check');children[1].stdout.emit('data',Buffer.from('{"ok":true,"result":{"healthy":true,"operation_reconciled":false}}'));children[1].emit('close',0);await check;
  await assert.rejects(setup.call('connect'),/preview_previous_operation_unknown/);
  const final=setup.call('check');children[2].stdout.emit('data',Buffer.from('{"ok":true,"result":{"operation_reconciled":true}}'));children[2].emit('close',0);await final;
  assert.equal(setup.snapshot().completionUnknown,null);assert.equal(children.length,3);
});

for(const code of ['preview_launch_completion_unknown','preview_native_completion_unknown','preview_enrollment_completion_unknown'])
  test('an explicit '+code+' receipt cannot start another controller mutation',async()=>{
    const child=fake();let starts=0;const setup=createPreviewSetup('C:/CLW',{spawnProcess:()=>{starts++;return child;}});
    const first=setup.call('connect');child.stdout.emit('data',Buffer.from(JSON.stringify({ok:false,code})));child.emit('close',1);
    await assert.rejects(first,new RegExp(code));assert.equal(setup.snapshot().completionUnknown,'connect');
    await assert.rejects(setup.call('connect'),/preview_previous_operation_unknown/);assert.equal(starts,1);
  });
