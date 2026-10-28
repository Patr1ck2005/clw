'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {captureTaskIdentity}=require('../task-action-identity.cjs');
const {WebDriver}=require('../web-driver.cjs');
function fixture(){
  const pages=new Map(['A','B'].map(id=>[id,{id,account:'A',documentGeneration:1,view:{webContents:{}}}]));
  const rows=new Map(['A','B'].map(id=>[id,{page_id:id,thread_id:'thread-'+id,account:'A',url:'https://chatgpt.com/c/'+id,
    latest_request:{id:'accepted-'+id,phase:'processing'}}]));let selected='A',generation=1;
  const resolvePage=id=>{if(!pages.has(id)||pages.get(id).closed)throw Error('missing');return pages.get(id);};
  const capture=(payload,documentAware=false)=>captureTaskIdentity({payload,resolvePage,recordFor:id=>rows.get(id),connectionGeneration:()=>generation,documentAware});
  return {pages,rows,capture,select:id=>{selected=id;},selected:()=>selected,reconnect:()=>{generation++;}};
}
test('explicit invalid, missing, and undefined task IDs never fall back to the selected page',()=>{
  const f=fixture();for(const payload of [{},{id:undefined},{id:null},{id:''},{id:'missing'}])assert.throws(()=>f.capture(payload));
  f.select('B');assert.equal(f.capture({id:'A'}).page,f.pages.get('A'));
});
test('switching the sidebar while an action waits never changes its original task owner',async()=>{
  const f=fixture(),action=f.capture({id:'A'});let release;const wait=new Promise(resolve=>{release=resolve;}),effects=[];
  const result=action.run(async page=>{await wait;effects.push(page.id);return {page_id:page.id,accepted:true};});
  f.select('B');release();assert.deepEqual(await result,{page_id:'A',accepted:true});assert.deepEqual(effects,['A']);assert.equal(f.selected(),'B');
});
test('new request, thread, account, replacement page, close and reconnect all reject a stale preflight',()=>{
  for(const change of [f=>f.rows.get('A').latest_request.id='new-request',f=>f.rows.get('A').thread_id='new-thread',
    f=>f.rows.get('A').account='B',f=>f.pages.set('A',{...f.pages.get('A')}),f=>f.pages.get('A').closed=true,f=>f.reconnect()]){
    const f=fixture(),action=f.capture({id:'A'});change(f);assert.throws(()=>action.assertCurrent(),/managed_task_identity_changed/);
  }
});
test('a late accepted response is fenced without executing twice or rolling back its original result',async()=>{
  const f=fixture(),action=f.capture({id:'A'});let effects=0,release;const wait=new Promise(resolve=>{release=resolve;});
  const pending=action.run(async page=>{effects++;await wait;assert.equal(page.id,'A');return {accepted:true};});
  f.reconnect();release();await assert.rejects(pending,/managed_task_response_stale/);assert.equal(effects,1);
});

test('only an acknowledged next request can advance the same frozen task identity',()=>{
 const next='12345678-1234-4234-8234-123456789abc',f=fixture(),action=f.capture({id:'A'});
 f.rows.get('A').latest_request.id=next;
 assert.throws(()=>action.assertCurrent({response:true}),/managed_task_response_stale/);
 assert.doesNotThrow(()=>action.assertCurrent({response:true,acceptedRequestId:next}));
 assert.throws(()=>action.assertCurrent({response:true,acceptedRequestId:'a different accepted request'}),/managed_task_response_stale/);
 for(const change of [g=>g.rows.get('A').thread_id='foreign-thread',g=>g.rows.get('A').account='B',g=>g.reconnect()]){
  const g=fixture(),frozen=g.capture({id:'A'});g.rows.get('A').latest_request.id=next;change(g);
  assert.throws(()=>frozen.assertCurrent({response:true,acceptedRequestId:next}),/managed_task_response_stale/);
 }
});
test('request CAS compares the active request and connection generation, not an old completed request',()=>{
  const f=fixture();assert.throws(()=>f.capture({id:'A',expected_request_id:'accepted-B'}),/managed_resume_request_changed/);
  assert.throws(()=>f.capture({id:'A',expected_connection_generation:0}),/managed_task_identity_changed/);
  f.rows.get('A').latest_request.phase='completed';assert.doesNotThrow(()=>f.capture({id:'A',expected_request_id:null}));
  assert.throws(()=>f.capture({id:'A',expected_request_id:'accepted-A'}),/managed_resume_request_changed/);
});
test('known hydration may pin its new document once; a later navigation cannot replace its public observation',()=>{
  const f=fixture(),action=f.capture({id:'A'},true);f.pages.get('A').documentGeneration=2;action.pinDocument();
  assert.doesNotThrow(()=>action.assertCurrent());f.pages.get('A').documentGeneration=3;
  assert.throws(()=>action.assertCurrent(),/managed_task_identity_changed/);
});
test('a legitimate initial enrollment may advance its previously absent ledger, preserving the same account and owner',async()=>{
  const f=fixture();f.rows.delete('A');const action=f.capture({id:'A'});
  const result=await action.run(async page=>{f.rows.set('A',{thread_id:'original-new-thread',account:'A',latest_request:{id:'reserved-original',phase:'queued'}});return {page_id:page.id,accepted:true};},{allowRecordAdvance:true});
  assert.equal(result.page_id,'A');assert.equal(f.rows.get('A').latest_request.id,'reserved-original');
});
test('a navigation during model inspection reads no foreign menu and releases only the original page',async()=>{
  const f=fixture(),action=f.capture({id:'A'},true);action.pinDocument();const calls=[];
  const runtime=new EventEmitter(),driver=new WebDriver({runtime,pool:{pages:f.pages},onNotice(){},
    dom:async(_wc,operation)=>{calls.push(operation);if(operation==='open-model')f.pages.get('A').documentGeneration++;else assert.fail('foreign model observed');},
    input:{key:async(_wc,key)=>calls.push(key)}});
  await assert.rejects(action.run((page,assertCurrent)=>driver.inspect(page,assertCurrent)),/managed_task_identity_changed/);
  assert.deepEqual(calls,['open-model','Escape']);
});
test('intake changes are fenced after an asynchronous public read before the first mutation',async()=>{
  const f=fixture(),action=f.capture({id:'A'},true);action.pinDocument();const runtime=new EventEmitter();let mutations=0;
  runtime.call=async()=>{mutations++;};
  const driver=new WebDriver({runtime,pool:{pages:f.pages},onNotice(){},dom:async()=>{f.reconnect();return {generating:false};}});
  await assert.rejects(action.run((page,assertCurrent)=>driver.configureIntake(page,{access:'read',write_paths:[]},assertCurrent)),/managed_task_identity_changed/);
  assert.equal(mutations,0);assert.equal(driver.busy.has('A'),false);
});
