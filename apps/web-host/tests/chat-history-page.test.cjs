'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {createPageHistoryFetch}=require('../chat-history-page.cjs');
const {collectChatHistoryUsage}=require('../chat-history-usage.cjs');
const ORIGIN='https://chatgpt.com',PAGE=ORIGIN+'/c/original',NOW=Date.parse('2026-10-14T00:00:00Z'),SECRET='PRIVATE_prompt_html_email_secret';
const auth=()=>({user:{id:'user-a',email:SECRET,name:SECRET},accessToken:'access-'+SECRET,expires:'2026-10-15T00:00:00.000Z',private:SECRET});
const message=(id,extra={})=>({id,author:{role:'assistant',name:SECRET},create_time:(NOW-1000)/1000,end_turn:true,
  recipient:'all',metadata:{model_slug:'gpt-6-pro',private:SECRET},content:{parts:[SECRET]},...extra});
const conversation=messages=>({title:SECRET,files:[SECRET],mapping:Object.fromEntries(messages.map((m,i)=>['private-node-'+i,{message:m,parent:SECRET,children:[SECRET]}]))});
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const authorized=signal=>({method:'GET',redirect:'error',credentials:'include',headers:{Authorization:'Bearer access-'+SECRET},...(signal?{signal}:{})});
async function flush(){for(let i=0;i<90;i++)await Promise.resolve();}
function fixture({fetch:read,overrideEvaluate}={}){
  const session={},wc=Object.assign(new EventEmitter(),{session,isDestroyed:()=>false,getURL:()=>PAGE}),view={webContents:wc};
  const page={id:'original',account:'A',documentGeneration:2,url:PAGE,view,closed:false},calls=[],evaluations=[],results=[];
  const context=vm.createContext({location:{href:PAGE,origin:ORIGIN},document:{},URL,Map,Symbol,Date,AbortController,TextEncoder,TextDecoder,Uint8Array,
    setTimeout,clearTimeout,fetch:async(route,options)=>{calls.push({route,options});return read?read(route,options):route==='/api/auth/session'?json(auth()):
      route.startsWith('/backend-api/conversations?')?json({items:[{id:'conv-a',update_time:(NOW-1000)/1000,title:SECRET}],total:1,private:SECRET}):json(conversation([message('a')]));}});
  const evaluate=overrideEvaluate||(async(contents,expression)=>{assert.equal(contents,wc);evaluations.push(expression);const result=await vm.runInContext(expression,context);results.push(result);return result;});
  let allowed=true;
  const fetchSession=createPageHistoryFetch({page,session,assertCurrent:()=>allowed,evaluate});
  return {page,wc,view,session,calls,evaluations,results,context,fetchSession,setAllowed:value=>allowed=value};
}

test('uses the already-owned page and original session for fixed same-origin reads without any UI action',async t=>{
  const f=fixture();t.after(()=>f.fetchSession.dispose());const result=await collectChatHistoryUsage({account:'A',now:NOW,fetchSession:f.fetchSession});
  assert.equal(result.coverage.state,'complete');assert.equal(result.completedProResponses,1);assert.equal(f.calls.length,4);
  for(const call of f.calls){assert.equal(call.options.method,'GET');assert.equal(call.options.credentials,'include');assert.equal(call.options.cache,'no-store');
    assert.equal(call.options.redirect,'error');assert.equal(call.options.headers.Accept,'application/json');
    assert.deepEqual(Object.keys(call.options.headers).sort(),call.route==='/api/auth/session'?['Accept']:['Accept','Authorization']);}
  assert.equal(f.page.view,f.view);assert.equal(f.page.documentGeneration,2);assert.equal(f.wc.getURL(),PAGE);
  assert.doesNotMatch(JSON.stringify(result),new RegExp(SECRET));
});

