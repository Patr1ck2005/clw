'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {NetworkGuard,configureNetworkFlags,normalizeNetworkOptions,proxyEndpoint,DEFAULT_PROXY}=require('../network-guard.cjs');
const {readPreviewConfig,networkOptions,defaultAccount,childEnvironment}=require('../preview-config.cjs');
function flags(options){const result={};configureNetworkFlags({commandLine:{appendSwitch:(name,value)=>result[name]=value}},options);return result;}
function sessionFixture(route='PROXY 127.0.0.1:17890'){
  const calls={setProxy:[],closed:0,resolved:[],fetch:[],permissions:[]};let beforeRequest;
  const ses={
    setProxy:async value=>calls.setProxy.push(value),closeAllConnections:async()=>{calls.closed++;},
    setPermissionRequestHandler:handler=>calls.requestPermission=handler,setPermissionCheckHandler:handler=>calls.checkPermission=handler,
    webRequest:{onBeforeRequest:handler=>{beforeRequest=handler;}},
    resolveProxy:async url=>{calls.resolved.push(url);return route;},
    fetch:async(url,options)=>{calls.fetch.push({url,options});return {ok:true,text:async()=> 'ip=fixture-address\n'};}
  };
  return {ses,calls,request:url=>new Promise(resolve=>beforeRequest({url},resolve))};
}
function manifestFixture(t,value,{readError,lstatError}={}){
  const reads=[],root=path.resolve('preview-installation-fixture'),file=path.join(root,'.local','preview-installation.json');
  t.mock.method(fs,'readFileSync',(actual,encoding)=>{reads.push(actual);assert.equal(actual,file);assert.equal(encoding,'utf8');if(readError)throw readError;return typeof value==='string'?value:JSON.stringify(value);});
  t.mock.method(fs,'lstatSync',actual=>{assert.equal(actual,file);if(lstatError)throw lstatError;return {};});
  return {root,file,reads};
}
test('missing installation manifest preserves the exact legacy policy',t=>{
  const missing=Object.assign(Error('missing'),{code:'ENOENT'}),f=manifestFixture(t,null,{readError:missing,lstatError:missing});
  assert.deepEqual(readPreviewConfig(f.root),{schema:1,legacy:true,network:{mode:'legacy',proxy_url:DEFAULT_PROXY}});
  assert.deepEqual(networkOptions(f.root),{mode:'legacy',proxyUrl:DEFAULT_PROXY});
});
for(const mode of ['system','direct'])test('explicit '+mode+' manifest supplies only network metadata',t=>{
  const f=manifestFixture(t,{schema:1,network:{mode,proxy_url:''},credentials:{secret:'never expose'},installation_id:'private-id'});
  assert.deepEqual(readPreviewConfig(f.root),{schema:1,legacy:false,network:{mode,proxy_url:''}});
  assert.deepEqual(networkOptions(f.root),{mode});assert.equal(f.reads.length,2);
});
test('manual proxy manifest is normalized and may explicitly select any listener',t=>{
  const f=manifestFixture(t,{schema:1,network:{mode:'proxy',proxy_url:'http://proxy.example:17891/'}});
  assert.deepEqual(networkOptions(f.root),{mode:'proxy',proxyUrl:'http://proxy.example:17891'});
  assert.throws(()=>proxyEndpoint('http://127.0.0.1:17891'));
});
test('UTF-8 BOM and empty optional proxy fields are accepted',t=>{
  const f=manifestFixture(t,'\uFEFF'+JSON.stringify({schema:1,network:{mode:'system',proxy_url:null}}));
  assert.deepEqual(networkOptions(f.root),{mode:'system'});
});
test('legacy default account remains B, without a manifest or credential lookup',t=>{
  const missing=Object.assign(Error('missing'),{code:'ENOENT'}),f=manifestFixture(t,null,{readError:missing,lstatError:missing});
  assert.equal(defaultAccount(f.root),'B');assert.equal(f.reads.length,1);
});
for(const [accounts,expected] of [[undefined,'A'],[[{id:'A'}],'A'],[[{id:'B'}],'B'],[[{id:'A'},{id:'B'}],'A'],[[{id:'B'},{id:'A'}],'B']])
  test('preview default account reads only the first configured slot: '+expected,t=>{
    const f=manifestFixture(t,{schema:1,accounts,credentials:{secret:'do not read'}});assert.equal(defaultAccount(f.root),expected);assert.equal(f.reads.length,1);
  });
