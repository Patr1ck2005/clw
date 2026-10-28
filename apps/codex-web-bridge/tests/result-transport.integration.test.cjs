'use strict';

// Exercise the real authenticated HTTP union and its durable result store. All
// upstream work is isolated fixture work; no production account or Job is used.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const {startUnion}=require('../mcp-union.cjs');
const {INLINE_BYTES}=require('../result-transport.cjs');
const {createCallDetailsReader}=require('../mcp-activity-details.cjs');
const {createActivityProjection}=require('../mcp-activity.cjs');
const {journal}=require('../union-journal.cjs');

const MiB=1024*1024,AUTH='Bearer isolated-result-integration';
const META={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}};
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label){
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if(await predicate())return;await pause(10);}
  assert.fail(`Timed out waiting for ${label}`);
}
const largeResult=(id,text='数式 \\[x^2\\] / '.repeat(700000))=>Buffer.from(JSON.stringify({jsonrpc:'2.0',id,result:{
  isError:false,content:[{type:'text',text}],structuredContent:{success:true,original_job:'isolated-original-job'}
}}));

test('actual HTTP call details survive restart and read original parameters and full outcome locally',async t=>{
  const f=await fixture(t,{observeCallDetails:true}),args={session_id:'isolated-original-session',path:'fixture.md'};
  const original=await f.post('tools/call',{name:'read_files',arguments:args});
  await until(()=>f.events.filter(row=>row.event==='mcp_call_details'&&row.resultId).length===2,'original detail references');
  const started=f.events.find(row=>row.event==='mcp_call_started'),write=journal(path.join(f.root,'mcp-activity.jsonl'));
  for(const row of f.events)write(row);
  const readActivity=createActivityProjection(f.root,{resultHome:f.resultHome});
  assert.equal(readActivity().events.find(row=>row.callId===started.callId).details.response.available,true);
  const reader=createCallDetailsReader({resultHome:f.resultHome,authorizationFile:f.authorizationFile,readActivity});
  await f.restart();
  const parameters=await reader({callId:started.callId,part:'arguments'});
  assert.deepEqual(JSON.parse(parameters.data),args);
  const result=await reader({callId:started.callId,part:'response'});
  assert.equal(result.data,original.raw.toString('utf8'));
  assert.equal(f.originals().length,1);
  assert.equal(f.received.length,1,'local pages do not send another MCP or model request');
});

test('HTTP large-call detail projection reuses delivery bytes and viewer reads leave coverage untouched',async t=>{
  const f=await fixture(t,{observeCallDetails:true});
  f.setHandler((message,res)=>{res.end(largeResult(message.id,'v'.repeat(7*MiB)));return true;});
  const response=await f.post('tools/call',{name:'read_files',arguments:{session_id:'isolated-large-session'}});
  const {value}=preserved(response),started=f.events.find(row=>row.event==='mcp_call_started');
  await until(()=>f.events.some(row=>row.event==='mcp_call_details'&&row.part==='arguments'&&row.resultId),'argument reference');
  const detail=f.events.find(row=>row.event==='mcp_call_details'&&row.part==='response');
  assert.equal(detail.resultId,value.delivery.result_id);
  const reader=createCallDetailsReader({resultHome:f.resultHome,authorizationFile:f.authorizationFile,readActivity:()=>({events:f.events})});
  let offset=0,bytes=0;
  while(true){const page=await reader({callId:started.callId,part:'response',offset,max_bytes:512*1024});
    assert.equal(page.available,true);offset=page.next_offset;bytes+=page.bytes_returned;if(page.eof)break;}
  assert.equal(bytes,value.delivery.raw_bytes);
  const meta=fs.readdirSync(f.resultHome).filter(name=>name.startsWith('result_'))
    .map(name=>JSON.parse(fs.readFileSync(path.join(f.resultHome,name,'meta.json'),'utf8')));
  assert.equal(meta.filter(row=>row.activity_part==='response'&&row.call_id===started.callId).length,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.resultHome,value.delivery.result_id,'read.json'),'utf8')).fully_read,false);
  assert.equal(f.originals().length,1);
});

test('HTTP observation storage failure leaves the original inline tool result and one execution intact',async t=>{
  const f=await fixture(t,{observeCallDetails:true});
  fs.writeFileSync(f.resultHome,'isolated activity storage unavailable');
  const response=await f.post('tools/call',{name:'read_files',arguments:{session_id:'isolated-ordinary-session'}});
  assert.equal(response.status,200);assert.equal(response.json().result.content[0].text,'unchanged fixture reply');
  await until(()=>f.events.filter(row=>row.event==='mcp_call_details'&&row.code==='call_details_storage_unavailable').length===2,'optional capture failure');
  assert.equal(f.originals().length,1);
  assert.equal(f.events.filter(row=>row.event==='union_error').length,0);
});