test('default evaluator uses only original ordinary page execution without debugger, navigation or input commands',async t=>{
  const f=fixture();f.fetchSession.dispose();const evaluations=[];
  Object.defineProperty(f.wc,'debugger',{get:()=>assert.fail('history must not access or change another observer debugger')});
  f.wc.loadURL=()=>assert.fail('history must not navigate the original page');
  f.wc.sendInputEvent=()=>assert.fail('history must not operate page input');
  f.wc.executeJavaScript=async(expression,userGesture)=>{evaluations.push({userGesture});return vm.runInContext(expression,f.context);};
  const fetchSession=createPageHistoryFetch({page:f.page,session:f.session});t.after(()=>fetchSession.dispose());
  const r=await collectChatHistoryUsage({account:'A',now:NOW,fetchSession});
  assert.equal(r.coverage.state,'complete');assert.equal(r.completedProResponses,1);
  assert.equal(f.calls.length,4);assert.ok(evaluations.length>=5);assert.ok(evaluations.every(call=>call.userGesture===false));
});

test('default evaluator scrubs ordinary page exceptions without exposing the expression or touching debugger',async t=>{
  const f=fixture();f.fetchSession.dispose();let evaluations=0;
  Object.defineProperty(f.wc,'debugger',{get:()=>assert.fail('history must not inspect another observer debugger')});
  f.wc.executeJavaScript=async()=>{evaluations++;throw Error('expression Bearer '+SECRET);};
  const fetchSession=createPageHistoryFetch({page:f.page,session:f.session});t.after(()=>fetchSession.dispose());
  await assert.rejects(fetchSession(ORIGIN+'/api/auth/session'),e=>e.code==='request_failed'&&e.message==='request_failed');
  assert.equal(evaluations,1);assert.equal(f.calls.length,0);
});

test('an unresolved default page execution stays bounded and prevents a duplicate read',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.fetchSession.dispose();let evaluations=0;
  Object.defineProperty(f.wc,'debugger',{get:()=>assert.fail('no debugger fallback')});
  f.wc.executeJavaScript=()=>{evaluations++;return new Promise(()=>{});};
  const fetchSession=createPageHistoryFetch({page:f.page,session:f.session});t.after(()=>fetchSession.dispose());
  const pending=fetchSession(ORIGIN+'/api/auth/session'),assertion=assert.rejects(pending,e=>e.code==='timeout');let settled=false;
  void pending.then(()=>{settled=true;},()=>{settled=true;});await flush();
  t.mock.timers.tick(59999);await flush();assert.equal(settled,false);t.mock.timers.tick(2);await assertion;
  await assert.rejects(fetchSession(ORIGIN+'/api/auth/session'),e=>e.code==='request_failed');assert.equal(evaluations,1);assert.equal(f.calls.length,0);
});

test('a delayed original page evaluation cannot GET after cancellation tombstone expiration',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});const f=fixture();f.fetchSession.dispose();let runDelayed;
  f.wc.executeJavaScript=expression=>expression.startsWith('(async function rendererRead')?
    new Promise(resolve=>{runDelayed=async()=>resolve(await vm.runInContext(expression,f.context));}):vm.runInContext(expression,f.context);
  const fetchSession=createPageHistoryFetch({page:f.page,session:f.session});t.after(()=>fetchSession.dispose());
  const controller=new AbortController(),pending=fetchSession(ORIGIN+'/api/auth/session',{signal:controller.signal});
  const assertion=assert.rejects(pending,e=>e.code==='timeout');await flush();assert.equal(typeof runDelayed,'function');assert.equal(f.calls.length,0);
  controller.abort();await assertion;await flush();
  const state=vm.runInContext('globalThis[Symbol.for("clw.chat-history.reads.v1")]',f.context);assert.equal(state.cancelled.size,1);
  t.mock.timers.tick(60001);await flush();assert.equal(state.cancelled.size,0);
  await runDelayed();await flush();assert.equal(f.calls.length,0);assert.equal(state.requests.size,0);
});

