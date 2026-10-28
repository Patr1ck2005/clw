'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {openOperationStore}=require('../app-control-store.cjs');
const {executionReference}=require('../app-control.cjs');
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'clw-operation-store-')),profile=path.join(root,'profile');
  await fs.mkdir(profile);const file=path.join(profile,'operations.sqlite'),instanceId='isolated-store-instance';
  const store=await openOperationStore({file,root,profile,instanceId});
  t.after(async()=>{await store.close();assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  await store.migrate({rows:[]});return {root,profile,file,instanceId,store};
}
function completed(f,id,result){return {operation_id:id,app_instance_id:f.instanceId,action:'inspect-ui',
  request_hash:'a'.repeat(64),execution_reference:executionReference(f.instanceId,id),state:'completed',
  accepted_at:'2026-10-06T00:00:00.000Z',updated_at:'2026-10-06T00:00:01.000Z',result_observed:true,result};}
test('a burst of worker reads has a bounded queue and drains without losing future operation storage',async t=>{
  const f=await fixture(t),results=await Promise.allSettled(Array.from({length:300},()=>f.store.get('operation-missing-001')));
  assert.equal(results.filter(item=>item.status==='fulfilled').length,128);
  assert.equal(results.filter(item=>item.status==='rejected').length,172);
  for(const item of results)if(item.status==='rejected')assert.equal(item.reason.code,'app_control_storage_busy');
  const original=completed(f,'operation-after-burst-001',{request_id:'original-request'});
  await f.store.put(original);assert.deepEqual(await f.store.get(original.operation_id),original);
  assert.equal((await f.store.stats()).operations,1);
  await f.store.close();await assert.rejects(f.store.get(original.operation_id),{code:'app_control_storage_closed'});
});
test('identical large receipts retain distinct original keys but share one compressed result with checksum validation',async t=>{
  const f=await fixture(t),result={data:'large preserved result '.repeat(2000)};
  const first=completed(f,'operation-result-original-001',result),second=completed(f,'operation-result-original-002',result);
  await f.store.put(first);await f.store.put(second);
  assert.deepEqual(await f.store.get(first.operation_id),first);assert.deepEqual(await f.store.get(second.operation_id),second);
  const stats=await f.store.stats();assert.equal(stats.operations,2);assert.equal(stats.results,1);
  const db=new DatabaseSync(f.file);
  try{
    const blob=db.prepare('SELECT codec,length(data) AS bytes FROM results').get();
    assert.equal(blob.codec,'deflate');assert.ok(blob.bytes<Buffer.byteLength(JSON.stringify(result))/10);
    db.prepare('UPDATE results SET data=?').run(Buffer.from('corrupted receipt'));
  }finally{db.close();}
  await assert.rejects(f.store.get(first.operation_id));
  assert.equal((await f.store.stats()).operations,2);
});
