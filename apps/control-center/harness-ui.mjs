import {renderTeam} from './harness-team-ui.mjs';
import {projectEvents,mergeEvents,canSend,composerAction,canClearSubmittedDraft,draftKey,statusLabel,isWebProvider} from './harness-model.mjs';
const $=id=>document.getElementById(id),PENDING='clw.harness.pending.v1';
let info=null,threads=[],selected=null,busy=false,composing=false,polling=false,renderStamp='',history=new Map(),cursors=new Map(),pending=null;
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;n.className=cls;return n;};
const notice=text=>{$('notice').textContent=text;$('notice').hidden=!text;};
try{pending=JSON.parse(sessionStorage.getItem(PENDING)||'null');document.body.classList.toggle('light',localStorage.getItem('clw.harness.theme')==='light');}catch{notice('浏览器存储不可用；请勿关闭带有未确认发送的页面。');}
function savePending(value){pending=value;try{value?sessionStorage.setItem(PENDING,JSON.stringify(value)):sessionStorage.removeItem(PENDING);}catch{throw Error('无法保存发送身份；未开始新的操作。');}$('pendingBox').hidden=!pending;updateComposer();}
function selectedThread(){return threads.find(t=>t.id===selected);}
async function get(route,params={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),18000);
 try{const r=await fetch('/api/harness/'+route+'?'+new URLSearchParams(params),{cache:'no-store',credentials:'omit',signal:controller.signal});const raw=await r.text();if(raw.length>5000000)throw Error('响应超过显示上限');const data=JSON.parse(raw);if(!r.ok||data.success!==true)throw Error(data.code||'读取失败');return data;}finally{clearTimeout(timer);}
}
async function command(action,data={},threadId=selected){
 if(busy||pending)throw Error('请先核对未确认请求');
 busy=true;updateComposer();
 const saved={store_id:info.store_id,command:{request_id:crypto.randomUUID(),action,data,...(threadId?{thread_id:threadId}:{})}};
 try{
  savePending(saved);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
  let response;
  try{response=await fetch('/api/harness/command',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json','X-CLW-Intent':info.intent},body:JSON.stringify(saved.command),signal:controller.signal});}finally{clearTimeout(timer);}
  const result=await response.json();
  if(!response.ok||!result.success)throw Error(result.code||'结果未确认');
  if(result.operation_id!==saved.command.request_id)throw Error('原请求回执不匹配');
  if(result.state==='unknown'||result.state==='dispatching'||result.state==='reserved'){notice('原请求结果未知，已保留。先核对，不重新发送。');return result;}
  savePending(null);
  if(result.state==='rejected')throw Error(result.code||'操作已拒绝');
  notice('');return result;
 }finally{busy=false;updateComposer();}
}
function updateComposer(){
 const row=selectedThread(),action=composerAction(row,pending),allowed=!!action&&!busy;
 $('prompt').disabled=!row;$('send').disabled=!allowed;$('newThread').disabled=busy||!!pending;
 $('send').textContent=['message.steer','message.append'].includes(action)?'追加要求':'发送';
 $('send').title=action==='message.append'?'保存到原任务，Web 下次读取时收到；不打断原生推理':action==='message.steer'?'追加到当前原生回合，不启动第二份执行':'发送新的开发要求';
 $('forkThread').disabled=!row||isWebProvider(row.provider)||!canSend(row,pending)||busy;$('syncThread').disabled=!row||busy||!!pending;
 $('stopTurn').hidden=!row||isWebProvider(row.provider)||!['working','stopping'].includes(row.status);$('stopTurn').disabled=busy||!!pending||row?.status==='stopping';
 $('threadTitle').textContent=row?.title||'开发对话';
 $('threadMeta').textContent=row?statusLabel(row.status)+' · '+row.provider+' · '+(row.parent_id?(row.provider==='chatgpt_web_host'?'逻辑协作分支 · 载体状态见持续运行面板':'原生历史分支'):'主对话'):'原生 Web 与本地 Codex，保留各自运行身份';
 const provider=info?.providers?.find(p=>p.id===(row?.provider||'codex'));$('providerChip').textContent=isWebProvider(row?.provider)?'ChatGPT Web':'本地 Codex';$('modelInfo').textContent=isWebProvider(row?.provider)?'沿用原网页模型与档位 · 非完整历史镜像':provider?.defaults?.model?[provider.defaults.model,provider.defaults.effort].filter(Boolean).join(' · '):'沿用你的模型和思考配置';
}
function renderThreads(){
 const nav=$('threadList'),filter=$('threadSearch').value.toLowerCase();nav.replaceChildren();
 for(const row of threads.filter(t=>t.title.toLowerCase().includes(filter))){
  const button=el('button','',row.id===selected?'selected':'');button.dataset.threadId=row.id;
  button.append(el('span','','dot '+row.status),el('span',(row.parent_id?'↳ ':'')+row.title,'thread-label'));button.title=statusLabel(row.status)+' · '+row.native_id;
  button.onclick=()=>select(row.id);nav.append(button);
 }
 if(!threads.length)nav.append(el('div','还没有会话。创建后将使用真实本地 Codex。','empty'));
 updateComposer();
}
function saveDraft(){if(selected&&info)try{localStorage.setItem(draftKey(info.store_id,selected),$('prompt').value);}catch{notice('草稿只在当前页面中保留。');}}
async function select(id){
 saveDraft();selected=id;renderStamp='';
 try{$('prompt').value=localStorage.getItem(draftKey(info.store_id,id))||'';}catch{$('prompt').value='';}
 $('sidebar').classList.remove('open');renderThreads();renderConversation();await poll();
}
function renderConversation(){
 if(!selected)return;
 const events=history.get(selected)||[],signature=selected+':'+events.length+':'+(events.at(-1)?.seq||0);
 if(signature===renderStamp)return;renderStamp=signature;
 const box=$('conversation'),nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<120,oldTop=box.scrollTop;box.replaceChildren();
 const messages=projectEvents(events);
 if(!messages.length)box.append(el('div','这个真实会话已创建。输入要求，让 AI 开始工作。','welcome-hint'));
 for(const message of messages){
  if(message.role==='tool'){
   const detail=el('details','','tool-event');detail.append(el('summary',(message.status?message.status+' · ':'')+message.text),el('pre',message.detail));box.append(detail);continue;
  }
  const article=el('article','','message '+message.role);article.dataset.messageId=message.id;
  if(message.role!=='system')article.append(el('div',message.role==='user'?(message.steering?'你 · 中途追加':'你'):isWebProvider(message.provider)?'ChatGPT Web':'Codex','by'));
  article.append(el('div',message.text,'text'));box.append(article);
 }
 if(nearBottom||oldTop===0)box.scrollTop=box.scrollHeight;else box.scrollTop=oldTop;
}
function renderApprovals(items){
 const box=$('approvals');box.replaceChildren();
 for(const item of items){
  const card=el('div','','approval');card.append(el('strong','原生 Codex 请求你的决定'),el('pre',JSON.stringify(item.params,null,2)));
  if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(item.method)){
   for(const [label,decision] of [['允许本次','accept'],['拒绝','decline'],['取消回合','cancel']]){
    const button=el('button',label);button.onclick=()=>act(async()=>{await command('approval.respond',{approval_id:item.approval_id,decision});await poll();});card.append(button);
   }
  }else card.append(el('p','当前版本尚不能回答这种请求；保留原执行，不自动批准。'));
  box.append(card);
 }
}
async function refreshInfo(){info=await get('info');$('projectName').textContent=info.root.split(/[\\/]/).filter(Boolean).at(-1);$('projectName').title=info.root;updateComposer();}
async function poll(){
 if(polling||!info)return;polling=true;const id=selected;
 try{
  const list=await get('threads');threads=list.items;renderThreads();
  if(id){
   let rounds=0,more=true;
   while(more&&rounds++<8){const result=await get('events',{thread_id:id,after:cursors.get(id)||0});history.set(id,mergeEvents(history.get(id)||[],result.items));cursors.set(id,result.next_after);more=result.has_more;}
   if(selected===id){renderConversation();renderApprovals((await get('approvals',{thread_id:id})).items);}
  }
  $('connectionState').textContent='本机已连接 · '+info.version;
 }catch(error){$('connectionState').textContent='连接暂不可用 · 原会话与草稿保留';notice(error.message);}
 finally{polling=false;}
}
async function act(fn){try{await fn();}catch(error){notice(error.message);}}
function detail(title){$('details').hidden=false;$('detailTitle').textContent=title;$('detailContent').replaceChildren();return $('detailContent');}
async function connections(){
 await refreshInfo();const box=detail('连接与兼容性');
 const life=info.lifetime;box.append(el('p',['user-terminal','supervised-terminal'].includes(life?.owner)?'应用由普通启动终端持有；这是启动声明，不是长期稳定性验收。':'当前应用生命期有界或未知；不要把 Runner Job 当作永久服务，超时后先核原 Job。'));
 for(const provider of info.providers){const card=el('div','','provider-card');card.append(el('strong',provider.name),el('p',provider.status),el('p','协议：'+provider.protocol));if(provider.defaults?.model)card.append(el('p','实际配置：'+provider.defaults.model+' / '+provider.defaults.effort));if(provider.id==='pi')card.append(el('p','保留适配边界，尚未接入真实 Pi 模型执行。'));box.append(card);}
 box.append(el('h3','原生 Web 授权诊断'));const result=await get('web');box.append(el('pre',JSON.stringify(result,null,2)));
 box.append(el('p','本地 Codex 使用自己的原生线程、登录及模型。Web 不可用时不会改投 Codex。已绑定 Web 对话的完整聊天与隐藏推理不会被镜像。'));
 box.append(el('p','本版首先接入当前产品工程。同目录下的面板写入回合串行；多工作树及 Web 子分支由后续适配接入，不伪报已完成。'));
}
async function webConnection(){
 const result=await get('web'),box=detail('接入 ChatGPT Web');
 const host=await get('host');
 box.append(el('h3','当前网页对话 · 项目 Host 接入'));
 box.append(el('p','通过已授权 MCP 工作会话接收要求和返回结果，不更换模型、不读取管理员凭据。是否产生新的 Web 回合需真实宿主验证。'));
 for(const b of host.bindings){
  const card=el('div','','provider-card');card.append(el('p',b.enabled?(b.waiter_recent?'本机等待器在线；等待新要求':'已配对；等待器状态需核对'):'已暂停接收'));
  const open=el('button','使用当前 ChatGPT Web 对话');open.dataset.hostThread=b.thread_id;open.disabled=busy||!!pending;
  open.onclick=()=>act(async()=>{await poll();await select(b.thread_id);$('details').hidden=true;});card.append(open);
  const pause=el('button',b.enabled?'暂停接收新要求':'恢复接收新要求');pause.disabled=busy||!!pending;
  pause.onclick=()=>act(async()=>{await command(b.enabled?'host.pause':'host.resume',{},b.thread_id);await poll();await webConnection();});card.append(pause);box.append(card);
 }
 if(!host.bindings.length)box.append(el('p','尚未配对。首次配对由当前已授权 Web 对话执行本机 Host 客户端，不在此输入密钥。'));
 box.append(el('hr'));
 box.append(el('h3','让原生网页对话在这里继续开发'));
 box.append(el('p','使用现有 WebCodex 消息与 Host 载体，不启动 Codex，不改变原网页模型，不读取 Cookie。'));
 const blocked=result.status==='blocked';
 box.append(el('p',blocked?'尚未通过原连接授权：'+(result.code||'未知原因'):'连接状态：'+result.status));
 if(result.http_status)box.append(el('p','原拒绝 HTTP '+result.http_status+'；所缺权限：'+(result.required_scopes||[]).join('、')));
 box.append(el('p','读取需要 communication:read；发送还需要 communication:manage。权限与目标归属均由原生后端核验，此按钮不能授予权限。'));
 if(result.observed_at)box.append(el('p','保留的检查时间：'+result.observed_at));
 const probe=el('button',blocked?'原连接授权已修复，重新检查':'检查原连接与目标');probe.id='webProbe';
 probe.onclick=()=>act(async()=>{if(blocked&&!confirm('仅在已通过原 WebCodex 正式授权修复后继续。没有修改权限则取消，避免重复被拒请求。'))return;await command('web.probe',{authorization_changed:blocked},null);await refreshInfo();await webConnection();});box.append(probe);
 for(const t of result.targets||[]){const b=el('button','绑定 '+t.title);b.dataset.webTarget=t.id;b.disabled=result.status!=='read_authorized'||busy||!!pending;
  b.onclick=()=>act(async()=>{if(!confirm('绑定这个已存在的原生 Web 对话，并允许此面板向它发送你输入的要求？不创建新网页、不变更模型，也不解除旧任务暂停。'))return;const r=await command('web.attach',{target_id:t.id,confirm:true},null);await poll();if(r.thread)await select(r.thread.id);});box.append(b);}
 box.append(el('p','保持原 ChatGPT 对话的 Host 卡片可用。原生网页停止/新建/完整历史分叉未提供通用控制接口，不会以假按钮代替。'));
 box.append(el('p','当前正式连接的授权说明：docs/harness/WEB_CONNECTION.md。不要把密钥复制到本页面、聊天或工程。'));
}
async function recoveryPanel(){
 const row=selectedThread();if(row?.provider!=='chatgpt_web_host')throw Error('先选择已配对的 ChatGPT Web 项目对话');
 const id=row.id,box=detail('Web 自动恢复'),r=await get('recovery',{thread_id:id});
 box.append(el('h3',r.paired?(r.observer_recent?'浏览器观察端已连接':'已配对，等待观察端'):'尚未连接浏览器观察端'));
 const page=r.page_observation,kindLabels={idle:'空闲',generating:'正在生成',draft:'草稿或中文输入中',hidden:'标签页在后台',unsupported:'页面结构尚未识别',cannot_think:'明确生成失败',generation_failed:'明确生成失败',user_stopped:'用户已停止',new_user_input:'用户已追加消息',login_required:'需要登录',rate_limited:'额度或频率限制',safety_denied:'权限或安全拒绝'};
 const diagnostic=el('p',page?'网页观察 v'+page.adapter_version+' · '+(page.recent?'当前':'已过期')+' · '+(kindLabels[page.kind]||'未知状态')+' · 输入控件'+(page.controls_known?'已识别':'未识别'):'观察端尚未报告页面状态；已连接不等于页面适配或自动恢复已验证。');
 diagnostic.id='recoveryPageStatus';box.append(diagnostic);
 box.append(el('p','只有真实故障后的恢复提示被原 Web 任务确认，才计为自动恢复通过；页面诊断不会生成测试错误或发送消息。'));
 const refresh=el('button','刷新连接状态');refresh.id='recoveryRefresh';refresh.onclick=()=>act(recoveryPanel);box.append(refresh);
 box.append(el('p','明确“无法思考／生成失败”后，按 15／45／120 秒退避，向原网页发送简短恢复提示；每个原请求最多三次。不会因长时间思考而打断。'));
 box.append(el('p','保留原 request、claim 与 Job。草稿、用户停止、新消息、登录、额度或权限问题会暂停；发送结果未知不重复点击。'));
 const pair=el('button','生成当前对话配对码');pair.id='recoveryPair';pair.onclick=()=>act(async()=>{
  const result=await command('recovery.pair',{},id);if(!result.pair_code)return;
  const code=el('pre',result.pair_code);code.id='recoveryPairCode';box.append(code,el('p','两分钟内有效。切到对应 ChatGPT 标签页，在 CLW Web Recovery Companion 扩展中输入此码。不要粘贴到聊天。'));
 });box.append(pair);
 const disable=el('button','停用自动恢复');disable.id='recoveryDisable';disable.onclick=()=>act(async()=>{await command('recovery.disable',{},id);await recoveryPanel();});box.append(disable);
 box.append(el('p','首次加载扩展：apps/web-recovery-companion。详细步骤见 docs/harness/WEB_RECOVERY.md。页面结构适配尚需在你的实际 ChatGPT 页面验收；不把测试页面算作在线通过。'));
 for(const a of r.attempts||[])box.append(el('p',a.ordinal+'/3 · '+a.kind+' · '+a.state+' · '+a.request_id));
}
async function teamPanel(){const box=detail('自动协作');await renderTeam({box,get,command,selected:selectedThread(),info,refresh:()=>act(teamPanel)});}
async function controlPanel(){
 const box=detail('网页载体诊断');
 box.append(el('h3','高级诊断'));
 box.append(el('p','正常流程在“自动协作”中添加一次真实对话。Companion 0.4.0 会自动接收原任务并回传该轮公开回复；不需要 target、claim、配对码或手动 adopt。'));
 box.append(el('p','自动范围只限已加入本项目的真实页面；任意 ChatGPT 标签页不会默认接管。允许 Sol + Medium/中等或Extra High/极高；可见 Pro 或其他档位时停止。'));
 const webRows=threads.filter(x=>x.provider==='chatgpt_web_host');
 if(!webRows.length)box.append(el('p','当前没有已登记的 Web 对话。'));
 for(const item of webRows){
  const state=await get('control',{thread_id:item.id});
  const label=state.paired?(state.observer_recent?'已启用 · 页面最近可见':'已启用 · 页面当前未确认'):'未启用';
  box.append(el('p',(item.title||'Web 对话')+' · '+label+(item.active_turn?' · 有当前原请求':'')));
 }
 const row=selectedThread();
 if(row?.provider==='chatgpt_web_host'){
  const id=row.id,r=await get('control',{thread_id:id});
  const advanced=el('details'),summary=el('summary','高级兼容/诊断（只作用于当前选中的 Web 对话）');advanced.append(summary);
  const model=el('input');model.id='controlModelLabel';model.value=r.model_label||'GPT-5.6 Sol';model.setAttribute('aria-label','网页可见模型标签');
  const effort=el('input');effort.id='controlEffortLabel';effort.value=r.effort_label||'Extra High';effort.setAttribute('aria-label','网页可见思考档位标签');
  advanced.append(el('label','精确可见标签（不是计费认证）'),model,effort);
  const pair=el('button','高级：生成手动控制码');pair.id='controlPair';pair.onclick=()=>act(async()=>{
   if(!confirm('仅用于首次安装或诊断。确认页面是显式Sol，档位为Medium/中等或Extra High/极高，且不是Pro？'))return;
   const x=await command('control.pair',{confirm:true,model_label:model.value,effort_label:effort.value},id);
   if(x.pair_code)advanced.append(el('pre',x.pair_code),el('p','仅用于旧兼容诊断；正常0.4.0流程不需要此码。'));
  });advanced.append(pair);
  const adopt=el('button','高级：手动接续当前原请求（不重派）');adopt.id='controlAdopt';adopt.disabled=!row.active_turn;
  adopt.onclick=()=>act(async()=>{if(!confirm('仅用于自动识别不可用时。将当前原请求交给此页载体？未知发送不重试，不新建请求。'))return;await command('control.adopt',{confirm:true,request_id:row.active_turn},id);await controlPanel();});advanced.append(adopt);
  const stop=el('button','停用当前选中对话的网页接管');stop.id='controlDisable';stop.onclick=()=>act(async()=>{await command('control.disable',{confirm:true},id);await controlPanel();});advanced.append(stop);
  for(const recovery of r.recoveries||[])advanced.append(el('p','错误恢复 '+recovery.ordinal+'/3 · '+recovery.request_id));
  for(const a of r.attempts||[])advanced.append(el('p',a.state+' · '+a.request_id+' · epoch '+a.epoch));
  box.append(advanced);
 }
 const refresh=el('button','刷新接管状态');refresh.id='controlRefresh';refresh.onclick=()=>act(controlPanel);box.append(refresh);
 box.append(el('p','dispatching/sent不等于模型已领取；unknown/not_sent永不自动重发。统一伴侣路径：apps/web-recovery-companion。拆分的apps/web-control-companion已弃用，不要安装。'));
}
function clearSubmittedInput(command){
 if(!['message.send','message.steer','message.append'].includes(command.action))return;
 const id=command.thread_id,text=command.data.text,key=draftKey(info.store_id,id);
 try{
  const current=selected===id?$('prompt').value:localStorage.getItem(key);
  if(canClearSubmittedDraft(current,text)){
   if(canClearSubmittedDraft(localStorage.getItem(key),text))localStorage.removeItem(key);
   if(selected===id)$('prompt').value='';
  }
 }catch{notice('已收到原请求回执；草稿存储暂不可用，保留输入。');}
}
$('composer').onsubmit=event=>{event.preventDefault();act(async()=>{
 const id=selected,text=$('prompt').value,row=selectedThread(),action=composerAction(row,pending);
 if(!text.trim()||!action)return;
 const data=action==='message.append'?{text,expected_request_id:row.active_turn}:action==='message.steer'?{text,expected_turn_id:row.active_turn}:{text};
 const result=await command(action,data,id);
 if(['accepted_not_completed','steered_not_completed','message_posted_not_completed','queued_for_web_host','note_saved_not_native_interrupt'].includes(result.state))clearSubmittedInput({action,thread_id:id,data});
 await poll();
});};
$('prompt').addEventListener('compositionstart',()=>{composing=true;});$('prompt').addEventListener('compositionend',()=>{composing=false;});
$('prompt').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!composing){event.preventDefault();if(!$('send').disabled)$('composer').requestSubmit();}});
$('prompt').addEventListener('input',saveDraft);
$('newThread').onclick=()=>act(async()=>{const title=prompt('这次想做什么？','继续开发 CLW');if(!title)return;const r=await command('thread.create',{title},null);await poll();if(r.thread)await select(r.thread.id);await refreshInfo();});
$('forkThread').onclick=()=>act(async()=>{const title=prompt('为这条原生历史分支命名','探索另一种方案');if(!title)return;const r=await command('thread.fork',{title});await poll();if(r.thread)await select(r.thread.id);});
$('connectCodex').onclick=()=>act(async()=>{await command('provider.connect',{},null);await refreshInfo();notice('已连接本地 Codex；没有启动模型回合。');});
$('syncThread').onclick=()=>act(async()=>{const r=await command('thread.sync');await poll();if(r.turns?.length){const box=detail('原生最近公开回复');box.append(el('p','从原生线程读取，不重复运行。'));for(const turn of r.turns)for(const m of turn.messages||[])box.append(el('pre',m.text||''));}});
$('stopTurn').onclick=()=>act(async()=>{await command('turn.stop');await poll();});
$('reconcile').onclick=()=>act(async()=>{
 if(!pending)return;await refreshInfo();if(pending.store_id!==info.store_id)throw Error('当前库不是原请求所属库，禁止跨库重试。');
 const result=await get('receipt',{request_id:pending.command.request_id});
 if(result.state==='completed'||result.state==='rejected'){
  const completed=pending.command;savePending(null);
  if(result.state==='completed')clearSubmittedInput(completed);
  notice(result.state==='completed'?'已找回原请求回执，没有重新执行。':'原请求已拒绝：'+(result.result?.code||''));await poll();
 }else notice('原请求仍为 '+result.state+'，已保留，不重放。');
});
$('showDiff').onclick=()=>act(async()=>{if(!selected)throw Error('先选择一个会话');const box=detail('当前工程变更'),result=await get('diff',{thread_id:selected});box.append(el('p',result.scope),el('pre',result.summary||'无已跟踪文件差异'),el('pre',result.text));if(result.truncated)box.append(el('p','差异显示已截断；不是完整空白或全部文件。'));});
$('showArtifacts').onclick=()=>act(async()=>{
 if(!selected)throw Error('先选择一个会话');const id=selected,box=detail('真实产物与文件');
 const result=await get('artifacts',{thread_id:id});
 box.append(el('p','以下来自原生文件变更记录。点击查看当前字节与 SHA256，不代表已通过品质验收。'));
 if(!result.items.length)box.append(el('p','当前分支还没有原生文件变更记录。'));
 for(const item of result.items){const button=el('button',item.path);button.disabled=!item.previewable;button.style.display='block';button.style.textAlign='left';button.style.overflowWrap='anywhere';button.onclick=()=>act(async()=>{const file=await get('artifact',{thread_id:id,artifact_id:item.id}),holder=detail(file.path);holder.append(el('p',file.bytes+' bytes · SHA256 '+file.sha256),el('pre',file.text));});box.append(button);}
});
$('showBranches').onclick=()=>act(async()=>{
 const row=selectedThread();if(row?.provider!=='chatgpt_web_host')throw Error('先选择 Web 主对话或协作分支');
 const r=await get('branches',{thread_id:row.id}),box=detail('已连接分支与结果');
 box.append(el('p','这里是已独立连接的真实工作会话，不是自动新建 ChatGPT 网页。相同工作目录的写入串行。内部target只用于协议；0.2.0扩展按当前页和人类标题自动识别，正常使用不用抄target。'));
 if(!r.children.length)box.append(el('p','尚无已登记的子对话。接入和委派说明：docs/harness/BRANCHES.md。'));
 for(const child of r.children){const b=el('button',threads.find(t=>t.id===child.thread_id)?.title||'已登记 Web 分支');b.onclick=()=>act(async()=>{await select(child.thread_id);$('details').hidden=true;});box.append(b,el('p',child.enabled?(child.waiter_recent?'当前接收器可见':'已登记，等待接收器'):'已暂停'));}
 const handoffLabels={control_observing:'控制伴侣正在观察；仍需模型实际接管',control_offered:'原接管通知已准备；尚未发送',control_dispatching:'已授予一次发送；等待原接管回执，不可重发',control_sent:'网页发送已观察；还不能当作领取',control_unknown:'发送结果未知；禁止自动重试',control_not_sent:'该次未发送；需明确核对，不自动再试',control_pair_inactive:'控制配对已失效',control_explicit_adoption_required:'旧原请求需要明确接续，不会自动重派',control_observer_missing:'已配对但原页面观察不可见',receiver_unavailable:'已排队，但接收端不可见；登记不等于能自动启动',receiver_polling:'接收端正在观察；尚未领取',handoff_offered_unclaimed:'等待进程已交接，但原请求尚未被领取',claim_confirmed:'原请求领取已确认；不是最终验收',waiting_children:'原请求等待子结果',completed:'子结果已返回；主任务尚需审阅',cancel_requested:'已请求停止；需核对原执行'};
 for(const result of r.results.children){const h=result.handoff;box.append(el('h3',result.phase));if(h){box.append(el('p',handoffLabels[h.state]||h.state));if(h.attention_required)box.append(el('p','需要处理原接收对话/Host：'+result.child_request_id+'。不要重新委派，也不要把等待超时当成模型失败。'));}box.append(el('pre',result.reply_excerpt||'尚无公开回复'));if(result.reply_truncated)box.append(el('p','此处仅为摘要；使用原分支对话或 result 分页读取完整回复后再审阅。'));}
});
$('showRecovery').onclick=()=>act(recoveryPanel);
$('showControl').onclick=()=>act(controlPanel);
$('showTeam').onclick=()=>act(teamPanel);
$('connectWeb').onclick=()=>act(webConnection);
$('showConnection').onclick=()=>act(connections);$('closeDetails').onclick=()=>{$('details').hidden=true;};$('toggleSidebar').onclick=()=>{$('sidebar').classList.toggle('open');};$('threadSearch').oninput=renderThreads;
$('themeToggle').onclick=()=>{document.body.classList.toggle('light');try{localStorage.setItem('clw.harness.theme',document.body.classList.contains('light')?'light':'dark');}catch{}};
window.addEventListener('beforeunload',saveDraft);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});
(async()=>{try{await refreshInfo();$('pendingBox').hidden=!pending;await poll();if(threads.length)await select(threads[0].id);}catch(error){notice(error.message);}})();
setInterval(()=>{if(!document.hidden)void poll();},2000);
