'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {dom}=require('../page-dom.cjs');
function fixture({body='@Local-MCP',busy=false,pill=false}={}){
  const window=createWindow(`<form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true">${pill?'<span app-mention-path="app://original" app-mention-display-name="Local-MCP" contenteditable="false">Local-MCP</span>':''}${body}</div>${busy?'<button data-testid="stop-button"></button>':''}</form>
    <div data-turn-key="original"><div data-user-message-bubble>Original user</div><div data-conversation-role="assistant"><div class="markdown">Original assistant</div></div></div>`);
  const document=window.document,editor=document.getElementById('prompt-textarea');let active=null,deletions=0,approval=false;
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>active});document.hasFocus=()=>false;Object.defineProperty(editor,'focus',{value:()=>{active=editor;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return 100;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return 30;}});
  window.HTMLElement.prototype.getClientRects=()=>[{}];
  const prototype=Object.getPrototypeOf(document.querySelectorAll('div'));Object.defineProperty(prototype,Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
  const selection={anchorNode:null,removeAllRanges(){this.anchorNode=null;},addRange(range){this.anchorNode=range.node;}};
  window.getSelection=()=>selection;document.createRange=()=>({selectNodeContents(node){this.node=node;}});
  document.execCommand=op=>{assert.equal(op,'delete');assert.equal(selection.anchorNode,editor);deletions++;editor.textContent='';return true;};
  const context=vm.createContext({document,window,location:{href:'https://chatgpt.com/c/original'},Node:window.Node,getComputedStyle:()=>({flexDirection:'column'})});
  const run=(action,arg={})=>vm.runInContext(`(${dom.toString()})(${JSON.stringify(action)},${JSON.stringify(arg)},()=>{},()=>false,()=>({required:${approval}}))`,context);
  const baseline=run('snapshot');
  return {editor,run,baseline,get deletions(){return deletions;},set approval(value){approval=value;},
    clear:extra=>run('connector-clear-query',{expectedConnector:'Local-MCP',expectedText:'@Local-MCP',reconciliationId:'original-operation',
      expectedBaseline:{url:baseline.url,userId:baseline.userId,assistantId:baseline.assistantId},...extra})};
}
test('purpose DOM reconciliation removes exactly its own connector query with original public baseline',()=>{
  const f=fixture();assert.equal(f.clear().cleared,true);assert.equal(f.deletions,1);assert.equal(f.run('editor-text').text,'');
  assert.throws(()=>f.clear(),/query_changed/);assert.equal(f.deletions,1);
});
for(const changed of ['user-draft','different-query','selected-pill','generation','approval','original-user','operation'])
  test('purpose DOM query reconciliation preserves '+changed+' without deleting any composer body',()=>{
    const f=fixture({body:changed==='user-draft'?'my original draft':changed==='different-query'?'@Local-MCP-B':'@Local-MCP',
      busy:changed==='generation',pill:changed==='selected-pill'});
    if(changed==='approval')f.approval=true;
    const args=changed==='original-user'?{expectedBaseline:{url:f.baseline.url,userId:'foreign',assistantId:f.baseline.assistantId}}:
      changed==='operation'?{reconciliationId:null}:{};
    assert.throws(()=>f.clear(args),/send_baseline_changed|query_changed/);assert.equal(f.deletions,0);
  });
