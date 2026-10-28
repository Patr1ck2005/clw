'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');

test('isolated workspace exposes one original unsent recovery action and sends its exact CAS',async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
    await page.addInitScript(()=>{
      localStorage.clear();window.commands=[];
      const latest={id:'original-request',phase:'queued',attempt_id:'original-attempt',sent_user_hash:null};
      const task={id:'original-page',kind:'task',title:'原任务 · 隔离测试',account:'A',bound:true,paused:true,
        model:'GPT-6 · 最新',effort:'高',attention:'原发送前检查失败',issue_kind:'control_failed',latest_request:latest,
        observation:{generating:false,editorReady:true,effortLabel:'高',at:Date.now()}};
      window.fixture={connected:true,taskStateReady:true,connectionGeneration:3,selected:task.id,pages:[task],closed:[],theme:'dark',
        codexWeb:{state:'unconfigured',recent:[]},recordHistory:{web:true,codex:true},
        view:{page_id:task.id,thread_id:'original-thread',request:{id:latest.id,phase:'queued',cancel_requested:0},latest_request:latest,
          attempt:{id:latest.attempt_id,state:'not_sent',dispatched:100,acknowledged:null},events:[]}};
      window.clw={onState(callback){window.updateFixture=()=>{callback(window.fixture);renderStateImmediately();};setTimeout(window.updateFixture,0);},onIntent(){},
        async command(action,payload){window.commands.push({action,payload});
          if(action==='record-index')return {mode:'web',page_id:task.id,thread_id:'original-thread',items:[],total:0};
          if(action==='resume'){task.paused=false;task.attention=null;task.issue_kind=null;window.updateFixture();return {paused:false,original_claims_preserved:true};}
          return {};}};
    });
    await page.goto('file:///'+path.resolve('apps/web-host/index.html').replaceAll('\\','/'));
    await page.locator('#workflow-action').getByText('恢复自动推进',{exact:true}).waitFor();
    assert.equal(await page.locator('#resume').evaluate(node=>node.hidden),true,'menu must not duplicate the primary recovery action');
    assert.equal(await page.locator('#start').isDisabled(),true);
    await page.locator('#workflow-action').click();
    await page.waitForFunction(()=>!busy.has('resume'));
    const calls=await page.evaluate(()=>window.commands.filter(c=>c.action==='resume'));
    assert.equal(calls.length,1);assert.equal(calls[0].payload.id,'original-page');
    assert.equal(calls[0].payload.expected_request_id,'original-request');
    assert.equal(calls[0].payload.expected_connection_generation,3);
    assert.equal(await page.evaluate(()=>window.commands.some(c=>['start','enroll','goal-continue'].includes(c.action))),false);
    // A later unknown state must retain reconciliation, not resurrect this CTA.
    await page.evaluate(()=>{const f=window.fixture;f.pages[0].paused=true;f.pages[0].attention='原发送结果未知';f.pages[0].issue_kind='control_failed';f.view.attempt.state='unknown';window.updateFixture();});
    assert.equal(await page.locator('#workflow-action').isVisible(),false);
    assert.equal(await page.locator('#resume').evaluate(node=>node.hidden),true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
