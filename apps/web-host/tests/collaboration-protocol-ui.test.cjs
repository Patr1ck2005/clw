'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');

function shell(storage=new Map()){
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const window=createWindow(html),commands=[];
  // Domino's optimized single-tag collections lack the browser's iterator.
  for(const collection of [window.document.querySelectorAll('div'),window.document.body.children]){
    if(!collection[Symbol.iterator])Object.defineProperty(Object.getPrototypeOf(collection),Symbol.iterator,{
      configurable:true,value:Array.prototype[Symbol.iterator]});
  }
  if(!('dataset' in window.Element.prototype))Object.defineProperty(window.Element.prototype,'dataset',{get(){const node=this;return new Proxy({},{get:(_,key)=>node.getAttribute('data-'+String(key).replace(/[A-Z]/g,c=>'-'+c.toLowerCase())),set:(_,key,value)=>{node.setAttribute('data-'+String(key).replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),String(value));return true;}});}});
  const localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
  window.clw={command:async(action,payload)=>{commands.push({action,payload});return action==='enroll'?{message:'queued'}:{};},onState(){},onIntent(){}};
  const context=vm.createContext({atob:globalThis.atob,window,document:window.document,localStorage,
    ResizeObserver:class{observe(){}},requestAnimationFrame(){},cancelAnimationFrame(){},setTimeout,clearTimeout});
  // Use the actual page's dependency order, including shared interaction and
  // task presentation modules, rather than booting shell with stale globals.
  for(const script of window.document.querySelectorAll('script[src]')){
    const source=script.getAttribute('src');
    if(source==='shell.js')break;
    vm.runInContext(fs.readFileSync(path.join(__dirname,'..',source),'utf8'),context,{filename:source});
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../shell.js'),'utf8'),context);
  const element=id=>window.document.getElementById(id);
  element('settings-form').checkValidity=()=>true;
  element('first-task-effort').value='极高';
  vm.runInContext('render=()=>{}',context);
  const select=id=>{vm.runInContext(`state={pages:[${JSON.stringify({id,title:'New task',kind:'task',root:'D:\\project',model:'GPT-6',effort:'极高'})}],selected:${JSON.stringify(id)}};fillSettings()`,context);};
  return {context,commands,element,select,storage};
}

test('new task defaults to a single conversation and sends collaboration only as an explicit opt-in',async()=>{
  const h=shell();h.select('new');
  assert.equal(h.element('collaboration-protocol').value,'tool_v1');
  assert.equal(h.element('collaboration-protocol').disabled,false);
  assert.equal(h.element('collaboration-enabled').checked,false);
  assert.equal(h.element('collaboration-mode-field').hidden,true);
  assert.match(h.element('collaboration-protocol-help').textContent,/默认只使用当前对话/);
  await h.element('first-task-form').onsubmit({preventDefault(){}});
  const enroll=h.commands.filter(x=>x.action==='start-first-turn');
  assert.equal(enroll.length,1);
  assert.equal(enroll[0].payload.collaboration_protocol,'tool_v1');
  assert.equal(enroll[0].payload.collaboration_enabled,false);
  assert.equal(enroll[0].payload.duration_seconds,null);
  assert.equal(enroll[0].payload.max_dispatches,null);
  assert.equal(h.commands.filter(x=>x.action==='rename').length,0);
  assert.equal(h.commands.filter(x=>x.action==='start'||x.action==='send').length,0);
});

