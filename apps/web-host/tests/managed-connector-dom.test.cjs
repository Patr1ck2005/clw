'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {dom}=require('../page-dom.cjs'),{WebDriver}=require('../web-driver.cjs');
const URL='https://chatgpt.com/c/original',marker='[CLW:control_'+'b'.repeat(32)+']';
const pill=(name='Local-MCP',attributes='')=>`<span app-mention-path="app://original" app-mention-display-name="${name}" contenteditable="false" ${attributes}>${name}</span>`;
const row=(name='Local-MCP',description='original connector')=>`<button type="button" data-list-navigation-item="true"><span>${name}</span><small>${description}</small></button>`;
function harness({account='A',body='',rows=row(account==='A'?'Local-MCP':'Local-MCP-B'),extra=''}={}){
 const window=createWindow(`<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox">${body}</div><button type="submit" data-testid="send-button"></button><button data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" aria-haspopup="menu">高</button></form>
 <div data-turn-key="original"><div data-user-message-bubble>原始任务</div><div data-conversation-role="assistant"><div class="markdown">原始答案</div></div></div>
 <div data-composer-overlay-floating-ui hidden><div data-mention-list-scroll-area>${rows}</div></div>${extra}`);
 const document=window.document;let active=null,selected=0,sends=0,insertions=0,beforeSend=null,approval=false;
 const location={href:URL},getEditor=()=>document.querySelector('[contenteditable="true"]');
 Object.defineProperty(document,'activeElement',{configurable:true,get:()=>active});document.hasFocus=()=>false;
 const bindFocus=element=>Object.defineProperty(element,'focus',{configurable:true,value(){active=this;}});
 for(const element of document.querySelectorAll('*'))bindFocus(element);
 Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.closest('[hidden],[inert]')?0:100;}});
 Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return this.offsetWidth?30:0;}});
 window.HTMLElement.prototype.getClientRects=function(){return this.offsetWidth?[{}]:[];};
 for(const list of [document.querySelectorAll('div'),document.body.children])Object.defineProperty(Object.getPrototypeOf(list),Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
 const selection={isCollapsed:true,anchorNode:null,removeAllRanges(){},addRange(range){this.anchorNode=range.node;}};
 document.createRange=()=>({selectNodeContents(node){this.node=node;},setStart(node){this.node=node;},collapse(){}});window.getSelection=()=>selection;
 document.execCommand=(op,_unused,value)=>{
  assert.equal(op,'insertText');insertions++;
  const editor=getEditor();
  if(value.startsWith('@')&&!editor.textContent){editor.textContent=value;document.querySelector('[data-composer-overlay-floating-ui]').removeAttribute('hidden');}
  else{
   const lines=value.split('\n'),anchor=selection.anchorNode;
   if(anchor?.tagName==='P'&&!anchor.textContent){anchor.textContent=lines.shift();}
   for(const line of lines){const p=document.createElement('p');p.textContent=line;editor.appendChild(p);}
  }
  return true;
 };
 for(const button of document.querySelectorAll('[data-mention-list-scroll-area] button'))button.addEventListener('click',()=>{
  selected++;const name=button.querySelector('span').textContent,old=getEditor(),replacement=old.cloneNode(false);
  replacement.innerHTML='<p>'+pill(name)+'<span data-inline-selection-pill-cursor-target>\uFEFF</span></p>';
  bindFocus(replacement);old.parentNode.replaceChild(replacement,old);active=replacement;document.querySelector('[data-composer-overlay-floating-ui]').setAttribute('hidden','');
 });
 const context=vm.createContext({document,window,Node:window.Node,location,getComputedStyle:e=>({flexDirection:e.style.flexDirection||'column'})});
 const run=(action,arg={})=>vm.runInContext(`(${dom.toString()})(${JSON.stringify(action)},${JSON.stringify(arg)},e=>e.click(),()=>false,()=>({required:${approval}}))`,context);
 document.querySelector('[data-testid="send-button"]').addEventListener('click',e=>{
  e.preventDefault();sends++;const body=run('editor-text').text;getEditor().innerHTML='';
  const turn=document.createElement('div');turn.setAttribute('data-turn-key','new');const bubble=document.createElement('div');bubble.setAttribute('data-user-message-bubble','');bubble.textContent=body;turn.appendChild(bubble);document.body.appendChild(turn);
 });
 const p={id:'original',account,documentGeneration:1,view:{webContents:{getURL:()=>location.href,isDestroyed:()=>false}}},runtime=new EventEmitter();
 const driver=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]])},onNotice(){},sleep:async()=>{},
  dom:async(_wc,action,arg)=>{if(action==='send')beforeSend?.();return run(action,arg);}});
 const baseline=run('snapshot');
 return {window,document,location,driver,p,baseline,run,editor:getEditor,get selected(){return selected;},get sends(){return sends;},get insertions(){return insertions;},
  beforeSend(fn){beforeSend=fn;},approval(value){approval=value;}};
}
for(const account of ['A','B'])test('public DOM selects real '+account+' pill, survives composer replacement and sends complete Chinese prompt once',async()=>{
 const h=harness({account}),prompt='\n  中文任务要求。\r\n正文 @Local-MCP 只是原文\r\n```text\r\n  缩进保留\r\n```\n'+marker;
 const result=await h.driver.send(h.p,prompt,h.baseline,marker);
 assert.equal(h.selected,1);assert.equal(h.sends,1);assert.equal(h.insertions,2);assert.equal(result.attemptMarker,marker);
 const bubble=h.document.querySelector('[data-turn-key="new"] [data-user-message-bubble]');assert.equal(bubble.textContent,prompt.replace(/\r\n/g,'\n'));
});