test('a delayed read gets only its remaining original time rather than a fresh sixty-second deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});const f=fixture({fetch:()=>new Promise(()=>{})});f.fetchSession.dispose();let runDelayed;
  f.wc.executeJavaScript=expression=>expression.startsWith('(async function rendererRead')?
    new Promise(resolve=>{runDelayed=async()=>resolve(await vm.runInContext(expression,f.context));}):vm.runInContext(expression,f.context);
  const fetchSession=createPageHistoryFetch({page:f.page,session:f.session});t.after(()=>fetchSession.dispose());
  const pending=fetchSession(ORIGIN+'/api/auth/session'),assertion=assert.rejects(pending,e=>e.code==='timeout');await flush();
  t.mock.timers.tick(50000);const delayed=runDelayed();await flush();assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.signal.aborted,false);
  t.mock.timers.tick(9999);await flush();assert.equal(f.calls[0].options.signal.aborted,false);
  t.mock.timers.tick(2);await assertion;await delayed;await flush();assert.equal(f.calls[0].options.signal.aborted,true);
});

test('auth projection contains only id/token/expiry; listing and detail projections strip every content field before IPC',async t=>{
  const f=fixture();t.after(()=>f.fetchSession.dispose());
  assert.deepEqual(await (await f.fetchSession(ORIGIN+'/api/auth/session')).json(),{user:{id:'user-a'},accessToken:'access-'+SECRET,expires:'2026-10-15T00:00:00.000Z'});
  const list=await (await f.fetchSession(ORIGIN+'/backend-api/conversations?offset=0&limit=100&order=updated',authorized())).json();
  assert.deepEqual(list,{items:[{id:'conv-a',update_time:(NOW-1000)/1000}],total:1});
  const detail=await (await f.fetchSession(ORIGIN+'/backend-api/conversation/conv-a',authorized())).json();
  assert.deepEqual(detail,{mapping:{n0:{message:{author:{role:'assistant'},end_turn:true,id:'a',create_time:(NOW-1000)/1000,recipient:'all',metadata:{model_slug:'gpt-6-pro'}}}}});
  const ipc=f.results.filter(x=>x.payload&&x.payload.includes('mapping'));
  assert.equal(ipc.length,1);assert.doesNotMatch(ipc[0].payload,new RegExp(SECRET));assert.doesNotMatch(JSON.stringify(list),new RegExp(SECRET));
});

test('projects all counting fields without changing visibility, model precedence, time fallback or deduplication',async t=>{
  const messages=[message('a'),message('a'),message('normal',{metadata:{resolved_model_slug:'gpt-6',model_slug:'gpt-6-pro'}}),
    message('resolved',{metadata:{model_slug:'auto',resolved_model_slug:'o3-pro'}}),
    message('hidden',{hidden:true}),message('hidden-meta',{metadata:{model_slug:'gpt-6-pro',is_hidden:true}}),
    message('hidden-vis',{metadata:{model_slug:'gpt-6-pro',is_visually_hidden_from_conversation:true}}),
    message('tool',{recipient:'python'}),message('analysis',{channel:'analysis'}),message('open',{end_turn:false}),
    message('user',{author:{role:'user'}}),message('invalid-create',{create_time:'invalid',update_time:(NOW-1000)/1000}),
    message('fallback',{create_time:null,update_time:(NOW-1000)/1000}),message('bad-resolved',{metadata:{resolved_model_slug:SECRET,model_slug:'gpt-6-pro'}}),
    message('commentary',{channel:'commentary'}),message('zero-channel',{channel:0}),message('invalid-recipient',{recipient:0})];
  const data=conversation(messages),read=route=>route==='/api/auth/session'?json(auth()):route.startsWith('/backend-api/conversations?')?
    json({items:[{id:'conv-a',update_time:(NOW-1000)/1000}],total:1}):json(data);
  const f=fixture({fetch:read});t.after(()=>f.fetchSession.dispose());
  const original=await collectChatHistoryUsage({account:'A',now:NOW,fetchSession:async url=>read(new URL(url).pathname+new URL(url).search)});
  const projected=await collectChatHistoryUsage({account:'A',now:NOW,fetchSession:f.fetchSession});
  assert.deepEqual(projected,original);assert.equal(projected.completedProResponses,5);assert.equal(projected.allCompletedResponses,7);
  assert.doesNotMatch(f.results.filter(x=>x.payload?.includes('mapping')).map(x=>x.payload).join(''),new RegExp(SECRET));
});

