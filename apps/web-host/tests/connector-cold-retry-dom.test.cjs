'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {dom}=require('../page-dom.cjs');
const operation='dddddddd-dddd-4ddd-dddd-dddddddddddd';
const row=name=>`<button data-list-navigation-item="true"><span>${name}</span></button>`;
function fixture({rows='',duplicate=false,body='@Local-MCP',busy=false}={}){
  const popup=value=>`<div data-composer-overlay-floating-ui><div data-mention-list-scroll-area>${value}</div></div>`;
  const window=createWindow(`<form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true">${body}</div>${busy?'<button data-testid="stop-button"></button>':''}</form>${rows?popup(rows):''}${duplicate?popup(row('Local-MCP')):''}`);
  const document=window.document,editor=document.getElementById('prompt-textarea');let active=null,deletes=0,inserts=0,focuses=0,approval=false,focusHook=null;
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>active});document.hasFocus=()=>false;
  Object.defineProperty(editor,'focus',{value:()=>{focuses++;active=editor;focusHook?.();}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return 100;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return 30;}});
  window.HTMLElement.prototype.getClientRects=()=>[{}];
  const prototype=Object.getPrototypeOf(document.querySelectorAll('div'));Object.defineProperty(prototype,Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
  const selection={isCollapsed:true,anchorNode:null,removeAllRanges(){this.anchorNode=null;},addRange(range){this.anchorNode=range.node;}};
  window.getSelection=()=>selection;document.createRange=()=>({selectNodeContents(node){this.node=node;},collapse(){}});
  document.execCommand=(action,_unused,value)=>{assert.equal(selection.anchorNode,editor);
    if(action==='delete'){deletes++;editor.textContent='';}else{assert.equal(action,'insertText');inserts++;editor.textContent=value;}return true;};
  const context=vm.createContext({document,window,location:{href:'https://chatgpt.com/'},Node:window.Node,getComputedStyle:()=>({flexDirection:'column'})});
  const run=(action,arg={})=>vm.runInContext(`(${dom.toString()})(${JSON.stringify(action)},${JSON.stringify(arg)},()=>{},()=>false,()=>({required:${approval}}))`,context);
  const baseline=run('snapshot');
  return {editor,document,context,run,get deletes(){return deletes;},get inserts(){return inserts;},get focuses(){return focuses;},set approval(value){approval=value;},
    onFocus(fn){focusHook=fn;},addMenu(name='Local-MCP'){const node=document.createElement('div');node.innerHTML=popup(row(name));document.body.appendChild(node);},
    query:extra=>run('connector-query',{expectedConnector:'Local-MCP',expectedText:'',reconciliationId:operation,coldRetry:true,
      expectedBaseline:{url:baseline.url,userId:baseline.userId,assistantId:baseline.assistantId},...extra}),
    clear:extra=>run('connector-clear-query',{expectedConnector:'Local-MCP',expectedText:'@Local-MCP',reconciliationId:operation,coldRetry:true,
      expectedBaseline:{url:baseline.url,userId:baseline.userId,assistantId:baseline.assistantId},...extra})};
}
test('cold retry synchronously clears only a query with no owned menu',()=>{
  const f=fixture();assert.equal(f.clear().cleared,true);assert.equal(f.deletes,1);assert.equal(f.editor.textContent,'');
  assert.throws(()=>f.clear(),/query_changed/);assert.equal(f.deletes,1);
});
test('a uniquely correct menu appearing at clear time returns menuReady without focus or deletion',()=>{
  const f=fixture({rows:row('local-mcp')});assert.equal(f.clear().menuReady,true);assert.equal(f.deletes,0);assert.equal(f.focuses,0);assert.equal(f.editor.textContent,'@Local-MCP');
});
for(const [name,options]of [['wrong app',{rows:row('Other')}],['duplicate name',{rows:row('Local-MCP')+row('local-mcp')}],
  ['duplicate menu',{rows:row('Local-MCP'),duplicate:true}],['empty menu',{rows:'<div>No app</div>'}]])
  test('cold retry preserves a late '+name+' menu',()=>{
    const f=fixture(options);assert.throws(()=>f.clear(),/menu_not_unique_or_query_changed/);assert.equal(f.deletes,0);assert.equal(f.focuses,0);
  });