test('large manifest above the old 16MiB parser cap is preserved without replay',async t=>{
  const f=await fixture(t);let original;
  f.setHandler((message,res)=>{
    if(message.params?.name!=='tool_manifest')return false;
    original=largeResult(message.id,'m'.repeat(18*MiB));res.end(original);return true;
  });
  const {value}=preserved(await f.post('tools/call',{name:'tool_manifest',arguments:{category:'file'}}));
  assert.equal(value.delivery.complete,true);
  assert.deepEqual(await readAll(f,value.delivery),original);
  assert.equal(f.originals().length,1);
});

test('real HTTP oversized tools catalog stays ListToolsResult and preserves all contracts',async t=>{
  const f=await fixture(t),contracts=Array.from({length:13},(_,index)=>({name:'fixture_'+index,
    description:'合同'.repeat(170000),inputSchema:{type:'object',properties:{index:{const:index}}}}));
  f.setHandler((message,res)=>{
    if(message.method!=='tools/list')return false;
    res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{tools:contracts,_meta:{catalog:'original'}}}));return true;
  });
  const all=[];let cursor,pages=0;
  do{
    const response=await f.post('tools/list',cursor?{cursor}:{}),rpc=response.json();
    assert.ok(response.raw.length<=INLINE_BYTES);assert.equal(rpc.error,undefined);
    assert.ok(Array.isArray(rpc.result.tools));assert.equal(rpc.result.content,undefined);
    assert.deepEqual(rpc.result._meta,{catalog:'original'});
    all.push(...rpc.result.tools);cursor=rpc.result.nextCursor;pages++;
  }while(cursor);
  assert.ok(pages>=3);
  assert.deepEqual(all.slice(0,contracts.length),contracts);
  assert.deepEqual(all.slice(contracts.length).map(tool=>tool.name),['codex_exec','codex_view_image','clw_read_result']);
  assert.equal(f.received.filter(row=>row.message.method==='tools/list').length,1);
});

async function fixture(t,{observeCallDetails=false,resultStore}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-results-integration-'));
  const authorizationFile=path.join(root,'authorization'),resultHome=path.join(root,'results');
  fs.writeFileSync(authorizationFile,AUTH);
  const received=[],events=[],nativeCalls=[];
  let denied=false,handler,nativeHandler,union,sequence=0;
  const original=http.createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const message=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({message,headers:req.headers});
      res.setHeader('content-type','application/json');
      res.setHeader('mcp-session-id','fixture-session');
      if(denied){res.writeHead(403).end(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'fixture authority revoked'}}));return;}
      if(req.headers.authorization!==fs.readFileSync(authorizationFile,'utf8').trim()){
        res.writeHead(401).end();return;
      }
      if(req.headers['mcp-method']!==message.method||
        message.method==='server/discover'&&req.headers['mcp-name']){
        res.writeHead(400).end(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32020,message:'fixture header mismatch'}}));return;
      }
      if(message.method==='server/discover'){
        res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{serverInfo:{name:'fixture-original',version:'1'}}}));return;
      }
      if(handler&&await handler(message,res,req))return;
      res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:message.method==='tools/list'?{
        tools:[{name:'read_files',inputSchema:{type:'object'}},{name:'call_runtime_tool',inputSchema:{type:'object'}}]
      }:{content:[{type:'text',text:'unchanged fixture reply'}],isError:false}}));
    }catch(error){res.destroy(error);}
  });
  await new Promise(resolve=>original.listen(0,'127.0.0.1',resolve));
  const native={tools:[{name:'codex_exec',inputSchema:{type:'object'}},{name:'codex_view_image',inputSchema:{type:'object'}}],
    call:async(params,signal)=>{nativeCalls.push(params);return nativeHandler?nativeHandler(params,signal):{content:[{type:'text',text:'native fixture reply'}]};},close:async()=>{}};
  const start=async()=>{union=await startUnion({target:`http://127.0.0.1:${original.address().port}/mcp`,
    authorizationFile,native,resultHome,resultStore,onEvent:event=>events.push(event),observeCallDetails});};
  await start();
  const request=(method,params={},id=++sequence,extraHeaders={})=>({
    method:'POST',headers:{authorization:AUTH,'content-type':'application/json','mcp-protocol-version':'2026-07-28',
      'mcp-method':method,...(params.name?{'mcp-name':params.name}:{}),...extraHeaders},
    body:JSON.stringify({jsonrpc:'2.0',id,method,params:{...params,_meta:{...META,...params._meta}}})
  });
  const post=async(method,params={},id=++sequence,extraHeaders={})=>{
    const response=await fetch(union.url,request(method,params,id,extraHeaders));
    const raw=Buffer.from(await response.arrayBuffer());
    return {status:response.status,headers:response.headers,raw,json:()=>JSON.parse(raw.toString('utf8'))};
  };
  t.after(async()=>{
    await union.close();original.closeAllConnections();await new Promise(resolve=>original.close(resolve));
    const resolved=path.resolve(root),temporary=path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved),temporary);
    assert.ok(path.basename(resolved).startsWith('clw-results-integration-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  return {get union(){return union;},root,resultHome,authorizationFile,events,received,nativeCalls,request,post,
    setHandler:value=>handler=value,setNative:value=>nativeHandler=value,revoke:()=>denied=true,
    allow:()=>denied=false,restart:async()=>{await union.close();await start();},
    originals:()=>received.filter(row=>row.message.method==='tools/call'&&row.message.params.name!=='clw_read_result'&&
      !(row.message.params.name==='call_runtime_tool'&&row.message.params.arguments?.tool==='clw_read_result'))};
}

