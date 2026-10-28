'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {startUnion,nativeProvider}=require('../mcp-union.cjs');
async function waitFor(predicate,label){
  for(let n=0;n<100;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail(`timed out waiting for ${label}`);
}
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-union-'));
  const key=path.join(root,'auth');fs.writeFileSync(key,'Bearer isolated-test');
  const received=[],calls=[],events=[];let collision=false,deny=false,call,checkHook;
  const original=http.createServer(async(req,res)=>{
    let text='';for await(const b of req)text+=b;const m=text?JSON.parse(text):{};
    received.push({headers:req.headers,text});
    res.setHeader('content-type','application/json');res.setHeader('mcp-session-id','original-session');
    if(req.headers['mcp-method']&&req.headers['mcp-method']!==m.method){res.writeHead(400).end(JSON.stringify({error:{code:-32020,message:'Mcp-Method header/body mismatch'}}));return;}
    if(m.method==='ping'&&req.headers['mcp-name']){res.writeHead(400).end(JSON.stringify({error:{code:-32020,message:'ping retained tool name'}}));return;}
    if(req.headers['mcp-protocol-version']==='2026-07-28'&&m.method==='ping'){res.writeHead(404).end(JSON.stringify({error:{code:-32601,message:'Method not found: ping'}}));return;}
    if((m.method==='ping'||m.method==='server/discover')&&checkHook)await checkHook();
    if(deny){res.writeHead(403).end(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'revoked'}}));return;}
    if(m.method==='resources/read'){res.writeHead(200);res.write('{"unchanged":');res.end('"resource stream"}');return;}
    if(m.method==='tools/call'&&m.params?.name==='work_on_project'){
      res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{isError:false,content:[{type:'text',text:'private backend error detail'}],structuredContent:{success:false,error:'private backend error detail',error_code:'INVALID_ARGUMENT'}}}));return;
    }
    if(m.method==='tools/call'&&m.params?.name==='read_files'&&m.params.arguments?.test_partial===true){
      res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{isError:false,content:[{type:'text',text:'private path and error'}],structuredContent:{success:true,output:{failed_count:1,items:[{success:false,path:'private-file'}]}}}}));return;
    }
    if(m.method==='tools/call'&&(m.params?.name==='tool_manifest'||(m.params?.name==='call_runtime_tool'&&m.params.arguments?.tool==='tool_manifest'))){
      const a=m.params.name==='tool_manifest'?m.params.arguments||{}:m.params.arguments.arguments||{},missing=a.tool_name?.startsWith('codex_');
      const output=missing?{code:'unknown_tool_manifest_tool',tool_name:a.tool_name}:a.tool_name?{name:a.tool_name,input_schema:{type:'object'}}:
        a.category||a.intent?{tools:[],...(a.category?{category:a.category}:{intent:a.intent})}:{categories:{file:['read_files']},tool_count:1,risk_summary:{read_only:1}};
      res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{isError:!!missing,content:[{type:'text',text:missing?'unknown tool':'original discovery'}],structuredContent:{success:!missing,error:missing?'unknown tool':null,...(missing?{error_code:'INVALID_ARGUMENT'}:{}),output}}}));return;
    }
    const result=m.method==='initialize'?{capabilities:{tools:{},resources:{}},protocolVersion:'2025-06-18'}:
      m.method==='tools/list'?{tools:[{name:collision?'codex_exec':'read_files',inputSchema:{type:'object'}}]}:
      m.method==='tools/call'?{content:[{type:'image',mimeType:'image/png',data:'fixture-only'}],structuredContent:{session:'wf-original'}}:{};
    res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
  });
  await new Promise(r=>original.listen(0,'127.0.0.1',r));
  const native={tools:[{name:'codex_exec',inputSchema:{type:'object'}},{name:'codex_view_image',inputSchema:{type:'object'}}],
    call:async(p,s)=>{calls.push(p);return call?call(p,s):{content:[{type:'text',text:'native original result'}]};},close:async()=>{}};
  const union=await startUnion({target:`http://127.0.0.1:${original.address().port}/mcp`,authorizationFile:key,native,onEvent:e=>events.push(e),observeCallDetails:false});
  t.after(async()=>{await union.close();original.closeAllConnections();await new Promise(r=>original.close(r));fs.rmSync(root,{recursive:true,force:true});});
  const post=(method,params={},id=1,extra={})=>fetch(union.url,{method:'POST',headers:{authorization:'Bearer isolated-test','content-type':'application/json','mcp-session-id':'original-session','mcp-protocol-version':'2025-06-18','mcp-method':method,...(params.name?{'mcp-name':params.name}:{}) ,...extra},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  return {union,post,received,calls,events,setCall:f=>call=f,setCheckHook:f=>checkHook=f,collision:()=>collision=true,deny:()=>deny=true};
}
test('ordinary tool trace links one accepted call and unchanged response without payloads',async t=>{
  const f=await fixture(t);
  const params={name:'read_files',arguments:{session_id:'secret-session',path:'private-file',text:'sensitive-body'}};
  const result=await(await f.post('tools/call',params)).json();
  assert.equal(result.result.content[0].type,'image');
  const start=f.events.find(e=>e.event==='mcp_call_started'),end=f.events.find(e=>e.event==='mcp_call_finished');
  assert.ok(start.callId);assert.equal(end.callId,start.callId);assert.equal(start.route,'webcodex');
  assert.equal(end.bodyInspected,true);assert.equal(end.isError,false);assert.equal(end.httpStatus,200);
  const raw=JSON.stringify(f.events);
  for(const secret of ['secret-session','private-file','sensitive-body','Bearer isolated-test','fixture-only'])assert.equal(raw.includes(secret),false);
  assert.equal(f.received.filter(x=>JSON.parse(x.text).method==='tools/call').length,1);
});

test('WebCodex business failure is observable even when HTTP and MCP envelope succeed',async t=>{
  const f=await fixture(t),result=await(await f.post('tools/call',{name:'work_on_project',arguments:{client_id:'isolated-invalid-id'}})).json();
  assert.equal(result.result.isError,false);assert.equal(result.result.structuredContent.success,false);
  const end=f.events.find(e=>e.event==='mcp_call_finished');
  assert.equal(end.httpStatus,200);assert.equal(end.isError,false);assert.equal(end.applicationSuccess,false);
  for(const secret of ['private backend error detail','isolated-invalid-id'])assert.equal(JSON.stringify(f.events).includes(secret),false);
  assert.equal(f.received.filter(x=>JSON.parse(x.text).method==='tools/call').length,1);
});
test('batch file failure is recorded despite a successful outer envelope',async t=>{
  const f=await fixture(t);
  const raw=await(await f.post('tools/call',{name:'read_files',arguments:{session_id:'private-session',test_partial:true}})).json();
  assert.equal(raw.result.structuredContent.success,true);
  assert.equal(raw.result.structuredContent.output.failed_count,1);
  const end=f.events.find(e=>e.event==='mcp_call_finished');
  assert.equal(end.applicationSuccess,true);assert.equal(end.itemFailureCount,1);
  for(const secret of ['private-session','private-file','private path'])assert.equal(JSON.stringify(f.events).includes(secret),false);
});
test('same MCP entry preserves original session, tools, resources and exact call payload',async t=>{
  const f=await fixture(t);
  const init=await f.post('initialize');assert.equal(init.headers.get('mcp-session-id'),'original-session');
  const catalog=await(await f.post('tools/list')).json();assert.deepEqual(catalog.result.tools.map(x=>x.name),['read_files','codex_exec','codex_view_image','clw_read_result']);
  const params={name:'read_files',arguments:{session_id:'wf-original',path:'formula.tex'},_meta:{opaque:'original'}};
  const original=await(await f.post('tools/call',params,12)).json();
  assert.deepEqual(JSON.parse(f.received.at(-1).text).params,params);assert.equal(f.received.at(-1).headers['mcp-session-id'],'original-session');
  assert.equal(original.result.content[0].type,'image');assert.equal(f.calls.length,0);
  assert.equal(await(await f.post('resources/read',{uri:'original://resource'})).text(),'{"unchanged":"resource stream"}');
});
test('native text, image, structured result and original turn token survive without gateway flattening',async t=>{
  const f=await fixture(t),result={content:[{type:'image',mimeType:'image/png',data:'fixture-only'},{type:'text',text:'\\[x^2\\]\n```js\na();\n```'}],structuredContent:{claim:'native'},isError:false};
  f.setCall(async()=>result);
  const params={name:'codex_view_image',arguments:{turn_token:'original-turn-capability',path:'diagram.png'},_meta:{purpose:'unchanged'}};
  assert.deepEqual((await(await f.post('tools/call',params,'native-1')).json()),{jsonrpc:'2.0',id:'native-1',result});
  assert.deepEqual(f.calls,[params]);assert.equal(JSON.parse(f.received.at(-1).text).method,'ping');
  assert.equal(f.received.at(-1).headers['mcp-method'],'ping');assert.equal(f.received.at(-1).headers['mcp-name'],undefined);
});
test('native activity retains explicit application failure without changing its MCP result',async t=>{
 const f=await fixture(t),result={isError:false,content:[{type:'text',text:'private failure detail'}],structuredContent:{success:false,error:'private failure detail'}};
 f.setCall(async()=>result);
 const params={name:'codex_exec',arguments:{turn_token:'private-turn-capability',cmd:'fixture only'}};
 assert.deepEqual((await(await f.post('tools/call',params,71)).json()).result,result);
 const failed=f.events.find(e=>e.event==='native_result');
 assert.equal(failed.isError,false);assert.equal(failed.applicationSuccess,false);
 assert.equal(JSON.stringify(f.events).includes('private failure detail'),false);
 f.setCall(async()=>({content:[{type:'text',text:'no business flag'}]}));
 await(await f.post('tools/call',params,72)).json();
 const unknown=f.events.filter(e=>e.event==='native_result').at(-1);
 assert.equal(Object.hasOwn(unknown,'applicationSuccess'),false);
 assert.equal(f.calls.length,2);
});
test('expired native authority gets a fixed metadata code without replay or changing its wire result',async t=>{
 const f=await fixture(t),result={isError:true,content:[{type:'text',text:'turn token is invalid, expired, or revoked'}]};
 f.setCall(async()=>result);
 const r=await(await f.post('tools/call',{name:'codex_exec',arguments:{turn_token:'secret-old-turn'}},91)).json();
 assert.deepEqual(r.result,result);assert.equal(f.calls.length,1);
 const end=f.events.find(e=>e.event==='native_result');assert.equal(end.code,'native_turn_authority_ended');
 assert.equal(JSON.stringify(f.events).includes('secret-old-turn'),false);
 const {nativeResultCode}=require('../native-errors.cjs');
 assert.equal(nativeResultCode({...result,isError:false}),undefined);
 assert.equal(nativeResultCode({isError:true,content:[{type:'text',text:'different error'}]}),undefined);
});
test('invalid auth, revoked authority, collisions and native failure never fall back or replay',async t=>{
  const f=await fixture(t),params={name:'codex_exec',arguments:{turn_token:'original-turn-capability'}};
  assert.equal((await f.post('tools/call',params,1,{authorization:'Bearer wrong'})).status,401);
  assert.equal((await f.post('tools/list',{},1,{origin:'https://untrusted.invalid'})).status,403);
  assert.equal(f.calls.length,0);
  f.setCall(async()=>{throw Error('transport failed');});
  assert.ok((await(await f.post('tools/call',params,2)).json()).error);assert.equal(f.calls.length,1);
  f.deny();assert.equal((await f.post('tools/call',params,3)).status,403);assert.equal(f.calls.length,1);
  const other=await fixture(t);other.collision();assert.equal((await other.post('tools/list')).status,502);
});
test('stateless calls use discovery with matching metadata and preserve the native payload',async t=>{
  const f=await fixture(t),meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}};
  const params={name:'codex_exec',arguments:{turn_token:'original-turn-capability'},_meta:meta};
  const nativeResult={content:[{type:'image',mimeType:'image/png',data:'fixture-only'}],structuredContent:{identity:'original'},_meta:{native:'retained'}};
  f.setCall(async()=>nativeResult);
  const reply=await f.post('tools/call',params,'stateless-native',{'mcp-protocol-version':'2026-07-28'});
  assert.equal(reply.status,200);const result=(await reply.json()).result;
  assert.equal(result.resultType,'complete');assert.deepEqual(result.content,nativeResult.content);assert.deepEqual(result.structuredContent,nativeResult.structuredContent);
  assert.equal(result._meta.native,'retained');assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name,'clw-native-bridge');assert.deepEqual(f.calls,[params]);
  const checked=f.received.at(-1),message=JSON.parse(checked.text);
  assert.equal(message.method,'server/discover');assert.equal(checked.headers['mcp-method'],'server/discover');
  assert.equal(checked.headers['mcp-name'],undefined);assert.deepEqual(message.params._meta,meta);
  for(const invalid of [{'mcp-method':'ping'},{'mcp-name':'other_tool'}]){
    assert.equal((await f.post('tools/call',params,'bad-header',{'mcp-protocol-version':'2026-07-28',...invalid})).status,400);
  }
  assert.equal(f.calls.length,1);
  assert.equal((await f.post('tools/call',params,'encoded-name',{'mcp-protocol-version':'2026-07-28','mcp-name':'=?base64?'+Buffer.from(params.name).toString('base64')+'?='})).status,200);
});
test('disconnect preserves in-flight call; explicit cancellation is scoped to the original MCP session',async t=>{
  const f=await fixture(t);let started,finish,wasAborted=false;
  const began=new Promise(r=>started=r);
  f.setCall((_p,s)=>new Promise(resolve=>{finish=()=>resolve({content:[{type:'text',text:'done'}]});s.addEventListener('abort',()=>{wasAborted=true;finish();});started();}));
  const req=http.request(f.union.url,{method:'POST',headers:{authorization:'Bearer isolated-test','content-type':'application/json','mcp-session-id':'original-session'}},r=>r.resume());
  req.on('error',()=>{});req.end(JSON.stringify({jsonrpc:'2.0',id:42,method:'tools/call',params:{name:'codex_exec',arguments:{turn_token:'original'}}}));
  await began;req.destroy();
  const wrong=await f.post('notifications/cancelled',{requestId:42},undefined,{'mcp-session-id':'other-session'});await wrong.text();assert.equal(wasAborted,false);
  assert.equal((await f.post('notifications/cancelled',{requestId:42})).status,202);
  assert.equal(wasAborted,true);assert.equal(f.calls.length,1);
});