for(const [account,label] of [['A','local-mcp'],['B','local-mcp-b']])test('serialized DOM accepts lowercase '+account+' menu title and retains raw selected label',async()=>{
 const h=harness({account,rows:row(label)}),prompt='中文原任务\n'+marker;
 const menu=h.document.querySelector('[data-composer-overlay-floating-ui]');menu.removeAttribute('hidden');
 const before=h.run('connector-state',{expectedConnector:account==='A'?'Local-MCP':'Local-MCP-B'});
 assert.equal(before.exactRows,1);assert.deepEqual(Array.from(before.titles),[label]);menu.setAttribute('hidden','');
 const result=await h.driver.send(h.p,prompt,h.baseline,marker);
 assert.equal(h.selected,1);assert.equal(h.sends,1);assert.equal(result.attemptMarker,marker);
});

test('actual A SPAN chip path and lowercase label stay unchanged through original body preparation',async()=>{
 const name='local-mcp',path='app://asdk_app_6aafc9612cb48191b4b0a1dac31278d4';
 const h=harness({body:'<p>'+pill(name).replace('app://original',path)+' </p>'}),chip=h.editor().querySelector('[app-mention-path]');
 chip.getBoundingClientRect=()=>({width:94.71875,height:20});
 const state=h.run('connector-state',{expectedConnector:'Local-MCP',diagnostics:true});
 assert.deepEqual(Array.from(state.selected),[name]);assert.equal(state.editorCount,1);assert.equal(state.visibleSelectedCount,1);assert.equal(state.text,'');
 assert.equal(state.selectedDetails[0].path,path);assert.equal(state.selectedDetails[0].name,name);assert.equal(state.selectedDetails[0].width,94.71875);assert.equal(state.selectedDetails[0].height,20);
 await h.driver.send(h.p,'原任务完整正文\n'+marker,h.baseline,marker);
 assert.equal(h.selected,0);assert.equal(h.sends,1);assert.equal(chip.getAttribute('app-mention-path'),path);assert.equal(chip.getAttribute('app-mention-display-name'),name);
});

