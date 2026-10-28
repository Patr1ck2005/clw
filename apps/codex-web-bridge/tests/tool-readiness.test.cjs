'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {probe,createToolCheck}=require('../tool-readiness.cjs');
const {guardToolRoute}=require('../tool-route.cjs');
const {canReverifyTools}=require('../electron-host.cjs');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-readiness-')),home=path.join(root,'.local','codex-web-bridge');
  fs.mkdirSync(home,{recursive:true});const key=path.join(home,'auth.txt');fs.writeFileSync(key,'Bearer fixture-private');
  fs.writeFileSync(path.join(home,'union-config.json'),JSON.stringify({port:18945,authorizationFile:key}));
  fs.writeFileSync(path.join(home,'shared-entry.json'),JSON.stringify({unionPid:42,url:'http://127.0.0.1:18945/mcp'}));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let health={service:'clw-mcp-union',pid:42},output={name:'codex_tool_call',input_schema:{properties:{turn_token:{type:'string'}},type:'object'}};
  let denied=false,gatewayDenied=false,staleError=false;const calls=[];
  const request=async(url,options={})=>{
    calls.push({url,options});if(url.endsWith('/healthz'))return health;
    assert.equal(options.headers.authorization,'Bearer fixture-private');
    const m=options.body;
    if(m.method==='tools/list')return {result:{tools:[{name:'codex_tool_call',inputSchema:{type:'object',properties:{turn_token:{type:'string'}}}}]}};
    assert.equal(m.method,'tools/call');assert.ok(['tool_manifest','call_runtime_tool'].includes(m.params.name));
    const wrapped=m.params.name==='call_runtime_tool';if(wrapped)assert.equal(m.params.arguments.tool,'tool_manifest');
    assert.deepEqual(wrapped?m.params.arguments.arguments:m.params.arguments,{tool_name:'codex_tool_call',include_recommended_flows:false});
    const fail=denied||(wrapped&&gatewayDenied);
    return {result:{isError:fail,structuredContent:{success:!fail,output,...(staleError?{error_code:'INVALID_ARGUMENT'}:{})}}};
  };
  return {root,request,calls,setHealth:v=>health=v,setOutput:v=>output=v,deny:()=>denied=true,denyGateway:()=>gatewayDenied=true,staleError:()=>staleError=true};
}
test('catalog presence alone is insufficient; matching real manifest admits without execution',async t=>{
  const f=fixture(t);f.setOutput({code:'unknown_tool_manifest_tool',tool_name:'codex_tool_call'});
  assert.equal((await probe(f.root,{request:f.request})).code,'discovery_mismatch');
  f.setOutput({name:'codex_tool_call',input_schema:{type:'object',properties:{turn_token:{type:'string'}}}});
  const r=await probe(f.root,{request:f.request});assert.equal(r.ready,true);assert.equal(r.nativeToolCount,1);
  assert.ok(!JSON.stringify(r).includes('fixture-private'));assert.ok(f.calls.every(c=>!c.options.body||c.options.body.method==='tools/list'||['tool_manifest','call_runtime_tool'].includes(c.options.body.params.name)));
});

