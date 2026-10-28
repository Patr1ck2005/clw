'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {dom}=require('../page-dom.cjs');

const marker='[CLW:control_683c4994d6394c97abea76eb53969a7e]';
const otherMarker='[CLW:control_'+'a'.repeat(32)+']';
const composer=(stop=true)=>'<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox"></div>'+
  '<button data-testid="send-button" type="submit"></button>'+(stop?'<button data-testid="stop-button"></button>':'')+
  '<button data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" aria-haspopup="menu">Pro</button></form>';
const group=(key,body,{user='Current task '+marker,answer=''}={})=>`<div data-content-search-turn-key="${key}">
  <div data-content-search-unit-key="${key}:0:user"><div data-user-message-bubble>${user}</div></div>${body}${answer}</div>`;
const failed='<div class="group/activity-header"><span>无法思考</span></div>';
const disconnected='<aside role="alert"><span>连接已中断，正在等待完整答复</span></aside>';
const processing='<aside role="alert"><span>我们的系统正在进一步处理此请求</span></aside>';

function harness(html){
  const window=createWindow(html);window.document.hasFocus=()=>false;
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.closest('[hidden],[inert],[aria-hidden="true"]')?0:100;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return this.offsetWidth?30:0;}});
  window.HTMLElement.prototype.getClientRects=function(){return this.offsetWidth?[{}]:[];};
  for(const list of [window.document.querySelectorAll('div'),window.document.body.children])Object.defineProperty(Object.getPrototypeOf(list),Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
  const context=vm.createContext({document:window.document,Node:window.Node,getComputedStyle:e=>({flexDirection:'column',display:e.style.display||'block',visibility:e.style.visibility||'visible'}),
    location:{href:'https://chatgpt.com/c/original'}});
  let sends=0;window.document.querySelector('button[type="submit"]')?.addEventListener('click',e=>{sends++;e.preventDefault();});
  const run=(action='snapshot',arg={})=>JSON.parse(JSON.stringify(vm.runInContext(`(${dom.toString()})(${JSON.stringify(action)},${JSON.stringify(arg)},()=>{},()=>false,()=>({required:false}))`,context)));
  return {window,run,sends:()=>sends};
}

test('public process projects bounded visible current activity without affecting completion or failures',()=>{
 const current='<div class="group/activity-header"><span>梳理当前进展</span><div data-reasoning-summary>公开摘要</div><div hidden>hidden reasoning</div></div>';
 const snapshot=harness(composer(true)+group('old','<div class="group/activity-header">旧任务</div>')+
  group('current',current+'<div class="markdown"><div class="group/activity-header">quoted title</div></div>')).run();
 assert.equal(snapshot.generating,true);assert.equal(snapshot.failure,'');
 assert.equal(snapshot.publicProcess.scope,'current_user_turn');assert.equal(snapshot.publicProcess.userId,snapshot.userId);
 assert.equal(snapshot.publicProcess.activities.length,1);assert.equal(snapshot.publicProcess.activities[0].summary,'公开摘要');
 assert.doesNotMatch(snapshot.publicProcess.activities[0].title,/旧任务|hidden|quoted/);
 const many=Array.from({length:20},(_,i)=>'<div class="group/activity-header">Task '+i+'</div>').join('');
 const bounded=harness(composer(true)+group('current',many)).run().publicProcess;
 assert.equal(bounded.activities.length,12);assert.equal(bounded.truncated,true);assert.equal(bounded.activities[0].title,'Task 8');
});