function preserved(response,kind='tools'){
  assert.equal(response.status,200);
  assert.ok(response.raw.length<INLINE_BYTES,'receipt is bounded by the production inline budget');
  assert.ok(4*Math.ceil(response.raw.length/3)+1024<10*MiB,'receipt fits control-plane base64 framing');
  let rpc;
  if(response.headers.get('content-type').includes('text/event-stream')){
    const data=response.raw.toString('utf8').split('\n').find(line=>line.startsWith('data: '));
    assert.ok(data);rpc=JSON.parse(data.slice(6));
  }else rpc=response.json();
  const value=kind==='resources'?JSON.parse(rpc.result.contents[0].text):rpc.result.structuredContent;
  assert.equal(value.delivery.status,'result_preserved');
  assert.equal(value.delivery.complete,true);
  assert.equal(value.delivery.original_execution_replayed,false);
  assert.equal(value.delivery.continue_current_task,true);
  assert.match(value.instruction,/not a reason to end the conversation/);
  assert.match(value.instruction,/Do not rerun the original action/);
  assert.equal(value.suggested_call.tool,'call_runtime_tool');
  assert.equal(value.suggested_call.arguments.tool,'clw_read_result');
  return {value,rpc};
}

async function readAll(f,descriptor,{format='base64',maxBytes=512*1024}={}){
  const parts=[];let offset=0,pageNumber=0;
  while(true){
    const arguments_={result_id:descriptor.result_id,offset,max_bytes:maxBytes,format};
    const direct=pageNumber++===0;
    const response=await f.post('tools/call',direct?{name:'clw_read_result',arguments:arguments_}:
      {name:'call_runtime_tool',arguments:{tool:'clw_read_result',arguments:arguments_}});
    assert.equal(response.status,200);
    assert.ok(response.raw.length<INLINE_BYTES);
    const rpc=response.json();assert.notEqual(rpc.result.isError,true);
    assert.equal(rpc.result.structuredContent.data_in_content,true);
    assert.equal(Object.hasOwn(rpc.result.structuredContent,'data'),false);
    const page=JSON.parse(rpc.result.content[0].text);
    assert.equal(page.sha256,descriptor.sha256);assert.equal(page.offset,offset);
    const chunk=format==='base64'?Buffer.from(page.data,'base64'):Buffer.from(page.data);
    assert.equal(chunk.length,page.bytes_returned);assert.equal(page.next_offset,offset+chunk.length);
    parts.push(chunk);offset=page.next_offset;
    if(page.eof){
      assert.equal(offset,page.total_bytes);
      if(descriptor.complete===false){assert.match(page.instruction,/original response was incomplete/);assert.match(page.instruction,/Reconcile the original Job\/request/);}
      else assert.match(page.instruction,/Continue the original task/);
      break;
    }
    assert.ok(chunk.length>0);assert.equal(page.suggested_call.arguments.arguments.offset,offset);
    assert.equal(page.suggested_call.arguments.tool,'clw_read_result');
  }
  return Buffer.concat(parts);
}

