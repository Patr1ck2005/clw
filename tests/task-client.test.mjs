import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskClient} from '../apps/control-center/task-client.mjs';
const memory=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};};
const reply=(data,status=200)=>({ok:status<300,status,text:async()=>JSON.stringify({success:status<300,...data})});
function setup(handler,storage=memory()){
 const calls=[];let n=0;const fetcher=async(url,init={})=>{calls.push({url,init});if(url.includes('/info'))return reply({store_id:'store-one',intent:'local-csrf'});return handler(url,init,calls);};
 return {client:createTaskClient({fetcher,storage,newId:()=>`req_${String(++n).padStart(20,'0')}`}),calls,storage};
}
const responseFor=init=>{const body=JSON.parse(init.body);return {request_id:body.request_id,task_id:'t',store_id:'store-one',version:1,task:{id:'t',version:1}};};
test('exactly one POST per action with explicit expected version',async()=>{const h=setup((_,i)=>reply(responseFor(i)));await h.client.command('publish',{id:'t',version:3},'M',{});const p=h.calls.filter(c=>c.init.method==='POST');assert.equal(p.length,1);assert.equal(JSON.parse(p[0].init.body).expected_version,3);assert.equal(p[0].init.credentials,'omit');assert.equal(h.client.pending(),null);});
test('transport failure retains complete original request without automatic POST retry',async()=>{const h=setup(()=>{throw Error('lost')});await assert.rejects(h.client.command('create',null,'M',{contract:{goal:'完整目标'}}));assert.equal(h.calls.filter(c=>c.init.method==='POST').length,1);assert.equal(h.client.pending().command.data.contract.goal,'完整目标');});
test('unresolved request prevents a different action',async()=>{const h=setup(()=>{throw Error('lost')});await assert.rejects(h.client.command('create',null,'M',{}));await assert.rejects(h.client.command('create',null,'M',{}),/核对/);assert.equal(h.calls.length,2);});
test('receipt recovery clears pending and sends no second POST',async()=>{let result;const h=setup((u,i)=>{if(i.method==='POST'){result=responseFor(i);throw Error('lost after commit');}return reply({found:true,receipt:result,store_id:'store-one'});});await assert.rejects(h.client.command('create',null,'M',{}));assert.equal((await h.client.reconcile()).task_id,'t');assert.equal(h.client.pending(),null);assert.equal(h.calls.filter(c=>c.init.method==='POST').length,1);});
test('not-found receipt keeps request for explicit same-id retry',async()=>{let count=0,original;const h=setup((u,i)=>{if(i.method==='POST'){count++;if(count===1){original=i.body;throw Error('lost');}assert.equal(i.body,original);return reply(responseFor(i));}return reply({found:false,store_id:'store-one'});});await assert.rejects(h.client.command('create',null,'M',{}));assert.equal(await h.client.reconcile(),null);await h.client.retrySame();assert.equal(count,2);});
test('definite version conflict preserves caller data and clears replay lock',async()=>{const h=setup(()=>reply({message:'版本冲突',error_code:'version_conflict'},409));const data={note:'保留草稿'};await assert.rejects(h.client.command('pause',{id:'t',version:1},'M',data),/版本冲突/);assert.equal(data.note,'保留草稿');assert.equal(h.client.pending(),null);});
test('storage failure occurs before POST',async()=>{const storage=memory();storage.setItem=()=>{throw Error('no storage');};const h=setup(()=>{throw Error('should not run')},storage);await assert.rejects(h.client.command('create',null,'M',{}));assert.equal(h.calls.filter(c=>c.init.method==='POST').length,0);});
test('reload can reconcile same durable request from session storage',async()=>{const storage=memory();let result;const a=setup((_,i)=>{result=responseFor(i);throw Error('lost')},storage);await assert.rejects(a.client.command('create',null,'M',{}));const b=setup(()=>reply({found:true,store_id:'store-one',receipt:result}),storage);await b.client.init();assert.equal((await b.client.reconcile()).task_id,'t');});
test('different store cannot replay old request',async()=>{const h=setup(()=>{throw Error('lost')});await assert.rejects(h.client.command('create',null,'M',{}));const other=createTaskClient({storage:h.storage,fetcher:async()=>reply({store_id:'other',intent:'x'})});await assert.rejects(other.retrySame(),/另一任务库/);});
test('server error retains unknown outcome instead of claiming failure without side effect',async()=>{const h=setup(()=>reply({message:'storage error'},503));await assert.rejects(h.client.command('create',null,'M',{}),/结果未知/);assert.ok(h.client.pending());});
test('mismatched receipt cannot confirm a different action',async()=>{const h=setup((_,i)=>reply({...responseFor(i),request_id:'other'}));await assert.rejects(h.client.command('create',null,'M',{}));assert.ok(h.client.pending());});
test('GET receipt identity mismatch never clears pending',async()=>{const h=setup((u,i)=>{if(i.method==='POST')throw Error('lost');return reply({found:true,store_id:'store-one',receipt:{request_id:'other-request',store_id:'store-one',task_id:'other'}});});await assert.rejects(h.client.command('create',null,'M',{}));await assert.rejects(h.client.reconcile());assert.ok(h.client.pending());});
test('403 after uncertain retry preserves the original request for reconciliation',async()=>{let n=0;const h=setup(()=>{if(++n===1)throw Error('lost');return reply({error_code:'intent'},403);});await assert.rejects(h.client.command('create',null,'M',{}));const id=h.client.pending().command.request_id;await assert.rejects(h.client.retrySame());assert.equal(h.client.pending().command.request_id,id);});
test('receipt reconciliation serializes all actions until its exact result is known',async()=>{
 let release,result;const h=setup((url,init)=>{
  if(init.method==='POST'){result=responseFor(init);throw Error('lost after commit');}
  return new Promise(resolve=>{release=()=>resolve(reply({found:true,receipt:result,store_id:'store-one'}));});
 });
 await assert.rejects(h.client.command('create',null,'M',{}));
 const checking=h.client.reconcile();await new Promise(r=>setImmediate(r));
 try{
  assert.equal(h.client.busy(),true,'A pending receipt GET must exclude a concurrent retry or second reconciliation');
  await assert.rejects(h.client.reconcile(),/等待/);
  await assert.rejects(h.client.retrySame(),/正在处理/);
  assert.equal(h.calls.filter(c=>c.url.includes('/receipt')).length,1);
 }finally{release();await checking;}
 assert.equal(h.client.busy(),false);assert.equal(h.client.pending(),null);
 assert.equal(h.calls.filter(c=>c.init.method==='POST').length,1);
});
test('receipt read failure releases the lock but preserves the same pending request',async()=>{
 let result,failRead=true;const h=setup((url,init)=>{
  if(init.method==='POST'){result=responseFor(init);throw Error('lost after commit');}
  if(failRead)throw Error('receipt temporarily unreachable');
  return reply({found:true,receipt:result,store_id:'store-one'});
 });
 await assert.rejects(h.client.command('create',null,'M',{}));const id=h.client.pending().command.request_id;
 await assert.rejects(h.client.reconcile(),/temporarily/);assert.equal(h.client.busy(),false);
 assert.equal(h.client.pending().command.request_id,id);failRead=false;
 assert.equal((await h.client.reconcile()).request_id,id);assert.equal(h.client.pending(),null);
});
test('concurrent clicks cannot dispatch twice',async()=>{let release;const h=setup((_,i)=>new Promise(r=>{release=()=>r(reply(responseFor(i)))}));const first=h.client.command('create',null,'M',{});await new Promise(r=>setImmediate(r));await assert.rejects(h.client.command('create',null,'M',{}),/正在处理/);release();await first;assert.equal(h.calls.filter(c=>c.init.method==='POST').length,1);});
