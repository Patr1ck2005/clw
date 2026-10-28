'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {dom}=require('../page-dom.cjs'),{WebDriver}=require('../web-driver.cjs');
const composer='<form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true"></div><button data-testid="model-switcher-dropdown-button" aria-haspopup="menu"></button></form>';
function fixture(body,url='https://chatgpt.com/c/original'){
  const window=createWindow('<!doctype html><html><body>'+body+composer+'</body></html>'),document=window.document;
  document.hasFocus=()=>false;
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.closest('[hidden]')?0:100;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return this.offsetWidth?30:0;}});
  window.HTMLElement.prototype.getClientRects=function(){return this.offsetWidth?[{}]:[];};
  const prototype=Object.getPrototypeOf(document.querySelectorAll('div'));
  Object.defineProperty(prototype,Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
  const context=vm.createContext({document,window,location:{href:url},Node:window.Node,
    getComputedStyle:e=>({display:e.style.display||'block',visibility:e.style.visibility||'visible',flexDirection:'column'})});
  return {document,window,run:()=>vm.runInContext(`(${dom.toString()})('snapshot',{},()=>{throw Error('unexpected input');},()=>false,()=>({required:false}))`,context)};
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('read-only public NavigationTiming separates the loaded entry from a later homepage location',()=>{
  const f=fixture('<main>Private request</main>','https://chatgpt.com/');
  Object.defineProperty(f.window,'performance',{value:{getEntriesByType(type){assert.equal(type,'navigation');
    return [{name:'https://chatgpt.com/c/original',type:'navigate',redirectCount:0,privateBody:'Private navigation body'}];}}});
  const s=f.run(),n=plain(s.readiness.document.navigation);
  assert.deepEqual(n,{available:true,name:'https://chatgpt.com/c/original',finalLocation:'https://chatgpt.com/',type:'navigate',redirectCount:0});
  assert.equal(s.userId,'');assert.equal(s.attemptMarker,null);assert.equal(s.readiness.turnStructure.eligible,false);
  assert.doesNotMatch(JSON.stringify(n),/Private request|Private navigation body/);
});

test('public navigation metadata omits private, malformed and unbounded entry fields',()=>{
  for(const name of ['https://chatgpt.com/c/original?private-token','https://chatgpt.com/c/original#private-token',
    'https://auth.openai.com/private-token','https://other.invalid/c/private-token','https://chatgpt.com/c/'+'x'.repeat(300)]){
    const f=fixture('<main>Private text</main>');
    Object.defineProperty(f.window,'performance',{value:{getEntriesByType(){return [{name,type:'private-type',redirectCount:101}];}}});
    const n=plain(f.run().readiness.document.navigation);
    assert.deepEqual(n,{available:true,name:null,finalLocation:'https://chatgpt.com/c/original',type:null,redirectCount:null});
    assert.doesNotMatch(JSON.stringify(n),/private-token|private-type/);
  }
});

test('missing or failed NavigationTiming preserves readiness and original receipt decisions',()=>{
  for(const read of [()=>[],()=>{throw Error('Private navigation error');}]){
    const f=fixture('<main><article data-testid="conversation-turn-1" data-turn="user" data-turn-id="original">Original request</article></main>');
    Object.defineProperty(f.window,'performance',{value:{getEntriesByType:read}});
    const s=f.run(),n=plain(s.readiness.document.navigation);
    assert.deepEqual(n,{available:false,name:null,finalLocation:'https://chatgpt.com/c/original',type:null,redirectCount:null});
    assert.equal(s.userId,'original');assert.equal(s.editor,true);assert.equal(s.attemptMarker,null);
    assert.doesNotMatch(JSON.stringify(n),/Private navigation error/);
  }
});

test('missing identity exposes bare author structure and parent attribute names without values or transcript',()=>{
  const f=fixture('<main data-layout-key="private layout"><section data-new-turn="private turn" id="private-id">'+
    '<div data-message-author-role="user" data-message-id="private-user">Private request</div>'+
    '<div data-conversation-role="assistant" data-private-value="private-token">Private reply</div></section></main>');
  const s=f.run(),d=plain(s.readiness.turnStructure);
  assert.equal(s.userId,'');assert.equal(s.assistantId,'');assert.equal(s.attemptMarker,null);
  assert.equal(d.eligible,true);assert.equal(d.scope,'main');assert.deepEqual(d.recognized,{users:0,assistants:0});
  assert.deepEqual(d.counts.messageAuthor,{raw:1,visible:1});assert.deepEqual(d.counts.conversationRole,{raw:1,visible:1});
  assert.deepEqual(d.nodes.map(n=>[n.tag,n.messageAuthorRole,n.conversationRole]),[['DIV','user',null],['DIV',null,'assistant']]);
  assert.ok(d.nodes[0].ancestors[0].attributes.includes('data-new-turn'));
  assert.ok(d.nodes[1].attributes.includes('data-private-value'));
  assert.doesNotMatch(JSON.stringify(d),/private layout|private turn|private-id|private-user|private-token|Private request|Private reply/);
});

test('a search group with unmatched unit roles is diagnosed without admitting it as a public turn',()=>{
  const s=fixture('<main><div data-content-search-turn-key="private-key">'+
    '<div data-content-search-unit-key="different-key:user"><div data-user-message-bubble>Private request</div></div>'+
    '<div data-content-search-unit-key="different-key:assistant"><div data-conversation-role="assistant">Private reply</div></div></div></main>').run();
  const d=plain(s.readiness.turnStructure);assert.equal(s.userId,'');assert.equal(s.attemptMarkerCount,0);
  assert.deepEqual(d.recognized,{users:0,assistants:0});assert.equal(d.counts.searchTurnKey.raw,1);assert.equal(d.counts.searchUnitKey.raw,2);
  assert.deepEqual(d.nodes.filter(n=>n.matches.includes('searchUnitKey')).map(n=>n.unitRole),['user','assistant']);
  assert.doesNotMatch(JSON.stringify(d),/private-key|different-key|Private request|Private reply/);
});

test('known identity and exact homepage skip diagnostic traversal',()=>{
  for(const [body,url] of [['<main><article data-testid="conversation-turn-1" data-turn="user" data-turn-id="known">Private request</article></main>','https://chatgpt.com/c/original'],
    ['<main><div data-message-author-role="user">Private request</div></main>','https://chatgpt.com/']]){
    const d=plain(fixture(body,url).run().readiness.turnStructure);assert.equal(d.eligible,false);assert.equal(d.scannedElements,0);assert.deepEqual(d.nodes,[]);
  }
});

test('diagnostics bound nodes, ancestry and scan work while excluding composer and navigation',()=>{
  const body='<main><nav><div data-message-author-role="user">Navigation secret</div></nav><form><div data-conversation-role="assistant">Editor secret</div></form>'+
    '<section>'.repeat(12)+Array.from({length:20},(_,i)=>'<div data-content-search-unit-key="secret-'+i+':user" data-message-author-role="other-private-role">Secret body</div>').join('')+'</section>'.repeat(12)+
    '<i>Large private text</i>'.repeat(4200)+'</main>';
  const d=plain(fixture(body).run().readiness.turnStructure);
  assert.equal(d.scannedElements,4096);assert.equal(d.scanTruncated,true);assert.equal(d.nodes.length,8);assert.equal(d.nodesTruncated,true);
  assert.equal(d.counts.messageAuthor.raw,20);assert.equal(d.counts.conversationRole.raw,0);
  assert.ok(d.nodes.every(n=>n.ancestors.length===8&&n.ancestorsTruncated&&n.messageAuthorRole==='other'));
  assert.doesNotMatch(JSON.stringify(d),/secret-[0-9]|other-private-role|Secret body|Large private text|Navigation secret|Editor secret/);
});

test('formal original observation forwards structure without Host calls or input operations',async()=>{
  const s=fixture('<main><div data-message-author-role="user">Private request</div></main>').run(),calls=[];
  const runtime=new EventEmitter();runtime.call=()=>assert.fail('readonly observation must not call Host');
  const driver=new WebDriver({runtime,pool:{},dom:async(_wc,action)=>{calls.push(action);return action==='snapshot'?s:{text:'Private draft',editorCount:1};}});
  const observation=await driver.observeTask({id:'original',account:'A',documentGeneration:2,view:{webContents:{isDestroyed:()=>false}}});
  assert.deepEqual(calls,['snapshot','connector-state']);assert.deepEqual(observation.snapshot.readiness.turnStructure,s.readiness.turnStructure);
  assert.doesNotMatch(JSON.stringify(observation),/Private request|Private draft/);
});
