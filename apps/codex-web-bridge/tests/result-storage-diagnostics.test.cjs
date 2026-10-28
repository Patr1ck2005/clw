'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('node:stream');
const {createResultTransport}=require('../result-transport.cjs');
const CALL='11111111-2222-4333-8444-555555555555';
const context={id:1,principal:'fixture',callId:CALL,method:'tools/call',tool:'read_files',contentType:'application/json'};

for(const phase of ['buffer_store','stream_store'])test(`${phase} records the typed failure for the original call once`,async()=>{
 const events=[];let attempts=0;
 const fail=async()=>{attempts++;throw Object.assign(Error('private disk path and payload'),{code:'RESULT_STORE_FULL'});};
 const transport=createResultTransport({store:{put:fail,putStream:fail},inlineBytes:1024,onEvent:row=>events.push(row)});
 let result;
 if(phase==='buffer_store')result=await transport.protect(Buffer.alloc(2048,97),context);
 else {const reply=Readable.from([Buffer.alloc(2048,97),Buffer.alloc(4096,98)]);reply.headers={};reply.statusCode=200;
   result=await transport.relay(reply,null,context);assert.equal(reply.readableEnded,true);}
 assert.equal(attempts,1);assert.equal(result.attention,true);
 const failures=events.filter(row=>row.event==='mcp_result_delivery_attention');assert.equal(failures.length,1);
 assert.equal(failures[0].storeCode,'RESULT_STORE_FULL');assert.equal(failures[0].callId,CALL);
 assert.equal(failures[0].phase,phase);assert.ok(failures[0].durationMs>=0);
 assert.equal(JSON.stringify(events).includes('private'),false);
});

test('optional capture records a bounded code without changing the delivered response',async()=>{
 const events=[],raw=Buffer.from('unchanged result');
 const transport=createResultTransport({store:{put:async()=>{throw Object.assign(Error('private'),{code:'RESULT_STORE_BUSY'});}},onEvent:row=>events.push(row)});
 assert.deepEqual((await transport.protect(raw,context)).raw,raw);assert.equal(await transport.flushObserved(),true);
 assert.equal(events[0].storeCode,'RESULT_STORE_BUSY');assert.equal(events[0].phase,'observer_store');
 assert.equal(events[0].callId,CALL);assert.equal(JSON.stringify(events).includes('private'),false);
});

test('unexpected error codes are not copied into metadata',async()=>{
 const events=[];
 const transport=createResultTransport({store:{put:async()=>{throw {code:'RESULT_PRIVATE_PAYLOAD'};}},inlineBytes:1024,onEvent:row=>events.push(row)});
 await transport.protect(Buffer.alloc(2048),context);
 assert.equal(events[0].storeCode,'RESULT_STORE_UNAVAILABLE');
 assert.equal(JSON.stringify(events).includes('RESULT_PRIVATE_PAYLOAD'),false);
});
