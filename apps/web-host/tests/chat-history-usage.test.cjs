'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {collectChatHistoryUsage,sanitizeUsage}=require('../chat-history-usage.cjs');
const {AccountQuota}=require('../account-quota.cjs');
const NOW=Date.parse('2026-10-13T00:00:00.000Z'),DAY=86400000,SECRET='SECRET_token_email_body_id';
function auth(id='user-'+SECRET){return {user:{id,email:SECRET+'@example.com'},accessToken:'access-'+SECRET,expires:new Date(NOW+DAY).toISOString()};}
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}
function message(id,at=NOW-1000,model='gpt-6-pro',extra={}){
  return {id,create_time:at/1000,author:{role:'assistant'},recipient:'all',end_turn:true,
    content:{parts:[SECRET]},metadata:{model_slug:model},...extra};
}
function conversation(messages=[]){return {title:SECRET,mapping:Object.fromEntries(messages.map((m,i)=>['node-'+i,{message:m}]))};}
async function flush(){for(let i=0;i<80;i++)await Promise.resolve();}
async function finishWithTimers(t,promise,{step=500,maxTicks=40}={}){
  let done=false,result,error;promise.then(x=>{result=x;done=true;},e=>{error=e;done=true;});
  for(let i=0;i<maxTicks&&!done;i++){await flush();if(!done)t.mock.timers.tick(step);}
  await flush();assert.equal(done,true,'bounded mock clock must settle the collector');if(error)throw error;return result;
}
function fixture({items=[{id:'conv-a',update_time:(NOW-1000)/1000}],total=items.length,conversations={'conv-a':conversation([message('message-'+SECRET)])},sessions=[auth(),auth()],list,detail}={}){
  const calls=[],progress=[];let sessionIndex=0;
  const fetchSession=async(url,options)=>{
    calls.push({url,options});const u=new URL(url);
    assert.equal(u.origin,'https://chatgpt.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
    if(u.pathname==='/api/auth/session')return json(sessions[Math.min(sessionIndex++,sessions.length-1)]);
    assert.equal(options.headers.Authorization,'Bearer access-'+SECRET);
    if(u.pathname==='/backend-api/conversations')return list?list(u):json({items,total});
    const id=decodeURIComponent(u.pathname.slice('/backend-api/conversation/'.length));
    return detail?detail(id,options):json(conversations[id]);
  };
  return {calls,progress,fetchSession,collect:(extra={})=>collectChatHistoryUsage({account:'A',fetchSession,now:NOW,
    onProgress:x=>progress.push(x),...extra})};
}

test('completed visible Pro replies are counted once, with UTC days and no official balance or secrets',async()=>{
  const f=fixture(),result=await f.collect();
  assert.equal(result.coverage.state,'complete');assert.equal(result.coverage.reason,'complete');
  assert.equal(result.completedProResponses,1);assert.equal(result.proConversations,1);
  assert.equal(result.allCompletedResponses,1);assert.equal(result.officialRemaining,null);
  assert.deepEqual(result.window,{start:NOW-7*DAY,end:NOW,source:'rolling_7d'});
  assert.equal(result.byDayTimezone,'UTC');assert.equal(result.byDay[0].date,'2026-10-12');
  assert.deepEqual(result.byModel,[{model:'gpt-6-pro',completedResponses:1,completedProResponses:1}]);
  assert.match(result.accountIdentity,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(result),new RegExp(SECRET));
  assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/api/auth/session').length,2);
  for(const p of f.progress){assert.deepEqual(Object.keys(p).sort(),['account','conversationsListed','conversationsRead','failedConversations','pagesRead']);}
});

test('visibility, recipient, completion, timestamps and resolved model precedence use actual message fields',async()=>{
  const start=NOW-7*DAY;
  const valid=[message('at-start',start),message('resolved',NOW-2000,'auto',{metadata:{model_slug:'auto',resolved_model_slug:'o3-pro'}}),
    message('ordinary',NOW-2000,'gpt-6'),message('default-recipient',NOW-2000,'gpt-6-pro',{recipient:undefined}),
    message('resolved-normal',NOW-2000,'gpt-6-pro',{metadata:{model_slug:'gpt-6-pro',resolved_model_slug:'gpt-6'}})];
  const ignored=[message('old',start-1),message('end',NOW),message('hidden',NOW-1,'gpt-6-pro',{metadata:{model_slug:'gpt-6-pro',is_visually_hidden_from_conversation:true}}),
    message('tool',NOW-1,'gpt-6-pro',{author:{role:'tool'}}),message('non-end',NOW-1,'gpt-6-pro',{end_turn:false}),
    message('recipient',NOW-1,'gpt-6-pro',{recipient:'python'}),message('analysis',NOW-1,'gpt-6-pro',{channel:'analysis'}),
    message('no-time',NOW-1,'gpt-6-pro',{create_time:null,update_time:null})];
  const r=await fixture({conversations:{'conv-a':conversation([...valid,...ignored])}}).collect();
  assert.equal(r.completedProResponses,3);assert.equal(r.allCompletedResponses,5);
  assert.equal(r.byDay[0].date,new Date(start).toISOString().slice(0,10));
  assert.equal(r.byModel.find(x=>x.model==='gpt-6').completedResponses,2);
});

test('auto and professional-like strings never become inferred Pro; private model text is not retained',async()=>{
  const r=await fixture({conversations:{'conv-a':conversation([message('auto',NOW-1000,'auto'),
    message('professional',NOW-1000,'gpt-6-professional'),message('private-model',NOW-1000,SECRET)])}}).collect();
  assert.equal(r.completedProResponses,0);assert.equal(r.allCompletedResponses,3);
  assert.equal(r.byModel.find(x=>x.model==='unknown').completedResponses,1);
  assert.doesNotMatch(JSON.stringify(r),new RegExp(SECRET));
});

test('global message deduplication includes two distinct conversations and repeated mapping nodes',async()=>{
  const shared=message('shared');const f=fixture({items:[{id:'conv-a'},{id:'conv-b'}],
    conversations:{'conv-a':conversation([shared,shared]),'conv-b':conversation([shared,message('unique',NOW-1000,'gpt-6')])}});
  const r=await f.collect();assert.equal(r.completedProResponses,1);assert.equal(r.allCompletedResponses,2);
  assert.equal(r.proConversations,2);assert.equal(r.totalConversations,2);
});

test('custom start remains a non-official bounded window and rejects times outside 90 days without fetching',async()=>{
  const f=fixture();const r=await f.collect({since:NOW-DAY});
  assert.equal(r.window.source,'custom_start');assert.equal(r.window.start,NOW-DAY);assert.equal(r.officialRemaining,null);
  for(const since of [NOW+1,NOW-90*DAY-1,NaN])await assert.rejects(f.collect({since}),/invalid_response/);
  assert.equal(f.calls.length,4);
});

test('long account history with only two recent conversations stops after the verified window boundary',async()=>{
  const items=[{id:'conv-a',update_time:(NOW-1000)/1000},{id:'conv-b',update_time:new Date(NOW-DAY).toISOString()},
    ...Array.from({length:98},(_,i)=>({id:'old-'+i,update_time:(NOW-8*DAY-i*1000)/1000}))];
  const f=fixture({items,total:4000,conversations:{'conv-a':conversation([message('a')]),'conv-b':conversation([message('b')])}});
  const r=await f.collect();assert.equal(r.coverage.state,'complete');assert.equal(r.coverage.paginationComplete,true);
  assert.equal(r.coverage.conversationsListed,2);assert.equal(r.coverage.pagesRead,1);assert.equal(f.calls.length,5);
  assert.equal(r.completedProResponses,2);assert.equal(r.coverage.truncated,false);
});

test('unknown update timestamps cannot pretend the old boundary covers the window',async()=>{
  const f=fixture({list:u=>{
    const offset=Number(u.searchParams.get('offset'));
    return json({total:1000,items:Array.from({length:100},(_,i)=>({id:'conv-'+(offset+i),
      ...(offset+i===0?{}:{update_time:(NOW-8*DAY-(offset+i)*1000)/1000})}))});
  },detail:()=>json(conversation([message('known')]))});
  const r=await f.collect();assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.truncated,true);
  assert.equal(r.coverage.reason,'conversation_limit');assert.equal(r.coverage.pagesRead,5);
  assert.equal(r.coverage.conversationsRead,1);assert.equal(f.calls.length,8);
});

