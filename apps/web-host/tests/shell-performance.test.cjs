'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');

const host=path.resolve(__dirname,'..');
const copy=value=>JSON.parse(JSON.stringify(value));
const page=(id,extra={})=>({id,title:id==='alpha'?'Alpha':'Beta',kind:'task',root:'D:/fixture/project',
  account:'B',bound:true,enrollment_phase:'bound',selected:id==='alpha',model:'GPT-6 Latest',effort:'Pro',
  status:'idle',paused:false,first_turn_instructions:'Initial complete task',latest_request:null,
  observation:{at:Date.now(),model:'GPT-6 Latest',effort:'Pro',generating:false,historyAtLatest:true},...extra});
const snapshot=(extra={})=>({pages:[page('alpha'),page('beta')],closed:[],selected:'alpha',connected:true,
  taskStateReady:true,root:'D:/fixture/project',codexWeb:{recent:[]},
  view:{page_id:'alpha',events:[],request:null,latest_request:null,
    run:{state:'running',dispatches:4,max_dispatches:40,deadline:Date.now()/1000+21600},
    send_stats:{confirmed:4,unconfirmed:0}},...extra});

// Load every external UMD script in the real HTML order. The only emulation is
// browser platform behavior absent from domino; no application render is stubbed.
function shell(){
  const window=createWindow(fs.readFileSync(path.join(host,'index.html'),'utf8'));
  const document=window.document,commands=[],storage=new Map(),frames=new Map(),timers=new Map();
  const paints={count:0},submissions=[],valueWrites=new Map();
  let stateListener,intentListener,controlListener,commandHandler,hidden=false,activeElement=document.body,nextId=0;
  const controlReplies=[];
  let bounds={x:228,y:78,width:900,height:700};
  const element=id=>document.getElementById(id);
  const retiredHistoryControls={button:element('quota-history-check'),window:element('quota-usage-window'),since:element('quota-usage-since'),check:element('quota-check')};
  const method=(node,key,value)=>Object.defineProperty(node,key,{value,writable:true,configurable:true});
  for(const collection of [document.querySelectorAll('dialog'),document.body.children]){
    if(!collection[Symbol.iterator])Object.defineProperty(Object.getPrototypeOf(collection),Symbol.iterator,{
      value:function*(){for(let index=0;index<this.length;index++)yield this[index];},configurable:true});
  }
  const append=function(...items){for(const item of items)this.appendChild(typeof item==='string'?this.ownerDocument.createTextNode(item):item);};
  if(!window.Element.prototype.append)window.Element.prototype.append=append;
  if(!window.Element.prototype.replaceChildren)window.Element.prototype.replaceChildren=function(...items){
    while(this.firstChild)this.removeChild(this.firstChild);append.apply(this,items);
  };
  if(!('dataset' in window.Element.prototype))Object.defineProperty(window.Element.prototype,'dataset',{
    get(){const node=this;return new Proxy({},{get:(_,key)=>node.getAttribute('data-'+String(key).replace(/[A-Z]/g,c=>'-'+c.toLowerCase())),
      set:(_,key,value)=>{node.setAttribute('data-'+String(key).replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),String(value));return true;}});}
  });
  const focusable=node=>{
    Object.defineProperty(node,'focus',{value(){activeElement=this;},configurable:true});
    Object.defineProperty(node,'blur',{value(){if(activeElement===this)activeElement=document.body;},configurable:true});
    return node;
  };
  for(const node of document.querySelectorAll('*'))focusable(node);
  const createElement=document.createElement.bind(document);
  document.createElement=(...args)=>focusable(createElement(...args));
  window.Element.prototype.scrollIntoView=function(){};
  window.Element.prototype.getBoundingClientRect=function(){
    const r=this.id==='page-host'?bounds:{x:20,y:20,width:120,height:30};
    return {...r,left:r.x,top:r.y,right:r.x+r.width,bottom:r.y+r.height};
  };
  for(const dialog of document.querySelectorAll('dialog')){
    method(dialog,'showModal',function(){this.open=true;this.setAttribute('open','');});
    method(dialog,'close',function(){this.open=false;this.removeAttribute('open');this.onclose?.(new window.Event('close'));});
  }
  for(const menu of document.querySelectorAll('[popover]')){
    menu.hidePopover=function(){this.__shown=false;};menu.showPopover=function(){this.__shown=true;};
    menu.togglePopover=function(){this.__shown=!this.__shown;};
    method(menu,'matches',function(selector){return selector===':popover-open'?this.__shown===true:window.Element.prototype.matches.call(this,selector);});
  }
  for(const form of document.querySelectorAll('form')){
    method(form,'checkValidity',()=>true);method(form,'reportValidity',()=>true);
    method(form,'requestSubmit',()=>submissions.push(form.id));
  }
  for(const input of document.querySelectorAll('input,textarea')){
    input.selectionStart=0;input.selectionEnd=0;input.selectionDirection='none';
    input.setSelectionRange=function(start,end,direction='none'){
      this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;
    };
    let prototype=input,descriptor;
    while(prototype&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(prototype,'value');prototype=Object.getPrototypeOf(prototype);}
    if(descriptor?.get&&descriptor?.set)Object.defineProperty(input,'value',{configurable:true,
      get(){return descriptor.get.call(this);},set(value){
        const previous=descriptor.get.call(this);descriptor.set.call(this,value);
        valueWrites.set(this,(valueWrites.get(this)||0)+1);
        if(previous!==String(value))this.setSelectionRange(String(value).length,String(value).length);
      }});
  }
  Object.defineProperties(document,{hidden:{get:()=>hidden,configurable:true},
    visibilityState:{get:()=>hidden?'hidden':'visible',configurable:true},
    activeElement:{get:()=>activeElement,configurable:true}});
  const localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value))};
  window.innerWidth=1280;window.innerHeight=900;
  window.clw={command:async(action,payload={})=>{commands.push({action,payload:copy(payload)});return commandHandler?commandHandler(action,copy(payload)):{};},
    onState:listener=>{stateListener=listener;},onIntent:listener=>{intentListener=listener;},
    onControl:listener=>{controlListener=listener;},respondControl:reply=>controlReplies.push(copy(reply))};
  const context=vm.createContext({atob:globalThis.atob,crypto:require('node:crypto').webcrypto,window,document,localStorage,console,__shellPaints:paints,
    ResizeObserver:class{constructor(callback){this.callback=callback;}observe(){}},
    requestAnimationFrame:callback=>{const id=++nextId;frames.set(id,callback);return id;},
    cancelAnimationFrame:id=>frames.delete(id),
    setTimeout:callback=>{const id=++nextId;timers.set(id,callback);return id;},clearTimeout:id=>timers.delete(id)});
  for(const script of document.querySelectorAll('script[src]')){
    const source=script.getAttribute('src');
    assert.ok(!source.includes('..')&&!source.includes('://'),'Only local shell scripts may execute');
    vm.runInContext(fs.readFileSync(path.join(host,source),'utf8'),context,{filename:source});
  }
  vm.runInContext('const __originalShellRender=render;render=function(...args){__shellPaints.count++;return __originalShellRender(...args);};',context);
  const evaluate=code=>vm.runInContext(code,context);
  const frame=()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(16);return pending.length;};
  const flush=()=>{let count=0;while(frames.size){assert.ok(count++<20,'Frame scheduling must settle');frame();}};
  return {window,document,element,retiredHistoryControls,commands,storage,frames,paints,submissions,valueWrites,evaluate,frame,flush,
    publish:next=>{assert.equal(typeof stateListener,'function');stateListener(copy(next));},
    intent:next=>intentListener(next),setBounds:next=>{bounds={...next};},
    control:async(action,payload={})=>{await controlListener({id:'original-control',action,payload});return controlReplies.at(-1);},
    setCommand:handler=>{commandHandler=handler;},
    setHidden:value=>{hidden=value;document.dispatchEvent(new window.Event('visibilitychange'));},
    layouts:()=>commands.filter(command=>command.action==='layout'),
    currentState:()=>copy(evaluate('state'))};
}

test('the real shell and all shipped UMD renderers load and render a selected task',()=>{
  const h=shell();h.publish(snapshot());h.flush();
  assert.equal(h.element('thread-title').textContent,'Alpha');
  assert.equal(h.element('pages').querySelectorAll('.task-row').length,2);
  assert.equal(h.element('pages').querySelector('[data-page-id="alpha"] .task-select').getAttribute('aria-current'),'page');
  assert.ok(h.layouts().length>0);
  assert.equal(h.commands.filter(command=>['start','send','enroll','start-first-turn'].includes(command.action)).length,0);
});

