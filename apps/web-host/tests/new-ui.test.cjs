'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {dom}=require('../page-dom.cjs');
const {publicApproval}=require('../public-approval.cjs');

function harness(html){
  const window=createWindow(html);window.document.hasFocus=()=>false;
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.closest('[hidden],[inert]')?0:100;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return this.offsetWidth?30:0;}});
  window.HTMLElement.prototype.getClientRects=function(){return this.offsetWidth?[{}]:[];};
  for(const list of [window.document.querySelectorAll('div'),window.document.body.children])Object.defineProperty(Object.getPrototypeOf(list),Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
  const context=vm.createContext({document:window.document,Node:window.Node,getComputedStyle:e=>({flexDirection:e.style.flexDirection||'column'}),location:{href:'https://chatgpt.com/c/original'}});
  return {window,run:(action,arg={})=>vm.runInContext(`(${dom.toString()})(${JSON.stringify(action)},${JSON.stringify(arg)},()=>{},()=>false,${publicApproval.toString()})`,context)};
}
const composer='<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox"></div><button type="submit" aria-label="发送"></button><button data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" aria-haspopup="menu" aria-controls="picker">极高</button></form>';
function selectedApp(h){const editor=h.window.document.querySelector('[contenteditable]'),pill=h.window.document.createElement('span');pill.setAttribute('app-mention-path','app://original');pill.setAttribute('app-mention-display-name','Local-MCP');pill.setAttribute('contenteditable','false');pill.textContent='Local-MCP';editor.insertBefore(pill,editor.firstChild);return {expectedConnector:'Local-MCP',expectedBaseline:{url:'https://chatgpt.com/c/original',userId:'',assistantId:''}};}
test('a retry button cannot turn a safety or quota refusal into a thinking failure',()=>{
 const panel=text=>composer+'<div data-testid="conversation-turn-2" data-turn="assistant"><div class="text-token-text-error">'+text+'<button>Retry</button></div></div>';
 for(const text of ['This tool call was blocked by OpenAI because we could not determine its safety status.','You have reached your Pro usage limit'])assert.equal(harness(panel(text)).run('snapshot').failure,'');
 for(const text of ['Thinking failed','思考失败','无法思考'])assert.equal(harness(panel(text)).run('snapshot').failure,text);
});
test('quota notices are platform UI, never assistant quotations or hidden dialogs',()=>{
 assert.equal(harness(composer+'<div role="dialog">You have reached your Pro usage limit</div>').run('snapshot').usageLimited,true);
 assert.equal(harness(composer+'<div hidden role="alert">You have reached your Pro usage limit</div>').run('snapshot').usageLimited,false);
 assert.equal(harness(composer+'<div data-message-author-role="assistant"><div role="alert">You have reached your Pro usage limit</div></div>').run('snapshot').usageLimited,false);
 assert.equal(harness(composer+'<div role="dialog">Too many requests</div>').run('snapshot').usageLimited,false);
});

test('public composer readback preserves paragraphs and Send checks the exact draft atomically',()=>{
  const h=harness(composer),editor=h.window.document.querySelector('[contenteditable]');
  editor.innerHTML='<p>CLW 简洁协作 v1。</p><p>B.md</p><p>[CLW:control_'+ 'd'.repeat(32)+']</p>';
  const full=h.run('editor-text').text;
  assert.equal(full,'CLW 简洁协作 v1。\nB.md\n[CLW:control_'+ 'd'.repeat(32)+']');
  let clicks=0;h.window.document.querySelector('button[type="submit"]').addEventListener('click',e=>{clicks++;e.preventDefault();});
  assert.throws(()=>h.run('send',{expectedText:full+'\nmissing'}),/editor_prompt_mismatch/);
  assert.equal(clicks,0);
  assert.equal(Object.keys(h.run('send',{expectedText:full,...selectedApp(h)})).length,0);assert.equal(clicks,1);
  editor.textContent='   ';
  assert.equal(h.run('snapshot').draft,true);
  assert.throws(()=>h.run('focus-editor'),/editor_missing_or_user_draft/);
});
test('legacy textarea draft uses its value for the same Send integrity check',()=>{
  const h=harness('<form><textarea data-testid="prompt-textarea">unsent draft</textarea><button type="submit"></button></form>');
  assert.equal(h.run('snapshot').draft,true);
  assert.equal(h.run('editor-text').text,'unsent draft');
  assert.throws(()=>h.run('focus-editor'),/editor_missing_or_user_draft/);
  assert.throws(()=>h.run('send',{expectedText:'different draft'}),/editor_prompt_mismatch/);
});