test('rejects foreign origins, unexpected query/method/header/body and JS-like parameters before any evaluation',async t=>{
  const f=fixture();t.after(()=>f.fetchSession.dispose());
  for(const [url,options] of [['https://other.example/api/auth/session',{}],['https://chatgpt.com.evil.example/api/auth/session',{}],
    ['javascript:fetch("https://other.example")',{}],[ORIGIN+'/api/auth/session?extra=1',{}],
    [ORIGIN+'/backend-api/conversations?offset=0&limit=100&order=updated&extra=1',authorized()],
    [ORIGIN+'/backend-api/conversations?offset=0&offset=100&limit=100&order=updated',authorized()],
    [ORIGIN+'/backend-api/conversations?offset=500&limit=100&order=updated',authorized()],
    [ORIGIN+'/backend-api/conversation/%22);fetch(SECRET);//',authorized()],
    [ORIGIN+'/api/auth/session',{method:'POST'}],[ORIGIN+'/api/auth/session',{method:'GET',body:'x'}],
    [ORIGIN+'/backend-api/conversation/conv-a',{headers:{Authorization:'Bearer x','User-Agent':'spoof'}}],
    [ORIGIN+'/backend-api/conversation/conv-a',{headers:{Authorization:'Bearer x\nheader'}}]])
    await assert.rejects(f.fetchSession(url,options),e=>['invalid_response','redirect_refused','invalid_auth'].includes(e.code));
  assert.equal(f.calls.length,0);assert.equal(f.evaluations.length,0);
});

test('authorization tokens remain literal values in a fixed expression and cannot execute JavaScript',async t=>{
  const f=fixture();t.after(()=>f.fetchSession.dispose());const token='Bearer x\");globalThis.injected=true;//';
  await f.fetchSession(ORIGIN+'/backend-api/conversation/conv-a',{headers:{Authorization:token}});
  assert.equal(f.context.injected,undefined);assert.equal(f.calls[0].options.headers.Authorization,token);
});

test('403 and 429 return fixed status/headers only, never read HTML and never replay the rejected request',async t=>{
  for(const status of [403,429]){
    let bodyReads=0;const f=fixture({fetch:()=>({status,url:ORIGIN+'/backend-api/conversation/conv-a',redirected:false,
      headers:new Headers({'content-type':'text/html; charset=utf-8','retry-after':'120','cf-mitigated':'challenge','secret':SECRET}),
      body:{getReader(){bodyReads++;assert.fail('refusal body must not be read');}}})});t.after(()=>f.fetchSession.dispose());
    const r=await f.fetchSession(ORIGIN+'/backend-api/conversation/conv-a',authorized());assert.equal(r.status,status);assert.equal(await r.text(),'');
    assert.equal(r.headers.get('content-type'),'text/html');assert.equal(r.headers.get('retry-after'),'120');assert.equal(r.headers.get('cf-mitigated'),'challenge');
    assert.equal(f.calls.length,1);assert.equal(bodyReads,0);assert.doesNotMatch(JSON.stringify(f.results),new RegExp(SECRET));
  }
});

test('rejects owner/account/session/view/document changes before fetching, including same-URL replacement',async t=>{
  for(const change of [f=>f.page.account='B',f=>f.page.documentGeneration++,f=>f.page.view={webContents:f.wc},
    f=>f.wc.session={},f=>f.page.closed=true,f=>f.setAllowed(false),f=>f.wc.getURL=()=>ORIGIN+'/c/new']){
    const f=fixture();t.after(()=>f.fetchSession.dispose());change(f);
    await assert.rejects(f.fetchSession(ORIGIN+'/api/auth/session'),e=>e.code==='account_context_changed');assert.equal(f.calls.length,0);
  }
});