test('out-of-order updates and explicitly missing conversations remain partial',async()=>{
  for(const extra of [{items:[{id:'conv-a',update_time:(NOW-1000)/1000},{id:'old',update_time:(NOW-8*DAY)/1000},
    {id:'later',update_time:(NOW-2000)/1000}]},{items:[{id:'conv-a',update_time:(NOW-1000)/1000}],has_missing_conversations:true}]){
    const f=fixture({list:()=>json({...extra,total:1000})});const r=await f.collect();
    assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.paginationComplete,false);assert.equal(r.coverage.reason,'invalid_response');
  }
});

test('maximum five pages and 500 details remains partial when the window boundary is not covered',async()=>{
  const f=fixture({list:u=>json({total:501,items:Array.from({length:100},(_,i)=>({id:'conv-'+(Number(u.searchParams.get('offset'))+i)}))}),
    detail:()=>json(conversation())});
  const r=await f.collect();assert.equal(r.coverage.conversationsRead,500);assert.equal(r.coverage.pagesRead,5);
  assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.reason,'conversation_limit');assert.equal(f.calls.length,507);
});

test('session auth validates owner and expiry before scanning, and rechecks the same user after scanning',async()=>{
  for(const invalid of [{...auth(),user:{}},{...auth(),expires:new Date(NOW).toISOString()},{...auth(),accessToken:''}]){
    const f=fixture({sessions:[invalid]});const r=await f.collect();assert.equal(r.coverage.state,'failed');
    assert.equal(r.coverage.reason,'invalid_auth');assert.equal(f.calls.length,1);
  }
  const changed=await fixture({sessions:[auth('first'),auth('second')]}).collect();
  assert.equal(changed.coverage.state,'failed');assert.equal(changed.coverage.reason,'account_identity_changed');
  assert.equal(changed.completedProResponses,0);assert.deepEqual(changed.byModel,[]);
  const a=await fixture().collect(),b=await fixture().collect({account:'B'});
  assert.notEqual(a.accountIdentity,b.accountIdentity);
});