test('explicit current public alerts keep their unmanaged contract and chronological phase ordering',()=>{
  for(const message of ['消息流中的错误','Error in message stream','无法思考']){
    const alert=`<aside role="alert"><span>${message}</span></aside>`;
    const turn=body=>group('current',body,{user:'Ordinary unmanaged current request'});
    const failed=harness(composer(false)+turn(alert)).run();
    assert.equal(failed.failure,message);assert.equal(failed.complete,false);assert.equal(failed.generating,false);
    assert.equal(failed.attemptMarker,null);assert.equal(failed.attemptMarkerCount,0);
    for(const active of ['<div class="group/activity-header">思考中</div>','<aside role="alert">Thinking</aside>']){
      const resumed=harness(composer(false)+turn(alert+active+disconnected+processing)).run();
      assert.equal(resumed.failure,'');assert.equal(resumed.complete,false);
      assert.equal(harness(composer(false)+turn(active+alert)).run().failure,message);
    }
    const physical=harness(composer(true)+turn(alert)).run();
    assert.equal(physical.failure,'');assert.equal(physical.generating,true);
    // An explicit platform alert is distinct from a class-free title fallback.
    // Ambiguous managed text still cannot override a physical generation Stop.
    for(const user of [marker+' is quoted',marker+' '+marker]){
      assert.equal(harness(composer(false)+group('current',alert,{user})).run().failure,message);
      const busy=harness(composer(true)+group('current',alert,{user})).run();
      assert.equal(busy.failure,'');assert.equal(busy.generating,true);
    }
    for(const body of [
      group('old',alert,{user:'Earlier unmanaged request'})+turn(''),
      turn('<div class="markdown">'+alert+'</div>'),turn('<div data-message-author-role="assistant">'+alert+'</div>'),
      turn('<div hidden>'+alert+'</div>'),turn('<div data-content-search-turn-key="foreign">'+alert+'</div>'),
      turn('<div data-content-search-unit-key="foreign:1:assistant">'+alert+'</div>'),
      turn('<div data-content-search-unit-key="current:1:tool">'+alert+'</div>'),
      turn('<div data-content-search-unit-key="current:1:assistant">'+alert+'</div><div data-content-search-unit-key="current:2:assistant"></div>')
    ])assert.equal(harness(composer(false)+body).run().failure,'',body);
  }
  for(const body of ['<div>无法思考</div>','<span>无法思考</span>','<h3>无法思考</h3>','<div role="status">无法思考</div>'])
    assert.equal(harness(composer(false)+group('current',body,{user:'Unmanaged request'})).run().failure,'');
});

test('current unique managed thinking failure takes precedence over a retained Stop with separate waiting evidence',()=>{
  const h=harness(composer()+group('fallback-turn-1',failed+disconnected+processing)),s=h.run();
  assert.equal(s.failure,'无法思考');assert.equal(s.generating,false);assert.equal(s.complete,false);
  assert.equal(s.rawStopPresent,true);assert.equal(s.streamInterrupted,true);assert.equal(s.processingNotice,true);
  assert.equal(s.attemptMarker,marker);assert.equal(s.attemptMarkerCount,1);
  assert.equal(s.assistantId,`managed-public:${marker}:failed-assistant:无法思考`);assert.equal(h.sends(),0);
});

test('an exact visible failed title remains identifiable inside a compound platform activity header',()=>{
  const activity='<div class="group/activity-header"><span>无法思考</span><span>连接已中断，正在等待完整答复</span><span>我们的系统正在进一步处理此请求</span></div>';
  const s=harness(composer()+group('fallback-turn-1',activity)).run();
  assert.equal(s.failure,'无法思考');assert.equal(s.generating,false);assert.equal(s.streamInterrupted,true);assert.equal(s.processingNotice,true);
  assert.equal(harness(composer()+group('fallback-turn-9',activity)).run().assistantId,s.assistantId);
});

test('disconnected waiting and further processing alone preserve active generation without time-based failure',()=>{
  for(const body of [disconnected,processing,disconnected+processing,'<div class="group/activity-header">思考中，已持续 123 分钟</div>']){
    const h=harness(composer()+group('fallback-turn-1',body)),s=h.run();
    assert.equal(s.failure,'');assert.equal(s.generating,true);assert.equal(s.rawStopPresent,true);assert.equal(s.complete,false);assert.equal(h.sends(),0);
  }
});

test('historical, quoted, hidden and nested foreign failures cannot override the current generation',()=>{
  const cases=[
    group('old',failed,{user:'Earlier task '+otherMarker})+group('current',disconnected+processing),
    group('current','<div class="markdown">'+failed+disconnected+processing+'</div>'),
    group('current','<div data-markdown-text-style="assistant-message">'+failed+'</div>'),
    group('current','<div hidden>'+failed+'</div>'),
    group('current','<div style="display:none">'+failed+'</div>'),
    group('current','<div aria-hidden="true">'+failed+'</div>'),
    group('current','<div data-content-search-turn-key="foreign">'+failed+'</div>'),
    group('current','<div class="group/activity-header"><div class="markdown">无法思考</div></div>'),
    group('current','<div class="group/activity-header"><span hidden>无法思考</span></div>'),
    group('current','<aside role="alert"><span style="display:none">无法思考</span></aside>'),
    group('current','<aside role="alert"><div data-turn-key="foreign">无法思考</div></aside>'),
    group('current','')+'<div role="alert">无法思考</div>'
  ];
  for(const body of cases){const s=harness(composer()+body).run();assert.equal(s.failure,'',body);assert.equal(s.generating,true,body);}
});