test('text_v1 opt-in is task scoped and becomes read-only when enrollment starts',async()=>{
  const h=shell();h.select('first');
  h.element('collaboration-enabled').checked=true;
  h.element('collaboration-enabled').onchange();
  h.element('collaboration-protocol').value='text_v1';
  h.element('collaboration-protocol').onchange();
  assert.equal(h.element('collaboration-mode-field').hidden,false);
  assert.match(h.element('collaboration-protocol-help').textContent,/实验版/);
  h.select('second');
  assert.equal(h.element('collaboration-protocol').value,'tool_v1');
  assert.equal(h.element('collaboration-enabled').checked,false);
  h.select('first');
  assert.equal(h.element('collaboration-enabled').checked,true);
  assert.equal(h.element('collaboration-protocol').value,'text_v1');
  await h.element('first-task-form').onsubmit({preventDefault(){}});
  assert.equal(h.commands.find(x=>x.action==='start-first-turn').payload.collaboration_protocol,'text_v1');
  assert.equal(h.commands.find(x=>x.action==='start-first-turn').payload.collaboration_enabled,true);
  vm.runInContext("state.pages[0].enrolling=true;state.pages[0].collaboration_enabled=true;state.pages[0].collaboration_protocol='text_v1';fillSettings()",h.context);
  assert.equal(h.element('collaboration-protocol').value,'text_v1');
  assert.equal(h.element('collaboration-protocol').disabled,true);
  assert.equal(h.element('collaboration-enabled').checked,true);
  assert.equal(h.element('collaboration-enabled').disabled,true);
  assert.equal(vm.runInContext("collaborationDrafts.has('first')",h.context),false,'An accepted task uses its durable configuration');
  assert.match(h.element('collaboration-protocol-help').textContent,/已锁定/);
  vm.runInContext("state.pages[0].enrolling=false;state.pages[0].bound=true;fillSettings()",h.context);
  assert.equal(h.element('collaboration-protocol').disabled,true);
  h.select('second');
  assert.equal(h.element('collaboration-protocol').value,'tool_v1');
  assert.equal(h.element('collaboration-protocol').disabled,false);
});

test('explicit false overrides stored first-turn options and the collaboration draft survives renderer recreation',()=>{
  const h=shell();h.select('first');
  h.element('collaboration-enabled').checked=true;h.element('collaboration-enabled').onchange();
  const restored=shell(h.storage);restored.select('first');assert.equal(restored.element('collaboration-enabled').checked,true);
  restored.element('collaboration-enabled').checked=false;restored.element('collaboration-enabled').onchange();
  restored.select('other');
  vm.runInContext("state={pages:[{id:'first',kind:'task',title:'First',firstTurnOptions:{collaboration_enabled:true}}],selected:'first'};fillSettings()",restored.context);
  assert.equal(restored.element('collaboration-enabled').checked,false);
  assert.equal(restored.element('collaboration-mode-field').hidden,true);
});

