'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),vm=require('node:vm');
const {WebDriver}=require('../web-driver.cjs'),{dom}=require('../page-dom.cjs');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');

function fixture(options={}){
  let position=options.position??3,inspections=0;const calls=[],sends=[],keys=[];
  const record={page_id:'original-successor',account:'A',root:'D:/original-camp',phase:'reserved',bootstrap_state:'pending',
    first_turn_mode:'prepare_v1',first_turn_instructions:'',bootstrap_text:'Only enter the original project.',
    model:'GPT-6 · 最新',effort:'Pro',model_selection:{model:'GPT-6 · 最新',effort:'Pro',selection:['最新']},work_model_pending:true,
    bootstrap_model_selection:{model:'GPT-6 · 最新',effort:'极高',selection:['最新']},...options.record};
  const page={id:record.page_id,account:record.account,view:{webContents:{getURL:()=> 'https://chatgpt.com/c/original'}}};
  const model=()=>({model:`GPT-${position===4?(options.proVersion||'6'):(options.version||'6.1')} · ${options.family||'Latest'}`,
    effort:options.effort||['低','中','高','极高','Pro'][position],selection:[options.family||'Latest'],
    options:[{name:options.family||'Latest',checked:true,available:true}],sliderCount:1,sliderContainerCount:1,
    slider:{min:0,max:4,value:position},efforts:['低','中','高','极高','Pro'].map((label,value)=>({label,value,available:true})),...options.model?.(position)});
  const runtime=new EventEmitter();runtime.call=async(op,payload)=>{calls.push([op,payload]);options.onCall?.(op,payload);if(op==='bootstrap')record.bootstrap_state=payload.state;return {};};
  const driver=new WebDriver({runtime,pool:{pages:new Map([[page.id,page]]),running(){},work(){},layout(){}},onNotice(){},sleep:async()=>{},
    dom:async(_wc,action)=>{
      if(action==='snapshot')return {url:'https://chatgpt.com/c/original',editor:true,controlKnown:true,userId:'previous-user',assistantId:'previous-answer',generating:false,draft:false,composing:false};
      if(action==='connector-state')return options.connectorState||{editorCount:1,text:'',selected:['Local-MCP'],visibleSelectedCount:1};
      if(action==='model')return model();return {};
    },input:{key:async(_wc,key)=>{if(key!=='Escape'){position+=key==='ArrowRight'?1:-1;keys.push(position);}}}});
  driver.inspect=async()=>{inspections++;return {...model(),...options.inspection?.(inspections)};};
  driver.send=async(_p,prompt,_baseline,_marker,_context,beforeSend)=>{if(options.sendError)throw options.sendError;await beforeSend?.();sends.push(prompt);return {};};
  return {driver,page,record,calls,sends,keys,model};
}

test('a wrong actual connector holds the original pending bootstrap before consuming a Send or its budget',async()=>{
 const f=fixture({connectorState:{editorCount:1,text:'',selected:['CLW T003 Stable No-OIDC'],visibleSelectedCount:1}});
 await f.driver.tick(f.record);
 assert.equal(f.sends.length,0);assert.equal(f.record.bootstrap_state,'pending');assert.equal(f.calls.some(([op])=>op==='bootstrap'),false);
 assert.equal(f.calls.find(([op])=>op==='page-issue')[1].kind,'control_failed');
});
test('a known body failure before bootstrap admission retains pending and the original draft without a budget or unknown Send',async()=>{
 const f=fixture({sendError:Object.assign(Error('完整正文未保留'),{code:'editor_prompt_mismatch',notSent:true})});await f.driver.tick(f.record);
 assert.equal(f.sends.length,0);assert.equal(f.record.bootstrap_state,'pending');assert.equal(f.calls.some(([op])=>op==='bootstrap'),false);
 assert.equal(f.calls.find(([op])=>op==='page-issue')[1].kind,'control_failed');
});