test('actual >10 MiB JSON tool reply is paged losslessly through direct and gateway HTTP calls without repeating work',async t=>{
  const f=await fixture(t);let original;
  f.setHandler(async(message,res)=>{if(message.method!=='tools/call')return false;
    original=largeResult(message.id);assert.ok(original.length>12*MiB);res.end(original);return true;});
  const response=await f.post('tools/call',{name:'read_files',arguments:{request_id:'one-original-effect'}});
  const {value,rpc}=preserved(response);
  assert.equal(rpc.result.resultType,'complete');
  assert.equal(rpc.result._meta['io.modelcontextprotocol/serverInfo'].name,'clw-result-continuation');
  assert.equal(value.delivery.raw_bytes,original.length);assert.equal(value.delivery.sha256,digest(original));
  assert.equal(value.delivery.original_tool,'read_files');
  const sidecarRead=await f.post('tools/call',{name:'call_runtime_tool',arguments:{tool:'clw_read_result',
    arguments:{result_id:value.delivery.result_id,max_bytes:4},recording_session_id:'private-recording',
    ack_session_message_ids:['private-message'],context_request:{private:'context'},session_message_resolution:{private:'resolution'}}});
  const sidecarResult=sidecarRead.json().result;
  assert.deepEqual(sidecarResult.structuredContent.unprocessed_workflow_sidecars,
    ['recording_session_id','ack_session_message_ids','context_request','session_message_resolution']);
  assert.equal(sidecarRead.raw.includes(Buffer.from('private-message')),false);
  for(const row of f.received.filter(row=>row.message.method==='server/discover')){
    assert.equal(Object.hasOwn(row.message.params,'arguments'),false,'result reads cannot forward Workflow ACK sidecars');
  }
  assert.deepEqual(await readAll(f,value.delivery),original);
  assert.equal(f.originals().length,1);assert.equal(f.nativeCalls.length,0);
  assert.equal(f.events.filter(event=>event.event==='mcp_result_preserved').length,1);
  const state=JSON.parse(fs.readFileSync(path.join(f.resultHome,value.delivery.result_id,'read.json'),'utf8'));
  assert.equal(state.fully_read,true);
});

test('large resources/read retains its URI and every original JSON and binary byte',async t=>{
  const f=await fixture(t),binary=Buffer.alloc(9*MiB,0xa7);let original;
  f.setHandler(async(message,res)=>{if(message.method!=='resources/read')return false;
    original=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{contents:[{
      uri:message.params.uri,mimeType:'application/octet-stream',blob:binary.toString('base64')
    }]}}));res.end(original);return true;});
  const response=await f.post('resources/read',{uri:'fixture://original/binary'});
  const {value,rpc}=preserved(response,'resources');
  assert.equal(rpc.result.contents[0].uri,'fixture://original/binary');
  const bytes=await readAll(f,value.delivery);
  assert.deepEqual(bytes,original);
  assert.deepEqual(Buffer.from(JSON.parse(bytes).result.contents[0].blob,'base64'),binary);
  assert.equal(f.received.filter(row=>row.message.method==='resources/read').length,1);
  const started=f.events.find(row=>row.event==='mcp_call_started'&&row.method==='resources/read');
  assert.ok(started?.callId);
  const meta=JSON.parse(fs.readFileSync(path.join(f.resultHome,value.delivery.result_id,'meta.json'),'utf8'));
  assert.equal(meta.call_id,started.callId);
  assert.equal(f.events.find(row=>row.event==='mcp_response_sent'&&row.method==='resources/read').callId,started.callId);
  assert.equal(JSON.stringify(f.events).includes('fixture://original/binary'),false);
});

test('large native media preserves isError, application failure, exact base64 media, and protocol metadata',async t=>{
  const f=await fixture(t),binary=Buffer.alloc(9*MiB,0x5a);
  const originalResult={isError:true,content:[{type:'image',mimeType:'image/png',data:binary.toString('base64')},
    {type:'text',text:'original fixture failure'}],structuredContent:{success:false,output:{failed_count:2}},_meta:{original:'preserved'}};
  f.setNative(async()=>originalResult);
  const response=await f.post('tools/call',{name:'codex_view_image',arguments:{turn_token:'fixture-turn',path:'fixture.png'}},'native-media');
  const {value,rpc}=preserved(response);
  assert.equal(rpc.result.isError,true);assert.equal(rpc.result.resultType,'complete');
  assert.equal(rpc.result._meta.original,'preserved');
  assert.equal(value.delivery.original_outcome.is_error,true);
  assert.equal(value.delivery.original_outcome.success,false);
  assert.equal(value.delivery.original_outcome.failed_count,2);
  const bytes=await readAll(f,value.delivery),recovered=JSON.parse(bytes);
  assert.deepEqual(recovered.result.content,originalResult.content);
  assert.deepEqual(recovered.result.structuredContent,originalResult.structuredContent);
  assert.equal(recovered.result.isError,true);
  assert.deepEqual(Buffer.from(recovered.result.content[0].data,'base64'),binary);
  assert.equal(digest(bytes),value.delivery.sha256);
  assert.equal(f.nativeCalls.length,1);
  const outcome=f.events.find(event=>event.event==='native_result');
  assert.equal(outcome.isError,true);assert.equal(outcome.applicationSuccess,false);assert.equal(outcome.itemFailureCount,2);
});

