'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../maintenance-exit.cjs'),'utf8');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-fresh-read-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let mono=100,wall=1791308416761,calls=0;const module={exports:{}};
 const clockDate=class extends Date{static now(){return wall;}};
 vm.runInNewContext(source,{module,exports:module.exports,Date:clockDate,require:name=>name==='node:perf_hooks'?{performance:{now:()=>mono}}:require(name)});
 const exit=module.exports,child={pid:123},runtime={ready:true,child,store:'store',info:{store_id:'store',instance_id:'a'.repeat(32)}};
 const original={runtime,child,store:'store',instance:'a'.repeat(32),ledgerFingerprint:exit.ledgerFingerprint(root)};
 const proof={version:1,source:'original_host_maintenance_readonly',idle:true,permitId:'c'.repeat(32),instanceId:original.instance,hostPid:123,storeId:'store',root,observedAt:wall/1000,ledgerFingerprint:original.ledgerFingerprint,jobs:{clientId:'original',ownedActiveJobs:0,inventoryComplete:true}};
 const payload={store_id:original.store,ledger_fingerprint:original.ledgerFingerprint,page_bindings:[]};
 runtime.call=async(op,args)=>{calls++;assert.equal(op,'maintenance-readiness');assert.equal(args,payload);return proof;};
 const read=async()=>{const result=await exit.readProof(root,original,payload);original.freshRead=result.freshRead;assert.equal(result.proof,proof);return result;};
 return {root,exit,original,proof,payload,runtime,read,calls:()=>calls,setMono:value=>{mono=value;},setWall:value=>{wall=value;}};
}
for(const offset of [-1.093,-0.608,0,1,60000,-60000])test('same original fresh read ignores cross-language wall-clock offset '+offset+' ms',async t=>{
 const f=fixture(t);f.proof.observedAt+=offset/1000;await f.read();f.setMono(105);
 assert.doesNotThrow(()=>f.exit.assertProof(f.root,f.proof,f.original));assert.equal(f.calls(),1);
});
test('a current original fresh read survives large local wall-clock jumps',async t=>{
 const f=fixture(t);await f.read();f.setMono(110);
 for(const wall of [0,1791308416761+3600000,1791308416761-3600000]){f.setWall(wall);assert.doesNotThrow(()=>f.exit.assertProof(f.root,f.proof,f.original));}
 assert.equal(f.calls(),1);
});
for(const invalid of ['expired','negative','nan','infinite','before-reply'])test('fresh original proof refuses '+invalid+' monotonic age',async t=>{
 const f=fixture(t);if(invalid==='before-reply')f.runtime.call=async()=>{f.setMono(105);return f.proof;};await f.read();
 f.setMono(({expired:30100.001,negative:99,nan:NaN,infinite:Infinity,'before-reply':104})[invalid]);
 assert.throws(()=>f.exit.assertProof(f.root,f.proof,f.original),/original_receipt/);
});
test('30 second fresh read lifetime conservatively includes its request round trip',async t=>{
 const f=fixture(t);f.runtime.call=async()=>{f.setMono(30099);return f.proof;};await f.read();
 f.setMono(30100);assert.doesNotThrow(()=>f.exit.assertProof(f.root,f.proof,f.original));f.setMono(30101);assert.throws(()=>f.exit.assertProof(f.root,f.proof,f.original),/original_receipt/);
});
for(const stage of ['start','receive'])for(const value of [NaN,Infinity,-1])test('fresh read refuses invalid '+stage+' clock '+value,async t=>{
 const f=fixture(t);if(stage==='start')f.setMono(value);else f.runtime.call=async()=>{f.setMono(value);return f.proof;};
 await assert.rejects(f.read(),/original_receipt/);
});
for(const change of ['proof-copy','binding-copy','invented-binding','runtime','child','store','instance','runtime-child','runtime-store','runtime-instance','root'])test('a fresh read cannot certify a different '+change,async t=>{
 const f=fixture(t);await f.read();let proof=f.proof,root=f.root;
 if(change==='proof-copy')proof={...proof};if(change==='binding-copy')f.original.freshRead={...f.original.freshRead};if(change==='invented-binding')f.original.freshRead={startedAt:100,receivedAt:100};
 if(change==='runtime')f.original.runtime={...f.runtime};if(change==='child')f.original.child={pid:123};if(change==='store')f.original.store='other';if(change==='instance')f.original.instance='b'.repeat(32);
 if(change==='runtime-child')f.runtime.child={pid:123};if(change==='runtime-store')f.runtime.store='other';if(change==='runtime-instance')f.runtime.info.instance_id='b'.repeat(32);if(change==='root')root=f.root+'-other';
 assert.throws(()=>f.exit.assertProof(root,proof,f.original),/original_receipt/);
});
test('owner changes during the original read cannot mint its fresh binding',async t=>{
 for(const changed of ['child','store','instance']){const f=fixture(t);f.runtime.call=async()=>{if(changed==='child')f.runtime.child={pid:123};if(changed==='store')f.runtime.store='other';if(changed==='instance')f.runtime.info.instance_id='b'.repeat(32);return f.proof;};await assert.rejects(f.read(),/execution_unresolved/);}
});
test('fresh proof still requires finite diagnostic time and every original owner, Jobs and ledger field',async t=>{
 for(const field of ['observedAt','hostPid','permitId','storeId','instanceId','root','source','idle','ledgerFingerprint','jobs']){const f=fixture(t);await f.read();if(field==='observedAt')f.proof[field]=NaN;else if(field==='hostPid')f.proof[field]=456;else if(field==='idle')f.proof[field]=false;else if(field==='jobs')f.proof.jobs={...f.proof.jobs,ownedActiveJobs:1};else f.proof[field]='different';assert.throws(()=>f.exit.assertProof(f.root,f.proof,f.original),/original_receipt|store_changed/);}
});
test('allowElapsed retains only the existing final-close age exception for this exact read',async t=>{
 const f=fixture(t);await f.read();f.setMono(90100);assert.doesNotThrow(()=>f.exit.assertProof(f.root,f.proof,{...f.original,allowElapsed:true}));
 assert.throws(()=>f.exit.assertProof(f.root,{...f.proof},{...f.original,allowElapsed:true}),/original_receipt/);
 f.setMono(99);assert.throws(()=>f.exit.assertProof(f.root,f.proof,{...f.original,allowElapsed:true}),/original_receipt/);
});
test('legacy proof without a fresh read binding keeps its exact strict wall-clock checks',t=>{
 const f=fixture(t);assert.doesNotThrow(()=>f.exit.assertProof(f.root,f.proof,f.original));
 for(const delta of [0.001,31000]){f.proof.observedAt=1791308416761/1000+(delta===31000?-delta:delta)/1000;assert.throws(()=>f.exit.assertProof(f.root,f.proof,f.original),/original_receipt/);}
 f.proof.observedAt=1791308416761/1000-60;assert.doesNotThrow(()=>f.exit.assertProof(f.root,f.proof,{...f.original,allowElapsed:true}));
});