test('a same-URL navigation between binding and fetch cannot issue a read on the new document',async t=>{
  const f=fixture();t.after(()=>f.fetchSession.dispose());await f.fetchSession(ORIGIN+'/api/auth/session');
  f.context.document={};
  await assert.rejects(f.fetchSession(ORIGIN+'/backend-api/conversation/conv-a',authorized()),e=>e.code==='account_context_changed');
  assert.equal(f.calls.length,1);
});

test('original AbortSignal cancels only its original renderer request and releases its lane after acknowledgement',async t=>{
  let aborted=0;const f=fixture({fetch:(_route,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted++;reject(Error(SECRET));},{once:true}))});
  t.after(()=>f.fetchSession.dispose());const controller=new AbortController(),pending=f.fetchSession(ORIGIN+'/backend-api/conversation/conv-a',authorized(controller.signal));
  const assertion=assert.rejects(pending,e=>e.code==='timeout');await flush();assert.equal(f.calls.length,1);controller.abort();await assertion;await flush();
  assert.equal(aborted,1);assert.equal(f.calls[0].options.signal.aborted,true);
  const already=new AbortController();already.abort();await assert.rejects(f.fetchSession(ORIGIN+'/api/auth/session',{signal:already.signal}),e=>e.code==='timeout');
  assert.equal(f.calls.length,1);
});

test('navigation rejects immediately, discards late replies and never cancels a replacement owner',async t=>{
  let resolve;const f=fixture({fetch:()=>new Promise(r=>{resolve=r;})});t.after(()=>f.fetchSession.dispose());
  const pending=f.fetchSession(ORIGIN+'/api/auth/session'),assertion=assert.rejects(pending,e=>e.code==='account_context_changed');await flush();
  f.page.documentGeneration++;f.context.document={};f.wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});
  await assertion;const evaluated=f.evaluations.length;resolve(json(auth()));await flush();
  assert.equal(f.evaluations.length,evaluated);await assert.rejects(f.fetchSession(ORIGIN+'/api/auth/session'),e=>e.code==='account_context_changed');
  assert.equal(f.calls.length,1);assert.equal(f.wc.listenerCount('did-start-navigation'),0);
});

test('subframe navigation does not dispose the original main document',async t=>{
  const f=fixture();t.after(()=>f.fetchSession.dispose());f.wc.emit('did-start-navigation',{isMainFrame:false,isSameDocument:false});
  assert.equal((await f.fetchSession(ORIGIN+'/api/auth/session')).status,200);
});

test('same-document events on the unchanged original URL do not abort a read or dispose later reads',async t=>{
  for(const legacy of [false,true]){
    let resolve,first=true;const f=fixture({fetch:()=>first?(first=false,new Promise(r=>{resolve=r;})):json(auth())});t.after(()=>f.fetchSession.dispose());
    const pending=f.fetchSession(ORIGIN+'/api/auth/session');await flush();assert.equal(f.calls.length,1);
    if(legacy)f.wc.emit('did-start-navigation',{},PAGE,true,true);
    else f.wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true});
    assert.equal(f.calls[0].options.signal.aborted,false);resolve(json(auth()));
    assert.equal((await pending).status,200);assert.equal((await f.fetchSession(ORIGIN+'/api/auth/session')).status,200);
    assert.equal(f.calls.length,2);assert.equal(f.wc.listenerCount('did-start-navigation'),1);
  }
});