test('giant native protocol metadata is stored losslessly while its continuation receipt stays bounded',async t=>{
  const f=await fixture(t),metadata='native-metadata-'.repeat(500000);
  assert.ok(Buffer.byteLength(metadata)>INLINE_BYTES);
  const original={content:[{type:'text',text:'small outcome with giant original metadata'}],
    structuredContent:{success:true},_meta:{private_metadata:metadata,original_flag:true}};
  f.setNative(async()=>original);
  const response=await f.post('tools/call',{name:'codex_exec',arguments:{turn_token:'fixture-metadata-turn'}},'native-metadata');
  const {value,rpc}=preserved(response);
  assert.equal(rpc.result.resultType,'complete');
  assert.ok(Buffer.byteLength(JSON.stringify(rpc.result._meta))<8192,'receipt metadata cannot bypass its body budget');
  const bytes=await readAll(f,value.delivery),recovered=JSON.parse(bytes);
  assert.equal(recovered.result._meta.private_metadata,metadata);
  assert.equal(recovered.result._meta.original_flag,true);
  assert.deepEqual(recovered.result.content,original.content);
  assert.equal(digest(bytes),value.delivery.sha256);assert.equal(f.nativeCalls.length,1);
});

test('giant resource URI metadata cannot overflow the receipt and original request and response remain exact',async t=>{
  const f=await fixture(t),uri='fixture://original/'+('ø'.repeat(4*MiB));let original;
  // Four MiB of characters occupy eight MiB on the UTF-8 wire. This tests the
  // production body budget, including resource metadata outside receipt text.
  assert.ok(Buffer.byteLength(uri)>INLINE_BYTES);
  f.setHandler(async(message,res)=>{if(message.method!=='resources/read')return false;
    original=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{contents:[{
      uri:message.params.uri,mimeType:'text/plain',text:'r'.repeat(3*MiB)
    }]}}));res.end(original);return true;});
  const response=await f.post('resources/read',{uri},'giant-resource-uri');
  const {value,rpc}=preserved(response,'resources');
  assert.equal(rpc.result.contents[0].uri,'clw://result/'+value.delivery.result_id);
  const bytes=await readAll(f,value.delivery);
  assert.deepEqual(bytes,original);assert.equal(JSON.parse(bytes).result.contents[0].uri,uri);
  const received=f.received.filter(row=>row.message.method==='resources/read');
  assert.equal(received.length,1);assert.equal(received[0].message.params.uri,uri);
});

test('result references survive an HTTP union restart and read only the preserved original outcome',async t=>{
  const f=await fixture(t);let original;
  f.setHandler(async(message,res)=>{if(message.method!=='tools/call')return false;original=largeResult(message.id);res.end(original);return true;});
  const {value}=preserved(await f.post('tools/call',{name:'read_files',arguments:{request_id:'persist-original'}}));
  const first=await f.post('tools/call',{name:'clw_read_result',arguments:{result_id:value.delivery.result_id,max_bytes:4}});
  assert.equal(first.status,200);assert.equal(JSON.parse(first.json().result.content[0].text).bytes_returned,4);
  await f.restart();
  assert.deepEqual(await readAll(f,value.delivery),original);
  assert.equal(f.originals().length,1);
});

test('client disconnect does not cancel a WebCodex response and completed bytes still become readable',async t=>{
  const f=await fixture(t);let release,started,original;
  const began=new Promise(resolve=>started=resolve),ready=new Promise(resolve=>release=resolve);
  f.setHandler(async(message,res)=>{if(message.method!=='tools/call')return false;started();await ready;
    original=largeResult(message.id);res.end(original);return true;});
  const options=f.request('tools/call',{name:'read_files',arguments:{request_id:'disconnect-original'}},'disconnect-original');
  const req=http.request(f.union.url,{method:options.method,headers:options.headers},res=>res.resume());
  req.on('error',()=>{});req.end(options.body);await began;req.destroy();
  await until(()=>f.events.some(event=>event.event==='mcp_client_disconnected'),'downstream disconnect');
  release();await until(()=>f.events.some(event=>event.event==='mcp_result_preserved'),'durable disconnected outcome');
  const entry=fs.readdirSync(f.resultHome).find(name=>name.startsWith('result_'));
  const descriptor=JSON.parse(fs.readFileSync(path.join(f.resultHome,entry,'meta.json'),'utf8'));
  assert.equal(descriptor.complete,true);assert.deepEqual(await readAll(f,descriptor),original);
  assert.equal(f.originals().length,1);
  assert.equal(f.received.some(row=>row.message.method==='notifications/cancelled'),false);
});