test('setup-only Latest observes 6.1 Extra High and verifies formal 6 Pro after binding without a second Send',async()=>{
  const f=fixture();await f.driver.tick(f.record);
  assert.equal(f.sends.length,1);assert.match(f.sends[0],/\[CLW-BOOTSTRAP:original-successor\]/);
  assert.equal(f.calls.find(([op])=>op==='bootstrap-model-ready')[1].model_selection.model,'GPT-6.1 · Latest');
  assert.equal(f.record.model,'GPT-6 · 最新');assert.equal(f.record.effort,'Pro');assert.equal(f.record.account,'A');
  assert.deepEqual(f.keys,[]);assert.ok(!f.calls.some(([op])=>op==='page-issue'));
  await f.driver.tick({...f.record,phase:'bound',url:'https://chatgpt.com/c/original'});
  const work=f.calls.find(([op])=>op==='work-model-ready')[1].model_selection;
  assert.equal(work.model,'GPT-6 · Latest');assert.equal(work.effort,'Pro');assert.equal(f.sends.length,1);assert.deepEqual(f.keys,[4]);
});

test('setup may move from the observed Latest Pro slider to the original requested Extra High slot',async()=>{
  const f=fixture({position:4});await f.driver.tick(f.record);
  assert.equal(f.sends.length,1);assert.deepEqual(f.keys,[3]);
  assert.equal(f.calls.find(([op])=>op==='bootstrap-model-ready')[1].model_selection.model,'GPT-6.1 · Latest');
});

test('crossover accepts only a single localized Latest choice within major family 6',async()=>{
  for(const invalid of [
    {version:'5.6'},{version:'7.0'},{family:'Newest'},
    {model:()=>({selection:['Latest','GPT-6']})},
    {record:{bootstrap_model_selection:{model:'GPT-6 Sol',effort:'极高',selection:['GPT-6 Sol']}}},
    {record:{bootstrap_model_selection:{model:'GPT-6 · 最新',effort:'极高',selection:['GPT-6','最新']}}},
    {record:{bootstrap_model_selection:{model:'GPT-6 · 最新',effort:'极高'}}}
  ]){
    const f=fixture(invalid);await f.driver.tick(f.record);
    assert.equal(f.sends.length,0,JSON.stringify(invalid));assert.ok(!f.calls.some(([op])=>op==='bootstrap-model-ready'));
    assert.equal(f.calls.find(([op])=>op==='page-issue')[1].kind,'model_unavailable');
  }
});

test('substantive first tasks, preparation instructions and no pending formal-work model keep exact matching',async()=>{
  for(const record of [{first_turn_instructions:'Implement and deliver the complete module.'},{first_turn_mode:'task_v1'},{work_model_pending:false}]){
    const f=fixture({record});await f.driver.tick(f.record);assert.equal(f.sends.length,0);
    assert.equal(f.calls.find(([op])=>op==='page-issue')[1].kind,'model_unavailable');
  }
});

test('a changed final public menu cannot authorize setup even when its old model label looked compatible',async()=>{
  for(const changed of [{selection:['GPT-6 Sol']},{model:'GPT-7 · Latest'},{effort:'Pro'},{model:'GPT-6.2 · Latest'},{sliderCount:2}]){
    const f=fixture({inspection:count=>count>=3?changed:{}});await f.driver.tick(f.record);
    assert.equal(f.sends.length,0);assert.ok(!f.calls.some(([op])=>op==='bootstrap-model-ready'));
    assert.equal(f.calls.find(([op])=>op==='page-issue')[1].kind,'model_unavailable');
  }
});

test('duplicate controls or wrong observed effort stop before bootstrap readiness and Send',async()=>{
  for(const overrides of [{sliderCount:2},{sliderContainerCount:2},{sliderCount:0}]){
    const f=fixture({model:()=>overrides});await f.driver.tick(f.record);assert.equal(f.sends.length,0);
    assert.ok(!f.calls.some(([op])=>op==='bootstrap-model-ready'));
  }
  const effort=fixture({effort:'Pro'});await effort.driver.tick(effort.record);assert.equal(effort.sends.length,0);
  assert.equal(effort.calls.find(([op])=>op==='page-issue')[1].kind,'model_unavailable');
});