test('task navigation can collapse and return without changing the selected task or issuing work',()=>{
  const h=shell();h.publish(snapshot());h.flush();
  h.element('objective').value='Keep this original task draft';
  const first=h.commands.length;
  h.element('sidebar-toggle').onclick();h.flush();
  assert.equal(h.document.body.classList.contains('nav-collapsed'),true);
  assert.equal(h.element('sidebar-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(h.storage.get('clw-navigation-collapsed'),'true');
  h.publish(snapshot());h.flush();
  assert.equal(h.document.body.classList.contains('nav-collapsed'),true);
  h.element('sidebar-toggle').onclick();h.flush();
  assert.equal(h.element('sidebar-toggle').getAttribute('aria-expanded'),'true');
  assert.equal(h.currentState().selected,'alpha');
  assert.equal(h.element('objective').value,'Keep this original task draft');
  assert.deepEqual(h.commands.slice(first).filter(row=>row.action!=='layout'),[]);
});

test('configured goal stays above the composer; unset goal is reached through the plus menu',()=>{
  const h=shell(),initial=snapshot();h.publish(initial);h.flush();
  assert.equal(h.document.querySelectorAll('#settings-refill').length,1);
  assert.equal(h.element('settings-refill').closest('#composer-goal').id,'composer-goal');
  assert.equal(h.element('settings-refill').hidden,true);
  assert.equal(h.element('composer-add-goal').hidden,false);
  assert.equal(h.element('composer-add-goal').textContent,'设置目标');
  initial.view.goal={configured:true,objective:'Original goal',state:'paused',mode:'manual',cycles:2};
  h.publish(initial);h.flush();
  assert.equal(h.element('settings-refill').hidden,false);
  assert.equal(h.element('composer-goal-objective').textContent,'Original goal');
  assert.equal(h.element('composer-goal-state').textContent,'目标已暂停');
  assert.equal(h.element('composer-goal-meta').textContent,'已接续 2 包');
  assert.equal(h.element('details').hidden,true);
  h.element('mode-codex').onclick();h.flush();assert.equal(h.element('settings-refill').hidden,true);
  h.element('mode-local').onclick();h.flush();assert.equal(h.element('settings-refill').hidden,true);
  h.element('mode-web').onclick();h.flush();assert.equal(h.element('settings-refill').hidden,false);
  const worker=copy(initial);worker.pages[0].parent='other-controller';h.publish(worker);h.flush();
  assert.equal(h.element('settings-refill').hidden,true);
  assert.equal(h.element('composer-add-goal').hidden,true);
  assert.equal(h.commands.some(row=>['start','send','resume','goal-save','goal-continue'].includes(row.action)),false);
});

test('conversation messages remain continuous when new replies arrive while explicitly collapsed messages stay collapsed',()=>{
  const h=shell(),initial=snapshot();initial.recordHistory={web:true};
  const event=seq=>({seq,kind:'assistant_message',at:'2026-10-05T12:00:00Z',data:{text:'Complete reply '+seq}});
  initial.view.thread_id='original-alpha';initial.view.events=Array.from({length:9},(_,i)=>event(i+1));
  initial.view.record_history={total:9,has_before:false,has_after:false};
  h.publish(initial);h.flush();
  const messages=[...h.element('events').querySelectorAll('.record-message')];
  assert.equal(messages.length,9);assert.equal(messages.every(row=>row.open),true);
  assert.match(messages[0].textContent,/Complete reply 1/);
  messages[1].open=false;messages[1].dispatchEvent(new h.window.Event('toggle'));
  const next=copy(initial);next.view.events.push(event(10),event(11));next.view.record_history.total=11;
  h.publish(next);h.flush();
  assert.equal(messages[0].open,true,'New replies must not automatically close earlier visible messages');
  assert.equal(messages[1].open,false,'User controlled folding remains explicit');
  assert.equal(h.element('events').querySelector('[data-seq="11"]').open,true);
  assert.equal(h.element('events').querySelector('[data-seq="1"]'),messages[0]);
  assert.equal(h.commands.some(row=>['start','send','resume','goal-continue'].includes(row.action)),false);
});

test('volatile long first-turn content, budget and observation timing preserve navigation nodes',()=>{
  const h=shell(),initial=snapshot();h.publish(initial);h.flush();
  const row=h.element('pages').querySelector('[data-page-id="alpha"]'),select=row.querySelector('.task-select');
  h.element('pages').scrollTop=173;select.focus();
  const next=copy(initial);
  next.pages[0].first_turn_instructions='A substantive first turn. '.repeat(6000);
  next.pages[0].firstTurnDraft='Changed saved draft. '.repeat(3000);
  next.pages[0].observation.at+=4000;next.pages[0].observation.elapsedMs=94000;
  next.pages[0].budget_status={available_sends:39,deadline:Date.now()/1000+21600};
  next.view.run.dispatches=5;next.view.run.deadline+=3600;
  h.publish(next);h.flush();
  assert.ok(h.element('pages').querySelector('[data-page-id="alpha"]')===row,'Volatile state must keep the same navigation DOM node');
  assert.ok(h.document.activeElement===select,'The selected navigation control must retain focus');
  assert.equal(h.element('pages').scrollTop,173);
  assert.match(h.element('run-info').textContent,/5 \/ 40/);
});

test('inactive worker records collapse and expand reversibly without issuing task commands',()=>{
  const h=shell(),initial=snapshot();
  const phases=['completed','blocked','cancelled','failed','withdrawn'];
  initial.pages.push(...phases.map(phase=>page('worker-'+phase,{title:'Worker '+phase,parent:'alpha',selected:false,
    latest_request:{id:'request-'+phase,phase}})),page('worker-idle',{title:'Idle worker',parent:'alpha',selected:false}));
  h.publish(initial);h.flush();
  const commandStart=h.commands.length;
  const rows=()=>[...h.element('pages').querySelectorAll('.task-row')].map(row=>row.dataset.pageId);
  const toggle=()=>h.element('pages').querySelector('.worker-toggle');
  assert.deepEqual(rows(),['alpha','beta'],'Inactive workers start folded while main conversations remain visible');
  assert.ok(toggle(),'The project offers access to its folded worker records');
  assert.equal(toggle().getAttribute('aria-expanded'),'false');
  toggle().onclick();h.flush();
  assert.deepEqual(rows(),initial.pages.map(p=>p.id));
  assert.equal(toggle().getAttribute('aria-expanded'),'true');
  toggle().onclick();h.flush();
  assert.deepEqual(rows(),['alpha','beta']);
  assert.equal(toggle().getAttribute('aria-expanded'),'false');
  assert.deepEqual(h.currentState().pages,initial.pages,'Folding must preserve original worker state and request records');
  assert.deepEqual(h.currentState().closed,initial.closed,'Folding must not close a conversation');
  assert.equal(h.currentState().selected,'alpha');
  assert.deepEqual(h.commands.slice(commandStart).filter(command=>command.action!=='layout'),[],'Display-only folding must not issue task commands');
});

test('active workers stay visible and selection or search reveals folded worker records',()=>{
  const h=shell(),initial=snapshot();
  const worker=(id,extra={})=>page(id,{title:id,parent:'alpha',selected:false,...extra});
  const observed=extra=>({...initial.pages[0].observation,...extra});
  const active=[
    ...['queued','processing','suspended'].map(phase=>worker('active-'+phase,{latest_request:{id:'request-'+phase,phase}})),
    worker('active-generating',{observation:observed({generating:true})}),
    worker('active-draft',{observation:observed({draft:'Unsent browser text'})}),
    worker('active-approval',{observation:observed({approvalRequired:true})}),
    worker('active-model',{work_model_pending:true}),
    worker('active-enrolling',{bound:false,enrolling:true,enrollment_phase:'reserved'})
  ];
  initial.pages.push(...active,
    worker('idle-selected',{title:'Idle selected branch'}),
    worker('search-archived',{title:'Needle archived branch',latest_request:{id:'search-request',phase:'completed'}}),
    worker('paused-enrolling',{bound:false,enrolling:true,paused:true,enrollment_phase:'reserved'}));
  h.publish(initial);h.flush();
  const commandStart=h.commands.length;
  const visible=id=>!!h.element('pages').querySelector('[data-page-id="'+id+'"]');
  for(const p of active)assert.ok(visible(p.id),p.id+' is active and must remain visible');
  assert.equal(visible('idle-selected'),false);assert.equal(visible('search-archived'),false);
  assert.equal(visible('paused-enrolling'),false,'Paused enrollment alone does not make an idle worker active');
  const selected=copy(initial);selected.selected='idle-selected';
  for(const p of selected.pages)p.selected=p.id===selected.selected;
  selected.view={page_id:selected.selected,events:[],request:null,latest_request:null};
  h.publish(selected);h.flush();
  assert.ok(visible('idle-selected'),'The selected worker stays visible even when it is idle');
  assert.equal(h.element('pages').querySelector('[data-page-id="idle-selected"] .task-select').getAttribute('aria-current'),'page');
  h.element('search').value='needle';h.element('search').oninput();h.flush();
  assert.ok(visible('search-archived'),'Search can reveal a matching folded historical worker');
  assert.ok(visible('idle-selected'),'Search must retain the selected worker even when its title does not match');
  assert.equal(visible('paused-enrolling'),false);
  h.element('search').value='';h.element('search').oninput();h.flush();
  assert.equal(visible('search-archived'),false,'Clearing search restores the folded history');
  for(const p of active)assert.ok(visible(p.id));
  assert.ok(visible('idle-selected'));
  assert.deepEqual(h.currentState().pages,selected.pages);
  assert.deepEqual(h.commands.slice(commandStart).filter(command=>command.action!=='layout'),[],'Visibility and filtering do not dispatch work');
});

test('volatile worker heartbeats preserve status chip DOM while a real phase change updates status',()=>{
  const h=shell(),initial=snapshot();
  initial.pages.push(page('worker-live',{title:'Live branch',parent:'alpha',selected:false,
    latest_request:{id:'request-live',phase:'processing'}}),page('worker-done',{title:'Saved branch',parent:'alpha',selected:false,
    latest_request:{id:'request-done',phase:'completed'}}));
  h.publish(initial);h.flush();
  const commandStart=h.commands.length;
  const chips=()=>[...h.element('worker-status').querySelectorAll('.worker-chip')];
  assert.equal(chips().length,0,'Collapsed progress does not construct worker-detail DOM');
  h.element('workflow-toggle').onclick();h.flush();
  const original=chips();assert.equal(original.length,2);original[0].focus();
  const next=copy(initial);
  for(const p of next.pages){p.observation.at+=3000;p.observation.elapsedMs=90000;
    p.first_turn_instructions='Saved full instructions. '.repeat(2000);
    p.budget_status={available_sends:33,deadline:Date.now()/1000+3600};}
  next.view.run.dispatches=7;next.view.run.deadline+=1800;
  h.publish(next);h.flush();
  assert.equal(chips().length,original.length);
  for(let index=0;index<original.length;index++)assert.ok(chips()[index]===original[index],'Unchanged chip '+index+' retains its DOM node');
  assert.ok(h.document.activeElement===original[0],'The focused worker chip must retain focus across heartbeats');
  const completed=copy(next);completed.pages.find(p=>p.id==='worker-live').latest_request.phase='completed';
  h.publish(completed);h.flush();
  assert.match(chips()[0].textContent,/Live branch.*结果已保存/,'A true worker phase change must update its visible status');
  assert.deepEqual(h.commands.slice(commandStart).filter(command=>command.action!=='layout'),[]);
});

test('real request phase, pause and selection changes update visible navigation and controls',()=>{
  const h=shell(),initial=snapshot();h.publish(initial);h.flush();
  const text=()=>h.element('pages').querySelector('[data-page-id="alpha"] .task-status').textContent;
  assert.match(text(),/可以发送/);
  const queued=copy(initial);queued.pages[0].latest_request={id:'request-alpha',phase:'queued'};
  queued.view.request=queued.pages[0].latest_request;h.publish(queued);h.flush();assert.match(text(),/排队/);
  const paused=copy(queued);paused.pages[0].paused=true;h.publish(paused);h.flush();assert.match(text(),/暂停/);
  assert.equal(h.element('resume').hidden,true);assert.match(h.element('start').textContent,/保存补充/);
  assert.equal(h.element('start').disabled,true,'An empty supplement cannot resume automation');
  assert.equal(h.element('workflow-action').hidden,true,'A partial queue projection cannot authorize a retry');
  const completed=copy(initial);completed.pages[0].latest_request={id:'request-alpha',phase:'completed'};
  h.publish(completed);h.flush();assert.match(text(),/结果已保存/);
  const selected=copy(completed);selected.selected='beta';selected.pages[0].selected=false;selected.pages[1].selected=true;
  selected.view={page_id:'beta',events:[],request:null,latest_request:null};
  h.publish(selected);h.flush();
  assert.equal(h.element('thread-title').textContent,'Beta');
  assert.equal(h.element('pages').querySelector('[data-page-id="beta"] .task-select').getAttribute('aria-current'),'page');
  assert.equal(h.element('pages').querySelector('[data-page-id="alpha"] .task-select').getAttribute('aria-current'),'false');
});

test('a burst of onState events produces one paint using the latest state',()=>{
  const h=shell();h.publish(snapshot());h.flush();const before=h.paints.count;
  for(let index=0;index<30;index++){
    const next=snapshot();next.pages[0].title='Revision '+index;next.view.run.dispatches=index;
    h.publish(next);
  }
  assert.equal(h.paints.count,before,'Incoming state must not render synchronously');
  assert.equal(h.currentState().pages[0].title,'Revision 29','State remains immediately available to actions');
  h.frame();
  assert.equal(h.paints.count,before+1);
  assert.equal(h.element('thread-title').textContent,'Revision 29');
  assert.match(h.element('run-info').textContent,/29 \/ 40/);
  h.flush();assert.equal(h.paints.count,before+1);
});

test('hidden heartbeats do not paint, while one selection change binds drafts and visibility paints latest state',()=>{
  const h=shell();h.publish(snapshot());h.flush();const before=h.paints.count;
  h.element('objective').value='Alpha draft';h.element('objective').oninput();
  h.setHidden(true);
  for(let index=0;index<8;index++){
    const next=snapshot();next.pages[0].title='Hidden Alpha '+index;h.publish(next);
  }
  h.flush();assert.equal(h.paints.count,before,'Same-page hidden heartbeats must not paint');
  const beta=snapshot();beta.selected='beta';beta.pages[0].selected=false;beta.pages[1].selected=true;
  beta.pages[1].title='Hidden Beta';beta.pages[1].paused=true;
  beta.view={page_id:'beta',events:[],request:{id:'request-beta',phase:'queued'}};
  h.publish(beta);
  assert.equal(h.paints.count,before+1,'Selection immediately rebinds editable fields even while hidden');
  assert.equal(h.element('objective').value,'');
  assert.deepEqual(JSON.parse(h.storage.get('clw-composer-drafts')),[['alpha','Alpha draft']]);
  h.element('objective').value='Beta draft';h.element('objective').oninput();
  for(let index=0;index<8;index++){
    const next=copy(beta);
    next.pages[1].title='Hidden revision '+index;next.pages[1].paused=true;
    h.publish(next);
  }
  h.flush();assert.equal(h.paints.count,before+1,'New-page hidden heartbeats must not keep painting');
  assert.equal(h.currentState().selected,'beta');
  assert.equal(h.currentState().pages[1].title,'Hidden revision 7');
  h.setHidden(false);h.flush();
  assert.equal(h.paints.count,before+2);
  assert.equal(h.element('thread-title').textContent,'Hidden revision 7');
  assert.equal(h.element('objective').value,'Beta draft');
  assert.equal(h.element('resume').hidden,true);assert.match(h.element('start').textContent,/保存补充/);
  assert.equal(h.element('pages').querySelector('[data-page-id="beta"] .task-select').getAttribute('aria-current'),'page');
});

test('unchanged layout does not repeat IPC, while native, details, bounds and modal changes do',()=>{
  const h=shell();h.publish(snapshot());h.flush();const initial=h.layouts().length;
  for(let index=0;index<5;index++){const next=snapshot();next.view.run.dispatches=index;h.publish(next);h.flush();}
  assert.equal(h.layouts().length,initial);
  h.element('native').onclick();h.flush();assert.equal(h.layouts().length,initial+1);assert.equal(h.layouts().at(-1).payload.native,true);
  h.element('settings').onclick();h.flush();assert.equal(h.layouts().length,initial+2);assert.equal(h.layouts().at(-1).payload.details,true);
  h.setBounds({x:250,y:100,width:850,height:680});h.evaluate('scheduleLayout()');h.flush();
  assert.equal(h.layouts().length,initial+3);assert.deepEqual(h.layouts().at(-1).payload.bounds,{x:250,y:100,width:850,height:680});
  h.evaluate("$('task-dialog').showModal();scheduleLayout()");h.flush();
  assert.equal(h.layouts().length,initial+4);assert.equal(h.layouts().at(-1).payload.native,false);
  h.evaluate("$('task-dialog').close()");h.flush();
  assert.equal(h.layouts().length,initial+5);assert.equal(h.layouts().at(-1).payload.native,true);
  h.evaluate('scheduleLayout();scheduleLayout()');h.flush();assert.equal(h.layouts().length,initial+5);
});

test('heartbeats preserve a focused composer draft, selection, scroll and IME Enter behavior',()=>{
  const h=shell();h.publish(snapshot());h.flush();
  const input=h.element('objective'),conversation=h.element('conversation');
  input.value='草稿正在输入，尚未发送';input.oninput();input.focus();input.setSelectionRange(2,7,'backward');
  conversation.scrollTop=321;h.element('pages').scrollTop=127;
  const writes=h.valueWrites.get(input);
  input.dispatchEvent(new h.window.Event('compositionstart'));
  for(let index=0;index<12;index++){const next=snapshot();next.pages[0].observation.at+=index;next.view.run.dispatches=index;h.publish(next);}
  h.flush();
  assert.equal(input.value,'草稿正在输入，尚未发送');assert.ok(h.document.activeElement===input,'Composer retains focus');
  assert.deepEqual([input.selectionStart,input.selectionEnd,input.selectionDirection],[2,7,'backward']);
  assert.equal(h.valueWrites.get(input),writes,'A heartbeat must not rewrite the active input value');
  assert.equal(conversation.scrollTop,321);assert.equal(h.element('pages').scrollTop,127);
  assert.deepEqual(JSON.parse(h.storage.get('clw-composer-drafts')),[['alpha','草稿正在输入，尚未发送']]);
  let prevented=false;input.onkeydown({key:'Enter',shiftKey:false,isComposing:true,preventDefault(){prevented=true;}});
  assert.equal(prevented,false);assert.equal(h.submissions.length,0);
  input.onkeydown({key:'Enter',shiftKey:false,isComposing:false,preventDefault(){prevented=true;}});
  assert.equal(prevented,false);assert.equal(h.submissions.length,0,'composition lifecycle must also guard ambiguous Enter');
  input.dispatchEvent(new h.window.Event('compositionend'));
  input.onkeydown({key:'Enter',keyCode:229,shiftKey:false,isComposing:false,preventDefault(){prevented=true;}});
  assert.equal(prevented,false);assert.equal(h.submissions.length,0);
  input.onkeydown({key:'Enter',shiftKey:false,isComposing:false,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.deepEqual(h.submissions,['composer']);
});

test('selection changes immediately bind drafts even when an earlier same-page paint is pending',()=>{
  const h=shell();h.publish(snapshot());h.flush();
  h.element('objective').value='Keep Alpha draft';h.element('objective').oninput();
  const heartbeat=snapshot();heartbeat.pages[0].title='Pending Alpha title';h.publish(heartbeat);
  const beta=snapshot();beta.selected='beta';beta.pages[0].selected=false;beta.pages[1].selected=true;
  beta.pendingObjective='Beta initial objective';beta.view={page_id:'beta',events:[]};h.publish(beta);
  assert.equal(h.element('thread-title').textContent,'Beta');
  assert.equal(h.element('objective').value,'Beta initial objective');
  h.element('objective').value='Keep Beta draft';h.element('objective').oninput();
  h.publish(snapshot());assert.equal(h.element('objective').value,'Keep Alpha draft');h.flush();
  assert.deepEqual(JSON.parse(h.storage.get('clw-composer-drafts')),[['alpha','Keep Alpha draft'],['beta','Keep Beta draft']]);
});

test('an unbound first-task draft keeps focus and selection through the same-page heartbeat',()=>{
  const h=shell(),initial=snapshot();initial.pages[0].bound=false;initial.pages[0].enrollment_phase='reserved';
  initial.pages[0].firstTurnDraft='Initial saved objective';h.publish(initial);h.flush();
  const input=h.element('first-task-objective');input.value='尚未发送的首次任务草稿';input.oninput();input.focus();input.setSelectionRange(1,5);
  const writes=h.valueWrites.get(input),next=copy(initial);next.pages[0].observation.at+=3000;next.pages[0].duration_seconds=25000;
  h.publish(next);h.flush();
  assert.equal(input.value,'尚未发送的首次任务草稿');assert.ok(h.document.activeElement===input);
  assert.deepEqual([input.selectionStart,input.selectionEnd],[1,5]);assert.equal(h.valueWrites.get(input),writes);
  assert.deepEqual(JSON.parse(h.storage.get('clw-first-turn-drafts')),[['alpha','尚未发送的首次任务草稿']]);
});

test('a hidden transient notice cleared by the latest state is never restored',()=>{
  const h=shell();h.publish(snapshot({notice:'Previously displayed notice'}));h.flush();
  assert.equal(h.element('notice-text').textContent,'Previously displayed notice');
  h.setHidden(true);h.publish(snapshot({notice:'Transient hidden warning'}));h.publish(snapshot({notice:''}));
  h.setHidden(false);h.flush();
  assert.equal(h.element('notice').hidden,true);assert.equal(h.element('notice-text').textContent,'');
});

test('the exact old communication warning clears only after both connection and task state recover',()=>{
  const h=shell(),notice='本机通信中断；原请求保留，请核对原执行。';
  h.publish(snapshot({notice,connected:false,taskStateReady:false}));h.flush();
  assert.equal(h.element('notice-text').textContent,notice);assert.equal(h.element('notice').hidden,false);
  const commandStart=h.commands.length;
  for(const readiness of [{connected:true,taskStateReady:false},{connected:false,taskStateReady:true},
    {connected:true,taskStateReady:undefined}]){
    h.publish(snapshot({notice,...readiness}));h.flush();
    assert.equal(h.element('notice-text').textContent,notice,'Both recovery flags must be explicitly true');
  }
  const restored=snapshot({notice,connected:true,taskStateReady:true});h.publish(restored);h.flush();
  assert.equal(h.element('notice').hidden,true);assert.equal(h.element('notice-text').textContent,'');
  assert.equal(h.currentState().notice,'','The shell projects the stale bridge notice out of its restored state');
  assert.deepEqual(h.currentState().pages,restored.pages,'Notice recovery preserves all task state');
  h.publish(restored);h.flush();assert.equal(h.element('notice').hidden,true,'Repeated old bridge strings must not restore the warning');
  h.setHidden(true);h.publish(snapshot({notice,connected:false,taskStateReady:false}));h.publish(restored);
  h.setHidden(false);h.flush();assert.equal(h.element('notice').hidden,true,'Coalesced hidden recovery must not flash the stale warning');
  assert.deepEqual(h.commands.slice(commandStart).filter(command=>command.action!=='layout'),[],'Recovery display must not resume or dispatch work');
});

test('restored snapshots preserve unknown request results, page failures and nonmatching communication notices',()=>{
  const stale='本机通信中断；原请求保留，请核对原执行。';
  for(const notice of ['本机回执尚未确认，正在核对原操作，请勿重复提交。',
    '原请求 request-alpha 的执行结果未知，请核对原执行。','网页生成失败：原回复需要核对。',stale+' 请求 request-alpha 待核对。']){
    const h=shell();h.publish(snapshot({notice:stale,connected:false,taskStateReady:false}));h.flush();
    const commandStart=h.commands.length;
    h.publish(snapshot({notice,connected:true,taskStateReady:true}));h.flush();
    assert.equal(h.element('notice-text').textContent,notice);assert.equal(h.element('notice').hidden,false);
    h.publish(snapshot({notice:stale,connected:true,taskStateReady:true}));h.flush();
    assert.equal(h.element('notice-text').textContent,notice,'A stale connection string cannot erase a distinct request or page warning');
    assert.equal(h.element('notice').hidden,false);
    assert.deepEqual(h.commands.slice(commandStart).filter(command=>command.action!=='layout'),[]);
  }
});

test('an old recovered communication notice cannot erase a newer local error before or after its snapshot',async()=>{
  const notice='本机通信中断；原请求保留，请核对原执行。';
  for(const errorFirst of [true,false]){
    const h=shell();h.publish(snapshot({notice,connected:false,taskStateReady:false}));h.flush();
    h.setCommand(action=>{if(action==='fixture-local-error')throw Error('New local request error');return {};});
    if(errorFirst)await h.evaluate("act('fixture-local-error')");
    const restored=snapshot({notice,connected:true,taskStateReady:true});h.publish(restored);
    if(!errorFirst)await h.evaluate("act('fixture-local-error')");
    h.flush();
    assert.equal(h.element('notice-text').textContent,'New local request error');assert.equal(h.element('notice').hidden,false);
    h.publish(restored);h.flush();
    assert.equal(h.element('notice-text').textContent,'New local request error','Repeated recovered snapshots must keep the local error');
  }
});

test('a pending notice belongs to its selected page and does not label another page',()=>{
  const h=shell();h.publish(snapshot());h.flush();h.setHidden(true);
  h.publish(snapshot({notice:'Alpha-only warning'}));
  const beta=snapshot({notice:''});beta.selected='beta';beta.pages[0].selected=false;beta.pages[1].selected=true;
  beta.view={page_id:'beta',events:[]};h.publish(beta);
  assert.equal(h.element('notice').hidden,true);
  const latest=copy(beta);latest.notice='Beta latest warning';h.publish(latest);h.setHidden(false);h.flush();
  assert.equal(h.element('notice-text').textContent,'Beta latest warning');
  assert.equal(h.element('notice').hidden,false);assert.equal(h.element('thread-title').textContent,'Beta');
});

test('task and queued notices retire on workflow changes while shared service faults survive',()=>{
  const h=shell();h.publish(snapshot());h.flush();
  h.evaluate("showNotice('Task operation accepted')");h.evaluate("setWorkflowMode('local')");
  assert.equal(h.element('notice').hidden,true);
  h.evaluate("setWorkflowMode('web')");h.publish(snapshot({notice:'Queued Web task warning'}));
  h.evaluate("setWorkflowMode('local')");h.flush();assert.equal(h.element('notice').hidden,true);
  h.evaluate("showNotice('本机服务尚未连接，请稍候。')");h.evaluate("setWorkflowMode('web')");
  const beta=snapshot();beta.selected='beta';beta.view={page_id:'beta',events:[]};h.publish(beta);h.flush();
  assert.equal(h.element('notice-text').textContent,'本机服务尚未连接，请稍候。');
  assert.equal(h.element('notice').hidden,false);
});

test('late action errors cannot acquire the workflow that was selected while waiting',async()=>{
  const h=shell();h.publish(snapshot());h.flush();let reject;
  h.setCommand(action=>action==='fixture-late-action'?new Promise((_,fail)=>{reject=fail;}):{});
  const pending=h.evaluate("act('fixture-late-action')");h.evaluate("setWorkflowMode('local')");
  reject(Error('Original Web task error'));await pending;h.flush();assert.equal(h.element('notice').hidden,true);
  h.setCommand(action=>{if(action==='fixture-global-error')throw Error('runtime_not_connected');return {};});
  await h.evaluate("act('fixture-global-error')");h.evaluate("setWorkflowMode('web')");
  assert.equal(h.element('notice-text').textContent,'本机服务尚未连接，请稍候。');
});

test('real clicked action shows waiting before the original command settles and clears it on refusal',async()=>{
  const h=shell();h.publish(snapshot());h.flush();let reject;
  h.element('native').onclick();h.flush();
  h.setCommand(action=>action==='refresh'?new Promise((_,fail)=>{reject=fail;}):{});
  const button=h.element('refresh-page');
  button.dispatchEvent(new h.window.Event('click',{bubbles:true}));
  assert.equal(button.getAttribute('aria-busy'),'true');
  assert.equal(button.classList.contains('interaction-pending'),true);
  assert.equal(h.element('interaction-status').hidden,false);
  assert.match(h.element('interaction-status-text').textContent,/正在刷新/);
  reject(Error('Original refresh refused'));await new Promise(setImmediate);h.flush();
  assert.equal(button.getAttribute('aria-busy'),null);
  assert.equal(h.element('interaction-status').hidden,true);
  assert.equal(h.element('notice-text').textContent,'Original refresh refused');
  assert.equal(h.commands.filter(command=>command.action==='refresh').length,1);
});

test('one accessible refresh control sits beside the view switch and is shown only for the selected webpage',()=>{
  const h=shell();h.publish(snapshot());h.flush();const button=h.element('refresh-page');
  assert.equal(h.document.querySelectorAll('#refresh-page').length,1);
  assert.equal(button.closest('.topbar').className,'topbar');
  assert.equal(button.parentElement,h.element('view-switch').parentElement);
  assert.equal(button.closest('#task-menu'),null);
  assert.equal(button.getAttribute('aria-label'),'刷新当前网页');assert.equal(button.hidden,true);
  const before=h.commands.length;button.onclick();assert.equal(h.commands.length,before,'A hidden records control cannot dispatch refresh');
  h.element('native').onclick();h.flush();assert.equal(button.hidden,false);assert.equal(button.disabled,false);
  h.element('records').onclick();h.flush();assert.equal(button.hidden,true);
  h.evaluate("setWorkflowMode('local')");assert.equal(button.hidden,true);assert.equal(h.element('web-view-controls').hidden,true);
  const codex=snapshot({codexConversation:{traceId:'aaaaaaaaaaaa',account:'A',available:true,running:false},
    codexWeb:{recent:[{traceId:'aaaaaaaaaaaa',status:'completed',account:'A',
      source:{threadId:'task-a',turnId:'original-a',workingDirectory:'D:/Fixture/A'},review:{finalText:'Saved original A'}}]}});
  h.publish(codex);h.flush();h.evaluate("setWorkflowMode('codex');selectCodexTask('task-a');nativeView(true)");h.flush();
  assert.equal(button.hidden,false);assert.equal(button.disabled,false);
  h.element('records').onclick();h.flush();assert.equal(button.hidden,true);
  h.evaluate('nativeView(true)');codex.codexConversation.running=true;h.publish(codex);h.flush();assert.equal(button.disabled,true);
  codex.codexConversation.running=false;codex.codexConversation.available=false;h.publish(codex);h.flush();assert.equal(button.disabled,true);
  assert.equal(h.commands.some(row=>['refresh','codex-refresh-web','start','resume','stop-generation'].includes(row.action)),false);
});

function homepageRecoverySnapshot(phase='processing'){
  const initial=snapshot(),request={id:'original-request',phase};
  Object.assign(initial.pages[0],{url:'https://chatgpt.com/',conversationUrl:'https://chatgpt.com/c/6ac3276e-af90-83ea-a96c-9d00bf3a83b4',
    paused:true,manualControl:true,manualUrl:'https://chatgpt.com/',latest_request:request,observation:{at:Date.now(),generating:false,draft:false,composing:false,approvalRequired:false,emptyHomepage:true}});
  initial.view.request=request;return initial;
}
for(const phase of ['processing','suspended'])test('manually selected idle homepage exposes current-page refresh while preserving the original '+phase+' conversation',async()=>{
  const h=shell(),initial=homepageRecoverySnapshot(phase);h.publish(initial);h.flush();h.element('native').onclick();h.flush();
  const button=h.element('refresh-page');assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-label'),'刷新当前网页');
  assert.equal(h.element('web-navigation-hint').hidden,false);assert.match(h.element('web-navigation-hint').textContent,/不会自动切回/);
  h.setCommand(action=>action==='refresh'?{message:'已请求刷新当前网页'}:{});await button.onclick();h.flush();
  assert.deepEqual(h.commands.filter(row=>row.action==='refresh'),[{action:'refresh',payload:{id:'alpha'}}]);
  assert.deepEqual(h.currentState().view.request,initial.view.request);assert.equal(h.currentState().pages[0].paused,true);
  assert.equal(h.commands.some(row=>['start','resume','stop-generation','send','enroll'].includes(row.action)),false);
  const restored=copy(initial);restored.pages[0].url=restored.pages[0].conversationUrl+'?model=gpt-6#original';restored.pages[0].observation.emptyHomepage=false;
  h.publish(restored);h.flush();assert.equal(h.element('web-navigation-hint').hidden,true);
  assert.equal(button.getAttribute('aria-label'),'刷新当前网页');assert.equal(button.disabled,true,'An ongoing original cannot be reloaded');
});

for(const [label,change] of [
  ['nonmanual processing original',s=>s.pages[0].manualControl=false],
  ['nonmanual suspended original',s=>{s.pages[0].manualControl=false;s.pages[0].latest_request.phase='suspended';}],
  ['stale empty proof while loading',s=>{s.pages[0].loading=true;s.pages[0].observation.at=Date.now()-30001;}],
  ['undated empty proof while loading',s=>{s.pages[0].loading=true;delete s.pages[0].observation.at;}],
  ['future empty proof while loading',s=>{s.pages[0].loading=true;s.pages[0].observation.at=Date.now()+10000;}],
  ['generation',s=>s.pages[0].observation.generating=true],
  ['unsent draft',s=>s.pages[0].observation.draft='Original unsent draft'],
  ['composition',s=>s.pages[0].observation.composing=true],
  ['approval',s=>s.pages[0].observation.approvalRequired=true],
  ['unavailable original record',s=>s.view.state_read={unavailable:true}],
  ['pending original record',s=>s.view=null],
  ['missing durable identity',s=>delete s.pages[0].conversationUrl],
  ['foreign durable URL',s=>s.pages[0].conversationUrl='https://other.invalid/c/original'],
  ['nonmanual different conversation',s=>{s.pages[0].manualControl=false;s.pages[0].url='https://chatgpt.com/c/another-original';}]
])test('current-page refresh stays disabled for '+label,()=>{
  const h=shell(),initial=homepageRecoverySnapshot();change(initial);h.publish(initial);h.flush();h.element('native').onclick();h.flush();
  assert.equal(h.element('refresh-page').disabled,true);h.element('refresh-page').onclick();
  assert.equal(h.commands.some(row=>['refresh','start','resume','stop-generation'].includes(row.action)),false);
});

test('manually selected verified homepage refreshes during stalled resources while preserving its original processing request',async()=>{
  const h=shell(),initial=homepageRecoverySnapshot();initial.pages[0].loading=true;initial.pages[0].status='loading';
  initial.pages[0].observation.at=Date.now()-29000;
  h.publish(initial);h.flush();h.element('native').onclick();h.flush();const button=h.element('refresh-page');
  assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-busy'),null);
  assert.equal(button.getAttribute('aria-label'),'刷新当前网页');assert.match(h.element('web-navigation-hint').textContent,/不会自动切回/);
  h.setCommand(action=>action==='refresh'?{message:'已请求刷新当前网页'}:{});await button.onclick();h.flush();
  assert.equal(h.commands.filter(row=>row.action==='refresh').length,1);
  assert.deepEqual(h.currentState().view.request,initial.view.request);assert.equal(h.currentState().pages[0].paused,true);
  assert.equal(h.commands.some(row=>['start','resume','stop-generation','send'].includes(row.action)),false);
});

test('refresh and page navigation have visible busy feedback, settle once, and preserve drafts and records',async()=>{
  const h=shell(),initial=homepageRecoverySnapshot();h.publish(initial);h.flush();h.element('native').onclick();h.flush();
  h.element('objective').value='Original local supplement';let finish;
  h.setCommand(action=>action==='refresh'?new Promise(resolve=>{finish=resolve;}):{});
  const button=h.element('refresh-page'),pending=button.onclick();
  assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-busy'),'true');assert.match(button.title,/正在加载当前网页/);
  assert.match(h.element('web-navigation-hint').textContent,/不会自动切回/);button.onclick();
  assert.equal(h.commands.filter(row=>row.action==='refresh').length,1);
  finish({message:'已请求刷新当前网页'});await pending;h.flush();assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-busy'),null);
  const loading=copy(initial);loading.pages[0].status='loading';loading.pages[0].observation.at=Date.now()-30001;h.publish(loading);h.flush();
  assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-busy'),'true');
  loading.pages[0].status='idle';loading.pages[0].observation.at=Date.now();h.publish(loading);h.flush();assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-busy'),null);
  assert.equal(h.element('objective').value,'Original local supplement');assert.deepEqual(h.currentState().view,initial.view);
  h.element('records').onclick();h.flush();assert.equal(button.hidden,true);assert.equal(h.element('web-navigation-hint').hidden,true);
});

test('a task-owned waiting status retires on a selection change while its original operation continues',async()=>{
  const h=shell();h.publish(snapshot());h.flush();let resolve;
  h.setCommand(action=>action==='record-body'?new Promise(yes=>{resolve=yes;}):{});
  const pending=h.evaluate("interactiveCommand('record-body',{id:'alpha',seq:1})");
  assert.equal(h.element('interaction-status').hidden,false);
  const beta=snapshot();beta.selected='beta';beta.pages[0].selected=false;beta.pages[1].selected=true;beta.view={page_id:'beta',events:[]};
  h.publish(beta);h.flush();assert.equal(h.element('interaction-status').hidden,true);
  resolve({});await pending;assert.equal(h.commands.filter(command=>command.action==='record-body').length,1);
});

test('an unfinished Web selection does not label a subsequently selected native workflow',async()=>{
  const h=shell();h.publish(snapshot());h.flush();let resolve;
  h.setCommand(action=>action==='select'?new Promise(yes=>{resolve=yes;}):{});
  const pending=h.evaluate("selectTask('beta')");assert.equal(h.element('interaction-status').hidden,false);
  h.evaluate("setWorkflowMode('local')");assert.equal(h.element('interaction-status').hidden,true);
  resolve({selected:'beta'});await pending;assert.equal(h.evaluate('workflowMode'),'local');
});

for(const change of ['task','workflow','records','aba'])test('late original Codex webpage opening cannot change a newer '+change,async()=>{
  const h=shell(),initial=snapshot();initial.codexWeb={ready:true,recent:[{traceId:'aaaaaaaaaaaa',status:'completed',account:'A',
    source:{traceId:'aaaaaaaaaaaa',threadId:'task-a',turnId:'original-a',workingDirectory:'D:/Fixture/A'},review:{finalText:'Saved original A'}}]};
  h.publish(initial);h.flush();h.evaluate("setWorkflowMode('codex');selectCodexTask('task-a')");let resolve;
  h.setCommand(action=>action==='codex-view-turn'?new Promise(yes=>{resolve=yes;}):{});
  const pending=h.evaluate("openCodexWeb('aaaaaaaaaaaa')");
  if(change==='task')h.evaluate("selectCodexTask('task-b')");
  else if(change==='workflow')h.evaluate("setWorkflowMode('web')");
  else if(change==='records')h.element('records').onclick();
  else h.evaluate("selectCodexTask('task-b');selectCodexTask('task-a')");
  resolve({traceId:'aaaaaaaaaaaa',account:'A'});await pending;h.flush();
  assert.equal(h.evaluate('native'),false);assert.equal(h.evaluate('codexSelected'),change==='task'?'task-b':'task-a');
  assert.equal(h.evaluate('workflowMode'),change==='workflow'?'web':'codex');
  assert.equal(h.commands.filter(command=>command.action==='codex-view-turn').length,1);
});

test('selected-record waiting and a failed original read have separate feedback and cannot send or change a model',()=>{
  const h=shell(),pending=snapshot({view:null,selectedRecords:{page_id:'alpha',state:'loading'}});h.publish(pending);h.flush();
  assert.equal(h.element('record-loading').hidden,false);assert.equal(h.element('record-loading').getAttribute('aria-busy'),'true');
  assert.equal(h.element('record-loading-spinner').hidden,false);
  h.element('objective').value='Original Alpha draft';h.element('objective').oninput();
  assert.equal(h.element('start').disabled,true);
  assert.ok([...h.document.querySelectorAll('[data-work-effort]')].every(choice=>choice.disabled));
  const failed=copy(pending);failed.selectedRecords.state='unavailable';h.publish(failed);h.flush();
  assert.equal(h.element('record-loading-spinner').hidden,true);assert.equal(h.element('record-loading').getAttribute('aria-busy'),'false');
  assert.match(h.element('record-loading-text').textContent,/暂不可用/);assert.equal(h.element('objective').value,'Original Alpha draft');
  const idle=copy(failed);idle.selectedRecords.state='idle';h.publish(idle);h.flush();
  assert.equal(h.element('record-loading-spinner').hidden,true);assert.equal(h.element('record-loading').getAttribute('aria-busy'),'false');
  h.publish(snapshot());h.flush();assert.equal(h.element('record-loading').hidden,true);
  assert.equal(h.commands.filter(command=>['start','set-model','resume'].includes(command.action)).length,0);
});

test('programmatic scroll does not stop automatic new records; deliberate scrolling preserves reading position',()=>{
  const h=shell(),initial=snapshot({recordHistory:{web:true}});
  const event=seq=>({seq,kind:'host_user_note',data:{text:'Original saved note '+seq},body_loaded:true});
  initial.view.events=[event(1)];initial.view.thread_id='original-alpha';h.publish(initial);h.flush();
  const scroller=h.element('conversation');
  Object.defineProperties(scroller,{scrollHeight:{value:1600,writable:true,configurable:true},clientHeight:{value:600,writable:true,configurable:true}});
  scroller.scrollTop=100;scroller.dispatchEvent(new h.window.Event('scroll'));
  assert.equal(h.evaluate('recordHistory.active.following'),true);
  const second=copy(initial);second.view.events.push(event(2));h.publish(second);h.flush();
  assert.equal(h.evaluate('recordHistory.active.rows.at(-1).seq'),2);
  assert.equal(scroller.scrollTop,1600);assert.equal(h.element('record-latest').hidden,true);
  scroller.dispatchEvent(new h.window.Event('wheel'));scroller.scrollTop=200;scroller.dispatchEvent(new h.window.Event('scroll'));
  assert.equal(h.evaluate('recordHistory.active.following'),false);assert.equal(h.evaluate('recordHistory.active.live'),true);
  const third=copy(second);third.view.events.push(event(3));h.publish(third);h.flush();
  assert.equal(h.evaluate('recordHistory.active.rows.at(-1).seq'),3);assert.equal(scroller.scrollTop,200);
  assert.equal(h.element('record-latest').hidden,false);assert.match(h.element('record-latest').textContent,/查看新记录/);
  const count=h.commands.length;h.element('record-latest').onclick();h.flush();
  assert.equal(scroller.scrollTop,1600);assert.equal(h.element('record-latest').hidden,true);
  assert.equal(h.commands.slice(count).filter(command=>command.action==='record-history').length,0);
});

test('late selection acknowledgements cannot reopen a view or settings after the newer selected task',async()=>{
  const h=shell();h.publish(snapshot());h.flush();const pending=[];
  h.setCommand((action,payload)=>action==='select'?new Promise(resolve=>pending.push({id:payload.id,resolve})):{});
  const old=h.evaluate("selectTask('alpha')"),newer=h.evaluate("selectTask('beta')");
  const beta=snapshot();beta.selected='beta';beta.pages[0].selected=false;beta.pages[1].selected=true;beta.view={page_id:'beta',events:[]};
  h.publish(beta);h.flush();h.element('objective').value='Beta draft stays';
  pending[1].resolve({selected:'beta'});await newer;
  h.evaluate('native=true');pending[0].resolve({selected:'alpha'});await old;h.flush();
  assert.equal(h.evaluate('native'),true);assert.equal(h.element('thread-title').textContent,'Beta');
  assert.equal(h.element('objective').value,'Beta draft stays');
  assert.equal(h.commands.filter(command=>command.action==='select').length,2);
});

test('an error from an explicitly targeted task does not label the current other task',async()=>{
  const h=shell();h.publish(snapshot());h.flush();
  h.setCommand(action=>{if(action==='start-first-turn')throw Error('Beta enrollment error');return {};});
  await h.evaluate("act('start-first-turn',{id:'beta'})");
  assert.equal(h.element('thread-title').textContent,'Alpha');assert.equal(h.element('notice').hidden,true);
  assert.equal(h.commands.filter(command=>command.action==='start-first-turn').length,1,'Ownership checks must not retry the original operation');
});

test('a queued old or empty incoming notice cannot overwrite a newer local error at the next frame',async()=>{
  for(const incomingNotice of ['Older incoming warning','']){
    const h=shell();h.publish(snapshot({notice:'Previously received warning'}));h.flush();
    h.publish(snapshot({notice:incomingNotice}));
    h.setCommand(action=>{if(action==='fixture-local-error')throw Error('New local error');return {};});
    await h.evaluate("act('fixture-local-error')");
    assert.equal(h.element('notice-text').textContent,'New local error');
    h.flush();
    assert.equal(h.element('notice-text').textContent,'New local error');
    assert.equal(h.element('notice').hidden,false);
  }
});

test('retiring a temporary queued-task banner preserves the fresh incoming error for that task',()=>{
  const h=shell(),initial=snapshot();initial.pages[0].bound=false;initial.pages[0].enrollment_phase='reserved';
  h.publish(initial);h.flush();
  h.evaluate("showNotice('本地队列已保存，正在核对网页；是否送达以任务状态为准。')");
  const next=copy(initial);next.pages[0].bound=true;next.pages[0].enrollment_phase='bound';next.notice='Fresh task failure needs attention';
  h.publish(next);h.flush();
  assert.equal(h.element('notice-text').textContent,'Fresh task failure needs attention');
  assert.equal(h.element('notice').hidden,false);
});

test('dismissing a notice cancels its already queued incoming replacement',()=>{
  const h=shell();h.publish(snapshot({notice:'Displayed notice'}));h.flush();
  h.publish(snapshot({notice:'Incoming notice before dismissal'}));h.element('dismiss-notice').onclick();h.flush();
  assert.equal(h.element('notice').hidden,true);assert.equal(h.element('notice-text').textContent,'');
  assert.equal(h.commands.filter(command=>command.action==='dismiss-notice').length,1);
});

test('pure Web leaves Codex DOM untouched and switching to Codex renders its latest saved turn',()=>{
  const h=shell();
  const nativeRow=(trace,text)=>({traceId:trace,status:'completed',account:'B',submission:'confirmed',
    startedAt:'2026-10-01T00:00:00Z',url:'https://chatgpt.invalid/c/native',review:{finalText:text},
    source:{threadId:'native-thread',traceId:trace,workingDirectory:'D:/fixture/native',model:'chatgpt-web/pro'}});
  const initial=snapshot();initial.codexWeb={ready:true,recent:[nativeRow('old-trace','Old saved reply')]};
  h.publish(initial);h.flush();
  assert.equal(h.element('codex-pages').childNodes.length,0,'Hidden Codex navigation does not render in Web mode');
  h.element('mode-codex').onclick();h.flush();h.evaluate("selectCodexTask('native-thread')");h.flush();
  assert.match(h.element('codex-turns').textContent,/Old saved reply/);
  h.element('mode-web').onclick();h.flush();
  const oldNav=h.element('codex-pages').firstChild,oldTurn=h.element('codex-turns').firstChild;
  const next=copy(initial);next.codexWeb.recent=[nativeRow('new-trace','Latest saved reply')];h.publish(next);h.flush();
  assert.ok(h.element('codex-pages').firstChild===oldNav);assert.ok(h.element('codex-turns').firstChild===oldTurn);
  assert.doesNotMatch(h.element('codex-turns').textContent,/Latest saved reply/,'Hidden navigation must not paint incoming native records');
  h.element('mode-codex').onclick();h.flush();
  assert.match(h.element('codex-turns').textContent,/Latest saved reply/);
  assert.doesNotMatch(h.element('codex-turns').textContent,/Old saved reply/);
});

for(const change of ['workflow','workflow-aba','native-view','task'])test('a cached native full-text copy cannot dispatch after leaving its '+change+' owner',async()=>{
  const h=shell(),traceId='aaaaaaaaaaaa',full='Original exact full reply\n'+'x'.repeat(2500);
  const row={traceId,status:'completed',account:'A',submission:'confirmed',bodyRevision:'original-revision',
    startedAt:'2026-10-05T00:00:00Z',source:{traceId,threadId:'native-a',turnId:'original-turn',
      workingDirectory:'D:/fixture/native',account:'A',model:'chatgpt-web/pro'},nativeState:{state:'completed'},review:{finalText:full}};
  h.setCommand(action=>action==='record-body'?{row}:{});
  const initial=snapshot({recordHistory:{web:true,codex:true}});initial.codexWeb={state:'ready',recent:[row]};
  h.publish(initial);h.flush();h.evaluate("setWorkflowMode('codex');selectCodexTask('native-a')");h.flush();
  await new Promise(setImmediate);h.flush();await new Promise(setImmediate);
  const control=h.element('codex-turns').querySelector('.record-body');assert.ok(control);
  await control.expand();assert.equal(control.querySelector('.text').textContent,full);
  const copy=Array.from(control.querySelectorAll('button')).find(button=>button.textContent==='复制全文');
  const copying=copy.onclick();
  if(change==='workflow')h.evaluate("setWorkflowMode('web')");
  else if(change==='workflow-aba')h.evaluate("setWorkflowMode('web');setWorkflowMode('codex')");
  else if(change==='native-view')h.evaluate('nativeView(true)');
  else h.evaluate("selectCodexTask('native-b')");
  h.flush();await copying;h.flush();
  assert.equal(h.commands.filter(command=>command.action==='copy-record-text').length,0);
  assert.equal(control.querySelector('.text').textContent,'','Leaving its owner disposes the retained full text');
  assert.equal(h.commands.filter(command=>['start','send','resume','stop-generation','codex-resume-turn'].includes(command.action)).length,0);
});

test('native new replies follow the bottom until deliberate reading, then keep position and return without loading or sending',()=>{
  const h=shell(),initial=snapshot({recordHistory:{codex:true}});
  const row=(trace,text)=>({traceId:trace,status:'completed',submission:'confirmed',account:'A',bodyRevision:trace,
    source:{traceId:trace,threadId:'native-thread',turnId:'turn-'+trace,workingDirectory:'D:/fixture/native',account:'A'},
    nativeState:{state:'completed'},review:{finalText:text}});
  initial.codexWeb={state:'ready',recent:[row('aaaaaaaaaaaa','First saved reply')]};
  h.publish(initial);h.flush();h.evaluate("setWorkflowMode('codex');selectCodexTask('native-thread')");h.flush();
  const scroller=h.element('codex-workspace');Object.defineProperties(scroller,{
    scrollHeight:{value:1600,writable:true,configurable:true},clientHeight:{value:600,writable:true,configurable:true}});
  scroller.scrollTop=100;scroller.dispatchEvent(new h.window.Event('scroll'));
  const second=copy(initial);second.codexWeb.recent.unshift(row('bbbbbbbbbbbb','New saved reply'));h.publish(second);h.flush();
  assert.equal(h.evaluate('recordHistory.active.following'),true);assert.equal(scroller.scrollTop,1600);
  assert.match(h.element('codex-turns').textContent,/First saved reply/);assert.match(h.element('codex-turns').textContent,/New saved reply/);
  scroller.dispatchEvent(new h.window.Event('wheel'));scroller.scrollTop=200;scroller.dispatchEvent(new h.window.Event('scroll'));
  const third=copy(second);third.codexWeb.recent.unshift(row('cccccccccccc','Newest saved reply'));h.publish(third);h.flush();
  assert.equal(h.evaluate('recordHistory.active.following'),false);assert.equal(scroller.scrollTop,200);
  assert.match(h.element('codex-turns').textContent,/Newest saved reply/);assert.equal(h.element('record-latest').hidden,false);
  assert.match(h.element('record-latest').textContent,/查看新记录/);
  const before=h.commands.length;h.element('record-latest').onclick();h.flush();
  assert.equal(scroller.scrollTop,1600);assert.equal(h.element('record-latest').hidden,true);
  assert.equal(h.commands.slice(before).filter(command=>['record-body','record-history','send','start','codex-resume-turn'].includes(command.action)).length,0);
});

test('subpixel bounds do not repeat layout IPC but a different selected page does',()=>{
  const h=shell();h.publish(snapshot());h.flush();h.element('native').onclick();h.flush();
  const before=h.layouts().length;h.setBounds({x:228.2,y:78.1,width:900.3,height:700.2});h.evaluate('scheduleLayout()');h.flush();
  assert.equal(h.layouts().length,before);
  const next=snapshot();next.selected='beta';next.pages[0].selected=false;next.pages[1].selected=true;next.view={page_id:'beta',events:[]};
  h.publish(next);h.flush();assert.equal(h.layouts().length,before+1);
});

test('an asynchronous layout failure can retry the same geometry and then deduplicate success',async()=>{
  const h=shell();let attempts=0;
  h.setCommand(action=>{if(action==='layout'&&++attempts===1)throw Error('Transient layout failure');return {};});
  h.publish(snapshot());h.flush();assert.equal(h.layouts().length,1);
  await new Promise(setImmediate);h.flush();await new Promise(setImmediate);
  assert.equal(h.layouts().length,2);assert.equal(attempts,2);
  h.evaluate('scheduleLayout()');h.flush();assert.equal(h.layouts().length,2);
});

test('an older failed layout cannot erase the successful layout key for a newer native mode',async()=>{
  const h=shell();let rejectOriginal,first=true;
  h.setCommand(action=>{
    if(action==='layout'&&first){first=false;return new Promise((resolve,reject)=>{rejectOriginal=reject;});}
    return {};
  });
  h.publish(snapshot());h.flush();assert.equal(h.layouts().length,1);
  h.element('native').onclick();h.flush();assert.equal(h.layouts().length,2);assert.equal(h.layouts().at(-1).payload.native,true);
  await new Promise(setImmediate);rejectOriginal(Error('Older layout failed'));await new Promise(setImmediate);h.flush();
  h.evaluate('scheduleLayout()');h.flush();assert.equal(h.layouts().length,2,'The late failure must retain the newer successful key');
});


const pendingSnapshot=()=>{
  const initial=snapshot({connectionGeneration:1});initial.view.thread_id='original-alpha';
  initial.view.events=[
    {seq:1,kind:'host_user_note',delivery:'queued_note',data:{text:'Original unread note'},withdraw:{request_id:'accepted-original',note_id:'note-1'}},
    {seq:2,kind:'host_user_note',delivery:'host_queued',data:{text:'Old label alone'}},
    {seq:3,kind:'host_user_note',delivery:'queued_note',data:{text:'Already reserved, no capability'}},
    {seq:4,kind:'user_message',delivery:'queued',data:{text:'Original queued target'},withdraw:{request_id:'queued-original'}},
    {seq:5,kind:'user_message',delivery:'delivered',data:{text:'Already delivered'},withdraw:{request_id:'old'}}
  ];return initial;
};
test('waiting strip shows actual waiting facts; only original capabilities offer withdrawal across heartbeat',()=>{
  const h=shell(),initial=pendingSnapshot();h.publish(initial);h.flush();
  const rows=()=>[...h.element('composer-pending').querySelectorAll('.composer-pending-row')];
  const original=rows();assert.deepEqual(original.map(node=>node.dataset.seq),['1','3','4']);
  assert.match(original[0].textContent,/待下一轮处理/);assert.equal(original[1].querySelector('.composer-pending-action').hidden,true);assert.match(original[2].textContent,/待发送/);
  for(let index=0;index<60;index++){h.publish(initial);h.flush();}
  assert.equal(rows()[0],original[0]);assert.equal(rows()[1],original[1]);
  h.element('mode-codex').onclick();h.flush();assert.equal(h.element('composer-pending').hidden,true);
  assert.equal(h.commands.some(row=>['start','send','resume','withdraw','stop-generation'].includes(row.action)),false);
});
test('unknown accepted submission only reads the original receipt, even with modified or empty draft',async()=>{
  for(const draft of ['Freshly changed draft','']){
    const h=shell(),initial=snapshot({connectionGeneration:1,pendingObjective:'Original submission with unknown receipt'});h.publish(initial);h.flush();
    h.element('objective').value=draft;h.element('objective').oninput();
    const row=h.element('composer-pending').querySelector('.composer-pending-row');
    assert.equal(row.dataset.seq,'original-submit');assert.match(row.textContent,/发送待核对.*核对提交/);
    await row.querySelector('.composer-pending-action').onclick();
    const calls=h.commands.filter(row=>row.action==='reconcile-submission');assert.equal(calls.length,1);
    assert.equal(calls[0].payload.id,'alpha');assert.equal(calls[0].payload.objective,initial.pendingObjective);
    assert.equal(calls[0].payload.expected_connection_generation,1);assert.equal(calls[0].payload.expected_request_id,null);
    assert.equal(h.element('objective').value,draft);assert.deepEqual(h.submissions,[]);
    assert.equal(h.commands.some(row=>['withdraw','start','send','resume','stop-generation'].includes(row.action)),false);
  }
});

test('withdraw restores exact old note after a task switch and preserves the new task draft',async()=>{
  const h=shell(),initial=pendingSnapshot();h.publish(initial);h.flush();let resolve;
  h.element('objective').value='Alpha existing draft';
  h.setCommand(action=>action==='withdraw'?new Promise(yes=>{resolve=yes;}):{});
  const pending=h.element('composer-pending').querySelector('.composer-pending-action').onclick();
  const beta=copy(initial);beta.selected='beta';beta.view={page_id:'beta',thread_id:'original-beta',events:[]};h.publish(beta);h.flush();
  h.element('objective').value='Beta new draft';h.element('objective').oninput();
  resolve({text:'Original unread note',model_sends:0});await pending;h.flush();
  assert.equal(h.element('objective').value,'Beta new draft');
  assert.equal(h.evaluate("drafts.get('alpha')"),'Alpha existing draft\n\nOriginal unread note');
  const calls=h.commands.filter(row=>row.action==='withdraw');assert.equal(calls.length,1);
  assert.equal(calls[0].payload.id,'alpha');assert.equal(calls[0].payload.request_id,'accepted-original');assert.equal(calls[0].payload.note_id,'note-1');
  assert.equal(h.commands.some(row=>['resume','stop-generation','refresh','start'].includes(row.action)),false);
});
test('file references append to the fresh draft using original request identity, with no send or permission change',async()=>{
  const h=shell(),initial=snapshot({connectionGeneration:7});initial.view.thread_id='original-alpha';initial.view.request={id:'accepted-package',phase:'processing'};
  h.publish(initial);h.flush();let resolve;
  h.setCommand(action=>action==='pick-context'?new Promise(yes=>{resolve=yes;}):{});
  h.element('objective').value='Before file dialog';const pending=h.element('composer-add-files').onclick();
  h.element('objective').value='Freshly typed while waiting';h.element('objective').oninput();
  resolve({references:[{path:'D:/fixture/project/src/example.js',relative_path:'src/example.js',kind:'file'}],model_sends:0});await pending;
  assert.match(h.element('objective').value,/^Freshly typed while waiting\n\n请读取以下项目内文件/);
  assert.match(h.element('objective').value,/"D:\/fixture\/project\/src\/example.js"/);
  const calls=h.commands.filter(row=>row.action==='pick-context');assert.equal(calls.length,1);
  assert.equal(calls[0].payload.id,'alpha');assert.equal(calls[0].payload.kind,'files');
  assert.equal(calls[0].payload.expected_connection_generation,7);assert.equal(calls[0].payload.expected_request_id,'accepted-package');
  assert.equal(h.commands.some(row=>['send','start','resume','stop-generation','settings'].includes(row.action)),false);
});
for(const change of ['selection','selection-aba','workflow-aba','request','connection'])test('late file references cannot enter a changed '+change+' context',async()=>{
  const h=shell(),initial=snapshot({connectionGeneration:1});initial.view.thread_id='original-alpha';h.publish(initial);h.flush();let resolve;
  h.setCommand(action=>action==='pick-context'?new Promise(yes=>{resolve=yes;}):{});
  h.element('objective').value='Original draft';const pending=h.element('composer-add-folder').onclick();
  if(change.startsWith('selection')){const beta=copy(initial);beta.selected='beta';beta.view={page_id:'beta',thread_id:'original-beta',events:[]};h.publish(beta);h.flush();if(change==='selection-aba'){h.publish(initial);h.flush();}}
  else if(change==='workflow-aba'){h.element('mode-local').onclick();h.element('mode-web').onclick();h.flush();}
  else{const next=copy(initial);if(change==='request')next.view.request={id:'new-original-request',phase:'processing'};else next.connectionGeneration=2;h.publish(next);h.flush();}
  h.element('objective').value='New current draft';h.element('objective').oninput();
  resolve({references:[{path:'D:/fixture/project',kind:'folder'}],model_sends:0});await pending;h.flush();
  assert.equal(h.element('objective').value,'New current draft');assert.equal(h.commands.filter(row=>row.action==='pick-context').length,1);
  assert.equal(h.commands.some(row=>['send','start','resume','stop-generation','refresh'].includes(row.action)),false);
});
test('composer access comes from actual project scope and textarea grows only to its viewport bound',()=>{
  const h=shell(),initial=snapshot();Object.assign(initial.pages[0],{access:'write',write_paths:['.']});h.publish(initial);h.flush();
  assert.equal(h.element('composer-access-label').textContent,'完整项目访问');assert.equal(h.element('composer-access').dataset.access,'full');
  initial.pages[0].write_paths=['src'];h.publish(initial);h.flush();assert.equal(h.element('composer-access-label').textContent,'指定目录访问');
  initial.pages[0].access='read';h.publish(initial);h.flush();assert.equal(h.element('composer-access-label').textContent,'只读访问');
  const input=h.element('objective');Object.defineProperty(input,'scrollHeight',{get:()=>500,configurable:true});input.value='Long draft';input.oninput();
  assert.equal(input.style.height,'220px');assert.equal(input.style.overflowY,'auto');
  h.window.innerHeight=320;h.window.dispatchEvent(new h.window.Event('resize'));assert.equal(input.style.height,'96px');
  assert.equal(h.commands.some(row=>['send','start','resume','configure-intake'].includes(row.action)),false);
});

test('an already resolved original submission never clears the draft or reports accepted work',async()=>{
  const h=shell(),initial=snapshot({connectionGeneration:1,pendingObjective:'Original unknown submission'});h.publish(initial);h.flush();
  h.element('objective').value='Original unknown submission';
  h.setCommand(action=>action==='reconcile-submission'?{state:'rejected',code:'managed_submission_original_intent_missing',model_sends:0}:{});
  await h.element('composer-pending').querySelector('.composer-pending-action').onclick();
  assert.equal(h.element('objective').value,initial.pendingObjective);assert.match(h.element('notice-text').textContent,/没有再次发送.*草稿已保留/);
  assert.equal(h.commands.some(row=>['start','resume','stop-generation'].includes(row.action)),false);
});
test('a late original receipt preserves edits made while checking, and the main submit follows the same read-only route',async()=>{
  const h=shell(),initial=snapshot({connectionGeneration:1,pendingObjective:'Original unknown submission'});h.publish(initial);h.flush();let resolve;
  h.setCommand(action=>action==='reconcile-submission'?new Promise(yes=>{resolve=yes;}):{});
  const checking=h.element('composer').onsubmit({preventDefault(){}});
  assert.equal(h.commands.filter(row=>row.action==='reconcile-submission').length,1);
  h.element('objective').value='Typed after checking started';h.element('objective').oninput();
  resolve({state:'queued_for_web_host',request_id:'accepted-original'});await checking;h.flush();
  assert.equal(h.element('objective').value,'Typed after checking started');
  assert.equal(h.commands.filter(row=>row.action==='start').length,0);
});
test('waiting messages without a withdrawal capability cannot invoke backend withdrawal',()=>{
  const h=shell(),initial=pendingSnapshot();h.publish(initial);h.flush();
  const row=h.element('composer-pending').querySelector('[data-seq="3"]');assert.ok(row);
  assert.equal(row.querySelector('.composer-pending-action').hidden,true);
  row.querySelector('.composer-pending-action').onclick();
  assert.equal(h.commands.filter(row=>row.action==='withdraw').length,0);
});

for(const action of ['pick-context','reconcile-submission','withdraw'])test('late '+action+' failures stay with the old task',async()=>{
  const h=shell();h.publish(snapshot());h.flush();let reject;
  h.setCommand(kind=>kind===action?new Promise((resolve,no)=>{reject=no;}):{});
  const pending=h.evaluate("act('"+action+"',{id:'alpha'})");
  const next=snapshot({selected:'beta',view:{page_id:'beta',events:[]}});h.publish(next);h.flush();
  reject(Error('old task refusal'));await pending;h.flush();
  assert.equal(h.element('notice-text').textContent.includes('old task refusal'),false);
  assert.equal(h.commands.filter(row=>row.action===action).length,1);
});

test('formal shell inspection reads geometry without exposing a draft or sending work',async()=>{
  const h=shell();h.publish(snapshot());h.flush();h.element('objective').value='Private unsent draft';
  const before=h.commands.length,r=await h.control('inspect');
  assert.equal(r.ok,true);assert.equal(r.result.selected,'alpha');assert.equal(r.result.draft_length,20);
  assert.doesNotMatch(JSON.stringify(r),/Private unsent draft/);
  assert.equal(h.commands.slice(before).filter(command=>!['status','layout'].includes(command.action)).length,0);
});

test('formal shell reload preparation saves the original draft and display without model dispatch',async()=>{
  const h=shell();h.publish(snapshot());h.flush();h.element('objective').value='Original draft';
  const before=h.commands.length,r=await h.control('prepare-reload');
  assert.equal(r.ok,true);assert.equal(r.result.safe,true);
  assert.equal(new Map(JSON.parse(h.storage.get('clw-composer-drafts'))).get('alpha'),'Original draft');
  assert.equal(JSON.parse(h.storage.get('clw-shell-view')).selected,'alpha');
  assert.equal(h.commands.slice(before).filter(command=>!['status','layout'].includes(command.action)).length,0);
});

for(const [label,setup] of [['IME',h=>h.evaluate('composerComposition=true')],['new task',h=>h.evaluate('newTaskDraft={title:"Unsaved"}')],
  ['goal dialog',h=>h.element('budget-dialog').open=true],['operation',h=>h.evaluate('busy.add("start")')],['settings',h=>h.evaluate('detailMode="settings"')]])
  test('reload cannot discard '+label,async()=>{
    const h=shell();h.publish(snapshot());h.flush();setup(h);const r=await h.control('prepare-reload');
    assert.equal(r.ok,false);assert.match(r.code,/in_progress/);
    assert.equal(h.commands.filter(command=>['start','resume','stop-generation'].includes(command.action)).length,0);
  });

test('compact navigation overlays can close without changing task or automation',()=>{
  const h=shell();h.publish(snapshot());h.flush();h.window.innerWidth=430;h.window.dispatchEvent(new h.window.Event('resize'));h.flush();
  assert.equal(h.element('sidebar-toggle').getAttribute('aria-expanded'),'false');
  h.element('sidebar-toggle').onclick();h.flush();assert.equal(h.element('sidebar-toggle').getAttribute('aria-expanded'),'true');
  h.element('sidebar-scrim').onclick();h.flush();assert.equal(h.element('sidebar-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(h.currentState().selected,'alpha');assert.equal(h.commands.filter(command=>['start','resume','pause','stop-generation'].includes(command.action)).length,0);
});

for(const [label,setup] of [['open first-task options',h=>h.element('first-task-options').open=true],
  ['closed title edit',h=>h.element('title').value='Unsubmitted name'],
  ['closed duration edit',h=>h.element('hours').value='12'],['closed budget edit',h=>h.element('budget').value='90'],
  ['closed access edit',h=>h.element('access').value='read'],['closed write paths edit',h=>h.element('write-paths').value='Assets']])
  test('reload preserves '+label+' before first enrollment',async()=>{
    const h=shell();h.publish(snapshot({pages:[page('alpha',{bound:false,enrollment_phase:'discovered',first_turn_instructions:''})]}));h.flush();
    setup(h);const before=h.commands.length,r=await h.control('prepare-reload');
    assert.equal(r.ok,false);assert.match(r.code,/in_progress/);
    assert.equal(h.commands.slice(before).filter(command=>!['status','layout'].includes(command.action)).length,0);
    assert.equal(h.storage.has('clw-shell-view'),false);
  });

test('unchanged first-task options permit shell preparation without enrollment',async()=>{
  const h=shell();h.publish(snapshot({pages:[page('alpha',{bound:false,enrollment_phase:'discovered',first_turn_instructions:''})]}));h.flush();
  const before=h.commands.length,r=await h.control('prepare-reload');assert.equal(r.ok,true);
  assert.equal(h.commands.slice(before).filter(command=>!['status','layout'].includes(command.action)).length,0);
});

test('first-task IME composition blocks reload until the browser completes it',async()=>{
  const h=shell();h.publish(snapshot({pages:[page('alpha',{bound:false,enrollment_phase:'discovered',first_turn_instructions:''})]}));h.flush();
  h.element('first-task-objective').dispatchEvent(new h.window.Event('compositionstart',{bubbles:true}));
  let r=await h.control('prepare-reload');assert.equal(r.ok,false);assert.match(r.code,/in_progress/);
  h.element('first-task-objective').dispatchEvent(new h.window.Event('compositionend',{bubbles:true}));
  r=await h.control('prepare-reload');assert.equal(r.ok,true);
  assert.equal(h.commands.filter(command=>['start','enroll','resume','start-first-turn'].includes(command.action)).length,0);
});

function automationSnapshot({paused=false,maintenance=null,active=true}={}){
  const initial=snapshot(),request={id:'original-running-request',phase:'processing',attempt_id:'control_original',sent_user_hash:'original_hash'};
  if(active)initial.view.attempt={id:'control_original',state:'acknowledged',acknowledged:Date.now()/1000};
  initial.pages[0].paused=paused;initial.pages[0].latest_request=active?request:null;
  initial.view.latest_request=active?request:null;initial.view.request=active?request:null;
  initial.view.run.state='active';initial.view.maintenance=maintenance;return initial;
}
function visibleAutomationActions(h){return ['team-maintenance','pause','resume'].filter(id=>!h.element(id).hidden);}

test('paused controller with an active original request has one resume action and no contradictory team pause',()=>{
  const h=shell(),initial=automationSnapshot({paused:true});h.publish(initial);h.flush();
  assert.deepEqual(visibleAutomationActions(h),['resume']);assert.match(h.element('resume').textContent,/恢复自动推进/);
  assert.equal(h.element('workflow-action').hidden,true);assert.equal(h.currentState().view.request.id,'original-running-request');
  assert.equal(h.commands.some(row=>['pause','resume','start','stop-generation','team-maintenance'].includes(row.action)),false);
});

test('unpaused controller offers team pause in place of the ordinary page pause',()=>{
  const h=shell();h.publish(automationSnapshot());h.flush();
  assert.deepEqual(visibleAutomationActions(h),['team-maintenance']);assert.match(h.element('team-maintenance').textContent,/暂停自动推进/);
  assert.equal(h.commands.some(row=>['pause','resume','start','stop-generation','team-maintenance'].includes(row.action)),false);
});

for(const maintenanceState of ['holding','settled'])test('maintenance '+maintenanceState+' retains only its existing team recovery action',()=>{
  const h=shell();h.publish(automationSnapshot({paused:true,maintenance:{state:maintenanceState,pending:[]}}));h.flush();
  assert.deepEqual(visibleAutomationActions(h),['team-maintenance']);assert.match(h.element('team-maintenance').textContent,/恢复自动推进/);
  assert.equal(h.element('resume').hidden,true);assert.equal(h.element('pause').hidden,true);
  assert.equal(h.commands.some(row=>['pause','resume','start','stop-generation','team-maintenance'].includes(row.action)),false);
});

test('paused idle task with no goal describes its actual local draft action and never implies automatic sending',async()=>{
  const h=shell(),initial=automationSnapshot({paused:true,active:false});h.publish(initial);h.flush();
  h.element('objective').value='保留新工作要求';h.element('objective').oninput();h.flush();
  assert.equal(h.element('start').dataset.action,'save-draft');assert.match(h.element('start').textContent,/保存草稿/);
  assert.match(h.element('compose-hint').textContent,/草稿.*本机.*尚未排队发送/);assert.doesNotMatch(h.element('compose-hint').textContent,/发送并开始/);
  assert.deepEqual(visibleAutomationActions(h),[]);assert.equal(h.element('workflow-action').hidden,false);
  await h.element('composer').onsubmit({preventDefault(){}});h.flush();
  assert.equal(new Map(JSON.parse(h.storage.get('clw-composer-drafts'))).get('alpha'),'保留新工作要求');assert.equal(h.currentState().pages[0].paused,true);
  assert.equal(h.commands.some(row=>['pause','resume','start','stop-generation','team-maintenance'].includes(row.action)),false);
});

test('original unknown submission hint names the reconcile action without implying new work',()=>{
  const h=shell(),initial=automationSnapshot({paused:true,active:false});initial.pendingObjective='原未知提交';h.publish(initial);h.flush();
  assert.equal(h.element('start').dataset.action,'reconcile');assert.match(h.element('compose-hint').textContent,/核对提交.*同一次提交/);
  assert.doesNotMatch(h.element('compose-hint').textContent,/发送并开始|才开始新工作/);
  assert.equal(h.currentState().pendingObjective,'原未知提交');assert.equal(h.commands.some(row=>['start','resume','reconcile-submission'].includes(row.action)),false);
});

test('goal, active supplement and maintenance hints keep their actual existing semantics',()=>{
  const h=shell(),initial=automationSnapshot({paused:true,active:false});
  initial.view.goal={configured:true,objective:'原长期目标',state:'paused',mode:'manual',revision:1,request_id:'done-original',can_review:true};
  initial.view.latest_request={id:'done-original',phase:'completed'};initial.pages[0].latest_request=initial.view.latest_request;
  h.publish(initial);h.flush();assert.equal(h.element('start').dataset.action,'goal');assert.match(h.element('compose-hint').textContent,/目标与验收.*均不发送/);
  const active=automationSnapshot({paused:true});h.publish(active);h.flush();assert.match(h.element('compose-hint').textContent,/补充.*下一轮.*当前回合继续工作/);
  const held=automationSnapshot({paused:true,maintenance:{state:'holding',pending:[]}});h.publish(held);h.flush();
  assert.match(h.element('compose-hint').textContent,/补充仅保存到原任务.*维护暂停/);
  assert.equal(h.commands.some(row=>['start','resume','goal-continue','team-maintenance','stop-generation'].includes(row.action)),false);
});


test('completed QA remains saved with a separate read warning and no meaningless recovery action',()=>{
  const h=shell(),initial=snapshot(),saved={id:'qa-original',phase:'completed',attempt_id:'control_qa'};
  initial.pages[0].paused=true;initial.pages[0].latest_request=saved;
  initial.pages[0].observation.error='page_snapshot_timeout';
  initial.pages[0].observation.publicProcess={title:'Old thinking activity'};
  initial.view.latest_request=saved;initial.view.goal={configured:false};initial.view.next_round={count:0};
  initial.view.attempt={id:'control_qa',state:'acknowledged',acknowledged:100};
  h.publish(initial);h.flush();
  assert.equal(h.element('workflow-title').textContent,'本轮结果已保存');
  assert.match(h.element('workflow-observation').textContent,/网页状态读取/);
  assert.doesNotMatch(h.element('workflow-observation').textContent,/page_snapshot_timeout/);
  assert.equal(h.element('workflow-action').hidden,true);
  assert.deepEqual(visibleAutomationActions(h),[]);
  h.element('process-toggle').onclick();h.flush();
  assert.doesNotMatch(h.element('public-process').textContent,/Old thinking activity/);
  const healthy=copy(initial);delete healthy.pages[0].observation.error;h.publish(healthy);h.flush();
  assert.equal(h.element('workflow-title').textContent,'本轮结果已保存');
  assert.equal(h.element('workflow-observation').hidden,true);
  assert.equal(h.currentState().pages[0].paused,true);
  assert.equal(h.commands.some(row=>['start','resume','refresh','stop-generation'].includes(row.action)),false);
});

test('new draft reveals an explicit unpause without sending or replacing the saved reply',async()=>{
  const h=shell(),initial=automationSnapshot({paused:true,active:false});
  const saved={id:'saved-original',phase:'completed'};initial.pages[0].latest_request=saved;initial.view.latest_request=saved;
  h.publish(initial);h.flush();assert.equal(h.element('workflow-action').hidden,true);
  h.element('objective').value='Next requirements in original order';h.element('objective').oninput();h.flush();
  assert.equal(h.element('workflow-action').hidden,false);assert.equal(h.element('workflow-action').dataset.label,'解除暂停');
  h.setCommand((action)=>{if(action==='resume'){const restored=copy(initial);restored.pages[0].paused=false;h.publish(restored);return {paused:false};}return {};});
  await h.element('workflow-action').onclick();h.flush();
  assert.equal(h.element('objective').value,'Next requirements in original order');
  assert.equal(h.currentState().view.latest_request.id,'saved-original');
  assert.equal(h.element('start').dataset.label,'发送消息');
  assert.equal(h.commands.filter(row=>row.action==='resume').length,1);
  assert.equal(h.commands.some(row=>['start','refresh','enroll','start-first-turn'].includes(row.action)),false);
});

test('public approval action names the confirmation and does not pretend to resume work',()=>{
  const h=shell(),initial=automationSnapshot({paused:true});
  initial.pages[0].observation.approvalRequired=true;
  h.publish(initial);h.flush();
  assert.equal(h.element('workflow-action').dataset.label,'查看网页确认');
  assert.equal(h.element('workflow-action').dataset.action,'view');
  assert.equal(h.currentState().pages[0].paused,true);
});


test('Codex progress disclosure and local redraw never borrow a Web observation warning or reply state',()=>{
  const h=shell(),initial=snapshot();
  initial.pages[0].paused=true;initial.pages[0].observation.error='page_snapshot_timeout';
  initial.pages[0].latest_request={id:'qa-saved',phase:'completed'};initial.view.latest_request=initial.pages[0].latest_request;
  initial.codexWeb={state:'ready',recent:[{traceId:'aaaaaaaaaaaa',status:'completed',account:'A',submission:'confirmed',
    startedAt:'2026-10-11T03:00:00Z',endedAt:'2026-10-11T03:00:15Z',
    source:{traceId:'aaaaaaaaaaaa',threadId:'native-original',turnId:'native-turn',prompt:'Original native task'},review:{finalText:'Saved native reply'}}]};
  h.publish(initial);h.flush();
  h.evaluate("setWorkflowMode('codex');codexSelected='native-original';render();");h.flush();
  const title=h.element('workflow-title').textContent;
  h.element('workflow-toggle').onclick();h.flush();
  assert.equal(h.element('workflow-title').textContent,title);
  assert.equal(h.element('workflow-observation').hidden,true);
  assert.equal(h.element('workflow-action').hidden,true);
  h.element('objective').value='Hidden native draft';h.element('objective').oninput();h.flush();
  assert.equal(h.element('workflow-title').textContent,title);
  assert.equal(h.element('workflow-observation').hidden,true);
  assert.equal(h.commands.some(row=>['resume','start','refresh','stop-generation'].includes(row.action)),false);
});


test('project-free conversations never borrow the host checkout as their project',()=>{
  const h=shell(),initial=snapshot();initial.pages[0].root='';
  h.publish(initial);h.flush();
  assert.match(h.element('connection').textContent,/直接对话.*项目可选/);
  const group=h.element('pages').querySelector('[data-page-id="alpha"]').closest('.project-group');
  assert.equal(group.querySelector('.project-label').textContent,'直接对话');
  assert.ok(!group.querySelector('.project-heading button'));
  assert.equal(h.commands.some(row=>['start','resume','project-menu'].includes(row.action)),false);
});


test('claim history describes local acceptance without inventing send order or model activity',()=>{
  const h=shell();h.publish(snapshot());h.flush();
  for(const source of ['explicit_project_host_process_not_provider_authentication','bound_browser_public_receiver']){
    const value=h.evaluate('eventRecordText('+JSON.stringify({kind:'host_claimed',data:{source}})+')');
    assert.equal(value,'本地已登记任务受理');assert.doesNotMatch(value,/准备发送|模型.*工作|已送达/);
  }
});


function controllableGoalSnapshot(){
  const s=automationSnapshot({paused:true}),req=s.view.request;
  s.view.goal={configured:true,mode:'automatic',state:'active',objective:'Complete original goal',etag:'goal-original',revision:1,request_id:req.id,cycles:1};
  s.pages[0].goal={configured:true,mode:'automatic',state:'active',revision:1};return s;
}

test('goal bar exposes pause/resume and close independently from task details and current generation',async()=>{
  const h=shell(),s=controllableGoalSnapshot();h.publish(s);h.flush();
  assert.equal(h.element('composer-goal-state').textContent,'目标已暂停');
  assert.equal(h.element('composer-goal-toggle').hidden,false);assert.equal(h.element('composer-goal-toggle').getAttribute('aria-label'),'继续目标');
  assert.equal(h.element('composer-goal-stop').hidden,false);assert.equal(h.element('composer-goal-stop').disabled,false);
  const original=s.view.request.id;h.setCommand(action=>action==='resume'?{paused:false}:{});
  await h.element('composer-goal-toggle').onclick();h.flush();
  const resumes=h.commands.filter(row=>row.action==='resume');assert.equal(resumes.length,1);assert.equal(resumes[0].payload.expected_request_id,original);
  assert.equal(h.commands.some(row=>['start','stop-generation','goal-stop'].includes(row.action)),false);
});

test('closing a goal preserves an unknown original operation across canonical changes and never sends',async()=>{
  const h=shell(),s=controllableGoalSnapshot();h.publish(s);h.flush();let lost=true;
  h.setCommand((action,payload)=>{
    if(action!=='goal-stop')return {};
    const stopped=copy(s);stopped.view.goal={...s.view.goal,state:'stopped',display_state:'stopped',etag:'goal-stopped',revision:2};stopped.pages[0].goal={...s.pages[0].goal,state:'stopped',revision:2};
    h.publish(stopped);
    if(lost){lost=false;throw Error('runtime_receipt_unknown_reconcile_original');}
    return {state:'goal_stopped',goal:stopped.view.goal,model_sends:0,future_paused:true};
  });
  await h.element('composer-goal-stop').onclick();h.flush();
  assert.equal(h.element('composer-goal').hidden,false,'An unknown original stop remains queryable');
  assert.equal(h.element('composer-goal-stop').disabled,false);
  const first=h.commands.find(row=>row.action==='goal-stop').payload;
  await h.element('composer-goal-stop').onclick();h.flush();
  const stops=h.commands.filter(row=>row.action==='goal-stop');assert.equal(stops.length,2);assert.deepEqual(stops[1].payload,first);
  assert.equal(h.element('composer-goal').hidden,true);
  assert.equal(h.element('composer-add-goal').textContent,'重新设置目标');
  assert.equal(h.currentState().view.request.id,s.view.request.id);
  assert.equal(h.commands.some(row=>['start','resume','stop-generation','withdraw'].includes(row.action)),false);
});

test('primary stop appears only for a fresh generating page and gives way to saved supplements',()=>{
  const h=shell(),s=controllableGoalSnapshot();s.pages[0].observation.generating=true;s.pages[0].observation.at=Date.now();h.publish(s);h.flush();
  assert.equal(h.element('composer-stop').hidden,false);assert.equal(h.element('start').hidden,true);
  h.element('objective').value='Keep this supplement for next round';h.element('objective').oninput();h.flush();
  assert.equal(h.element('composer-stop').hidden,true);assert.equal(h.element('start').hidden,false);
  const idle=copy(s);idle.pages[0].observation.generating=false;h.publish(idle);h.flush();assert.equal(h.element('composer-stop').hidden,true);
  const stale=copy(s);stale.pages[0].observation.at=Date.now()-60000;h.publish(stale);h.flush();assert.equal(h.element('composer-stop').hidden,true);
  assert.equal(h.commands.some(row=>['stop-generation','resume','start','goal-stop'].includes(row.action)),false);
});

test('an original unknown Goal closure receipt cannot label a later explicitly reset Goal as closed',async()=>{
  const h=shell(),s=controllableGoalSnapshot();h.publish(s);h.flush();let original;
  h.setCommand((action,payload)=>{
    if(action!=='goal-stop')return {};
    if(!original){original=copy(payload);throw Error('runtime_receipt_unknown_reconcile_original');}
    return {state:'goal_stopped',model_sends:0,future_paused:true,
      goal:{...s.view.goal,state:'stopped',display_state:'stopped',revision:2,etag:'original-closed'}};
  });
  await h.element('composer-goal-stop').onclick();h.flush();
  const newer=copy(s);newer.view.goal={...s.view.goal,revision:3,etag:'explicit-new-goal',objective:'New explicit goal'};
  newer.pages[0].goal={...s.pages[0].goal,revision:3};h.publish(newer);h.flush();
  await h.element('composer-goal-stop').onclick();h.flush();
  assert.deepEqual(h.commands.filter(row=>row.action==='goal-stop')[1].payload,original);
  assert.equal(h.currentState().view.goal.state,'active');assert.equal(h.currentState().view.goal.etag,'explicit-new-goal');
  assert.equal(h.element('notice-text').textContent,'原关闭操作已核对，后来重新设置的目标保持当前状态。');
});

test('history panel shows complete local B cache and partial A coverage without remote controls or draft changes',async()=>{
  const h=shell();h.publish(snapshot());h.flush();h.element('objective').value='Preserve original task requirement';
  const s=snapshot(),at=Date.now()-3600000;
  s.quotas=[{account:'A',models:[],historyPolicy:'cache_only',historyProgress:null,
    usage:{stale:true,lastGood:null,lastAttempt:{checkedAt:at,coverage:{state:'partial',conversationsRead:19,conversationsListed:20,reason:'http_403',diagnostic:{browserVerification:true}}}}},
    {account:'B',models:[],historyPolicy:'cache_only',historyProgress:null,usage:{stale:true,
      lastGood:{checkedAt:at,window:{start:at-7*24*3600000,end:at,source:'rolling_7d'},completedProResponses:50,proConversations:13,coverage:{state:'complete'},byModel:[]},
      lastAttempt:{coverage:{state:'failed',reason:'rate_limited'}}}}];
  h.publish(s);h.flush();h.element('quota-open').onclick();
  assert.equal(h.element('quota-history').querySelectorAll('section').length,2);
  const text=h.element('quota-history').textContent;
  assert.match(text,/19 \/ 20 个对话/);assert.match(text,/Pro 用量未知/);assert.match(text,/50 次完成的 Pro 回复/);assert.match(text,/涉及 13 个对话/);
  assert.ok(text.includes(new Date(at).toLocaleString()));assert.ok(text.includes(new Date(at-7*24*3600000).toLocaleString()));
  assert.match(h.element('quota-summary').textContent,/B · Pro 50 次 · 本机缓存/);
  assert.equal(h.element('quota-history-check'),null);assert.equal(h.element('quota-usage-window'),null);
  assert.equal(h.element('quota-history').querySelectorAll('button').length,0);
  assert.match(h.element('quota-history-message').textContent,/本机保存信息，不联网读取/);
  assert.equal(h.element('objective').value,'Preserve original task requirement');
  assert.deepEqual(h.currentState().pages,s.pages);assert.equal(h.currentState().selected,s.selected);
  assert.equal(h.commands.some(r=>['quota-history','quota-verify','start','resume','stop-generation','quota-check'].includes(r.action)),false);
});

test('retired history and availability controls cannot send history, verification or quota-check requests',async()=>{
  const h=shell();h.publish(snapshot());h.flush();h.element('quota-open').onclick();
  const original=copy(h.currentState()),before=h.commands.length;
  const retired=h.retiredHistoryControls;
  assert.equal(!!retired.button?.onclick,false);assert.equal(!!retired.window?.onchange,false);assert.equal(!!retired.check?.onclick,false);
  retired.button?.dispatchEvent(new h.window.Event('click'));
  retired.window?.dispatchEvent(new h.window.Event('change'));
  retired.check?.dispatchEvent(new h.window.Event('click'));
  await h.evaluate("quotaAction('quota-history',{account:'A'})");
  await h.evaluate("quotaAction('quota-verify',{account:'B'})");
  await h.evaluate("quotaAction('quota-check',{account:'A'})");h.flush();
  assert.deepEqual(h.commands.slice(before),[]);assert.deepEqual(h.currentState(),original);
  assert.equal(h.element('quota-check'),null);
  assert.match(h.element('quota-history-message').textContent,/本机保存信息，不联网读取/);
});

test('background snapshots including obsolete waits never read history or verification and keep task input usable',async()=>{
  const h=shell(),s=snapshot();h.publish(s);h.flush();h.element('quota-open').onclick();
  h.element('objective').value='Do not disturb the original work';h.element('objective').setSelectionRange(3,12);
  const before=h.commands.length;
  for(let index=0;index<20;index++){
    const next=copy(s);next.quotas=['A','B'].map(account=>({account,models:[],historyPolicy:'cache_only',
      usage:{lastGood:null,lastAttempt:{coverage:{state:'failed',reason:'rate_limited',diagnostic:{browserVerification:true}}}},
      historyProgress:{state:index%2?'completed':'reading',startedAt:Date.now(),reason:'rate_limited',waitUntil:Date.now()+33000,conversationsRead:2}}));
    h.publish(next);h.flush();
    assert.equal(h.element('quota-history-check'),null);assert.equal(h.element('quota-history').querySelectorAll('button').length,0);
    assert.doesNotMatch(h.element('quota-history').textContent,/等待至|等待后|正在读取|完成后更新/);
  }
  assert.equal(h.element('objective').value,'Do not disturb the original work');assert.equal(h.element('objective').selectionStart,3);assert.equal(h.element('objective').selectionEnd,12);
  assert.deepEqual(h.currentState().pages,s.pages);assert.equal(h.currentState().selected,s.selected);
  assert.equal(h.element('quota-check'),null);
  assert.equal(h.commands.slice(before).some(r=>['quota-history','quota-verify','start','resume','stop-generation','quota-check'].includes(r.action)),false);
});

test('formal usage panel opening displays both accounts without querying history or changing task execution',async()=>{
 const h=shell();h.publish(snapshot());h.flush();const result=await h.control('view',{view:'quota'});
 assert.equal(result.ok,true);assert.equal(h.element('quota-dialog').open,true);
 assert.equal(h.element('quota-history').querySelectorAll('section').length,2);
 assert.equal(h.commands.some(r=>['quota-history','quota-verify','start','resume','quota-check'].includes(r.action)),false);
});

test('only local user quota reports remain enabled and every history, verification or availability action sends zero requests',async()=>{
 const h=shell();h.publish(snapshot());h.flush();h.element('quota-open').onclick();
 h.element('objective').value='Preserve this manual requirement';h.element('quota-account').value='A';
 h.element('quota-report-model').value='latest-pro';h.element('quota-reset').value='Saved user reset time';
 await h.evaluate("quotaAction('quota-check',{account:'A'})");
 await h.evaluate("quotaAction('quota-history',{account:'A'})");
 await h.evaluate("quotaAction('quota-verify',{account:'A'})");
 await h.element('quota-exhausted').onclick();await h.element('quota-clear').onclick();h.flush();
 const actions=h.commands.filter(row=>row.action.startsWith('quota-'));
 assert.deepEqual(actions,[{action:'quota-report',payload:{account:'A',model:'latest-pro',exhausted:true,resetText:'Saved user reset time'}},
   {action:'quota-report',payload:{account:'A',model:'latest-pro',exhausted:false}}]);
 assert.equal(h.element('objective').value,'Preserve this manual requirement');assert.equal(h.currentState().selected,'alpha');
 assert.equal(h.element('quota-check'),null);assert.equal(h.element('quota-message').textContent,'已保存到本机。');
});