for(const [name,args,options]of [['baseline absent',{expectedBaseline:null},{}],['wrong baseline',{expectedBaseline:{url:'https://chatgpt.com/',userId:'foreign',assistantId:''}},{}],
  ['operation absent',{reconciliationId:null},{}],['noncall operation',{reconciliationId:'old-automatic-query'},{}],
  ['user draft',{}, {body:'@Local-MCP 原稿'}],['generation',{}, {busy:true}]])
  test('cold retry rejects '+name+' before any deletion',()=>{
    const f=fixture(options);assert.throws(()=>f.clear(args));assert.equal(f.deletes,0);assert.equal(f.focuses,0);
  });
test('approval or composing during cold retry preserves the query',()=>{
  for(const mode of ['approval','IME']){const f=fixture();if(mode==='approval')f.approval=true;else vm.runInContext('globalThis.__clwComposing=true',f.context);
    assert.throws(()=>f.clear(),/send_baseline_changed/);assert.equal(f.deletes,0);}
});
test('a correct menu created synchronously by focus is returned without deleting the query',()=>{
  const f=fixture();f.onFocus(()=>f.addMenu());assert.equal(f.clear().menuReady,true);assert.equal(f.deletes,0);assert.equal(f.editor.textContent,'@Local-MCP');
});
test('a wrong menu created synchronously by focus is preserved without deleting the query',()=>{
  const f=fixture();f.onFocus(()=>f.addMenu('Other App'));assert.throws(()=>f.clear(),/menu_not_unique_or_query_changed/);assert.equal(f.deletes,0);
});
for(const kind of ['stop','draft','second-editor','editor-replacement'])test('focus-time '+kind+' fences cold clear with fresh public nodes',()=>{
  const f=fixture();f.onFocus(()=>{
    if(kind==='stop'){const stop=f.document.createElement('button');stop.setAttribute('data-testid','stop-button');f.document.body.appendChild(stop);}
    if(kind==='draft')f.editor.textContent='我的新草稿';
    if(kind==='second-editor'){const other=f.document.createElement('div');other.setAttribute('data-testid','prompt-textarea');other.setAttribute('contenteditable','true');f.document.body.appendChild(other);}
    if(kind==='editor-replacement'){const other=f.editor.cloneNode(true);f.editor.parentNode.replaceChild(other,f.editor);}
  });assert.throws(()=>f.clear(),/send_baseline_changed|query_changed/);assert.equal(f.deletes,0);
});
test('a confirmed empty composer supports only a cold query with no owned menu',()=>{
  const f=fixture({body:''});assert.equal(f.query().inserted,true);assert.equal(f.inserts,1);assert.equal(f.editor.textContent,'@Local-MCP');
});
test('an owned menu arriving after empty readback prevents the next cold insert',()=>{
  const f=fixture({body:''});assert.equal(f.run('connector-state',{expectedConnector:'Local-MCP'}).menuCount,0);f.addMenu();
  assert.throws(()=>f.query(),/menu_not_unique_or_query_changed/);assert.equal(f.inserts,0);assert.equal(f.editor.textContent,'');
});
test('an owned menu created during query focus prevents a cold insert',()=>{
  const f=fixture({body:''});f.onFocus(()=>f.addMenu());assert.throws(()=>f.query(),/menu_not_unique_or_query_changed/);
  assert.equal(f.inserts,0);assert.equal(f.editor.textContent,'');
});
test('new generation during query focus prevents a cold insert using fresh stop buttons',()=>{
  const f=fixture({body:''});f.onFocus(()=>{const stop=f.document.createElement('button');stop.setAttribute('data-testid','stop-button');f.document.body.appendChild(stop);});
  assert.throws(()=>f.query(),/send_baseline_changed/);assert.equal(f.inserts,0);
});