test('atomic Send compares a Windows prompt with its LF composer but rejects CR converted to a space',()=>{
  const h=harness(composer),editor=h.window.document.querySelector('[contenteditable]');
  editor.innerHTML='<p>first</p><p>  second</p>';
  let sends=0;h.window.document.querySelector('button[type="submit"]').addEventListener('click',e=>{sends++;e.preventDefault();});
  h.run('send',{expectedText:'first\r\n  second',...selectedApp(h)});assert.equal(sends,1);
  editor.innerHTML='<p>first </p><p>  second</p>';
  assert.throws(()=>h.run('send',{expectedText:'first\r\n  second'}),/editor_prompt_mismatch/);
  assert.equal(sends,1);
});

test('virtualized history follows the latest edge in both scroll directions without Send',()=>{
  for(const reverse of [false,true]){
    const h=harness(composer+'<div class="thread-scroll-container"></div>');
    const e=h.window.document.querySelector('.thread-scroll-container');
    e.style.flexDirection=reverse?'column-reverse':'column';
    Object.defineProperties(e,{clientHeight:{value:800},scrollHeight:{value:42000},scrollTop:{value:reverse?-41200:0,writable:true}});
    e.scrollTo=options=>{assert.equal(options.behavior,'instant');e.scrollTop=reverse?options.top:Math.min(options.top,41200);};
    assert.equal(h.run('snapshot').historyAtLatest,false);
    assert.equal(h.run('snapshot').complete,false);
    assert.equal(h.run('show-latest').moved,true);
    assert.equal(h.run('snapshot').historyAtLatest,true);
    assert.equal(h.run('show-latest').moved,false);
    e.scrollTop=reverse?-41200:0;
    h.window.document.querySelector('[contenteditable]').textContent='unsent draft';
    assert.equal(h.run('show-latest').moved,false);
  }
});

test('driver snapshot recognizes the live attachment card even when keyboard hints adjoin the labels',()=>{
  const h=harness(composer+'<div data-turn-key="u1"><div data-user-message-bubble>Task</div></div><section>Local-MCP-B 允许文件实体化？ ChatGPT需要批准返回的1个文件附件。<button>Deny<kbd>Esc</kbd></button><button>Allow once<kbd>⏎</kbd></button></section>');
  assert.equal(h.run('snapshot').approvalRequired,true);
});

test('explicit Thinking failed is a terminal generation error only on the current turn',()=>{
  const old='<div data-turn-key="old"><div data-user-message-bubble>Earlier work</div><div data-conversation-role="assistant"><div class="text-token-text-error">Thinking failed</div></div></div>';
  const current='<div data-turn-key="current"><div data-user-message-bubble>Current work</div><div data-conversation-role="assistant"><div class="text-token-text-error">Thinking failed</div></div></div>';
  assert.equal(harness(composer+old).run('snapshot').failure,'Thinking failed');
  assert.equal(harness(composer+old+'<div data-turn-key="later"><div data-user-message-bubble>Later user message</div></div>').run('snapshot').failure,'');
  assert.equal(harness(composer+old+current).run('snapshot').failure,'Thinking failed');
  assert.equal(harness(composer+'<div role="alert">Thinking failed</div>').run('snapshot').failure,'Thinking failed');
  const quote='<div data-turn-key="normal"><div data-user-message-bubble>Explain the error</div><div data-conversation-role="assistant"><div class="markdown">Thinking failed was shown earlier.</div></div></div>';
  assert.equal(harness(composer+quote).run('snapshot').failure,'');
});