test('ignoring same-document events never accepts changed URL, view, session, generation or document tokens',async t=>{
  for(const change of [f=>f.wc.getURL=()=>ORIGIN+'/c/changed',f=>f.page.view={webContents:f.wc},f=>f.wc.session={},
    f=>f.page.documentGeneration++,f=>f.context.document={}]){
    let resolve;const f=fixture({fetch:()=>new Promise(r=>{resolve=r;})});t.after(()=>f.fetchSession.dispose());
    const pending=f.fetchSession(ORIGIN+'/api/auth/session'),assertion=assert.rejects(pending,e=>e.code==='account_context_changed');await flush();
    change(f);f.wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true});resolve(json(auth()));await assertion;
    if(f.context.document!==undefined&&f.page.view===f.view&&f.wc.session===f.session&&f.page.documentGeneration===2&&f.wc.getURL()===PAGE)
      await assert.rejects(f.fetchSession(ORIGIN+'/api/auth/session'),e=>e.code==='account_context_changed');
    assert.equal(f.calls.length,1);
  }
});

test('a same-document event targeting a new URL immediately cancels instead of waiting for a late read',async t=>{
  for(const legacy of [false,true]){
    let resolve;const f=fixture({fetch:()=>new Promise(r=>{resolve=r;})});t.after(()=>f.fetchSession.dispose());
    const pending=f.fetchSession(ORIGIN+'/api/auth/session'),assertion=assert.rejects(pending,e=>e.code==='account_context_changed');await flush();
    // The event target can change before WebContents.getURL has updated.
    if(legacy)f.wc.emit('did-start-navigation',{},ORIGIN+'/c/changed',true,true);
    else f.wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true,url:ORIGIN+'/c/changed'});
    await assertion;await flush();assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.wc.listenerCount('did-start-navigation'),0);
    resolve(json(auth()));await flush();assert.equal(f.calls.length,1);
  }
});

test('dispose fences new requests and cancels an active original read without any page/task action',async t=>{
  let aborted=false;const f=fixture({fetch:(_route,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(Error(SECRET));},{once:true}))});
  const pending=f.fetchSession(ORIGIN+'/api/auth/session'),assertion=assert.rejects(pending,e=>e.code==='account_context_changed');await flush();f.fetchSession.dispose();
  await assertion;await flush();assert.equal(aborted,true);assert.equal(f.wc.listenerCount('destroyed'),0);
  await assert.rejects(f.fetchSession(ORIGIN+'/api/auth/session'),e=>e.code==='account_context_changed');assert.equal(f.calls.length,1);
});

test('outer deadline and renderer deadline stay finite when the fetch ignores AbortSignal',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture({fetch:()=>new Promise(()=>{})});t.after(()=>f.fetchSession.dispose());
  // Install the mock timers in the renderer fixture as a real page would use its own clock.
  f.context.setTimeout=setTimeout;f.context.clearTimeout=clearTimeout;
  const pending=f.fetchSession(ORIGIN+'/api/auth/session'),assertion=assert.rejects(pending,e=>e.code==='timeout');await flush();
  t.mock.timers.tick(60001);await assertion;await flush();assert.equal(f.calls.length,1);
});

test('an unconfirmed original evaluation cannot accumulate subsequent reads',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let attempts=0;
  const f=fixture({overrideEvaluate:async()=>{attempts++;return new Promise(()=>{});}});t.after(()=>f.fetchSession.dispose());
  const pending=f.fetchSession(ORIGIN+'/api/auth/session'),assertion=assert.rejects(pending,e=>e.code==='timeout');await flush();
  t.mock.timers.tick(60001);await assertion;
  await assert.rejects(f.fetchSession(ORIGIN+'/api/auth/session'),e=>e.code==='request_failed');assert.equal(attempts,1);assert.equal(f.calls.length,0);
  f.fetchSession.dispose();
  const replacement=createPageHistoryFetch({page:f.page,session:f.session,evaluate:()=>assert.fail('unknown original evaluation must retain its document lane')});
  t.after(()=>replacement.dispose());await assert.rejects(replacement(ORIGIN+'/api/auth/session'),e=>e.code==='request_failed');
});