test('an exact in-flight native request shares one side effect and the identical envelope',async t=>{
  const f=await fixture(t);let release,started;
  const began=new Promise(resolve=>{started=resolve;});
  f.setCall(()=>new Promise(resolve=>{release=resolve;started();}));
  const params={name:'codex_exec',arguments:{turn_token:'private-turn',cmd:'one side effect'}};
  const first=f.post('tools/call',params,41);await began;
  const duplicate=f.post('tools/call',{name:'codex_exec',arguments:{cmd:'one side effect',turn_token:'private-turn'}},41);
  try{
    await waitFor(()=>f.events.some(e=>e.event==='native_duplicate_attached'),'duplicate attachment');
    assert.equal(f.calls.length,1);
    assert.equal((await(await fetch(f.union.url.replace('/mcp','/healthz'))).json()).pendingNative,1);
  }finally{release({content:[{type:'text',text:'private original result'}],structuredContent:{success:true}});}
  const [one,two]=await Promise.all([first,duplicate]);
  assert.equal(one.status,200);assert.equal(two.status,200);
  assert.equal(await one.text(),await two.text());
  assert.equal(f.calls.length,1);
  assert.equal(f.events.filter(e=>e.event==='native_call').length,1);
  assert.equal(JSON.stringify(f.events).includes('private original result'),false);
  assert.equal((await(await fetch(f.union.url.replace('/mcp','/healthz'))).json()).pendingNative,0);
});

