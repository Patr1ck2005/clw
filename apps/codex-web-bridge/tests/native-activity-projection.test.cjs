'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createNativeActivityProjection}=require('../electron-host.cjs');

function event(eventId,extra={}){
  return {version:1,eventId,atMs:1000+eventId,traceId:'aaaaaaaaaaaa',
    callId:`call_${String(eventId).padStart(32,'0')}`,phase:'queued',tool:'exec_command',...extra};
}
async function fixture(respond){
  const server=http.createServer((req,res)=>{
    if(req.headers.authorization!=='Bearer local-test-token'){res.writeHead(401).end();return;}
    respond(req,res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {endpoint:`http://127.0.0.1:${server.address().port}`,
    close:()=>new Promise(resolve=>server.close(resolve))};
}

test('native broker projection keeps exact metadata, cursor, bounded recent window and failure disclosure',async()=>{
  const seen=[];let fail=false;
  const local=await fixture((req,res)=>{
    seen.push(req.url);
    if(fail){res.writeHead(503).end('{}');return;}
    const recent=new URL(req.url,'http://127.0.0.1').searchParams.has('recent');
    const rows=recent?[event(3,{privatePrompt:'never forward'}),event(4)]:[event(5),event(6)];
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({events:rows,oldestEventId:1,latestEventId:6,windowTruncated:false}));
  });
  const projection=createNativeActivityProjection(local.endpoint,'local-test-token',{maxEvents:2});
  try{
    await projection.poll();
    const initial=projection.snapshot();
    assert.deepEqual(initial.events.map(row=>row.eventId),[3,4]);
    assert.equal(initial.events[0].privatePrompt,undefined);
    assert.equal(initial.windowTruncated,true);
    assert.equal(initial.backlog,true);
    assert.equal(initial.cursor,4);
    await projection.poll();
    const advanced=projection.snapshot();
    assert.deepEqual(advanced.events.map(row=>row.eventId),[5,6]);
    assert.equal(advanced.cursor,6);
    assert.equal(advanced.backlog,false);
    assert.ok(seen[0].includes('recent=1&limit=2'));
    assert.ok(seen[1].includes('afterEventId=4&limit=2'));
    fail=true;
    await projection.poll();
    const unavailable=projection.snapshot();
    assert.equal(unavailable.readFailed,true);
    assert.equal(unavailable.unavailable,false);
    assert.deepEqual(unavailable.events.map(row=>row.eventId),[5,6]);
  }finally{projection.stop();await local.close();}
});

test('native broker projection reports a lost cursor window and rejects malformed payloads',async()=>{
  let next={events:[event(8),event(9)],oldestEventId:8,latestEventId:9,windowTruncated:true};
  const local=await fixture((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(next));});
  const projection=createNativeActivityProjection(local.endpoint,'local-test-token',{maxEvents:3});
  try{
    await projection.poll();
    assert.equal(projection.snapshot().cursor,9);
    next={events:[event(12)],oldestEventId:12,latestEventId:12,windowTruncated:true};
    await projection.poll();
    assert.equal(projection.snapshot().windowTruncated,true);
    assert.equal(projection.snapshot().cursor,12);
    next={events:[event(13,{traceId:'secret path'})],oldestEventId:12,latestEventId:13,windowTruncated:false};
    await projection.poll();
    assert.equal(projection.snapshot().readFailed,true);
    assert.equal(projection.snapshot().cursor,12);
  }finally{projection.stop();await local.close();}
});

test('native broker projection exposes journal reset and only resumes from a new recent window',async()=>{
  let next={events:[event(3)],oldestEventId:1,latestEventId:3,windowTruncated:false};
  const seen=[];
  const local=await fixture((req,res)=>{seen.push(req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(next));});
  const projection=createNativeActivityProjection(local.endpoint,'local-test-token',{maxEvents:2});
  try{
    await projection.poll();
    assert.equal(projection.snapshot().cursor,3);
    next={events:[],oldestEventId:null,latestEventId:null,windowTruncated:false};
    await projection.poll();
    assert.equal(projection.snapshot().readFailed,true);
    assert.equal(projection.snapshot().windowTruncated,true);
    assert.equal(projection.snapshot().cursor,0);
    next={events:[event(1)],oldestEventId:1,latestEventId:1,windowTruncated:false};
    await projection.poll();
    assert.equal(projection.snapshot().readFailed,false);
    assert.deepEqual(projection.snapshot().events.map(row=>row.eventId),[1]);
    assert.ok(seen[2].includes('recent=1'));
  }finally{projection.stop();await local.close();}
});