test('owner context changes fail the whole batch without returning read identities',async()=>{
  let checks=0;const f=fixture();const r=await f.collect({assertCurrent:()=>{if(++checks>=4)throw Error(SECRET);}});
  assert.equal(r.coverage.state,'failed');assert.equal(r.coverage.reason,'account_context_changed');
  assert.equal(f.calls.length,1);assert.doesNotMatch(JSON.stringify(r),new RegExp(SECRET));
});

test('page-local auth and owner errors preserve their meaning without network retry',async()=>{
  for(const reason of ['invalid_auth','account_context_changed','response_too_large','redirect_refused']){
    let calls=0;
    const result=await collectChatHistoryUsage({account:'A',now:NOW,fetchSession:async()=>{
      calls++;throw Object.assign(Error(SECRET),{code:reason});}});
    assert.equal(result.coverage.reason,reason);assert.equal(calls,1);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(SECRET));
  }
});

test('verified browser challenge metadata is distinct from ordinary HTTP refusal and survives persistence',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-history-challenge-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const q=new AccountQuota(root,'A');
  for(const challenge of [true,false]){
    const f=fixture({detail:()=>new Response(SECRET,{status:403,headers:{'content-type':'text/html',
      ...(challenge?{'cf-mitigated':'challenge'}:{})}})}),result=await f.collect();
    assert.equal(result.coverage.reason,'http_403');
    assert.equal(result.coverage.diagnostic.browserVerification,challenge?true:undefined);
    assert.equal(f.calls.filter(x=>new URL(x.url).pathname.startsWith('/backend-api/conversation/')).length,1);
    q.recordUsage(result);assert.equal(q.snapshot().usage.lastAttempt.coverage.diagnostic.browserVerification,challenge?true:undefined);
    assert.doesNotMatch(fs.readFileSync(q.file,'utf8'),new RegExp(SECRET));
  }
});

