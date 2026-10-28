'use strict';
// Real Chromium layout of the local shell; every command is an isolated stub.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');

test('sidebar groups preserve hierarchy, folding and original mode-specific actions',async t=>{
  const output=path.resolve(__dirname,'../../../.local/personal-redesign-20261011/goal-controls/sidebar-hierarchy');
  fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1424,height:921}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
    await page.addInitScript(()=>{
      window.commands=[];
      window.fixture={connected:true,taskStateReady:true,theme:'dark',accent:'purple',network:'VPN 已连接 · 直连已禁用',pages:[],closed:[],
        localCodex:{available:true,protocol:'installed-codex-cli',capabilities:['launch','resume']},
        recordHistory:{web:true,codex:true},codexWeb:{state:'ready',account:'A',recent:[]}};
      window.clw={onState:callback=>{window.emit=()=>{callback(structuredClone(window.fixture));renderStateImmediately();};setTimeout(window.emit,0);},onIntent(){},
        command:async(action,payload={})=>{
          window.commands.push({action,payload:structuredClone(payload)});
          if(action==='connection-read')return {etag:'fixture',configured:false,enabled:false,webAccount:'A',transport:'dedicated',tunnel:{},prerequisites:{}};
          if(action==='theme'){Object.assign(window.fixture,payload);window.emit();}
          if(['start','resume','goal-continue','native-codex-start','codex-start','codex-verify'].includes(action))throw Error('unexpected_business_command');
          return {};
        }};
    });
    const url='file:///'+path.resolve(__dirname,'../index.html').replaceAll('\\','/');
    const ready=()=>page.waitForFunction(()=>!document.body.classList.contains('restoring-workspace'));
    const group=id=>page.locator('#'+id);
    const open=async id=>{if(await group(id).getAttribute('open')===null)await page.locator('#'+id+'>summary').click();await page.waitForFunction(id=>document.querySelector('#'+id+'>summary').getAttribute('aria-expanded')==='true',id);};
    const choose=async mode=>{await page.locator('#workflow-selector>summary').click();await page.locator('#mode-'+mode).click();};
    const shot=name=>page.locator('#task-sidebar').screenshot({path:path.join(output,name+'.png')});
    await page.goto(url);await ready();
    await t.test('parents fold children while session actions remain independent',async()=>{
      for(const id of ['connection-tools','workspace-tools'])assert.equal(await group(id).getAttribute('open'),null);
      assert.equal(await page.locator('#login').isVisible(),false);assert.equal(await page.locator('#quota-open').isVisible(),false);
      assert.equal(await page.locator('#background').isVisible(),true);assert.equal(await page.locator('#quit').isVisible(),true);
      assert.equal(await page.locator('#connection-tools #login').count(),1);assert.equal(await page.locator('#connection-tools #quota-open').count(),1);
      assert.equal(await page.locator('#connection-tools #connection-settings-open').count(),1);
      assert.equal(await page.locator('#workspace-tools #theme').count(),1);assert.equal(await page.locator('#workspace-tools #panel').count(),1);
      assert.equal(await page.locator('#workspace-tools #background,#workspace-tools #quit').count(),0);
      await shot('collapsed');
      await open('connection-tools');await open('workspace-tools');
      const geometry=await page.evaluate(()=>{
        const parent=document.querySelector('#connection-tools>summary').getBoundingClientRect(),child=document.getElementById('login').getBoundingClientRect();
        return {indent:child.left-parent.left,border:getComputedStyle(document.getElementById('connection-tools-items')).borderLeftWidth,
          parentWeight:getComputedStyle(document.querySelector('#connection-tools>summary')).fontWeight,childWeight:getComputedStyle(document.getElementById('login')).fontWeight};
      });
      assert.ok(geometry.indent>=24);assert.equal(geometry.border,'1px');assert.ok(Number(geometry.parentWeight)>Number(geometry.childWeight));
      await shot('expanded-wide');
    });
    await t.test('folds survive refresh and mode switches without restoring the choice popup',async()=>{
      await page.waitForFunction(()=>JSON.parse(localStorage.getItem('clw-sidebar-groups'))['workspace-tools']===true);
      await page.locator('#workflow-selector>summary').click();assert.equal(await group('workflow-selector').getAttribute('open'),'');
      await page.reload();await ready();
      for(const id of ['connection-tools','workspace-tools'])assert.equal(await group(id).getAttribute('open'),'');
      assert.equal(await group('workflow-selector').getAttribute('open'),null);
      await choose('codex');assert.equal(await page.locator('#closed-tasks').isVisible(),false);assert.equal(await page.locator('#codex-archive').isVisible(),true);
      assert.equal(await page.locator('#login-label').innerText(),'账号与启动');
      await page.locator('#login').click();assert.equal(await page.locator('#codex-setup').isVisible(),true);
      await page.locator('#close-details').click();
      await choose('local');assert.equal(await page.locator('#login').isVisible(),false);assert.equal(await page.locator('#quota-open').isVisible(),false);
      assert.equal(await page.locator('#workspace-records').isVisible(),false);assert.equal(await page.locator('#connection-settings-open').isVisible(),true);
      assert.equal(await page.locator('#accent-select').isVisible(),true);assert.equal(await page.locator('#theme').isVisible(),true);
      await shot('local-groups');
      await choose('web');assert.equal(await page.locator('#closed-tasks').isVisible(),true);assert.equal(await page.locator('#codex-archive').isVisible(),false);
      await page.locator('#login').click();assert.equal(await page.evaluate(()=>window.commands.filter(row=>row.action==='accounts').length),1);
      await page.locator('#connection-tools>summary').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('clw-sidebar-groups'))['connection-tools']===false);
      await page.reload();await ready();assert.equal(await group('connection-tools').getAttribute('open'),null);assert.equal(await group('workspace-tools').getAttribute('open'),'');
    });
    await t.test('summary keyboard toggles differ from the temporary mode chooser',async()=>{
      await page.locator('#connection-tools>summary').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#connection-tools>summary').getAttribute('aria-expanded')==='true');
      await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('#connection-tools>summary').getAttribute('aria-expanded')==='false');
      await page.locator('#workflow-selector>summary').focus();await page.keyboard.press('ArrowDown');assert.equal(await page.locator('#mode-web').evaluate(node=>node===document.activeElement),true);
      await page.keyboard.press('ArrowDown');assert.equal(await page.locator('#mode-codex').evaluate(node=>node===document.activeElement),true);
      await page.keyboard.press('End');assert.equal(await page.locator('#mode-local').evaluate(node=>node===document.activeElement),true);
      await page.keyboard.press('Escape');assert.equal(await group('workflow-selector').getAttribute('open'),null);
      assert.equal(await page.locator('#workflow-selector>summary').evaluate(node=>node===document.activeElement),true);
      await page.locator('#workflow-selector>summary').click();await page.locator('#workspace-tools>summary').click();assert.equal(await group('workflow-selector').getAttribute('open'),null);
      await open('workspace-tools');
    });
    await t.test('compact navigation scrolls its children while bottom actions stay reachable',async()=>{
      await page.setViewportSize({width:360,height:680});
      if(!await page.locator('#task-sidebar').isVisible())await page.locator('#sidebar-toggle').click();
      await open('connection-tools');await open('workspace-tools');
      await page.locator('#panel').scrollIntoViewIfNeeded();
      const geometry=await page.evaluate(()=>{
        const ids=['task-sidebar','background','quit','panel','accent-select'],bounds=Object.fromEntries(ids.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [id,{x:r.x,y:r.y,width:r.width,height:r.height}];}));
        return {bounds,viewport:{width:innerWidth,height:innerHeight},scroller:{client:document.querySelector('.sidebar-settings').clientHeight,scroll:document.querySelector('.sidebar-settings').scrollHeight},overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert.equal(geometry.overflow,false);assert.ok(geometry.scroller.scroll>geometry.scroller.client);
      for(const id of ['background','quit','panel','accent-select']){const r=geometry.bounds[id];assert.ok(r.x>=0&&r.x+r.width<=360&&r.y>=0&&r.y+r.height<=680,id+' clipped '+JSON.stringify(r));}
      assert.ok(geometry.bounds.quit.y>=geometry.bounds.background.y+geometry.bounds.background.height);
      await shot('expanded-compact');
      await page.locator('#workflow-selector>summary').focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Escape');
      assert.equal(await page.locator('#task-sidebar').isVisible(),true,'Esc should close the chooser before mobile navigation');
      await page.keyboard.press('Escape');assert.equal(await page.locator('#task-sidebar').isVisible(),false);
    });
    assert.deepEqual(errors,[]);
    const commands=await page.evaluate(()=>window.commands),business=['start','resume','goal-continue','native-codex-start','codex-start','codex-verify'];
    assert.equal(commands.some(row=>business.includes(row.action)),false);
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({isolated:true,realCommands:0,modelSends:0,errors,commands,sourceHashes:Object.fromEntries(['index.html','shell.css','shell.js'].map(name=>[name,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'..',name))).digest('hex')]))},null,2)+'\n');
  }finally{await browser.close();}
});