test('native client disconnect preserves its original side effect and stores its result without aborting its signal',async t=>{
  const f=await fixture(t);let started,release,aborted=false;
  const began=new Promise(resolve=>started=resolve),ready=new Promise(resolve=>release=resolve);
  f.setNative(async(_params,signal)=>{signal.addEventListener('abort',()=>{aborted=true;});started();await ready;
    return {content:[{type:'text',text:'n'.repeat(12*MiB)}],structuredContent:{success:true}};});
  const options=f.request('tools/call',{name:'codex_exec',arguments:{turn_token:'fixture-original-turn',cmd:'fixture effect'}},'native-disconnect');
  const req=http.request(f.union.url,{method:options.method,headers:options.headers},res=>res.resume());
  req.on('error',()=>{});req.end(options.body);await began;req.destroy();
  await until(()=>f.events.some(event=>event.event==='mcp_client_disconnected'),'native downstream disconnect');
  release();await until(()=>f.events.some(event=>event.event==='mcp_result_preserved'),'native durable result');
  const entry=fs.readdirSync(f.resultHome).find(name=>name.startsWith('result_'));
  const descriptor=JSON.parse(fs.readFileSync(path.join(f.resultHome,entry,'meta.json'),'utf8'));
  const bytes=await readAll(f,descriptor);
  assert.equal(JSON.parse(bytes).result.structuredContent.success,true);
  assert.equal(digest(bytes),descriptor.sha256);assert.equal(f.nativeCalls.length,1);assert.equal(aborted,false);
});

test('gzip replies are sized after decompression and their readable original JSON remains exact',async t=>{
  const f=await fixture(t);let original;
  f.setHandler(async(message,res)=>{if(message.method!=='tools/call')return false;
    original=largeResult(message.id,'g'.repeat(12*MiB));res.setHeader('content-encoding','gzip');res.end(zlib.gzipSync(original));return true;});
  const response=await f.post('tools/call',{name:'read_files',arguments:{request_id:'compressed-original'}});
  const {value}=preserved(response);
  assert.equal(response.headers.get('content-encoding'),null);
  assert.equal(value.delivery.original_content_encoding,'gzip');
  assert.deepEqual(await readAll(f,value.delivery),original);
  assert.equal(f.originals().length,1);
});

test('finite POST SSE above 10 MiB is preserved as exact SSE bytes and remains paged through the gateway',async t=>{
  const f=await fixture(t);let original;
  f.setHandler(async(message,res)=>{if(message.method!=='tools/call')return false;
    original=Buffer.concat([Buffer.from('event: message\ndata: '),largeResult(message.id,'s'.repeat(12*MiB)),Buffer.from('\n\n')]);
    res.setHeader('content-type','text/event-stream');res.end(original);return true;});
  const response=await f.post('tools/call',{name:'read_files',arguments:{request_id:'sse-original'}});
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const {value}=preserved(response);
  assert.deepEqual(await readAll(f,value.delivery),original);
  assert.equal(f.originals().length,1);
});

test('result reads reject invalid, revoked, mismatched-header and different-principal requests without replaying work',async t=>{
  const f=await fixture(t);
  f.setHandler(async(message,res)=>{if(message.method!=='tools/call')return false;res.end(largeResult(message.id));return true;});
  const {value}=preserved(await f.post('tools/call',{name:'read_files',arguments:{request_id:'authority-original'}}));
  const params={name:'clw_read_result',arguments:{result_id:value.delivery.result_id}};
  const before=f.received.length;
  assert.equal((await f.post('tools/call',params,100,{authorization:'Bearer unauthorized'})).status,401);
  assert.equal((await f.post('tools/call',params,101,{'mcp-name':'read_files'})).status,400);
  assert.equal(f.received.length,before);
  f.revoke();assert.equal((await f.post('tools/call',params,102)).status,403);f.allow();
  fs.writeFileSync(f.authorizationFile,'Bearer rotated-integration-principal');
  assert.equal((await f.post('tools/call',params,103)).status,401);
  const other=await f.post('tools/call',params,104,{authorization:'Bearer rotated-integration-principal'});
  assert.equal(other.status,200);assert.equal(other.json().result.isError,true);
  assert.equal(other.json().result.resultType,'complete');
  assert.equal(other.json().result._meta['io.modelcontextprotocol/serverInfo'].name,'clw-result-continuation');
  assert.match(other.json().result.content[0].text,/RESULT_NOT_FOUND/);
  assert.equal(other.raw.includes(Buffer.from(value.delivery.sha256)),false);
  assert.equal(f.originals().length,1);
});