test('an ambiguous or quoted attempt marker cannot reinterpret a Stop as a retained failure control',()=>{
  for(const body of [
    group('current',failed,{user:'Unmarked current work'}),
    group('current',failed,{user:marker+' was quoted here'}),
    group('old','',{user:'Earlier '+marker})+group('current',failed),
    group('current',failed,{user:'Current '+marker+' '+marker})
  ]){const s=harness(composer()+body).run();assert.equal(s.generating,true);assert.equal(s.failure,'');}
});

test('a later active platform header in the same unique managed group supersedes an earlier thinking failure',()=>{
  const thinking='<div class="group/activity-header"><span>思考中</span></div>';
  for(const body of [thinking,failed+thinking,failed+thinking+disconnected+processing]){
    const s=harness(composer()+group('fallback-turn-1',body)).run();
    assert.equal(s.failure,'');assert.equal(s.generating,true);assert.equal(s.rawStopPresent,true);assert.equal(s.complete,false);
  }
  const latestFailed=harness(composer()+group('fallback-turn-1',thinking+failed+disconnected+processing)).run();
  assert.equal(latestFailed.failure,'无法思考');assert.equal(latestFailed.generating,false);assert.equal(latestFailed.rawStopPresent,true);
});

test('older assistant units and platform-looking text inside the user unit do not own the current failure',()=>{
  const oldAssistant='<div data-content-search-unit-key="current:1:assistant"><div data-conversation-role="assistant"></div>'+failed+'<div class="text-token-text-error">无法思考</div></div>';
  const newAssistant='<div data-content-search-unit-key="current:2:assistant"><div data-conversation-role="assistant"></div><div class="group/activity-header">思考中</div></div>';
  const body=group('current',oldAssistant+newAssistant),s=harness(composer()+body).run();
  assert.equal(s.failure,'');assert.equal(s.generating,true);
  const userOwned=`<div data-content-search-turn-key="current"><div data-content-search-unit-key="current:0:user"><div data-user-message-bubble>Task ${marker}</div>${failed}</div></div>`;
  assert.equal(harness(composer()+userOwned).run().failure,'');
});

test('current assistant error and platform activity failures both prevent a completed partial answer',()=>{
  for(const message of ['Thinking failed','无法思考','Error in message stream','消息流中的错误']){
    const answer=`<div data-content-search-unit-key="fallback-turn-1:2:assistant"><div data-conversation-role="assistant"></div><div class="text-token-text-error"><span>${message}</span><button>Retry</button></div><div class="markdown">Partial answer</div></div><button aria-label="复制"></button>`;
    const s=harness(composer()+group('fallback-turn-1','',{answer})).run();
    assert.equal(s.failure,message);assert.equal(s.generating,false);assert.equal(s.complete,false);assert.equal(s.rawStopPresent,true);
  }
});

test('terminal failure observation never permits sole Send while the physical Stop remains',()=>{
  const h=harness(composer()+group('fallback-turn-1',failed)),s=h.run(),editor=h.window.document.querySelector('[contenteditable]');
  editor.innerHTML='<p><span app-mention-path="app://original" app-mention-display-name="Local-MCP" contenteditable="false">Local-MCP</span> </p><p>Operator prepared body</p>';
  assert.throws(()=>h.run('send',{expectedText:'Operator prepared body',expectedConnector:'Local-MCP',expectedBaseline:{url:s.url,userId:s.userId,assistantId:s.assistantId}}),/send_baseline_changed/);
  assert.equal(h.sends(),0);
});

test('explicit stopped thinking keeps its own stop semantics and never becomes a generation failure',()=>{
  const body=failed.replace('无法思考','已停止思考');
  for(const physicalStop of [false,true]){const s=harness(composer(physicalStop)+group('fallback-turn-1',body)).run();assert.equal(s.failure,'');assert.equal(s.stopped,!physicalStop);assert.equal(s.generating,physicalStop);}
});

const standaloneTitles=[...Array.from({length:6},(_,i)=>[`h${i+1}`,`<h${i+1}>无法思考</h${i+1}>`]),
 ['heading','<div role="heading" aria-level="3">无法思考</div>'],
 ['status','<div role="status"><span>无法思考</span></div>'],
 ['alert','<aside role="alert"><span>无法思考</span></aside>'],
 ['bare-div','<div class="changed-platform-title">无法思考</div>'],
 ['bare-span','<div class="changed-platform-title"><span>无法思考</span></div>']];