test('a passing direct lookup never conceals gateway failure or stale error classification',async t=>{
 const gateway=fixture(t);gateway.denyGateway();
 assert.equal((await probe(gateway.root,{request:gateway.request})).code,'discovery_mismatch');
 const stale=fixture(t);stale.staleError();
 assert.equal((await probe(stale.root,{request:stale.request})).code,'discovery_mismatch');
});
test('a changed owner gets no credentials or catalog request; denials and drift never count as ready',async t=>{
  const f=fixture(t);f.setHealth({service:'clw-mcp-union',pid:43});
  assert.equal((await probe(f.root,{request:f.request})).code,'owner_changed');assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.headers,undefined);
  f.setHealth({service:'clw-mcp-union',pid:42});f.deny();
  assert.equal((await probe(f.root,{request:f.request})).ready,false);
  const error=await probe(f.root,{request:async()=>{throw Error('Bearer fixture-private');}});
  assert.equal(error.code,'unavailable');assert.ok(!JSON.stringify(error).includes('fixture-private'));
});
test('concurrent local checks coalesce and freshness never triggers a browser check',async()=>{
  let count=0,resolve,clock=0;
  const checker=createToolCheck('fixture',{transport:'shared-mcp',now:()=>clock,check:()=>{count++;return new Promise(r=>resolve=r);}});
  const a=checker.check(),b=checker.check({fresh:true});await Promise.resolve();assert.equal(count,1);
  resolve({ready:true});await Promise.all([a,b]);await checker.check();assert.equal(count,1);
  clock=30001;const next=checker.check();await Promise.resolve();assert.equal(count,2);resolve({ready:false,code:'discovery_mismatch'});await next;
  assert.equal(checker.snapshot().ready,false);
  const dedicated=createToolCheck('fixture',{transport:'dedicated',check:()=>{throw Error('must not inspect union');}});
  assert.equal((await dedicated.check({fresh:true})).ready,true);
});
test('new turns stop before a browser send, while health and existing-turn controls remain usable',async()=>{
  let checks=0;
  const guard=guardToolRoute({check:async options=>{assert.equal(options.fresh,true);checks++;return {ready:false,message:'Tool discovery pending'};}});
  for(const endpoint of ['/v1/responses','/v1/responses/compact']){
    const response=await guard(new Request('http://127.0.0.1'+endpoint,{method:'POST',body:'{}'}));
    assert.equal(response.status,503);const body=await response.json();assert.equal(body.error.code,'clw_tool_discovery_not_ready');assert.match(body.error.message,/No Web message was sent/);
  }
  for(const [endpoint,method]of [['/healthz','GET'],['/admin/cancel-turn','POST'],['/v1/responses/existing','GET']])assert.equal(await guard(new Request('http://127.0.0.1'+endpoint,{method})),undefined);
  assert.equal(checks,2);
});

test('startup failure explains unavailability without exposing process output or arbitrary metadata',async t=>{
  const f=fixture(t),folder=path.join(f.root,'.local','web-host');fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,'shared-entry-start.json');
  const unavailable={request:async()=>{throw Error('fixture-private');}};
  fs.writeFileSync(file,JSON.stringify({state:'needs_attention',stage:'backend',reason:'backend_server_not_ready',stderr:'fixture-private'}));
  const result=await probe(f.root,unavailable);
  assert.equal(result.startupReason,'backend_server_not_ready');assert.match(result.message,/后台服务启动尚未就绪/);
  assert.ok(!JSON.stringify(result).includes('fixture-private'));
  for(const saved of [{state:'ready',reason:'backend_server_not_ready'},{state:'needs_attention',reason:'fixture-private'},{state:'needs_attention',reason:'__proto__'}]){
    fs.writeFileSync(file,JSON.stringify(saved));assert.equal((await probe(f.root,unavailable)).startupReason,undefined);
  }
});

test('only recovered local tools can request one connection check; cooldown and other failures stay held',()=>{
  const eligible={status:{state:'tool_service_unavailable',lastError:'bridge_tool_discovery_unavailable'},tools:{ready:true},closed:false,runtimeFailed:false,accessBlocked:false};
  assert.equal(canReverifyTools(eligible),true);
  for(const change of [{closed:true},{runtimeFailed:true},{accessBlocked:true},{tools:{ready:false}},
    {status:{state:'ready'}},{status:{state:'verifying_connector'}},
    {status:{state:'connector_verification_required',lastError:'bridge_login_required'}},
    {status:{state:'tool_service_unavailable',lastError:'bridge_owner_unavailable'}}]){
    assert.equal(canReverifyTools({...eligible,...change}),false);
  }
});
