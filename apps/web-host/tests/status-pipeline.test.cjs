'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {StatusFileWriter,writePrivateStatusAtomic}=require('../status-files.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};

test('busy asynchronous snapshots coalesce only derived state and preserve the latest complete file',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-status-pipeline-')),gate=deferred(),writes=[];let first=true;
  const writer=new StatusFileWriter(folder,{write:async(file,text)=>{writes.push(JSON.parse(text));if(first){first=false;await gate.promise;}await writePrivateStatusAtomic(file,text);}});
  try{
    writer.request({'task-status.json':{at:1,current:{request:{id:'accepted-original',phase:'processing'}}}});
    for(let n=2;n<=1000;n++)writer.request({'task-status.json':{at:n,current:{request:{id:'accepted-original',phase:n===1000?'completed':'processing'}},pending_notes:n}});
    assert.equal(writes.length,1);gate.resolve();await writer.idle();
    assert.equal(writes.length,2);assert.equal(writer.metrics.coalesced,998);
    const saved=JSON.parse(fs.readFileSync(path.join(folder,'task-status.json'),'utf8'));
    assert.equal(saved.at,1000);assert.equal(saved.current.request.id,'accepted-original');assert.equal(saved.current.request.phase,'completed');assert.equal(saved.pending_notes,1000);
    assert.deepEqual(fs.readdirSync(folder),['task-status.json']);
  }finally{gate.resolve();await writer.close();fs.rmSync(folder,{recursive:true,force:true});}
});

test('unchanged sampling does not rewrite snapshots, while health heartbeat and actual connection changes stay fresh',async()=>{
  let now=0;const writes=[];
  const writer=new StatusFileWriter('isolated',{now:()=>now,write:async(file,text)=>writes.push({file,value:JSON.parse(text)})});
  const request=()=>writer.request({'health.json':{at:now,connected:true},'task-status.json':{at:now,pages:[{id:'A',observation:{at:now,generating:true,attemptId:'original'}}]}});
  request();await writer.idle();assert.equal(writes.length,2);
  now=2500;request();await writer.idle();assert.equal(writes.length,2);
  now=5000;request();await writer.idle();assert.equal(writes.length,3);assert.equal(writes[2].value.at,5000);assert.ok(writes[2].file.endsWith('health.json'));
  now=10000;request();await writer.idle();assert.equal(writes.length,5);
  now++;writer.request({'health.json':{at:now,connected:false}});await writer.idle();assert.equal(writes.at(-1).value.connected,false);
  await writer.close();request();assert.equal(writes.length,6);
});

test('a locked status file preserves the old valid snapshot while other files advance, then recovers without executing work',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-status-fault-'));let locked=false;const notices=[];
  const writer=new StatusFileWriter(folder,{onFailures:value=>notices.push(value),write:async(file,text)=>{
    if(locked&&file.endsWith('health.json'))throw Object.assign(Error('locked'),{code:'EACCES'});await writePrivateStatusAtomic(file,text);
  }});
  try{
    writer.request({'health.json':{at:1,connected:true},'task-status.json':{at:1,current:{request:{id:'original'}}}});await writer.idle();
    locked=true;writer.request({'health.json':{at:2,connected:false},'task-status.json':{at:2,current:{request:{id:'original',phase:'completed'}}}});await writer.idle();
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'health.json'))).at,1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'task-status.json'))).current.request.phase,'completed');
    assert.deepEqual(notices,[[{file:'health.json',code:'EACCES'}]]);
    locked=false;writer.request({'health.json':{at:3,connected:false}});await writer.idle();
    assert.deepEqual(notices.at(-1),[]);assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'health.json'))).at,3);
    assert.deepEqual(fs.readdirSync(folder).sort(),['health.json','task-status.json']);
  }finally{await writer.close();fs.rmSync(folder,{recursive:true,force:true});}
});

test('Windows rename retry yields to the event loop and retains atomic old/new readback',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-status-rename-')),file=path.join(folder,'health.json');
  try{
    await writePrivateStatusAtomic(file,'{"at":1}');let attempts=0,eventLoopAdvanced=false;
    const pending=writePrivateStatusAtomic(file,'{"at":2}',{platform:'win32',rename:async(from,to)=>{
      if(++attempts===1){assert.equal(JSON.parse(fs.readFileSync(file)).at,1);throw Object.assign(Error('reader locked'),{code:'EBUSY'});}
      return fs.promises.rename(from,to);
    }});
    setImmediate(()=>{eventLoopAdvanced=true;});await pending;
    assert.equal(eventLoopAdvanced,true);assert.equal(attempts,2);assert.equal(JSON.parse(fs.readFileSync(file)).at,2);
    assert.deepEqual(fs.readdirSync(folder),['health.json']);
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test('exhausted rename retries leave complete old data and clean temporary files',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-status-exhausted-')),file=path.join(folder,'health.json'),delays=[];
  try{
    await writePrivateStatusAtomic(file,'{"at":1}');
    await assert.rejects(writePrivateStatusAtomic(file,'{"at":2}',{platform:'win32',sleep:async ms=>delays.push(ms),
      rename:async()=>{throw Object.assign(Error('permanent lock'),{code:'EPERM'});}}),/permanent lock/);
    assert.deepEqual(delays,[25,50,100,150,250,350,500]);assert.equal(JSON.parse(fs.readFileSync(file)).at,1);
    assert.deepEqual(fs.readdirSync(folder),['health.json']);
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test('snapshot names cannot escape their designated profile and asynchronous write errors stay contained',async()=>{
  const failures=[],writer=new StatusFileWriter('isolated',{write:async()=>{throw Error('disk unavailable');},onFailures:value=>failures.push(value)});
  assert.throws(()=>writer.request({'../workspace.json':{}}),/status_snapshot_name_invalid/);
  writer.request({'health.json':{at:1}});await writer.idle();assert.deepEqual(failures,[[{file:'health.json',code:'snapshot_write_failed'}]]);
  assert.equal(writer.metrics.failed,1);await writer.close();
});

test('returning to a previously committed state while a different write is in flight still commits the final state',async()=>{
  const gate=deferred(),writes=[];let hold=false;
  const writer=new StatusFileWriter('isolated',{write:async(_file,text)=>{const value=JSON.parse(text);if(hold&&value.connected===false)await gate.promise;writes.push(value);}});
  writer.request({'health.json':{at:1,connected:true}});await writer.idle();hold=true;
  writer.request({'health.json':{at:2,connected:false}});await tick();
  writer.request({'health.json':{at:3,connected:true}});gate.resolve();await writer.idle();
  assert.deepEqual(writes.map(value=>value.connected),[true,false,true]);assert.equal(writes.at(-1).at,3);await writer.close();
});