test('401, 403 and 429 stop the read batch immediately without later detail or auth requests',async()=>{
  for(const [status,reason] of [[401,'http_401'],[403,'http_403'],[429,'rate_limited']]){
    const f=fixture({items:[{id:'conv-a'},{id:'conv-b'},{id:'conv-c'}],detail:id=>id==='conv-a'?json(conversation([message('a')])):json({error:SECRET},status)});
    const r=await f.collect();assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.reason,reason);
    assert.equal(r.coverage.conversationsRead,1);assert.equal(r.coverage.failedConversations,1);assert.equal(f.calls.length,4);
    assert.doesNotMatch(JSON.stringify(r),new RegExp(SECRET));
  }
});

test('server short Retry-After waits before the same detail GET and exposes fixed waiting progress',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});let attempts=0;
  const f=fixture({detail:()=>++attempts===1?new Response(SECRET,{status:429,headers:{'retry-after':'1'}}):json(conversation([message('a')]))});
  const pending=f.collect();await flush();assert.equal(f.calls.length,3);
  const waiting=f.progress.find(p=>p.reason==='rate_limited');assert.equal(waiting.waitUntil,NOW+1000);
  t.mock.timers.tick(999);await flush();assert.equal(f.calls.length,3);
  t.mock.timers.tick(1);await flush();const r=await pending;assert.equal(attempts,2);assert.equal(r.coverage.state,'complete');
  assert.equal(r.completedProResponses,1);assert.equal(r.coverage.failedConversations,0);assert.equal(r.coverage.diagnostic,undefined);
  assert.equal(f.calls[2].url,f.calls[3].url);assert.deepEqual(f.calls[2].options.headers,f.calls[3].options.headers);
  assert.ok(f.progress.some(p=>p.waitUntil===null&&p.reason===null));assert.doesNotMatch(JSON.stringify(f.progress),new RegExp(SECRET));
});

test('auth and list use the same bounded Retry-After handling without network retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});let authReads=0,listReads=0;
  const f=fixture(),fetchSession=async(url,options)=>{
    const path=new URL(url).pathname;
    if(path==='/api/auth/session'&&++authReads===1)return new Response(SECRET,{status:429,headers:{'retry-after':'1'}});
    if(path==='/backend-api/conversations'&&++listReads===1)return new Response(SECRET,{status:429,headers:{'retry-after':'2'}});
    return f.fetchSession(url,options);
  };
  const r=await finishWithTimers(t,f.collect({fetchSession}));assert.equal(r.coverage.state,'complete');
  assert.equal(authReads,3);assert.equal(listReads,2);assert.equal(r.completedProResponses,1);
  assert.equal(f.progress.filter(p=>p.reason==='rate_limited').length,2);
});

test('auth and list network errors are never retried, including after an allowed server wait',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});let authRequests=0;
  const authFailure=await collectChatHistoryUsage({account:'A',now:NOW,fetchSession:async()=>{authRequests++;throw Error(SECRET);}});
  assert.equal(authFailure.coverage.reason,'request_failed');assert.equal(authRequests,1);
  const f=fixture({list:()=>{throw Error(SECRET);}}),listFailure=await f.collect();
  assert.equal(listFailure.coverage.reason,'request_failed');assert.equal(f.calls.length,2);
  let afterWait=0;const pending=collectChatHistoryUsage({account:'A',now:NOW,fetchSession:async()=>{
    if(++afterWait===1)return new Response(SECRET,{status:429,headers:{'retry-after':'1'}});throw Error(SECRET);
  }});
  const r=await finishWithTimers(t,pending);assert.equal(r.coverage.reason,'request_failed');assert.equal(afterWait,2);
});

test('a short future HTTP-date Retry-After is obeyed on the original request',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});let attempts=0;
  const f=fixture({detail:()=>++attempts===1?new Response(SECRET,{status:429,headers:{'retry-after':new Date(NOW+2000).toUTCString()}}):json(conversation([message('a')]))});
  const pending=f.collect();await flush();assert.equal(attempts,1);assert.equal(f.progress.find(p=>p.reason==='rate_limited').waitUntil,NOW+2000);
  t.mock.timers.tick(1999);await flush();assert.equal(attempts,1);t.mock.timers.tick(1);await flush();
  assert.equal((await pending).coverage.state,'complete');assert.equal(attempts,2);
});