test('case variants are two exact owned menu rows and cannot activate either connector',()=>{
 const h=harness({body:'@Local-MCP',rows:row('Local-MCP')+row('local-mcp')});
 h.editor().focus();h.document.querySelector('[data-composer-overlay-floating-ui]').removeAttribute('hidden');
 const state=h.run('connector-state',{expectedConnector:'Local-MCP'});assert.equal(state.exactRows,2);
 assert.deepEqual(Array.from(state.titles),['Local-MCP','local-mcp']);
 assert.throws(()=>h.run('connector-select',{expectedConnector:'Local-MCP',expectedBaseline:h.baseline}),/connector_menu_not_unique_or_query_changed/);
 assert.equal(h.selected,0);assert.equal(h.sends,0);
});

for(const name of ['local-mcp-a','local-mcp-b','MCP-B','LOCAL–MCP'])test('lowercase label does not alias another public connector: '+name,()=>{
 const h=harness({body:'<p>'+pill(name)+' </p><p>原始正文</p>'});
 assert.throws(()=>h.run('send',{expectedConnector:'Local-MCP',expectedText:'原始正文',expectedBaseline:h.baseline}),/connector_selection_mismatch/);
 assert.equal(h.sends,0);assert.equal(h.editor().querySelector('[app-mention-display-name]').getAttribute('app-mention-display-name'),name);
});