test('menu changes during the durable readiness call keep the original bootstrap pending with zero Sends',async()=>{
  let changed=false;const f=fixture({onCall:op=>{if(op==='bootstrap-model-ready')changed=true;},model:()=>changed?{selection:['GPT-6 Sol']}:{}});
  await f.driver.tick(f.record);assert.equal(f.sends.length,0);assert.equal(f.record.bootstrap_state,'pending');
  assert.equal(f.calls.filter(([op])=>op==='bootstrap-model-ready').length,1);assert.ok(!f.calls.some(([op])=>op==='bootstrap'));
  assert.equal(f.calls.find(([op])=>op==='page-issue')[1].kind,'model_unavailable');
});

test('already observed 6.1 setup rechecks the public choice after readiness even without a version difference',async()=>{
  let changed=false;const f=fixture({record:{bootstrap_model_selection:{model:'GPT-6.1 · Latest',effort:'极高',selection:['Latest']}},
    onCall:op=>{if(op==='bootstrap-model-ready')changed=true;},model:()=>changed?{selection:['GPT-6 Sol']}:{}});
  await f.driver.tick(f.record);assert.equal(f.sends.length,0);assert.equal(f.record.bootstrap_state,'pending');
  assert.equal(f.calls.filter(([op])=>op==='bootstrap-model-ready').length,1);assert.ok(!f.calls.some(([op])=>op==='bootstrap'));
  assert.equal(f.calls.find(([op])=>op==='page-issue')[1].kind,'model_unavailable');
});

test('an initially identical Latest version still rechecks a menu changed during readiness with zero Sends',async()=>{
  for(const version of ['6','6.1']){
    let changed=false;const f=fixture({version,record:{bootstrap_model_selection:{model:`GPT-${version} · Latest`,effort:'极高',selection:['Latest']}},
      onCall:op=>{if(op==='bootstrap-model-ready')changed=true;},model:()=>changed?{selection:['GPT-6 Sol']}:{}});
    await f.driver.tick(f.record);assert.equal(f.sends.length,0,version);assert.equal(f.record.bootstrap_state,'pending');
    assert.equal(f.calls.filter(([op])=>op==='bootstrap-model-ready').length,1);assert.ok(!f.calls.some(([op])=>op==='bootstrap'));
  }
});

test('formal work readiness cannot accept a 6.1 Pro label in place of recorded 6 Pro',async()=>{
  const f=fixture({position:4,proVersion:'6.1',record:{phase:'bound',bootstrap_state:'sent',url:'https://chatgpt.com/c/original'}});
  await f.driver.tick(f.record);assert.equal(f.sends.length,0);assert.ok(!f.calls.some(([op])=>op==='work-model-ready'||op==='wire'));
  assert.equal(f.calls.find(([op])=>op==='page-issue')[1].kind,'model_unavailable');
});

test('paused and already sent or unknown bootstrap keep their original no-Send boundary',async()=>{
  for(const record of [{paused:true},{bootstrap_state:'sent'},{bootstrap_state:'unknown'}]){
    const f=fixture({record});await f.driver.tick(f.record);assert.equal(f.sends.length,0);
    assert.ok(!f.calls.some(([op])=>op==='bootstrap-model-ready'||op==='bootstrap'));
  }
});

function publicModel(extra='',{prefix='',activeVersion='6.1',innerPrefix=''}={}){
  const ticks=Array.from({length:5},(_,i)=>`<span data-selected="${i===3}"></span>`).join('');
  const slider='<div data-model-picker-power-slider>'+innerPrefix+'<span data-orientation="horizontal" aria-disabled="false">'+ticks+'<span id="active-slider" role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="3" aria-valuetext="'+activeVersion+' 极高，第 4 项，共 5 项。"></span></span></div>';
  const html='<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox"></div><button data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" aria-haspopup="menu" aria-controls="owned-picker">极高</button></form>'+
    '<div role="menu" id="owned-picker"><div role="menuitemradio" aria-checked="true">Latest</div>'+prefix+slider+extra.replaceAll('$SLIDER',slider)+'</div>'+
    '<div role="menu" id="unrelated-picker">'+slider+'</div>';
  const window=createWindow(html);window.document.hasFocus=()=>false;
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.closest('[hidden],[inert]')?0:100;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return this.offsetWidth?30:0;}});
  window.HTMLElement.prototype.getClientRects=function(){return this.offsetWidth?[{}]:[];};
  for(const list of [window.document.querySelectorAll('div'),window.document.body.children])Object.defineProperty(Object.getPrototypeOf(list),Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
  const focused=[];for(const element of window.document.querySelectorAll('[role="slider"],[role="menuitem"]'))
    Object.defineProperty(element,'focus',{configurable:true,value(){focused.push(this);}});
  const context=vm.createContext({document:window.document,location:{href:'https://chatgpt.com/c/original'}});
  const read=action=>vm.runInContext(`(${dom.toString()})(${JSON.stringify(action)},{},()=>{},()=>false,()=>({required:false}))`,context);
  const result=JSON.parse(JSON.stringify(read('model')));
  Object.defineProperties(result,{focus:{value:()=>read('focus-effort')},focused:{value:focused}});return result;
}