test('repeated short 429 responses have exactly three total attempts and only two server waits',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});
  const f=fixture({detail:()=>new Response(SECRET,{status:429,headers:{'retry-after':'1'}})});
  const r=await finishWithTimers(t,f.collect());assert.equal(r.coverage.reason,'rate_limited');assert.equal(r.coverage.state,'failed');
  assert.equal(f.calls.length,5);assert.equal(f.calls.filter(c=>new URL(c.url).pathname.startsWith('/backend-api/conversation/')).length,3);
  assert.equal(f.progress.filter(p=>p.reason==='rate_limited').length,2);assert.equal(r.coverage.failedConversations,1);
});

test('detail network errors and rate waits share one three-attempt budget rather than multiplying retries',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});let attempts=0;
  const f=fixture({detail:()=>{attempts++;if(attempts!==2)throw Error(SECRET);
    return new Response(SECRET,{status:429,headers:{'retry-after':'1'}});}});
  const r=await finishWithTimers(t,f.collect());assert.equal(attempts,3);assert.equal(f.calls.length,5);
  assert.equal(r.coverage.reason,'request_failed');assert.equal(r.coverage.failedConversations,1);
  assert.equal(f.progress.filter(p=>p.reason==='rate_limited').length,1);
});

test('missing, invalid, zero, expired and over-sixty-second Retry-After never trigger a retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});
  for(const retry of [undefined,'',SECRET,'0','-1','61','1.5','Infinity',new Date(NOW-1000).toUTCString(),new Date(NOW+61000).toUTCString()]){
    const f=fixture({detail:()=>new Response(SECRET,{status:429,headers:retry===undefined?{}:{'retry-after':retry}})});
    const r=await f.collect();assert.equal(r.coverage.reason,'rate_limited');assert.equal(f.calls.length,3);
    assert.equal(f.progress.some(p=>p.reason==='rate_limited'),false);
  }
});

test('401 and unknown 403 still stop immediately even when a short Retry-After header is supplied',async()=>{
  for(const status of [401,403]){
    const f=fixture({detail:()=>new Response(SECRET,{status,headers:{'retry-after':'1','content-type':'text/html'}})});
    const r=await f.collect();assert.equal(f.calls.length,3);assert.equal(r.coverage.reason,'http_'+status);
    assert.equal(r.coverage.diagnostic.browserVerification,undefined);assert.equal(f.progress.some(p=>p.waitUntil),false);
  }
});

test('owner changes during a server-directed wait stop before any retry or later read',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});let allowed=true;
  const f=fixture({detail:()=>new Response(SECRET,{status:429,headers:{'retry-after':'1'}})});
  const pending=f.collect({assertCurrent:()=>allowed});await flush();assert.equal(f.calls.length,3);allowed=false;
  t.mock.timers.tick(1000);const r=await pending;assert.equal(f.calls.length,3);assert.equal(r.coverage.reason,'account_context_changed');
  assert.equal(r.coverage.state,'failed');assert.equal(r.completedProResponses,0);assert.ok(f.progress.some(p=>p.waitUntil===null));
});

test('request pacing precedes the HTTP deadline and does not turn a valid slow response into timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});const starts=[];
  const f=fixture({list:()=>new Promise(resolve=>setTimeout(()=>resolve(json({items:[{id:'conv-a',update_time:(NOW-1000)/1000}],total:1})),9999))});
  const fetchSession=(url,options)=>{starts.push(Date.now());return f.fetchSession(url,options);};
  const pending=f.collect({requestIntervalMs:12000,fetchSession});await flush();assert.equal(f.calls.length,1);
  t.mock.timers.tick(11999);await flush();assert.equal(f.calls.length,1);
  t.mock.timers.tick(1);await flush();assert.equal(f.calls.length,2);
  t.mock.timers.tick(9999);await flush();assert.equal(f.calls.length,2);
  t.mock.timers.tick(2001);await flush();assert.equal(f.calls.length,3);
  const r=await finishWithTimers(t,pending,{step:12000});assert.equal(r.coverage.state,'complete');assert.equal(r.completedProResponses,1);
  assert.deepEqual(starts.map(at=>at-NOW),[0,12000,24000,36000]);
  assert.ok(f.progress.some(p=>p.reason==='request_interval'));assert.doesNotMatch(JSON.stringify(f.progress),new RegExp(SECRET));
});

