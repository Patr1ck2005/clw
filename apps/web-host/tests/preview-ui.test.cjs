'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');
test('first-run UI preserves drafts, configures one account, then adds B without resending',async t=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1080,height:820}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
    await page.addInitScript(()=>{
      localStorage.clear();window.commands=[];
      window.saved={configured:true,manifest:{schema:1,installation_id:'11111111-1111-4111-8111-111111111111',backend:{mode:'owned',origin:'http://127.0.0.1:40000'},binaries:{cli:'C:/CLW/cli.exe',server:'C:/CLW/server.exe',runner:'C:/CLW/runner.exe',tunnel:'C:/CLW/tunnel.exe'},network:{mode:'system'},accounts:[{id:'A'}],projectRoots:[],auto_connect:true},accounts:[{id:'A',credentialConfigured:false}],status:{state:'not_configured'}};
      window.fixture={root:'C:/CLW',connected:true,taskStateReady:true,taskStateRead:{state:'ready'},pages:[],closed:[],theme:'dark',defaultAccount:'A',network:'系统网络设置已应用',preview:{available:true,busy:null,configuration:window.saved},codexWeb:{state:'unconfigured',recent:[]},recordHistory:{web:true,codex:false},localCodex:{available:false}};
      window.clw={onState(callback){window.emit=()=>callback(structuredClone(window.fixture));setTimeout(()=>window.emit(),0);},onIntent(){},onControl(){},
        command:async(action,payload={})=>{window.commands.push({action,payload:structuredClone(payload)});
          if(action==='preview-read')return structuredClone(window.saved);
          if(action==='preview-save'){window.saved.manifest=structuredClone(payload.manifest);for(const id of Object.keys(payload.credentials||{})){if(!window.saved.accounts.some(row=>row.id===id))window.saved.accounts.push({id,credentialConfigured:true});else window.saved.accounts.find(row=>row.id===id).credentialConfigured=true;}return {...structuredClone(window.saved),restart_required:window.restartOnSave===true};}
          if(action==='preview-connect'){if(window.holdConnect)return new Promise(resolve=>{window.finishConnect=()=>resolve({state:'ready'});});return {state:'ready'};}
          if(action==='preview-pick-root')return {path:'C:/工作目录/Project A'};
          if(action==='preview-bootstrap')return {state:'prepared'};
          return {};
        }};
    });
    await page.goto('file:///'+path.resolve(__dirname,'../index.html').replace(/\\/g,'/'));
    await page.waitForFunction(()=>document.getElementById('preview-dialog')?.open);
    assert.equal(await page.locator('#preview-account').inputValue(),'A');
    if(process.env.CLW_PREVIEW_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.CLW_PREVIEW_SCREENSHOT_DIR,'first-run.png')});
    await page.locator('#preview-network').selectOption('proxy');await page.locator('#preview-proxy').fill('http://127.0.0.1:7890');
    await page.evaluate(()=>{window.restartOnSave=true;});await page.locator('#preview-next').click();
    await page.waitForFunction(()=>document.getElementById('preview-message').textContent.includes('重新打开'));
    assert.equal(await page.locator('#preview-login').isVisible(),false);
    assert.equal(await page.evaluate(()=>window.commands.filter(row=>row.action==='preview-connect').length),0);
    await page.evaluate(()=>{window.restartOnSave=false;});
    await page.locator('#preview-next').click();await page.locator('#preview-login').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>window.saved.manifest.network.proxy_url),'http://127.0.0.1:7890');
    await page.locator('#preview-login').click();await page.waitForFunction(()=>!document.getElementById('preview-dialog').open);
    assert.equal(await page.evaluate(()=>window.commands.find(row=>row.action==='login').payload.account),'A');
    await page.evaluate(()=>document.getElementById('preview-settings-open').click());
    await page.locator('[data-step="2"]').click();await page.locator('#preview-tunnel').fill('tunnel_'+'a'.repeat(32));await page.locator('#preview-key').fill('example-not-a-real-key');
    await page.evaluate(()=>{window.fixture.preview.configuration=structuredClone(window.saved);window.emit();});
    assert.equal(await page.locator('#preview-key').inputValue(),'example-not-a-real-key','background refresh must preserve input');
    await page.locator('#preview-next').click();await page.locator('#preview-pick-root').click();
    assert.match(await page.locator('#preview-roots').inputValue(),/工作目录/);
    await page.evaluate(()=>{window.holdConnect=true;});await page.locator('#preview-next').click();
    await page.waitForFunction(()=>typeof window.finishConnect==='function');assert.equal(await page.locator('#preview-next').isDisabled(),true);
    assert.equal(await page.locator('#preview-roots').isDisabled(),true);assert.equal(await page.locator('#preview-key').isDisabled(),true);
    await page.evaluate(()=>window.finishConnect());await page.waitForFunction(()=>!document.getElementById('preview-next').disabled);
    assert.equal(await page.evaluate(()=>window.commands.filter(row=>row.action==='preview-connect').length),1);
    await page.locator('[data-step="2"]').click();await page.locator('#preview-account').selectOption('B');
    await page.locator('#preview-tunnel').fill('tunnel_'+'b'.repeat(32));await page.locator('#preview-key').fill('example-B-not-a-real-key');await page.locator('#preview-next').click();
    assert.deepEqual(await page.evaluate(()=>window.saved.manifest.accounts.map(row=>row.id)),['A','B']);
    assert.equal(await page.evaluate(()=>window.commands.filter(row=>['start','start-first-turn','resume','codex-start','goal-continue'].includes(row.action)).length),0);
    await page.setViewportSize({width:600,height:760});
    const bounds=await page.locator('#preview-dialog').boundingBox();assert(bounds.width<=576);assert(bounds.x>=0);
    if(process.env.CLW_PREVIEW_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.CLW_PREVIEW_SCREENSHOT_DIR,'narrow-settings.png')});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