test('current grouped stream alert is a terminal failure without an assistant unit; old, quoted and hidden alerts are ignored',()=>{
 const turn=(key,body)=>`<div data-content-search-turn-key="${key}"><div data-content-search-unit-key="${key}:0:user"><div data-user-message-bubble>Current request</div></div>${body}</div>`;
 for(const message of ['消息流中的错误','Error in message stream']){
  const alert=`<div><aside role="alert" class="text-danger"><div>${message}</div></aside></div>`;
  const s=harness(composer+turn('current',alert)).run('snapshot');
  assert.equal(s.failure,message);assert.equal(s.complete,false);assert.equal(s.generating,false);
  assert.equal(harness(composer+turn('old',alert)+turn('current','')).run('snapshot').failure,'');
  assert.equal(harness(composer+turn('current',`<div class="markdown">${alert}</div>`)).run('snapshot').failure,'');
  assert.equal(harness(composer+turn('current',alert.replace('role="alert"','role="alert" hidden'))).run('snapshot').failure,'');
  assert.equal(harness(composer+turn('current',alert.replace(message,'OpenAI 无法确定请求的安全状态'))).run('snapshot').failure,'');
 }
});
test('a failed managed current group without assistant reply keeps its own semantic baseline across viewport reload',()=>{
 const marker='[CLW:control_'+'d'.repeat(32)+']';
 const failed=ordinal=>`<div data-content-search-turn-key="fallback-turn-${ordinal}"><div data-content-search-unit-key="fallback-turn-${ordinal}:user"><div data-user-message-bubble>Original task ${marker}</div></div><div class="group/activity-header">无法思考</div></div>`;
 const prior=ordinal=>`<div data-content-search-turn-key="fallback-turn-${ordinal}"><div data-content-search-unit-key="fallback-turn-${ordinal}:assistant"><div data-conversation-role="assistant"><div class="markdown">Earlier reply</div></div></div></div>`;
 const first=harness(composer+prior(1)+failed(2)).run('snapshot'),reloaded=harness(composer+prior(17)+failed(18)).run('snapshot');
 assert.equal(first.assistantId,`managed-public:${marker}:failed-assistant:无法思考`);assert.equal(reloaded.assistantId,first.assistantId);
 assert.equal(reloaded.userId,first.userId);assert.equal(first.complete,false);assert.equal(reloaded.complete,false);
 const quoted=failed(2).replace('class="group/activity-header"','class="markdown group/activity-header"');
 assert.notEqual(harness(composer+prior(1)+quoted).run('snapshot').assistantId,first.assistantId);
 const global=failed(2).replace('<div class="group/activity-header">无法思考</div>','')+'<div role="alert">无法思考</div>';
 assert.notEqual(harness(composer+prior(1)+global).run('snapshot').assistantId,first.assistantId);
});

test('reloaded public turn exposes only one exact trailing attempt marker, not a quoted or duplicate marker',()=>{
  const marker='[CLW:control_'+ 'a'.repeat(32)+']';
  const turn=(id,body)=>`<div data-turn-key="${id}"><div data-user-message-bubble>${body}</div></div>`;
  const valid=harness(composer+turn('new-id','original work '+marker+'…Show more')).run('snapshot');
  assert.equal(valid.attemptMarker,marker);assert.equal(valid.attemptMarkerCount,1);
  assert.equal(harness(composer+turn('quote',marker+' is a quotation')).run('snapshot').attemptMarker,null);
  assert.equal(harness(composer+turn('old',marker)+turn('new',marker)).run('snapshot').attemptMarkerCount,2);
  const grouped=`<div data-content-search-turn-key="fallback-turn-0">
    <div data-content-search-unit-key="fallback-turn-0:0:user"><div data-user-message-bubble>Older ${marker}</div></div>
    <div data-content-search-unit-key="fallback-turn-0:1:user"><div data-user-message-bubble>Newer ${marker}</div></div>
  </div>`;
  assert.equal(harness(composer+grouped).run('snapshot').attemptMarkerCount,2);
  const nested=`<div data-turn-key="legacy-wrapper">${grouped.replace('Older '+marker,'Older work').replace('Newer '+marker,'Newer '+marker+'…显示更多')}</div>`;
  assert.equal(harness(composer+nested).run('snapshot').attemptMarkerCount,1);
});