test('owner getter exceptions are fixed and destroyed original pages cannot produce late data',async t=>{
  const f=fixture();t.after(()=>f.fetchSession.dispose());f.wc.getURL=()=>{throw Error(SECRET);};
  await assert.rejects(f.fetchSession(ORIGIN+'/api/auth/session'),e=>e.message==='account_context_changed');
  assert.throws(()=>createPageHistoryFetch({page:f.page,session:f.session,evaluate:()=>{}}),e=>e.message==='account_context_changed');
  assert.equal(f.calls.length,0);
});

test('raw 32MiB bound applies before JSON parsing and projected 2MiB bound applies before IPC',async t=>{
  for(const read of [()=>new Response('x',{headers:{'content-length':String(32*1024*1024+1)}}),
    ()=>new Response('x'.repeat(32*1024*1024+1)),
    ()=>json(conversation(Array.from({length:10000},(_,i)=>message('message-'+i+'x'.repeat(180)))))]){
    const f=fixture({fetch:read});t.after(()=>f.fetchSession.dispose());
    await assert.rejects(f.fetchSession(ORIGIN+'/backend-api/conversation/conv-a',authorized()),e=>e.code==='response_too_large');
    assert.equal(f.calls.length,1);assert.equal(f.results.filter(x=>x.payload).length,0);
  }
});

test('a greater-than-eight-MiB original reply keeps unused content in renderer and returns only small counting metadata',async t=>{
  const data=conversation([message('large-original',{content:{parts:[SECRET,'x'.repeat(9*1024*1024)]},attachments:[{body:'x'.repeat(1024*1024),name:SECRET}]})]);
  const rawSize=Buffer.byteLength(JSON.stringify(data));assert.ok(rawSize>8*1024*1024&&rawSize<32*1024*1024);
  const f=fixture({fetch:()=>json(data)});t.after(()=>f.fetchSession.dispose());
  const response=await f.fetchSession(ORIGIN+'/backend-api/conversation/conv-a',authorized()),projected=await response.json();
  assert.equal(projected.mapping.n0.message.id,'large-original');assert.equal(projected.mapping.n0.message.metadata.model_slug,'gpt-6-pro');
  const payload=f.results.find(x=>x.payload)?.payload;assert.ok(Buffer.byteLength(payload)<1024);
  assert.doesNotMatch(payload,new RegExp(SECRET));assert.equal(projected.mapping.n0.message.content,undefined);assert.equal(projected.mapping.n0.message.attachments,undefined);
});

test('a read may take fifty seconds while retaining its original owner and finite sixty-second deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture({fetch:()=>new Promise(resolve=>setTimeout(()=>resolve(json(auth())),50000))});
  t.after(()=>f.fetchSession.dispose());f.context.setTimeout=setTimeout;f.context.clearTimeout=clearTimeout;let done=false;
  const pending=f.fetchSession(ORIGIN+'/api/auth/session').then(value=>{done=true;return value;});await flush();
  t.mock.timers.tick(30001);await flush();assert.equal(done,false);assert.equal(f.calls.length,1);
  t.mock.timers.tick(20000);await flush();assert.equal((await pending).status,200);assert.equal(done,true);
});

test('renderer parse and evaluate exceptions become fixed codes without body/token/error text',async t=>{
  for(const read of [()=>new Response(SECRET),()=>json({mapping:[]}),()=>{throw Error(SECRET);}]){
    const f=fixture({fetch:read});t.after(()=>f.fetchSession.dispose());
    await assert.rejects(f.fetchSession(ORIGIN+'/backend-api/conversation/conv-a',authorized()),e=>{
      assert.doesNotMatch(e.message,new RegExp(SECRET));return ['invalid_response','request_failed'].includes(e.code);});
    assert.doesNotMatch(JSON.stringify(f.results),new RegExp(SECRET));
  }
  const f=fixture({overrideEvaluate:()=>{throw Error('expression access-'+SECRET);}});t.after(()=>f.fetchSession.dispose());
  await assert.rejects(f.fetchSession(ORIGIN+'/api/auth/session'),e=>e.message==='request_failed');
});