for(const [kind,title]of standaloneTitles)test('owned standalone '+kind+' terminal title is observed without an assistant body or Stop',()=>{
 const h=harness(composer(false)+group('fallback-turn-1',title)),s=h.run();
 assert.equal(s.failure,'无法思考');assert.equal(s.generating,false);assert.equal(s.rawStopPresent,false);assert.equal(s.complete,false);
 assert.equal(s.attemptMarker,marker);assert.equal(s.attemptMarkerCount,1);assert.equal(s.publicText,'');assert.equal(s.html,'');
 assert.equal(s.assistantId,`managed-public:${marker}:failed-assistant:无法思考`);assert.equal(h.sends(),0);
 assert.equal(harness(composer(false)+group('fallback-turn-91',title)).run().assistantId,s.assistantId);
});

test('declared latest public assistant unit can own its terminal title without a conversational assistant body',()=>{
 const old=group('old','',{user:'Earlier '+otherMarker,answer:'<div data-content-search-unit-key="old:1:assistant"><div data-conversation-role="assistant"></div><div class="markdown">Earlier completed answer</div></div><button aria-label="复制"></button>'});
 for(const [,title]of standaloneTitles){
  const body='<div data-content-search-unit-key="fallback-turn-1:1:assistant">'+title+'</div>';
  const s=harness(composer(false)+old+group('fallback-turn-1',body)).run();
  assert.equal(s.failure,'无法思考');assert.equal(s.complete,false);assert.equal(s.publicText,'Earlier completed answer');
  assert.equal(s.assistantId,`managed-public:${marker}:failed-assistant:无法思考`);assert.equal(s.attemptMarker,marker);
 }
});

test('legacy explicit current assistant turn owns semantic or bare terminal titles after the managed user',()=>{
 const user=`<div data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user"><div data-user-message-bubble>Task ${marker}</div></div></div>`;
 for(const [,title]of standaloneTitles){
  const assistant='<div data-testid="conversation-turn-2" data-turn="assistant" data-turn-id="current-assistant-original">'+title+'</div>';
  const s=harness(composer(false)+user+assistant).run();
  assert.equal(s.failure,'无法思考');assert.equal(s.rawStopPresent,false);assert.equal(s.complete,false);assert.equal(s.assistantId,'current-assistant-original');assert.equal(s.attemptMarker,marker);
 }
});

test('a later current thinking phase supersedes every standalone terminal title, including an earlier explicit alert',()=>{
 for(const physicalStop of [false,true])for(const [,title]of standaloneTitles)for(const thinking of [
  '<div class="group/activity-header"><span>思考中</span></div>',
  '<div role="status"><span>Thinking</span></div>',
  '<h3>正在思考</h3>',
  '<span>Thinking</span>',
  '<div>思考中</div>'
 ]){
  const s=harness(composer(physicalStop)+group('fallback-turn-1',title+thinking+disconnected+processing)).run();
  assert.equal(s.failure,'');assert.equal(s.generating,physicalStop);assert.equal(s.complete,false);
  assert.equal(s.streamInterrupted,true);assert.equal(s.processingNotice,true);
 }
 const latest=harness(composer(false)+group('fallback-turn-1','<div role="status">思考中</div><span>无法思考</span>'+disconnected+processing)).run();
 assert.equal(latest.failure,'无法思考');assert.equal(latest.streamInterrupted,true);assert.equal(latest.processingNotice,true);
});

test('older, foreign, authored, hidden and user-owned standalone terminal text never becomes current failure',()=>{
 for(const [kind,title]of standaloneTitles){
  const cases=[
   group('old',title,{user:'Old '+otherMarker})+group('fallback-turn-1',''),
   group('fallback-turn-1','<div class="markdown">'+title+'</div>'),
   group('fallback-turn-1','<div data-markdown-text-style="assistant-message">'+title+'</div>'),
   group('fallback-turn-1','<div data-conversation-role="assistant">'+title+'</div>'),
   group('fallback-turn-1','<div data-message-author-role="assistant">'+title+'</div>'),
   group('fallback-turn-1','<pre>'+title+'</pre>'),group('fallback-turn-1','<code>'+title+'</code>'),group('fallback-turn-1','<blockquote>'+title+'</blockquote>'),
   group('fallback-turn-1','<button>'+title+'</button>'),group('fallback-turn-1','<a href="#">'+title+'</a>'),
   group('fallback-turn-1','<div contenteditable="true">'+title+'</div>'),
   group('fallback-turn-1','<div hidden>'+title+'</div>'),group('fallback-turn-1','<div inert>'+title+'</div>'),
   group('fallback-turn-1','<div style="display:none">'+title+'</div>'),group('fallback-turn-1','<div style="visibility:hidden">'+title+'</div>'),
   group('fallback-turn-1','<div aria-hidden="true">'+title+'</div>'),
   group('fallback-turn-1','<div data-content-search-turn-key="foreign">'+title+'</div>'),
   group('fallback-turn-1','<div data-turn-key="foreign">'+title+'</div>'),
   group('fallback-turn-1','<div data-content-search-unit-key="foreign:1:assistant">'+title+'</div>'),
   group('fallback-turn-1','<div data-content-search-unit-key="fallback-turn-1:1:tool">'+title+'</div>'),
   `<div data-content-search-turn-key="fallback-turn-1"><div data-content-search-unit-key="fallback-turn-1:0:user"><div data-user-message-bubble>Task ${marker}</div>${title}</div></div>`,
   // Global role=alert already has its separate legacy page-alert contract.
   ...(kind==='alert'?[]:[group('fallback-turn-1','')+title])
  ];
  for(const body of cases){const s=harness(composer(false)+body).run();assert.equal(s.failure,'',body);assert.equal(s.complete,false,body);}
 }
});