test('current activity-only thinking failure ignores prose/history and survives a retained generation button',()=>{
 const marker='[CLW:control_'+'a'.repeat(32)+']';
 const turn=(key,body)=>`<div data-content-search-turn-key="${key}"><div data-content-search-unit-key="${key}:0:user"><div data-user-message-bubble>Task ${marker}</div></div>${body}</div>`;
 const header='<div class="group/activity-header"><span>无法思考</span></div>';
 const current=turn('fallback-turn-1',header);
 const snapshot=harness(composer+current).run('snapshot');
 assert.equal(snapshot.failure,'无法思考');assert.equal(snapshot.complete,false);assert.equal(snapshot.attemptMarker,marker);
 assert.equal(harness(composer+current+turn('later','')).run('snapshot').failure,'');
 assert.equal(harness(composer+turn('current','<div class="markdown">'+header+'</div>')).run('snapshot').failure,'');
 assert.equal(harness(composer+turn('current','<div hidden>'+header+'</div>')).run('snapshot').failure,'');
 const retained=harness(composer+current+'<button data-testid="stop-button"></button>').run('snapshot');
 assert.equal(retained.failure,'无法思考');assert.equal(retained.generating,false);assert.equal(retained.rawStopPresent,true);
 assert.equal(harness(composer+turn('current',header.replace('无法思考','OpenAI 无法确定请求的安全状态'))).run('snapshot').failure,'');
 const stopped=header.replace('无法思考','已停止思考');
 const stoppedSnapshot=harness(composer+turn('current',stopped)).run('snapshot');
 assert.equal(stoppedSnapshot.stopped,true);assert.equal(stoppedSnapshot.failure,'');
 assert.equal(harness(composer+turn('old',stopped)+turn('new','')).run('snapshot').stopped,false);
 assert.equal(harness(composer+turn('current','<div class="markdown">'+stopped+'</div>')).run('snapshot').stopped,false);
 assert.equal(harness(composer+turn('current',stopped)+'<button data-testid="stop-button"></button>').run('snapshot').stopped,false);
});

test('captured new grouped response preserves separate role identities and ignores the earlier user footer',()=>{
  const fixture=name=>fs.readFileSync(path.resolve(__dirname,'../../codex-web-bridge/upstream/tests/fixtures',name),'utf8');
  const complete=harness(composer+fixture('chatgpt-power-complete.html')).run('snapshot');
  assert.equal(complete.editor,true);assert.equal(complete.controlKnown,true);assert.equal(complete.complete,true);
  assert.match(complete.userId,/^group:user:/);assert.match(complete.assistantId,/^group:assistant:/);assert.notEqual(complete.userId,complete.assistantId);
  assert.match(complete.userText,/No tools or apps/);assert.doesNotMatch(complete.html,/No tools or apps/);assert.match(complete.html,/STREAM_END_927/);
  const streaming=harness(composer+fixture('chatgpt-power-streaming.html')).run('snapshot');assert.equal(streaming.complete,false);
});

