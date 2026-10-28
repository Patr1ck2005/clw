'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {dom}=require('../page-dom.cjs'),{WebDriver}=require('../web-driver.cjs');
const marker='[CLW:control_'+'7'.repeat(32)+']';
const composer='<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox">private composer secret</div>'+
  '<button data-testid="send-button" type="submit">Send</button><button data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" aria-haspopup="menu">Pro</button></form>';
const group=(body,user='Current private request '+marker)=>'<div data-content-search-turn-key="fallback-turn-1"><div data-content-search-unit-key="fallback-turn-1:0:user"><div data-user-message-bubble>'+user+'</div></div>'+body+'</div>';
function fixture(body){
  const window=createWindow('<!doctype html><html><body>'+composer+body+'</body></html>');window.document.hasFocus=()=>false;
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.closest('[hidden],[inert],[aria-hidden="true"]')?0:100;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return this.offsetWidth?30:0;}});
  window.HTMLElement.prototype.getClientRects=function(){return this.offsetWidth?[{}]:[];};
  for(const list of [window.document.querySelectorAll('div'),window.document.body.children])
    Object.defineProperty(Object.getPrototypeOf(list),Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
  const context=vm.createContext({document:window.document,Node:window.Node,location:{href:'https://chatgpt.com/c/original'},
    getComputedStyle:e=>({flexDirection:'column',display:e.style.display||'block',visibility:e.style.visibility||'visible'})});
  const run=()=>JSON.parse(JSON.stringify(vm.runInContext(`(${dom.toString()})('snapshot',{},()=>{throw Error('no input allowed')},()=>false,()=>({required:false}))`,context)));
  return {window,run};
}
const diagnostic=body=>fixture(body).run().readiness.failureDiagnostics;

