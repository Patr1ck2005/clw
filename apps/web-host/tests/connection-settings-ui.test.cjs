'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');
test('first connection setup is explicit, preserves routes and stays usable in a compact real browser',async t=>{
 const output=path.resolve('.local/product-control-20261006/connection-regression');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:680}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith('file:')?r.continue():r.abort());
  await page.addInitScript(()=>{
   localStorage.clear();localStorage.setItem('clw-workflow-mode','codex');window.commands=[];
   window.connection={etag:'absent',enabled:false,configured:false,webAccount:'B',transport:'dedicated',tunnel:{tunnelId:'',runtimeKeyFile:'',binaryPath:''},sharedExisting:false,prerequisites:{browserHelper:true,bun:true},modelSends:0};
   window.fixture={root:'D:/Fixture',connected:true,taskStateReady:true,pages:[],closed:[],theme:'dark',network:'隔离预览',codexWeb:{state:'unconfigured',recent:[]},recordHistory:{web:true,codex:false},localCodex:{available:false}};
   window.clw={onState:cb=>{window.emit=()=>{cb(structuredClone(window.fixture));renderStateImmediately();};setTimeout(()=>window.emit(),0);},onIntent(){},command:async(action,payload={})=>{
    window.commands.push({action,payload:structuredClone(payload)});
    if(action==='connection-read'){
     if(window.holdConnectionRead)return new Promise(resolve=>{window.releaseConnectionRead=()=>{window.holdConnectionRead=false;resolve(structuredClone(window.connection));};});
     return structuredClone(window.connection);
    }
    if(action==='connection-save'){
     if(window.rejectNext){const error=window.rejectNext;window.rejectNext=null;throw Error(error);}
     if(payload.expected_etag!==window.connection.etag)throw Error('connection_settings_changed');
     const nextAccountOnly=window.connection.sharedExisting&&payload.transport==='shared-mcp'&&payload.webAccount!==window.connection.webAccount;
     window.connection={...window.connection,...payload,etag:'saved-'+(window.commands.length),configured:true};
     const r={state:'connection_settings_saved',settings:structuredClone(window.connection),reopenRequired:true,modelSends:0,servicesStarted:0,tunnelsClaimed:0,
      ...(nextAccountOnly?{selectionApplies:'next_startup',nextStartupAccount:payload.webAccount,activeAccount:'B'}:{})};
     if(window.unknownOnce){window.unknownOnce=false;throw Error('runtime_receipt_unknown_reconcile_original');}return r;
    }
    if(action==='connection-pick-file')return {path:payload.kind==='key'?'D:/External/key.txt':'D:/External/tunnel-client.exe'};
    if(['codex-start','start','resume','goal-continue'].includes(action))throw Error('unexpected_model_send');
    return {};
   }};
  });
  await page.goto('file:///'+path.resolve('apps/web-host/index.html').replaceAll('\\','/'));await page.locator('#codex-status').getByText(/尚未初始化/).waitFor();
  const count=()=>page.evaluate(()=>window.commands.filter(c=>c.action==='connection-save').length);
  const open=async()=>{if(await page.locator('#connection-tools').getAttribute('open')===null)await page.locator('#connection-tools>summary').click();await page.locator('#connection-settings-open').click();await page.waitForFunction(()=>connectionSnapshot!==null&&!busy.has('connection-read'));};
  const fill=async()=>{await page.locator('#connection-enabled').check();await page.locator('#connection-account').selectOption('A');await page.locator('#connection-tunnel-id').fill('tunnel_'+'a'.repeat(32));await page.locator('#connection-pick-key').click();await page.locator('#connection-pick-binary').click();};
  await t.test('new working directory is empty and settings use one folded account and connection entry',async()=>{
   assert.equal(await page.locator('#codex-root').inputValue(),'');assert.equal(await page.locator('#connection-settings-open').isVisible(),false);
   await open();assert.equal(await page.locator('#connection-enabled').isChecked(),false);assert.equal(await count(),0);
   assert.equal(await page.locator('#connection-transport option[value="shared-mcp"]').getAttribute('disabled'),'');
   await fill();assert.equal(await count(),0);
   await page.screenshot({path:path.join(output,'first-connection-compact.png')});
  });
  await t.test('save freezes identity and does not activate the current connection or send a model',async()=>{
   await page.locator('#connection-settings-save').click();await page.waitForFunction(()=>!busy.has('connection-save'));
   assert.match(await page.locator('#connection-settings-message').innerText(),/正常退出.*重新打开.*没有启动/);
   assert.equal(await count(),1);const request=await page.evaluate(()=>window.commands.find(c=>c.action==='connection-save').payload);
   assert.equal(request.expected_etag,'absent');assert.equal(request.webAccount,'A');assert.equal(request.enabled,true);assert.equal(request.tunnel.runtimeKeyFile,'D:/External/key.txt');
   assert.equal(await page.evaluate(()=>window.fixture.codexWeb.state),'unconfigured');
   assert.equal(await page.evaluate(()=>window.commands.filter(c=>['codex-start','start','resume','goal-continue','codex-verify'].includes(c.action)).length),0);
  });
  await t.test('unknown save is read back instead of being automatically repeated',async()=>{
   await page.evaluate(()=>window.unknownOnce=true);await page.locator('#connection-account').selectOption('B');await page.locator('#connection-settings-save').click();
   await page.waitForFunction(()=>!busy.has('connection-save'));assert.equal(await count(),2);assert.equal(await page.locator('#connection-settings-save').isDisabled(),true);
   await page.locator('#connection-settings-refresh').click();await page.waitForFunction(()=>connectionSnapshot!==null&&!busy.has('connection-read'));
   assert.equal(await page.locator('#connection-account').inputValue(),'B');assert.equal(await count(),2);
  });
  await t.test('inflight rejection preserves original selection and editing input',async()=>{
   await page.evaluate(()=>window.rejectNext='connection_original_execution_unresolved');await page.locator('#connection-account').selectOption('A');await page.locator('#connection-settings-save').click();await page.waitForFunction(()=>!busy.has('connection-save'));
   assert.match(await page.locator('#connection-settings-message').innerText(),/在途.*配置没有改变/);assert.equal(await page.locator('#connection-account').inputValue(),'A');assert.equal(await page.evaluate(()=>window.connection.webAccount),'B');
  });
  await t.test('shared settings allow A/B browser choice while locking original tunnel references',async()=>{
   await page.evaluate(()=>{window.connection={...window.connection,transport:'shared-mcp',sharedExisting:true};});await page.locator('#connection-settings-refresh').click();await page.waitForFunction(()=>!busy.has('connection-read'));
   assert.equal(await page.locator('#connection-account').isDisabled(),false);assert.equal(await page.locator('#connection-key-path').getAttribute('readonly'),'');
   assert.equal(await page.locator('#connection-pick-binary').isDisabled(),true);assert.match(await page.locator('#connection-shared-hint').innerText(),/不会迁移或认领/);
   const before=await page.evaluate(()=>structuredClone(window.connection.tunnel)),savedBefore=await count();
   await page.locator('#connection-account').selectOption('A');assert.equal(await count(),savedBefore);
   await page.locator('#connection-settings-save').click();await page.waitForFunction(()=>!busy.has('connection-save'));
   assert.equal(await count(),savedBefore+1);assert.equal(await page.evaluate(()=>window.connection.webAccount),'A');
   assert.match(await page.locator('#connection-settings-message').innerText(),/下次启动账号.*当前连接.*原账号.*正常退出/);
   assert.deepEqual(await page.evaluate(()=>window.connection.tunnel),before);
   const last=await page.evaluate(()=>window.commands.filter(c=>c.action==='connection-save').at(-1));assert.equal(last.payload.transport,'shared-mcp');
   await page.locator('.connection-prerequisite-note>summary').click();await page.locator('#connection-settings-save').scrollIntoViewIfNeeded();
   const rect=await page.locator('#connection-settings-save').boundingBox();assert.ok(rect.y>=0&&rect.y+rect.height<=680);await page.screenshot({path:path.join(output,'existing-shared-connection-compact.png')});
  });
  await t.test('reopening while a prior read is pending rechecks the original configuration once',async()=>{
   const savedBefore=await count();await page.locator('#close-details').click();await page.evaluate(()=>window.holdConnectionRead=true);
   await page.locator('#connection-settings-open').click();await page.waitForFunction(()=>busy.has('connection-read'));
   await page.locator('#close-details').click();await page.locator('#connection-settings-open').click();
   await page.evaluate(()=>{window.connection.etag='reopened-original';window.releaseConnectionRead();});
   await page.waitForFunction(()=>!busy.has('connection-read')&&connectionSnapshot?.etag==='reopened-original');
   assert.equal(await page.locator('#connection-settings-save').isDisabled(),false);assert.equal(await count(),savedBefore);
  });
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