for(const accounts of [[],[{id:'C'}],['A'],[{id:'A'},{id:'A'}],[{id:'A'},{id:'B'},{id:'C'}]])
  test('invalid preview account slots fail explicitly: '+JSON.stringify(accounts),t=>{
    const f=manifestFixture(t,{schema:1,accounts});assert.throws(()=>defaultAccount(f.root),error=>error.code==='preview_installation_invalid');
  });
test('child environments preserve the system choice, clear direct proxies, and fix manual/legacy routes',()=>{
  const base={PATH:'retained',HTTP_PROXY:'http://os-proxy:8080',https_proxy:'http://os-secure:8081',ALL_PROXY:'socks5://old:1080',NO_PROXY:'*',no_proxy:'*'};
  const system=childEnvironment('unused',base,{mode:'system'});assert.equal(system.HTTP_PROXY,base.HTTP_PROXY);assert.equal(system.https_proxy,base.https_proxy);
  assert.equal(system.NO_PROXY,'127.0.0.1,localhost,::1');assert.equal(system.no_proxy,undefined);
  const direct=childEnvironment('unused',base,{mode:'direct'});for(const key of ['HTTP_PROXY','https_proxy','ALL_PROXY'])assert.equal(direct[key],undefined);
  for(const options of [{mode:'legacy',proxyUrl:DEFAULT_PROXY},{mode:'proxy',proxyUrl:'https://proxy.example:8443'}]){
    const env=childEnvironment('unused',base,options);for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'])assert.equal(env[key],options.proxyUrl);
    assert.equal(env.https_proxy,undefined);assert.equal(env.NO_PROXY,'127.0.0.1,localhost,::1');assert.equal(env.PATH,'retained');
  }
  assert.equal(base.NO_PROXY,'*');assert.equal(base.no_proxy,'*');
});
test('child environment policy is read from this installation manifest',t=>{
  const f=manifestFixture(t,{schema:1,network:{mode:'direct'}}),env=childEnvironment(f.root,{HTTPS_PROXY:'http://wrong:80'});
  assert.equal(env.HTTPS_PROXY,undefined);assert.equal(f.reads.length,1);
});
test('preview children disable runtime diagnostics without changing inherited or legacy settings',()=>{
  const base={powershell_telemetry_optout:'0',DO_NOT_TRACK:'0',Path:'unchanged'};
  for(const options of [{mode:'system'},{mode:'direct'},{mode:'proxy',proxyUrl:'https://proxy.example:443'}]){
    const env=childEnvironment('unused',base,options);
    assert.equal(env.POWERSHELL_TELEMETRY_OPTOUT,'1');assert.equal(env.DO_NOT_TRACK,'1');
    assert.equal(env.powershell_telemetry_optout,undefined);assert.equal(env.Path,base.Path);
  }
  const legacy=childEnvironment('unused',base,{mode:'legacy',proxyUrl:DEFAULT_PROXY});
  assert.equal(legacy.powershell_telemetry_optout,'0');assert.equal(legacy.DO_NOT_TRACK,'0');
  assert.deepEqual(base,{powershell_telemetry_optout:'0',DO_NOT_TRACK:'0',Path:'unchanged'});
});
for(const value of ['broken json',null,[],{schema:2,network:{mode:'direct'}},{schema:1},
  {schema:1,network:[]},{schema:1,network:{mode:'legacy'}},{schema:1,network:{mode:'automatic'}},
  {schema:1,network:{mode:'proxy'}},{schema:1,network:{mode:'direct',proxy_url:'http://proxy.example:80'}},
  {schema:1,network:{mode:'proxy',proxy_url:'http://user:private-secret@proxy.example:8080'}}])
  test('invalid manifest fails clearly without replacing legacy settings: '+JSON.stringify(value).replace(/private-secret/g,'redacted'),t=>{
    const f=manifestFixture(t,value);assert.throws(()=>readPreviewConfig(f.root),error=>error.code==='preview_installation_invalid'&&!error.message.includes('private-secret'));
  });