test('connection and processing activity headers preserve the current explicit failure without becoming a new phase',()=>{
 for(const [,title]of standaloneTitles)for(const physicalStop of [false,true]){
  const notices='<div class="group/activity-header"><span>连接已中断，正在等待完整答复</span></div><div class="group/activity-header"><span>我们的系统正在进一步处理此请求</span></div>';
  const s=harness(composer(physicalStop)+group('fallback-turn-1',title+notices)).run();
  assert.equal(s.failure,'无法思考');assert.equal(s.generating,false);assert.equal(s.rawStopPresent,physicalStop);assert.equal(s.streamInterrupted,true);assert.equal(s.processingNotice,true);
 }
});

test('class-free stopped labels retain explicit stop semantics after an earlier failure',()=>{
 for(const stopped of ['<span>已停止思考</span>','<div>Stopped thinking</div>']){
  const s=harness(composer(false)+group('fallback-turn-1','<span>无法思考</span>'+stopped)).run();
  assert.equal(s.failure,'');assert.equal(s.stopped,true);assert.equal(s.generating,false);assert.equal(s.complete,false);
 }
});

test('a later public assistant unit supersedes older failed headers even when the new unit has no body yet',()=>{
 for(const [,title]of standaloneTitles){
  const body='<div data-content-search-unit-key="fallback-turn-1:1:assistant">'+title+'</div><div data-content-search-unit-key="fallback-turn-1:2:assistant"></div>';
  const s=harness(composer(false)+group('fallback-turn-1',body)).run();assert.equal(s.failure,'');assert.equal(s.complete,false);
 }
});

test('class-free labels require one exact current managed marker, not a quoted or duplicated marker',()=>{
 for(const [,title]of standaloneTitles.filter(([kind])=>kind!=='alert'))for(const body of [
  group('fallback-turn-1',title,{user:'Unmarked current task'}),
  group('fallback-turn-1',title,{user:marker+' is a quote'}),
  group('fallback-turn-1',title,{user:'Current '+marker+' '+marker}),
  group('old','',{user:'Earlier '+marker})+group('fallback-turn-1',title)
 ]){const s=harness(composer(false)+body).run();assert.equal(s.failure,'');assert.equal(s.complete,false);}
});

test('substring prose, generic idle state and notices cannot substitute for an exact terminal platform title',()=>{
 for(const body of ['<span>无法思考，因为正在处理中</span>','<div>任务日志：无法思考</div>','<h3>Thinking failed was quoted</h3>',
  '<div role="status">已等待 300 分钟</div>','<div>处理完成</div>','<button>Retry</button>',disconnected+processing]){
  const h=harness(composer(false)+group('fallback-turn-1',body)),s=h.run();assert.equal(s.failure,'');assert.equal(s.complete,false);assert.equal(h.sends(),0);
 }
});

test('standalone terminal titles with a physical Stop still cannot bypass the original sole-Send baseline',()=>{
 for(const [,title]of standaloneTitles){
  const h=harness(composer()+group('fallback-turn-1',title)),s=h.run(),editor=h.window.document.querySelector('[contenteditable]');
  assert.equal(s.failure,'无法思考');assert.equal(s.rawStopPresent,true);assert.equal(s.generating,false);
  editor.innerHTML='<p><span app-mention-path="app://original" app-mention-display-name="Local-MCP" contenteditable="false">Local-MCP</span> </p><p>Operator prepared body</p>';
  assert.throws(()=>h.run('send',{expectedText:'Operator prepared body',expectedConnector:'Local-MCP',expectedBaseline:{url:s.url,userId:s.userId,assistantId:s.assistantId}}),/send_baseline_changed/);assert.equal(h.sends(),0);
 }
});