test('invalid request pacing is rejected before any account request',async()=>{
  const f=fixture();for(const requestIntervalMs of [-1,0.5,NaN,Infinity,60001,'1000'])await assert.rejects(f.collect({requestIntervalMs}),/invalid_response/);
  assert.equal(f.calls.length,0);
});

test('one detail network gap retries three times, then later independent IDs still complete',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({items:[{id:'conv-a'},{id:'conv-b'},{id:'conv-c'}],detail:id=>{
    if(id==='conv-b')throw Error(SECRET);return json(conversation([message(id)]));}});
  const r=await finishWithTimers(t,f.collect());assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.reason,'request_failed');
  assert.equal(f.calls.length,8);assert.equal(r.coverage.failedConversations,1);assert.equal(r.coverage.conversationsRead,2);
  assert.equal(r.completedProResponses,2);assert.equal(r.coverage.diagnostic.stage,'detail');
  assert.doesNotMatch(JSON.stringify(r),new RegExp(SECRET));
});

test('temporary detail network failure is retried within the same ID and never double-counted',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let attempts=0;
  const f=fixture({detail:()=>{if(++attempts<3)throw Error(SECRET);return json(conversation([message('a')]));}});
  const r=await finishWithTimers(t,f.collect());assert.equal(attempts,3);assert.equal(r.coverage.state,'complete');
  assert.equal(r.completedProResponses,1);assert.equal(r.coverage.failedConversations,0);assert.equal(r.coverage.diagnostic,undefined);
});

test('three consecutive detail IDs with no network progress stop after bounded retries',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({items:[{id:'conv-a'},{id:'failed-1'},{id:'failed-2'},{id:'failed-3'},{id:'untouched'}],detail:id=>{
    if(id==='conv-a')return json(conversation([message('a')]));throw Error(SECRET);}});
  const r=await finishWithTimers(t,f.collect());assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.reason,'request_failed');
  assert.equal(r.coverage.failedConversations,3);assert.equal(r.coverage.conversationsRead,1);assert.equal(f.calls.length,12);
  assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/api/auth/session').length,1);
  assert.equal(f.calls.some(c=>c.url.endsWith('/untouched')),false);
});

test('a successful independent detail resets the consecutive network-failure stop',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({items:[{id:'failed-1'},{id:'failed-2'},{id:'conv-a'},{id:'failed-3'},{id:'conv-b'}],detail:id=>{
    if(id.startsWith('failed-'))throw Error(SECRET);return json(conversation([message(id)]));}});
  const r=await finishWithTimers(t,f.collect());assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.conversationsRead,2);
  assert.equal(r.coverage.failedConversations,3);assert.equal(r.completedProResponses,2);
  assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/api/auth/session').length,2);
});

test('details allow a fifty-second response while auth and listing keep ten-second deadlines',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let done=false;
  const f=fixture({detail:()=>new Promise(resolve=>setTimeout(()=>resolve(json(conversation([message('a')]))),50000))});
  const pending=f.collect().then(x=>{done=true;return x;});await flush();t.mock.timers.tick(10001);await flush();
  assert.equal(done,false);assert.equal(f.calls.length,3);
  t.mock.timers.tick(40000);await flush();const r=await pending;assert.equal(r.coverage.state,'complete');assert.equal(r.completedProResponses,1);
});

test('detail sixty-second timeouts have bounded retries and leave a gap instead of losing later counts',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({items:[{id:'conv-a'},{id:'conv-b'}],detail:id=>id==='conv-a'?new Promise(()=>{}):json(conversation([message('b')]))});
  const pending=f.collect();await flush();t.mock.timers.tick(59999);await flush();assert.equal(f.calls.length,3);
  const r=await finishWithTimers(t,pending,{step:60001});
  assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.reason,'timeout');assert.equal(r.coverage.failedConversations,1);
  assert.equal(r.completedProResponses,1);assert.equal(f.calls.length,7);
});

test('the detail deadline covers a delayed body as well as response headers',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const bytes=Buffer.from(JSON.stringify(conversation([message('a')])));let emitted=false,done=false;
  const f=fixture({detail:()=>({status:200,headers:new Headers({'content-type':'application/json'}),body:{getReader:()=>({
    read:()=>emitted?Promise.resolve({done:true}):new Promise(resolve=>setTimeout(()=>{emitted=true;resolve({done:false,value:bytes});},50000)),
    releaseLock(){},cancel(){}})}})});
  const pending=f.collect().then(x=>{done=true;return x;});await flush();t.mock.timers.tick(10001);await flush();assert.equal(done,false);
  t.mock.timers.tick(40000);await flush();const r=await pending;assert.equal(r.coverage.state,'complete');assert.equal(r.completedProResponses,1);
});

