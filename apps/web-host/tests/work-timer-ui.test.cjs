'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');
test('actual shell clock ticks without rendering records, survives reload and freezes only its original round',async()=>{
  // A newly owned file-only browser with fake IPC. No live Web task is touched.
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const errors=[],commands=[];
  try{
    const page=await browser.newPage({viewport:{width:430,height:900}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
    await page.exposeFunction('fixtureCommand',async(action,payload)=>{commands.push({action,payload});return {};});
    await page.addInitScript(()=>{
      window.timerStart=1791356542811;window.timerNow=window.timerStart+3600000;
      Date.now=()=>window.timerNow;
      const request={id:'original-request',phase:'processing',created_at:new Date(window.timerStart-60000).toISOString(),attempt_id:'control_original'};
      const task={id:'camp',title:'Camp fixture',kind:'task',bound:true,thread_id:'original-thread',account:'A',
        root:'D:/Fixture/Camp',model:'gpt-6 · latest',effort:'pro',latest_request:request,paused:false,status:'idle',
        observation:{at:window.timerNow,attemptId:'control_original',generating:true,historyAtLatest:true,model:{model:'GPT-6 · 最新',effort:'Pro'}}};
      window.fixture={selected:task.id,connected:true,connectionGeneration:1,taskStateReady:true,closed:[],
        root:'D:/Fixture',theme:'dark',recordHistory:{web:false,codex:false},codexWeb:{recent:[]},localCodex:{available:false},pages:[task],
        view:{page_id:task.id,thread_id:task.thread_id,request,latest_request:request,attempt:{id:'control_original',acknowledged:window.timerStart/1000},
          events:[{seq:1,kind:'user_message',at:new Date(window.timerStart).toISOString(),data:{text:'Complete a playable demo',request_id:request.id}}]}};
      window.clw={command:(action,payload)=>window.fixtureCommand(action,payload),onIntent(){},
        onState:callback=>{window.publishFixture=()=>{callback(window.fixture);renderStateImmediately();};setTimeout(window.publishFixture,0);},
        onControl:callback=>{window.controlListener=callback;},respondControl:reply=>{window.controlReply=reply;}};
    });
    await page.goto('file:///'+path.resolve(__dirname,'../index.html').replaceAll('\\','/'));
    await page.locator('#thread-title').getByText('Camp fixture',{exact:true}).waitFor();
    assert.equal(await page.locator('#workflow-round-time').innerText(),'本轮用时 01:00:00');
    assert.equal(await page.locator('#workflow-goal-time').innerText(),'需求历时 01:01:00');
    assert.equal(await page.locator('#workflow-detail-panel').isVisible(),false,'The timer does not require opening progress');
    assert.equal(await page.locator('#workflow-clock').getAttribute('aria-live'),'off');
    await page.evaluate(()=>{
      window.nonTimerMutations=0;window.watchPaint=new MutationObserver(rows=>window.nonTimerMutations+=rows.length);
      for(const id of ['pages','events'])window.watchPaint.observe(document.getElementById(id),{subtree:true,childList:true,attributes:true,characterData:true});
      window.timerNow+=7000;
    });
    await page.waitForFunction(()=>document.getElementById('workflow-round-time').textContent==='本轮用时 01:00:07');
    assert.equal(await page.evaluate(()=>window.nonTimerMutations),0,'Clock ticks must not render navigation or reply bodies');
    await page.evaluate(()=>{window.watchPaint.disconnect();window.fixture.pages[0].paused=true;window.fixture.pages[0].observation.at=window.timerNow;window.publishFixture();});
    assert.match(await page.locator('#workflow-title').innerText(),/后续自动推进已暂停/);
    await page.evaluate(()=>{window.timerNow+=5000;});
    await page.waitForFunction(()=>document.getElementById('workflow-round-time').textContent==='本轮用时 01:00:12');
    await page.evaluate(()=>{
      const end=window.timerStart+3605000;window.fixture.pages[0].observation.generating=false;
      window.fixture.view.events.push({seq:2,kind:'host_turn_attention',at:new Date(end).toISOString(),
        data:{request_id:'original-request',attempt_id:'control_original'}});window.publishFixture();
    });
    assert.equal(await page.locator('#workflow-round-time').innerText(),'本轮用时 01:00:05');
    await page.evaluate(()=>{window.fixture.view.events=[];window.timerNow+=3600000;window.publishFixture();});
    assert.equal(await page.locator('#workflow-round-time').innerText(),'本轮用时 01:00:05','Rotated history retains a confirmed end');
    await page.reload();await page.locator('#thread-title').getByText('Camp fixture',{exact:true}).waitFor();
    assert.equal(await page.locator('#workflow-round-time').innerText(),'本轮用时 01:00:05','Reload never restarts the confirmed round');
    const inspect=await page.evaluate(async()=>{await window.controlListener({id:'timer-inspection',action:'inspect'});return window.controlReply.result;});
    assert.equal(inspect.work_timer.attemptId,'control_original');assert.equal(inspect.work_timer.state,'ended');
    const bounds=await page.locator('#workflow-clock').boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=430);
    assert.deepEqual(commands.filter(row=>!['status','layout','prompt-preview'].includes(row.action)),[]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