test('conflicting body or authority under one active native identity remains 409',async t=>{
  const f=await fixture(t);let release,started;
  const began=new Promise(resolve=>{started=resolve;});
  f.setCall(()=>new Promise(resolve=>{release=resolve;started();}));
  const params={name:'codex_exec',arguments:{turn_token:'private-turn',cmd:'original'}};
  const first=f.post('tools/call',params,42);await began;
  try{
    const changedBody=await f.post('tools/call',{name:'codex_exec',arguments:{turn_token:'private-turn',cmd:'different'}},42);
    const changedTool=await f.post('tools/call',{name:'codex_view_image',arguments:{turn_token:'private-turn',path:'different.png'}},42);
    const changedMeta=await f.post('tools/call',{...params,_meta:{intent:'different'}},42);
    const changedHeader=await f.post('tools/call',params,42,{'mcp-feature':'different'});
    for(const response of [changedBody,changedTool,changedMeta,changedHeader]){
      assert.equal(response.status,409);assert.equal((await response.json()).error.message,'Duplicate active request ID');
    }
    assert.equal(f.calls.length,1);
  }finally{release({content:[{type:'text',text:'original'}]});}
  assert.equal((await first).status,200);
  assert.equal(f.events.filter(e=>e.event==='native_duplicate_rejected').length,4);
});