test('structural diagnostics expose fixed codes for missed authored paragraph without declaring a failure',()=>{
  const f=fixture(group('<div data-content-search-unit-key="fallback-turn-1:1:assistant"><div data-conversation-role="assistant"><p class="unknown-platform-class text-token-text-error">无法思考</p></div></div>'));
  const state=f.run(),d=state.readiness.failureDiagnostics;
  assert.equal(d.eligible,true);assert.equal(d.nodes.length,1);const node=d.nodes[0];
  assert.equal(node.labelCode,'thinking_unavailable_zh');assert.equal(node.tag,'P');assert.equal(node.role,null);
  assert.deepEqual(node.classTokens,['text-token-text-error']);assert.equal(node.publicGroup,'current_user');
  assert.equal(node.latestGroup,true);assert.equal(node.ownedAssistant,true);assert.equal(node.authorContainer,true);
  assert.equal(node.relationToCurrentUser,'after');assert.ok(node.exclusions.includes('author_container'));
  assert.equal(node.ancestors[0].conversationRole,'assistant');
  assert.doesNotMatch(JSON.stringify(d),/private composer secret|Current private request|unknown-platform-class|\[CLW:|无法思考/);
  // Diagnostics have no authority: this existing explicit error class still
  // follows its original parser path, while a class-free P remains unrecognized.
  assert.equal(state.failure,'无法思考');
  const missed=fixture(group('<div data-content-search-unit-key="fallback-turn-1:1:assistant"><div data-conversation-role="assistant"><p>无法思考</p></div></div>')).run();
  assert.equal(missed.failure,'');assert.equal(missed.complete,false);assert.equal(missed.readiness.failureDiagnostics.nodes[0].tag,'P');
});
test('diagnostic candidates include excluded prose, controls, foreign turns and unwrapped labels after the current user',()=>{
  const body=group('<div class="markdown"><p>无法思考</p></div><button>Thinking failed</button><div data-content-search-turn-key="foreign"><p>消息流中的错误</p></div>')+
    '<section><strong role="status">我们的系统正在进一步处理此请求</strong></section>';
  const state=fixture(body).run(),nodes=state.readiness.failureDiagnostics.nodes;
  assert.equal(state.failure,'');assert.equal(nodes.length,4);
  assert.deepEqual(nodes.map(node=>node.labelCode),['thinking_unavailable_zh','thinking_failed_en','stream_error_zh','processing_request_zh']);
  assert.ok(nodes[0].exclusions.includes('prose'));assert.equal(nodes[0].ownedPlatform,false);
  assert.ok(nodes[1].exclusions.includes('interactive_control'));assert.equal(nodes[1].control,true);
  assert.equal(nodes[2].publicGroup,'foreign');assert.ok(nodes[2].exclusions.includes('outside_current_public_turn'));
  assert.equal(nodes[3].publicGroup,'none');assert.equal(nodes[3].role,'status');assert.ok(nodes[3].exclusions.includes('outside_current_public_turn'));
});
test('fixed known labels in hidden nodes are diagnosed as hidden without becoming current failures',()=>{
  const state=fixture(group('<div hidden><p>无法思考</p></div><span style="visibility:hidden">Thinking</span>')).run();
  assert.equal(state.failure,'');assert.equal(state.readiness.failureDiagnostics.nodes.length,2);
  assert.ok(state.readiness.failureDiagnostics.nodes.every(node=>!node.visible&&node.exclusions.includes('not_visible')));
});
test('ordinary transcript, substring mentions, input values and pre-user labels are never included',()=>{
  const f=fixture('<p>无法思考</p>'+group('<p>private answer secret</p><p>Earlier 无法思考 was quoted.</p>'+
    '<textarea>无法思考</textarea><div contenteditable="true">Thinking failed</div><input value="消息流中的错误">'));
  const d=f.run().readiness.failureDiagnostics;assert.equal(d.nodes.length,0);
  assert.doesNotMatch(JSON.stringify(d),/private answer secret|Earlier|无法思考|Thinking failed|消息流中的错误/);
});
test('diagnostics require the exact unique current managed marker and never expose labels for unmatched turns',()=>{
  for(const body of [group('<p>无法思考</p>','Unmanaged task'),group('<p>无法思考</p>',marker+' was quoted'),
    group('<p>无法思考</p>',marker+' '+marker),
    '<div data-turn-key="old"><div data-user-message-bubble>Old '+marker+'</div></div>'+group('<p>无法思考</p>')]){
    const d=diagnostic(body);assert.equal(d.eligible,false);assert.deepEqual(d.nodes,[]);assert.equal(d.scannedElements,0);
  }
});
test('diagnostic node count, ancestors, text probes and class/role values are bounded',()=>{
  const deep='<div class="'+('secret-class-'.repeat(100))+'" role="'+('secret-role'.repeat(100))+'">'.repeat(1);
  const wrappers=Array.from({length:18},()=>deep).join('');
  const nodes=Array.from({length:20},(_,index)=>'<article><p class="text-token-text-error markdown '+('X'.repeat(1000))+'" role="'+('Y'.repeat(1000))+'">'+(index%2?'Thinking failed':'无法思考')+'</p></article>').join('');
  const d=diagnostic(group(wrappers+nodes+'</div>'.repeat(18)));
  assert.equal(d.nodes.length,12);assert.equal(d.nodesTruncated,true);assert.ok(d.nodes.every(node=>node.ancestors.length===12&&node.ancestorsTruncated));
  assert.ok(d.nodes.every(node=>node.role==='other'&&node.classTokens.length<=8&&node.tag.length<=32));
  assert.ok(d.scannedElements<=4096);assert.doesNotMatch(JSON.stringify(d),/secret-class|secret-role|X{20}|Y{20}/);
  const huge=diagnostic(group('<p>'+('private long text'.repeat(2000))+'</p><p>无法思考</p>'));
  assert.equal(huge.nodes.length,1);assert.equal(huge.nodes[0].labelCode,'thinking_unavailable_zh');
});
test('a wrapper stack yields the exact deepest label and retains semantic ancestors',()=>{
  const d=diagnostic(group('<section role="alert"><div><div><span>消息流中的错误</span></div></div></section>'));
  assert.equal(d.nodes.length,1);assert.equal(d.nodes[0].tag,'SPAN');assert.equal(d.nodes[0].labelCode,'stream_error_zh');
  assert.equal(d.nodes[0].ancestors[2].role,'alert');
});
test('large post-user structures terminate at the diagnostic scan bound and disclose truncation',()=>{
  const d=diagnostic(group('<b>ordinary private text</b>'.repeat(4200)+'<p>无法思考</p>'));
  assert.equal(d.scannedElements,4096);assert.equal(d.scanTruncated,true);assert.deepEqual(d.nodes,[]);
  assert.doesNotMatch(JSON.stringify(d),/ordinary private text|无法思考/);
});
test('diagnostic traversal starts at current user and never visits large earlier history',()=>{
  const prior='<div data-turn-key="old"><div data-user-message-bubble>Earlier ordinary request</div>'+'<p>earlier private text</p>'.repeat(5000)+'</div>';
  const f=fixture(prior+group('<p>无法思考</p>')),create=f.window.document.createTreeWalker.bind(f.window.document);let visits=0;
  Object.defineProperty(f.window.document,'createTreeWalker',{configurable:true,value:(...args)=>{
    const walker=create(...args),next=walker.nextNode.bind(walker);
    Object.defineProperty(walker,'nextNode',{configurable:true,value:()=>{const node=next();if(node){visits++;assert.equal(node.closest('[data-turn-key="old"]'),null);}return node;}});
    return walker;
  }});
  const d=f.run().readiness.failureDiagnostics;assert.equal(d.nodes.length,1);assert.ok(visits<20);
  assert.equal(d.scanTruncated,false);assert.ok(d.scannedElements<20);
});
test('wide-container text probes check total stack capacity before indexing childNodes',()=>{
  const f=fixture(group('<p id="wide">无法思考</p>'));
  const wide=f.window.document.getElementById('wide'),nodes=wide.childNodes;
  Object.defineProperty(wide,'childNodes',{configurable:true,get:()=>new Proxy(nodes,{get(target,key){
    if(key==='length')return 500000;
    if(typeof key==='string'&&/^\d+$/.test(key))throw Error('diagnostic_wide_child_indexed');
    return Reflect.get(target,key);
  }})});
  const d=f.run().readiness.failureDiagnostics;assert.deepEqual(d.nodes,[]);assert.ok(d.scannedElements<20);
});
test('next-user relationship is discovered inside the same bounded walk without a global user array',()=>{
  // The role-only bubble is deliberately outside recognized public turn
  // wrappers, making it a structural next-user marker for diagnostics only.
  const f=fixture(group('<p>无法思考</p>')+'<div data-message-author-role="user">next private request <span>Thinking failed</span></div><section>思考中</section>');
  const query=f.window.document.querySelectorAll.bind(f.window.document);
  Object.defineProperty(f.window.document,'querySelectorAll',{configurable:true,value:selector=>{assert.notEqual(selector,'[data-user-message-bubble],[data-message-author-role="user"]');return query(selector);}});
  const d=f.run().readiness.failureDiagnostics;
  assert.equal(d.nextUserObserved,true);assert.deepEqual(d.nodes.map(node=>node.relationToNextUser),['before','inside','after']);
  assert.doesNotMatch(JSON.stringify(d),/next private request/);
});
test('existing loaded observeTask whitelist forwards diagnostics through readiness with zero Host or input calls',async()=>{
  const f=fixture(group('<div data-conversation-role="assistant"><p>无法思考</p></div>')),state=f.run(),calls=[];
  const runtime=new EventEmitter();runtime.call=()=>assert.fail('diagnostics do not call Host');
  const driver=new WebDriver({runtime,pool:{},dom:async(_wc,action)=>{calls.push(action);if(action==='snapshot')return state;return {text:'private composer secret',editorCount:1};}});
  const page={id:'original',account:'A',documentGeneration:3,view:{webContents:{isDestroyed:()=>false}}};
  const observation=await driver.observeTask(page);assert.deepEqual(calls,['snapshot','connector-state']);
  assert.deepEqual(observation.snapshot.readiness.failureDiagnostics,state.readiness.failureDiagnostics);
  assert.equal(observation.snapshot.failure,'');assert.doesNotMatch(JSON.stringify(observation),/private composer secret|Current private request/);
});