test('lowercase chip remains rejected when hidden or duplicated across case variants',()=>{
 for(const body of [pill('local-mcp','hidden'),pill('local-mcp')+pill('Local-MCP')]){
  const h=harness({body:body+'<p>原始正文</p>'});
  assert.throws(()=>h.run('send',{expectedConnector:'Local-MCP',expectedText:'原始正文',expectedBaseline:h.baseline}),/connector_selection_mismatch/);
  assert.equal(h.sends,0);
 }
});
test('menu descriptions cannot impersonate the exact app title and a foreign unowned list cannot be activated',()=>{
 const h=harness({body:'@Local-MCP',rows:row('Other App','Local-MCP'),extra:'<div role="listbox">'+row('Local-MCP')+'</div>'});
 h.document.querySelector('[data-composer-overlay-floating-ui]').removeAttribute('hidden');h.editor().focus();
 const state=h.run('connector-state',{expectedConnector:'Local-MCP'});assert.equal(state.menuCount,1);assert.equal(state.exactRows,0);
 assert.throws(()=>h.run('connector-select',{expectedConnector:'Local-MCP',expectedBaseline:h.baseline}),/connector_menu_not_unique_or_query_changed/);
 assert.equal(h.selected,0);assert.equal(h.sends,0);
});
test('one exact row is activated from the same owned portal even if an unowned matching list exists',()=>{
 const h=harness({body:'@Local-MCP',extra:'<div role="listbox">'+row('Local-MCP')+'</div>'});
 h.document.querySelector('[data-composer-overlay-floating-ui]').removeAttribute('hidden');h.editor().focus();
 h.run('connector-select',{expectedConnector:'Local-MCP',expectedBaseline:h.baseline});assert.equal(h.selected,1);assert.equal(h.sends,0);
});
test('duplicate owned portals and a disabled exact row cannot activate the app',()=>{
 for(const duplicate of [false,true]){
  const h=harness({body:'@Local-MCP',rows:duplicate?row():row().replace('type="button"','type="button" disabled'),
    extra:duplicate?'<div data-composer-overlay-floating-ui><div data-mention-list-scroll-area>'+row()+'</div></div>':''});
  h.document.querySelector('[data-composer-overlay-floating-ui]').removeAttribute('hidden');h.editor().focus();
  assert.throws(()=>h.run('connector-select',{expectedConnector:'Local-MCP',expectedBaseline:h.baseline}),/connector_(?:menu_not_unique_or_query_changed|row_not_unique_or_disabled)/);
  assert.equal(h.selected,0);assert.equal(h.sends,0);
 }
});
for(const body of [pill('CLW T003 Stable No-OIDC'),pill('Local-MCP-A'),pill('Local-MCP')+pill('Local-MCP'),pill('Local-MCP')+pill('Other'),pill('Local-MCP')+pill('Local-MCP','hidden')])test('atomic Send rejects app mismatch/duplicates with exact body: '+body,()=>{
 const h=harness({body:body+'<p>原始正文</p>'});
 assert.equal(h.run('editor-text').text,'原始正文');
 assert.throws(()=>h.run('send',{expectedText:'原始正文',expectedConnector:'Local-MCP',expectedBaseline:h.baseline}),/connector_selection_mismatch/);
 assert.equal(h.sends,0);
});
test('selected app structure excludes cursor padding but preserves real leading blank paragraphs and spaces',()=>{
 const h=harness({body:'<p>'+pill()+'<span data-inline-selection-pill-cursor-target>\uFEFF</span></p><p></p><p>  中文</p><p></p>'});
 assert.equal(h.run('editor-text').text,'\n  中文\n');assert.equal(h.run('snapshot').draft,true);
 h.editor().innerHTML='<p>'+pill()+'  </p>';assert.equal(h.run('editor-text').text,'  ');assert.equal(h.run('snapshot').draft,true);
 h.editor().innerHTML='<p>'+pill()+'<span data-inline-selection-pill-cursor-target>\uFEFF</span></p>';assert.equal(h.run('editor-text').text,'');assert.equal(h.run('snapshot').draft,false);
});
test('the observed ProseMirror app-only ASCII separator is structural while genuine blank/body nodes remain exact',()=>{
 const h=harness({body:'<p>'+pill()+' </p>'});
 assert.equal(h.run('editor-text').text,'');assert.equal(h.run('snapshot').draft,false);
 for(const [body,expected] of [
  ['<p>'+pill()+'  </p>','  '],
  ['<p>'+pill()+'\u00a0</p>','\u00a0'],
  ['<p> '+pill()+' </p>','  '],
  ['<p>'+pill()+' 原始正文</p>',' 原始正文'],
  ['<p>'+pill()+' </p><p></p><p>  中文正文</p>','\n  中文正文'],
  ['<p>'+pill()+'<span> </span></p>',' '],
  ['<p><span data-id="plugin:original" data-keyword="Local-MCP" contenteditable="false">Local-MCP</span> </p>',' '],
 ]){
  h.editor().innerHTML=body;
  assert.equal(h.run('editor-text').text,expected);assert.equal(h.run('snapshot').draft,true);
 }
});
test('a real ProseMirror app-only row admits exact Chinese body insertion and a single Send',async()=>{
 const h=harness({body:'<p>'+pill()+' </p>'}),prompt='\n  原始中文要求\r\n保留  双空格\n'+marker;
 const result=await h.driver.send(h.p,prompt,h.baseline,marker);
 assert.equal(h.selected,0);assert.equal(h.insertions,1);assert.equal(h.sends,1);assert.equal(result.attemptMarker,marker);
 assert.equal(h.document.querySelector('[data-turn-key="new"] [data-user-message-bubble]').textContent,prompt.replace(/\r\n/g,'\n'));
});
test('cached sole Send synchronously reads its visible owned model choice and rejects late menu/model changes',()=>{
 const picker='<div role="menu" id="owned-model"><div role="menuitemradio" aria-checked="true">Latest</div>'+
  '<div data-model-picker-power-slider><span data-orientation="horizontal" aria-disabled="false"><span data-selected="true"></span>'+
  '<span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="4" aria-valuetext="6 Pro"></span></span></div></div>';
 for(const change of ['none','effort','family','closed','duplicate-slider','foreign-menu','duplicate-choice']){
  const body='  原始正文\n'+marker,h=harness({body:'<p>'+pill()+' </p><p>  原始正文</p><p>'+marker+'</p>',extra:picker});
  const control=h.document.querySelector('[data-codex-intelligence-trigger]'),menu=h.document.getElementById('owned-model');
  control.setAttribute('aria-controls','owned-model');control.setAttribute('aria-expanded','true');
  const model=h.run('model');assert.equal(model.model,'GPT-6 · Latest');assert.equal(model.effort,'Pro');
  if(change==='effort')menu.querySelector('[role="slider"]').setAttribute('aria-valuetext','6 高');
  if(change==='family')menu.querySelector('[role="menuitemradio"]').textContent='Other';
  if(change==='closed')menu.setAttribute('hidden','');
  if(change==='duplicate-slider')menu.appendChild(menu.querySelector('[data-model-picker-power-slider]').cloneNode(true));
  if(change==='foreign-menu')control.setAttribute('aria-controls','foreign-menu');
  if(change==='duplicate-choice')menu.appendChild(menu.querySelector('[role="menuitemradio"]').cloneNode(true));
  const send=()=>h.run('send',{expectedText:body,expectedConnector:'Local-MCP',expectedBaseline:h.baseline,
   expectedModel:{model:model.model,effort:model.effort,selection:model.selection}});
  if(change==='none'){send();assert.equal(h.sends,1);}else{
   assert.throws(send,/send_model_selection_mismatch/,change);assert.equal(h.sends,0,change);assert.equal(h.run('editor-text').text,body,change);
  }
 }
});
test('Chromium cursor wrappers retain genuine pasted body and blank lines while excluding just their initial sentinel',()=>{
 const body='中文原任务\n\n保留  双空格\n'+marker;
 const h=harness({body:'<p>'+pill()+'<span data-inline-selection-pill-cursor-target>\u200b中文原任务</span></p><p><span data-inline-selection-pill-cursor-target><br></span></p><p><span data-inline-selection-pill-cursor-target>保留  双空格</span></p><p><span data-inline-selection-pill-cursor-target>'+marker+'</span></p>'});
 assert.equal(h.run('editor-text').text,body);assert.equal(h.run('snapshot').draft,true);
});
test('a pill-only composer does not block read-only history positioning',()=>{
 const h=harness({body:pill(),extra:'<div class="thread-scroll-container"></div>'}),history=h.document.querySelector('.thread-scroll-container');
 Object.defineProperties(history,{clientHeight:{value:100},scrollHeight:{value:1000},scrollTop:{value:0,writable:true}});
 history.scrollTo=({top})=>{history.scrollTop=top-100;};assert.equal(h.run('show-latest').moved,true);assert.equal(h.sends,0);
});
for(const changed of ['new-user','approval','generating','URL'])test('atomic Send rechecks '+changed+' after async preparation and preserves unknown without a second click',async()=>{
 const h=harness();h.beforeSend(()=>{
  if(changed==='new-user'){const user=h.document.createElement('div');user.setAttribute('data-turn-key','manual');user.innerHTML='<div data-user-message-bubble>人工消息</div>';h.document.body.appendChild(user);}
  if(changed==='approval')h.approval(true);
  if(changed==='generating'){const stop=h.document.createElement('button');stop.setAttribute('data-testid','stop-button');h.document.body.appendChild(stop);}
  if(changed==='URL')h.location.href='https://chatgpt.com/c/other';
 });
 await assert.rejects(h.driver.send(h.p,'中文完整要求\n'+marker,h.baseline,marker),e=>e.message==='send_baseline_changed'&&e.notSent===undefined);
 assert.equal(h.sends,0);assert.equal(h.selected,1);
});
test('a new generation or approval before connector selection is rejected synchronously with no app activation',()=>{
 for(const changed of ['generating','approval']){
  const h=harness({body:'@Local-MCP'});h.editor().focus();h.document.querySelector('[data-composer-overlay-floating-ui]').removeAttribute('hidden');
  if(changed==='approval')h.approval(true);else{const stop=h.document.createElement('button');stop.setAttribute('data-testid','stop-button');h.document.body.appendChild(stop);}
  assert.throws(()=>h.run('connector-select',{expectedConnector:'Local-MCP',expectedBaseline:h.baseline}),/send_baseline_changed/);assert.equal(h.selected,0);assert.equal(h.sends,0);
 }
});
