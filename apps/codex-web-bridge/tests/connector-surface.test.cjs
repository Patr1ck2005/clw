const {test}=require('node:test'),assert=require('node:assert/strict');
const {prepareConnectorSurface}=require('../connector-surface.cjs');
test('authentication redirect stops immediately even without home login button',async()=>{
 let probes=0;
 const host={clearHomeNavigationTimeout(){},view:{webContents:{getURL:()=> 'https://chatgpt.com/?temporary-chat=true',isDestroyed:()=>false,loadURL:()=>assert.fail('must not reload authentication')}}};
 await assert.rejects(prepareConnectorSurface(host,{delay:async()=>assert.fail('must not wait on login'),readSurface:async(_contents,script)=>{
  probes++;
  return require('node:vm').runInNewContext(script,{URL,location:{href:'https://chatgpt.com/auth/login?next=%2F'},document:{querySelectorAll:()=>[],body:{innerText:'Log in to ChatGPT'}}});
 }}),/bridge_login_required/);
 assert.equal(probes,1);
});
test('current signed-out home buttons are recognized without the retired test id',async()=>{
 for(const label of ['登录','Log in','Sign in']){
  let probes=0;
  const login={innerText:label,getAttribute:()=>null,getBoundingClientRect:()=>({width:70,height:35})};
  const host={clearHomeNavigationTimeout(){},view:{webContents:{getURL:()=> 'https://chatgpt.com/?temporary-chat=true',isDestroyed:()=>false,loadURL:()=>assert.fail('login must not be refreshed by verification')}}};
  await assert.rejects(prepareConnectorSurface(host,{delay:async()=>assert.fail('a real login requirement must not wait or retry'),readSurface:async(_contents,script)=>{
   probes++;
   return require('node:vm').runInNewContext(script,{URL,location:{href:'https://chatgpt.com/?temporary-chat=true'},getComputedStyle:()=>({visibility:'visible',display:'block'}),document:{querySelectorAll:selector=>selector==='[data-testid="login-button"],button,a'?[login]:[],body:{innerText:'Welcome'}}});
  }}),/bridge_login_required/);
  assert.equal(probes,1);
 }
});
test('quoted login text and hidden controls cannot turn an unavailable document into login',async()=>{
 let clock=0;
 const hidden={innerText:'Log in',getAttribute:()=>null,getBoundingClientRect:()=>({width:0,height:0})};
 const unrelated={innerText:'登录说明',getAttribute:()=>null,getBoundingClientRect:()=>({width:70,height:35})};
 const host={clearHomeNavigationTimeout(){},view:{webContents:{getURL:()=> 'https://chatgpt.com/?temporary-chat=true',isDestroyed:()=>false,loadURL:()=>assert.fail('nonblank document must remain untouched')}}};
 await assert.rejects(prepareConnectorSurface(host,{timeoutMs:1000,now:()=>clock,delay:async n=>{clock+=n;},readSurface:async(_contents,script)=>require('node:vm').runInNewContext(script,{URL,location:{href:'https://chatgpt.com/?temporary-chat=true'},getComputedStyle:()=>({visibility:'visible',display:'block'}),document:{querySelectorAll:selector=>selector==='[data-testid="login-button"],button,a'?[hidden,unrelated]:[],body:{innerText:'Log in is a phrase in an example'}}})}),/surface_not_ready/);
 assert.equal(clock,1000);
});
test('a visible account access limit stops inspection without reload or model send',async()=>{
 const host={clearHomeNavigationTimeout(){},view:{webContents:{getURL:()=> 'https://chatgpt.com/?temporary-chat=true',isDestroyed:()=>false,loadURL:()=>assert.fail('must not refresh the limited account')}}};
 await assert.rejects(prepareConnectorSurface(host,{readSurface:async()=>({supportedHome:true,accessLimited:true,composer:true,controlsReady:true})}),/account_access_cooldown/);
});
test('slow inspection surface preserves upstream mode without awaiting every resource',async()=>{
 let clock=0,navigations=0,probes=0;
 const host={clearHomeNavigationTimeout(){},view:{webContents:{getURL:()=> 'data:text/html,empty',isDestroyed:()=>false,
  loadURL:url=>{assert.equal(url,'https://chatgpt.com/?temporary-chat=true');navigations++;return new Promise(()=>{});},
  executeJavaScript:async()=>({supportedHome:true,composer:++probes>=4,login:false})}}};
 const result=await prepareConnectorSurface(host,{now:()=>clock,delay:async n=>{clock+=n;},readSurface:wc=>wc.executeJavaScript()});
 assert.equal(navigations,1);assert.equal(result.surfaceReady,true);assert.equal(result.connectorVerified,false);
});
test('login and unavailable surface remain bounded; no message is sent',async()=>{
 for(const login of [true,false]){
  let clock=0;
  const host={clearHomeNavigationTimeout(){},view:{webContents:{getURL:()=> 'https://chatgpt.com/?temporary-chat=true',isDestroyed:()=>false,
   loadURL:()=>assert.fail('existing empty home reloaded'),executeJavaScript:async()=>({supportedHome:true,composer:false,login})}}};
  await assert.rejects(prepareConnectorSurface(host,{timeoutMs:1000,now:()=>clock,delay:async n=>{clock+=n;},readSurface:wc=>wc.executeJavaScript()}),login?/login_required/:/surface_not_ready/);
 }
});
test('a stalled DOM observation cannot exceed the startup deadline',async()=>{
 const host={clearHomeNavigationTimeout(){},view:{webContents:{getURL:()=> 'https://chatgpt.com/?temporary-chat=true',isDestroyed:()=>false}}};
 const start=Date.now();
 await assert.rejects(prepareConnectorSurface(host,{timeoutMs:30,delay:async()=>{},readSurface:()=>new Promise(()=>{})}),/surface_not_ready/);
 assert.ok(Date.now()-start<1500);
});
test('visible account-load failure is distinct from expired login or model capacity',async()=>{
 const host={clearHomeNavigationTimeout(){},view:{webContents:{getURL:()=> 'https://chatgpt.com/?temporary-chat=true',isDestroyed:()=>false}}};
 let probes=0;
 await assert.rejects(prepareConnectorSurface(host,{readSurface:async()=>{probes++;return {supportedHome:true,accountLoadFailed:true,composer:false,login:false};}}),/bridge_account_load_failed/);
 assert.equal(probes,1);
});