test('public DOM reports only current owned visible sliders; duplicate owned controls cannot Send',async()=>{
  const one=publicModel('<div hidden>$SLIDER</div>');assert.equal(one.sliderCount,1);assert.equal(one.sliderContainerCount,1);assert.equal(one.model,'GPT-6.1 · Latest');
  const duplicate=publicModel('$SLIDER');assert.equal(duplicate.sliderCount,2);assert.equal(duplicate.sliderContainerCount,2);
  assert.equal(duplicate.slider,null);assert.throws(()=>duplicate.focus(),/effort_slider_missing/);assert.equal(duplicate.focused.length,0);
  const f=fixture({model:()=>duplicate});await assert.rejects(()=>f.driver.tick(f.record),/完整的档位可用性/);assert.equal(f.sends.length,0);
  assert.ok(!f.calls.some(([op])=>op==='bootstrap-model-ready'));
});

test('hidden old 6.1 container before visible 7 cannot supply its model, positions or focus target',async()=>{
  const stale='<div hidden><div data-model-picker-power-slider><span data-selected="true"></span><span role="slider" id="stale-slider" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0" aria-valuetext="6.1 Extra High"></span></div></div>';
  const observed=publicModel('',{prefix:stale,activeVersion:'7'});
  assert.equal(observed.model,'GPT-7 · Latest');assert.equal(observed.sliderCount,1);assert.equal(observed.sliderContainerCount,1);
  assert.equal(observed.efforts.length,5);assert.deepEqual(observed.slider,{min:0,max:4,value:3});observed.focus();
  assert.equal(observed.focused.length,1);assert.equal(observed.focused[0].id,'active-slider');
  const f=fixture({model:()=>observed});await f.driver.tick(f.record);assert.equal(f.sends.length,0);
  assert.equal(f.calls.find(([op])=>op==='page-issue')[1].kind,'model_unavailable');
});

test('a hidden old slider and ticks first in one container cannot replace the unique visible slider',async()=>{
  const stale='<span hidden><span data-selected="true"></span><span role="slider" id="stale-slider" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0" aria-valuetext="6.1 Extra High"></span></span>';
  const observed=publicModel('',{innerPrefix:stale,activeVersion:'7'});
  assert.equal(observed.model,'GPT-7 · Latest');assert.equal(observed.sliderCount,1);assert.equal(observed.sliderContainerCount,1);assert.equal(observed.efforts.length,5);
  observed.focus();assert.equal(observed.focused[0].id,'active-slider');
  const f=fixture({model:()=>observed});await f.driver.tick(f.record);assert.equal(f.sends.length,0);
});

test('two visible sliders in the same owned container are ambiguous and cannot be focused or sent',async()=>{
  const other='<span role="slider" id="other-slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="3" aria-valuetext="6.1 Extra High"></span>';
  const observed=publicModel('',{innerPrefix:other});assert.equal(observed.sliderCount,2);assert.equal(observed.sliderContainerCount,1);assert.equal(observed.slider,null);
  assert.throws(()=>observed.focus(),/effort_slider_missing/);assert.equal(observed.focused.length,0);
  const f=fixture({model:()=>observed});await assert.rejects(()=>f.driver.tick(f.record),/完整的档位可用性/);assert.equal(f.sends.length,0);
});