test('an attached request receives the original native failure without a second execution',async t=>{
  const f=await fixture(t);let fail,started;
  const began=new Promise(resolve=>{started=resolve;});
  f.setCall(()=>new Promise((_resolve,reject)=>{fail=()=>reject(Error('private unknown outcome'));started();}));
  const params={name:'codex_exec',arguments:{turn_token:'private-turn',cmd:'uncertain side effect'}};
  const first=f.post('tools/call',params,43);await began;
  const duplicate=f.post('tools/call',params,43);
  try{
    await waitFor(()=>f.events.some(e=>e.event==='native_duplicate_attached'),'failure attachment');
    assert.equal(f.calls.length,1);
  }finally{fail();}
  const [one,two]=await Promise.all([first,duplicate]);
  assert.equal(one.status,200);assert.equal(two.status,200);
  const raw=await one.text();assert.equal(raw,await two.text());
  assert.deepEqual(JSON.parse(raw),{jsonrpc:'2.0',id:43,error:{code:-32603,message:'Native tool failed; original execution was not replayed'}});
  assert.equal(f.calls.length,1);
  assert.equal(f.events.filter(e=>e.event==='native_error').length,1);
  assert.equal(JSON.stringify(f.events).includes('private unknown outcome'),false);
});

test('session-scoped cancellation remains one shared abort for attached requests',async t=>{
  const f=await fixture(t);let fail,started;
  const began=new Promise(resolve=>{started=resolve;});
  f.setCall((_params,signal)=>new Promise((_resolve,reject)=>{
    fail=reject;signal.addEventListener('abort',()=>reject(Error('private cancellation')));started();
  }));
  const params={name:'codex_exec',arguments:{turn_token:'private-turn',cmd:'cancellable'}};
  const first=f.post('tools/call',params,45);await began;
  const duplicate=f.post('tools/call',params,45);
  try{
    await waitFor(()=>f.events.some(e=>e.event==='native_duplicate_attached'),'cancellation attachment');
    assert.equal((await f.post('notifications/cancelled',{requestId:45},46)).status,202);
  }finally{fail(Error('private test release'));}
  const [one,two]=await Promise.all([first,duplicate]);
  assert.equal(one.status,200);assert.equal(two.status,200);
  assert.equal(await one.text(),await two.text());
  assert.equal(f.calls.length,1);
  assert.equal(f.events.filter(e=>e.event==='native_error').length,1);
});

