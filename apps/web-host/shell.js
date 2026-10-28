'use strict';
const $=id=>document.getElementById(id);
let state={pages:[],closed:[]},native=false,detailMode=null,selectedId=null,lastBound=false,navSignature='',eventsSignature='',eventsPageId=null,closedSignature='',dialogAction=null,layoutQueued=false;
let newTaskDraft=null;
let statePaintPending=false,statePaintFrame=null,pendingStateNotice=null,noticeOwner=null;
let stateSnapshotRequested=false;
let rendererConnectionEpoch=0;
let taskSelectionEpoch=0;
let composerComposition=false;
let shellViewRestore=null;
try{shellViewRestore=JSON.parse(localStorage.getItem('clw-shell-view')||'null');localStorage.removeItem?.('clw-shell-view');}catch{}
let navigationCollapsed=(window.innerWidth||1280)<=760,navigationPreference=null;
try{navigationPreference=localStorage.getItem('clw-navigation-collapsed');if(navigationPreference!==null)navigationCollapsed=navigationPreference==='true';}catch{/* Navigation remains available when storage is unavailable. */}
function renderNavigationChrome(){
  document.body.classList.toggle('nav-collapsed',navigationCollapsed);
  const toggle=$('sidebar-toggle');
  toggle.setAttribute('aria-expanded',String(!navigationCollapsed));
  toggle.title=navigationCollapsed?'展开任务导航':'收起任务导航';toggle.setAttribute('aria-label',toggle.title);
}
function toggleNavigation(){
  preserveReaderLayout();
  navigationCollapsed=!navigationCollapsed;
  navigationPreference=String(navigationCollapsed);
  try{localStorage.setItem('clw-navigation-collapsed',String(navigationCollapsed));}catch{/* A display preference never blocks the current work. */}
  renderNavigationChrome();scheduleLayout();
}
$('sidebar-toggle').onclick=toggleNavigation;
function closeMobileNavigation(){if((window.innerWidth||1280)<=760&&!navigationCollapsed){navigationCollapsed=true;renderNavigationChrome();scheduleLayout();}}
for(const id of ['sidebar-close','sidebar-scrim'])if($(id))$(id).onclick=closeMobileNavigation;
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('workflow-selector').open)closeMobileNavigation();});
renderNavigationChrome();
// These are persistent navigation groups. The workflow selector is a temporary
// choice popup, so its open state is deliberately separate from group folding.
let sidebarGroupPreferences={};
try{const stored=JSON.parse(localStorage.getItem('clw-sidebar-groups')||'{}');if(stored&&typeof stored==='object'&&!Array.isArray(stored))sidebarGroupPreferences=stored;}catch{/* Folding remains usable without storage. */}
for(const id of ['connection-tools','workspace-tools']){
  const group=$(id),summary=group.firstElementChild;
  group.open=sidebarGroupPreferences[id]===true;
  summary.setAttribute('aria-expanded',String(group.open));
  group.addEventListener('toggle',()=>{
    summary.setAttribute('aria-expanded',String(group.open));
    sidebarGroupPreferences[id]=group.open;
    try{localStorage.setItem('clw-sidebar-groups',JSON.stringify(sidebarGroupPreferences));}catch{/* A display preference never blocks work. */}
    scheduleLayout();
  });
}
function closeWorkflowSelector(focus=false){
  const selector=$('workflow-selector');selector.open=false;
  const summary=selector.firstElementChild;summary.setAttribute('aria-expanded','false');
  if(focus)summary.focus();
}
$('workflow-selector').addEventListener('toggle',()=>{
  const selector=$('workflow-selector');selector.firstElementChild.setAttribute('aria-expanded',String(selector.open));
});
$('workflow-selector').addEventListener('keydown',event=>{
  const selector=$('workflow-selector'),summary=selector.firstElementChild;
  const choices=[...$('workflow-choices').querySelectorAll('button')];
  if(event.key==='Escape'&&selector.open){event.preventDefault();event.stopPropagation();closeWorkflowSelector(true);return;}
  if(event.target===summary&&['ArrowDown','ArrowUp'].includes(event.key)){
    event.preventDefault();selector.open=true;summary.setAttribute('aria-expanded','true');
    (choices.find(node=>node.classList.contains('active'))||choices[0]).focus();return;
  }
  const index=choices.indexOf(document.activeElement);
  if(index<0||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();choices[event.key==='Home'?0:event.key==='End'?choices.length-1:(index+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length].focus();
});
document.addEventListener('pointerdown',event=>{if($('workflow-selector').open&&!$('workflow-selector').contains(event.target))closeWorkflowSelector();});
const disconnectedNotice='本机通信中断；原请求保留，请核对原执行。';
let layoutFrame=null,layoutSignature='';
let workflowDetailKey='',workflowDetailOpen=false;
function paintWorkflowClock(value){
  const clock=$('workflow-clock');if(!clock)return;
  clock.hidden=!value.visible;clock.dataset.state=value.state||'';
  for(const [id,text,note]of [['workflow-round-time',value.round,value.roundNote],['workflow-goal-time',value.goal,value.goalNote]]){
    const node=$(id);if(node.textContent!==text)node.textContent=text;node.hidden=!text;
    if(node.title!==(note||''))node.title=note||'';
  }
}
const workClock=new CLWWorkTimer.Clock({storage:localStorage,hidden:()=>document.hidden,onChange:paintWorkflowClock});
const navWorkersExpanded=new Set();let workersSignature='';
function workflowDisclosure(key,attention=false){
  if(workflowDetailKey!==key){workflowDetailKey=key;workflowDetailOpen=attention;}
  $('workflow-detail-panel').hidden=!workflowDetailOpen;
  $('workflow-toggle').setAttribute('aria-expanded',String(workflowDetailOpen));
  $('workflow-toggle').textContent=workflowDetailOpen?'收起 ⌃':'进展 ⌄';
}
function readDrafts(key='clw-composer-drafts'){try{return new Map(JSON.parse(localStorage.getItem(key)||'[]'));}catch{return new Map();}}
const drafts=readDrafts(),draftRevisions=new Map(),busy=new Set(),modelDrafts=new Map();let settingsPageId=null;
function writeComposerDraft(id,text){drafts.set(id,text);draftRevisions.set(id,(draftRevisions.get(id)||0)+1);return saveDrafts();}
let interactionTarget=null;
const interactionFeedback=new CLWInteractionFeedback.Feedback({onChange:renderInteractionFeedback});
document.addEventListener('click',event=>{const node=event.target.closest?.('button,summary');
  interactionTarget=node?{node,at:Date.now()}:null;
  if(node?.closest('#task-menu'))$('task-menu').hidePopover();
},true);
function renderInteractionFeedback(){
  const pending=interactionFeedback.snapshot(owner=>!owner||noticeContextCurrent(owner)||
    (owner.selection&&owner.workflow===workflowMode&&owner.workflowEpoch===workflowEpoch));
  $('interaction-status').hidden=!pending;
  $('interaction-status').setAttribute('aria-busy',String(!!pending));
  $('interaction-status-text').textContent=pending?pending.label+'…':'';
}
async function interactiveCommand(action,payload={}){
  if(['status','layout','prompt-preview'].includes(action))return window.clw.command(action,payload);
  const node=interactionTarget&&Date.now()-interactionTarget.at<800?interactionTarget.node:null;
  const owner={...captureNoticeContext(payload.id||current()?.id),selection:action==='select'};
  const finish=interactionFeedback.begin(action,{node,owner});
  try{return await window.clw.command(action,payload);}finally{finish();}
}
let connectionSnapshot=null,connectionReadSerial=0,connectionRefreshQueued=false;
const recordHistory=new CLWRecordHistory.Records({command:interactiveCommand,onChange:()=>queueStateRender()});
const recordViews=readDrafts('clw-record-view-state');let recordViewSaveTimer=null,recordRenderedKey=null,recordRenderVersion=0;
let webRecordNodes=new Map(),recordIndexSignature='',recordIntentSerial='',recordFindTimer=null,codexRecordSignature='';
const recordAppliedIntents=new Map();
function recordView(key){
  const existing=recordViews.get(key);
  if(existing&&typeof existing==='object'&&existing.folds&&typeof existing.folds==='object'){recordViews.delete(key);recordViews.set(key,existing);return existing;}
  const value={folds:{},scrollTop:0,hasPosition:false,anchor:null};recordViews.set(key,value);
  while(recordViews.size>32)recordViews.delete(recordViews.keys().next().value);return value;
}
function saveRecordViews(){
  clearTimeout(recordViewSaveTimer);recordViewSaveTimer=setTimeout(()=>{
    try{localStorage.setItem('clw-record-view-state',JSON.stringify([...recordViews].slice(-32)));}catch{}
  },150);
}
function recordFold(key,id,open){const view=recordView(key);view.folds[id]=!!open;
  const keys=Object.keys(view.folds);for(const old of keys.slice(0,Math.max(0,keys.length-160)))delete view.folds[old];saveRecordViews();}
function recordScroller(mode=recordHistory.active?.mode){return $(mode==='codex'?'codex-workspace':'conversation');}
function recordAnchor(scroller){
  const top=scroller.getBoundingClientRect().top;
  for(const row of scroller.querySelectorAll('[data-record-key],[data-trace]')){
    const bounds=row.getBoundingClientRect();if(bounds.bottom>top+8&&bounds.height>0){
      const anchor={key:row.dataset.recordKey||row.dataset.trace,offset:bounds.top-top};
      const blocks=row.querySelectorAll('.text > *');
      for(let index=0;index<blocks.length;index++){const block=blocks[index],r=block.getBoundingClientRect();if(r.height&&r.bottom>top+8){anchor.block=index;anchor.blockText=block.textContent.slice(0,64);anchor.blockOffset=r.top-top;break;}}
      return anchor;
    }
  }return null;
}
function restoreReadingAnchor(scroller,anchor){
  if(!anchor)return false;
  const row=[...scroller.querySelectorAll('[data-record-key],[data-trace]')].find(node=>(node.dataset.recordKey||node.dataset.trace)===anchor.key);
  if(!row)return false;
  const block=Number.isInteger(anchor.block)?row.querySelectorAll('.text > *')[anchor.block]:null;
  const useBlock=block&&block.textContent.slice(0,64)===anchor.blockText&&block.getBoundingClientRect().height>0;
  const bounds=(useBlock?block:row).getBoundingClientRect(),offset=useBlock?anchor.blockOffset:Math.max(anchor.offset,32-bounds.height);
  scroller.scrollTop=(Number(scroller.scrollTop)||0)+bounds.top-scroller.getBoundingClientRect().top-offset;
  return true;
}
let readingLayout=null;
function captureReadingLayout(){
  const active=recordHistory.active;if(!active||native)return;
  const scroller=recordScroller(active.mode);
  if(scroller.hidden)return;
  readingLayout={key:active.key,anchor:recordAnchor(scroller),top:Number(scroller.scrollTop)||0};
  active.following=false;rememberRecordPosition();renderRecordToolbar();
}
function applyReadingLayout(){
  const active=recordHistory.active,held=readingLayout;if(!active||held?.key!==active.key)return;
  const scroller=recordScroller(active.mode);
  if(!restoreReadingAnchor(scroller,held.anchor))scroller.scrollTop=held.top;
  rememberRecordPosition();
}
function preserveReaderLayout(){captureReadingLayout();requestAnimationFrame(applyReadingLayout);}
function rememberRecordPosition(){const active=recordHistory.active;if(!active)return;
  const scroller=recordScroller(active.mode),view=recordView(active.key);view.scrollTop=scroller.scrollTop||0;view.hasPosition=true;
  view.following=active.following!==false;
  if(!scroller.hidden)view.anchor=recordAnchor(scroller)||view.anchor;saveRecordViews();}
function activateRecords(context,rows,meta){
  const key=context?context.mode+':'+context.id:null;
  const changed=recordHistory.active?.key!==key;
  if(changed){rememberRecordPosition();clearTimeout(recordFindTimer);recordRenderVersion++;recordIndexSignature='';}
  const active=recordHistory.use(context,rows,meta);
  if(changed&&active&&recordView(key).following===false)active.following=false;
  return active;
}
function renderRecordToolbar(){
  const active=recordHistory.active,visible=!!active&&!native&&(workflowMode==='web'?!!current()?.bound:!!codexSelected);
  $('record-toolbar').hidden=!visible;if(!visible)return;
  const meta=active.meta;
  $('record-range').textContent=active.loading?'正在读取记录…':(active.capable?'已加载 '+active.rows.length+' 条'+(Number.isFinite(meta.total)?' · 共 '+meta.total+' 条':''):'近期记录 · 完整历史待加载');
  $('record-earlier').disabled=active.loading||!active.capable||!meta.has_before;
  $('record-first').disabled=active.loading||!active.capable||!meta.has_before;
  $('record-latest').disabled=active.loading||(!active.capable&&!active.live);
  $('record-latest').hidden=active.live&&active.following!==false&&!active.newer&&!active.loading;
  $('record-latest').textContent=active.newer?'查看新记录 ↓':'回到最新 ↓';$('record-latest').dataset.new=String(active.newer);
  for(const id of ['record-directory-toggle']){$(id).disabled=!active.capable;$(id).setAttribute('aria-expanded',String(active.indexOpen));}
  $('record-drawer').hidden=!active.indexOpen;
  $('record-error').hidden=!active.error;$('record-error').textContent=active.error;
  if(!active.indexOpen)return;
  if(document.activeElement!==$('record-find')&&$('record-find').value!==active.query)$('record-find').value=active.query;
  $('record-drawer-title').textContent=active.query?'查找记录':'对话目录';
  $('record-find-status').textContent=active.indexLoading?'正在查找…':active.query?(active.indexMeta.total||0)+' 处匹配':(active.indexMeta.total||0)+' 条对话记录';
  const findScope=active.mode==='codex'?'查找此任务保存的网页回复…':'查找此任务的全部保存记录…';$('record-find').placeholder=findScope;$('record-find').setAttribute('aria-label',findScope);
  if(active.indexMeta.unavailable_body_count)$('record-find-status').textContent+=' · '+active.indexMeta.unavailable_body_count+' 份完整原稿暂不可检索';
  $('record-index-before').disabled=active.indexLoading||!active.indexMeta.has_before;
  $('record-index-after').disabled=active.indexLoading||!active.indexMeta.has_after;
  $('record-index-first').disabled=active.indexLoading||!active.indexMeta.has_before;
  const signature=JSON.stringify([active.key,active.query,active.indexLoading,active.index]);
  if(signature!==recordIndexSignature){recordIndexSignature=signature;$('record-index').replaceChildren();
    if(!active.index.length&&!active.indexLoading){const empty=document.createElement('p');empty.className='scope-hint';empty.textContent=active.query?'没有找到匹配记录。':'还没有可展示的对话记录。';$('record-index').append(empty);}
    for(const item of active.index){const b=button('','record-index-item',()=>{active.indexOpen=false;void recordHistory.navigate('around',active.mode==='web'?item.seq:item.traceId);renderRecordToolbar();});
      const time=document.createElement('small');time.textContent=item.at?new Date(item.at).toLocaleString():'时间未记录';
      const title=document.createElement('span');title.textContent=item.label||'查看记录';b.append(time,title);$('record-index').append(b);}
  }
}
function restoreRecordScroll(active,previous,follow,changed){
  const key=active.key,version=recordRenderVersion,scroller=recordScroller(active.mode),intent=active.intent;
  const intentKey=intent?key+':'+intent.serial:'';
  const newIntent=intent&&recordAppliedIntents.get(key)!==intent.serial;
  requestAnimationFrame(()=>{
    if(recordHistory.active?.key!==key||recordRenderVersion!==version)return;
    if(newIntent){readingLayout=null;recordIntentSerial=intentKey;recordAppliedIntents.delete(key);recordAppliedIntents.set(key,intent.serial);
      while(recordAppliedIntents.size>32)recordAppliedIntents.delete(recordAppliedIntents.keys().next().value);}
    if(newIntent&&intent.direction==='around'){
      if(active.mode==='codex')CLWCodexTurns.focusTrace?.($('codex-turns'),intent.target);
      else{const entry=webRecordNodes.get('event:'+intent.target)||[...webRecordNodes.values()].find(entry=>entry.rows?.some(row=>row.seq===intent.target));
        if(entry){entry.autoOpen=false;entry.node.open=true;entry.mount();}const target=$('events').querySelector('[data-seq="'+intent.target+'"]');if(target){target.scrollIntoView({block:'center'});target.classList.add('record-jump');setTimeout(()=>target.classList.remove('record-jump'),2500);}}
    }else if(newIntent&&intent.direction==='first'){
      if(active.mode==='codex'&&active.rows[0])CLWCodexTurns.focusTrace?.($('codex-turns'),active.rows[0].traceId);
      else scroller.scrollTop=0;
    }else if(newIntent&&intent.direction==='latest')scroller.scrollTop=Number(scroller.scrollHeight)||0;
    else if(changed){const saved=recordView(key);
      if(saved.hasPosition&&active.following===false){scroller.scrollTop=saved.scrollTop||0;restoreReadingAnchor(scroller,saved.anchor);}
      else scroller.scrollTop=Number(scroller.scrollHeight)||0;
    }
    else if(readingLayout?.key===active.key)applyReadingLayout();
    else if(active.following!==false&&active.live)scroller.scrollTop=Number(scroller.scrollHeight)||0;
    else if(previous){
      if(!restoreReadingAnchor(scroller,previous)&&active.following!==false&&active.live)scroller.scrollTop=Number(scroller.scrollHeight)||0;
    }else if(active.following!==false&&active.live)scroller.scrollTop=Number(scroller.scrollHeight)||0;
  });
}
let codexTurnsSignature='',sessionActivitySignature='';
let workflowMode=['codex','local'].includes(localStorage.getItem('clw-workflow-mode'))?localStorage.getItem('clw-workflow-mode'):'web',codexSelected=null,codexArchiveView=false;
let workflowEpoch=0,nativeViewIntent=0;
let codexArchives;try{const stored=JSON.parse(localStorage.getItem('clw-codex-archives')||'[]');codexArchives=new Set(Array.isArray(stored)?stored.filter(k=>typeof k==='string'):[]);}catch{codexArchives=new Set();}
function selectCodexTask(key){nativeViewIntent++;codexSelected=key;nativeView(false);details(null);render();}
function codexOverview(archived=false){codexArchiveView=archived;selectCodexTask(null);}
function archiveCodexTask(key,archived){const group=CLWCodexTurns.groupRows(state.codexWeb?.recent||[]).find(g=>g.key===key);if(!group||!CLWCodexTurns.canArchive(group))return;const next=new Set(codexArchives);if(archived)next.add(key);else next.delete(key);try{localStorage.setItem('clw-codex-archives',JSON.stringify([...next]));codexArchives=next;render();}catch{showNotice('归档未能保存，请稍后再试。');}}
function setWorkflowMode(mode){if(workflowMode!==mode){if(workflowMode==='codex')CLWCodexTurns.invalidateTask($('codex-turns'));codexRecordSignature='';workflowEpoch++;nativeViewIntent++;}workflowMode=mode;localStorage.setItem('clw-workflow-mode',mode);nativeView(false);details(null);render();}
function originalConversationMismatch(p){
  const original=p?.bound&&typeof p.conversationUrl==='string'&&/^https:\/\/chatgpt\.com\/c\/([A-Za-z0-9-]+)(?:[?#].*)?$/.exec(p.conversationUrl);
  if(!original||typeof p.url!=='string'||!p.url)return false;
  const currentUrl=/^https:\/\/chatgpt\.com\/c\/([A-Za-z0-9-]+)(?:[?#].*)?$/.exec(p.url);
  return currentUrl?.[1]!==original[1];
}
function renderRefreshControl(){
  const web=workflowMode==='web',codex=workflowMode==='codex',p=current(),selectedWeb=state.codexConversation;
  const button=$('refresh-page'),visible=native&&(web?!!p&&!p.draft:codex&&!!codexSelected&&!!selectedWeb);
  const mismatch=web&&originalConversationMismatch(p),observation=p?.observation,view=taskView(p);
  const pageLoading=web?(p?.status==='loading'||p?.loading===true):selectedWeb?.loading===true;
  const readUnknown=web&&(!state.connected||state.taskStateReady===false||!!view.state_read?.unavailable||!!p?.bound&&view.page_id!==p.id);
  const activeBrowser=!!(observation?.generating||observation?.draft||observation?.composing||observation?.approvalRequired);
  // A stalled resource can keep isLoading true after the public DOM is ready.
  // Refresh stays on the visible page; an older task does not own navigation.
  const observationAge=Number.isFinite(observation?.at)?Date.now()-observation.at:null;
  const freshEmptyHome=observationAge!==null&&observationAge>=0&&observationAge<=30000&&observation?.emptyHomepage===true;
  const restoreIdleHome=mismatch&&/^https:\/\/chatgpt\.com\/?$/.test(p.url)&&freshEmptyHome&&!activeBrowser;
  const waiting=busy.has('refresh')||(pageLoading&&!restoreIdleHome);
  const requestBusy=['processing','suspended'].includes((view.request||p?.latest_request)?.phase);
  const protectedWeb=activeBrowser||readUnknown||(requestBusy&&!(p?.manualControl&&mismatch));
  button.hidden=!visible;
  button.disabled=!visible||waiting||(web?(!!p?.draft||!!p?.accountAccess?.blocked||protectedWeb):!!selectedWeb?.running||selectedWeb?.available===false);
  const label='刷新当前网页';
  button.setAttribute('aria-label',label);
  button.title=waiting?'正在加载当前网页…':web&&protectedWeb?
    label+'：原回合仍在工作或待核对，当前工作继续。':label+'，不发送模型消息。';
  if(waiting)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
  const hint=$('web-navigation-hint');hint.hidden=!visible||!web||!mismatch;
  hint.textContent='你正在浏览其他对话；原任务和消息已保留，CLW不会自动切回。';
  $('web-view-controls').hidden=$('view-switch').hidden&&button.hidden;
}
function renderWorkspaceMode(){
  renderComposerContext();
  const codex=workflowMode==='codex',local=workflowMode==='local',web=workflowMode==='web';
  if(!web){$('workflow-observation').hidden=true;$('workflow-observation').textContent='';}
  const rows=codexSelected?CLWCodexTurns.filterRows(state.codexWeb?.recent||[],codexSelected):[];
  const selectedWeb=state.codexConversation;
  document.body.classList.toggle('codex-mode',codex);
  document.body.classList.toggle('local-mode',local);
  $('local-workspace').hidden=!local;$('local-navigation-note').hidden=!local;
  $('codex-workspace').hidden=!codex||(native&&!!selectedWeb);$('pages').hidden=!web;$('codex-pages').hidden=!codex;
  $('codex-browser-bar').hidden=!codex||!native||!selectedWeb;
  if(codex&&native&&selectedWeb){
    $('codex-browser-account').textContent='账号 '+selectedWeb.account+' · '+(selectedWeb.running?'正在执行的原网页':'原对话');
    $('codex-browser-note').textContent=selectedWeb.available===false?'原页面已关闭，请重新点击「对话网页」打开已保存对话。':'查看不发送消息。补充要求和继续工作请回原 Codex；同一对话可能包含后续回合。';
  }
  for(const id of ['codex-overview','codex-nav-label','codex-archive'])$(id).hidden=!codex;
  $('closed-tasks').hidden=!web;$('quota-open').hidden=local;$('login').hidden=local;
  $('login-label').textContent=codex?'账号与启动':'账号管理';
  $('workspace-records').hidden=local;
  $('connection-tools').hidden=[...$('connection-tools-items').querySelectorAll('button')].every(node=>node.hidden);
  $('codex-overview').classList.toggle('selected',!codexSelected&&!codexArchiveView);
  $('codex-overview').setAttribute('aria-current',!codexSelected&&!codexArchiveView?'page':'false');
  $('codex-archive').classList.toggle('selected',codexArchiveView);
  $('codex-nav-label').textContent=codexArchiveView?'已归档的任务':'任务';
  $('mode-web').classList.toggle('active',web);$('mode-codex').classList.toggle('active',codex);$('mode-local').classList.toggle('active',local);
  $('workflow-mode-label').textContent=codex?'Codex＋Web':local?'本地 Codex':'纯 Web';
  $('mode-web').setAttribute('aria-pressed',String(web));$('mode-codex').setAttribute('aria-pressed',String(codex));$('mode-local').setAttribute('aria-pressed',String(local));
  if(codex){
    $('automation-control-note').textContent='当前回合由原 Codex 终端控制；查看记录和切换页面不打断工作。';
    $('thread-title').textContent=rows[0]?CLWCodexTurns.turnView(rows[0]).title:'Codex＋Web';$('thread-title').title='';
    $('connection').textContent='同一工作区 · 原生工具执行 · 网页模型推理';
    for(const id of ['team-maintenance','pause','resume','stop-generation','compose-footer'])$(id).hidden=true;
    $('workflow').hidden=!rows.length;
    if(rows[0]){
      const row=rows[0],v=CLWCodexTurns.turnView(row),step=v.step;
      $('workflow').dataset.tone=v.needsAttention?'warning':row.status==='running'&&step===1?'active':step===3?'success':'waiting';
      $('workflow-title').textContent=v.status;$('workflow-detail').textContent=v.sent+' · '+v.note;
      workflowDisclosure('codex:'+row.traceId+':'+row.status,v.needsAttention);
      $('workflow-time').textContent=v.model+(row.startedAt?' · '+new Date(row.startedAt).toLocaleTimeString():'');
      [...$('workflow-steps').children].forEach((element,i)=>{element.classList.toggle('current',i===step);element.classList.toggle('done',i<step);element.setAttribute('aria-current',i===step?'step':'false');});
      $('workflow-action').hidden=true;$('model-difference').hidden=true;$('worker-status').hidden=true;
    }
    $('view-switch').hidden=!codexSelected;
    $('native').disabled=!rows[0]||!CLWCodexTurns.webpage(rows[0]).available;
    $('settings').disabled=false;
  }else if(web){$('native').disabled=false;}
  if(local){
    const installed=state.localCodex?.available===true;
    $('thread-title').textContent='本地 Codex';$('thread-title').title='';
    $('connection').textContent='本机账号与模型 · 原生工具';
    for(const id of ['workflow','view-switch','compose-footer','record-toolbar','settings','task-menu-toggle'])$(id).hidden=true;
    $('local-codex-status').textContent=installed?'已找到本机 Codex；打开后在原终端工作。':'尚未找到本机 Codex，当前不能打开。';
    for(const id of ['local-codex-open','local-codex-resume'])$(id).disabled=!installed||busy.has('local-codex-start');
    if(!$('local-codex-root').value)$('local-codex-root').value=current()?.root||state.root||'';
  }else{$('settings').hidden=false;$('task-menu-toggle').hidden=false;}
  $('conversation').hidden=!web;
  workClock.update(web&&current()?.bound?{mode:'web',page:current(),view:taskView()}:
    codex&&rows[0]?{mode:'codex',row:rows[0]}:null);
  renderRefreshControl();
}
const toolActivityPaints=new Map();
function renderToolActivity(id,activity,key){
  const panel=$(id),container=$(id+'-list');
  if(!panel.open||panel.hidden||native)return;
  const context=captureTaskContext(current()?.id),owner=captureNoticeContext(),scope=id==='codex-mcp-activity'?'connection':'task';
  const renderKey=JSON.stringify([key,scope==='task'?context:owner,state.connectionGeneration]);
  const signature=JSON.stringify([renderKey,activity]);
  if(toolActivityPaints.get(id)===signature)return;
  toolActivityPaints.set(id,signature);CLWMcpActivity.render(container,activity,{key:renderKey, isCurrent:()=>scope==='task'?taskContextCurrent(context):noticeContextCurrent(owner),
    readDetails:query=>interactiveCommand('mcp-call-details',{...query,id:scope==='task'?context.id:null,scope})});
}
function renderSessionActivity(){
  const p=current(),view=taskView(p),activity=view.session_activity;
  const visible=workflowMode==='web'&&!!p&&(p.bound||p.enrolling)&&view.page_id===p.id;
  $('session-mcp-activity').hidden=!visible;if(!visible)return;
  const signature=JSON.stringify([p.id,activity]);
  if(signature!==sessionActivitySignature){
    sessionActivitySignature=signature;
    const rows=CLWMcpActivity.calls(activity);
    $('session-mcp-summary').textContent='工具活动'+(rows.length?' · '+rows.length+' 次近期调用':'');
  }
  renderToolActivity('session-mcp-activity',activity,p.id);
}
let processOpen=(window.innerWidth||1280)>1280,processCompactOpen=false,processSignature='',composerExpanded=false;
const processCompactMedia=window.matchMedia?.('(max-width:1280px)');
function processPanelOpen(){return (processCompactMedia?.matches??((window.innerWidth||1280)<=1280))?processCompactOpen:processOpen;}
function renderProcessPanel(){
  const available=workflowMode!=='local'&&!current()?.draft;
  const open=processPanelOpen();
  $('process-panel').hidden=!available||!open||!!detailMode;
  $('process-toggle').hidden=!available;$('process-toggle').setAttribute('aria-expanded',String(open&&!detailMode));
  if(!available||!open||detailMode)return;
  const p=current(),view=taskView(p),bridge=state.codexWeb||{};
  const process=workflowMode==='web'?(p?.observation?.publicProcess||view.public_process):null;
  const publicActivity=process?.activities?.at(-1);const title=publicActivity?.title||process?.title||process?.phase||'';
  const flow=workflowMode==='web'&&p?workflow(p,view,state.connected):null;
  const working=flow&&(['working','working_held'].includes(flow.key)||flow.key==='enrolling'&&flow.step===1);
  const processText=title&&working?(title+(publicActivity?.summary?'\n'+publicActivity.summary:process.summary?'\n'+process.summary:'')):(flow?.title||'查看当前任务的工具与执行活动');
  if($('public-process').textContent!==processText)$('public-process').textContent=processText;
  const rows=workflowMode==='web'?(view.events||[]).filter(row=>!userRecordKinds.has(row.kind)&&!replyRecordKinds.has(row.kind)&&eventRecordText(row)).slice(-16):[];
  const workers=workflowMode==='web'?state.pages.filter(child=>child.parent===p?.id):[];
  const wait=workflowMode==='web'?(view.goal?.wait_context||view.goal?.waiting||view.goal?.wait||view.waiting):null;
  const nativeRows=workflowMode==='codex'&&codexSelected?CLWCodexTurns.groupRows(bridge.recent||[]).find(g=>g.key===codexSelected)?.turns||[]:[];
  const signature=JSON.stringify([p?.id,codexSelected,rows,workers.map(w=>[w.id,w.title,w.paused,w.status]),wait,nativeRows.map(r=>r.traceId),bridge.nativeActivity]);
  if(signature!==processSignature){processSignature=signature;$('process-events').replaceChildren();
    for(const row of rows){const item=document.createElement('div');item.className='run-event';const time=document.createElement('time');time.textContent=row.at?new Date(row.at).toLocaleTimeString():'';const label=document.createElement('span');label.textContent=eventRecordText(row).slice(0,450);item.append(time,label);$('process-events').append(item);}
    $('process-workers').hidden=!workers.length;$('process-workers').replaceChildren();
    if(workers.length){const heading=document.createElement('h3');heading.textContent='协作者';$('process-workers').append(heading);for(const worker of workers){const item=button(worker.title+' · '+status(worker),'quiet wide',()=>selectTask(worker.id));$('process-workers').append(item);}}
    $('process-wait').hidden=!wait;$('process-wait').textContent=wait?'等待结果 · '+(wait.result||wait.reason||'原工作已保存')+'\n'+(wait.resume||wait.resume_point||'')+'\n'+(wait.job_ids||wait.jobs||[]).map(j=>typeof j==='string'?j:j.job_id).filter(Boolean).join('\n'):'';
    const calls=nativeRows.flatMap(row=>CLWCodexTurns.nativeCalls(bridge.nativeActivity,row.traceId));
    $('native-process').hidden=workflowMode!=='codex'||!codexSelected;
    if(workflowMode==='codex'&&codexSelected)CLWWorkRecord.tools($('native-process'),calls.map(call=>({tool:call.tool,status:CLWCodexTurns.nativeStatus(call.phase),detail:(call.atMs?new Date(call.atMs).toLocaleTimeString():'')+(Number.isFinite(call.durationMs)?' · '+(call.durationMs/1000).toFixed(1)+' 秒':'')})));
  }
  // Unattributed connector events stay visibly separate from the selected task.
  $('codex-mcp-activity').hidden=false;renderToolActivity('codex-mcp-activity',bridge.mcpActivity,'connection');
  renderSessionActivity();
}
function setProcessPanelOpen(open){
  if(processCompactMedia?.matches??((window.innerWidth||1280)<=1280))processCompactOpen=open;else processOpen=open;
}
$('process-toggle').onclick=()=>{preserveReaderLayout();const open=!!detailMode||!processPanelOpen();if(detailMode)details(null);setProcessPanelOpen(open);renderProcessPanel();scheduleLayout();};
$('process-close').onclick=()=>{preserveReaderLayout();setProcessPanelOpen(false);renderProcessPanel();scheduleLayout();};
processCompactMedia?.addEventListener?.('change',()=>{preserveReaderLayout();renderProcessPanel();scheduleLayout();});
$('composer-expand').onclick=()=>{const input=$('objective'),start=input.selectionStart,end=input.selectionEnd,direction=input.selectionDirection;
  composerExpanded=!composerExpanded;document.body.classList.toggle('composer-expanded',composerExpanded);$('composer-expand').setAttribute('aria-expanded',String(composerExpanded));$('composer-expand').title=composerExpanded?'恢复正文阅读':'放大编辑';input.focus();input.setSelectionRange?.(start,end,direction);scheduleLayout();};
function optionalNumber(input){return input.value.trim()===''?null:Number(input.value);}
const firstTurnDrafts=readDrafts('clw-first-turn-drafts');
const firstTurnEfforts=readDrafts('clw-first-turn-efforts');
let previewRevision=0,previewTimer=null;
async function renderPromptPreview(){
  const p=current(),revision=++previewRevision;if(!p||!$('task-prompt-preview').open)return;
  const list=$('task-prompt-blocks');list.textContent='正在读取实际发送内容…';
  try{
    const result=await window.clw.command('prompt-preview',{id:p.id,draft:!!p.draft,stored:!!p.bound,root:p.draft?$('root').value:p.root,account:p.account,collaboration_enabled:$('collaboration-enabled').checked,instructions:firstTurnDrafts.get(p.id)??p.firstTurnDraft??''});
    if(revision!==previewRevision||current()?.id!==p.id)return;
    list.replaceChildren();
    for(const block of result.blocks||[]){
      const section=document.createElement('section'),title=document.createElement('h3'),text=document.createElement('pre');
      title.textContent=block.title;text.textContent=block.text;section.append(title,text);list.append(section);
    }
  }catch(error){if(revision===previewRevision)list.textContent='发送内容预览暂不可用。已发送消息和保存的结果保留；送达状态请查看工作记录。';}
}
function saveFirstTurnDrafts(){try{localStorage.setItem('clw-first-turn-drafts',JSON.stringify([...firstTurnDrafts]));}catch{showNotice('首次任务要求暂未保存，关闭前请复制。');}}
const protocolDrafts=readDrafts('clw-protocol-drafts');
function saveProtocolDrafts(){try{localStorage.setItem('clw-protocol-drafts',JSON.stringify([...protocolDrafts]));}catch{showNotice('协作方式暂未持久保存，接入前请再次核对。');}}
const collaborationDrafts=readDrafts('clw-collaboration-drafts');
function saveCollaborationDrafts(){try{localStorage.setItem('clw-collaboration-drafts',JSON.stringify([...collaborationDrafts]));}catch{showNotice('协作选择暂未持久保存，开始前请再次核对。');}}
function saveDrafts(){try{localStorage.setItem('clw-composer-drafts',JSON.stringify([...drafts]));return true;}catch{showNotice('草稿暂时仅保存在当前窗口，关闭前请复制保存。');return false;}}
const {workflow,modelState,enrollmentState,settledBranch,deliveries}=CLWWorkflow;
const basename=p=>(p||'').replace(/[\\/]+$/,'').split(/[\\/]/).at(-1)||'未选择项目';
const projectKey=p=>String(p||'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();let navSelected=null;
const current=()=>newTaskDraft||state.pages.find(p=>p.id===(state.selected||state.pages.find(x=>x.selected)?.id));
const emptyTaskView=Object.freeze({});
function taskView(p=current()){return p&&state.view?.page_id===p.id?state.view:emptyTaskView;}
function captureTaskContext(id=current()?.id){
  const p=current()?.id===id?current():state.pages.find(page=>page.id===id),view=taskView(p);
  return {id,thread:view.thread_id||p?.thread_id||null,request:view.request?.id||p?.latest_request?.id||null,
    connection:state.connectionGeneration??null,epoch:rendererConnectionEpoch,selectionEpoch:taskSelectionEpoch,workflow:workflowMode,workflowEpoch};
}
function taskContextCurrent(context){
  if(!context||current()?.id!==context.id)return false;
  const next=captureTaskContext(context.id);
  return ['id','thread','request','connection','epoch','selectionEpoch','workflow','workflowEpoch'].every(key=>next[key]===context[key]);
}
function captureNoticeContext(taskId=current()?.id||null){return {workflow:workflowMode,workflowEpoch,task:workflowMode==='web'?taskId:workflowMode==='codex'?codexSelected:null};}
function noticeContextCurrent(owner){
  if(!owner)return true;const next=captureNoticeContext();
  return ['workflow','workflowEpoch','task'].every(key=>next[key]===owner[key]);
}
function globalConnectionNotice(message){return CLWRuntimeAvailability.isNotice(message)||[disconnectedNotice,'本机服务尚未连接，请稍候。'].includes(message);}
function actionLabel(node,text,kind){
  if(node.dataset.action===kind&&node.dataset.label===text)return;
  const icon=document.createElement('span');icon.className='action-symbol';icon.setAttribute('aria-hidden','true');
  icon.textContent=({resume:'▶',send:'↑',append:'✓',reconcile:'↻',pause:'Ⅱ',goal:'◎','save-draft':'✓'})[kind]||'';
  const label=document.createElement('span');label.textContent=text;
  node.replaceChildren(icon,label);node.dataset.action=kind;node.dataset.label=text;node.setAttribute('aria-label',text);node.title=text;
}
let composerContextSignature='',composerContextRows=new Map(),composerHeightText=null;
function resizeComposer(force=false){
  const input=$('objective');if(!force&&composerHeightText===input.value)return;
  composerHeightText=input.value;input.style.height='auto';
  const height=Math.min(Math.max(64,Number(input.scrollHeight)||64),Math.min(220,Math.max(96,(window.innerHeight||800)*.3)));
  input.style.height=height+'px';input.style.overflowY=(Number(input.scrollHeight)||0)>height?'auto':'hidden';scheduleLayout();
}
async function withdrawRecord(id,row,context){
  if(!row?.withdraw||!taskContextCurrent(context))return;
  return once('withdraw:'+id+':'+row.seq,async()=>{
    if(!taskContextCurrent(context))return;
    const owner=captureNoticeContext(id),result=await act('withdraw',{id,...row.withdraw});
    if(!result)return;
    const existing=current()?.id===id?$('objective').value:drafts.get(id)||'',text=String(result.text||'');
    const restored=!text?existing:existing.trim()?(existing===text||existing.endsWith('\n\n'+text)?existing:existing+'\n\n'+text):text;
    writeComposerDraft(id,restored);
    if(taskContextCurrent(context)){$('objective').value=restored;resizeComposer();}
    showNotice('已撤回，内容已放回输入框；当前网页继续工作。',{owner});eventsSignature='';composerContextSignature='';render();
    return result;
  });
}
async function reconcileOriginalSubmission(context,objective){
  if(!taskContextCurrent(context)||state.pendingObjective!==objective)return;
  const id=context.id,request=taskView().request||current()?.latest_request;
  const draft=$('objective').value,revision=draftRevisions.get(id)||0;
  const result=await act('reconcile-submission',{id,objective,expected_connection_generation:context.connection,
    expected_request_id:['queued','processing','suspended'].includes(request?.phase)?request.id:null});
  if(!result)return;
  if(result.state==='rejected'){
    showNotice(result.code==='managed_submission_original_intent_missing'?'原提交待核对记录已结清或不存在，本次没有再次发送；草稿已保留。':'原提交尚未核对成功，草稿与原记录已保留：'+String(result.code||'等待核对'),{owner:{workflow:context.workflow,workflowEpoch:context.workflowEpoch,task:id}});return;
  }
  if(!['queued_for_web_host','note_saved_not_native_interrupt'].includes(result.state)||typeof result.request_id!=='string'||!result.request_id){
    showNotice('原提交回执尚未确认，草稿与原记录已保留。',{owner:{workflow:context.workflow,workflowEpoch:context.workflowEpoch,task:id}});return;
  }
  if(taskContextCurrent(context)&&draft===objective&&$('objective').value===draft&&(draftRevisions.get(id)||0)===revision){
    drafts.delete(id);saveDrafts();$('objective').value='';resizeComposer();
  }
  showNotice('原提交回执已核对；后来编辑的草稿继续保留。',{owner:{workflow:context.workflow,workflowEpoch:context.workflowEpoch,task:id}});
}
function renderComposerContext(){
  const p=current(),view=taskView(p),web=workflowMode==='web'&&!!p?.bound&&!p.successor&&p.kind!=='account';
  const verified=web&&view.page_id===p.id&&!view.state_read?.unavailable;
  const eligibleGoal=web&&!p.parent,presentation=CLWTaskPresentation.goalPresentation(p,view),goal=presentation.goal;
  const hasGoal=eligibleGoal&&goal?.configured===true&&(presentation.state!=='stopped'||goalStopIntents.has(p?.id)),goalKnown=verified&&!!goal&&!goal.unavailable&&(goal.owner_identity_valid??goal.identity_valid)!==false;
  const objective=goalKnown&&typeof goal.objective==='string'?goal.objective:'正在核对原目标…';
  const controls=CLWTaskPresentation.goalControls(p,view,{connected:state.connected});
  const goalLabel=!goalKnown?'目标待核对':goalStopIntents.has(p?.id)&&presentation.state==='stopped'?'目标已关闭 · 回执待核对':controls.title;
  $('composer-goal').hidden=!hasGoal;$('settings-refill').hidden=!hasGoal;
  $('composer-goal-state').textContent=goalLabel;$('composer-goal-objective').textContent=objective;
  $('composer-goal-meta').textContent=goalKnown&&presentation.cycles>0?'已接续 '+presentation.cycles+' 包':'';
  $('settings-refill').dataset.state=presentation.state;$('settings-refill').title='目标：'+goalLabel+' · '+objective;
  $('settings-refill').setAttribute('aria-label',$('settings-refill').title);
  const stopping=goalStopIntents.has(p?.id),goalBusy=busy.has('goal-stop:'+p?.id)||busy.has('goal-toggle:'+p?.id);
  const toggle=$('composer-goal-toggle');toggle.hidden=!hasGoal||!controls.toggleVisible;toggle.disabled=!controls.toggleEnabled||goalBusy||stopping;
  toggle.textContent=controls.toggleAction==='resume'?'▶':'Ⅱ';toggle.setAttribute('aria-label',controls.toggleLabel);
  toggle.title=controls.toggleAction==='resume'?'继续这个目标的后续自动发送；沿原任务接续。':'暂停后续自动发送；当前网页回合继续工作。';
  const stop=$('composer-goal-stop');stop.hidden=!hasGoal;stop.disabled=!(controls.stopEnabled||stopping&&goalKnown&&state.connected)||goalBusy;
  stop.title=stopping?'核对同一次关闭目标操作，原回执保留。':'关闭目标并停止后续自动发送；保留对话、要求和成果。';stop.setAttribute('aria-label',stopping?'核对关闭目标':'关闭目标');
  $('composer-add-goal').hidden=!eligibleGoal;$('composer-add-goal').textContent=hasGoal?'目标':presentation.state==='stopped'?'重新设置目标':'设置目标';
  const ready=verified&&state.connected===true&&state.taskStateReady!==false;
  for(const id of ['composer-add-files','composer-add-folder'])$(id).disabled=!ready||(!p?.root&&p?.conversation_mode!=='direct')||busy.has('pick-context');
  $('composer-add').disabled=!web;$('composer-access').disabled=!web;
  const paths=Array.isArray(p?.write_paths)?p.write_paths:[],full=p?.access==='write'&&paths.includes('.');
  const access=p?.access==='read'?'只读访问':full?'完整项目访问':p?.access==='write'?'指定目录访问':'访问待核对';
  $('composer-access-label').textContent=access;
  $('composer-access').dataset.access=full?'full':p?.access==='read'?'read':p?.access==='write'?'limited':'unknown';
  $('composer-access').title=access+(p?.root?' · '+p.root:'')+(p?.access==='write'&&!full&&paths.length?' · 可写：'+paths.join(', '):'');
  $('composer-add-preview').hidden=!web;$('composer-add-settings').disabled=!web;
  const queued=verified&&Array.isArray(view.next_round?.messages)?view.next_round.messages.map(note=>({seq:'next-'+note.id,kind:'host_user_note',data:{text:note.text},delivery:view.next_round.state||'pending',withdraw:note.withdrawable?{request_id:note.request_id,note_id:note.id}:null})):[];
  const waiting=verified?[...(view.events||[]).filter(row=>Number.isInteger(row.seq)&&['queued','queued_note'].includes(row.delivery)&&['user_message','host_user_note'].includes(row.kind)&&(!view.next_round||row.kind!=='host_user_note')),...queued]:[];
  const uncertain=web&&!!state.pendingObjective;
  const signature=JSON.stringify([p?.id,view.thread_id,state.connectionGeneration,rendererConnectionEpoch,workflowEpoch,ready,uncertain?state.pendingObjective:'',waiting.map(row=>[row.seq,row.kind,row.data?.text,row.delivery,row.withdraw])]);
  if(signature!==composerContextSignature){
    composerContextSignature=signature;const keep=new Set(),nodes=[];
    const rows=[...(uncertain?[{seq:'original-submit',uncertain:true,data:{text:state.pendingObjective}}]:[]),...waiting];
    for(const row of rows){
      const key=p.id+':'+view.thread_id+':'+row.seq;keep.add(key);let entry=composerContextRows.get(key);
      if(!entry){const node=document.createElement('div');node.className='composer-pending-row';node.dataset.seq=row.seq;
        const message=document.createElement('button');message.type='button';message.className='composer-pending-message';
        const status=document.createElement('span');status.className='composer-pending-status';
        const actions=document.createElement('div');actions.className='composer-pending-actions';
        const recover=document.createElement('button');recover.type='button';recover.className='composer-pending-action';actions.append(recover);node.append(message,status,actions);
        entry={node,message,status,recover};composerContextRows.set(key,entry);}
      const context=captureTaskContext(p.id),text=String(row.data?.text||'待处理消息');
      entry.message.textContent=text.replace(/\s+/g,' ').slice(0,180);entry.message.title=text;entry.message.onclick=()=>{if(!taskContextCurrent(context))return;const event=$('events').querySelector('[data-seq="'+row.seq+'"]');if(event){event.open=true;event.scrollIntoView?.({block:'nearest'});}else $('objective').focus();};
      entry.status.textContent=row.uncertain||row.delivery==='delivery_unknown'?'发送待核对':row.delivery==='sending'?'发送中':row.delivery==='queued_note'?'待下一轮处理':row.kind==='user_message'?'待发送':'待发送 · 下一轮合并';
      entry.recover.textContent=row.uncertain?'核对提交':'撤回编辑';entry.recover.title=row.uncertain?'核对原提交回执，不创建新请求':'撤回尚未交付的原消息并放回输入框';
      entry.recover.hidden=!row.uncertain&&!(typeof row.withdraw?.request_id==='string'&&row.withdraw.request_id);
      entry.recover.disabled=!ready||busy.has('withdraw:'+p.id+':'+row.seq)||busy.has('start');
      entry.recover.onclick=()=>{if(!taskContextCurrent(context))return;entry.recover.disabled=true;return Promise.resolve(row.uncertain?once('start',()=>reconcileOriginalSubmission(context,text)):withdrawRecord(p.id,row,context)).finally(()=>{composerContextSignature='';renderComposerContext();});};nodes.push(entry.node);
    }
    for(const key of composerContextRows.keys())if(!keep.has(key))composerContextRows.delete(key);
    const container=$('composer-pending');for(const node of Array.from(container.childNodes))if(!nodes.includes(node))node.remove();
    for(const [index,node]of nodes.entries())if(container.childNodes[index]!==node)container.insertBefore(node,container.childNodes[index]||null);
  }
  $('composer-pending').hidden=!web||(!waiting.length&&!uncertain);$('composer-context').hidden=!hasGoal&&$('composer-pending').hidden;
  resizeComposer();
}
function showNotice(message,{preservePending=false,scope=globalConnectionNotice(message)?'global':'task',owner=captureNoticeContext()}={}){
  if(message&&scope!=='global'&&!noticeContextCurrent(owner))return;
  if(!preservePending)pendingStateNotice=null;
  const labels={chat_page_required:'网页正在加载或等待登录，请查看对话网页。',managed_resume_successor_instead:'这个对话已交接，请打开后继任务继续。'};
  message=CLWRuntimeAvailability.notice(message)||labels[message]||message;
  noticeOwner=message&&scope!=='global'?owner:null;
  $('notice-text').textContent=message||'';$('notice').hidden=!message;scheduleLayout();
}
async function act(action,payload={}){
  const noticeContext=Object.hasOwn(payload,'id')?captureNoticeContext(payload.id):captureNoticeContext();
  const scoped=['inspect','adopt-model','configure-intake','pause','resume','enroll','goal-read','goal-save','goal-review','goal-discard','goal-stop','goal-continue','pick-context','reconcile-submission','withdraw'].includes(action);
  let context;
  if(scoped){
    const id=Object.hasOwn(payload,'id')?payload.id:current()?.id;
    payload={...payload,id};context=captureTaskContext(id);
    if(['pause','resume'].includes(action)&&!Object.hasOwn(payload,'expected_request_id')){
      const p=state.pages.find(page=>page.id===id),latest=taskView(p).request||p?.latest_request;
      payload.expected_request_id=['queued','processing','suspended'].includes(latest?.phase)?latest.id:null;
    }
  }
  try{return await interactiveCommand(action,payload);}
  catch(error){
    const message=error.message.replace(/^Error invoking remote method '[^']+': Error: /,'');
    const labels={model_control_not_found:'网页尚未显示模型菜单，请等页面加载完成后重试。',model_menu_did_not_settle:'模型菜单未能打开，请在对话网页确认后重试。',chat_page_required:'请先完成登录，返回对话网页。',host_handoff_in_progress:'正在交接上下文，输入已保留。请打开接续任务后追加。',runtime_not_connected:'本机服务尚未连接，请稍候。',runtime_receipt_unknown_reconcile_original:'本机回执尚未确认，正在核对原操作，请勿重复提交。'};
    Object.assign(labels,{team_write_paths_required:'可写访问必须填写可写的相对目录；空白不代表整个项目。此次接入未提交。',team_write_path_forbidden:'请填写项目内的相对目录，不能使用绝对路径、.. 或目录外路径。此次接入未提交。',team_duplicate_write_path:'可写目录重复，请去掉重复项后再接入。',managed_model_wait_for_turn_end:'本轮仍在执行或等待结果。结束后才能采用新的模型设置。',managed_original_send_unconfirmed:'上一发送回执未确认，请先核对原网页，不能改变其模型归属。',managed_worker_model_inherited:'此协作者保留创建时指定或继承的设置。主控创建新 worker 时可分别指定档位。',managed_model_settings_changed:'任务设置已经变化，请重新核对。',managed_resume_request_changed:'任务已有新进展，请查看当前消息后再恢复；本次没有重新发送。'});
    labels.managed_message_already_delivering='消息已开始送达或已被主控读取，不能撤回。请通过补充要求或停止生成处理。';
    labels.managed_partial_retirement_public_turn_changed='原网页回合已变化，先重新核对；旧请求仍保留。';
    labels.managed_partial_retirement_external_jobs_not_idle='本地仍有执行或状态未明，不能收尾这条旧任务。';
    labels.managed_partial_retirement_execution_not_quiescent='工作区仍有执行占用，旧任务仍保留。';
    labels.managed_task_identity_required='请先选择明确的任务，当前操作没有发送。';
    labels.managed_task_identity_changed='任务状态已变化，请核对当前记录。此次没有重发。';
    labels.managed_task_response_stale='原操作的回包已经过期，先核对原任务与回执，不重复提交。';
    labels['首次任务已提交，请查看原回执，不要重复发送。']='首次要求已保存在原任务。若暂停且尚未发送，点击「恢复」；已有送达回执则等待本轮结果。';
    if(globalConnectionNotice(message))showNotice(labels[message]||message,{scope:'global'});
    else if(!scoped||taskContextCurrent(context))showNotice(labels[message]||message,{owner:noticeContext});return undefined;
  }
}
async function once(key,fn){
  if(busy.has(key))return;busy.add(key);
  try{return await fn();}finally{busy.delete(key);}
}
function flushStateNotice(){
  const notice=pendingStateNotice;pendingStateNotice=null;
  // A task's cleared banner cannot dismiss a separately reported service fault.
  if(notice?.text===''&&notice.scope!=='global'&&!noticeOwner&&$('notice-text').textContent)return;
  if(notice&&(notice.scope==='global'||noticeContextCurrent(notice.owner)))showNotice(notice.text,{scope:notice.scope,owner:notice.owner});
}
function renderStateImmediately(){
  if(statePaintFrame!==null)cancelAnimationFrame(statePaintFrame);
  statePaintFrame=null;statePaintPending=false;
  render();flushStateNotice();
}
function queueStateRender(){
  statePaintPending=true;
  if(document.hidden||statePaintFrame!==null)return;
  statePaintFrame=requestAnimationFrame(()=>{
    statePaintFrame=null;
    if(document.hidden)return;
    statePaintPending=false;render();flushStateNotice();
  });
}
function scheduleLayout(){
  if(document.hidden||layoutQueued)return;layoutQueued=true;
  layoutFrame=requestAnimationFrame(()=>{
    layoutQueued=false;layoutFrame=null;
    if(document.hidden)return;
    const r=$('page-host').getBoundingClientRect();
    document.body.classList.toggle('native-mode',workflowMode==='web'&&native&&!!current());
    const unobscured=!$('task-dialog').open&&!$('budget-dialog').open&&!$('quota-dialog').open&&!$('task-menu').matches(':popover-open');
    const payload={native:workflowMode==='web'&&native&&!!current()&&unobscured,codexNative:workflowMode==='codex'&&native&&!!state.codexConversation&&unobscured,details:!$('details').hidden,
      bounds:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}};
    const conversation=state.codexConversation;
    const signature=JSON.stringify([workflowMode,state.selected,current()?.id,native,payload,
      conversation&&[conversation.traceId,conversation.account,conversation.kind,conversation.tabId,conversation.pageId,conversation.url,conversation.available]]);
    if(signature===layoutSignature)return;
    layoutSignature=signature;
    void act('layout',payload).then(result=>{if(result===undefined&&layoutSignature===signature)layoutSignature='';});
  });
}
document.addEventListener('visibilitychange',()=>{
  workClock.visibility();
  layoutSignature='';
  if(document.hidden){
    if(statePaintFrame!==null)cancelAnimationFrame(statePaintFrame);
    statePaintFrame=null;
    if(layoutFrame!==null)cancelAnimationFrame(layoutFrame);
    layoutFrame=null;layoutQueued=false;
  }else{
    if(statePaintPending)renderStateImmediately();
    scheduleLayout();
  }
});
function nativeView(show){
  if(native!==show&&workflowMode==='codex'){CLWCodexTurns.invalidateTask($('codex-turns'));codexRecordSignature='';}
  native=show;$('native').classList.toggle('active',show);$('records').classList.toggle('active',!show);renderWorkspaceMode();scheduleLayout();
}
async function openCodexWeb(traceId){
  await once('codex-view',async()=>{
    const row=(state.codexWeb?.recent||[]).find(r=>r.traceId===traceId)||recordHistory.active?.rows.find(r=>r.traceId===traceId);if(!row)return;
    const owner=captureNoticeContext(),selected=codexSelected,intent=++nativeViewIntent;
    const opened=await act('codex-view-turn',{traceId});if(!opened)return;
    if(!noticeContextCurrent(owner)||workflowMode!=='codex'||codexSelected!==selected||nativeViewIntent!==intent)return;
    state.codexConversation=opened;codexSelected=CLWCodexTurns.taskKey(row);nativeView(true);render();
  });
}
function details(mode){
  if(mode==='settings'&&current()&&!current().bound){
    nativeView(false);details(null);$('first-task-options').open=true;fillSettings();$('first-task-options').scrollIntoView({block:'nearest'});return;
  }
  detailMode=mode;$('details').hidden=!mode;$('setup').hidden=mode!=='settings';$('closed-list').hidden=mode!=='closed';$('codex-setup').hidden=mode!=='codex';$('connection-setup').hidden=mode!=='connection';
  renderProcessPanel();
  $('detail-title').textContent=mode==='connection'?'连接设置':mode==='codex'?'启动与连接设置':mode==='closed'?'已关闭的任务':'任务设置';
  if(mode==='settings')fillSettings();if(mode==='closed')renderClosed();scheduleLayout();
  if(mode==='connection')void readConnectionSettings();else connectionReadSerial++;
}
function connectionError(error){
  const code=String(error?.message||error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
  const labels={connection_settings_changed:'原配置已变化。请重新读取后核对再保存。',connection_original_execution_unresolved:'仍有在途或待核对的执行；先核对原任务，连接配置没有改变。',maintenance_exit_requires_original_receipt:'原生执行尚未核销，连接配置没有改变。',connection_shared_existing_only:'共享连接只能沿用原完整配置。新安装请先准备外部 Union 与 Local-MCP 后台，或选择已有专用连接。',connection_tunnel_identity_required:'请填写完整的已有隧道标识。',connection_key_file_required:'请选择运行密钥文件的绝对路径。',connection_key_file_missing:'所选运行密钥文件不存在。',connection_tunnel_binary_required:'请选择已有隧道客户端的绝对路径。',connection_tunnel_binary_missing:'所选隧道客户端不存在。',bridge_cannot_reuse_local_mcp_tunnel:'这是已有共享隧道，不能作为专用连接另起轮询者。',bridge_shared_tunnel_identity_changed:'原共享隧道身份已变化，请核对现有后台。',connection_runtime_prerequisites_missing:'候选运行时或浏览器辅助文件不完整，请核对安装包。',connection_settings_busy:'另一项连接保存尚未结清，请先核对原配置。',connection_response_invalid:'保存回执未确认。请重新读取原配置，避免盲目重复保存。'};
  if(/^connection_execution_/.test(code))return '原执行账本尚未核验：请核对本机连接与原任务，再重新读取配置。连接配置没有改变。';
  return labels[code]||'连接设置未完成：'+code;
}
function renderConnectionFields(){
  const shared=$('connection-transport').value==='shared-mcp',waiting=busy.has('connection-save')||busy.has('connection-read');
  for(const id of ['connection-tunnel-id','connection-key-path','connection-binary-path'])$(id).readOnly=shared||waiting;
  $('connection-account').disabled=waiting;
  for(const id of ['connection-pick-key','connection-pick-binary'])$(id).disabled=shared||waiting;
  $('connection-enabled').disabled=waiting;$('connection-transport').disabled=waiting;
  $('connection-transport').querySelector('[value="shared-mcp"]').disabled=connectionSnapshot?.sharedExisting!==true;
  $('connection-settings-save').disabled=!connectionSnapshot||waiting;
  $('connection-settings-refresh').disabled=waiting;
  $('connection-shared-hint').textContent=shared?'可切换 A/B 网页账号；保留原共享连接的标识和文件引用，不会迁移或认领隧道。保存后正常退出并重开生效。':'使用外部已创建的专用连接；本页不会新建隧道或读取密钥内容。';
}
function fillConnectionSettings(snapshot){
  if(!snapshot||typeof snapshot.etag!=='string'||typeof snapshot.enabled!=='boolean'||!['A','B'].includes(snapshot.webAccount)||!snapshot.tunnel)throw Error('connection_response_invalid');
  connectionSnapshot=snapshot;$('connection-enabled').checked=snapshot.enabled;$('connection-account').value=snapshot.webAccount;
  $('connection-transport').value=snapshot.transport;
  $('connection-tunnel-id').value=snapshot.tunnel.tunnelId;$('connection-key-path').value=snapshot.tunnel.runtimeKeyFile;$('connection-binary-path').value=snapshot.tunnel.binaryPath;
  $('connection-prerequisites').textContent=snapshot.prerequisites?.browserHelper&&snapshot.prerequisites?.bun?'随包运行时与浏览器辅助文件已找到；尚不表示连接器或实际工具已核验。':'候选运行时或浏览器辅助文件尚未齐全。';
  renderConnectionFields();
}
async function readConnectionSettings(){
  if(busy.has('connection-save')||busy.has('connection-read')){connectionRefreshQueued=detailMode==='connection';return;}
  connectionRefreshQueued=false;
  const serial=++connectionReadSerial;connectionSnapshot=null;busy.add('connection-read');renderConnectionFields();
  $('connection-settings-message').textContent='正在读取原连接配置…';
  try{const snapshot=await window.clw.command('connection-read');if(detailMode!=='connection'||serial!==connectionReadSerial)return;
    fillConnectionSettings(snapshot);$('connection-settings-message').textContent=snapshot.configured?'已读取原配置；编辑不会立即改动当前连接。':'尚未保存连接；请明确选择账号与已有连接。';
  }catch(error){if(detailMode==='connection'&&serial===connectionReadSerial)$('connection-settings-message').textContent=connectionError(error);}
  finally{busy.delete('connection-read');renderConnectionFields();if(connectionRefreshQueued&&detailMode==='connection')void readConnectionSettings();}
}
$('connection-settings-open').onclick=()=>{nativeView(false);details(detailMode==='connection'?null:'connection');};
$('connection-settings-refresh').onclick=()=>readConnectionSettings();
$('connection-transport').onchange=()=>{
  if($('connection-transport').value==='shared-mcp'&&connectionSnapshot?.sharedExisting)fillConnectionSettings(connectionSnapshot);
  renderConnectionFields();
};
for(const [id,kind,target] of [['connection-pick-key','key','connection-key-path'],['connection-pick-binary','binary','connection-binary-path']])$(id).onclick=async()=>{
  const serial=connectionReadSerial,result=await act('connection-pick-file',{kind});
  if(result?.path&&serial===connectionReadSerial&&detailMode==='connection')$(target).value=result.path;
};
$('connection-settings-form').onsubmit=async event=>{
  event.preventDefault();if(!connectionSnapshot||busy.has('connection-save')||busy.has('connection-read'))return;
  const serial=connectionReadSerial,payload={expected_etag:connectionSnapshot.etag,enabled:$('connection-enabled').checked,webAccount:$('connection-account').value,transport:$('connection-transport').value,
    tunnel:{tunnelId:$('connection-tunnel-id').value.trim(),runtimeKeyFile:$('connection-key-path').value.trim(),binaryPath:$('connection-binary-path').value.trim()}};
  busy.add('connection-save');renderConnectionFields();
  try{const result=await window.clw.command('connection-save',payload);
    if(result?.state!=='connection_settings_saved'||result.modelSends!==0||result.reopenRequired!==true)throw Error('connection_response_invalid');
    if(serial===connectionReadSerial&&detailMode==='connection'){fillConnectionSettings(result.settings);$('connection-settings-message').textContent=result.selectionApplies==='next_startup'?
      '下次启动账号已保存为 '+result.nextStartupAccount+'；当前连接与任务仍用原账号。正常退出并重新打开后生效。没有启动服务或发送模型消息。':
      '已保存；正常退出并重新打开后初始化。没有启动服务或发送模型消息。';}
  }catch(error){if(serial===connectionReadSerial&&detailMode==='connection'){
    if(/connection_settings_changed|connection_response_invalid|receipt_unknown|reconcile_original/.test(String(error?.message||error)))connectionSnapshot=null;
    $('connection-settings-message').textContent=connectionError(error);
  }}
  finally{busy.delete('connection-save');renderConnectionFields();if(connectionRefreshQueued&&detailMode==='connection')void readConnectionSettings();}
};
function selectedAccess(){
  const access=$('access').value;
  return {access:access==='full'?'write':access,write_paths:access==='full'?['.']:access==='write'?$('write-paths').value.split(/[,，]/).map(x=>x.trim()).filter(Boolean):[]};
}
function unsavedEnrollmentSettings(){
  const p=current();if(!p||p.bound||settingsPageId!==p.id)return false;
  const settings=p.firstTurnOptions||p;
  const access=settings.access==='write'&&settings.write_paths?.length===1&&settings.write_paths[0]==='.'?'full':settings.access||'full';
  const paths=(settings.write_paths||[]).filter(x=>x!=='.').join(', ');
  return $('first-task-options').open||$('title').value!==(p.draft?(p.taskTitle||''):p.title)||$('access').value!==access||$('write-paths').value!==paths||
    optionalNumber($('hours'))!== (settings.duration_seconds==null?null:settings.duration_seconds/3600)||
    optionalNumber($('budget'))!==(settings.max_dispatches??null);
}
function fillSettings(){
  const p=current();if(!p)return;
  const locked=p.bound||p.enrolling;
  if(settingsPageId!==p.id||locked){$('title').value=p.draft?(p.taskTitle||''):p.title;$('root').value=p.root||'';}
  $('root').readOnly=!p.draft;$('first-browse-root').hidden=!p.draft;
  const enrollmentView=enrollmentState(p,modelDrafts.get(p.id)),shown=enrollmentView.selection;
  $('model-label').textContent=enrollmentView.label;
  $('model').value=shown.model||'';$('effort').value=shown.effort||'';
  if(settingsPageId!==p.id||locked)$('collaboration-protocol').value=locked?(p.collaboration_protocol==='text_v1'?'text_v1':'tool_v1'):((protocolDrafts.get(p.id)||p.firstTurnOptions?.collaboration_protocol)==='text_v1'?'text_v1':'tool_v1');
  if(locked&&protocolDrafts.delete(p.id))saveProtocolDrafts();
  if(settingsPageId!==p.id||locked){const settings=locked?p:(p.firstTurnOptions||p);$('collaboration-enabled').checked=!locked&&collaborationDrafts.has(p.id)?collaborationDrafts.get(p.id)===true:settings.collaboration_enabled===true;}
  if(locked&&collaborationDrafts.delete(p.id))saveCollaborationDrafts();
  if(settingsPageId!==p.id||p.bound){const settings=locked?p:(p.firstTurnOptions||p);$('access').value=settings.access==='write'&&settings.write_paths?.length===1&&settings.write_paths[0]==='.'?'full':settings.access||'full';$('write-paths').value=(settings.write_paths||[]).filter(x=>x!=='.').join(', ');$('hours').value=settings.duration_seconds==null?'':settings.duration_seconds/3600;$('budget').value=settings.max_dispatches??'';settingsPageId=p.id;}
  $('write-paths-field').hidden=$('access').value!=='write';
  $('write-paths').required=$('access').value==='write';
  const repair=!!p.intake?.can_edit_scope;
  $('title').readOnly=locked;
  for(const id of ['access','write-paths','hours','budget','enroll','collaboration-protocol','collaboration-enabled'])$(id).disabled=locked;
  if(repair)for(const id of ['access','write-paths','enroll'])$(id).disabled=false;
  updateProtocolHelp(p);
  $('inspect').disabled=!!p.enrolling||busy.has('inspect');$('inspect').textContent=p.bound?'重新核对网页模型':'读取网页模型';
  $('adopt-model').hidden=!p.bound||!!p.parent;
  $('adopt-model').disabled=!modelDrafts.has(p.id)||busy.has('adopt-model')||['processing','suspended'].includes(taskView()?.request?.phase);
  $('enroll').hidden=!repair;
  document.querySelector('#settings-form .model-card').hidden=!p.bound;
  $('bootstrap-policy').hidden=!p.bound;$('model-policy').hidden=!p.bound;
  $('initial-limits').hidden=!!p.bound;
  const preparing=!!(p.first_turn_instructions||firstTurnDrafts.get(p.id)||p.firstTurnDraft||'').trim();
  $('enroll').textContent=p.bound?'已接入':p.enrolling?(p.attention||p.paused?'接入未完成':preparing?'正在接入并工作…':'正在接入…'):(preparing?'接入并工作':'仅接入')+' · '+(shown.effort||'待核对')+' · 1 条消息';
  if(repair)$('enroll').textContent='保存访问范围 · 不发送消息';
  const enrollment=p.bootstrap_model_selection;
  $('bootstrap-policy').textContent=p.bound?(enrollment?'首次接入使用：'+[enrollment.model,enrollment.effort].join(' · ')+'。后续使用工作模型；新协作者的接入档位按其实际首轮合同核对。':'旧任务未记录接入档位，不推测过去的模型。'):p.enrolling?'本轮接入使用：'+[shown.model,shown.effort].filter(Boolean).join(' · ')+'。已发送的回合不随工作模型设置改变。':'仅接入选极高；完整研究或开发任务按所选 Pro 执行，与接入合并为一条消息。当前按钮显示本轮实际采用的档位。';
  $('bootstrap-policy').classList.remove('model-warning');
  $('model-policy').textContent=p.enrolling?enrollmentView.next+'。本轮结束后才核对并切换；切换不发送消息。':p.bound?'任务采用：'+[p.model,p.effort].filter(Boolean).join(' · ')+'。采用网页新设置后，对后续轮次和新 worker 生效；已有 worker 保留自己的设置，不会自动恢复暂停任务。':'网页改档后，请重新读取确认。不会自动改用其他档位。';
  $('setup-hint').textContent=p.bound?'已接入项目。切换工作模型无需重新接入；目标与公开交接从工作记录发送。':p.enrolling&&(p.attention||p.paused)?'接入已暂停。原消息保留；先核对错误原因，不会自动重发接入命令。':p.enrolling?'下方显示本轮接入档位及接入后的工作档位。':'选择本次任务模型；接入和首个任务会一并发送。';
}
function updateProtocolHelp(p=current()){
  if(!p)return;
  const enabled=$('collaboration-enabled').checked;
  $('collaboration-mode-field').hidden=!enabled;
  if(!enabled){$('collaboration-protocol-help').textContent='默认只使用当前对话。开启后由主控自主分工。';return;}
  const text=$('collaboration-protocol').value==='text_v1',locked=p.bound||p.enrolling;
  $('collaboration-protocol-help').textContent=locked
    ? '本任务'+(p.enrolling?'接入时已锁定为':'已固定为')+(text?'简洁协作实验版':'原有工具模式')+'。协作方式不能在这里切换。'
    : text?'实验版让主控用结构化文本提出分工；文件与命令仍受原有权限约束。仅首次接入时生效，选择本身不发送消息。'
      :'沿用当前工具协作方式。旧任务保持原模式；首次接入后固定，选择本身不发送消息。';
}
function displayTaskStatus(p){
  const availability=CLWRuntimeAvailability.presentation(state);
  if(availability.blocked&&!availability.loading&&p.kind!=='account')return {label:p.paused?'已暂停 · 连接待处理':'原回执待核对 · 连接未就绪',dot:'paused'};
  return CLWWorkflow.taskStatus(p,state.connected);
}
function status(p){return displayTaskStatus(p).label;}
function button(label,className,click,title){
  const b=document.createElement('button');b.type='button';b.className=className;b.textContent=label;b.onclick=click;
  if(title){b.title=title;b.setAttribute('aria-label',title);}return b;
}
function activeWorker(p){
  const observation=p.observation||{};
  return ['queued','processing','suspended'].includes(p.latest_request?.phase)||
    p.status==='running'||p.work_model_pending||(!p.paused&&p.enrolling)||
    !!(observation.generating||observation.draft||observation.composing||observation.approvalRequired);
}
function renderNav(){
  const query=$('search').value.trim().toLowerCase();
  const signature=JSON.stringify([state.root,current()?.id,state.pages.map(p=>{
    const task=displayTaskStatus(p),phase=enrollmentState(p);
    return [p.id,p.title,p.root,p.parent,p.kind,p.automaticWorkspace,p.selected,p.account,p.collaboration_protocol,task.label,task.dot,phase.nav,phase.next,activeWorker(p)];
  }),query,[...navWorkersExpanded]]);
  if(signature===navSignature)return;navSignature=signature;
  const scroll=$('pages').scrollTop;$('pages').replaceChildren();const groups=new Map();
  const byId=new Map(state.pages.map(p=>[p.id,p]));
  for(const p of state.pages.filter(p=>(p.parent&&p.id===current()?.id)||(p.title+' '+(p.root||'')).toLowerCase().includes(query))){
    const parent=byId.get(p.parent),root=parent?.root||p.root;const key=p.kind==='account'?'@account':(parent||p).automaticWorkspace?'@tasks':root?projectKey(root):'@direct';
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p);
  }
  if(!groups.size){const e=document.createElement('p');e.className='empty';e.textContent=query?'没有匹配的任务。':'还没有打开的任务。';$('pages').append(e);}
  for(const [root,pages] of groups){
    const group=document.createElement('section');group.className='project-group';
    const heading=document.createElement('div');heading.className='project-heading';
    const label=document.createElement('span');label.className='project-label';label.textContent=root==='@account'?'账号与连接':root==='@tasks'?'任务':root==='@direct'?'直接对话':'▱ '+basename(root);label.title=root==='@account'?'登录网页':root==='@tasks'?'CLW 自动准备的独立工作区':root==='@direct'?'未绑定项目；可以直接发送需求':'工作目录：'+root;
    heading.append(label);
    if(!root.startsWith('@'))heading.append(button('···','icon',()=>act('project-menu',{root}),'项目操作：'+basename(root)));
    group.append(heading);
    const inactive=pages.filter(p=>p.parent&&!activeWorker(p));
    const expanded=navWorkersExpanded.has(root);
    for(const p of pages.filter(p=>!p.parent||activeWorker(p)||p.id===current()?.id||query||expanded)){
      const row=document.createElement('div');row.className='task-row'+(p.selected?' selected':'')+(p.parent?' worker':'');row.dataset.pageId=p.id;
      const select=button('','task-select',()=>selectTask(p.id));
      select.setAttribute('aria-label','打开任务：'+p.title);select.setAttribute('aria-current',p.selected?'page':'false');
      const dot=document.createElement('span');dot.className='dot '+displayTaskStatus(p).dot;
      const labels=document.createElement('span');labels.className='task-label';
      const title=document.createElement('span');title.className='task-title';title.textContent=p.title;
      const subtitle=document.createElement('small');subtitle.className='task-status';const phaseModel=enrollmentState(p);subtitle.textContent=status(p)+(phaseModel.nav?' · '+phaseModel.nav:'');subtitle.title=[p.parent?'协作者':'主控','账号 '+(p.account||'B'),phaseModel.next,p.collaboration_protocol==='text_v1'?'简洁协作实验版':'工具协作'].filter(Boolean).join(' · ');
      labels.append(title,subtitle);select.append(dot,labels);row.append(select);
      row.append(button('···','task-more',()=>act('task-menu',{id:p.id}),'任务操作：'+p.title));
      row.append(button('×','task-close',()=>closeTask(p.id),'移出列表并保留现场：'+p.title));
      row.oncontextmenu=event=>{event.preventDefault();void act('task-menu',{id:p.id});};group.append(row);
    }
    if(inactive.length&&!query){
      const toggle=button(expanded?'收起协作者记录':'协作者记录 · '+inactive.length,'worker-toggle quiet',()=>{
        if(navWorkersExpanded.has(root))navWorkersExpanded.delete(root);else navWorkersExpanded.add(root);
        renderNav();
      });
      toggle.setAttribute('aria-expanded',String(expanded));group.append(toggle);
    }
    $('pages').append(group);
  }
  $('pages').scrollTop=scroll;
  if(navSelected!==current()?.id){navSelected=current()?.id;$('pages').querySelector('.selected')?.scrollIntoView({block:'nearest'});}
}
function renderClosed(){
  const signature=JSON.stringify(state.closed);if(signature===closedSignature)return;closedSignature=signature;
  $('closed-list').replaceChildren();
  const hint=document.createElement('p');hint.className='scope-hint';hint.textContent='删除本机记录不会删除成果文件或 ChatGPT 原对话。若也要删除网页对话，请先重新打开，在原网页菜单中删除，再回这里清理记录。';$('closed-list').append(hint);
  if(!state.closed.length){const e=document.createElement('p');e.className='empty';e.textContent='关闭的任务会保留在这里，随时可以重新打开。';$('closed-list').append(e);return;}
  for(const p of state.closed){
    const row=document.createElement('div');row.className='closed-item';
    const name=document.createElement('strong');name.textContent=p.title;
    const root=document.createElement('p');root.textContent=p.kind==='account'?'账号连接':p.root||state.root;
    const actions=document.createElement('div');actions.className='closed-actions';
    actions.append(button('重新打开网页','secondary',()=>once('reopen:'+p.id,async()=>{
      const owner=captureNoticeContext(),r=await act('reopen',{id:p.id});
      if(r&&workflowMode===owner.workflow&&workflowEpoch===owner.workflowEpoch&&current()?.id===p.id){details(null);nativeView(true);showNotice('任务已重新打开。已暂停的工作需点击「恢复」。');}
    }),'重新打开：'+p.title),button('删除本机记录…','quiet danger-text',()=>showDialog({kind:'delete',id:p.id,title:'删除「'+p.title+'」的本机记录？',description:'将从 CLW 列表中永久移除，不能重新打开。项目文件、成果、执行回执和 ChatGPT 原对话保留。网页对话若也要删除，请取消后先重新打开网页操作。',confirm:'删除本机记录'})));
    row.append(name,root,actions);$('closed-list').append(row);
  }
}
const recordLabels={host_queued:'消息已进入本地队列 · 尚未发送',host_claimed:'本地已登记任务受理',control_dispatch:'正在发送到网页',control_not_sent:'本次尚未发送',control_received:'网页已确认收到',host_result:'本轮结果已保存',host_turn_yielded:'本轮已进入结果等待',host_turn_attention:'本轮需要处理 · 查看具体原因',host_parent_resumed:'已接续原任务',host_delegated:'已分派工作',host_child_result:'协作者结果已到达',host_waiting_children:'正在等待协作者结果',managed_model_changed:'后续轮次的模型设置已更新',managed_budget_refilled:'后续发送预算已更新'};
const userRecordKinds=new Set(['user_message','host_user_note','managed_preparation_requested','managed_first_task_requested']);
const replyRecordKinds=new Set(['assistant_message','managed_preparation_reply','managed_first_task_public_reply']);
function eventRecordText(event){
  if(event.kind==='host_result'&&event.data?.reason==='operator_withdrew_unsent_goal')return '';
  if(event.kind==='host_result'&&event.data?.source==='controller_settled_parked_branch')return '本批受阻任务已收尾，原始回执保留。';
  if(event.kind==='host_result'&&event.data?.source==='operator_retired_partial_public_send')return '仅部分送达的旧回合已受阻留档，原消息没有重发。';
  return event.data?.text||recordLabels[event.kind]||'';
}
function eventBody(event,active,{latest=false}={}){
  const view=recordView(active.key),remote=event.body_loaded===false;
  return CLWWorkRecord.body(eventRecordText(event),{length:event.full_length_known===false?null:event.text_length??null,
    expanded:typeof view.folds['body:'+event.seq]==='boolean'?view.folds['body:'+event.seq]:latest,
    onBeforeLayout:()=>{if(recordHistory.active?.key===active.key&&recordHistory.active.following===false)captureReadingLayout();},
    onToggle:open=>{recordFold(active.key,'body:'+event.seq,open);requestAnimationFrame(applyReadingLayout);},
    load:remote?async()=>{const full=await recordHistory.body(event,active.key);if(typeof full.data?.text!=='string')throw Error('完整正文暂不可用。');return full.data.text;}:null});
}
function messageRecord(event,active,defaultOpen){
  const node=document.createElement('details');node.className='message record-message';node.dataset.recordKey='event:'+event.seq;node.dataset.seq=event.seq;
  const summary=document.createElement('summary'),meta=document.createElement('div');meta.className='message-meta';
  const who=document.createElement('strong'),badge=document.createElement('span'),time=document.createElement('time'),sample=document.createElement('span');sample.className='record-message-preview';meta.append(who,badge,time);summary.append(meta,sample);
  const pane=document.createElement('div');pane.className='record-message-content';node.append(summary,pane);
  const entry={node,who,badge,time,sample,pane,event,mounted:false,bodySignature:null,autoOpen:false};
  const saved=recordView(active.key).folds[node.dataset.recordKey];
  if(userRecordKinds.has(event.kind)&&Math.max(event.text_length||0,eventRecordText(event).length)>1900)defaultOpen=false;
  node.open=typeof saved==='boolean'?saved:defaultOpen;
  entry.autoOpen=typeof saved!=='boolean'&&defaultOpen;summary.addEventListener('click',()=>{entry.autoOpen=false;});
  entry.mount=()=>{if(!node.open||entry.mounted||entry.event.delivery==='withdrawn')return;entry.mounted=true;
    pane.append(eventBody(entry.event,active,{latest:active.live&&replyRecordKinds.has(entry.event.kind)&&entry.event.seq===active.rows.filter(row=>replyRecordKinds.has(row.kind)).at(-1)?.seq}));};
  node.addEventListener('toggle',()=>{recordFold(active.key,node.dataset.recordKey,node.open);
    if(node.open)entry.mount();else{pane.querySelectorAll('.record-body').forEach(body=>body.dispose?.());pane.replaceChildren();entry.mounted=false;}
  });
  const undo=button('撤回','withdraw-message',async()=>{
    if(!entry.event.withdraw)return;undo.disabled=true;
    try{return await withdrawRecord(active.id,entry.event,entry.withdrawContext);}finally{undo.disabled=false;}
  },'撤回尚未交付的消息');
  const withdraw=undo.onclick;undo.onclick=event=>{event?.preventDefault();event?.stopPropagation();return withdraw();};meta.append(undo);entry.undo=undo;
  entry.update=row=>{
    entry.event=row;entry.withdrawContext=captureTaskContext(active.id);const isUser=userRecordKinds.has(row.kind),withdrawn=row.delivery==='withdrawn';
    node.className='message record-message'+(isUser?' user-message':'')+(withdrawn?' withdrawn-message':'');
    who.textContent=withdrawn?(row.kind==='host_user_note'?'补充已撤回':'消息已撤回'):row.kind==='managed_first_task_requested'?'你 · 首个任务':row.kind==='managed_preparation_requested'?'你 · 首次准备':row.kind==='managed_preparation_reply'?'网页 · 首次准备回复':isUser?(row.kind==='host_user_note'?'你 · 补充':'你 · 消息'):'模型 · 回复';
    const delivery=deliveries[row.delivery];badge.hidden=!delivery;badge.className='delivery '+(delivery?.[1]||'');badge.textContent=delivery?.[0]||'';
    time.textContent=row.at?new Date(row.at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
    sample.textContent=withdrawn?'':eventRecordText(row).replace(/\s+/g,' ').slice(0,180);
    undo.hidden=!row.withdraw||withdrawn;undo.disabled=false;
    const bodySignature=JSON.stringify([active.thread,row.kind,row.data?.text,row.data?.reason,row.data?.source,row.body_loaded,row.text_length,row.full_length_known,row.bodyRevision,row.body_revision,withdrawn]);
    if(bodySignature!==entry.bodySignature){entry.bodySignature=bodySignature;entry.mounted=false;pane.querySelectorAll('.record-body').forEach(body=>body.dispose?.());pane.replaceChildren();}
    if(withdrawn){node.open=false;pane.replaceChildren();entry.mounted=false;}else entry.mount();
  };
  entry.update(event);return entry;
}
function renderEvents(){
  if(workflowMode!=='web'||native)return;
  const p=current(),projection=taskView()?.page_id===p?.id?taskView():null;
  const active=activateRecords(p?.bound&&projection?{mode:'web',id:p.id,thread:projection.thread_id,capable:state.recordHistory?.web||!!projection.record_history}:null,projection?.events||[],projection?.record_history);
  renderRecordToolbar();
  if(!active){if(recordRenderedKey!==null){$('events').replaceChildren();webRecordNodes.clear();recordRenderedKey=null;eventsSignature='';}return;}
  const signature=JSON.stringify([active.key,active.rows,active.intent?.serial]);if(signature===eventsSignature)return;eventsSignature=signature;
  const scroller=$('conversation'),changed=recordRenderedKey!==active.key,previous=changed?null:recordAnchor(scroller);
  const follow=changed||(Number(scroller.scrollHeight)||0)-(Number(scroller.clientHeight)||0)-(Number(scroller.scrollTop)||0)<80;
  if(changed){$('events').replaceChildren();webRecordNodes=new Map();recordRenderedKey=active.key;recordIntentSerial='';}
  eventsPageId=p.id;
  const descriptors=[];
  for(const row of active.rows){if(!eventRecordText(row)&&row.delivery!=='withdrawn')continue;
    if(userRecordKinds.has(row.kind)||replyRecordKinds.has(row.kind))descriptors.push({key:'event:'+row.seq,event:row});
  }
  const retained=new Set();let cursor=$('events').firstChild;
  for(const descriptor of descriptors){retained.add(descriptor.key);let entry=webRecordNodes.get(descriptor.key);
    if(!entry){entry=messageRecord(descriptor.event,active,true);webRecordNodes.set(descriptor.key,entry);}
    else entry.update(descriptor.event);
    if(entry.node!==cursor)$('events').insertBefore(entry.node,cursor);cursor=entry.node.nextSibling;
  }
  for(const [key,entry]of webRecordNodes)if(!retained.has(key)){entry.node.remove();webRecordNodes.delete(key);}
  restoreRecordScroll(active,previous,follow,changed);
}
function renderWorkflow(p){
  if(workflowMode!=='web')return;
  const f=workflow(p,taskView()||{},state.connected),m=modelState(p);
  if(taskView().state_read?.unavailable){f.title+=' · 记录待更新';f.detail+=' 最近一次记录读取未完成，正在沿原任务恢复。原记录可查看；核对完成前暂停界面发送，不影响已接受的执行。';}
  $('workflow').hidden=!p||(p.kind==='task'&&!p.bound&&!p.enrolling);$('workflow').dataset.tone=f.tone;$('workflow-title').textContent=f.title;$('workflow-detail').textContent=f.detail;
  const observationNotice=f.observationNotice,observationText=observationNotice?[observationNotice.title,observationNotice.detail].filter(Boolean).join('。'):'';
  $('workflow-observation').hidden=!observationText;if($('workflow-observation').textContent!==observationText)$('workflow-observation').textContent=observationText;
  if(workflowMode==='web')workflowDisclosure('web:'+p?.id+':'+f.key,f.tone==='warning'||f.tone==='warn');
  [...$('workflow-steps').children].forEach((step,i)=>{step.classList.toggle('current',i===f.step);step.classList.toggle('done',i<f.step);step.setAttribute('aria-current',i===f.step?'step':'false');});
  $('workflow-time').textContent=taskView()?.attempt?.acknowledged?'本对话累计 '+(taskView()?.send_stats?.confirmed??taskView()?.turns??1)+' 次确认送达；本轮用时从确认送达开始，需求历时另含排队与等待。':taskView()?.request?'消息已进入本地队列 · 尚未确认送达。':'';
  $('model-difference').hidden=!p?.bound||!m.mismatch;
  $('model-difference-text').textContent='任务采用 '+m.expected+'　·　网页显示 '+m.actual;
  const action=$('workflow-action');action.hidden=!CLWTaskPresentation.needsWorkflowAction(p,taskView(),f,m,!!$('objective').value.trim());
  const unsentRequest=CLWTaskPresentation.unsentResumeRequest(p,taskView(),f,m),unsentGeneration=state.connectionGeneration;
  const resumeRelevant=CLWTaskPresentation.resumeRelevant(p,taskView(),{flow:f,model:m,draft:$('objective').value});
  const canContinue=(p?.bound?resumeRelevant:p?.enrolling&&p.bootstrap_state==='pending')&&p.paused&&!m.mismatch&&!p.pause_origin?.inherited&&!['approval_required','account_cooldown','team_paused','team_pausing'].includes(f.key)&&(!taskView()?.request||!p.attention||!!unsentRequest);
  if(f.key==='partial_public_send'){
    actionLabel(action,'核对并收尾','reconcile');
    action.onclick=()=>once('retire-partial:'+p.id,async()=>{
      const owner=captureNoticeContext(p.id);
      const original=taskView()?.partial_public_send;if(!original)return;
      if(!window.confirm('当前网页只收到部分消息。核对后将旧任务记为受阻，保留原始记录；不会重发，也不会记作成功。继续？'))return;
      const result=await act('retire-partial',{id:p.id,request_id:original.request_id,
        attempt_id:original.attempt_id,observation_hash:original.observation_hash,
        reason:'操作员核对当前公开网页回合与原本地记录后，将部分送达的旧请求留档为受阻。',confirm:true});
      if(result){showNotice('旧任务已受阻留档，原消息没有重发；主控可安排新工作。',{owner});render();}
    });
  }else{
    const newDraftOnly=canContinue&&!taskView()?.request&&!!$('objective').value.trim()&&!taskView()?.pending_notes&&!taskView()?.next_round?.count&&!taskView()?.goal?.configured;
    actionLabel(action,f.actionPage?'打开主控':f.key==='setup'?'接入项目':f.key==='successor'?'打开接续':canContinue?(taskView()?.run?.state==='draining'?'恢复并收尾':newDraftOnly?'解除暂停':'恢复自动推进'):m.mismatch?'核对模型':f.key==='approval_required'?'查看网页确认':f.key==='login_required'?'打开登录网页':'查看原网页',canContinue?'resume':'view');
    if(newDraftOnly)action.title='解除这条对话的后续发送暂停。草稿保留，点击发送消息后才会发送。';
    action.onclick=()=>f.actionPage?selectTask(f.actionPage):f.key==='setup'?details('settings'):f.key==='successor'?selectTask(p.successor):canContinue?act('resume',{id:p.id,...(unsentRequest?{expected_request_id:unsentRequest,...(Number.isInteger(unsentGeneration)?{expected_connection_generation:unsentGeneration}:{})}:{})}):m.mismatch?details('settings'):nativeView(true);
  }
  const workers=state.pages.filter(x=>x.parent===p?.id);$('worker-status').hidden=!workers.length;
  const signature=JSON.stringify([p?.id,workflowDetailOpen,workers.map(child=>[child.id,child.title,status(child),child.model,child.effort])]);
  if(workflowDetailOpen&&signature!==workersSignature){
    workersSignature=signature;$('worker-status').replaceChildren();
    for(const child of workers){const b=button(child.title+' · '+status(child),'worker-chip',()=>selectTask(child.id));b.title=[child.model,child.effort].filter(Boolean).join(' · ');$('worker-status').append(b);}
  }
}
function renderPrimaryStop(p=current()){
  const o=p?.observation||{},value=Number(o.at??o.observed),at=value<1e12?value*1000:value,age=Date.now()-at;
  const visible=workflowMode==='web'&&!!p?.bound&&!p.successor&&o.generating===true&&!o.error&&
    Number.isFinite(at)&&age>=0&&age<=30000;
  $('composer-stop').hidden=!visible||!!$('objective').value.trim();
  $('composer-stop').disabled=busy.has('dialog')||busy.has('stop-generation');
  $('start').hidden=!$('composer-stop').hidden;
  return visible;
}
// History is a fixed local-cache view. Retire old controls without retaining
// click/change handlers that could start a remote read from an older shell.
$('quota-history-check')?.closest('.quota-usage-controls')?.remove();
$('quota-check')?.remove();
function renderQuota(){
  const account=$('quota-account').value;
  const q=(state.quotas||[]).find(q=>q.account===account);
  const selectedAccount=workflowMode==='codex'?(state.codexWeb?.account||'B'):(current()?.account||'B');
  $('quota-summary').textContent=CLWQuotaView.summary((state.quotas||[]).find(q=>q.account===selectedAccount));
  if(!$('quota-dialog').open)return;
  CLWQuotaView.render($('quota-models'),q);
  CLWQuotaView.renderHistory($('quota-history'),state.quotas||[]);
  $('quota-history-message').textContent='本机保存信息，不联网读取。统计按完成的 Pro 回复计数，不是官方剩余额度。手动标记仅保存到本机。';
  const stats=taskView()?.send_stats,p=state.pages.find(p=>p.id===state.selected);
  $('quota-local').textContent=workflowMode==='web'&&p?.account===account&&stats?'当前任务本地确认发送 '+stats.confirmed+' 次（含接入），待核对 '+stats.unconfirmed+' 次；不是账号官方用量。':'本地发送数见各任务记录；不把近期记录数量当成全账号用量。';
}
$('quota-open').onclick=()=>{nativeView(false);$('quota-account').value=workflowMode==='codex'?(state.codexWeb?.account||'B'):(state.pages.find(p=>p.id===state.selected)?.account||'B');$('quota-dialog').showModal();renderQuota();};
$('quota-close').onclick=()=>$('quota-dialog').close();
$('quota-account').onchange=()=>{$('quota-message').textContent='';renderQuota();};
async function quotaAction(action,payload){
  if(action!=='quota-report')return;
  if(busy.has('quota'))return;busy.add('quota');
  try{await interactiveCommand(action,{account:$('quota-account').value,...payload});$('quota-message').textContent='已保存到本机。';}
  catch(e){$('quota-message').textContent=e.message;}
  finally{busy.delete('quota');renderQuota();}
}
$('quota-exhausted').onclick=()=>quotaAction('quota-report',{model:$('quota-report-model').value,exhausted:true,resetText:$('quota-reset').value});
$('quota-clear').onclick=()=>quotaAction('quota-report',{model:$('quota-report-model').value,exhausted:false});
function render(){
  renderInteractionFeedback();
  renderExitFeedback();
  const readingPage=current(),missingRecords=!!readingPage?.bound&&taskView().page_id!==readingPage.id;
  const unavailableRecords=!!taskView().state_read?.unavailable||
    (state.selectedRecords?.page_id===readingPage?.id&&['unavailable','idle'].includes(state.selectedRecords?.state));
  const readingRecords=workflowMode==='web'&&!native&&!!readingPage?.bound&&state.connected===true&&state.taskStateReady!==false&&(missingRecords||unavailableRecords);
  $('record-loading').hidden=!readingRecords;$('record-loading').setAttribute('aria-busy',String(readingRecords&&!unavailableRecords));
  $('record-loading-spinner').hidden=unavailableRecords;
  $('record-loading-text').textContent=unavailableRecords?'记录暂不可用，正在沿原任务恢复。草稿保留。':'正在读取当前任务记录…';
  const restoring=workflowMode==='web'&&(state.taskStateReady===false||!state.connected);
  const availability=CLWRuntimeAvailability.presentation(state);
  document.body.classList.toggle('restoring-workspace',restoring);$('workspace-loading').hidden=!restoring;
  $('workspace-loading').setAttribute('aria-busy',String(restoring&&availability.loading));$('new-page').disabled=restoring;
  $('workspace-loading-spinner').hidden=!availability.loading;
  $('workspace-loading-title').textContent=availability.title||'正在恢复工作区';
  $('workspace-loading-detail').textContent=availability.detail||'';$('workspace-loading-hint').textContent=availability.hint||'';
  const p=current(),changed=selectedId!==(p?.id||null);
  if(noticeOwner&&!noticeContextCurrent(noticeOwner))showNotice('',{preservePending:true});
  if(changed){
    taskSelectionEpoch++;
    // Feedback with a different owner was retired above; global faults remain.
    if(selectedId){drafts.set(selectedId,$('objective').value);saveDrafts();}
    selectedId=p?.id||null;$('objective').value=drafts.get(selectedId)||state.pendingObjective||'';
    $('first-task-objective').value=firstTurnDrafts.get(selectedId)??p?.firstTurnDraft??'';
    $('first-task-effort').value=firstTurnEfforts.get(selectedId)||p?.firstTurnOptions?.effort||'极高';
    $('task-prompt-preview').open=false;previewRevision++;
    $('first-model-menu').hidePopover();
    if(detailMode==='settings'){if(p?.kind==='task')fillSettings();else details(null);}
    if(workflowMode==='web')nativeView(p?.kind==='account');
  }
  if(workflowMode==='web'&&p?.bound&&!lastBound)nativeView(false);
  lastBound=!!p?.bound;
  document.body.classList.toggle('light',state.theme==='light');
  const accent=['purple','blue','amber'].includes(state.accent)?state.accent:'purple';document.body.dataset.accent=accent;
  if(document.activeElement!==$('accent-select'))$('accent-select').value=accent;
  $('thread-title').textContent=p?.title||'CLW 工作区';
  $('thread-title').title=p&&!p.draft?'双击重命名':'';
  $('connection').textContent=p?(p.kind==='account'?'账号 '+(p.account||'B')+' · 独立浏览器':(p.automaticWorkspace?'独立工作区':p.root?basename(p.root):'直接对话 · 项目可选')+' / '+(p.parent?'协作者':'主控任务')+' · 账号 '+(p.account||'B')+' · '+(p.access==='write'?(p.write_paths?.[0]==='.'?'完整项目访问':'指定目录可写'):p.access==='read'?'只读':'待接入')):(state.connected?'本机已连接':'正在连接本机…');
  if(restoring)$('connection').textContent=availability.loading?'正在恢复任务状态…':availability.title;
  renderQuota();
  $('vpn').textContent=state.network||'正在核对 VPN…';$('closed-count').textContent=String(state.closed.length);
  const bridge=state.codexWeb||{},accessHeld=bridge.accountAccess?.blocked,toolsHeld=bridge.tools?.ready===false,bridgeReady=bridge.state==='ready'&&!accessHeld&&!toolsHeld;
  $('codex-status').textContent=bridgeReady?'● 网页推理连接已就绪 · 账号 '+(bridge.account||'B'):bridge.lastError?'网页推理连接暂不可用，请查看连接设置中的诊断。':'正在等待网页推理连接就绪…';
  if(bridge.state==='unconfigured')$('codex-status').textContent='尚未初始化 Codex＋Web；在「账号与连接 → 连接设置」保存已有连接，正常重新打开后核对。';
  const bridgeFault=CLWFailure.describe(bridge.lastError);
  if(!bridgeReady&&bridgeFault)$('codex-status').textContent=bridgeFault.title+'：'+bridgeFault.detail;
  $('codex-status').classList.toggle('ready',bridgeReady);
  $('codex-current-account').textContent='当前网页推理账号：'+(bridge.account||'尚未核对')+' · '+(bridgeReady?'连接已就绪':'连接待核对');
  if(toolsHeld)$('codex-status').textContent='⏸ '+bridge.tools.message;
  $('codex-open').disabled=$('codex-resume').disabled=!bridgeReady||busy.has('codex-start');
  $('codex-check').disabled=bridge.state==='verifying_connector'||busy.has('codex-check');
  if(accessHeld){$('codex-status').textContent=bridge.accountAccess.message;$('codex-check').disabled||=!bridge.accountAccess.recheckAllowed;}
  if(workflowMode==='codex'){
  const displayNotice=CLWCodexTurns.displayIndexNotice(bridge.displayIndex);
  $('codex-record-status').hidden=!displayNotice;
  if($('codex-record-status').textContent!==displayNotice)$('codex-record-status').textContent=displayNotice;
  const catalog=bridge.recent||[],summaries=catalog.map(row=>CLWRecordHistory.summary('codex',row));
  const turnsSignature=JSON.stringify([summaries.map(row=>[row.traceId,row.source,row.status,row.submission,row.startedAt,row.nativeState,row.failure,row.review?.reportedBlockers]),bridgeReady,busy.has('codex-start'),codexSelected,$('search').value,[...codexArchives],codexArchiveView]);
  const listOptions={query:$('search').value,archived:[...codexArchives],archiveView:codexArchiveView};
  if(turnsSignature!==codexTurnsSignature){
    codexTurnsSignature=turnsSignature;
    const groups=CLWCodexTurns.taskList(summaries,listOptions);
    CLWCodexTurns.renderNavigation($('codex-pages'),summaries,{...listOptions,selected:codexSelected,onSelect:selectCodexTask});
    $('codex-workspace-title').textContent=codexSelected?'工作记录':codexArchiveView?'已归档':'任务总览';
    $('codex-workspace-description').textContent=codexSelected?'查看保存的网页回复和历史回合。目标与补充从原 Codex 发送。':'每张卡片是一项任务；打开后查看工作记录和原网页。';
    $('codex-summary').hidden=!!codexSelected;$('codex-workspace').querySelector('.workspace-intro').hidden=!!codexSelected;
    $('codex-workspace').dataset.view=codexSelected?'task':'overview';
    $('codex-back').hidden=!codexSelected;$('codex-back').textContent=codexArchiveView?'← 已归档':'← 任务总览';
    $('codex-list-label').textContent=codexSelected?'对话记录':(codexArchiveView?'归档任务':'任务')+' · '+groups.length;
    $('codex-archive-count').textContent=CLWCodexTurns.taskList(summaries,{archived:[...codexArchives],archiveView:true}).length;
    CLWCodexTurns.renderSummary($('codex-summary'),groups.flatMap(group=>group.turns));
    if(!codexSelected){CLWCodexTurns.renderOverview($('codex-turns'),groups,{archiveView:codexArchiveView,onSelect:selectCodexTask,onArchive:archiveCodexTask});codexRecordSignature='';}
  }
  if(codexSelected&&!native){
    const saved=CLWCodexTurns.filterRows(catalog,codexSelected),latest=CLWCodexTurns.groupRows(saved)[0]?.latest?.traceId;
    const active=activateRecords({mode:'codex',id:codexSelected,capable:!!state.recordHistory?.codex},saved,
      {total:saved.length,has_before:saved.length>40,has_after:false,newest_trace:latest});
    const signature=JSON.stringify([active.key,active.rows,active.intent?.serial,bridge.nativeActivity,bridgeReady,busy.has('codex-start')]);
    if(signature!==codexRecordSignature){
      codexRecordSignature=signature;
      const scroller=$('codex-workspace'),changed=recordRenderedKey!==active.key,previous=changed?null:recordAnchor(scroller);
      const follow=(Number(scroller.scrollTop)||0)<80;if(changed){recordRenderedKey=active.key;recordIntentSerial='';}
      const ownedWorkflowEpoch=workflowEpoch;
      CLWCodexTurns.renderTask($('codex-turns'),active.rows,{taskKey:active.id,latestTrace:active.meta.newest_trace||latest,
        isCurrent:()=>workflowMode==='codex'&&!native&&workflowEpoch===ownedWorkflowEpoch&&codexSelected===active.id&&recordHistory.active===active,
        folds:recordView(active.key).folds,onFold:(id,open)=>recordFold(active.key,id,open),
        ready:bridgeReady,resuming:busy.has('codex-start'),nativeActivity:bridge.nativeActivity,inlineActivity:false,
        preserveReading:active.following===false,
        loadBody:traceId=>{const row=active.rows.find(row=>row.traceId===traceId);if(!row||recordHistory.active!==active)return Promise.reject(Error('任务已切换。'));return recordHistory.body(row,active.key);},
        onView:openCodexWeb,onResume:traceId=>once('codex-start',async()=>{
          const owner=captureNoticeContext();
          render();const result=await act('codex-resume-turn',{traceId});
          if(result)showNotice('已打开原 Codex 任务，保留原网页模型。输入要求后才会发送新回合。',{owner});
        }).finally(render)});
      restoreRecordScroll(active,previous,follow,changed);
    }
  }else if(!codexSelected)activateRecords(null,[]);
  renderRecordToolbar();
  const nativeActivity=bridge.nativeActivity;
  $('codex-mcp-activity').hidden=false;
  document.querySelector('.codex-continuation-note').hidden=!!codexSelected;
  $('codex-settings').hidden=true; // The header is the single details entry.
  $('codex-status').hidden=!!codexSelected&&bridgeReady;
  const nativeActivityIssue=nativeActivity?.readFailed||nativeActivity?.unavailable||nativeActivity?.windowTruncated;
  $('codex-native-activity-status').hidden=!nativeActivityIssue;
  if(nativeActivityIssue)$('codex-native-activity-status').textContent=nativeActivity.readFailed||nativeActivity.unavailable?
    '原生工具活动记录暂不可用；已有回合和工具结果请从原 Codex 与成果核对。':
    '原生工具活动只保留近期窗口；更早回合可能没有可展示的逐步记录。';
  renderToolActivity('codex-mcp-activity',bridge.mcpActivity,'codex-overview');
  }
  renderSessionActivity();renderProcessPanel();
  $('settings').disabled=!p||p.kind==='account';$('task-menu-toggle').disabled=!p||!!p.draft;$('view-switch').hidden=!p||!!p.draft;
  const inlineSettings=!!p&&p.kind==='task'&&!p.bound;
  $('conversation').dataset.setup=String(inlineSettings);
  const settingsSlot=inlineSettings?$('first-settings-slot'):$('setup');
  if($('settings-form').parentElement!==settingsSlot)settingsSlot.insertBefore($('settings-form'),inlineSettings?null:$('setup-hint').nextSibling);
  $('first-task-options').hidden=!inlineSettings;
  if(inlineSettings)fillSettings();
  const managed=!!p?.bound||!!p?.enrolling;
  const maintenance=taskView()?.maintenance||p?.maintenance;
  const teamControl=!!taskView()?.run&&!p?.parent&&(taskView().run.state!=='closed'||!!maintenance);
  $('team-maintenance').hidden=!teamControl||(!maintenance&&!!p?.paused);
  $('team-maintenance').disabled=busy.has('team-maintenance');
  actionLabel($('team-maintenance'),maintenance?.state==='settled'?(p?.attention?'解除维护暂停':'恢复自动推进'):maintenance?.state==='holding'?'恢复自动推进':'暂停自动推进',['holding','settled'].includes(maintenance?.state)?'resume':'pause');
  $('team-maintenance').title=maintenance?.state==='holding'?'撤回等待停稳的请求，继续原有工作；已有错误和单独暂停的任务保留。':maintenance?.state==='settled'?'解除维护暂停会保留原错误和用户暂停；不会重试被拒操作或重置预算。':'停止新派发，已送达回合继续完成并保存；不发送额外模型消息。';
  $('pause').hidden=!managed||!!p?.paused;$('resume').hidden=!managed||!p?.paused||(!p?.bound&&p?.bootstrap_state!=='pending');
  if(teamControl)$('pause').hidden=true;
  // Saving a supplement never resumes accepted work. Resume has one explicit
  // menu action unless an exceptional state requires its existing recovery UI.
  $('resume').hidden=$('resume').hidden||!CLWTaskPresentation.resumeRelevant(p,taskView(),{flow:workflow(p,taskView(),state.connected),model:modelState(p),draft:$('objective').value})||!taskView()?.request||!!p?.attention||CLWTaskPresentation.needsWorkflowAction(p,taskView(),workflow(p,taskView(),state.connected),modelState(p),!!$('objective').value.trim());
  if(maintenance)$('resume').hidden=true;
  if(taskView()?.partial_public_send)$('resume').hidden=true;
  const stripControls=CLWTaskPresentation.goalControls(p,taskView(),{connected:state.connected});
  if(stripControls.toggleVisible&&stripControls.toggleEnabled){$('pause').hidden=true;$('resume').hidden=true;if(!maintenance)$('team-maintenance').hidden=true;}
  const stopVisible=renderPrimaryStop(p);
  $('stop-generation').hidden=!managed||!!p?.successor||!stopVisible||!$('composer-stop').hidden;
  actionLabel($('resume'),p?.successor?'打开接续':'恢复自动推进',p?.successor?'view':'resume');
  actionLabel($('pause'),'暂停自动推进','pause');
  $('pause').title='只停止后续自动派发；当前网页、原生工具和已受理任务继续工作并保存结果。';
  $('resume').title='恢复后续自动推进，先核对原回执；不重做已受理的工作。';
  $('automation-control-note').textContent=maintenance||p?.paused?(taskView()?.request?'后续自动推进已暂停。已送达回合继续执行，补充只排入下一轮。':'后续自动推进已暂停。保存草稿不会发送；有新要求时可明确解除暂停。'):'暂停只停止后续自动推进，已送达的网页回合继续工作。';
  const intakeFailed=!!p?.enrolling&&!!p?.attention;
  $('intake-configure').hidden=!p?.intake?.can_edit_scope;
  $('intake-diagnostics').hidden=!intakeFailed;
  if(intakeFailed){
    const i=p.intake||{},latest=i.latest_public_reply;
    const stages=[['项目配置',i.configuration_error==='team_write_paths_required'?'需要填写可写目录':i.configuration_error?'需要核对：'+i.configuration_error:i.configuration_error===null?'当前配置检查通过':'尚未取得配置检查结果'],['网页消息',p.bootstrap_state==='sent'?'已确认送达':p.bootstrap_state==='pending'?'尚未发送':'发送结果待核对'],['接入工具',i.tool_receipt?'已取得本地接入回执':i.local_rejection?'本地调用被拒绝：'+i.local_rejection.code:p.bootstrap_state==='pending'?'接入消息尚未发送':'未取得成功回执；不能据此断言工具未执行']];
    $('intake-stages').replaceChildren();for(const [name,value] of stages){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=value;$('intake-stages').append(dt,dd);}
    $('intake-source').textContent=latest?'来自原网页的公开回复 · '+new Date(latest.observed*1000).toLocaleString()+'。这是网页报告，不是平台原始判定。':'尚未采集新的公开回复。';
    $('intake-report').textContent=latest?.public_text||'暂无';$('intake-original').textContent=p.attention;
  }
  const firstRecord=!!p?.enrolling&&!!p.first_turn_instructions;
  $('intake-record').hidden=!firstRecord;
  if(firstRecord){
    const instructions=p.first_turn_instructions,delivery=p.bootstrap_state==='sent'?'已送达网页':p.bootstrap_state==='pending'?'本地已保存 · 尚未发送':'送达回执待核对';
    const excerpt=instructions.length>180?instructions.slice(0,180)+'…':instructions;
    if($('intake-request-preview').textContent!==excerpt)$('intake-request-preview').textContent=excerpt;
    if($('intake-request-full').textContent!==instructions)$('intake-request-full').textContent=instructions;
    $('intake-delivery').textContent=delivery+' · '+(p.bootstrap_model_selection?.effort||p.effort||'待核对');
    $('intake-delivery').className='delivery '+(p.bootstrap_state==='sent'?'success':'waiting');
    const working=!!p.observation?.generating;
    $('intake-progress').dataset.working=String(working&&!p.attention);
    $('intake-progress-title').textContent=p.attention?'需要处理':working?'正在工作':p.paused?'已暂停':'正在核对本轮状态';
    $('intake-progress-note').textContent=p.attention?'原要求与执行记录保留，具体原因见下方。':p.enrollment_phase==='receiver_enrolled'?'Local-MCP 已接入，正在处理首次要求。':p.bootstrap_state==='sent'?'消息已送达，等待工具回执与网页回复。':'要求已保存在本地，送达前不计为网页工作。';
  }
  $('welcome').hidden=!!p;$('task-empty').hidden=!p||!!p.bound||p.kind==='account'||intakeFailed||firstRecord;
  $('task-empty').querySelector('h2').textContent=p?.enrolling?(p.first_turn_instructions?'接入与任务正在本轮进行':'正在接入项目'):p?.draft?'今天想推进什么？':'让这段对话开始工作';
  $('task-empty').querySelector('.eyebrow').textContent=p?.enrolling?'原消息与回执自动保存':'新对话';
  $('task-empty').querySelector('p').textContent=p?.enrolling?'查看原网页进展，送达情况会自动核对。':'写下要求，选择模型，直接开始。项目绑定与自动协作可选。';
  $('task-empty').querySelector('.setup-steps').hidden=true;
  $('task-empty').querySelector('.scope-hint').hidden=true;
  $('setup-web').textContent=p?.enrolling?'查看本轮网页':'查看网页／登录';$('setup-web').hidden=!!p?.draft;$('setup-current').hidden=true;
  $('first-task-form').hidden=!p||managed||p.kind==='account';
  const promptSlot=p?.bound?$('saved-prompt-slot'):$('conversation');
  if($('task-prompt-preview').parentElement!==promptSlot)promptSlot.insertBefore($('task-prompt-preview'),p?.bound?null:$('events'));
  $('task-runtime-details').hidden=!p?.bound;
  $('task-prompt-preview').hidden=!p||p.kind==='account';
  $('task-prompt-summary').textContent=p?.bound?'首次要求':managed?(p.bootstrap_state==='pending'?'查看待发送内容':'查看首次发送内容'):'发送内容预览';
  $('task-prompt-preview').querySelector('p').textContent=p?.bound?'首次要求从原任务读取，接入说明按当前模板展示。历史实际发送内容以保存的工作记录为准。':'下面来自实际发送模板。项目文件不会打包；模型按列出的路径和约定读取。接入凭据与本机身份不在预览中显示。';
  $('first-task-model-hint').textContent='本轮使用 '+$('first-task-effort').value+'。发送前核对原网页，保持所选账号与模型。';
  $('first-task-effort').textContent=$('first-task-effort').value+' ⌄';
  for(const choice of document.querySelectorAll('[data-first-effort]'))choice.setAttribute('aria-checked',String(choice.dataset.firstEffort===$('first-task-effort').value));
  $('first-task-effort').disabled=busy.has('first-task:'+p?.id);
  $('first-task-account').value=p?.account||'B';$('first-task-account').disabled=!p?.draft||busy.has('first-task');
  $('first-task-location').textContent=p?.root&&!p?.automaticWorkspace?'项目：'+p.root:$('collaboration-enabled').checked?'未绑定项目；协作开始时准备独立工作区。':'未绑定项目；可以直接对话，也可以选择项目。';
  $('first-task-send').disabled=busy.has('first-task')||!state.connected||restoring;
  $('first-task-send').textContent=busy.has('first-task')?'正在核对并提交…':'发送 · '+$('first-task-effort').value+' ↑';
  $('first-task-effort').disabled=busy.has('first-task');
  // The durable task state supersedes the temporary reservation notice.
  // Do not leave a yellow duplicate-submit banner above a running Pro turn.
  if((p?.bound||(p?.enrolling&&(p.attention||p.bootstrap_state==='sent')))&&/^(接入与首次准备已提交|本地队列已保存|首次任务已提交|首次要求已保存在原任务)/.test($('notice-text').textContent))showNotice('',{preservePending:true});
  $('compose-footer').hidden=!p?.bound||!!p?.successor;$('events').hidden=!p?.bound;
  const action=CLWTaskPresentation.composer(p,taskView(),{draft:$('objective').value,pending:state.pendingObjective,connected:state.connected,modelMismatch:modelState(p).mismatch});
  const active=action.active,inputLimit=action.limit,inputLength=action.length;
  $('start').disabled=action.disabled||busy.has('start');
  actionLabel($('start'),busy.has('start')?'正在保存…':action.label,action.kind);
  $('start').hidden=!$('composer-stop').hidden;
  $('objective').placeholder=action.kind==='goal'?'验收意见或下一工作包的重点…':p?.paused?(active?'补充要求，排入下一轮，后续发送仍暂停…':'写下新要求，解除暂停后发送…'):active?'补充要求，当前回合结束后合并发送…':'告诉模型要完成什么…';
  $('model-button').textContent=busy.has('set-model')?'正在切换…':([p?.model,p?.effort].filter(Boolean).join(' · ')||'尚未确认')+' ⌄';
  $('model-button').title='切换工作模型与思考强度';
  const modelLocked=busy.has('set-model')||!p?.bound||taskView()?.page_id!==p?.id||taskView()?.state_read?.unavailable||!!p?.parent||!!p?.observation?.generating||['processing','suspended'].includes(taskView()?.request?.phase);
  for(const choice of document.querySelectorAll('[data-work-effort]')){choice.disabled=modelLocked;choice.setAttribute('aria-checked',String(choice.dataset.workEffort.toLowerCase()===String(p?.effort||'').toLowerCase()));}
  $('work-model-hint').textContent=busy.has('set-model')?'正在切换并核对原网页，请稍候…':modelLocked?'当前回合结束后可切换；协作者沿用派发时的设置。':'切换不发送消息，也不恢复暂停。新 worker 继承工作模型，接入档位保留。';
  if(changed)$('work-model-menu').hidePopover();
  $('compose-hint').textContent=action.kind==='save-draft'?'草稿已保存在本机，尚未排队发送。先解除暂停，再点击发送消息。':action.kind==='reconcile'?'点击“'+action.label+'”核对同一次提交；草稿和原请求保留，不重复发送。':p?.paused&&active?'补充按原文顺序排入下一轮，当前回合继续工作。后续发送仍暂停，明确恢复后再处理。':active?'补充按原文顺序保存，当前回合结束后合并到下一轮发送。不会注入当前回合。':'点击“'+action.label+'”后先进入本地队列；网页确认收到后显示「已送达」。Enter 发送，Shift+Enter 换行。';
  if(action.kind==='goal')$('compose-hint').textContent='打开目标与验收，确认本轮成果并决定下一包。草稿保留；保存目标和验收均不发送模型消息。';
  if(p?.bound&&taskView().page_id!==p.id)$('compose-hint').textContent='正在读取当前任务记录，草稿保留。核对完成后可以发送。';
  if(taskView().state_read?.unavailable)$('compose-hint').textContent='任务记录正在恢复，草稿保留。核对完成后可以发送；已接受的工作继续。';
  if(maintenance){$('objective').placeholder='维护暂停中。可保存补充要求，不恢复、不发送到网页…';$('compose-hint').textContent='补充仅保存到原任务。维护暂停和原待处理原因分别保留，恢复前先核对原问题。';}
  if(p?.pause_origin?.inherited)$('compose-hint').textContent='当前跟随主控暂停。请打开主控核对并恢复，草稿会保留。';
  if(inputLength>inputLimit)$('compose-hint').textContent='内容共 '+inputLength+' 字符，超过本次 '+inputLimit+' 字符的输入容量。草稿完整保留；请将长交接保存为项目内 Markdown 文件，在目标中写文件路径，请主控完整读取。';
  const run=taskView()?.run;
  $('run-info').textContent=run?(run.max_dispatches==null?'已发送 '+run.dispatches+' 次 · 次数不限':'已发送 '+run.dispatches+' / '+run.max_dispatches+' 次'):(p?.duration_seconds==null?'时长不限':p.duration_seconds/3600+' 小时')+' · '+(p?.max_dispatches==null?'次数不限':p.max_dispatches+' 次发送');
  const stats=taskView()?.send_stats;$('send-stats').textContent=stats?'本地确认 '+stats.confirmed+' 次'+(stats.unconfirmed?' · 待核对 '+stats.unconfirmed+' 次':''):'本地发送统计';
  $('send-stats').title='含首次接入；仅本应用记录，不代表账号官方剩余额度。';
  if(p?.budget_status?.saved)$('run-info').textContent+=' · 下一包可用 '+p.budget_status.available_sends+' 次';
  renderBudget();
  if(workflowMode==='web')renderNav();if(detailMode==='closed')renderClosed();renderEvents();renderWorkflow(p);
  if(p?.bound&&detailMode==='settings')fillSettings();
  renderWorkspaceMode();
  scheduleLayout();
}
// Refill is a local, durable operation; an uncertain reply reuses the same key.
const refillIntents=readDrafts('clw-budget-refill-intents');
const goalStopIntents=readDrafts('clw-goal-stop-intents');
function saveGoalStopIntents(){localStorage.setItem('clw-goal-stop-intents',JSON.stringify([...goalStopIntents]));}
const goalIntents=readDrafts('clw-goal-operation-intents'),goalDrafts=readDrafts('clw-goal-drafts'),goalModeDrafts=readDrafts('clw-goal-mode-drafts');
const goalDraftBases=readDrafts('clw-goal-draft-bases');
const goalStageDrafts=readDrafts('clw-goal-stage-drafts');
let budgetPageId=null,budgetSnapshot=null,goalSnapshot=null,goalSnapshotView=null,goalReadPending=false,goalReadVerified=false,goalDialogContext=null,goalReviewEditing=false,goalEditing=false,goalEditBasis=null,goalReviewBasis=null,goalNextBasis=null;
let goalReadSerial=0;
function saveRefillIntents(){localStorage.setItem('clw-budget-refill-intents',JSON.stringify([...refillIntents]));}
function saveGoalIntents(){localStorage.setItem('clw-goal-operation-intents',JSON.stringify([...goalIntents]));}
function saveGoalDrafts(){try{localStorage.setItem('clw-goal-drafts',JSON.stringify([...goalDrafts]));localStorage.setItem('clw-goal-mode-drafts',JSON.stringify([...goalModeDrafts]));localStorage.setItem('clw-goal-draft-bases',JSON.stringify([...goalDraftBases]));return true;}catch{$('goal-feedback').textContent='目标草稿暂未保存到本机，关闭前请复制。';return false;}}
function saveGoalStages(){try{localStorage.setItem('clw-goal-stage-drafts',JSON.stringify([...goalStageDrafts]));return true;}catch{$('goal-feedback').textContent='验收或下一包草稿暂未保存到本机，关闭前请复制。';return false;}}
const goalErrorLabels={
  managed_goal_stopped:'此目标已关闭。保留的原回执可继续核对；重新设置目标后才自动接续。',
  managed_goal_controller_required:'请从纯 Web 主控任务设置目标。',managed_goal_changed:'目标或原结果已变化，先核对当前内容再保存。',
  managed_goal_identity_changed:'原任务身份已变化，目标草稿保留。',managed_goal_request_changed:'已有新工作包，先核对原结果。',
  managed_goal_pending_original_send:'原接续回执尚未确认，请核对同一次操作。',managed_goal_not_set:'请先保存任务目标。',
  managed_goal_result_not_settled:'本轮尚未完整收尾，请等待原结果。',managed_goal_original_result_unavailable:'原结果暂未读到，请先核对工作记录。',
  managed_goal_human_review_required:'请先保存本轮验收决定，再明确开始下一包。',managed_goal_next_text_too_long:'目标、验收反馈和原交接合计超过 24000 字符，请精简目标或下一包重点；原稿完整保留。',
  managed_goal_invalid:'目标需为 1–18000 字符，不能包含空字符。',managed_goal_review_note_invalid:'验收反馈超出容量或包含空字符，请修改后保存。',
  managed_goal_review_decision_invalid:'请重新选择验收决定。',managed_goal_instructions_invalid:'下一包重点需在 11000 字符内，不能包含空字符。',
  managed_goal_operation_conflict:'原操作记录不匹配，请核对原任务，不能换键重发。',managed_goal_prepared_text_changed:'已准备的原接续内容发生变化，请核对原回执。',
  managed_goal_pending_changed:'原待发工作包已经变化，请重新核对。',managed_goal_original_send_unresolved:'原发送回执尚未核清，不能撤销或换键提交。',
  managed_goal_use_continue:'请通过目标与验收明确开始下一包，原普通接续不能绕过验收。',managed_goal_original_operation_required:'请核对已准备的原下一包，不能新建操作键。',
  managed_goal_prepared_intent_discarded:'这次原提交已撤销，旧操作键不能再发送。',managed_goal_store_changed:'原工作记录存储已变化，请核对任务身份。',
  managed_task_identity_changed:'任务状态已变化，请核对当前记录；没有重新发送。',
  managed_budget_changed:'预算或运行状态已变化，请核对后再保存。',managed_budget_next_window_too_large:'追加量超过单次运行容量，请减小次数或时长。',
  managed_budget_controller_required:'协作者共用主控预算，请打开主控任务。',managed_budget_wait_for_close:'上一工作包仍在收尾，请等待原回执。',
};
const goalUnknownCodes=new Set(['runtime_receipt_unknown_reconcile_original','runtime_disconnected_reconcile_original','managed_operation_unknown_reconcile','managed_task_response_stale','runtime_not_connected']);
const goalInputWarnings={review:'验收反馈超过 6000 字符或含空字符，原稿保留；请修改后保存。',next:'下一包重点超过 11000 字符或含空字符，原稿保留；请修改后开始。'};
async function goalCommand(action,payload){
  try{return await interactiveCommand(action,payload);}
  catch(error){
    const code=String(error.message||'').replace(/^Error invoking remote method '[^']+': Error: /,'');
    if(code==='runtime_not_connected')showNotice('本机服务尚未连接，请稍候。',{scope:'global'});
    return {state:goalUnknownCodes.has(code)||!Object.hasOwn(goalErrorLabels,code)?'unconfirmed':'rejected',code};
  }
}
function dialogOwnsTask(){return workflowMode==='web'&&budgetPageId===current()?.id&&taskContextCurrent(goalDialogContext);}
function currentDialogGoal(){
  const live=state.selected===budgetPageId?taskView().goal:null;
  return live&&(!goalSnapshot||live.revision>goalSnapshot.revision||live!==goalSnapshotView&&live.revision===goalSnapshot.revision)?live:goalSnapshot||live;
}
function dialogGoalPresentation(){
  const p=state.pages.find(p=>p.id===budgetPageId),view=taskView(p);
  return CLWTaskPresentation.goalPresentation(p,{...view,goal:currentDialogGoal()});
}
function goalDetailValid(g){return !!g&&typeof g.configured==='boolean'&&typeof g.objective==='string'&&typeof g.etag==='string'&&!!g.etag&&Number.isInteger(g.revision)&&g.revision>=0&&(g.request_id===null||typeof g.request_id==='string');}
function goalBasis(g){
  if(!goalDetailValid(g))return null;
  const p=state.pages.find(p=>p.id===budgetPageId);
  return {page_id:budgetPageId,thread_id:taskView(p).thread_id||p?.thread_id||null,account:p?.account||null,
    etag:g.etag,revision:g.revision,request_id:g.request_id,objective:g.objective};
}
function goalBasisMatches(basis,g){
  const current=goalBasis(g);
  return !!basis&&!!current&&Object.keys(current).every(key=>basis[key]===current[key]);
}
function goalEditConflict(g){return (goalEditing||goalDrafts.has(budgetPageId)||goalModeDrafts.has(budgetPageId))&&!goalBasisMatches(goalEditBasis,g);}
const goalConflictWarning='目标已从另一入口更新，或原草稿缺少编辑基准。当前已保存目标显示在上方，你的编辑稿保留。核对后点击“确认当前目标并继续编辑”，或取消本机编辑；不会自动覆盖。';
const goalStageConflictWarning='目标或验收记录已从另一入口更新，或草稿缺少原编辑基准。当前目标与验收显示在上方，本机决定和正文保留。核对后点击“确认当前记录并继续编辑”，或取消本机阶段草稿；不会自动提交。';
function goalNextBasisFor(g,b){const basis=goalBasis(g);return basis?{...basis,run_id:g.next?.expected_run_id||b?.run_id||null}:null;}
function goalStageConflicts(g,b){
  const stage=goalStageDrafts.get(budgetPageId);
  return {review:(goalReviewEditing||!!stage?.review)&&!goalBasisMatches(goalReviewBasis,g),
    next:!!stage?.next&&(!goalBasisMatches(goalNextBasis,g)||goalNextBasis?.run_id!==goalNextBasisFor(g,b)?.run_id)};
}
function preserveGoalStage(kind){
  if(goalIntents.has(budgetPageId)||!dialogOwnsTask())return;
  const stage=goalStageDrafts.get(budgetPageId)||{};
  goalStageDrafts.set(budgetPageId,{...stage,[kind]:kind==='review'?{basis:goalReviewBasis,decision:$('goal-review-decision').value,note:$('goal-review-notes').value}:
    {basis:goalNextBasis,instructions:$('budget-instructions').value}});
  if(kind==='review')goalReviewEditing=true;
  saveGoalStages();renderBudget();
}
function removeGoalStage(id,kind){
  const stage={...goalStageDrafts.get(id)};delete stage[kind];
  if(Object.keys(stage).length)goalStageDrafts.set(id,stage);else goalStageDrafts.delete(id);
}
const budgetHours=seconds=>Number((Math.max(0,seconds)/3600).toFixed(2))+' 小时';
// Presentation only: the original goal detail and operation guards below still
// decide whether a visible action may be submitted.
function goalDialogLayout(presentation,{configured,unsaved,editing,reviewEditing,pendingAction,preparedNext,legacyNext,verified}){
  const editor=!configured||editing||unsaved||pendingAction==='goal-save';
  const reviewed=!!presentation.reviewed,reviewedContinue=reviewed&&presentation.goal?.review?.decision==='continue';
  return {
    editor,summary:configured&&!editor,
    review:pendingAction==='goal-review'||verified&&!editor&&presentation.canReview&&(!reviewed||reviewEditing)&&pendingAction!=='goal-continue',
    reviewEdit:verified&&!editor&&presentation.canReview&&reviewed&&!reviewEditing&&!pendingAction,
    next:pendingAction==='goal-continue'||preparedNext||(configured?verified&&!editor&&!reviewEditing&&reviewedContinue:legacyNext),
  };
}
function goalPackagePresentation(p,view,presentation,{verified,reading,owns,preparedNext}){
  const g=presentation.goal,review=presentation.reviewed?g?.review:null;
  const decisions={continue:'验收已保存 · 继续推进',revise:'验收已保存 · 需要修正',complete:'完成决定已保存'};
  const reviewSummary=review&&Object.hasOwn(decisions,review.decision)?decisions[review.decision]+(review.note?'\n'+review.note:''):'';
  if(!owns||!verified)return {title:'当前工作包待核对',detail:reading?'正在读取原任务的目标与验收记录…':'原记录尚未核验，目标和草稿保留。核对完成前不会提交新操作。',reviewSummary:''};
  if(g?.mode==='automatic'||g?.result_contract>=2){
    const copy={delivered:['已交付','完整目标已经交付，自动发送已停止。你可以随时追加要求。'],waiting:['等待结果','已保存原 Job 与接续点。程序等待结果，不发送模型消息。'],paused:['后续已暂停','当前工作与现场保留。明确恢复后再自动接续。'],needs_attention:['需要处理','当前接续已保留，请查看过程区的具体问题。'],running:['持续推进中','当前回合正常交付后，合并你的补充与必要后续。完成全部目标后停止自动发送。']};
    const status=copy[presentation.state]||copy.running;
    return {title:status[0],detail:status[1],reviewSummary:''};
  }
  if(preparedNext)return {title:'原下一包待核对',detail:'原工作包已经准备，送达情况以原回执为准。核对复用原操作；撤销须满足原任务的安全条件。',reviewSummary};
  const request=view?.page_id===p?.id?view.request:null,latest=view?.page_id===p?.id?view.latest_request:null;
  if(request){
    if(g?.configured&&request.id!==g.request_id)return {title:'工作包身份待核对',detail:'当前请求与目标关联的原工作包不同，先核对任务记录。',reviewSummary:''};
    const phases={queued:['当前工作包已排队','要求已保存在本地队列；是否送达以原任务回执为准。'],
      processing:['当前工作包执行记录未结清','原请求仍处于执行阶段。当前包的结果收集继续，验收要等成果与回执结清。'],
      suspended:['当前工作包已挂起','原请求保持挂起。保存目标不会恢复或重新发送当前包。']};
    const status=phases[request.phase]||['当前工作包待核对','原请求尚未结清，请先查看工作记录。'];
    return {title:status[0],detail:status[1],reviewSummary};
  }
  if(p?.observation?.generating)return {title:'网页观测显示生成中',detail:'当前网页回合继续工作。保存目标和追加预算不会打断它，验收等待原包结清。',reviewSummary};
  if(review){
    if(review.decision==='complete')return {title:g.mode==='manual'&&review.actor==='human'?'目标已由你验收完成':'原完成决定已保存',detail:'目标与完成决定保留，没有开始下一工作包。',reviewSummary};
    if(review.decision==='continue')return {title:'本包验收已保存',detail:presentation.canStartNext?'下一包由你明确开始；保存目标、验收或预算均不会自动发送。':'下一包尚不能开始，请核对派发预算和原任务状态。',reviewSummary};
    if(review.decision==='revise')return {title:'本包需要修正',detail:'修正目标或修改验收反馈后，再决定是否开始下一包。',reviewSummary};
  }
  if(presentation.canReview)return {title:'本包成果已保存 · 等待验收',detail:'查看工作记录与真实成果后，记录你的验收决定。保存验收不发送消息。',reviewSummary};
  if(latest?.id===g?.request_id&&latest.phase==='completed')return {title:'原工作包已结束',detail:'目标验收资格尚未核实。回合结束不会自动成为你的验收决定。',reviewSummary};
  return {title:'当前工作包记录待核对',detail:'目标保持；尚未取得可验收的原包成果与结清记录。',reviewSummary};
}
function renderBudget(){
  if(!$('budget-dialog').open)return;
  const p=state.pages.find(p=>p.id===budgetPageId),b=budgetSnapshot||p?.budget_status;
  const pending=refillIntents.get(budgetPageId),working=busy.has('budget')||goalReadPending;
  const pendingStart=state.selected===budgetPageId&&!!state.pendingObjective;
  const owns=dialogOwnsTask()&&state.connected!==false&&!taskView(p).state_read?.unavailable;
  const presentation=dialogGoalPresentation(),g=presentation.goal,goalPending=goalIntents.get(budgetPageId),discardPending=goalPending?.discard||(goalPending?.action==='goal-discard'?goalPending:null);
  const preparedNext=g?.next?.state==='goal_next_prepared'&&typeof g.next.operation_id==='string';
  const detailed=goalReadVerified&&goalDetailValid(g);
  // A newer canonical goal is an update to an untouched overview, never a new
  // local draft. Explicit edits keep their original basis until confirmation.
  if(detailed&&owns&&!goalEditing&&!goalDrafts.has(budgetPageId)&&goalPending?.action!=='goal-save'){
    if($('goal-objective').value!==g.objective)$('goal-objective').value=g.objective;
    if(!goalBasisMatches(goalEditBasis,g))goalEditBasis=goalBasis(g);
  }
  if(detailed&&!goalModeDrafts.has(budgetPageId)&&goalPending?.action!=='goal-save')$('goal-auto-continue').checked=!g.configured||g.mode==='automatic';
  const stage=goalStageDrafts.get(budgetPageId);
  if(stage?.review)goalReviewEditing=true;
  if(detailed&&owns&&!goalReviewEditing&&!stage?.review&&goalPending?.action!=='goal-review'){
    $('goal-review-decision').value=g.review?.decision||'continue';
    const note=g.review?.note||'';if($('goal-review-notes').value!==note)$('goal-review-notes').value=note;
    if(!goalBasisMatches(goalReviewBasis,g))goalReviewBasis=goalBasis(g);
  }
  if(detailed&&owns&&!stage?.next&&goalPending?.action!=='goal-continue'&&!preparedNext){
    goalNextBasis=goalNextBasisFor(g,b);
    if($('budget-instructions').value)$('budget-instructions').value='';
  }
  const editConflict=detailed&&goalEditConflict(g),showConflict=editConflict&&!goalPending;
  const stageConflicts=goalStageConflicts(g,b),showStageConflict=detailed&&!goalPending&&(stageConflicts.review||stageConflicts.next);
  const mode=$('goal-auto-continue').checked?'automatic':'manual';
  const unsaved=$('goal-objective').value!==String(g?.objective||'')||(g?.configured===true&&(mode!==g.mode||g.state==='stopped'));
  const objective=$('goal-objective').value,validGoal=[...objective.trim()].length>0&&[...objective.trim()].length<=18000&&!objective.includes('\0');
  const note=$('goal-review-notes').value,instructions=$('budget-instructions').value;
  const validReview=[...note].length<=6000&&!note.includes('\0'),validNext=[...instructions].length<=11000&&!instructions.includes('\0');
  const reviewedContinue=presentation.reviewed&&g.review.decision==='continue';
  const configured=g?.configured===true;
  const layout=goalDialogLayout(presentation,{configured,unsaved,editing:goalEditing||showConflict,reviewEditing:goalReviewEditing,pendingAction:goalPending?.action,preparedNext,legacyNext:!!b?.saved||pendingStart,verified:detailed&&owns});
  if(stage?.review&&!goalEditing&&!showConflict&&goalPending?.action!=='goal-continue')layout.review=true;
  if(stage?.next&&(!goalReviewEditing||showStageConflict))layout.next=true;
  if(g?.mode==='automatic'){
    // Switching modes removes new manual decisions, but must leave the original
    // receipt available when an earlier manual operation is still unresolved.
    layout.review=goalPending?.action==='goal-review';layout.reviewEdit=false;
    layout.next=goalPending?.action==='goal-continue'||preparedNext||!!discardPending;
  }
  const packageSummary=goalPackagePresentation(p,taskView(p),presentation,{verified:detailed,reading:goalReadPending,owns,preparedNext});
  $('budget-title').textContent=(p?.title||'对话')+' · 目标';
  $('goal-panel').dataset.state=presentation.state;
  const goalLabel=presentation.state==='paused'&&g?.mode==='manual'&&!presentation.canReview&&!presentation.reviewed?'目标已保存 · 下一包由你发放':presentation.title;
  $('goal-status').textContent=!owns?'原任务状态待核对':goalReadPending?'正在读取目标…':!goalReadVerified?'目标记录待核对':goalLabel;
  $('goal-progress').textContent=presentation.cycles!==null?'已接续 '+presentation.cycles+' 个工作包':'';
  $('goal-objective-view').textContent=String(g?.objective||'');
  $('goal-objective-view').hidden=!layout.summary&&!showConflict;
  $('goal-objective-view').setAttribute('aria-label',showConflict?'当前已保存的目标':'已保存的目标');
  $('goal-form').hidden=!layout.editor;
  $('goal-edit').hidden=!layout.summary&&!showConflict&&!showStageConflict;
  $('goal-edit').textContent=showStageConflict?'确认当前记录并继续编辑':showConflict?'确认当前目标并继续编辑':'编辑目标';
  $('goal-edit').disabled=working||!owns||!detailed||!presentation.editable||!!goalPending||!!pending;
  $('goal-edit-cancel').hidden=(!configured&&!showConflict)||!layout.editor||!!goalPending;
  $('goal-edit-cancel').disabled=working||!owns||!detailed||!!pending;
  $('goal-package-status').textContent=packageSummary.title;
  $('goal-package-detail').textContent=packageSummary.detail;
  $('goal-review-summary').textContent=packageSummary.reviewSummary;
  $('goal-review-summary').hidden=!packageSummary.reviewSummary;
  $('goal-objective').disabled=working||!owns||!detailed||!presentation.editable||!!goalPending;
  $('goal-auto-continue').disabled=$('goal-objective').disabled;
  $('goal-save').textContent=goalPending?.action==='goal-save'?'核对原目标保存':'保存目标';
  $('goal-save').hidden=!unsaved&&g?.configured===true&&goalPending?.action!=='goal-save';
  $('goal-save').className='primary';
  $('goal-save').disabled=working||!owns||!detailed||!!pending||goalStopIntents.has(budgetPageId)||(goalPending?goalPending.action!=='goal-save':editConflict||!presentation.editable||!validGoal||!unsaved);
  $('goal-policy').textContent=mode==='automatic'?'保存目标后，未完成工作自动接续；全部交付后停止。现有暂停保持。':g?.configured&&!(g?.result_contract>=2)?'每包由你验收并发放后续。保存目标不会发送消息。':'由你发送后续；保存目标不发送消息。';
  // A review and a continuation are sequential decisions, never two competing primary buttons.
  $('goal-review-section').hidden=!layout.review;
  $('goal-review-save').textContent=goalPending?.action==='goal-review'?'核对原验收决定':'保存验收决定';
  $('goal-review-save').disabled=working||!owns||!detailed||unsaved||!!pending||(goalPending?goalPending.action!=='goal-review':editConflict||stageConflicts.review||!presentation.canReview||!validReview);
  for(const id of ['goal-review-decision','goal-review-notes'])$(id).disabled=working||!owns||!!goalPending;
  $('goal-review-edit').hidden=!layout.reviewEdit&&!goalReviewEditing&&!showStageConflict;
  $('goal-review-edit').textContent=showStageConflict?'取消本机阶段草稿':goalReviewEditing?'取消验收编辑':'修改验收决定';
  $('goal-review-edit').disabled=working||!owns||!detailed||unsaved||editConflict||!!goalPending||!!pending;
  const mayRequestDiscard=preparedNext&&g.next_recovery?.can_discard===true||goalPending?.action==='goal-continue'&&!!goalPending.rejection;
  $('goal-discard').hidden=!discardPending&&!mayRequestDiscard;
  $('goal-discard').textContent=discardPending?'核对原撤销操作':'撤销待发的下一包';
  $('goal-discard').disabled=working||!owns||!detailed||(!discardPending&&!mayRequestDiscard);
  $('budget-details').hidden=false;
  if(pending)$('budget-details').open=true;
  $('budget-summary').textContent=!b?'正在读取预算…':'已发送 '+b.used+' 次 · '+(b.limit==null?'次数不限':'上限 '+b.limit+' 次')+' · '+(b.available_seconds==null?'时长不限':'可用 '+budgetHours(b.available_seconds));
  const sends=Number($('refill-sends').value),seconds=Math.round(Number($('refill-hours').value)*3600);
  const valid=Number.isInteger(sends)&&sends>=0&&sends<=10000&&Number.isFinite(seconds)&&seconds>=0&&seconds<=604800&&(sends+seconds)>0;
  $('budget-preview').textContent=b&&valid?'保存后 '+(b.available_sends==null?'次数仍不限':'可用 '+(b.available_sends+sends)+' 次')+'、'+(b.available_seconds==null?'时长仍不限':budgetHours(b.available_seconds+seconds)):'只在设有预算时追加次数或时长。';
  $('budget-save').textContent=pending?'核对原预算追加':'保存追加预算 · 不发送消息';
  $('budget-save').disabled=working||!owns||!!goalPending||!b||(!pending&&(!valid||(b.limit==null&&b.available_seconds==null)));
  for(const id of ['refill-sends','refill-hours'])$(id).disabled=working||!owns||!!pending||!!goalPending;
  $('budget-continue-section').hidden=!layout.next;
  $('budget-continue').textContent=goalPending?.action==='goal-continue'||preparedNext?'核对原下一包提交':pendingStart?'核对已提交工作包':configured?'开始下一包':'继续原任务';
  $('budget-continue').disabled=working||!owns||!detailed||!!discardPending||!!pending||unsaved||(goalPending?goalPending.action!=='goal-continue':editConflict||!preparedNext&&(goalEditing||goalReviewEditing||stageConflicts.review||stageConflicts.next)|| (configured?(!presentation.canStartNext&&!preparedNext)||!preparedNext&&!validNext:!b?.can_continue&&!pendingStart));
  $('budget-instructions').disabled=working||!owns||!!goalPending||preparedNext;
  $('budget-instructions').placeholder=preparedNext?'原工作包已准备，核对将复用原稿。撤销待发后才可修改。':'结合验收反馈，写下下一包要完成和验证的内容。';
  if(showConflict&&owns)$('goal-feedback').textContent=goalConflictWarning;
  else if(showStageConflict&&owns)$('goal-feedback').textContent=goalStageConflictWarning;
  else if([goalConflictWarning,goalStageConflictWarning].includes($('goal-feedback').textContent))$('goal-feedback').textContent='';
  if(!showConflict&&!showStageConflict&&(!validReview||!validNext))$('goal-feedback').textContent=!validReview?goalInputWarnings.review:goalInputWarnings.next;
  else if(Object.values(goalInputWarnings).includes($('goal-feedback').textContent))$('goal-feedback').textContent='';
  if(configured&&reviewedContinue&&!presentation.canStartNext&&!goalPending&&!$('goal-feedback').textContent)$('goal-feedback').textContent='验收决定已保存。当前可用预算或原任务状态尚不支持下一包，请核对下面的派发次数与时长。';
  $('budget-close').disabled=busy.has('budget');
}
async function readDialogGoal(){
  const context=goalDialogContext,id=budgetPageId;if(!$('budget-dialog').open||!context)return;
  // Closing leaves the readonly request running. Only the latest read in this
  // exact dialog opening may update its snapshot or finish its loading state.
  const read=++goalReadSerial;
  const ownsRead=()=>read===goalReadSerial&&goalDialogContext===context;
  goalReadPending=true;renderBudget();
  try{
    const r=await goalCommand('goal-read',{id});
    if(!ownsRead()||!$('budget-dialog').open||budgetPageId!==id||!taskContextCurrent(context))return;
    if(goalDetailValid(r?.goal)&&r.model_sends===0){
      goalSnapshot=r.goal;goalSnapshotView=taskView().goal;goalReadVerified=true;
      if(!goalDrafts.has(id)&&!goalEditing&&goalIntents.get(id)?.action!=='goal-save')$('goal-objective').value=r.goal.objective;
    }else{goalReadVerified=false;$('goal-feedback').textContent='目标记录暂未读到，草稿保留。关闭后重新打开可核对原记录。';}
  }finally{if(ownsRead()){goalReadPending=false;renderBudget();}}
}
function openBudget({fromComposer=false}={}){
  const p=current();if(workflowMode!=='web'||!p?.bound||p.parent||p.successor)return;
  budgetPageId=p.id;budgetSnapshot=null;goalSnapshot=null;goalSnapshotView=null;goalReadVerified=false;goalReviewEditing=false;goalEditing=false;goalEditBasis=goalDrafts.has(p.id)||goalModeDrafts.has(p.id)?goalDraftBases.get(p.id)||null:null;goalDialogContext=captureTaskContext(p.id);
  const pending=refillIntents.get(p.id);
  const original=goalIntents.get(p.id),goal=taskView().goal;
  let stage=goalStageDrafts.get(p.id)||{};goalReviewEditing=!!stage.review;goalReviewBasis=stage.review?.basis||null;goalNextBasis=stage.next?.basis||null;
  $('refill-sends').value=pending?.add_dispatches??0;
  $('refill-hours').value=(pending?.add_seconds??0)/3600;
  $('budget-feedback').textContent=pending?'原预算追加回执未确认，请核对同一操作。不会重复追加。':'';
  $('goal-feedback').textContent=original?'原操作回执未确认，请核对同一次操作；不会换键重发。':'';
  $('goal-objective').value=original?.action==='goal-save'?original.payload.objective:goalDrafts.get(p.id)??goal?.objective??'';
  $('goal-auto-continue').checked=original?.action==='goal-save'?original.payload.mode==='automatic':goalModeDrafts.get(p.id)??(!goal?.configured||goal.mode==='automatic');
  $('goal-review-decision').value=original?.payload.decision||stage.review?.decision||goal?.review?.decision||'continue';
  const draft=fromComposer?$('objective').value:'';
  const forNext=goal?.review?.request_id===goal?.request_id&&goal?.review?.decision==='continue'&&!stage.review;
  if(draft&&!original){
    const kind=forNext?'next':'review';
    if(!stage[kind]){
      const basis=kind==='next'?goalNextBasisFor(goal,p.budget_status):goalBasis(goal);
      stage={...stage,[kind]:kind==='next'?{basis,instructions:draft}:{basis,decision:$('goal-review-decision').value,note:draft}};
      goalStageDrafts.set(p.id,stage);saveGoalStages();
      if(kind==='next')goalNextBasis=basis;else{goalReviewBasis=basis;goalReviewEditing=true;}
    }
  }
  $('goal-review-notes').value=original?.payload.note??stage.review?.note??goal?.review?.note??'';
  $('budget-instructions').value=original?.payload.instructions??stage.next?.instructions??'';
  $('budget-details').open=!!pending;
  $('budget-dialog').showModal();renderBudget();scheduleLayout();void readDialogGoal();
}
$('settings-refill').onclick=openBudget;
$('composer-add-goal').onclick=()=>{$('composer-add-menu').hidePopover();openBudget();};
$('composer-access').onclick=$('composer-add-settings').onclick=()=>{$('composer-add-menu').hidePopover();details('settings');};
$('composer-add-preview').onclick=()=>{$('composer-add-menu').hidePopover();$('task-prompt-preview').open=true;void renderPromptPreview();$('task-prompt-preview').scrollIntoView?.({block:'nearest'});};
async function pickComposerContext(kind){
  const p=current(),view=taskView(p);if(workflowMode!=='web'||!p?.bound||view.page_id!==p.id||view.state_read?.unavailable||!state.connected)return;
  const context=captureTaskContext(p.id),request=view.request||p.latest_request;
  $('composer-add-menu').hidePopover();
  await once('pick-context',async()=>{
    renderComposerContext();
    const result=await act('pick-context',{id:p.id,kind,expected_connection_generation:context.connection,
      expected_request_id:['queued','processing','suspended'].includes(request?.phase)?request.id:null});
    if(!result?.references?.length||!taskContextCurrent(context))return;
    const refs=result.references.filter(reference=>typeof reference.path==='string'&&['file','folder'].includes(reference.kind));
    if(!refs.length)return;
    const previous=$('objective').value,lines=refs.map(reference=>JSON.stringify(reference.path)),section='请读取以下项目内'+(kind==='folder'?'文件夹':'文件')+'，结合本轮任务处理：\n'+lines.join('\n');
    const value=previous.trim()?previous+'\n\n'+section:section;
    writeComposerDraft(p.id,value);
    if(taskContextCurrent(context)){$('objective').value=value;resizeComposer();$('objective').focus();}
  });renderComposerContext();
}
$('composer-add-files').onclick=()=>pickComposerContext('files');
$('composer-add-folder').onclick=()=>pickComposerContext('folder');
$('composer-add-menu').addEventListener('toggle',event=>{
  if(event.newState==='open'){const rect=$('composer-add').getBoundingClientRect(),menu=$('composer-add-menu');
    menu.style.left=Math.max(12,Math.min(rect.left,(window.innerWidth||800)-Math.min(248,(window.innerWidth||800)-24)-12))+'px';
    menu.style.bottom=Math.max(12,(window.innerHeight||800)-rect.top+8)+'px';}
  scheduleLayout();
});
$('composer-add-menu').onkeydown=event=>{
  const choices=Array.from($('composer-add-menu').querySelectorAll('button')).filter(node=>!node.hidden&&!node.disabled),at=choices.indexOf(document.activeElement);
  const next=event.key==='ArrowDown'?(at+1)%choices.length:event.key==='ArrowUp'?(at+choices.length-1)%choices.length:event.key==='Home'?0:event.key==='End'?choices.length-1:null;
  if(next!==null&&choices.length){event.preventDefault();choices[next].focus();}
};
for(const id of ['refill-sends','refill-hours'])$(id).oninput=renderBudget;
$('goal-objective').oninput=()=>{goalDrafts.set(budgetPageId,$('goal-objective').value);if(goalEditBasis)goalDraftBases.set(budgetPageId,goalEditBasis);saveGoalDrafts();renderBudget();};
$('goal-auto-continue').onchange=()=>{goalModeDrafts.set(budgetPageId,$('goal-auto-continue').checked);if(goalEditBasis)goalDraftBases.set(budgetPageId,goalEditBasis);saveGoalDrafts();renderBudget();};
$('goal-edit').onclick=()=>{
  renderBudget();if($('goal-edit').disabled)return;
  const g=currentDialogGoal(),b=budgetSnapshot||state.pages.find(p=>p.id===budgetPageId)?.budget_status,conflicts=goalStageConflicts(g,b),targetConflict=goalEditConflict(g);
  if(conflicts.review||conflicts.next){
    const previous=goalStageDrafts.get(budgetPageId),next={...previous};
    const reviewBasis=goalBasis(g),nextBasis=goalNextBasisFor(g,b);
    if(conflicts.review&&next.review)next.review={...next.review,basis:reviewBasis};
    if(conflicts.next&&next.next)next.next={...next.next,basis:nextBasis};
    goalStageDrafts.set(budgetPageId,next);
    if(!saveGoalStages()){if(previous)goalStageDrafts.set(budgetPageId,previous);else goalStageDrafts.delete(budgetPageId);return;}
    if(conflicts.review){goalReviewBasis=reviewBasis;goalReviewEditing=true;}if(conflicts.next)goalNextBasis=nextBasis;
    if(!targetConflict){renderBudget();return;}
  }
  const previous=goalEditBasis,storedBasis=goalDraftBases.get(budgetPageId);goalEditBasis=goalBasis(currentDialogGoal());
  if(goalDrafts.has(budgetPageId)){
    goalDraftBases.set(budgetPageId,goalEditBasis);
    if(!saveGoalDrafts()){goalEditBasis=previous;if(storedBasis)goalDraftBases.set(budgetPageId,storedBasis);else goalDraftBases.delete(budgetPageId);return;}
  }
  goalEditing=true;goalReviewEditing=false;renderBudget();$('goal-objective').focus();
};
$('goal-edit-cancel').onclick=()=>{
  renderBudget();if($('goal-edit-cancel').disabled||goalIntents.has(budgetPageId)||!dialogOwnsTask())return;
  const original=goalDrafts.get(budgetPageId),hadDraft=goalDrafts.has(budgetPageId),originalMode=goalModeDrafts.get(budgetPageId),hadMode=goalModeDrafts.has(budgetPageId),originalBasis=goalDraftBases.get(budgetPageId);
  goalDrafts.delete(budgetPageId);goalModeDrafts.delete(budgetPageId);goalDraftBases.delete(budgetPageId);
  if(!saveGoalDrafts()){if(hadDraft)goalDrafts.set(budgetPageId,original);if(hadMode)goalModeDrafts.set(budgetPageId,originalMode);if(originalBasis)goalDraftBases.set(budgetPageId,originalBasis);return;}
  $('goal-objective').value=currentDialogGoal().objective;goalEditing=false;goalEditBasis=goalBasis(currentDialogGoal());renderBudget();
};
$('goal-review-decision').onchange=()=>preserveGoalStage('review');
$('goal-review-notes').oninput=()=>preserveGoalStage('review');
$('budget-instructions').oninput=()=>preserveGoalStage('next');
$('budget-close').onclick=()=>{if(!busy.has('budget'))$('budget-dialog').close();};
$('budget-dialog').onclose=()=>{goalReadSerial++;goalReadPending=false;budgetPageId=null;budgetSnapshot=null;goalSnapshot=null;goalSnapshotView=null;goalReadVerified=false;goalDialogContext=null;goalEditing=false;goalReviewEditing=false;goalEditBasis=null;goalReviewBasis=null;goalNextBasis=null;scheduleLayout();};
$('budget-dialog').addEventListener('cancel',event=>{if(busy.has('budget'))event.preventDefault();});
async function mutateGoal(action,fields){
  if(busy.has('budget')||goalReadPending||!dialogOwnsTask())return;
  await once('budget',async()=>{
    const id=budgetPageId,context=captureTaskContext(id),g=currentDialogGoal();if(!g?.etag)return;
    const stored=goalIntents.get(id);let intent=action==='goal-discard'?(stored?.discard||(stored?.action==='goal-discard'?stored:null)):stored;
    if(stored&&action==='goal-discard'&&!['goal-continue','goal-discard'].includes(stored.action))return;
    if(stored?.discard&&action!=='goal-discard')return;
    if(intent&&intent.action!==action)return;
    if(!intent){
      if(['goal-save','goal-review','goal-continue'].includes(action)&&goalEditConflict(g)){$('goal-feedback').textContent=goalConflictWarning;return;}
      const conflicts=goalStageConflicts(g,budgetSnapshot||state.pages.find(p=>p.id===id)?.budget_status),prepared=g.next?.state==='goal_next_prepared';
      if(action==='goal-review'&&conflicts.review||action==='goal-continue'&&!prepared&&(conflicts.review||conflicts.next)){$('goal-feedback').textContent=goalStageConflictWarning;return;}
      const basis=action==='goal-save'?goalEditBasis:action==='goal-review'?goalReviewBasis:action==='goal-continue'&&!prepared?goalNextBasis:g;if(!basis?.etag)return;
      intent={action,payload:{id,operation_id:action==='goal-continue'&&g.next?.operation_id?g.next.operation_id:crypto.randomUUID(),expected_etag:basis.etag,expected_goal_request_id:basis.request_id,...fields}};
      goalIntents.set(id,action==='goal-discard'&&stored?{...stored,discard:intent}:intent);
      try{saveGoalIntents();}catch{if(stored)goalIntents.set(id,stored);else goalIntents.delete(id);$('goal-feedback').textContent='无法保存原操作身份，此次尚未提交。';return;}
    }
    renderBudget();const r=await goalCommand(action,intent.payload);
    const unconfirmed=!r||r.state==='unconfirmed'||goalUnknownCodes.has(r.code);
    if(unconfirmed){if(taskContextCurrent(context)&&budgetPageId===id)$('goal-feedback').textContent='原操作回执未确认，草稿与操作身份已保存。点击核对检查同一次操作，不会另发一包。';return;}
    const accepted=action==='goal-continue'?
      r.state==='queued_for_web_host'&&r.request_id===intent.payload.operation_id&&(!r.operation_id||r.operation_id===intent.payload.operation_id)&&(!r.thread_id||r.thread_id===context.thread):
      goalDetailValid(r.goal)&&r.goal.request_id===intent.payload.expected_goal_request_id&&r.model_sends===0&&(action!=='goal-discard'||r.original_operation_id===intent.payload.expected_pending_id);
    if(r.state!=='rejected'&&!accepted){if(taskContextCurrent(context)&&budgetPageId===id)$('goal-feedback').textContent='尚未取得原操作的完整回执，请核对同一次操作。';return;}
    // A rejected continuation retains its original send key until an explicit safe discard.
    if(r.state==='rejected'&&action==='goal-continue')goalIntents.set(id,{...intent,rejection:r.code});
    else if(r.state==='rejected'&&action==='goal-discard'&&stored?.action==='goal-continue')goalIntents.set(id,{...stored,discard:undefined});
    else goalIntents.delete(id);
    try{saveGoalIntents();}catch{/* The original persisted key remains safe to reconcile. */}
    if(!taskContextCurrent(context)||budgetPageId!==id)return;
    if(r.state==='rejected'){$('goal-feedback').textContent=goalErrorLabels[r.code]||'原操作未完成，请核对目标和工作记录后再尝试。';goalSnapshot=null;goalReadVerified=false;void readDialogGoal();return;}
    if(action==='goal-continue'){
      const stage=goalStageDrafts.get(id);if(stage?.next?.instructions===intent.payload.instructions){removeGoalStage(id,'next');saveGoalStages();}
      if($('objective').value===intent.payload.instructions){drafts.delete(id);saveDrafts();$('objective').value='';}
      $('budget-dialog').close();nativeView(false);details(null);showNotice('下一工作包已进入本地队列；是否送达以原任务回执为准。',{owner:captureNoticeContext(id)});return;
    }
    goalSnapshot=r.goal;goalSnapshotView=taskView().goal;
    if(action==='goal-review'&&$('goal-review-notes').value===intent.payload.note&&$('goal-review-decision').value===intent.payload.decision){removeGoalStage(id,'review');saveGoalStages();goalReviewEditing=false;goalReviewBasis=goalBasis(r.goal);}
    if(action==='goal-save'){
      if($('goal-objective').value===intent.payload.objective&&($('goal-auto-continue').checked?'automatic':'manual')===intent.payload.mode){goalDrafts.delete(id);goalModeDrafts.delete(id);goalDraftBases.delete(id);saveGoalDrafts();goalEditing=false;goalEditBasis=goalBasis(r.goal);}
      $('goal-feedback').textContent='目标已保存，本次没有发送模型消息。启用持续推进后，未完成工作自动接续，完整交付后停止发送。';
    }else if(action==='goal-discard')$('goal-feedback').textContent='原待发工作包已撤销，目标、验收、预算和原错误保留。没有发送模型消息。';
    else $('goal-feedback').textContent=intent.payload.decision==='complete'?'你的目标完成决定已保存。没有发送模型消息。':'验收决定已保存，没有发送模型消息。'+(intent.payload.decision==='continue'?'核对预算后，明确点击“开始下一包”才接续。':'请修正目标或验收反馈后再决定下一包。');
  });renderBudget();render();
}
$('goal-form').onsubmit=async event=>{event.preventDefault();renderBudget();if(!$('goal-form').hidden&&!$('goal-save').disabled)await mutateGoal('goal-save',{objective:$('goal-objective').value,mode:$('goal-auto-continue').checked?'automatic':'manual'});};
$('goal-review-form').onsubmit=async event=>{event.preventDefault();renderBudget();if(!$('goal-review-section').hidden&&!$('goal-review-save').disabled)await mutateGoal('goal-review',{decision:$('goal-review-decision').value,note:$('goal-review-notes').value});};
$('goal-review-edit').onclick=()=>{
  renderBudget();if($('goal-review-edit').disabled)return;
  const g=currentDialogGoal(),b=budgetSnapshot||state.pages.find(p=>p.id===budgetPageId)?.budget_status,conflicts=goalStageConflicts(g,b);
  if(goalReviewEditing||conflicts.review||conflicts.next){
    const previous=goalStageDrafts.get(budgetPageId);removeGoalStage(budgetPageId,'review');
    if(conflicts.next)removeGoalStage(budgetPageId,'next');
    if(!saveGoalStages()){if(previous)goalStageDrafts.set(budgetPageId,previous);return;}
    goalReviewEditing=false;goalReviewBasis=goalBasis(g);
    if(conflicts.next){goalNextBasis=goalNextBasisFor(g,b);$('budget-instructions').value='';}
    renderBudget();return;
  }
  goalReviewEditing=true;goalReviewBasis=goalBasis(g);preserveGoalStage('review');
};
$('goal-discard').onclick=()=>{
  renderBudget();if($('goal-discard').disabled)return;
  return mutateGoal('goal-discard',{expected_pending_id:currentDialogGoal()?.next?.operation_id||goalIntents.get(budgetPageId)?.payload.operation_id});
};
$('budget-form').onsubmit=async event=>{
  event.preventDefault();renderBudget();if($('budget-save').disabled)return;
  await once('budget',async()=>{
    const id=budgetPageId,context=captureTaskContext(id),p=state.pages.find(p=>p.id===id),b=budgetSnapshot||p?.budget_status;if(!b||!dialogOwnsTask())return;
    let intent=refillIntents.get(id);
    if(!intent){
      intent={id,operation_id:crypto.randomUUID(),expected_etag:b.etag,add_dispatches:Number($('refill-sends').value),add_seconds:Math.round(Number($('refill-hours').value)*3600)};
      refillIntents.set(id,intent);
      try{saveRefillIntents();}catch{refillIntents.delete(id);$('budget-feedback').textContent='无法保存本次操作记录，尚未追加预算。';return;}
    }
    renderBudget();const r=await act('refill-budget',intent);
    if(!r){if(taskContextCurrent(context)&&budgetPageId===id)$('budget-feedback').textContent='回执未确认。点击“核对原预算追加”检查同一操作，不会重复加预算。';return;}
    refillIntents.delete(id);try{saveRefillIntents();}catch{/* Persisted old intent is safe to replay. */}
    if(!taskContextCurrent(context)||budgetPageId!==id)return;
    if(r.state==='rejected'){
      budgetSnapshot=null;
      $('budget-feedback').textContent=goalErrorLabels[r.code]||'原预算未修改，请核对后再保存。';return;
    }
    showNotice('');budgetSnapshot=r.budget;$('refill-sends').value=0;$('refill-hours').value=0;
    $('budget-feedback').textContent='追加预算已保存，没有发送模型消息。原有暂停保持。';
    // Budget changes alter the goal's eligibility; read the canonical detail again.
    if(currentDialogGoal()?.configured)void readDialogGoal();
  });renderBudget();
};
$('budget-continue').onclick=async()=>{
  renderBudget();if($('budget-continue-section').hidden||$('budget-continue').disabled)return;
  if(currentDialogGoal()?.configured)return mutateGoal('goal-continue',{expected_run_id:goalIntents.get(budgetPageId)?.payload.expected_run_id||currentDialogGoal()?.next?.expected_run_id||goalNextBasis?.run_id,instructions:currentDialogGoal()?.next&&!goalIntents.has(budgetPageId)?'':$('budget-instructions').value});
  await once('budget',async()=>{
    const owner=captureNoticeContext(budgetPageId);renderBudget();const r=await act('budget-continue',{id:budgetPageId,expected_run_id:(budgetSnapshot||state.pages.find(p=>p.id===budgetPageId)?.budget_status)?.run_id,instructions:$('budget-instructions').value});
    if(r&&noticeContextCurrent(owner)){$('budget-dialog').close();nativeView(false);details(null);showNotice('原任务已排队接续，沿用原对话、模型和成果。',{owner});}
    else if(!r&&noticeContextCurrent(owner))$('budget-feedback').textContent='接续尚未确认：'+$('notice-text').textContent;
  });renderBudget();
};
let taskSelectionSerial=0;
async function selectTask(id){
  const serial=++taskSelectionSerial;
  closeMobileNavigation();
  newTaskDraft=null;
  if(workflowMode!=='web')setWorkflowMode('web');
  const epoch=workflowEpoch,r=await act('select',{id});
  if(r&&serial===taskSelectionSerial&&workflowEpoch===epoch&&workflowMode==='web'&&current()?.id===id){const p=current();nativeView(p?.kind==='account');if(detailMode==='settings')fillSettings();}
}
function showDialog({kind,id,root,title,description,confirm}){
  const stopRecord=kind==='stop-generation'?(taskView()?.request||current()?.latest_request):null;
  dialogAction={kind,id,root,...(kind==='stop-generation'?{context:captureTaskContext(id),expectedRequest:['queued','processing','suspended'].includes(stopRecord?.phase)?stopRecord.id:null}:{})};$('dialog-title').textContent=title;$('dialog-description').textContent=description||'';
  const fields=kind==='rename';$('dialog-fields').hidden=!fields;
  $('dialog-name').required=fields;
  $('dialog-name').value=kind==='rename'?state.pages.find(p=>p.id===id)?.title||'':'';
  $('dialog-confirm').textContent=confirm;$('dialog-confirm').disabled=false;$('dialog-error').hidden=true;
  $('task-dialog').showModal();scheduleLayout();
  if(fields)$('dialog-name').focus();
  if(kind==='quit')renderExitFeedback();
}
function renderExitFeedback(){
 const exit=state.exit;
 if(dialogAction?.kind!=='quit'||!exit||exit.state==='idle')return;
 const phases={'waiting-current-turn':'本轮结束后退出，已停止后续发送。当前网页继续工作，结束后自动保存退出。',checking:'正在暂停后续推进并核对当前网页与本地执行…','closing-native':'正在关闭原生执行所有者…','closing-host':'正在关闭原 Host…','awaiting-original-exit':'原关闭请求已保留，可继续核对原回执。','saving':'原所有者已退出，正在保存现场…','save-failed':'原所有者已退出，点击接续即可重试保存现场。',completed:'退出已确认，正在关闭工作区。',blocked:'退出暂未完成，原任务已保留。'};
 const reasons={browser_generating:'网页正在生成',browser_stop_present:'网页仍有停止控件',browser_draft:'网页有未提交草稿',browser_composing:'网页正在输入',browser_confirmation:'网页等待确认',original_send_unresolved:'原发送结果未确认',original_browser_turn_unverified:'原网页回合身份未确认',exit_local_operation_pending:'本地原操作尚未完成',exit_observation_pending:'界面状态读取尚未返回；原工作保留，可稍后核对本次退出',running_call:'原 Session 仍在执行',session_call:'原 Session 调用状态待核对',active_job:'本地 Job 仍在执行',owned_jobs:'原 Job 尚未结束',owned_job_outcome_unknown:'原 Job 执行结果未知',owned_jobs_inventory_incomplete:'原 Session 的 Job 清单尚未核对完整',owned_job_identity:'原 Job 的执行归属待核对',unknown_local_operation:'本地原命令结果未确认',exit_original_native_pending:'原生所有者退出回执待确认',exit_original_host_pending:'Host 退出回执待确认'};
 const jobStates={queued:'排队中',agent_queued:'代理队列中',started:'已开始',running:'正在执行',stop_requested:'已请求停止，仍待结束',recovering:'正在恢复',completed:'已结束',failed:'执行失败',stopped:'已停止',cancelled:'已取消',lost:'执行记录丢失',timeout:'超时',timed_out:'超时'};
 const executionStates={completed:'执行已结束',not_started:'确认未开始',timed_out:'执行已超时',outcome_unknown:'执行结果未知',unknown:'执行结果未知'};
 const details=[...(exit.active_conversations||[]),...(exit.blocked_reasons||[])].map(row=>{
  const task=state.pages.find(p=>p.id===row.page_id);
  const who=row.title||task?.title||row.page_id||row.thread_id||'';
  const jobs=[...new Set([row.job_id,...(Array.isArray(row.job_ids)?row.job_ids.slice(0,16):[])].filter(id=>typeof id==='string'&&id.length))];
  const jobState=row.status||row.job_state;
  return [who,reasons[row.code]||row.reason||row.code,row.request_id?'请求 '+row.request_id:'',jobs.length?'Job '+jobs.join(', '):'',row.session_id?'Session '+row.session_id:'',row.project?'范围 '+row.project:'',jobState?'状态 '+(jobStates[jobState]||jobState):'',row.command_execution_state?'执行 '+(executionStates[row.command_execution_state]||row.command_execution_state):''].filter(Boolean).join(' · ');
 });
 $('dialog-description').textContent=(phases[exit.state]||exit.state)+(details.length?'\n'+details.join('\n'):'')+'\n退出操作：'+exit.operation_id;
 const waiting=exit.state==='waiting-current-turn';$('dialog-cancel').textContent=waiting?'取消退出等待':'取消';
 const running=['waiting-current-turn','checking','closing-native','closing-host','saving','completed'].includes(exit.state);
 $('task-dialog').setAttribute('aria-busy',String(running));
 $('dialog-confirm').disabled=running||busy.has('dialog');
 $('dialog-confirm').textContent=running?'正在退出…':['awaiting-original-exit','save-failed'].includes(exit.state)?'接续原退出':'退出';
}
function newTask(root){
  if(busy.has('first-task'))return;
  const account=current()?.account||state.defaultAccount||'B';
  newTaskDraft={id:'new-task',draft:true,kind:'task',title:'新任务',root:root||'',account};
  settingsPageId=null;selectedId=null;nativeView(false);details(null);render();
  $('first-task-options').open=!!root;$('first-task-objective').focus();
}
function renameTask(id){showDialog({kind:'rename',id,title:'重命名任务',confirm:'保存'});}
async function closeTask(id){
  await once('close:'+id,async()=>{
    const owner=captureNoticeContext(id);
    const r=await act('close',{id});
    if(r?.confirmation&&noticeContextCurrent(owner))showDialog({kind:'close',id,title:'关闭「'+r.title+'」？',description:r.reason,confirm:'关闭并保留现场'});
    else if(r?.closed)showNotice('已关闭「'+r.title+'」，可从左下角「已关闭」重新打开。',{owner});
  });
}
$('task-dialog-form').onsubmit=async event=>{
  event.preventDefault();if(!dialogAction||busy.has('dialog'))return;
  await once('dialog',async()=>{
    const owner=captureNoticeContext(),a=dialogAction,confirm=$('dialog-confirm');confirm.disabled=true;const label=confirm.textContent;
    confirm.textContent=a.kind==='quit'?'正在核对退出…':'正在保存…';
    let result;
    if(a.kind==='rename')result=await act('rename',{id:a.id,title:$('dialog-name').value});
    if(a.kind==='close')result=await act('close',{id:a.id,confirmed:true});
    if(a.kind==='delete')result=await act('delete-task',{id:a.id});
    if(a.kind==='quit')result=await act(['awaiting-original-exit','save-failed'].includes(state.exit?.state)?'reconcile-exit':'quit',
      ['awaiting-original-exit','save-failed'].includes(state.exit?.state)?{exit_id:state.exit.exit_id}:{});
    if(a.kind==='stop-generation'){
      if(!taskContextCurrent(a.context)){showNotice('任务已切换或原回合已经变化；请在要停止的原任务中重新确认。');$('task-dialog').close();return;}
      result=await act('stop-generation',{id:a.id,expected_request_id:a.expectedRequest,...(Number.isInteger(a.context.connection)?{expected_connection_generation:a.context.connection}:{})});
      if(result)showNotice(result.pending?'后续派发已暂停，部分网页的停止结果待核对；本地命令未标为停止。':'网页生成已停止，后续派发已暂停。本地命令保留原回执，恢复时先核对。',{owner});
    }
    if(a.kind==='close-project'){
      result={};const targets=state.pages.filter(p=>projectKey(p.root)===projectKey(a.root)&&p.kind!=='account').map(p=>p.id);
      for(const id of targets){if(!await act('close',{id,confirmed:true})){result=undefined;break;}}
    }
    confirm.disabled=false;confirm.textContent=label;
    if(result&&a.kind==='quit'){
      if(result.exit)state={...state,exit:result.exit};
      renderExitFeedback();
    }else if(result){
      $('task-dialog').close();
      if(a.kind==='delete'){
        for(const map of [drafts,firstTurnDrafts,firstTurnEfforts,protocolDrafts,collaborationDrafts,modelDrafts])map.delete(a.id);
        try{localStorage.setItem('clw-first-turn-efforts',JSON.stringify([...firstTurnEfforts]));}catch{}
        saveDrafts();saveProtocolDrafts();saveCollaborationDrafts();saveFirstTurnDrafts();
        showNotice('已删除本机任务记录。成果文件和 ChatGPT 原对话保留。',{owner});
      }
      if(a.kind==='close-project')showNotice('项目已从侧栏移除，任务保留在「已关闭」。',{owner});
    }else{$('dialog-error').textContent=a.kind==='quit'&&state.exit?.blocked_reasons?.length?state.exit.blocked_reasons.map(r=>r.title?r.title+'：'+r.code:r.code).join('\n'):$('notice-text').textContent||'操作未完成，请稍后重试。';$('dialog-error').hidden=false;}
  });
  if(dialogAction?.kind==='quit')renderExitFeedback();
};
$('task-dialog').onclose=()=>{dialogAction=null;scheduleLayout();};
for(const id of ['dialog-cancel','dialog-close'])$(id).onclick=async()=>{if(busy.has('dialog'))return;if(dialogAction?.kind==='quit'&&state.exit?.state==='waiting-current-turn'){const result=await act('cancel-exit',{exit_id:state.exit.exit_id});if(!result)return;}$('task-dialog').close();};
$('task-dialog').addEventListener('cancel',event=>{if(busy.has('dialog')||dialogAction?.kind==='quit'&&state.exit?.state==='waiting-current-turn'){event.preventDefault();if(!busy.has('dialog'))void $('dialog-cancel').onclick();}});
window.clw.onState(next=>{
  const update=CLWStatePatch.apply(state,next);
  if(update.ignored)return;
  if(update.needsSnapshot){
    if(!stateSnapshotRequested){stateSnapshotRequested=true;void act('status').then(result=>{if(result===undefined)stateSnapshotRequested=false;});}
    return;
  }
  if(update.snapshot)stateSnapshotRequested=false;next=update.state;
  if(state.connected!==next.connected)rendererConnectionEpoch++;
  const priorNotice=state.notice;
  const recoveredNotice=next.notice===disconnectedNotice&&next.connected===true&&next.taskStateReady===true;
  state={closed:[],...next,notice:recoveredNotice?'':next.notice};
  window.clwPreview?.update(state);
  if(shellViewRestore&&state.taskStateReady){
    if(shellViewRestore.selected===(state.selected||null)&&shellViewRestore.workflow===workflowMode)native=shellViewRestore.native===true;
    shellViewRestore=null;
  }
  renderInteractionFeedback();
  if(budgetPageId&&state.pages.some(p=>p.id===budgetPageId&&p.budget_status))budgetSnapshot=null;
  if(recoveredNotice){
    // The bridge may retain its old global string after recovery. Retire only
    // that connection warning; a newer request or local error still matters.
    if(pendingStateNotice?.text===disconnectedNotice)pendingStateNotice=null;
    if($('notice-text').textContent===disconnectedNotice)pendingStateNotice={text:'',scope:'global'};
  }else if(state.notice!==priorNotice)pendingStateNotice={text:state.notice||'',scope:globalConnectionNotice(state.notice||priorNotice)?'global':'task',owner:captureNoticeContext()};
  // Selection binds editable fields to a task; update it before another input.
  if(selectedId!==(current()?.id||null))renderStateImmediately();else queueStateRender();
});
window.clw.onIntent(intent=>{
  if(intent.action==='login')void once('login',async()=>{newTaskDraft=null;const r=await act('login',{account:intent.id});if(r){details(null);nativeView(true);}});
  if(intent.action==='rename')renameTask(intent.id);
  if(intent.action==='close')void closeTask(intent.id);
  if(intent.action==='settings')void selectTask(intent.id).then(()=>details('settings'));
  if(intent.action==='new-in-project')newTask(intent.id);
  if(intent.action==='close-project')showDialog({kind:'close-project',root:intent.id,title:'移除「'+basename(intent.id)+'」？',description:'将关闭此项目下的任务，并暂停后续派发。已开始的执行和本地项目文件保留；任务可从「已关闭」重新打开。',confirm:'移出侧栏'});
});
// Explicit application protocol, independent of browser automation. The main
// process sends fixed intents; no arbitrary script, selector or click enters it.
if(typeof window.clw.onControl==='function')window.clw.onControl(async request=>{
  const respond=result=>window.clw.respondControl({id:request.id,ok:true,result});
  try{
    if(request.action==='inspect'){
      renderStateImmediately();
      const ids=['thread-title','sidebar-toggle','composer-stack','composer-context','composer-pending','composer-goal','composer',
        'objective','composer-add','composer-access','model-button','start','details','budget-dialog','quota-dialog'];
      const geometry=Object.fromEntries(ids.map(id=>{const node=$(id),r=node?.getBoundingClientRect();
        return [id,node?{visible:!node.hidden&&r.width>0&&r.height>0,
          x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),
          scroll_width:node.scrollWidth,client_width:node.clientWidth}:null];}));
      respond({selected:state.selected||null,workflow:workflowMode,view:native?'web':'records',detail:detailMode,
        viewport:{width:window.innerWidth,height:window.innerHeight},navigation_collapsed:navigationCollapsed,
        draft_length:$('objective').value.length,formula_count:document.querySelectorAll('.katex').length,
        composer_action:{kind:$('start').dataset.action,label:$('start').dataset.label,disabled:$('start').disabled,
          request_id:taskView().request?.id||null,draft_length:$('objective').value.length},
        dialogs:[...document.querySelectorAll('dialog[open]')].map(node=>node.id),
        workflow_state:{title:$('workflow-title').textContent,observation_notice:$('workflow-observation').hidden?null:$('workflow-observation').textContent,
          action_visible:!$('workflow-action').hidden,action_label:$('workflow-action').dataset.label||null,
          menu_resume_visible:!$('resume').hidden,process_title:$('public-process').textContent},
        goal_controls:{state:$('composer-goal-state').textContent,visible:!$('composer-goal').hidden,
          toggle_visible:!$('composer-goal-toggle').hidden,toggle_label:$('composer-goal-toggle').getAttribute('aria-label'),toggle_disabled:$('composer-goal-toggle').disabled,
          close_visible:!$('composer-goal-stop').hidden,close_disabled:$('composer-goal-stop').disabled,
          webpage_stop_visible:!$('composer-stop').hidden},
        work_timer:workClock.snapshot(),pending_actions:busy.size,geometry,model_sends:0});return;
    }
    if(request.action==='prepare-reload'){
      if(busy.size||interactionFeedback.snapshot()||newTaskDraft||detailMode||composerComposition||unsavedEnrollmentSettings()||document.querySelector('dialog[open]')||
        workflowMode==='local'&&$('local-codex-root').value!==(current()?.root||state.root||''))
        throw Error('app_shell_edit_or_operation_in_progress');
      if(selectedId&&!writeComposerDraft(selectedId,$('objective').value))throw Error('app_shell_draft_not_saved');
      rememberRecordPosition();
      // Native WebContents stay in the main process. Only restore their display
      // preference after the new shell has received its first coherent state.
      localStorage.setItem('clw-shell-view',JSON.stringify({selected:state.selected||null,workflow:workflowMode,native}));
      respond({safe:true,draft_saved:true,model_sends:0});return;
    }
    if(request.action==='view'){
      const target=request.payload?.view;
      if(busy.size)throw Error('app_shell_operation_in_progress');
      if(target==='goal'){if(workflowMode!=='web'||!current()?.bound)throw Error('app_shell_goal_unavailable');await openBudget();}
      else if(target==='quota')$('quota-open').onclick();
      else if(target==='settings')details(workflowMode==='codex'?'codex':'settings');
      else if(target==='records'){nativeView(false);details(null);render();}
      else if(target==='web'){nativeView(true);details(null);render();}
      else if(['web-workflow','codex-workflow','local-workflow'].includes(target))setWorkflowMode(target.split('-')[0]);
      else if(target==='navigation-open'){navigationCollapsed=false;renderNavigationChrome();scheduleLayout();}
      else if(target==='navigation-close'){navigationCollapsed=true;renderNavigationChrome();scheduleLayout();}
      else throw Error('app_shell_view_invalid');
      respond({view:target,model_sends:0});return;
    }
    throw Error('app_shell_control_invalid');
  }catch(error){window.clw.respondControl({id:request.id,ok:false,code:error.message});}
});
$('new-page').onclick=()=>workflowMode==='codex'?details('codex'):workflowMode==='local'?$('local-codex-root').focus():newTask();$('setup-start').onclick=()=>newTask();
$('search').oninput=()=>render();
$('login').onclick=()=>{if(workflowMode==='codex')details('codex');else void act('accounts');};
$('closed-tasks').onclick=()=>details(detailMode==='closed'?null:'closed');
$('settings').onclick=()=>{const kind=workflowMode==='codex'?'codex':'settings';details(detailMode===kind?null:kind);};
$('setup-current').onclick=()=>{nativeView(false);details('settings');};
$('intake-configure').onclick=()=>details('settings');
$('setup-web').onclick=()=>{nativeView(true);details(null);};
$('intake-open-web').onclick=()=>{nativeView(true);details(null);};
$('workflow-toggle').onclick=()=>{workflowDetailOpen=!workflowDetailOpen;workflowDisclosure(workflowDetailKey);if(workflowMode==='web')renderWorkflow(current());else renderWorkspaceMode();scheduleLayout();};
$('close-details').onclick=()=>details(null);$('close-current').onclick=()=>{if(current())void closeTask(current().id);};
$('thread-title').ondblclick=()=>{if(workflowMode==='web'&&current()&&!current().draft)renameTask(current().id);};
$('native').onclick=()=>{if(workflowMode==='codex'){const row=CLWCodexTurns.filterRows(state.codexWeb?.recent||[],codexSelected)[0];if(row)void openCodexWeb(row.traceId);}else nativeView(true);};$('records').onclick=()=>{nativeViewIntent++;nativeView(false);render();};
for(const [id,direction]of [['record-earlier','before'],['record-first','first'],['record-latest','latest']])$(id).onclick=()=>{
  rememberRecordPosition();if(recordHistory.active)recordHistory.active.indexOpen=false;renderRecordToolbar();
  if(direction==='latest')void recordHistory.follow();else void recordHistory.navigate(direction);
};
function openRecordDirectory(find=false){
  const active=recordHistory.active;if(!active?.capable)return;
  active.indexOpen=find||!active.indexOpen;renderRecordToolbar();scheduleLayout();
  if(active.indexOpen){void recordHistory.directory($('record-find').value);$('record-find').focus();}
}
$('record-directory-toggle').onclick=()=>openRecordDirectory();
$('record-drawer-close').onclick=()=>{if(recordHistory.active)recordHistory.active.indexOpen=false;renderRecordToolbar();scheduleLayout();};
$('record-find-form').onsubmit=event=>{event.preventDefault();clearTimeout(recordFindTimer);void recordHistory.directory($('record-find').value);};
$('record-find').oninput=()=>{clearTimeout(recordFindTimer);const active=recordHistory.active,version=recordHistory.version,query=$('record-find').value;
  recordFindTimer=setTimeout(()=>{if(recordHistory.active===active&&recordHistory.version===version)void recordHistory.directory(query);},280);};
for(const [id,direction]of [['record-index-before','before'],['record-index-first','first'],['record-index-after','after']])$(id).onclick=()=>{void recordHistory.directory($('record-find').value,direction);};
$('record-collapse').onclick=()=>{
  captureReadingLayout();requestAnimationFrame(applyReadingLayout);
  const active=recordHistory.active;if(!active)return;const container=$(active.mode==='codex'?'codex-turns':'events');
  container.querySelectorAll('.record-body').forEach(body=>body.collapse?.());
  container.querySelectorAll('details').forEach(node=>{node.open=false;if(node.dataset.recordKey)recordFold(active.key,node.dataset.recordKey,false);});
  for(const entry of webRecordNodes.values())entry.autoOpen=false;rememberRecordPosition();active.indexOpen=false;renderRecordToolbar();
};
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'&&!native&&recordHistory.active?.capable){event.preventDefault();openRecordDirectory(true);}
  if(event.key==='Escape'&&!$('record-drawer').hidden){$('record-drawer-close').click();}
});
const recordScrollInput=new WeakMap();
for(const mode of ['web','codex']){
const scroller=recordScroller(mode),markInput=()=>{readingLayout=null;recordScrollInput.set(scroller,Date.now());};
for(const event of ['wheel','touchmove'])scroller.addEventListener(event,markInput,{passive:true});
scroller.addEventListener('pointerdown',event=>{if(event.target===scroller)markInput();},{passive:true});
scroller.addEventListener('keydown',event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))markInput();});
scroller.addEventListener('scroll',()=>{
  const active=recordHistory.active;if(active?.mode!==mode||recordRenderedKey!==active.key)return;
  const away=scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop>100;
  if(Date.now()-(recordScrollInput.get(scroller)??-Infinity)<800&&!active.loading){
    active.following=!away;if(!away&&active.live){active.newer=false;active.seenLatest=active.seed.at(-1)&&CLWRecordHistory.identity(mode,active.seed.at(-1));}
    renderRecordToolbar();
  }rememberRecordPosition();
},{passive:true});
}
// Saved replies may finish loading after the state paint. Following is the
// reader's intent, so content growth should keep the same latest edge without
// waiting for another heartbeat or treating a layout scroll as reader input.
document.addEventListener('click',event=>{if(event.target.closest?.('#events summary,#events .record-body-toggle,#codex-turns summary,#codex-turns .record-body-toggle'))preserveReaderLayout();},true);
const recordContentObserver=new ResizeObserver(()=>{
  const active=recordHistory.active;
  if(!active||native||recordRenderedKey!==active.key)return;
  if(readingLayout?.key===active.key){requestAnimationFrame(applyReadingLayout);return;}
  if(active.live&&active.following!==false)restoreRecordScroll(active,null,true,false);
  else {const view=recordView(active.key);if(view.anchor)restoreRecordScroll(active,view.anchor,false,false);}
});
for(const id of ['events','codex-turns'])recordContentObserver.observe($(id));
for(const [id,mode]of [['mode-web','web'],['mode-codex','codex'],['mode-local','local']])$(id).onclick=()=>{closeWorkflowSelector(true);setWorkflowMode(mode);};
$('local-codex-browse').onclick=async()=>{const r=await act('pick-root',{root:$('local-codex-root').value});if(r?.root)$('local-codex-root').value=r.root;};
async function launchLocalCodex(resume){
  const workingDirectory=$('local-codex-root').value.trim();
  if(state.localCodex?.available!==true||!workingDirectory)return showNotice('请先选择工作目录，并确认本机已安装 Codex。');
  await once('local-codex-start',async()=>{
    const owner=captureNoticeContext();
    render();const result=await act('native-codex-start',{workingDirectory,resume});
    if(result)showNotice('已打开本地 Codex 终端；沿用本机账号与模型，输入目标后开始工作。',{owner});
  });render();
}
$('local-codex-form').onsubmit=event=>{event.preventDefault();return launchLocalCodex(false);};
$('local-codex-resume').onclick=()=>launchLocalCodex(true);
for(const id of ['session-mcp-activity','codex-mcp-activity'])$(id).addEventListener('toggle',()=>{
  if(id==='session-mcp-activity')renderSessionActivity();else renderToolActivity(id,state.codexWeb?.mcpActivity,'connection');
});
$('task-menu').addEventListener('toggle',event=>{
  if(event.newState==='open'){const rect=$('task-menu-toggle').getBoundingClientRect();$('task-menu').style.top=(rect.bottom+8)+'px';$('task-menu').style.left=Math.max(12,rect.right-248)+'px';}
  scheduleLayout();
});
$('task-menu').addEventListener('click',event=>{if(event.target.closest('button'))$('task-menu').hidePopover();});
$('codex-settings').onclick=()=>details('codex');
$('codex-manage-account').onclick=()=>{setWorkflowMode('web');void act('accounts');};
$('codex-overview').onclick=()=>codexOverview(false);$('codex-archive').onclick=()=>codexOverview(true);$('codex-back').onclick=()=>codexOverview(codexArchiveView);
$('codex-browse').onclick=async()=>{const r=await act('pick-root',{root:$('codex-root').value});if(r?.root)$('codex-root').value=r.root;};
$('codex-check').onclick=()=>once('codex-check',async()=>{const owner=captureNoticeContext(),r=await act('codex-verify');if(r)showNotice('Codex＋Web 连接检查通过，没有发送模型消息。',{owner});});
for(const [id,resume] of [['codex-open',false],['codex-resume',true]])$(id).onclick=()=>once('codex-start',async()=>{
  const owner=captureNoticeContext();
  const r=await act('codex-start',{model:$('codex-model').value,workingDirectory:$('codex-root').value,resume});
  if(r)showNotice('已打开 Codex＋Web 终端。输入目标开始；完整工作与工具调用在同一任务中继续。',{owner});
});
$('refresh-page').onclick=()=>{
  if($('refresh-page').hidden||$('refresh-page').disabled)return;
  return once('refresh',async()=>{
    const owner=captureNoticeContext();renderRefreshControl();
    if(workflowMode==='codex'){const r=await act('codex-refresh-web');if(r)showNotice(r.message,{owner});return;}
    const id=current()?.id;if(!id)return;
    const r=await act('refresh',{id});if(r){modelDrafts.delete(id);showNotice(r.message,{owner});}
  }).finally(()=>renderRefreshControl());
};
$('theme').onclick=()=>act('theme',{theme:state.theme==='light'?'dark':'light'});
$('accent-select').onchange=()=>act('theme',{theme:state.theme||'dark',accent:$('accent-select').value});
$('dismiss-notice').onclick=()=>{showNotice('');void act('dismiss-notice');};
$('access').onchange=()=>{$('write-paths-field').hidden=$('access').value!=='write';$('write-paths').required=$('access').value==='write';};
$('collaboration-protocol').onchange=()=>{const p=current();if(p&&!p.bound&&!p.enrolling){protocolDrafts.set(p.id,$('collaboration-protocol').value);saveProtocolDrafts();}updateProtocolHelp(p);};
$('collaboration-enabled').onchange=()=>{const p=current();if(p&&!p.bound&&!p.enrolling){collaborationDrafts.set(p.id,$('collaboration-enabled').checked);saveCollaborationDrafts();}updateProtocolHelp();render();clearTimeout(previewTimer);previewTimer=setTimeout(renderPromptPreview,350);};
$('inspect').onclick=()=>once('inspect',async()=>{
  $('inspect').disabled=true;
  const id=current()?.id,context=captureTaskContext(id);
  try{const r=await act('inspect',{id});if(r&&taskContextCurrent(context)){modelDrafts.set(id,r);$('model').value=r.model;$('effort').value=r.effort;fillSettings();}}
  finally{$('inspect').disabled=!!current()?.enrolling;}
});
$('adopt-model').onclick=()=>once('adopt-model',async()=>{
  const id=current()?.id,context=captureTaskContext(id),model=modelDrafts.get(id);if(!model)return;
  const r=await act('adopt-model',{id,model:model.model,effort:model.effort});
  if(r){modelDrafts.delete(id);if(taskContextCurrent(context))showNotice('已采用网页设置，后续轮次和新 worker 使用 '+r.effort+'。'+(r.paused?'任务仍暂停，确认后点击恢复。':'已有 worker 的设置保留。'));}
});
$('review-model').onclick=()=>{details('settings');$('inspect').click();};
$('settings-form').onsubmit=async event=>{
  event.preventDefault();await once('enroll',async()=>{
    const p=current();if(!p)return;
    const context=captureTaskContext(p.id);
    if($('access').value==='write'&&!$('write-paths').value.split(/[,，]/).some(x=>x.trim())){showNotice('请先填写可写的相对目录；空白不代表整个项目。'+(p.intake?.can_edit_scope?'配置尚未保存。':'接入消息尚未发送。'));$('write-paths').focus();return;}
    if(p.intake?.can_edit_scope){
      const r=await act('configure-intake',{id:p.id,...selectedAccess(),expected_access:p.access,expected_write_paths:p.write_paths});
      if(r&&taskContextCurrent(context)){showNotice(r.message);fillSettings();}return;
    }
    if(!p.enrolling&&!p.bound)$('first-task-form').requestSubmit();
  });
};
$('first-task-objective').oninput=()=>{
  const id=current()?.id;if(!id)return;
  firstTurnDrafts.set(id,$('first-task-objective').value);saveFirstTurnDrafts();
  clearTimeout(previewTimer);previewTimer=setTimeout(renderPromptPreview,350);
};
$('first-task-account').onchange=()=>{if(newTaskDraft){newTaskDraft.account=$('first-task-account').value;render();void renderPromptPreview();}};
$('root').oninput=()=>{if(newTaskDraft){newTaskDraft.root=$('root').value;clearTimeout(previewTimer);previewTimer=setTimeout(renderPromptPreview,350);}};
$('title').oninput=()=>{if(newTaskDraft)newTaskDraft.taskTitle=$('title').value;};
$('first-browse-root').onclick=async()=>{const p=current(),r=await act('pick-root',{root:$('root').value});if(r?.root&&p===newTaskDraft){p.root=r.root;$('root').value=r.root;void renderPromptPreview();}};
for(const choice of document.querySelectorAll('[data-first-effort]'))choice.onclick=()=>{
  const id=current()?.id;if(!id)return;
  $('first-task-effort').value=choice.dataset.firstEffort;
  firstTurnEfforts.set(id,choice.dataset.firstEffort);
  try{localStorage.setItem('clw-first-turn-efforts',JSON.stringify([...firstTurnEfforts]));}catch{showNotice('模型选择暂未保存。');}
  $('first-model-menu').hidePopover();
  render();
};
$('first-task-effort').onclick=()=>{
  const menu=$('first-model-menu'),anchor=$('first-task-effort').getBoundingClientRect();
  menu.style.left=Math.max(12,Math.min(anchor.left,window.innerWidth-284))+'px';
  menu.style.bottom=Math.max(12,window.innerHeight-anchor.top+8)+'px';menu.showPopover();
  menu.querySelector('[aria-checked="true"]')?.focus();
};
$('first-model-menu').onkeydown=event=>{
  const choices=[...document.querySelectorAll('[data-first-effort]')],at=choices.indexOf(document.activeElement);
  const next=event.key==='ArrowDown'?(at+1)%choices.length:event.key==='ArrowUp'?(at+choices.length-1)%choices.length:event.key==='Home'?0:event.key==='End'?choices.length-1:null;
  if(next!==null){event.preventDefault();choices[next].focus();}
};
$('task-prompt-preview').ontoggle=()=>{if($('task-prompt-preview').open)void renderPromptPreview();};
$('first-task-form').onsubmit=async event=>{
  event.preventDefault();const p=current();if(!p||p.bound||p.enrolling)return;
  const instructions=$('first-task-objective').value.trim(),effort=$('first-task-effort').value;
  if(effort==='Pro'&&!instructions){showNotice('Pro 需要完整的首轮研究或方案要求；仅接入请选择极高。尚未创建或发送。');$('first-task-objective').focus();return;}
  if(!$('settings-form').checkValidity()){$('first-task-options').open=true;$('settings-form').reportValidity();return;}
  const scope=selectedAccess();
  if(scope.access==='write'&&!scope.write_paths.length){showNotice('指定目录访问需要填写可写的相对目录。尚未发送。');$('first-task-options').open=true;return;}
  const options={...scope,collaboration_enabled:$('collaboration-enabled').checked,collaboration_protocol:$('collaboration-protocol').value,duration_seconds:optionalNumber($('hours'))===null?null:Math.round(optionalNumber($('hours'))*3600),max_dispatches:optionalNumber($('budget'))},title=$('title').value.trim(),root=$('root').value.trim();
  await once('first-task',async()=>{
    const owner=captureNoticeContext();
    render();
    let id=p.id;
    if(p.draft){
      const created=await act('new',{title,root,account:p.account,first_turn_instructions:instructions,first_turn_options:{effort,...options}});if(!created)return;
      id=created.id;firstTurnDrafts.set(id,instructions);firstTurnEfforts.set(id,effort);saveFirstTurnDrafts();
      collaborationDrafts.set(id,options.collaboration_enabled);collaborationDrafts.delete('new-task');saveCollaborationDrafts();
      if(newTaskDraft===p)newTaskDraft=null;
      render();
      // Preserve options if page loading or model verification stops this send.
      if(current()?.id===id){$('access').value=scope.access==='write'&&scope.write_paths[0]==='.'?'full':scope.access;$('write-paths').value=scope.write_paths.filter(x=>x!=='.').join(', ');$('hours').value=options.duration_seconds==null?'':options.duration_seconds/3600;$('budget').value=options.max_dispatches??'';$('collaboration-protocol').value=options.collaboration_protocol;$('collaboration-enabled').checked=options.collaboration_enabled;}
    }else if(title&&title!==p.title){if(!await act('rename',{id,title}))return;}
    const r=await act('start-first-turn',{id,instructions,effort,...options,wait_for_ready:!!p.draft});
    if(r){firstTurnDrafts.delete('new-task');saveFirstTurnDrafts();
      if(workflowMode===owner.workflow&&workflowEpoch===owner.workflowEpoch&&current()?.id===id){showNotice('本地队列已保存，正在核对网页；是否送达以任务状态为准。');details(null);void renderPromptPreview();}}
  });render();
};
$('composer').onsubmit=async event=>{
  event.preventDefault();await once('start',async()=>{
    const owner=current();if(!owner)return;const context=captureTaskContext(owner.id);
    const action=CLWTaskPresentation.composer(owner,taskView(owner),{draft:$('objective').value,pending:state.pendingObjective,connected:state.connected,modelMismatch:modelState(owner).mismatch});
    if(action.disabled)return;
    if(state.pendingObjective){await reconcileOriginalSubmission(context,state.pendingObjective);return;}
    if(action.kind==='goal'){openBudget({fromComposer:true});return;}
    if(action.kind==='save-draft'){
      if(writeComposerDraft(owner.id,$('objective').value)&&taskContextCurrent(context))showNotice('草稿已保存在本机，尚未排队或发送。解除暂停后，再点击发送消息。');
      return;
    }
    $('start').disabled=true;
    actionLabel($('start'),'正在保存…',action.kind);
    const id=owner.id,original=action.requestId;
    const held=!!(taskView()?.maintenance||current()?.maintenance);
    const submittedText=$('objective').value,submittedRevision=draftRevisions.get(id)||0,submittedDraft=drafts.get(id);
    if(held&&!taskView()?.request)return showNotice('维护暂停中，草稿已保留；当前没有可追加的原任务。');
    const r=await act('start',{id,objective:submittedText,expected_request_id:original||null,resume:false});
    const unchangedDraft=(draftRevisions.get(id)||0)===submittedRevision&&drafts.get(id)===submittedDraft;
    if(r&&unchangedDraft){drafts.delete(id);saveDrafts();if(taskContextCurrent(context)&&$('objective').value===submittedText){$('objective').value='';nativeView(false);details(null);}}
    if(taskContextCurrent(context)){
      if(r?.resume_error)showNotice('补充已保存，但尚未恢复：'+r.resume_error);
      else if(r?.resumed)showNotice('已恢复原任务，正在核对网页并发送待处理内容。');
      else if(['note_saved_not_native_interrupt','note_queued_next_round'].includes(r?.state))showNotice('补充已保存，下一轮合并发送；当前回合继续工作。');
    }
  });render();
};
$('objective').oninput=()=>{
  resizeComposer();
  if(current()?.id)writeComposerDraft(current().id,$('objective').value);
  const over=[...$('objective').value.trim()].length>(taskView()?.request?16000:24000);
  const action=CLWTaskPresentation.composer(current(),taskView(),{draft:$('objective').value,pending:state.pendingObjective,connected:state.connected,modelMismatch:modelState(current()).mismatch});
  $('start').disabled=action.disabled||busy.has('start');actionLabel($('start'),action.label,action.kind);
  renderPrimaryStop(current());
  renderWorkflow(current());
  if(over)render();
};
$('objective').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!composerComposition&&event.keyCode!==229){event.preventDefault();$('composer').requestSubmit();}};
document.addEventListener('compositionstart',()=>{composerComposition=true;},true);
document.addEventListener('compositionend',()=>{composerComposition=false;},true);
$('model-button').onclick=()=>{
  const menu=$('work-model-menu'),anchor=$('model-button').getBoundingClientRect();
  menu.style.left=Math.max(12,Math.min(anchor.left,window.innerWidth-284))+'px';
  menu.style.bottom=Math.max(12,window.innerHeight-anchor.top+8)+'px';
  menu.togglePopover();
};
$('more-models').onclick=()=>{$('work-model-menu').hidePopover();nativeView(true);details('settings');};
for(const choice of document.querySelectorAll('[data-work-effort]'))choice.onclick=()=>once('set-model',async()=>{
  const p=current();if(!p)return;const id=p.id,context=captureTaskContext(id);
  render();
  const r=await act('set-model',{id,effort:choice.dataset.workEffort,expected_model:p.model,expected_effort:p.effort});
  if(r){modelDrafts.delete(id);if(taskContextCurrent(context)){$('work-model-menu').hidePopover();showNotice('工作模型已切换为 '+[r.model,r.effort].filter(Boolean).join(' · ')+'。未发送消息。');}}
}).finally(()=>render());
$('pause').onclick=()=>act('pause');$('resume').onclick=()=>current()?.successor?selectTask(current().successor):act('resume');$('panel').onclick=()=>act('panel');
$('composer-goal-toggle').onclick=()=>{
  const p=current(),view=taskView(p),controls=CLWTaskPresentation.goalControls(p,view,{connected:state.connected});
  if(!controls.toggleEnabled||goalStopIntents.has(p.id))return;
  return once('goal-toggle:'+p.id,()=>act(controls.toggleAction,{id:p.id})).finally(()=>render());
};
$('composer-goal-stop').onclick=async()=>{
  const p=current(),id=p?.id,view=taskView(p),controls=CLWTaskPresentation.goalControls(p,view,{connected:state.connected});
  const goal=CLWTaskPresentation.goalPresentation(p,view).goal;
  const owns=!!p?.bound&&!p.parent&&!p.successor&&p.kind!=='account'&&view.page_id===id&&!view.state_read?.unavailable&&!!goal?.etag;
  if(!controls.stopEnabled&&!(goalStopIntents.has(id)&&owns&&state.connected))return;
  const context=captureTaskContext(id),owner=captureNoticeContext(id);
  await once('goal-stop:'+id,async()=>{
    let intent=goalStopIntents.get(id);
    if(!intent){
      intent={action:'goal-stop',payload:{id,operation_id:crypto.randomUUID(),expected_etag:view.goal.etag,expected_goal_request_id:view.goal.request_id}};
      goalStopIntents.set(id,intent);
      try{saveGoalStopIntents();}catch{goalStopIntents.delete(id);showNotice('关闭操作尚未保存，目标保持原状态。',{owner});return;}
    }
    renderComposerContext();const r=await goalCommand('goal-stop',intent.payload);
    if(!r||r.state==='unconfirmed'||goalUnknownCodes.has(r.code)){
      showNotice('正在核对同一次关闭目标操作。要求、成果和原操作记录保留。',{owner});return;
    }
    const accepted=r.state==='goal_stopped'&&r.model_sends===0&&r.future_paused===true&&goalDetailValid(r.goal)&&
      r.goal.state==='stopped'&&r.goal.request_id===intent.payload.expected_goal_request_id;
    if(r.state!=='rejected'&&!accepted){showNotice('关闭目标回执待核对，原操作身份已保留。',{owner});return;}
    goalStopIntents.delete(id);try{saveGoalStopIntents();}catch{}
    if(!taskContextCurrent(context))return;
    if(r.state==='rejected'){showNotice(goalErrorLabels[r.code]||'目标记录已变化，请核对当前目标后再关闭。',{owner});return;}
    const live=CLWTaskPresentation.goalPresentation(current(),taskView()).goal;
    if(live?.configured&&(live.request_id!==r.goal.request_id||live.revision>r.goal.revision||
      live.etag!==intent.payload.expected_etag&&live.etag!==r.goal.etag)){
      showNotice('原关闭操作已核对，后来重新设置的目标保持当前状态。',{owner});render();return;
    }
    showNotice('目标已关闭，后续自动发送已停止。对话与成果保留，已开始的网页和独立任务继续完成。',{owner});
    render();
  });render();
};
$('team-maintenance').onclick=()=>{const id=state.selected;return once('team-maintenance',()=>act('team-maintenance',{id}));};
$('stop-generation').onclick=()=>showDialog({kind:'stop-generation',id:current()?.id,title:'真正停止网页生成？',description:'将中断此主控及其协作者正在生成的网页回合，并暂停后续自动推进。已受理的本地执行不会因此停止；网页隐藏思考不能无损恢复，之后须核对原结果再继续。',confirm:'停止网页生成'});
$('composer-stop').onclick=()=>{if(!renderPrimaryStop(current())||$('composer-stop').disabled)return;return $('stop-generation').onclick();};
$('background').onclick=()=>act('background');
$('quit').onclick=()=>showDialog({kind:'quit',title:'退出并保留现场？',description:'停止后续自动发送，当前网页回合与应用内 Codex 回合结束后保存退出；等待期间可转入后台。未完成目标和原任务记录保留，重新打开后保持暂停。独立计算及本地 Codex 终端继续运行。',confirm:'退出'});
new ResizeObserver(scheduleLayout).observe($('page-host'));
window.addEventListener('resize',()=>{resizeComposer(true);if(navigationPreference===null)navigationCollapsed=(window.innerWidth||1280)<=760;renderNavigationChrome();scheduleLayout();});
void act('status');