test('a list timeout stops at the original ten-second deadline without retrying auth or starting details',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture({list:()=>new Promise(()=>{})});
  const pending=f.collect();await flush();t.mock.timers.tick(10001);const r=await pending;
  assert.equal(r.coverage.reason,'timeout');assert.equal(r.coverage.state,'failed');assert.equal(f.calls.length,2);
  assert.equal(r.coverage.diagnostic.stage,'list');
});

test('each request has a real timeout even when a fetch adapter ignores AbortSignal',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=collectChatHistoryUsage({account:'A',now:NOW,fetchSession:()=>new Promise(()=>{})});
  for(let i=0;i<6;i++)await Promise.resolve();t.mock.timers.tick(10001);
  const r=await pending;assert.equal(r.coverage.state,'failed');assert.equal(r.coverage.reason,'timeout');
});

test('bounded body reads reject oversized responses, malformed JSON and all redirects',async()=>{
  for(const [response,reason] of [[new Response('x',{headers:{'content-length':String(8*1024*1024+1)}}),'response_too_large'],
    [new Response('x'.repeat(8*1024*1024+1)),'response_too_large'],[new Response(SECRET),'invalid_response'],
    [new Response('',{status:302,headers:{location:'https://other.example'}}),'redirect_refused']]){
    const r=await collectChatHistoryUsage({account:'A',now:NOW,fetchSession:async()=>response});
    assert.equal(r.coverage.state,'failed');assert.equal(r.coverage.reason,reason);assert.doesNotMatch(JSON.stringify(r),new RegExp(SECRET));
  }
});

test('an individual unreadable conversation stays partial while later valid reads can finish',async()=>{
  const f=fixture({items:[{id:'conv-a'},{id:'conv-b'}],detail:id=>id==='conv-a'?json({error:SECRET},503):json(conversation([message('b')]))});
  const r=await f.collect();assert.equal(r.coverage.state,'partial');assert.equal(r.coverage.reason,'http_5xx');
  assert.equal(r.coverage.failedConversations,1);assert.equal(r.completedProResponses,1);assert.equal(f.calls.length,5);
});

test('fixed diagnostics retain refusal status and safe headers without response text or request identities',async()=>{
  for(const [status,reason,retry,retryValue] of [[403,'http_403',null,null],[429,'rate_limited','120',120],
    [429,'rate_limited','Wed, 14 Oct 2026 01:30:00 GMT','2026-10-14T01:30:00.000Z']]){
    const f=fixture({detail:()=>new Response(SECRET,{status,headers:{'content-type':'text/html; charset=utf-8',
      ...(retry?{'retry-after':retry}:{}),'x-private':SECRET}})}),r=await f.collect();
    assert.equal(r.coverage.reason,reason);assert.equal(f.calls.length,3);
    const d=r.coverage.diagnostic;assert.equal(d.stage,'detail');assert.equal(d.code,reason);assert.equal(d.status,status);
    assert.equal(d.contentType,'text/html');assert.equal(d.retryAfter,retryValue);assert.ok(Number.isSafeInteger(d.elapsedMs));
    assert.doesNotMatch(JSON.stringify(r),new RegExp(SECRET));
    const clean=sanitizeUsage({...r,coverage:{...r.coverage,diagnostic:{...d,url:SECRET,body:SECRET,token:SECRET,
      contentType:SECRET,retryAfter:SECRET}}},'A');
    assert.equal(clean.coverage.diagnostic.contentType,null);assert.equal(clean.coverage.diagnostic.retryAfter,null);
    assert.doesNotMatch(JSON.stringify(clean),new RegExp(SECRET));
  }
});