test('an attached request preserves the original authority denial status and bytes',async t=>{
  const f=await fixture(t);let release,started;
  const began=new Promise(resolve=>{started=resolve;});
  f.setCheckHook(()=>new Promise(resolve=>{release=resolve;started();}));
  const params={name:'codex_exec',arguments:{turn_token:'private-turn'}};
  const first=f.post('tools/call',params,44);await began;
  const duplicate=f.post('tools/call',params,44);
  try{
    await waitFor(()=>f.events.some(e=>e.event==='native_duplicate_attached'),'authority attachment');
    f.deny();
  }finally{release();}
  const [one,two]=await Promise.all([first,duplicate]);
  assert.equal(one.status,403);assert.equal(two.status,403);
  assert.equal(await one.text(),await two.text());
  assert.equal(f.calls.length,0);
});

test('two native turns may share a transport request ID; an exact same-turn call attaches',async t=>{
  const f=await fixture(t),pending=new Map();let began;
  const started=new Promise(r=>began=r);
  f.setCall((p,s)=>new Promise(resolve=>{pending.set(p.arguments.turn_token,{resolve,s});began();}));
  const headers={'mcp-protocol-version':'2026-07-28','mcp-session-id':''};
  const a={name:'codex_exec',arguments:{turn_token:'isolated-turn-A'}},b={name:'codex_exec',arguments:{turn_token:'isolated-turn-B'}};
  const one=f.post('tools/call',a,0,headers);await started;
  const two=f.post('tools/call',b,0,headers);
  let repeated;
  // Deterministic local wait, no Web/model calls. Release on failure as well.
  try{
    await waitFor(()=>pending.size===2,'two native turns');
    assert.equal(pending.size,2,'different native turn capabilities must not collide');
    repeated=f.post('tools/call',a,0,headers);
    await waitFor(()=>f.events.some(e=>e.event==='native_duplicate_attached'),'same-turn attachment');
    const cancelled=await f.post('notifications/cancelled',{requestId:0},99,headers);await cancelled.text();
    assert.ok([...pending.values()].every(p=>!p.s.aborted),'ambiguous stateless cancel must not stop either turn');
  }finally{for(const [token,p] of pending)p.resolve({content:[{type:'text',text:token}]});}
  const [oneResponse,twoResponse,repeatedResponse]=await Promise.all([one,two,repeated]);
  assert.equal(oneResponse.status,200);assert.equal(twoResponse.status,200);assert.equal(repeatedResponse.status,200);
  assert.equal(await oneResponse.text(),await repeatedResponse.text());
  assert.equal(f.calls.length,2);
  assert.equal(f.events.filter(e=>e.event==='native_duplicate_attached').length,1);
});

