'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');

test('goal strip controls in the actual layout pause, resume and close without hiding original work',async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const errors=[];
  try{
    const page=await browser.newPage({viewport:{width:1424,height:921}});page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
    await page.addInitScript(()=>{
      localStorage.clear();window.calls=[];window.receipts=new Map();window.loseStop=true;
      const req={id:'original-work',phase:'processing',attempt_id:'control_original',sent_user_hash:'accepted-original'};
      const goal={configured:true,mode:'automatic',state:'active',display_state:'running',objective:'Complete the original long goal with all required validation.',etag:'goal-1',request_id:req.id,revision:1,cycles:1};
      const task={id:'camp-fixture',title:'Camp · control fixture',kind:'task',bound:true,thread_id:'original-thread',paused:true,root:'D:/Fixture/Camp',account:'A',access:'write',write_paths:['.'],model:'gpt-6 · latest',effort:'pro',latest_request:req,goal:{...goal},
        observation:{at:Date.now(),generating:false,historyAtLatest:true,model:{model:'gpt-6 · latest',effort:'pro'}}};
      window.fixture={selected:task.id,connected:true,taskStateReady:true,connectionGeneration:1,pages:[task],closed:[],root:'D:/Fixture',theme:'dark',accent:'purple',recordHistory:{web:false,codex:false},codexWeb:{recent:[]},localCodex:{available:false},
        view:{page_id:task.id,thread_id:task.thread_id,request:req,latest_request:req,attempt:{id:'control_original',state:'acknowledged',acknowledged:Date.now()/1000-100},goal,pending_notes:0,next_round:{count:0,messages:[]},events:[{seq:1,kind:'assistant_message',data:{text:'Original saved checkpoint. Independent Job remains running.'}}]}};
      window.clw={onIntent(){},onState:callback=>{window.publish=()=>{callback(window.fixture);renderStateImmediately();};setTimeout(window.publish,0);},
        command:async(action,payload)=>{
          window.calls.push({action,payload:structuredClone(payload)});
          if(['pause','resume'].includes(action)){window.fixture.pages[0].paused=action==='pause';window.publish();return {paused:action==='pause'};}
          if(action==='goal-stop'){
            let receipt=window.receipts.get(payload.operation_id);
            if(!receipt){
              if(payload.expected_etag!==window.fixture.view.goal.etag||payload.expected_goal_request_id!=='original-work')throw Error('managed_goal_changed');
              window.fixture.pages[0].paused=true;Object.assign(window.fixture.view.goal,{state:'stopped',display_state:'stopped',revision:2,etag:'goal-2'});window.fixture.pages[0].goal={...window.fixture.view.goal};
              receipt={state:'goal_stopped',goal:structuredClone(window.fixture.view.goal),future_paused:true,model_sends:0};window.receipts.set(payload.operation_id,receipt);window.publish();
            }
            if(window.loseStop){window.loseStop=false;throw Error('runtime_receipt_unknown_reconcile_original');}
            return receipt;
          }
          if(action==='stop-generation')return {local_execution_stopped:false};
          return {};
        },onControl(){},respondControl(){}};
    });
    await page.goto('file:///'+path.resolve(__dirname,'../index.html').replaceAll('\\','/'));
    await page.locator('#composer-goal-state').getByText('目标已暂停',{exact:true}).waitFor();
    assert.equal(await page.locator('#composer-goal-toggle').getAttribute('aria-label'),'继续目标');
    assert.equal(await page.locator('#composer-goal-stop').isEnabled(),true);
    assert.equal(await page.locator('#composer-stop').isVisible(),false,'Old processing ledger is not live generation');
    await page.locator('#composer-goal-toggle').click();
    await page.waitForFunction(()=>document.getElementById('composer-goal-toggle').getAttribute('aria-label')==='暂停目标');
    await page.locator('#composer-goal-toggle').click();
    await page.waitForFunction(()=>document.getElementById('composer-goal-state').textContent==='目标已暂停');
    await page.locator('#objective').fill('Preserved local supplementary requirement');
    await page.setViewportSize({width:430,height:900});
    await page.waitForFunction(()=>window.innerWidth===430);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    const bounds=await page.locator('#composer-goal-stop').boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=430);
    await page.screenshot({path:path.resolve(__dirname,'../../../.local/personal-redesign-20261011/goal-controls/goal-strip-narrow.png')});
    await page.setViewportSize({width:1424,height:921});
    await page.screenshot({path:path.resolve(__dirname,'../../../.local/personal-redesign-20261011/goal-controls/goal-strip-wide.png')});
    await page.locator('#composer-goal-stop').click();
    await page.waitForFunction(()=>document.getElementById('composer-goal-state').textContent.includes('回执待核对'));
    assert.equal(await page.locator('#composer-goal-stop').isEnabled(),true);
    await page.locator('#composer-goal-stop').click();
    await page.waitForFunction(()=>document.getElementById('composer-goal').hidden);
    assert.equal(await page.locator('#objective').inputValue(),'Preserved local supplementary requirement');
    assert.equal(await page.evaluate(()=>window.fixture.view.request.id),'original-work');
    assert.equal(await page.evaluate(()=>window.fixture.pages[0].paused),true);
    const stops=await page.evaluate(()=>window.calls.filter(c=>c.action==='goal-stop'));assert.equal(stops.length,2);assert.deepEqual(stops[0].payload,stops[1].payload);
    await page.locator('#objective').fill('');
    await page.evaluate(()=>{window.fixture.pages[0].observation.at=Date.now();window.fixture.pages[0].observation.generating=true;window.publish();});
    assert.equal(await page.locator('#composer-stop').isVisible(),true);
    assert.equal(await page.locator('#start').isVisible(),false);
    await page.locator('#composer-stop').click();assert.equal(await page.locator('#task-dialog').isVisible(),true);
    assert.match(await page.locator('#dialog-description').innerText(),/主控及其协作者.*本地执行不会因此停止/);
    await page.locator('#dialog-cancel').click();
    await page.evaluate(()=>{
      const end=Date.now();window.fixture.quotas=['A','B'].map((account,i)=>({account,models:[],usage:{stale:false,
        lastGood:{window:{start:end-7*86400000,end,source:'rolling_7d'},checkedAt:end,completedProResponses:84-i*20,proConversations:12-i*3,coverage:{state:'complete'},byModel:[]},
        lastAttempt:{coverage:{state:'complete'}}}}));window.publish();document.getElementById('quota-open').onclick();
    });
    assert.equal(await page.locator('#quota-history section').count(),2);
    assert.match(await page.locator('#quota-history').innerText(),/账号 A.*84 次完成的 Pro 回复/s);
    assert.match(await page.locator('#quota-history').innerText(),/账号 B.*64 次完成的 Pro 回复/s);
    await page.setViewportSize({width:430,height:900});
    await page.waitForFunction(()=>document.getElementById('quota-history').getBoundingClientRect().width<400);
    assert.equal(await page.locator('#quota-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    await page.screenshot({path:path.resolve('.local/personal-redesign-20261011/goal-controls/quota-history-narrow-verified.png')});
    await page.setViewportSize({width:1424,height:921});
    await page.screenshot({path:path.resolve('.local/personal-redesign-20261011/goal-controls/quota-history-wide.png')});
    await page.locator('#quota-close').click();
    assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>['start','stop-generation','withdraw','goal-continue'].includes(c.action))),[]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