test('actual task navigation restores collaboration drafts and submits the selected opt-in without affecting another conversation',async()=>{
  const {chromium}=require('../node_modules/playwright-core');
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
    await page.addInitScript(()=>{
      localStorage.clear();window.commands=[];
      window.fixture={connected:true,taskStateReady:true,connectionGeneration:1,selected:'draft-first',closed:[],theme:'dark',pages:
        [{id:'draft-first',title:'首个草稿',kind:'task',account:'A',root:'D:/Fixture/First'},
         {id:'draft-second',title:'第二个草稿',kind:'task',account:'A',root:'D:/Fixture/Second'}]};
      window.clw={onState(callback){window.publish=()=>{callback(window.fixture);renderStateImmediately();};setTimeout(window.publish,0);},onIntent(){},async command(action,payload){
        window.commands.push({action,payload:structuredClone(payload)});
        if(action==='select'){window.fixture.selected=payload.id;window.publish();return {selected:payload.id};}
        return {};
      }};
    });
    await page.goto('file:///'+path.resolve('apps/web-host/index.html').replaceAll('\\','/'));
    await page.locator('#thread-title').getByText('首个草稿',{exact:true}).waitFor();
    await page.locator('#first-task-options>summary').click();
    assert.equal(await page.locator('#collaboration-enabled').isChecked(),false);
    await page.locator('#collaboration-enabled').check();
    await page.locator('#collaboration-protocol').selectOption('text_v1');
    await page.getByRole('button',{name:'打开任务：第二个草稿',exact:true}).click();
    assert.equal(await page.locator('#collaboration-enabled').isChecked(),false);
    await page.getByRole('button',{name:'打开任务：首个草稿',exact:true}).click();
    assert.equal(await page.locator('#collaboration-enabled').isChecked(),true);
    assert.equal(await page.locator('#collaboration-protocol').inputValue(),'text_v1');
    await page.locator('#first-task-objective').fill('完成这个独立任务');await page.locator('#first-task-send').click();
    await page.waitForFunction(()=>!busy.has('first-task'));
    const calls=await page.evaluate(()=>window.commands.filter(row=>row.action==='start-first-turn'));
    assert.equal(calls.length,1);assert.equal(calls[0].payload.id,'draft-first');
    assert.equal(calls[0].payload.collaboration_enabled,true);assert.equal(calls[0].payload.collaboration_protocol,'text_v1');
    await page.getByRole('button',{name:'打开任务：第二个草稿',exact:true}).click();
    assert.equal(await page.locator('#collaboration-enabled').isChecked(),false);
    await page.locator('#first-task-objective').fill('直接开始普通对话');await page.locator('#first-task-send').click();
    await page.waitForFunction(()=>!busy.has('first-task'));
    const latest=await page.evaluate(()=>window.commands.filter(row=>row.action==='start-first-turn').at(-1));
    assert.equal(latest.payload.id,'draft-second');assert.equal(latest.payload.collaboration_enabled,false);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('old bound task without a protocol record displays locked tool_v1',()=>{
  const h=shell();
  vm.runInContext("state={pages:[{id:'old',title:'Old',kind:'task',root:'D:\\\\project',bound:true}],selected:'old'};fillSettings()",h.context);
  assert.equal(h.element('collaboration-protocol').value,'tool_v1');
  assert.equal(h.element('collaboration-protocol').disabled,true);
});

test('prompt preview uses the explicit collaboration choice and checkbox changes repaint it without sending',async()=>{
  const h=shell();h.select('preview');h.element('task-prompt-preview').open=true;
  await vm.runInContext('renderPromptPreview()',h.context);
  assert.equal(h.commands.findLast(x=>x.action==='prompt-preview').payload.collaboration_enabled,false);
  h.element('collaboration-enabled').checked=true;h.element('collaboration-enabled').onchange();
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(h.commands.findLast(x=>x.action==='prompt-preview').payload.collaboration_enabled,true);
  assert.equal(h.commands.filter(x=>['start','send','start-first-turn','enroll'].includes(x.action)).length,0);
});

test('team maintenance captures the original task before another task is selected',async()=>{
  const h=shell();h.select('original');
  let finish;const command=h.context.window.clw.command;
  h.context.window.clw.command=(action,payload)=>{
    if(action!=='team-maintenance')return command(action,payload);
    h.commands.push({action,payload});return new Promise(resolve=>{finish=resolve;});
  };
  const submitting=h.element('team-maintenance').onclick();
  const maintenance=h.commands.filter(c=>c.action==='team-maintenance');assert.equal(maintenance.length,1);
  h.select('another');finish({state:'resumed'});await submitting;
  assert.equal(maintenance[0].payload.id,'original');
  assert.equal(h.commands.filter(c=>c.action==='team-maintenance').length,1);
  assert.equal(h.commands.filter(c=>['start','send','pause','resume'].includes(c.action)).length,0);
});

test('enrollment keeps the original task and settings if selection changes during rename',async()=>{
  const h=shell();h.select('first');
  h.element('root').value='D:\\first';
  h.element('collaboration-protocol').value='text_v1';
  h.element('collaboration-protocol').onchange();
  h.element('title').value='Renamed';
  let finishRename;
  const command=h.context.window.clw.command;
  h.context.window.clw.command=(action,payload)=>{
    if(action==='rename'){
      h.commands.push({action,payload});
      return new Promise(resolve=>{finishRename=resolve;});
    }
    return command(action,payload);
  };
  const submitting=h.element('first-task-form').onsubmit({preventDefault(){}});
  assert.equal(typeof finishRename,'function');
  h.select('second');h.element('root').value='D:\\second';
  finishRename({renamed:true});await submitting;
  const enroll=h.commands.find(x=>x.action==='start-first-turn');
  assert.equal(enroll.payload.id,'first');
  assert.equal(enroll.payload.effort,'极高');
  assert.equal(enroll.payload.collaboration_protocol,'text_v1');
});

test('task controls send an explicit owner and only an active request is the pause or resume guard',async()=>{
  const h=shell();h.select('original');
  vm.runInContext("state.view={page_id:'original',thread_id:'original-thread',request:{id:'accepted-request',phase:'processing'}}",h.context);
  await h.element('pause').onclick();
  assert.equal(h.commands.at(-1).payload.id,'original');assert.equal(h.commands.at(-1).payload.expected_request_id,'accepted-request');
  vm.runInContext("state.view={page_id:'original',thread_id:'original-thread'};state.pages[0].latest_request={id:'old-completed',phase:'completed'}",h.context);
  await h.element('resume').onclick();
  assert.equal(h.commands.at(-1).payload.id,'original');assert.equal(h.commands.at(-1).payload.expected_request_id,null);
  await vm.runInContext("act('inspect',{id:'explicit-wrong-owner'})",h.context);
  assert.equal(h.commands.at(-1).payload.id,'explicit-wrong-owner');
});

test('a late model read cannot attach to another thread after an A to B to A selection',async()=>{
  const h=shell();h.select('original');
  vm.runInContext("state.view={page_id:'original',thread_id:'original-thread',request:{id:'accepted-original',phase:'processing'}}",h.context);
  let finish;const command=h.context.window.clw.command;
  h.context.window.clw.command=(action,payload)=>{if(action!=='inspect')return command(action,payload);h.commands.push({action,payload});return new Promise(resolve=>{finish=resolve;});};
  const reading=h.element('inspect').onclick();assert.equal(h.commands.at(-1).payload.id,'original');
  h.select('other');h.select('original');
  vm.runInContext("state.view={page_id:'original',thread_id:'replacement-thread',request:{id:'accepted-replacement',phase:'processing'}}",h.context);
  finish({model:'GPT-6',effort:'Pro'});await reading;
  assert.equal(vm.runInContext("modelDrafts.has('original')",h.context),false);
});

test('a reconnected service cannot present a pre-reconnect model read as current',async()=>{
  const h=shell();h.select('original');
  vm.runInContext("state.connectionGeneration=1;state.view={page_id:'original',thread_id:'original-thread'}",h.context);
  let finish;h.context.window.clw.command=()=>new Promise(resolve=>{finish=resolve;});
  const reading=h.element('inspect').onclick();vm.runInContext('state.connectionGeneration=2',h.context);
  finish({model:'GPT-6',effort:'Pro'});await reading;
  assert.equal(vm.runInContext("modelDrafts.has('original')",h.context),false);
});

test('accepted model adoption cleans its original draft without painting a different selected task',async()=>{
  const h=shell();h.select('original');
  vm.runInContext("modelDrafts.set('original',{model:'GPT-6',effort:'Pro'})",h.context);
  let finish;const command=h.context.window.clw.command;
  h.context.window.clw.command=(action,payload)=>{if(action!=='adopt-model')return command(action,payload);h.commands.push({action,payload});return new Promise(resolve=>{finish=resolve;});};
  const adopting=h.element('adopt-model').onclick();assert.equal(h.commands.at(-1).payload.id,'original');
  h.select('other');finish({model:'GPT-6',effort:'Pro'});await adopting;
  assert.equal(vm.runInContext("modelDrafts.has('original')",h.context),false);
  assert.equal(h.element('notice-text').textContent,'');
});

test('a late model read cannot become current after a Web to local to Web workflow change',async()=>{
  const h=shell();h.select('original');let finish;
  const command=h.context.window.clw.command;
  h.context.window.clw.command=(action,payload)=>action==='inspect'?new Promise(resolve=>{finish=resolve;}):command(action,payload);
  const reading=h.element('inspect').onclick();
  vm.runInContext("setWorkflowMode('local');setWorkflowMode('web')",h.context);
  finish({model:'GPT-6',effort:'Pro'});await reading;
  assert.equal(vm.runInContext("modelDrafts.has('original')",h.context),false);
});