test('new input alone is insufficient: wait for actionable form controls and a stable document',async()=>{
 let clock=0,probes=0;
 const host={clearHomeNavigationTimeout(){},view:{webContents:{getURL:()=> 'https://chatgpt.com/?temporary-chat=true',isDestroyed:()=>false}}};
 await prepareConnectorSurface(host,{now:()=>clock,delay:async ms=>{clock+=ms;},readSurface:async()=>({supportedHome:true,composer:true,controlsReady:++probes>=4})});
 assert.equal(clock,3000);assert.equal(probes,7);
});
test('only a proven blank inspection surface gets one bounded cold reload',async()=>{
 for(const recovers of [true,false]){
  let clock=0,reloads=0;
  const host={clearHomeNavigationTimeout(){},view:{webContents:{getURL:()=> 'https://chatgpt.com/?temporary-chat=true',isDestroyed:()=>false,loadURL:async()=>{reloads++;}}}};
  const operation=prepareConnectorSurface(host,{timeoutMs:1000,blankReloadTimeoutMs:2500,now:()=>clock,delay:async ms=>{clock+=ms;},readSurface:async()=>({supportedHome:true,emptyDocument:!(recovers&&reloads),composer:!!(recovers&&reloads),controlsReady:true})});
  if(recovers)assert.equal((await operation).surfaceReady,true);else await assert.rejects(operation,/surface_not_ready/);
  assert.equal(reloads,1);assert.ok(clock<=3500);
 }
});