test('oversized RPC IDs are rejected before upstream business or native execution',async t=>{
  const f=await fixture(t),id='i'.repeat(1025);
  for(const [name,arguments_] of [['read_files',{request_id:'must-not-execute'}],
    ['codex_exec',{turn_token:'must-not-execute'}],['clw_read_result',{result_id:'must-not-read'}]]){
    const response=await f.post('tools/call',{name,arguments:arguments_},id);
    assert.equal(response.status,400);assert.ok(response.raw.length<2048);
    assert.equal(response.json().id,null);assert.equal(response.json().error.code,-32600);
  }
  assert.equal(f.received.length,0);assert.equal(f.nativeCalls.length,0);
  assert.equal(fs.existsSync(f.resultHome),false);
});

test('an interrupted large upstream preserves only an explicitly incomplete prefix and never claims a complete outcome',async t=>{
  const f=await fixture(t),prefix=Buffer.from('{"jsonrpc":"2.0","id":"partial","result":{"content":[{"type":"text","text":"'+'p'.repeat(7*MiB));
  f.setHandler(async(message,res)=>{if(message.method!=='tools/call')return false;
    res.write(prefix);
    try{await until(async()=>{
      const names=await fsp.readdir(f.resultHome).catch(()=>[]),pending=names.find(name=>name.startsWith('.pending-'));
      return pending&&(await fsp.stat(path.join(f.resultHome,pending,'raw.bin')).catch(()=>null))?.size===prefix.length;
    },'prefix persisted before upstream interruption');}finally{res.destroy();}
    return true;
  });
  const response=await f.post('tools/call',{name:'read_files',arguments:{request_id:'partial-original'}},'partial');
  assert.equal(response.status,200);
  const value=response.json().result.structuredContent;
  assert.equal(value.delivery.status,'result_delivery_incomplete');
  assert.equal(value.delivery.continue_current_task,true);assert.equal(value.delivery.original_execution_replayed,false);
  assert.equal(value.preserved_partial_result.complete,false);
  assert.equal(value.preserved_partial_result.incomplete_reason,'upstream_stream_interrupted');
  assert.deepEqual(await readAll(f,value.preserved_partial_result),prefix);
  const state=JSON.parse(fs.readFileSync(path.join(f.resultHome,value.preserved_partial_result.result_id,'read.json'),'utf8'));
  assert.equal(state.fully_read,false);assert.equal(f.originals().length,1);
});

test('interrupted upstream below the inline budget still retains every received prefix byte as incomplete',async t=>{
  const f=await fixture(t),prefix=Buffer.from('{"jsonrpc":"2.0","id":"small-partial","result":{"content":[{"type":"text","text":"'+'q'.repeat(256*1024));
  assert.ok(prefix.length<INLINE_BYTES);
  f.setHandler(async(message,res)=>{if(message.method!=='tools/call')return false;
    await new Promise(resolve=>res.write(prefix,resolve));await pause(100);res.destroy();return true;});
  const response=await f.post('tools/call',{name:'read_files',arguments:{request_id:'small-partial-original'}},'small-partial');
  assert.equal(response.status,200);assert.ok(response.raw.length<INLINE_BYTES);
  const value=response.json().result.structuredContent;
  assert.equal(value.delivery.status,'result_delivery_incomplete');
  assert.equal(value.delivery.continue_current_task,true);assert.equal(value.delivery.original_execution_replayed,false);
  assert.equal(value.preserved_partial_result.complete,false);
  assert.equal(value.preserved_partial_result.sha256,digest(prefix));
  assert.deepEqual(await readAll(f,value.preserved_partial_result),prefix);
  const state=JSON.parse(fs.readFileSync(path.join(f.resultHome,value.preserved_partial_result.result_id,'read.json'),'utf8'));
  assert.equal(state.fully_read,false);assert.equal(f.originals().length,1);
});