test('partial counts and fixed diagnostics persist only as a failed attempt, never replacing the last complete count',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-history-partial-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const q=new AccountQuota(root,'A',{now:()=>NOW});q.recordUsage(await fixture().collect());
  const partial=await fixture({items:[{id:'conv-a'},{id:'conv-b'}],detail:id=>id==='conv-a'?json({},503):json(conversation([message('b'),message('c')]))}).collect();
  assert.equal(partial.completedProResponses,2);q.recordUsage(partial);
  const r=new AccountQuota(root,'A').snapshot();assert.equal(r.usage.lastGood.completedProResponses,1);
  assert.equal(r.usage.stale,true);assert.equal(r.usage.lastAttempt.coverage.state,'partial');
  assert.equal(r.usage.lastAttempt.coverage.diagnostic.status,503);
  assert.doesNotMatch(fs.readFileSync(q.file,'utf8'),new RegExp(SECRET));
});

test('quota persistence keeps last good on read failures, isolates A/B and never overwrites an exhausted report',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-history-usage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const q=new AccountQuota(root,'A',{now:()=>NOW});q.report('latest-pro',{exhausted:true,resetText:'User recorded reset'});
  const good=await fixture().collect();q.recordUsage({...good,accessToken:SECRET,email:SECRET,prompt:SECRET});
  const failure=await fixture({detail:()=>json({error:SECRET},403)}).collect();q.recordUsage(failure);
  const restarted=new AccountQuota(root,'A',{now:()=>NOW}),s=restarted.snapshot();
  assert.equal(s.usage.lastGood.completedProResponses,1);assert.equal(s.usage.lastAttempt.coverage.reason,'http_403');
  assert.equal(s.usage.stale,true);assert.equal(s.models[0].status,'exhausted');assert.equal(s.officialRemaining,null);
  assert.equal(new AccountQuota(root,'B').snapshot().usage.lastGood,null);
  assert.doesNotMatch(fs.readFileSync(q.file,'utf8'),new RegExp(SECRET));
  assert.throws(()=>new AccountQuota(root,'B').recordUsage(good),/invalid_response/);
});

test('a different validated session identity cannot expose another login previous good cache',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-history-owner-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const q=new AccountQuota(root,'A',{now:()=>NOW});q.recordUsage(await fixture({sessions:[auth('old'),auth('old')]}).collect());
  q.recordUsage(await fixture({sessions:[auth('new'),auth('new')],detail:()=>json({},403)}).collect());
  assert.equal(q.snapshot().usage.lastGood,null);assert.equal(q.snapshot().usage.stale,true);
});

test('an identity change during the scan hides the prior login cache without erasing its original record',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-history-switch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const q=new AccountQuota(root,'A',{now:()=>NOW}),old=await fixture({sessions:[auth('old'),auth('old')]}).collect();
  q.recordUsage(old);
  const switched=await fixture({sessions:[auth('old'),auth('new')]}).collect();q.recordUsage(switched);
  assert.notEqual(switched.accountIdentity,old.accountIdentity);assert.equal(switched.coverage.reason,'account_identity_changed');
  assert.equal(q.snapshot().usage.lastGood,null);assert.equal(q.snapshot().usage.stale,true);
  assert.equal(JSON.parse(fs.readFileSync(q.file,'utf8')).usage.lastGood.accountIdentity,old.accountIdentity);
  q.recordUsage(old);
  const changed=await fixture().collect({assertCurrent:()=>false});q.recordUsage(changed);
  assert.equal(q.snapshot().usage.lastGood,null);assert.equal(q.snapshot().usage.lastAttempt.coverage.reason,'account_context_changed');
  q.recordUsage(old);
  const expired=await fixture({sessions:[{...auth(),expires:new Date(NOW).toISOString()}]}).collect();q.recordUsage(expired);
  assert.equal(q.snapshot().usage.lastGood.completedProResponses,1);assert.equal(q.snapshot().usage.stale,true);
});

test('corrupt quota data fails soft and is not replaced by a successful history scan',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-history-corrupt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const q=new AccountQuota(root,'A');fs.mkdirSync(path.dirname(q.file),{recursive:true});fs.writeFileSync(q.file,'{');
  assert.equal(q.snapshot().readFailed,true);assert.equal(q.snapshot().usage.stale,true);
  const good=await fixture().collect();assert.throws(()=>q.recordUsage(good),/unreadable/);assert.equal(fs.readFileSync(q.file,'utf8'),'{');
});