for(const kind of ['EACCES','EISDIR','dangling'])test('unreadable '+kind+' manifest does not become legacy',t=>{
  const f=manifestFixture(t,null,{readError:Object.assign(Error('unreadable'),{code:kind==='dangling'?'ENOENT':kind})});
  assert.throws(()=>networkOptions(f.root),error=>error.code==='preview_installation_unreadable');
});
test('legacy default and string signatures retain flags, route check and trace verification',async()=>{
  assert.deepEqual(flags(),flags(DEFAULT_PROXY));
  assert.deepEqual(flags(),{'proxy-server':DEFAULT_PROXY,'proxy-bypass-list':'<-loopback>','disable-quic':undefined,
    'force-webrtc-ip-handling-policy':'disable_non_proxied_udp','host-resolver-rules':'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'});
  const f=sessionFixture(),guard=new NetworkGuard();const result=await guard.verify(f.ses);
  assert.deepEqual(f.calls.setProxy,[{mode:'fixed_servers',proxyRules:DEFAULT_PROXY,proxyBypassRules:'<-loopback>'}]);
  assert.equal(f.calls.closed,1);assert.equal(f.calls.fetch.length,1);assert.equal(f.calls.fetch[0].url,'https://www.cloudflare.com/cdn-cgi/trace');
  assert.equal(f.calls.fetch[0].options.credentials,'omit');assert.equal(guard.state,'VPN 已连接 · 直连已禁用');assert.equal(guard.ready,true);
  assert.deepEqual(result,{proxy:DEFAULT_PROXY,route:'fixed_proxy',directFallback:false,webrtc:'disable_non_proxied_udp'});
});
test('legacy custom local proxy stays supported without enabling preview modes',async()=>{
  const raw='http://127.0.0.1:12345',f=sessionFixture('PROXY 127.0.0.1:12345'),guard=new NetworkGuard(raw);
  await guard.verify(f.ses);assert.equal(f.calls.setProxy[0].proxyRules,raw);assert.equal(f.calls.fetch.length,1);
  for(const proxy of ['http://127.0.0.1:17891','https://proxy.example:443','http://name:password@127.0.0.1:17890'])assert.throws(()=>new NetworkGuard(proxy));
});
for(const route of ['DIRECT','PROXY 127.0.0.1:17890; DIRECT','PROXY 127.0.0.1:17891'])test('legacy rejects route '+route,async()=>{
  const f=sessionFixture(route),guard=new NetworkGuard();await assert.rejects(()=>guard.verify(f.ses),/VPN 路由/);assert.equal(guard.ready,false);assert.equal(f.calls.fetch.length,0);
});
for(const response of [{ok:false,text:async()=>''},{ok:true,text:async()=> 'not an exit receipt'}])test('legacy still fails when its original trace check fails',async()=>{
  const f=sessionFixture();f.ses.fetch=async()=>response;const guard=new NetworkGuard();await assert.rejects(()=>guard.verify(f.ses),/VPN/);assert.equal(guard.ready,false);
});
test('system mode applies Electron system settings without an external preflight or connection reset',async()=>{
  const f=sessionFixture();f.ses.resolveProxy=async()=>{throw Error('must not resolve PAC before normal navigation');};
  const guard=new NetworkGuard({mode:'system'}),result=await guard.verify(f.ses);
  assert.deepEqual(f.calls.setProxy,[{mode:'system'}]);assert.equal(f.calls.closed,0);assert.equal(f.calls.fetch.length,0);
  assert.equal(result.availability,'not_probed');assert.equal(result.directFallback,null);assert.equal(guard.ready,true);assert.equal(guard.state,'系统网络设置已应用');
  assert.equal(Object.hasOwn(flags({mode:'system'}),'proxy-server'),false);assert.equal(Object.hasOwn(flags({mode:'system'}),'host-resolver-rules'),false);
});
test('direct mode applies only explicit direct settings without a third-party preflight',async()=>{
  const f=sessionFixture('DIRECT'),guard=new NetworkGuard({mode:'direct'}),result=await guard.verify(f.ses);
  assert.deepEqual(f.calls.setProxy,[{mode:'direct'}]);assert.equal(f.calls.closed,0);assert.equal(f.calls.fetch.length,0);assert.equal(guard.state,'直连设置已应用');
  assert.equal(Object.hasOwn(flags({mode:'direct'}),'no-proxy-server'),true);assert.equal(Object.hasOwn(flags({mode:'direct'}),'proxy-server'),false);
  assert.equal(Object.hasOwn(flags({mode:'direct'}),'host-resolver-rules'),false);assert.equal(result.route,'direct');
});
for(const [proxyUrl,route] of [['http://proxy.example:8080','PROXY proxy.example:8080'],['https://proxy.example','HTTPS proxy.example:443'],
  ['http://proxy.example:80','PROXY proxy.example:80'],['socks5://127.0.0.1:1080','SOCKS5 127.0.0.1:1080'],['socks5h://127.0.0.1:1080','SOCKS5 127.0.0.1:1080'],['http://[::1]:8080','PROXY [::1]:8080']])
  test('manual proxy applies exactly '+proxyUrl+' with no direct fallback',async()=>{
    const f=sessionFixture(route),options={mode:'proxy',proxyUrl},guard=new NetworkGuard(options),result=await guard.verify(f.ses);
    assert.deepEqual(f.calls.setProxy,[{mode:'fixed_servers',proxyRules:normalizeNetworkOptions(options).proxyUrl,proxyBypassRules:'<-loopback>'}]);
    assert.equal(f.calls.closed,0);assert.equal(f.calls.fetch.length,0);assert.equal(result.directFallback,false);assert.equal(result.route,'fixed_proxy');
    assert.equal(guard.state,'指定代理已应用 · 不回退直连');assert.equal(flags(options)['proxy-server'],normalizeNetworkOptions(options).proxyUrl);
  });