test('storage failure returns a bounded continue-and-reconcile receipt and drains the one original response',async t=>{
  const f=await fixture(t);
  // A local file at the dedicated result directory simulates unavailable
  // storage without modifying process-global fs or any production directory.
  fs.writeFileSync(f.resultHome,'isolated unavailable-storage fixture');
  f.setHandler(async(message,res)=>{if(message.method!=='tools/call')return false;
    res.end(largeResult(message.id));return true;});
  const response=await f.post('tools/call',{name:'read_files',arguments:{request_id:'storage-fault-original'}});
  assert.equal(response.status,200);assert.ok(response.raw.length<INLINE_BYTES);
  const value=response.json().result.structuredContent;
  assert.equal(value.delivery.status,'result_delivery_incomplete');
  assert.equal(value.delivery.continue_current_task,true);assert.equal(value.delivery.original_execution_replayed,false);
  assert.match(value.delivery.reason,/^RESULT_/);
  assert.match(value.instruction,/does not cancel the current task/);
  assert.match(value.instruction,/Do not rerun an accepted action/);
  assert.equal(value.suggested_call,undefined);assert.equal(f.originals().length,1);
  const diagnostic=f.events.find(row=>row.event==='mcp_result_delivery_attention');
  assert.equal(diagnostic.storeCode,value.delivery.reason);assert.equal(diagnostic.phase,'stream_store');
  assert.equal(diagnostic.callId,f.events.find(row=>row.event==='mcp_call_started').callId);
  const health=await(await fetch(f.union.url.replace('/mcp','/healthz'))).json();
  assert.equal(health.activeUpstream,0);assert.equal(health.pendingNative,0);
});

for(const code of ['RESULT_STORE_FULL','RESULT_STORE_BUSY'])test(`HTTP ${code} preserves diagnosis and never replays execution`,async t=>{
  let writes=0;
  const f=await fixture(t,{resultStore:{putStream:async()=>{writes++;throw Object.assign(Error('private storage details'),{code});}}});
  f.setHandler((message,res)=>{if(message.method!=='tools/call')return false;res.end(largeResult(message.id));return true;});
  const response=await f.post('tools/call',{name:'read_files',arguments:{request_id:'original-diagnosed'}});
  const value=response.json().result.structuredContent;
  assert.equal(response.status,200);assert.equal(value.delivery.reason,code);
  assert.equal(value.delivery.original_execution_replayed,false);assert.equal(writes,1);assert.equal(f.originals().length,1);
  const diagnostic=f.events.find(row=>row.event==='mcp_result_delivery_attention');
  assert.equal(diagnostic.storeCode,code);assert.equal(diagnostic.method,'tools/call');
  assert.equal(diagnostic.phase,'stream_store');assert.equal(diagnostic.callId,f.events.find(row=>row.event==='mcp_call_started').callId);
  assert.equal(JSON.stringify(f.events).includes('private storage details'),false);
});

test('small JSON, resource, native media and finite SSE responses retain their exact original wire content',async t=>{
  const f=await fixture(t);let expected;
  f.setHandler(async(message,res)=>{
    if(!['tools/call','resources/read'].includes(message.method))return false;
    const json=JSON.stringify({jsonrpc:'2.0',id:message.id,result:message.method==='resources/read'?{
      contents:[{uri:message.params.uri,mimeType:'text/plain',text:'数学 \\[a=b\\]'}]
    }:{content:[{type:'text',text:'exact \n whitespace and 数学'}],isError:false}});
    expected=Buffer.from(message.params.arguments?.sse?'event: message\ndata: '+json+'\n\n':json);
    if(message.params.arguments?.sse)res.setHeader('content-type','text/event-stream');
    res.end(expected);return true;
  });
  for(const [method,params] of [['tools/call',{name:'read_files',arguments:{}}],
    ['resources/read',{uri:'fixture://small'}],['tools/call',{name:'read_files',arguments:{sse:true}}]]){
    const response=await f.post(method,params);assert.equal(response.status,200);assert.deepEqual(response.raw,expected);
  }
  const original={content:[{type:'image',mimeType:'image/png',data:'AAAB'}],isError:false,structuredContent:{success:false}};
  f.setNative(async()=>original);
  const response=await f.post('tools/call',{name:'codex_view_image',arguments:{turn_token:'fixture-turn'}},'small-native');
  const actual=response.json().result;
  assert.deepEqual(actual.content,original.content);assert.deepEqual(actual.structuredContent,original.structuredContent);
  assert.equal(actual.isError,false);assert.equal(f.events.some(event=>event.event==='mcp_result_preserved'),false);
  assert.equal(fs.existsSync(f.resultHome),false);
});
