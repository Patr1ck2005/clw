import {safeParseSnapshot,validateAnnotations,emptyAnnotations,setBinding,projectGroup,visibleSessions,completedCalls,classifyCall,routeAdvice,makeTaskPacket,MAX_BYTES} from './model.mjs';
import {createAnnotationStore} from './annotations.mjs';
import {createLiveController,liveSelection} from './live.mjs';
const $=id=>document.getElementById(id);
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
let snapshot=null, annotations=null, selectedProject='', selectedSession='', view='overview', bindingId='', epoch=0, imported=false;
let liveMode=false,liveState=null,liveStateAt=0,catalog=null,requestedDetail='';
function closeEditors(){bindingId='';groupId='';bindingEpoch++;groupEpoch++;annotationImportEpoch++;$('bindingDialog').close();$('groupDialog').close();}
function clearObserved(){
 closeEditors();snapshot=null;store=null;catalog=null;annotations=null;invalidatePacket();dataControls();
 for(const id of ['projectList','sessionList','jobList','eventRows','timelineSession'])$(id).replaceChildren();
 for(const id of ['projectCount','sessionCount','jobCount'])$(id).textContent='—';
 $('selectedProjectTitle').textContent='等待有效观测';$('selectedProjectPath').textContent='';$('timelineSummary').textContent='';
 $('sourceTitle').textContent='尚无当前授权范围内的有效观测';$('sourceDetail').textContent='旧视图已移除；没有恢复或启动任务。';
}
function bindStore(next,retainDetached=false){
 catalog={runtime:next.runtime,projects:next.projects,sessions:next.sessions};
 store=createAnnotationStore({key:key(),snapshot:catalog,retainDetached,storage:{getItem:k=>localStorage.getItem(k),setItem:(k,v)=>localStorage.setItem(k,v)},locks:navigator.locks});loadAnnotations();
}
function installLive(next,envelope){
 if(!liveMode)return;
 if(!next){clearObserved();return;}
 const same=snapshot?.runtime.id===next.runtime.id&&store!==null;
 if(!same){closeEditors();invalidatePacket();snapshot=next;bindStore(next,true);}
 else {
   snapshot=next;
   // Only current observed identities are editable. Stored labels outside this
   // bounded window remain detached instead of disappearing on project changes.
   catalog.projects=next.projects;catalog.sessions=next.sessions;loadAnnotations();
   if(bindingId&&!next.sessions.some(s=>s.id===bindingId)){$('bindingDialog').close();bindingId='';bindingEpoch++;}
   if(groupId&&!next.projects.some(p=>p.id===groupId)){$('groupDialog').close();groupId='';groupEpoch++;}
 }
 if(requestedDetail&&next.sessions.some(s=>s.id===requestedDetail))selectedSession=requestedDetail;
 imported=false;liveState=envelope;liveStateAt=Date.now();render();
}
function liveStatus(value){
 liveState=value;liveStateAt=Date.now();$('liveState').dataset.state=value.state;
 $('pauseLive').disabled=!liveMode||!live.active();$('retryLive').disabled=!liveMode;
 $('sessionLookup').hidden=!liveMode||!selectedProject;
 paintLiveStatus();
}
function paintLiveStatus(){
 if(!liveState)return;
 const age=liveState.age_ms==null?null:Math.floor((liveState.age_ms+Date.now()-liveStateAt)/1000);
 const label={connected:'连接正常 · 有界最新观测',connecting:'正在核对',paused:'已暂停刷新',stale:'观测过期',disconnected:'连接中断',not_configured:'本机尚未配置',auth_required:'授权已失效',access_denied:'访问被拒绝',not_found:'目标不可见',upstream_invalid:'响应合同异常',incompatible_version:'版本未验收'}[liveState.state]||'只读观察暂不可用';
 const overdue=liveState.state==='connected'&&age!==null&&age>15;
 $('liveState').textContent=`${overdue?'观测已过期（等待新响应）':label}。${liveState.message||''}${age===null?'':` 最近成功观测距今 ${age} 秒。`}`;
 if(liveMode&&snapshot){$('sourceTitle').textContent=`正式只读接口 · ${overdue?'过期':label}`;$('sourceDetail').textContent=`${liveState.observed_at||snapshot.source.observed_at} | ${snapshot.source.scope}`;}
 const c=liveState.coverage;
 if(c)$('liveCoverage').textContent=[['项目',c.projects],['Session',c.sessions],['Job',c.jobs]].map(([n,x])=>x?`${n} ${x.returned}/${x.total}${x.truncated?'（上游截断）':''}${x.exact_lookup_extra?' + 确切查询1项':''}`:`${n} 未查询`).join(' · ')+'。此版本无原生列表游标；活动为保留窗口替换，不是全量聊天或累计事件流。';
 else $('liveCoverage').textContent='';
}
const live=createLiveController({onData:installLive,onState:liveStatus,isHidden:()=>document.hidden});
function startLive({reset=false}={}){
 epoch++;liveMode=true;imported=false;
 if(reset){selectedProject='';selectedSession='';requestedDetail='';clearObserved();}
 try{live.start(liveSelection(selectedProject,requestedDetail,$('liveQuery').value.trim()));}
 catch(error){note(error.message);}
}
function chooseProject(id){
 selectedProject=id;selectedSession='';requestedDetail='';
 if(liveMode){closeEditors();startLive();}
 renderProjectView();renderTimeline();
}
function chooseSession(id){
 selectedSession=id;requestedDetail=id;
 if(liveMode){closeEditors();startLive();}
 showView('timeline');
}
const key=()=>`clw.control-center.v1.${snapshot.runtime.id}`;
const note=(text)=>{$('notice').textContent=text;};
const short=(value,n=72)=>value.length>n?value.slice(0,n-1)+'…':value;
const utc=(seconds)=>new Date(seconds*1000).toISOString().slice(11,19);
let store=null, bindingExpected=null, bindingEpoch=0, groupId='', groupExpected=null, groupEpoch=0, annotationImportEpoch=0;
function dataControls(){for(const id of ['clearProject','accountFilter','timelineSession','packetProject','makePacket','exportAnnotations','editGroup'])$(id).disabled=!snapshot||(id==='editGroup'&&!selectedProject);}
function option(value,label){const e=node('option',label);e.value=value;return e;}
function download(name,body,mime='application/json'){
 const blob=new Blob([body],{type:mime}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function bindingFor(id){return annotations.bindings.find(b=>b.session_id===id);}
function loadAnnotations(){
 annotations=emptyAnnotations(snapshot.runtime.id);
 try {annotations=store.read();}
 catch{note('已有标注与当前观测包不匹配或无法读取，原存储未改动；当前使用空标注。');}
}
function projectCards(){
 const query=$('projectSearch').value.toLocaleLowerCase();const grouped=new Map();
 for(const p of snapshot.projects){if(![p.name,p.path].join(' ').toLocaleLowerCase().includes(query))continue;const g=projectGroup(p,annotations);if(!grouped.has(g))grouped.set(g,[]);grouped.get(g).push(p);}
 const holder=$('projectList');holder.replaceChildren();
 for(const [group,projects]of grouped){holder.append(node('div',group,'group-label'));for(const p of projects){
  const button=node('button',null,'project-item'+(selectedProject===p.id?' selected':''));button.dataset.projectId=p.id;button.setAttribute('aria-pressed',String(selectedProject===p.id));
  const n=snapshot.sessions.filter(s=>s.project_id===p.id).length;
  const name=node('b',p.name);name.append(node('em',n?`${n} ${liveMode?'项返回':'项采样'}`:(liveMode?'选择后查询':'会话未采样')));
  button.append(name,node('small',p.path));button.title=p.id;
  button.onclick=()=>chooseProject(p.id);holder.append(button);
 }}
 if(!grouped.size)holder.append(node('div','没有匹配的项目。','empty'));
}
function sessionCards(){
 const rows=visibleSessions(snapshot,annotations,{project:selectedProject,alias:$('accountFilter').value,query:$('sessionSearch').value});
 const holder=$('sessionList');holder.replaceChildren();
 for(const s of rows){const b=bindingFor(s.id),card=node('article',null,'session-card');card.dataset.sessionId=s.id;
  const top=node('div',null,'session-top');top.append(node('span',b?.account_alias||'账号别名未绑定','tag'),node('span',`生命周期：${s.lifecycle} · 非生成状态`,'tag muted'));
  card.append(top,node('h3',s.title),node('div',s.id,'mono'));
  const meta=node('div',null,'session-meta');for(const x of [`角色：${b?.role||'未标注'}`,s.counts_available?`工具调用 ${s.counts.tool_calls}`:'调用计数未提供',s.counts_available?`历史失败 ${s.counts.failed}`:`已观测 ${s.running_jobs??'未知'} 个运行Job${s.running_call?' / 调用进行中':''}`,`自报模型：${b?.model_label||'未核验'}`])meta.append(node('span',x));card.append(meta);
  const actions=node('div',null,'session-actions'),buttons=node('div',null,'header-actions');const label=node('button','标注账号 / 角色','link-button');label.onclick=()=>openBinding(s.id);const logs=node('button','查看调用 →','link-button');logs.onclick=()=>chooseSession(s.id);buttons.append(label,logs);actions.append(node('small',s.counts_available?(s.events_truncated?`仅显示 ${s.events.length}/${s.events_total} 条事件；不是全量历史`:`采样事件 ${s.events.length} 条`):(s.activities_loaded?`活动窗口 ${s.activities.length}/${s.activity_total}${s.activity_truncated?'（截断）':''}`:'详情按需读取 · 非网页生成状态')),buttons);card.append(actions);holder.append(card);
 }
 if(!rows.length)holder.append(node('div','本视图没有已导入的会话。\n项目已登记不代表聊天历史已采集；不会猜测或创建会话。','empty'));
 const jobs=snapshot.jobs.filter(j=>!selectedProject||j.project_id===selectedProject);$('jobList').replaceChildren();
 for(const j of jobs){const row=node('div',null,'job-row');row.append(node('span',j.id+(j.owner_session_id?`\n所属 ${j.owner_session_id}${j.session_id?'':'（未在当前窗口加载）'}`:''),'mono'),node('span',j.status,'tag'),node('span',j.exit_code==null?'退出码未定':`exit ${j.exit_code}`));$('jobList').append(row);}
 if(!jobs.length)$('jobList').append(node('small','当前观测包在已声明的Job采样范围内没有返回记录；不推断其他项目或历史任务为空。'));
}
function renderProjectView(){
 if(!snapshot)return;dataControls();
 const p=snapshot.projects.find(p=>p.id===selectedProject);$('selectedProjectTitle').textContent=p?.name||'所有已采样工作会话';$('selectedProjectPath').textContent=p?.path||'明确的 Session 绑定，比网页窗口标题更可靠。';
 projectCards();sessionCards();
}
function renderTimeline(){
 if(!snapshot)return;
 const choices=snapshot.sessions.filter(s=>!liveMode||s.project_id===selectedProject);
 const select=$('timelineSession');select.replaceChildren(...choices.map(s=>option(s.id,short(s.title,85))));
 if(!choices.some(s=>s.id===selectedSession))selectedSession=liveMode?'':(choices[0]?.id||'');
 if(liveMode&&!selectedSession)select.prepend(option('','选择Session以读取详情'));
 select.value=selectedSession;const s=choices.find(s=>s.id===selectedSession);$('eventRows').replaceChildren();
 if(!s){$('timelineSummary').textContent='没有已导入的会话。';return;}
 if(!s.counts_available){renderActivities(s);return;}
 const rows=completedCalls(s.events);
 $('timelineSummary').textContent=`后端摘要：${s.counts.tool_calls} 次调用 / ${s.counts.succeeded} 成功 / ${s.counts.failed} 失败。仅导入 ${s.events.length}/${s.events_total} 条事件，当前视图 ${rows.length} 个已结束逻辑调用。这不是完整错误率或全账户统计。`;
 for(const e of rows){const tr=document.createElement('tr'),time=node('td',utc(e.timestamp));time.title=new Date(e.timestamp*1000).toISOString();const tool=node('td',e.tool);tool.append(node('small',e.logical_id||e.id));const result=node('td'),status=classifyCall(e);result.append(node('span',status.label,'tag '+status.tone));const duration=node('td',e.duration_ms==null?'未提供':`${e.duration_ms} ms`);const origin=node('td',e.job_id||'无关联Job');origin.append(node('small',`${e.role} · ${e.error_class||'未报告错误类型'} · exit ${e.exit_code??'未知'}`));tr.append(time,tool,result,duration,origin);$('eventRows').append(tr);}
 if(!rows.length){const tr=node('tr'),td=node('td','已导入片段中没有结束记录，不能推断成功。');td.colSpan=5;tr.append(td);$('eventRows').append(tr);}
}
function renderActivities(s){
 $('timelineSummary').textContent=s.activities_loaded?`当前Session活动 ${s.activities.length}/${s.activity_total}${s.activity_truncated?'（历史被截断）':''}。上游保留投影，仅替换最新窗口；可能包含重复观测，没有公开原始event ID，不把投影项数当调用次数。`:'详情尚未读取。选择具体会话或点击“查看调用”获取上游保留窗口。';
 for(const a of s.activities){
  const tr=node('tr'),time=node('td',utc(a.started_at));time.title=new Date(a.started_at*1000).toISOString();
  const tool=node('td',a.tool||a.kind);if(a.summary)tool.append(node('p',a.summary,'activity-summary'));if(a.paths.length)tool.append(node('small',a.paths.join('\n')));
  let label=a.state||'unknown',tone='muted';
  if(a.job_handoff&&!['completed','failed','cancelled'].includes(a.execution_state)){label='已接受 · 非完成';tone='warn';}
  else if(a.exit_code!=null&&a.exit_code!==0){label='程序失败';tone='bad';}
  else if(['succeeded','completed'].includes(a.state)){label='已完成';tone='ok';}
  else if(['failed','timed_out'].includes(a.state)){tone='bad';}
  const state=node('td');state.append(node('span',label,'tag '+tone));
  const job=node('td',a.job_id||'无关联Job');
  const observedJob=snapshot.jobs.find(j=>j.id===a.job_id&&j.project_id===s.project_id&&j.owner_session_id===s.id);
  if(observedJob)job.append(node('small',`最新 Job：${observedJob.status} / exit ${observedJob.exit_code??'未定'}`));job.append(node('small',`上游${a.kind}投影${a.group_count?` · 合并 ${a.group_count} 项`:''} · exit ${a.exit_code??'未提供'}`));
  tr.append(time,tool,state,node('td',a.duration_ms==null?'未提供':`${a.duration_ms} ms`),job);$('eventRows').append(tr);
 }
 if(!s.activities.length){const tr=node('tr'),td=node('td',s.activities_loaded?'保留窗口内没有活动。':'等待详情；不会使用别的Session历史填充。');td.colSpan=5;tr.append(td);$('eventRows').append(tr);}
}
function renderAdvice(){const a=routeAdvice($('taskKind').value);$('routeAdvice').replaceChildren(node('b',a.target),node('p',a.reason));invalidatePacket();}
function invalidatePacket(){$('packetPreview').value='';$('exportPacket').disabled=true;}
function showView(next){view=next;for(const v of document.querySelectorAll('.view'))v.hidden=v.id!==next;for(const b of document.querySelectorAll('.nav')){b.classList.toggle('active',b.dataset.view===next);b.setAttribute('aria-current',b.dataset.view===next?'page':'false');}
 $('viewTitle').textContent={overview:'让每一项工作，都有明确归属。',timeline:'每一次调用，都能回到它的上下文。',routing:'Web 做主力，Codex 用在关键处。',help:'已知、未知与尚未接入，分开说明。'}[next];
 if(snapshot&&next==='timeline')renderTimeline();
}
function render(){
 $('runtimeVersion').textContent=`WebCodex ${snapshot.runtime.version} · ${snapshot.runtime.runner_id}`;
 $('sourceTitle').textContent=(snapshot.source.kind==='demo'?'演示数据':'工具观测快照')+' · 非实时'+(imported?' · 用户导入、来源未独立验证':' · 随本次版本保存');
 $('sourceDetail').textContent=`${snapshot.source.observed_at} | ${snapshot.source.scope}`;
 $('projectCount').textContent=String(snapshot.projects.length);$('sessionCount').textContent=String(snapshot.sessions.length);$('jobCount').textContent=String(snapshot.jobs.length);
 const filter=$('accountFilter').value,aliases=[...new Set(annotations.bindings.map(b=>b.account_alias).filter(Boolean))];$('accountFilter').replaceChildren(option('','全部 / 含未绑定'),option('__unbound__','仅未绑定'),...aliases.map(a=>option(a,a)));$('accountFilter').value=aliases.includes(filter)||filter==='__unbound__'?filter:'';
 const pp=$('packetProject').value;$('packetProject').replaceChildren(...snapshot.projects.map(p=>option(p.id,p.name)));if(snapshot.projects.some(p=>p.id===pp))$('packetProject').value=pp;else if(pp)invalidatePacket();
 if(selectedProject&&!snapshot.projects.some(p=>p.id===selectedProject))selectedProject='';
 $('projectMetricLabel').textContent=liveMode?'返回的项目':'已导入项目';$('sessionMetricLabel').textContent=liveMode?'当前Project Session':'已采样 Session';$('jobMetricLabel').textContent=liveMode?'当前Project Job':'快照内 Job';$('jobsHeading').textContent=liveMode?'当前项目 Job（有界元数据）':'Job 样本';
 $('sessionLookup').hidden=!liveMode||!selectedProject;
 renderProjectView();renderTimeline();showView(view);if(liveMode)paintLiveStatus();
}
function install(next,isImport){live.stop();liveMode=false;requestedDetail='';snapshot=next;imported=isImport;closeEditors();invalidatePacket();bindStore(next);dataControls();render();$('pauseLive').disabled=true;$('retryLive').disabled=true;$('sessionLookup').hidden=true;}
async function boundedFile(file){if(!file||file.size>MAX_BYTES)throw Error('文件缺失或超过2 MiB');return await file.text();}
async function reload(){const ticket=++epoch;note('正在读取随版本保存的本地观测包；不连接账号或控制后端。');try{const res=await fetch('./data/observed.json',{cache:'no-store',credentials:'omit'});if(!res.ok)throw Error(`读取失败 ${res.status}`);const text=await res.text();const next=safeParseSnapshot(text);if(ticket!==epoch)return;note('');install(next,false);}catch(e){if(ticket===epoch)note(`未替换现有数据：${e.message}`);}}
function openBinding(id){const b=bindingFor(id);bindingExpected=b??null;bindingEpoch++;bindingId=id;$('bindingError').textContent='';$('bindingSession').textContent=id;$('aliasInput').value=b?.account_alias||'';$('roleInput').value=b?.role||'';$('modelInput').value=b?.model_label||'';$('bindingDialog').showModal();}
for(const b of document.querySelectorAll('.nav'))b.onclick=()=>showView(b.dataset.view);
$('projectSearch').oninput=()=>snapshot&&projectCards();$('accountFilter').onchange=()=>snapshot&&sessionCards();$('sessionSearch').oninput=()=>snapshot&&sessionCards();$('clearProject').onclick=()=>chooseProject('');
$('timelineSession').onchange=e=>chooseSession(e.target.value);$('taskKind').onchange=renderAdvice;$('reload').onclick=reload;
$('closeBinding').onclick=()=>{$('bindingDialog').close();bindingId='';bindingEpoch++;};
$('bindingDialog').addEventListener('cancel',()=>{bindingId='';bindingEpoch++;});
$('bindingForm').onsubmit=async e=>{
 e.preventDefault();if(!snapshot||!bindingId)return;
 const ticket=bindingEpoch,current=store,value={session_id:bindingId,account_alias:$('aliasInput').value.trim(),role:$('roleInput').value.trim(),model_label:$('modelInput').value.trim(),updated_at:new Date().toISOString()};
 const valid=()=>current===store&&ticket===bindingEpoch&&!!bindingId;
 const button=$('bindingForm').querySelector('[type=submit]');button.disabled=true;
 try{const next=await current.saveBinding(value,bindingExpected,valid);if(!valid())return;annotations=next;$('bindingDialog').close();bindingId='';render();note('本地标注已保存；没有修改账号身份、网页模型或后端权限。');}
 catch(err){if(valid()){note(err.message);$('bindingError').textContent=err.message;}}
 finally{button.disabled=false;}
};
$('editGroup').onclick=()=>{if(!snapshot||!selectedProject)return;groupId=selectedProject;groupExpected=annotations.groups.find(g=>g.project_id===groupId)??null;groupEpoch++;$('groupProject').textContent=snapshot.projects.find(p=>p.id===groupId).name;$('groupInput').value=groupExpected?.name??'';$('groupError').textContent='';$('groupDialog').showModal();};
$('closeGroup').onclick=()=>{$('groupDialog').close();groupId='';groupEpoch++;};
$('groupDialog').addEventListener('cancel',()=>{groupId='';groupEpoch++;});
$('groupForm').onsubmit=async e=>{
 e.preventDefault();if(!snapshot||!groupId)return;const ticket=groupEpoch,current=store,value={project_id:groupId,name:$('groupInput').value};const valid=()=>current===store&&ticket===groupEpoch&&!!groupId;const button=$('groupForm').querySelector('[type=submit]');button.disabled=true;
 try{const next=await current.saveGroup(value,groupExpected,valid);if(!valid())return;annotations=next;$('groupDialog').close();groupId='';render();note('本地分组已保存；项目目录、登记和权限未改变。');}
 catch(err){if(valid())$('groupError').textContent=err.message;}
 finally{button.disabled=false;}
};
$('importSnapshot').onchange=async e=>{const file=e.target.files?.[0],ticket=++epoch;e.target.value='';try{const next=safeParseSnapshot(await boundedFile(file));if(ticket!==epoch)return;note('');install(next,true);}catch(err){if(ticket===epoch)note(`导入拒绝，原视图保留：${err.message}`);}};
$('exportAnnotations').onclick=()=>snapshot&&download('clw-local-labels.json',JSON.stringify(annotations,null,2));
$('importAnnotations').onchange=async e=>{const file=e.target.files?.[0],ticket=++annotationImportEpoch,current=store;e.target.value='';const valid=()=>current===store&&ticket===annotationImportEpoch;try{if(!current)throw Error('请先加载有效观测包');const before=current.raw();const text=await boundedFile(file);if(!valid())return;const next=validateAnnotations(JSON.parse(text),catalog);const saved=await current.replace(next,before,valid);if(!valid())return;annotations=saved;render();note('已替换本地标注；没有验证或改变真实账号。');}catch(err){if(valid())note(`标注导入拒绝：${err.message}`);}};
for(const id of ['goal','acceptance','packetProject'])$(id).addEventListener('input',invalidatePacket);
$('makePacket').onclick=()=>{try{const content=makeTaskPacket({project:snapshot?.projects.find(p=>p.id===$('packetProject').value),goal:$('goal').value,acceptance:$('acceptance').value,kind:$('taskKind').value});$('packetPreview').value=content;$('exportPacket').disabled=false;note('任务包已生成，仅供你审阅使用；没有派发命令、启动Codex或调用图像API。');}catch(err){note(err.message);}};
$('exportPacket').onclick=()=>{if($('packetPreview').value)download('clw-task.md',$('packetPreview').value,'text/markdown;charset=utf-8');};
window.addEventListener('storage',event=>{if(snapshot&&event.key===key()){loadAnnotations();render();note('已同步同源浏览器的本地标注；后端状态没有变化。');}});
$('connectLive').onclick=()=>startLive({reset:!liveMode});
$('pauseLive').onclick=()=>live.stop();
$('retryLive').onclick=()=>startLive();
$('searchLive').onclick=()=>startLive({reset:true});
$('lookupSessionButton').onclick=()=>{try{const id=$('lookupSession').value.trim();liveSelection(selectedProject,id,$('liveQuery').value.trim());if(!id)throw Error('请填入确切Session ID');chooseSession(id);}catch(error){note(error.message);}};
$('liveQuery').addEventListener('keydown',event=>{if(event.key==='Enter')startLive({reset:true});});
$('lookupSession').addEventListener('keydown',event=>{if(event.key==='Enter')$('lookupSessionButton').click();});
document.addEventListener('visibilitychange',()=>live.visibility());
window.addEventListener('pagehide',()=>live.stop());
setInterval(()=>{if(liveMode&&!document.hidden)paintLiveStatus();},1000);
dataControls();renderAdvice();
void reload().then(()=>{if(new URLSearchParams(location.search).get('live')==='1')startLive({reset:true});});
