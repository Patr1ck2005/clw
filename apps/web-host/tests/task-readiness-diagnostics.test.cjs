'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {dom}=require('../page-dom.cjs');
const {WebDriver}=require('../web-driver.cjs');
const knownComposer='<form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true"></div><button data-testid="model-switcher-dropdown-button" aria-haspopup="menu"></button></form>';
function fixture(body,{url='https://chatgpt.com/',readyState='complete',title='ChatGPT',width=1024,height=768,focused=false}={}){
  const window=createWindow('<!doctype html><html><head></head><body>'+body+'</body></html>'),document=window.document;
  document.title=title;document.hasFocus=()=>focused;let active=null,selection=null;
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>active});window.getSelection=()=>selection;
  Object.defineProperty(document,'readyState',{configurable:true,value:readyState});
  Object.defineProperty(window,'innerWidth',{configurable:true,value:width});
  Object.defineProperty(window,'innerHeight',{configurable:true,value:height});
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.closest('[data-visible="false"],[hidden]')?0:100;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return this.offsetWidth?30:0;}});
  window.HTMLElement.prototype.getClientRects=function(){return this.offsetWidth?[{}]:[];};
  const prototype=Object.getPrototypeOf(document.querySelectorAll('div'));
  Object.defineProperty(prototype,Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
  const context=vm.createContext({document,window,location:{href:url},Node:window.Node,
    getComputedStyle:e=>({display:e.style.display||'block',visibility:e.style.visibility||'visible',flexDirection:'column'})});
  const run=(action,arg={})=>vm.runInContext(`(${dom.toString()})(${JSON.stringify(action)},${JSON.stringify(arg)},()=>{throw Error('unexpected click');},()=>false,()=>({required:false}))`,context);
  return {document,snapshot:()=>run('snapshot'),run,setFocus:node=>{active=node;},
    setSelection:(anchorNode,focusNode=anchorNode,isCollapsed=true)=>{selection={anchorNode,focusNode,isCollapsed};}};
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('missing homepage composer exposes loading or challenge evidence without guessing a diagnosis',()=>{
  const {snapshot}=fixture('<main><h1>Checking your browser</h1><p>Please wait.</p><p hidden>hidden token</p><nav>unrelated navigation</nav><aside>unrelated history</aside><div data-testid="history-chat">history secret</div><div data-turn-key="old"><div data-user-message-bubble>private transcript</div></div><textarea>private draft</textarea></main><div role="alert">Connection interrupted</div>',
    {readyState:'loading',title:'Just a moment…'});
  const state=snapshot(),readiness=plain(state.readiness);
  assert.equal(state.editor,false);assert.equal(state.controlKnown,false);
  assert.deepEqual(readiness.document,{readyState:'loading',title:'Just a moment…',navigation:{available:false,name:null,finalLocation:'https://chatgpt.com/',type:null,redirectCount:null}});
  assert.deepEqual(readiness.viewport,{width:1024,height:768});
  assert.deepEqual(readiness.knownEditors,{rawCount:0,visibleCount:0});
  assert.deepEqual(readiness.knownControls,{rawCount:0,visibleCount:0});
  assert.equal(readiness.mainText,'Checking your browser Please wait.');
  assert.deepEqual(readiness.dialogs,{visibleCount:1,descriptors:[{role:'alert',text:'Connection interrupted'}]});
  assert.equal('diagnosis' in readiness,false);
  assert.doesNotMatch(JSON.stringify(readiness),/hidden token|unrelated navigation|unrelated history|history secret|private transcript|private draft/);
});

test('healthy composer suppresses MAIN text even on homepage and never includes editor values',()=>{
  const {snapshot}=fixture(knownComposer.replace('contenteditable="true"></div>','contenteditable="true">secret draft</div>')+
    '<main>private transcript <div role="textbox" aria-label="Alternative composer">other draft</div></main>');
  const state=snapshot(),readiness=plain(state.readiness);
  assert.equal(state.editor,true);assert.equal(state.controlKnown,true);assert.equal(state.draft,true);
  assert.deepEqual(readiness.knownEditors,{rawCount:1,visibleCount:1});
  assert.deepEqual(readiness.knownControls,{rawCount:1,visibleCount:1});
  assert.equal(readiness.mainText,undefined);
  assert.doesNotMatch(JSON.stringify(readiness),/secret draft|other draft|private transcript/);
});

test('alternate editable structures are attributes only and do not become a composer fallback',()=>{
  const {snapshot}=fixture('<main><div id="new-composer" role="textbox" contenteditable="plaintext-only" aria-label="Message" data-private="secret" value="secret">editable secret</div><textarea id="new-textarea" placeholder="Message" data-visible="false">hidden draft</textarea><nav><input type="text" aria-label="private history search"></nav><div data-turn-key="old"><div role="textbox" aria-label="private transcript attribute">private text</div></div></main>');
  const state=snapshot(),readiness=plain(state.readiness);
  assert.equal(state.editor,false);assert.equal(state.controlKnown,false);assert.equal(state.draft,false);
  assert.deepEqual(readiness.editableAlternatives,{rawCount:2,visibleCount:1,descriptors:[{tag:'DIV',attributes:
    {id:'new-composer',role:'textbox',contenteditable:'plaintext-only','aria-label':'Message'}}]});
  assert.doesNotMatch(JSON.stringify(readiness),/editable secret|hidden draft|data-private|value|private history search|private transcript attribute|private text/);
});

test('known controls report raw and visible counts while hidden dialogs remain excluded',()=>{
  const {snapshot}=fixture('<div id="prompt-textarea" contenteditable="true" data-visible="false"></div><div contenteditable="true" data-lexical-editor="true"></div><button data-testid="model-switcher-dropdown-button" aria-haspopup="menu" data-visible="false"></button><button aria-haspopup="menu" data-tone="neutral"></button><div role="dialog" hidden>hidden dialog</div><div aria-hidden="true"><div role="alert">hidden parent</div></div><div role="alert" style="visibility:hidden">invisible alert</div><div data-turn-key="old"><div role="alert">private turn alert</div></div>');
  const state=snapshot(),readiness=plain(state.readiness);
  assert.equal(state.editor,true);assert.equal(state.controlKnown,true);
  assert.deepEqual(readiness.knownEditors,{rawCount:2,visibleCount:1});
  assert.deepEqual(readiness.knownControls,{rawCount:2,visibleCount:1});
  assert.deepEqual(readiness.dialogs,{visibleCount:0,descriptors:[]});
});

test('MAIN and dialog excerpts exclude textbox values and ungrouped rendered chat bodies',()=>{
  const {snapshot}=fixture('<main><h1>Loading</h1><div role="textbox" aria-label="Message">private textbox value</div><div class="markdown">private rendered reply</div></main><div role="dialog">Check connection <div role="textbox">private dialog input</div><span data-markdown-text-style="assistant-message">private dialog reply</span></div>');
  const readiness=plain(snapshot().readiness);
  assert.equal(readiness.mainText,'Loading');
  assert.deepEqual(readiness.dialogs.descriptors,[{role:'dialog',text:'Check connection'}]);
  assert.doesNotMatch(JSON.stringify(readiness),/private textbox value|private rendered reply|private dialog input|private dialog reply/);
});

for(const url of ['https://chatgpt.com/c/original','https://chatgpt.com/?temporary=1','https://chatgpt.com/#home','https://chatgpt.com/auth/login'])
  test('MAIN text is absent outside exact homepage: '+url,()=>{
    const {snapshot}=fixture('<main>page body must stay private</main>',{url});
    assert.equal(snapshot().readiness.mainText,undefined);
  });

test('diagnostic strings, collections and viewport remain bounded',()=>{
  const {snapshot}=fixture('<main><h1>'+('M'.repeat(2000))+'</h1></main>'+
    Array.from({length:12},(_,i)=>'<div role="textbox" id="'+i+'" aria-label="'+('A'.repeat(500))+'">draft</div>').join('')+
    Array.from({length:9},()=>'<div role="dialog">'+('D'.repeat(2000))+'</div>').join(''),
    {title:'T'.repeat(500),width:Infinity,height:200000});
  const readiness=plain(snapshot().readiness);
  assert.equal(readiness.document.title.length,160);assert.equal(readiness.mainText.length,480);
  assert.deepEqual(readiness.viewport,{width:null,height:100000});
  assert.equal(readiness.editableAlternatives.rawCount,12);assert.equal(readiness.editableAlternatives.visibleCount,12);
  assert.equal(readiness.editableAlternatives.descriptors.length,6);
  assert.ok(readiness.editableAlternatives.descriptors.every(d=>d.attributes['aria-label'].length===96));
  assert.equal(readiness.dialogs.visibleCount,9);assert.equal(readiness.dialogs.descriptors.length,4);
  assert.ok(readiness.dialogs.descriptors.every(d=>d.text.length===240));
});

test('formal original-task observation forwards readiness and continues to redact body and editor text',async()=>{
  const original={},page={id:'original',account:'A',documentGeneration:2,view:{webContents:original}},calls=[];
  const readiness=plain(fixture('<main>Checking your browser</main>').snapshot().readiness);
  const driver=new WebDriver({pool:{},runtime:new EventEmitter(),dom:async(wc,action)=>{
    assert.equal(wc,original);calls.push(action);
    if(action==='snapshot')return {url:'https://chatgpt.com/',editor:false,controlKnown:false,readiness,
      html:'<p>private reply</p>',publicText:'private reply',userId:'private user',assistantId:'private assistant'};
    assert.equal(action,'connector-state');return {editorCount:0,text:'private draft',selected:[]};
  }});
  const observed=await driver.observeTask(page);
  assert.deepEqual(calls,['snapshot','connector-state']);assert.deepEqual(observed.snapshot.readiness,readiness);
  assert.equal(observed.composer.text,undefined);assert.equal(observed.composer.text_sha256.length,64);
  assert.doesNotMatch(JSON.stringify(observed),/private reply|private user|private assistant|private draft/);
});

test('connector diagnostics report editor focus and selection ownership without values or offsets',()=>{
  const f=fixture(knownComposer.replace('contenteditable="true"></div>','contenteditable="true">private draft</div>'),{focused:true});
  const editor=f.document.getElementById('prompt-textarea');f.setFocus(editor);f.setSelection(editor.firstChild);
  let diagnostic=plain(f.run('connector-state',{expectedConnector:'Local-MCP',diagnostics:true}).queryDiagnostics);
  assert.equal(diagnostic.documentFocused,true);assert.equal(diagnostic.focusInEditor,true);
  assert.equal(diagnostic.selectionAvailable,true);assert.equal(diagnostic.selectionAnchorInEditor,true);
  assert.equal(diagnostic.selectionFocusInEditor,true);assert.equal(diagnostic.selectionCollapsed,true);
  assert.doesNotMatch(JSON.stringify(diagnostic),/private draft|offset|anchorNode|focusNode/);
  f.setFocus(f.document.body);f.setSelection(editor.firstChild,f.document.body,false);
  diagnostic=plain(f.run('connector-state',{diagnostics:true}).queryDiagnostics);
  assert.equal(diagnostic.focusInEditor,false);assert.equal(diagnostic.selectionAnchorInEditor,true);
  assert.equal(diagnostic.selectionFocusInEditor,false);assert.equal(diagnostic.selectionCollapsed,false);
  assert.equal(f.run('connector-state').queryDiagnostics,undefined);
});

test('missing connector menu exposes raw and visible overlays and safe alternative row titles only',()=>{
  const f=fixture(knownComposer+'<div data-composer-overlay-floating-ui hidden><div data-mention-list-scroll-area>hidden title</div></div>'+
    '<div data-composer-overlay-floating-ui id="new-popup"><div data-mention-list-scroll-area><div role="option"><span>Local-MCP</span><span>private description</span></div><div role="option"><span>Other App</span></div><div role="option" hidden>hidden option</div><div role="option"><textarea>private draft</textarea></div><div data-turn-key="old"><div role="option">private conversation</div></div></div></div>'+
    '<nav><div role="menu"><button>private navigation</button></div></nav><div role="menu" style="visibility:hidden"><button>invisible popup</button></div>');
  const state=f.run('connector-state',{expectedConnector:'Local-MCP',diagnostics:true}),diagnostic=plain(state.queryDiagnostics);
  assert.equal(state.menuCount,1);assert.equal(state.exactRows,0);
  assert.deepEqual(diagnostic.composerOverlay,{rawCount:2,visibleCount:1});
  assert.deepEqual(diagnostic.mentionScroll,{rawCount:2,visibleCount:1});
  assert.deepEqual(diagnostic.popupStructures,[{tag:'DIV',scope:'body-overlay',attributes:{id:'new-popup','data-composer-overlay-floating-ui':''},rowTitles:['Local-MCP','Other App']}]);
  assert.doesNotMatch(JSON.stringify(diagnostic),/hidden title|private description|hidden option|private draft|private conversation|private navigation|invisible popup/);
});

test('connector diagnostics bound popup attributes and public titles while retaining scope',()=>{
  const f=fixture(knownComposer.replace('id="prompt-textarea"','id="prompt-textarea" aria-controls="owned-menu"')+
    '<div role="listbox" id="owned-menu"><div role="option">'+('O'.repeat(200))+'</div></div>'+
    '<form><div role="menu"><button>foreign composer</button></div></form>'+
    Array.from({length:9},(_,i)=>'<div role="menu" class="'+('C'.repeat(200))+'"><button>'+i+('T'.repeat(200))+'</button></div>').join(''));
  const diagnostic=plain(f.run('connector-state',{diagnostics:true}).queryDiagnostics);
  assert.equal(diagnostic.popupStructures.length,6);assert.equal(diagnostic.popupStructures[0].scope,'editor-owned');
  assert.equal(diagnostic.popupStructures[0].rowTitles[0].length,80);
  assert.ok(diagnostic.popupStructures.slice(1).every(p=>p.attributes.class.length===80));
  assert.equal(diagnostic.popupStructures.flatMap(p=>p.rowTitles).length,6);
  assert.ok(diagnostic.popupStructures.flatMap(p=>p.rowTitles).every(t=>t.length===80));
  assert.doesNotMatch(JSON.stringify(diagnostic),/foreign composer/);
});

test('formal observation forwards connector query diagnostics through the existing composer envelope',async()=>{
  const f=fixture(knownComposer+'<div role="listbox"><div role="option">Local-MCP</div></div>');
  const wc={},page={id:'original',account:'A',documentGeneration:3,view:{webContents:wc}};
  const driver=new WebDriver({pool:{},runtime:new EventEmitter(),dom:async(original,action,arg)=>{assert.equal(original,wc);return f.run(action,arg);}});
  const observed=await driver.observeTask(page);
  assert.deepEqual(plain(observed.composer.queryDiagnostics.popupStructures[0].rowTitles),['Local-MCP']);
  assert.equal(observed.composer.queryDiagnostics.selectionAvailable,false);
  assert.equal(observed.composer.menuCount,0);assert.equal(observed.composer.exactRows,0);
});

for(const heading of ['无法加载你的账户','Unable to load your account',"Couldn't load your account",'Could not load your account'])
  test('visible exact homepage account-load failure is recognized: '+heading,()=>{
    const label=heading==='无法加载你的账户'?'重新加载':'Reload';
    const f=fixture('<main><h1>'+heading+'</h1><p>Try reloading.</p><button>'+label+'</button><button>退出登录</button></main>');
    assert.equal(f.snapshot().pageLoadFailure,'account_load_failed');
  });

test('account failure title need not use a heading tag when sanitized visible MAIN starts with the exact platform title',()=>{
  const f=fixture('<main><div>无法加载你的账户</div><p>请尝试重新加载，或退出登录后重新登录</p><button>重新加载</button></main>');
  assert.equal(f.snapshot().pageLoadFailure,'account_load_failed');
});

test('account-load failure rejects duplicate visible known editors containing drafts',()=>{
  const f=fixture('<main><h1>无法加载你的账户</h1><button>重新加载</button></main>'+
    '<div data-testid="prompt-textarea" contenteditable="true">first private draft</div>'+
    '<div id="prompt-textarea" contenteditable="true">second private draft</div>');
  const state=f.snapshot();
  assert.equal(state.editor,false);assert.equal(state.draft,false);
  assert.equal(state.readiness.knownEditors.visibleCount,2);
  assert.equal(state.pageLoadFailure,undefined);
});

test('account-load failure rejects a visible alternative textarea containing a draft',()=>{
  const f=fixture('<main><h1>无法加载你的账户</h1><button>重新加载</button></main>'+
    '<textarea id="alternate-composer">private alternate draft</textarea>');
  const state=f.snapshot();
  assert.equal(state.editor,false);assert.equal(state.draft,false);
  assert.equal(state.readiness.knownEditors.visibleCount,0);
  assert.equal(state.readiness.editableAlternatives.visibleCount,1);
  assert.equal(state.pageLoadFailure,undefined);
});

for(const [name,body,options] of [
  ['ordinary loading','<main><h1>Loading your account</h1><button>Reload</button></main>',{}],
  ['quoted error','<main><h1>Discussion of 无法加载你的账户</h1><button>Reload</button></main>',{}],
  ['hidden heading','<main><h1 hidden>无法加载你的账户</h1><button>重新加载</button></main>',{}],
  ['hidden ancestor','<main><section aria-hidden="true"><h1>无法加载你的账户</h1></section><button>重新加载</button></main>',{}],
  ['hidden heading words','<main><h1>无法加载<span hidden>你的账户</span></h1><button>重新加载</button></main>',{}],
  ['hidden reload','<main><h1>无法加载你的账户</h1><button hidden>重新加载</button></main>',{}],
  ['invisible main','<main style="visibility:hidden"><h1>无法加载你的账户</h1><button>重新加载</button></main>',{}],
  ['duplicate reload','<main><h1>无法加载你的账户</h1><button>重新加载</button><button>Reload</button></main>',{}],
  ['reload outside MAIN','<main><h1>无法加载你的账户</h1></main><button>重新加载</button>',{}],
  ['conversation error','<main><div data-turn-key="old"><h1>无法加载你的账户</h1><button>重新加载</button></div></main>',{}],
  ['rendered conversation','<main><div class="markdown"><h1>无法加载你的账户</h1></div><button>重新加载</button></main>',{}],
  ['conversation URL','<main><h1>无法加载你的账户</h1><button>重新加载</button></main>',{url:'https://chatgpt.com/c/original'}],
  ['homepage query','<main><h1>无法加载你的账户</h1><button>重新加载</button></main>',{url:'https://chatgpt.com/?temporary=1'}],
  ['visible editor','<main><h1>无法加载你的账户</h1><button>重新加载</button></main><div id="prompt-textarea" contenteditable="true"></div>',{}],
  ['visible control','<main><h1>无法加载你的账户</h1><button>重新加载</button></main><button data-testid="model-switcher-dropdown-button" aria-haspopup="menu"></button>',{}]
])test('account-load failure is not inferred from '+name,()=>{
  assert.equal(fixture(body,options).snapshot().pageLoadFailure,undefined);
});