test('unscoped stateless cancellation cannot cancel a sole native turn',async t=>{
  const f=await fixture(t);let finish,started,signal;const began=new Promise(r=>started=r);
  f.setCall((_p,s)=>new Promise(resolve=>{signal=s;finish=resolve;started();}));
  const headers={'mcp-protocol-version':'2026-07-28','mcp-session-id':''};
  const first=f.post('tools/call',{name:'codex_exec',arguments:{turn_token:'one-native-turn'}},1,headers);await began;
  try{await (await f.post('notifications/cancelled',{requestId:1},2,headers)).text();assert.equal(signal.aborted,false);}
  finally{finish({content:[{type:'text',text:'original result'}]});}
  assert.equal((await first).status,200);
});

test('stateless parallel operations inside one turn are distinct while reordered duplicate arguments attach',async t=>{
  const f=await fixture(t),pending=[];let started;const began=new Promise(r=>started=r);
  f.setCall((_p,_s)=>new Promise(resolve=>{pending.push(resolve);started();}));
  const headers={'mcp-protocol-version':'2026-07-28','mcp-session-id':''};
  const a={name:'codex_exec',arguments:{turn_token:'same-native-turn',cmd:'read first'}},b={name:'codex_exec',arguments:{turn_token:'same-native-turn',cmd:'read second'}};
  const first=f.post('tools/call',a,0,headers);await began;const second=f.post('tools/call',b,0,headers);
  let duplicate;
  try{
    await waitFor(()=>pending.length===2,'two stateless operations');
    assert.equal(pending.length,2);
    duplicate=f.post('tools/call',{name:'codex_exec',arguments:{cmd:'read first',turn_token:'same-native-turn'}},0,headers);
    await waitFor(()=>f.events.some(e=>e.event==='native_duplicate_attached'),'reordered attachment');
    const conflicting=await f.post('tools/call',{...a,_meta:{different:true}},0,headers);
    assert.equal(conflicting.status,409);
  }finally{for(const resolve of pending)resolve({content:[{type:'text',text:'done'}]});}
  const [firstResponse,secondResponse,duplicateResponse]=await Promise.all([first,second,duplicate]);
  assert.equal(firstResponse.status,200);assert.equal(secondResponse.status,200);assert.equal(duplicateResponse.status,200);
  assert.equal(await firstResponse.text(),await duplicateResponse.text());assert.equal(f.calls.length,2);
});
test('pinned upstream native provider exposes six tools without invoking a browser or model',async()=>{
  const root=path.resolve(__dirname,'../../..');
  const provider=await nativeProvider({command:path.join(root,'.local/runtimes/bun-1.4.0/bun.exe'),args:['run',path.join(root,'apps/codex-web-bridge/upstream/src/cli.ts'),'mcp','--contract','native','--broker-socket','\\\\.\\pipe\\clw-isolated-no-broker'],cwd:root,env:{...process.env}});
  try{assert.deepEqual(provider.tools.map(t=>t.name),['codex_exec','codex_write_stdin','codex_apply_patch','codex_view_image','codex_tool_inventory','codex_tool_call']);}
  finally{await provider.close();}
});

