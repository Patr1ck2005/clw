'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {createControlBodyReader,MAX_CHUNK}=require('../control-record-body.cjs');
test('large Chinese, formula and code record reads byte-exact through bounded receipts',async()=>{
  const {readControlBody}=createControlBodyReader();let reads=0;
  const record={task_key:'original',row:{text:'中文公式 $\\alpha^2$\n```js\nconst value=1;\n```\n'.repeat(10000)}};
  const expected=Buffer.from(JSON.stringify(record),'utf8'),parts=[];let offset=0,sha256;
  do{
    const result=await readControlBody({mode:'codex',task_key:'original',byte_offset:offset,
      ...(sha256?{expected_sha256:sha256}:{} )},async payload=>{
      reads++;assert.deepEqual(payload,{mode:'codex',task_key:'original'});return record;
    });
    assert.ok(Buffer.byteLength(JSON.stringify(result))<128*1024);
    assert.equal(result.byte_offset,offset);sha256=result.sha256;
    parts.push(Buffer.from(result.data,'base64'));offset=result.next_offset;
    if(result.complete)break;
  }while(true);
  assert.ok(expected.length>256*1024);assert.ok(parts.length>4);
  assert.deepEqual(Buffer.concat(parts),expected);
  assert.equal(sha256,createHash('sha256').update(expected).digest('hex'));
  assert.deepEqual(JSON.parse(Buffer.concat(parts).toString('utf8')),record);
  assert.equal(reads,1,'all chunks reuse the same immutable body snapshot');
});
test('source changes do not mix an original snapshot with a newer revision',async()=>{
  const {readControlBody}=createControlBodyReader();
  const first=await readControlBody({},async()=>({text:'original'}));
  const changed=await readControlBody({},async()=>({text:'changed'}));assert.notEqual(first.sha256,changed.sha256);
  const rest=await readControlBody({byte_offset:2,expected_sha256:first.sha256},async()=>{throw Error('must not reread');});
  assert.equal(rest.sha256,first.sha256);assert.equal(Buffer.from(rest.data,'base64').toString(),JSON.stringify({text:'original'}).slice(2));
  await assert.rejects(readControlBody({traceId:'foreign',byte_offset:2,expected_sha256:first.sha256},async()=>{}),
    e=>e.code==='record_chunk_snapshot_expired_restart_read'&&e.accepted===false);
});
test('cursor validation happens before the body read and byte zero works without revision',async()=>{
  const {readControlBody}=createControlBodyReader();
  let reads=0;const read=async()=>{reads++;return {text:'完整'};};
  for(const payload of [{byte_offset:1},{byte_offset:-1},{byte_limit:MAX_CHUNK+1},{expected_sha256:'foreign'}])
    await assert.rejects(readControlBody(payload,read));
  assert.equal(reads,0);
  const empty=await readControlBody({},async()=>({}));
  const end=await readControlBody({byte_offset:empty.byte_length,expected_sha256:empty.sha256},async()=>({}));
  assert.equal(end.complete,true);assert.equal(end.data,'');
  await assert.rejects(readControlBody({byte_offset:empty.byte_length+1,expected_sha256:empty.sha256},async()=>({})),/cursor_invalid/);
});

test('snapshot memory and count stay bounded and an expired read never changes revision',async()=>{
  let clock=0;const reader=createControlBodyReader({maxBytes:100,maxSnapshots:2,ttlMs:10,now:()=>clock});
  const first=await reader.readControlBody({traceId:'first'},async()=>({text:'a'.repeat(40)}));
  await reader.readControlBody({traceId:'second'},async()=>({text:'b'.repeat(40)}));
  assert.equal(reader.stats().snapshots,1);assert.ok(reader.stats().bytes<=100);
  await assert.rejects(reader.readControlBody({traceId:'first',byte_offset:2,expected_sha256:first.sha256},async()=>{}),/snapshot_expired/);
  await assert.rejects(reader.readControlBody({},async()=>({text:'x'.repeat(100)})),/snapshot_too_large/);
  clock=11;assert.deepEqual(reader.stats(),{snapshots:0,bytes:0});reader.dispose();
});

test('8 MiB body is read and serialized once for all 129 chunks',async()=>{
  const reader=createControlBodyReader();let reads=0,offset=0,digest,chunks=0;
  const read=async()=>{reads++;return {text:'x'.repeat(8*1024*1024)};};
  do{
    const result=await reader.readControlBody({task_key:'large',byte_offset:offset,...(digest?{expected_sha256:digest}:{})},read);
    offset=result.next_offset;digest=result.sha256;chunks++;if(result.complete)break;
  }while(true);
  assert.equal(chunks,129);assert.equal(reads,1);assert.equal(reader.stats().snapshots,1);
  reader.dispose();assert.equal(reader.stats().bytes,0);
});