test('content-search fallback group reads the exact current user and completed assistant units',()=>{
  const marker='[CLW:control_'+ 'b'.repeat(32)+']';
  const group=(key,body,answer,actions)=>`<div data-content-search-turn-key="${key}">
    <div data-content-search-unit-key="${key}:0:user"><div data-user-message-bubble>${body}</div>
      <div class="turn-action-controls"><button aria-label="复制消息"></button></div></div>
    <div data-content-search-unit-key="${key}:2:assistant"><div><h4 data-conversation-role="assistant"></h4></div>
      <div data-markdown-text-style="assistant-message">${answer}</div></div>${actions}</div>`;
  const old='<div data-turn-key="older"><div data-user-message-bubble>Older work</div><div data-content-search-unit-key="older:1:assistant"><div data-conversation-role="assistant"></div><div class="markdown">Old answer</div></div><div class="turn-action-controls"><button></button></div></div>';
  const current=group('fallback-turn-0','Current work '+marker,'CURRENT_REPLY','<button aria-label="复制"></button>');
  const s=harness(composer+old+current).run('snapshot');
  assert.equal(s.userId,`managed-public:${marker}:user`);
  assert.equal(s.assistantId,`managed-public:${marker}:assistant`);
  const reloaded=harness(composer+group('fallback-turn-9','Current work '+marker,'CURRENT_REPLY','<button aria-label="复制"></button>')).run('snapshot');
  assert.equal(reloaded.assistantId,s.assistantId);
  assert.equal(reloaded.userId,s.userId);
  const nextMarker='[CLW:control_'+ 'c'.repeat(32)+']';
  const next=harness(composer+group('fallback-turn-0','Next work '+nextMarker,'NEW_REPLY','<button aria-label="复制"></button>')).run('snapshot');
  assert.notEqual(next.assistantId,s.assistantId);
  assert.notEqual(next.userId,s.userId);
  assert.equal(s.complete,true);assert.equal(s.attemptMarker,marker);assert.equal(s.attemptMarkerCount,1);
  assert.match(s.html,/CURRENT_REPLY/);assert.doesNotMatch(s.html,/Current work|Old answer/);
  assert.equal(harness(composer+old+group('fallback-turn-0','Current work','PARTIAL','')).run('snapshot').complete,false);
  const laterUser='<div data-content-search-turn-key="fallback-turn-1"><div data-content-search-unit-key="fallback-turn-1:0:user"><div data-user-message-bubble>Later work</div></div></div>';
  assert.equal(harness(composer+old+current+laterUser).run('snapshot').complete,false);
  assert.doesNotMatch(harness(composer+old+current+laterUser).run('snapshot').assistantId,/managed-public/);
  assert.doesNotMatch(harness(composer+current+current).run('snapshot').assistantId,/managed-public/);
  assert.doesNotMatch(harness(composer+current+current).run('snapshot').userId,/managed-public/);
});

test('new UI only submits the verified composer form; search and duplicate editors never qualify',()=>{
  const state=harness('<form><textarea id="pending-home-input"></textarea><button type="submit"></button></form>'+composer);
  let clicks=0;state.window.document.querySelector('form[data-chatgpt-composer] button[type=submit]').addEventListener('click',e=>{clicks++;e.preventDefault();});
  state.window.document.querySelector('form:not([data-chatgpt-composer]) button').addEventListener('click',()=>assert.fail('submitted a different form'));
  state.window.document.querySelector('[contenteditable]').textContent='verified work';
  state.run('send',{expectedText:'verified work',...selectedApp(state)});assert.equal(clicks,1);
  const pending=harness('<textarea id="pending-home-input"></textarea>');assert.equal(pending.run('snapshot').editor,false);
  const ambiguous=harness(composer+composer);assert.equal(ambiguous.run('snapshot').editor,false);assert.throws(()=>ambiguous.run('send',{expectedText:'verified work'}),/editor_missing/);
});

test('new power model picker reads exact public model and effort without treating omitted old attributes as locked',()=>{
  const ticks=Array.from({length:5},(_,i)=>`<span data-selected="${i<=3}"></span>`).join('');
  const picker='<div role="menu" id="picker"><div role="menuitemradio" aria-checked="true"><span class="truncate">最新</span></div><span id="announcement">5.6 极高，第 4 项，共 5 项。</span><div role="menuitem" aria-describedby="announcement"><div data-model-picker-power-slider><span data-orientation="horizontal" aria-disabled="false">'+ticks+'<span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="3"></span></span></div></div></div>';
  const result=harness(composer+picker).run('model');assert.equal(result.model,'GPT-5.6 · 最新');assert.equal(result.effort,'极高');assert.equal(result.efforts.length,5);assert.ok(result.efforts.every(e=>e.available));
});