test('native manifest matches published schema without executing a tool or inventing authority',async t=>{
  const f=await fixture(t),catalog=(await(await f.post('tools/list')).json()).result.tools;
  for(const name of ['codex_exec','codex_view_image']){
    const r=(await(await f.post('tools/call',{name:'tool_manifest',arguments:{tool_name:name}},7,{'mcp-protocol-version':'2026-07-28'})).json()).result;
    assert.equal(r.isError,false);assert.equal(r.structuredContent.success,true);
    const contract=r.structuredContent.output;
    assert.deepEqual(contract.input_schema,catalog.find(t=>t.name===name).inputSchema);
    assert.equal(contract.authority.credential,'turn_token');assert.equal(contract.approval,undefined);
    assert.equal(contract.risk,undefined);assert.deepEqual(contract.route,{mode:'direct'});
  }
  assert.equal(f.calls.length,0);
  assert.equal(f.received.filter(x=>JSON.parse(x.text).method==='tools/call').length,2);
  for(const row of f.events.filter(e=>e.event==='mcp_call_finished')){
    assert.equal(row.manifestExtended,true);assert.equal(row.manifestOriginalSuccess,false);assert.equal(row.manifestResultSuccess,true);
    assert.ok(['codex_exec','codex_view_image'].includes(row.manifestQuery));
  }
});

test('native discovery extends broad and coding catalogs; ordinary, unknown and sidecar results stay honest',async t=>{
  const f=await fixture(t),manifest=async args=>(await(await f.post('tools/call',{name:'tool_manifest',arguments:args})).json()).result;
  const broad=await manifest({});assert.deepEqual(broad.structuredContent.output.categories.codex_native,['codex_exec','codex_view_image']);
  assert.equal(broad.structuredContent.output.tool_count,4);assert.equal(broad.content[0].text,'original discovery');
  for(const args of [{category:'codex_native'},{category:'native'}])assert.equal((await manifest(args)).structuredContent.output.tools.length,2);
  for(const args of [{intent:'coding'},{intent:'discovery'}])assert.equal((await manifest(args)).structuredContent.output.tools.length,3);
  assert.equal((await manifest({category:'file'})).structuredContent.output.tools.length,0);
  const normal=await manifest({tool_name:'read_files'});assert.deepEqual(normal.content,[{type:'text',text:'original discovery'}]);
  const unknown=await manifest({tool_name:'codex_missing'});assert.equal(unknown.isError,true);
  for(const key of ['recording_session_id','ack_session_message_ids','context_request','session_message_resolution']){
    const r=await manifest({tool_name:'codex_exec',[key]:'not-native-authority'});
    assert.equal(r.isError,true);assert.equal(r.structuredContent.output.code,'native_manifest_sidecars_unsupported');
  }
  assert.equal(f.calls.length,0);
  f.deny();assert.equal((await f.post('tools/call',{name:'tool_manifest',arguments:{tool_name:'codex_exec'}})).status,403);
});

