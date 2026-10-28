'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');
const {modelState}=require('../workflow-state.js');
const {composer}=require('../task-presentation.js');

const request={id:'00000000-0000-4000-8000-000000000002',phase:'processing',attempt_id:'original-attempt'};
const task={id:'camp-fixture',kind:'task',bound:true,thread_id:'original-thread',account:'A',
  model:'gpt-6 · latest',effort:'pro',latest_request:request,
  observation:{model:{model:'GPT-6 · 最新',effort:'Pro',selection:['最新']},effortLabel:'Pro',historyAtLatest:false}};
const view={page_id:task.id,thread_id:task.thread_id,request,latest_request:request};

test('localized Latest retains the selected model version and actual mismatch evidence',()=>{
  assert.notEqual(task.model.toLowerCase(),task.observation.model.model.toLowerCase(),'The incident used distinct localized raw labels');
  assert.equal(modelState(task).mismatch,false);
  assert.equal(modelState({...task,observation:{model:{model:'GPT-6.1 · 最新',effort:'Pro'},effortLabel:'Pro'}}).mismatch,true);
  assert.equal(modelState({...task,observation:{model:{model:'GPT-6 · 最新',effort:'High'},effortLabel:'High'}}).mismatch,true);
});

test('a valid current-request note does not require a model change, while new sends and uncertain ledgers stay blocked',()=>{
  const options={draft:'补充当前工作要求',connected:true,modelMismatch:true};
  const note=composer(task,view,options);
  assert.equal(note.kind,'append');assert.equal(note.disabled,false);assert.equal(note.requestId,request.id);
  assert.equal(composer({...task,latest_request:null},{page_id:task.id,thread_id:task.thread_id,request:null},options).disabled,true);
  for(const invalid of [
    {...view,page_id:'another-page'},
    {...view,state_read:{unavailable:true}},
    {...view,request:{phase:'processing'}},
    {...view,request:{...request,phase:'unknown'}},
    {...view,latest_request:{...request,id:'newer-request'}},
    {...view,thread_id:'another-thread'},
  ])assert.equal(composer(task,invalid,options).disabled,true,JSON.stringify(invalid));
  assert.equal(composer({...task,latest_request:{...request,id:'newer-request'}},view,options).disabled,true);
});

test('isolated real shell preserves the working draft on reload and saves one original-request note with immediate feedback',async()=>{
  // This owns a new browser only. All Host responses are local fixtures and
  // every network request is blocked; no running CLW/Web task is controlled.
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const commands=[],errors=[];let finishNote;
  try{
    const page=await browser.newPage({viewport:{width:1380,height:960}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
    await page.exposeFunction('fixtureCommand',async(action,payload={})=>{
      commands.push({action,payload});
      if(action==='start')return new Promise(resolve=>{finishNote=resolve;});
      return {};
    });
    await page.addInitScript(({task,view})=>{
      window.fixture={selected:task.id,connected:true,connectionGeneration:7,taskStateReady:true,closed:[],
        root:'D:/Fixture',theme:'dark',recordHistory:{web:false,codex:false},codexWeb:{recent:[]},localCodex:{available:false},
        pages:[{...task,title:'Camp original work',root:'D:/Fixture/Camp',paused:false,status:'idle',
          first_turn_instructions:'Original complete work',observation:{...task.observation,at:Date.now(),generating:false}}],
        view:{...view,events:[],run:{state:'running',dispatches:4,max_dispatches:100},send_stats:{confirmed:15,unconfirmed:0}}};
      window.clw={command:(action,payload)=>window.fixtureCommand(action,payload),onIntent(){},
        onState:callback=>{window.publishFixture=()=>{callback(window.fixture);renderStateImmediately();};setTimeout(window.publishFixture,0);},
        onControl:callback=>{window.controlListener=callback;},respondControl:reply=>{window.controlReply=reply;}};
    },{task,view});
    await page.goto('file:///'+path.resolve(__dirname,'../index.html').replaceAll('\\','/'));
    await page.locator('#thread-title').getByText('Camp original work',{exact:true}).waitFor();
    const draft='请把这条额外要求保存在原任务，接续时一起处理。';
    await page.locator('#objective').fill(draft);
    assert.equal(await page.locator('#start').isEnabled(),true,'The actual Chinese Latest label must not disable a current-request note');
    assert.equal(await page.locator('#start').getAttribute('aria-label'),'保存补充');
    assert.equal(await page.locator('#start').getAttribute('data-action'),'append');
    const inspect=await page.evaluate(async()=>{
      await window.controlListener({id:'inspect-original',action:'inspect'});return window.controlReply;
    });
    assert.equal(inspect.ok,true);assert.deepEqual(inspect.result.composer_action,
      {kind:'append',label:'保存补充',disabled:false,request_id:request.id,draft_length:draft.length});
    assert.equal(JSON.stringify(inspect).includes(draft),false,'Inspection exposes metadata only');
    const prepared=await page.evaluate(async()=>{
      await window.controlListener({id:'prepare-original',action:'prepare-reload'});return window.controlReply;
    });
    assert.equal(prepared.ok,true);assert.equal(prepared.result.draft_saved,true);
    await page.reload();
    await page.locator('#thread-title').getByText('Camp original work',{exact:true}).waitFor();
    assert.equal(await page.locator('#objective').inputValue(),draft);
    assert.equal(await page.locator('#start').isEnabled(),true);
    await page.locator('#start').click();
    assert.equal(await page.locator('#start').isDisabled(),true);
    assert.equal(await page.locator('#start').getAttribute('aria-label'),'正在保存…');
    assert.equal(await page.locator('#interaction-status').isVisible(),true);
    assert.match(await page.locator('#interaction-status-text').innerText(),/正在保存/);
    assert.equal(commands.filter(row=>row.action==='start').length,1);
    const saved=commands.find(row=>row.action==='start');
    assert.deepEqual(saved.payload,{id:task.id,objective:draft,expected_request_id:request.id,resume:false});
    assert.equal(typeof finishNote,'function');finishNote({state:'note_saved_not_native_interrupt',request_id:request.id});
    await page.waitForFunction(()=>document.getElementById('objective').value==='');
    assert.match(await page.locator('#notice-text').innerText(),/补充已保存，下一轮合并发送.*当前回合继续工作/);
    assert.equal(await page.evaluate(()=>window.fixture.view.request.id),request.id);
    assert.equal(await page.evaluate(()=>window.fixture.view.request.phase),'processing');
    assert.equal(await page.evaluate(()=>window.fixture.pages[0].paused),false);
    assert.deepEqual(commands.filter(row=>['send','resume','pause','stop-generation','refresh','enroll','goal-continue'].includes(row.action)),[]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
