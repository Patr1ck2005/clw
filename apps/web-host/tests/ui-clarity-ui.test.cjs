'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');

test('actual layout separates saved results, observation warnings and next-round actions without sending',async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const commands=[],errors=[];
  try{
    const page=await browser.newPage({viewport:{width:1424,height:921}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
    await page.exposeFunction('fixtureCommand',async(action,payload)=>{commands.push({action,payload});return {};});
    await page.addInitScript(()=>{
      const request={id:'saved-original',phase:'completed',attempt_id:'control_original',created_at:'2026-10-11T12:25:11Z',finished_at:'2026-10-11T12:36:22Z'};
      const task={id:'qa',title:'个人版 High QA · 纯 Web',kind:'task',bound:true,paused:true,thread_id:'qa-original',root:'',account:'A',access:'read',model:'gpt-6 · latest',effort:'high',latest_request:request,
        observation:{at:Date.now(),error:'page_snapshot_timeout',generating:false,historyAtLatest:true,model:{model:'gpt-6 · latest',effort:'high'},publicProcess:{title:'Old thinking activity'}}};
      window.fixture={selected:'qa',connected:true,taskStateReady:true,connectionGeneration:1,root:'D:/Fixture',closed:[],theme:'dark',accent:'purple',recordHistory:{web:false,codex:false},codexWeb:{recent:[]},localCodex:{available:false},pages:[task],
        view:{page_id:'qa',thread_id:'qa-original',request:null,latest_request:request,goal:{configured:false},next_round:{count:0,messages:[]},pending_notes:0,send_stats:{confirmed:3,unconfirmed:0},attempt:{id:'control_original',state:'acknowledged',acknowledged:1791721986},events:[
          {seq:1,kind:'user_message',delivery:'delivered',at:'2026-10-11T12:33:06Z',data:{text:'Complete the ordered QA requirements',request_id:request.id}},
          {seq:2,kind:'assistant_message',at:'2026-10-11T12:36:22Z',data:{text:'PASS.\n\n'+Array.from({length:70},(_,i)=>'Paragraph '+i+': Saved output and mathematical rendering $x^2+y^2=1$.').join('\n\n')}}]}};
      window.clw={command:async(action,payload)=>{const result=await window.fixtureCommand(action,payload);if(action==='resume'){window.fixture.pages[0].paused=false;window.publishFixture();}return result;},onIntent(){},
        onState:callback=>{window.publishFixture=()=>{callback(window.fixture);renderStateImmediately();};setTimeout(window.publishFixture,0);},
        onControl:callback=>{window.controlListener=callback;},respondControl:reply=>{window.controlReply=reply;}};
    });
    await page.goto('file:///'+path.resolve(__dirname,'../index.html').replaceAll('\\','/'));
    await page.locator('#workflow-title').getByText('本轮结果已保存',{exact:true}).waitFor();
    assert.equal(await page.locator('#workflow-action').isVisible(),false);
    assert.match(await page.locator('#workflow-observation').innerText(),/网页状态读取/);
    assert.doesNotMatch(await page.locator('#workflow-observation').innerText(),/page_snapshot_timeout|AB.*断/);
    assert.equal(await page.locator('#public-process').innerText(),'本轮结果已保存');
    assert.match(await page.locator('#workflow-goal-time').innerText(),/^需求历时 /);
    assert.match(await page.locator('#connection').innerText(),/直接对话.*项目可选/);
    await page.locator('#objective').fill('New requirements kept as a local draft');
    await page.locator('#objective').evaluate(node=>node.setSelectionRange(4,12));
    await page.evaluate(()=>{for(let i=0;i<20;i++){window.fixture.pages[0].observation.at=Date.now()+i;window.publishFixture();}});
    assert.deepEqual(await page.locator('#objective').evaluate(node=>[node.selectionStart,node.selectionEnd]),[4,12]);
    assert.equal(await page.locator('#workflow-action').getAttribute('data-label'),'解除暂停');
    assert.equal(await page.locator('#start').getAttribute('data-action'),'save-draft');
    await page.screenshot({path:path.resolve(__dirname,'../../../.local/personal-redesign-20261011/ux-clarity/fixture-wide.png')});
    await page.locator('#workflow-action').click();
    await page.waitForFunction(()=>document.getElementById('start').dataset.label==='发送消息');
    assert.equal(await page.locator('#objective').inputValue(),'New requirements kept as a local draft');
    await page.setViewportSize({width:430,height:900});
    await page.waitForFunction(()=>document.body.classList.contains('navigation-overlay')||window.innerWidth===430);
    const bounds=await page.locator('#workflow-clock').boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=430);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.screenshot({path:path.resolve(__dirname,'../../../.local/personal-redesign-20261011/ux-clarity/fixture-narrow.png')});
    await page.evaluate(()=>{delete window.fixture.pages[0].observation.error;window.publishFixture();});
    assert.equal(await page.locator('#workflow-observation').isVisible(),false);
    await page.evaluate(()=>setWorkflowMode('local'));
    assert.equal(await page.locator('#workflow-observation').isVisible(),false);
    assert.equal(commands.filter(row=>row.action==='resume').length,1);
    assert.deepEqual(commands.filter(row=>['start','enroll','start-first-turn','refresh','stop-generation'].includes(row.action)),[]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
