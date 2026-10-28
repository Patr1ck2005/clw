'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');
test('compact workspace separates active startup from unavailable service and preserves original tasks',async t=>{
 const output=path.resolve('.local/product-control-20261006/availability-regression');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:680}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
  await page.addInitScript(()=>{
   localStorage.clear();window.commands=[];
   window.fixture={root:'D:/Fixture',connected:false,taskStateReady:false,runtime:{state:'unavailable',code:'runtime_port_in_use'},taskStateRead:{state:'pending'},network:'VPN 已连接 · 直连已禁用',notice:'runtime_disconnected_reconcile_original',closed:[],theme:'dark',selected:'original-camp',localCodex:{available:true},codexWeb:{state:'unconfigured',recent:[]},pages:[{id:'original-camp',title:'Camp · 原任务',kind:'task',root:'D:/Fixture/Camp',account:'A',bound:true,paused:true,loading:false,latest_request:{id:'original-request',phase:'processing'},maintenance:{state:'settled',pending:[]}}]};
   window.clw={onState:callback=>{window.emit=()=>{callback(structuredClone(window.fixture));renderStateImmediately();};setTimeout(window.emit,0);},onIntent(){},command:async(action,payload)=>{window.commands.push({action,payload});return {};}};
  });
  await page.goto('file:///'+path.resolve('apps/web-host/index.html').replaceAll('\\','/'));await page.waitForFunction(()=>document.querySelector('#workspace-loading-title').textContent.includes('已有实例'));
  await t.test('port conflict gives safe next steps without perpetual spinner or raw error code',async()=>{
   assert.equal(await page.locator('#workspace-loading').getAttribute('aria-busy'),'false');assert.equal(await page.locator('#workspace-loading-spinner').isVisible(),false);
   assert.match(await page.locator('#workspace-loading-detail').innerText(),/18944.*检查.*CLW.*停稳.*安全退出.*正常启动/);
   assert.doesNotMatch(await page.locator('body').innerText(),/runtime_disconnected_reconcile_original|runtime_port_in_use/);assert.equal(await page.locator('#new-page').isDisabled(),true);
   assert.deepEqual(await page.evaluate(()=>({request:state.pages[0].latest_request,paused:state.pages[0].paused,loading:state.pages[0].loading})),{request:{id:'original-request',phase:'processing'},paused:true,loading:false});
   assert.match(await page.locator('#pages').innerText(),/Camp.*已暂停 · 连接待处理/s);assert.doesNotMatch(await page.locator('#pages').innerText(),/正在恢复/);assert.equal(await page.evaluate(()=>window.commands.filter(call=>['start','pause','resume','start-first-turn','connection-save','codex-launch','native-codex-start'].includes(call.action)).length),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);await page.screenshot({path:path.join(output,'runtime-port-in-use-compact.png')});
  });
  await t.test('unknown startup and execution receipt are not reported as a failed task',async()=>{
   await page.evaluate(()=>{window.fixture.runtime={state:'unavailable',code:'runtime_startup_failed'};window.fixture.notice='runtime_receipt_unknown_reconcile_original';window.emit();});
   assert.equal(await page.locator('#workspace-loading-spinner').isVisible(),false);assert.match(await page.locator('#notice-text').innerText(),/回执尚未确认.*原命令.*不要重复提交/);
   assert.equal(await page.evaluate(()=>state.pages[0].latest_request.phase),'processing');assert.doesNotMatch(await page.locator('#workspace-loading-detail').innerText(),/任务失败|思考失败/);
  });
  await t.test('ready service with failed record read or VPN check stops loading and preserves records',async()=>{
   for(const [code,expected] of [['runtime_task_state_unavailable',/原任务记录暂时无法读取/],['runtime_network_unavailable',/VPN 尚未就绪.*不会改用直连/]]){
    await page.evaluate(code=>{window.fixture.connected=true;window.fixture.runtime={state:'ready',code:null};window.fixture.taskStateRead={state:'unavailable',code};window.fixture.notice='';window.emit();},code);
    assert.equal(await page.locator('#workspace-loading-spinner').isVisible(),false);assert.match(await page.locator('#workspace-loading-detail').innerText(),expected);assert.equal(await page.evaluate(()=>state.pages[0].paused),true);
   }
   await page.screenshot({path:path.join(output,'runtime-record-unavailable-compact.png')});
  });
  await t.test('only an actual startup or record read spins without rewriting task state',async()=>{
   await page.evaluate(()=>{window.fixture.connected=false;window.fixture.runtime={state:'starting',code:null};window.fixture.taskStateRead={state:'pending'};window.emit();});
   assert.equal(await page.locator('#workspace-loading').getAttribute('aria-busy'),'true');assert.equal(await page.locator('#workspace-loading-spinner').isVisible(),true);assert.equal(await page.evaluate(()=>state.pages[0].loading),false);
   await page.evaluate(()=>{window.fixture.connected=true;window.fixture.runtime={state:'ready'};window.fixture.taskStateRead={state:'loading'};window.emit();});assert.equal(await page.locator('#workspace-loading').getAttribute('aria-busy'),'true');
  });
  await t.test('optional tool activity fault does not regress a ready workspace',async()=>{
   await page.evaluate(()=>{window.fixture.taskStateReady=true;window.fixture.taskStateRead={state:'ready'};window.fixture.view={page_id:'original-camp',session_activity:{unavailable:true}};window.emit();});
   assert.equal(await page.locator('#workspace-loading').isVisible(),false);assert.equal(await page.locator('#new-page').isDisabled(),false);assert.equal(await page.evaluate(()=>state.pages[0].latest_request.id),'original-request');
   assert.equal(await page.evaluate(()=>window.commands.filter(call=>['start','pause','resume','start-first-turn','connection-save','codex-launch'].includes(call.action)).length),0);
  });
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