for(const route of ['DIRECT','PROXY proxy.example:8080; DIRECT','PROXY other.example:8080','PROXY proxy.example:8080; PROXY other.example:8080'])
  test('manual proxy rejects a fallback or different route: '+route,async()=>{
    const f=sessionFixture(route),guard=new NetworkGuard({mode:'proxy',proxyUrl:'http://proxy.example:8080'});
    await assert.rejects(()=>guard.verify(f.ses),/网络路由/);assert.equal(guard.ready,false);assert.equal(f.calls.fetch.length,0);
  });
for(const proxyUrl of ['',undefined,'http://user:secret@proxy.example:8080','http://proxy.example:8080/path','http://proxy.example:8080?token=secret',
  'http://proxy.example:8080#secret','file:///tmp/proxy','ftp://proxy.example:21','socks5://proxy.example',' http://proxy.example:80','http://proxy.example:80\t'])
  test('manual proxy rejects unsupported endpoint '+String(proxyUrl).replace(/secret/g,'redacted'),()=>{
    assert.throws(()=>new NetworkGuard({mode:'proxy',proxyUrl}),error=>/代理地址/.test(error.message)&&!error.message.includes('secret'));
  });
test('direct mode rejects an unexpected proxy route',async()=>{
  const f=sessionFixture('PROXY other.example:80'),guard=new NetworkGuard({mode:'direct'});await assert.rejects(()=>guard.verify(f.ses),/网络路由/);assert.equal(guard.ready,false);
});
test('native proxy resolution uses the protected page session and rejects late direct fallback',async()=>{
  const f=sessionFixture('PROXY proxy.example:8080'),guard=new NetworkGuard({mode:'proxy',proxyUrl:'http://proxy.example:8080'});
  await guard.verify(f.ses);const url='https://chatgpt.com/backend-api/codex/fixture';assert.equal(await guard.resolveProxy(f.ses,url),'PROXY proxy.example:8080');assert.equal(f.calls.resolved.at(-1),url);
  f.ses.resolveProxy=async()=> 'DIRECT';await assert.rejects(()=>guard.resolveProxy(f.ses,url),/网络路由/);assert.equal(f.calls.closed,0);
});
test('simultaneous protection of one session changes network settings only once',async()=>{
  const f=sessionFixture('DIRECT'),guard=new NetworkGuard({mode:'direct'});await Promise.all([guard.protect(f.ses),guard.protect(f.ses),guard.protect(f.ses)]);
  await guard.protect(f.ses);assert.equal(f.calls.setProxy.length,1);assert.equal(f.calls.resolved.length,1);assert.equal(f.calls.closed,0);
});
test('a failed session setup remains retryable without closing its connections',async()=>{
  const f=sessionFixture('DIRECT'),guard=new NetworkGuard({mode:'direct'});let tries=0;f.ses.setProxy=async()=>{if(++tries===1)throw Error('fixture failure');};
  await assert.rejects(()=>guard.protect(f.ses),/fixture failure/);await guard.protect(f.ses);assert.equal(tries,2);assert.equal(f.calls.closed,0);
});
test('all modes retain permitted schemes, local remote-request restrictions and permissions',async()=>{
  for(const options of [{mode:'legacy'},{mode:'system'},{mode:'direct'},{mode:'proxy',proxyUrl:DEFAULT_PROXY}]){
    const f=sessionFixture(options.mode==='direct'?'DIRECT':undefined),guard=new NetworkGuard(options);await guard.protect(f.ses);
    for(const url of ['https://chatgpt.com/','wss://example.test/','data:text/html,fixture','file:///fixture','about:blank','blob:https://example.test/id'])assert.deepEqual(await f.request(url),{cancel:false});
    for(const url of ['http://remote.test/','https://localhost/','https://127.0.0.1/','https://[::1]/','invalid-url'])assert.deepEqual(await f.request(url),{cancel:true});
    for(const permission of ['media','geolocation','notifications'])assert.equal(f.calls.checkPermission(null,permission),false);
    for(const permission of ['clipboard-sanitized-write','fullscreen']){
      assert.equal(f.calls.checkPermission(null,permission),true);let accepted;f.calls.requestPermission(null,permission,value=>accepted=value);assert.equal(accepted,true);
    }
  }
});