test('manifest adapter never changes platform/validation errors or truthful native annotations',()=>{
  const {adaptManifest}=require('../union-manifest.cjs');
  const tool={name:'codex_exec',inputSchema:{type:'object',required:['turn_token']},annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}};
  for(const code of ['permission_denied','platform_safety_refusal','invalid_arguments']){
    const envelope={result:{isError:true,structuredContent:{success:false,output:{code,tool_name:tool.name}}}};
    assert.equal(adaptManifest(envelope,{tool_name:tool.name},[tool]),envelope);
  }
  const original={result:{isError:true,structuredContent:{success:false,output:{code:'unknown_tool_manifest_tool',tool_name:tool.name}}}};
  assert.deepEqual(adaptManifest(original,{tool_name:tool.name},[tool]).result.structuredContent.output.annotations,tool.annotations);
});

test('manifest uses exact structured business error despite omitted or false transport error hint',()=>{
 const {adaptManifest}=require('../union-manifest.cjs');
 const native={name:'codex_tool_call',inputSchema:{type:'object'}};
 for(const flag of [{isError:false},{}]){
  const envelope={result:{...flag,resultType:'complete',content:[{type:'text',text:'old missing name'}],structuredContent:{success:false,error:'old missing name',error_code:'INVALID_ARGUMENT',output:{code:'unknown_tool_manifest_tool',tool_name:native.name}}}};
  const result=adaptManifest(envelope,{tool_name:native.name},[native]).result;
  assert.equal(result.structuredContent.success,true);assert.equal(result.structuredContent.output.name,native.name);assert.equal(result.structuredContent.error_code,undefined);
  const refusal={result:{...flag,structuredContent:{success:false,output:{code:'platform_safety_refusal',tool_name:native.name}}}};
  assert.equal(adaptManifest(refusal,{tool_name:native.name},[native]),refusal);
 }
});

test('direct and admitted gateway metadata use the same catalog with no stale error classification',async t=>{
 const f=await fixture(t);
 for(const wrap of [false,true]){
  const query=args=>wrap?{name:'call_runtime_tool',arguments:{tool:'tool_manifest',arguments:args}}:{name:'tool_manifest',arguments:args};
  const exact=await(await f.post('tools/call',query({tool_name:'codex_exec'}))).json();
  assert.equal(exact.result.isError,false);
  assert.equal(exact.result.structuredContent.success,true);
  assert.equal(exact.result.structuredContent.error_code,undefined);
  assert.equal(exact.result.structuredContent.output.name,'codex_exec');
  const broad=await(await f.post('tools/call',query({}))).json();
  assert.deepEqual(broad.result.structuredContent.output.categories.codex_native,['codex_exec','codex_view_image']);
  const normal=await(await f.post('tools/call',query({tool_name:'read_files'}))).json();
  assert.deepEqual(normal.result.content,[{type:'text',text:'original discovery'}]);
 }
 assert.equal(f.calls.length,0);
 assert.equal(f.received.length,6,'one original authority call per lookup; no replay');
 for(const params of [
  {name:'call_runtime_tool',arguments:{tool:'tool_manifest',arguments:{tool_name:'codex_exec'},recording_session_id:'outer-session'}},
  {name:'call_runtime_tool',arguments:{tool:'tool_manifest',arguments:{tool_name:'codex_exec',ack_session_message_ids:['inner-msg']}}}
 ]){
  const r=await(await f.post('tools/call',params)).json();
  assert.equal(r.result.isError,true);assert.equal(r.result.structuredContent.output.code,'native_manifest_sidecars_unsupported');
 }
 // This metadata adapter does not silently add a second native execution path.
 await f.post('tools/call',{name:'call_runtime_tool',arguments:{tool:'codex_exec',arguments:{turn_token:'not-usable'}}});
 assert.equal(f.calls.length,0);
 f.deny();assert.equal((await f.post('tools/call',{name:'call_runtime_tool',arguments:{tool:'tool_manifest',arguments:{tool_name:'codex_exec'}}})).status,403);
});
