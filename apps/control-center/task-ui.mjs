import {createTaskClient} from './task-client.mjs';
import {createResourceUI} from './task-resources.mjs';
import {createGoalUI} from './task-goals.mjs';
import {createRoutingUI} from './task-routing.mjs';
const $=id=>document.getElementById(id);
const el=(tag,text='',cls='')=>{const x=document.createElement(tag);x.textContent=text;if(cls)x.className=cls;return x;};
const lines=value=>value.split('\n').map(x=>x.trim()).filter(Boolean);
const phaseNames={draft:'草稿',ready:'已发布 · 待开工',working:'工作中（登记状态）',review:'有交接待审阅',awaiting_acceptance:'全部角色通过 · 待父验收',paused:'协调已暂停',accepted:'父任务已验收',cancelled:'已取消'};
const roleNames={pending:'待开工',running:'已登记工作中',blocked:'阻塞 · 保留写域',submitted:'交接待审阅',accepted:'审阅通过'};
let current=null,listAfter=0,nextAfter=null,epoch=0,editorTarget=null,actionSpec=null,projects=[],eventsAfter=0,listEpoch=0,eventEpoch=0;
const notice=text=>{$('taskNotice').textContent=text;};
const actor=()=>{$('taskActor').value=$('taskActor').value.trim();if(!$('taskActor').value)throw Error('先填写左侧本机操作者别名');return $('taskActor').value;};
function option(value,label){const o=el('option',label);o.value=value;return o;}
function button(label,fn,cls='button secondary'){const b=el('button',label,cls);b.type='button';b.onclick=fn;return b;}
function field(parent,name,label,{value='',type='textarea',required=true,options=[],max=16000}={}){
  const wrapper=el('label',label,'field');const input=el(type==='select'?'select':type==='textarea'?'textarea':'input');input.name=name;input.required=required;
  if(type==='select')input.append(...options.map(([v,l])=>option(v,l)));else {input.maxLength=max;if(type==='textarea')input.rows=3;else input.type=type;}
  input.value=type==='select'&&!options.some(([v])=>v===value)?(options[0]?.[0]??''):value;
  wrapper.append(input);parent.append(wrapper);return input;
}
function download(file){const url=URL.createObjectURL(new Blob([file.content],{type:file.media_type+';charset=utf-8'}));const a=el('a');a.href=url;a.download=file.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function pendingChanged(value){$('pendingRequest').hidden=!value;$('pendingId').textContent=value?value.command.request_id+' · '+value.command.action:'';}
const client=createTaskClient({onPending:pendingChanged});
const resourceUI=createResourceUI({client,getTask:()=>current,perform:(...args)=>perform(...args),onError:notice});
const goalUI=createGoalUI({client,getTask:()=>current,perform:(...args)=>perform(...args),onError:notice});
const routingUI=createRoutingUI({client,getTask:()=>current,perform:(...args)=>perform(...args),onError:notice});
let inboxAfter=0,inboxNext=null,inboxEpoch=0;
async function loadInbox(reset=true){
  const ticket=++inboxEpoch;if(reset)inboxAfter=0;
  try{const data=await client.read('inbox',{after:inboxAfter,limit:20});if(ticket!==inboxEpoch)return;
    const holder=$('inboxRows');holder.replaceChildren();inboxNext=data.next_after;$('moreInbox').hidden=inboxNext==null;
    for(const row of data.items){const box=el('article','','task-event');box.append(button(row.title,()=>select(row.task_id),'link-button'));
      for(const item of row.items)box.append(el('p',`${item.role_id||'主控'} · ${{delivery:'交付待审',blocked:'原工作受阻',shared_change:'共同变更待修订',parent_acceptance:'父任务待验收',goal_decision:'工作轮次待主控决策',goal_budget:'持续目标达到授权上限',routing_unknown:'原通知结果待核对'}[item.kind]||item.kind} · ${item.summary}`));holder.append(box);}
    $('inboxNotice').textContent=data.items.length?'直接来自当前任务记录；收件不代表审阅通过或模型已唤醒。':'当前页没有待处理交付；未提交的工作不会被当作完成。';
  }catch(e){if(ticket===inboxEpoch)$('inboxNotice').textContent='收件观察暂不可用，保留已有内容。'+e.message;}
}
async function exportAssignment(rid){
  try{const value=await client.read('assignment',{id:current.id,role:rid});const packet=value.assignment;
    download({filename:`${packet.task_id}-${rid}-attempt-${packet.attempt}.json`,media_type:'application/json',content:JSON.stringify(packet,null,2)});
    notice('职责包含完整合同、当前意见与版本栅栏；导出不会启动模型。工作者按交付CLI直接提交，主控无需搬运聊天。');
  }catch(e){notice(e.message);}
}
async function catalog(){
  try{
    const r=await fetch('./api/live/state',{cache:'no-store',credentials:'omit'});if(!r.ok)throw Error();const body=await r.json();
    projects=body.state==='connected'?(body.projection?.projects??[]):[];
  }catch{projects=[];}
}
async function list(reset=true){
  const ticket=++listEpoch;
  if(reset)listAfter=0;
  const result=await client.read('list',{query:$('taskSearch').value,status:$('taskFilter').value,after:listAfter});
  if(ticket!==listEpoch)return;
  nextAfter=result.next_after;$('moreTasks').hidden=nextAfter==null;
  $('taskList').replaceChildren();
  for(const t of result.tasks){
    const b=button('',()=>select(t.id),'task-list-item'+(current?.id===t.id?' selected':''));b.dataset.taskId=t.id;
    b.append(el('b',t.title),el('small',`${phaseNames[t.phase]||t.phase} · v${t.contract_version}`),el('small',`角色审阅 ${t.progress.accepted}/${t.progress.total}`));$('taskList').append(b);
  }
  if(!result.tasks.length)$('taskList').append(el('div','本页没有任务。','empty'));
}
async function select(id){
  const ticket=++epoch;try{const data=await client.read('get',{id});if(ticket!==epoch)return;current=data.task;renderTask();await list(false);}catch(e){notice(e.message);}
}
async function refreshCurrent(){if(current)await select(current.id);else await list();}
async function perform(action,data,task=current){
  const target=task?.id,ticket=epoch;
  const result=await client.command(action,task,actor(),data);
  if(ticket===epoch&&(current?.id===target||!task)){current=result.task;renderTask();}
  await list(false);await loadInbox();notice('已保存本机任务记录；没有派发模型、执行命令或改变项目权限。');return result;
}
function renderTask(){
  const t=current,c=t.contract,holder=$('taskDetail');holder.replaceChildren();
  const heading=el('div','','task-heading');heading.append(el('h2',c.title),el('span',phaseNames[t.phase]||t.phase,'tag task-state'));holder.append(heading);
  holder.append(el('p',`${t.id} · 合同 v${t.contract_version} · 数据版本 ${t.version}`,'mono task-id'));
  const stats=el('div','','task-stats');stats.append(el('span',`角色通过 ${t.progress.accepted}/${t.progress.total}`),el('span',`协调者 ${c.coordinator||'未标注'} / ${c.mode}`));holder.append(stats);
  const toolbar=el('div','','task-toolbar');
  if(!t.collaboration?.enabled&&['draft','open'].includes(t.status)&&Object.values(t.roles).every(s=>s.status==='pending'))toolbar.append(button('启用结构化协作',()=>openAction('collaborate'),'button'));
  if(!t.goal?.enabled&&!Object.values(t.roles).some(s=>['running','blocked'].includes(s.status)))toolbar.append(button(t.status==='draft'?'编辑草稿':'修订合同（新版本）',()=>openEditor(t)));
  if(t.status==='draft')toolbar.append(button('发布合同',()=>openAction('publish'),'button'));
  if(t.status==='open')toolbar.append(button('暂停协调',()=>openAction('pause')));
  if(t.status==='paused'&&!t.collaboration?.shared_change_pending)toolbar.append(button('恢复协调',()=>openAction('resume')));
  if(!['accepted','cancelled'].includes(t.status))toolbar.append(button('取消任务记录',()=>openAction('cancel')));
  if(t.phase==='awaiting_acceptance')toolbar.append(button('逐条验收父任务',()=>openAction('accept'),'button'));
  toolbar.append(button('导出完整任务包',()=>exportTask('markdown')),button('导出 JSON',()=>exportTask('json')));holder.append(toolbar);
  holder.append(el('div',c.goal,'task-goal'));
  goalUI.render(holder,t);
  routingUI.render(holder,t);
  if(t.collaboration?.enabled)holder.append(el('p','结构化协作已启用：角色独立版本交付，主控统一收件；来源账号仍是声明，不自动认证。','task-warning'));
  if(t.collaboration?.shared_change_pending)holder.append(el('p','存在共同变更：先核对所有角色停写，再修订合同。不能直接恢复以跳过新要求。','task-warning'));
  const facts=el('div','','task-facts');for(const [label,text]of [['不可变条件',c.constraints||'未另列'],['输入基线',c.baseline||'尚未填写，需执行者核对'],['来源与版本',c.sources||'未另列'],['合同 SHA256',t.contract_hash]]){const block=el('div');block.append(el('h3',label),el('p',text));facts.append(block);}holder.append(facts);
  holder.append(el('h3','父任务验收条件'));const checks=el('ol','','task-checks');for(const x of c.acceptance)checks.append(el('li',x));holder.append(checks);
  if(t.status==='paused')holder.append(el('div','这里只暂停协调；原模型或Job不会自动停止，未释放角色仍占用协调写域。','task-warning'));
  if(t.origin)holder.append(el('div','此任务从外部JSON导入为新草稿。外部的通过状态、账号和开工记录未继承。','task-warning'));
  holder.append(el('h3','角色、工作目录与交接'));
  for(const r of c.roles)renderRole(holder,r,t.roles[r.id]);
  if(t.acceptance_review){const panel=el('div','','task-role');panel.append(el('h3','父任务验收记录'),el('p',`${t.acceptance_review.actor} · ${t.acceptance_review.at}`),el('p',t.acceptance_review.note),el('small','来源：操作者审阅；系统没有代替你验证代码或运行测试。'));for(const check of t.acceptance_review.checks)panel.append(el('p',`${check.index+1}. ${check.evidence}`));holder.append(panel);}
  const history=el('section');history.append(el('h3','本机任务事件（可恢复）'));const entries=el('div');entries.id='taskEvents';history.append(entries);
  const more=button('读取下一页事件',()=>loadEvents(false),'link-button');more.id='moreEvents';history.append(more);holder.append(history);void loadEvents(true);
}
function renderRole(holder,r,s){
  const card=el('article','','task-role');card.dataset.roleId=r.id;const head=el('header');head.append(el('h3',`${r.id} · ${r.name}`),el('span',roleNames[s.status],'tag'));card.append(head,el('p',r.objective),el('p',`${r.executor} / ${r.access} · 依赖 ${r.depends_on.join(', ')||'无'} · 第 ${s.attempt} 次登记`),el('p',r.project_id+'\n'+r.worktree+'\n范围：'+(r.scopes.join(' / ')||'只读'),'mono'));
  card.append(el('p',s.binding?`已观测绑定：${s.binding.session_id}\n${s.binding.observed_at}（不等于网页仍在线）`:'未绑定已观测Session；外部引用与身份不自动核验。','mono'));
  if(s.external_ref)card.append(el('p','操作者声明的外部引用：'+s.external_ref));
  if(s.operator)card.append(el('p','开工登记者：'+s.operator));
  const actions=el('div','','role-actions');
  if(['open','paused'].includes(current.status)){
    if(s.status==='pending'){
      if(r.executor==='web')actions.append(button('核对 / 绑定 Session',()=>openAction('bind',r.id)));
      if(current.status==='open')actions.append(button('登记开工',()=>openAction('claim',r.id)));
    }
    if(['running','blocked'].includes(s.status)){
      actions.append(button('保存恢复点',()=>openAction('checkpoint',r.id)),current.collaboration?.enabled?button('导出当前职责包',()=>exportAssignment(r.id),'button'):button('提交交接',()=>openAction('submit',r.id),'button'),button(s.status==='blocked'?'解除阻塞':'记录阻塞',()=>openAction(s.status==='blocked'?'unblock':'block',r.id)),button('释放写入责任',()=>openAction('release',r.id)));
    }
    if(s.status==='submitted'&&current.status==='open')actions.append(button(current.collaboration?.enabled?'审阅结构化交付':'审阅交接',()=>openAction(current.collaboration?.enabled?'review_delivery':'review',r.id),'button'));
    if(current.collaboration?.enabled)actions.append(button('登记中途意见',()=>openAction('feedback',r.id)));
  }
  actions.append(button('导出角色启动包',()=>exportTask('markdown',r.id),'link-button'));card.append(actions);
  if(s.feedback?.length){const feedback=el('details');feedback.append(el('summary',`中途意见 · 本角色版本 ${s.feedback_revision||0}`));for(const f of s.feedback)feedback.append(el('p',`${f.scope==='shared'?'共同':'局部'} · ${f.actor} · ${f.note}`));card.append(feedback);}
  if(s.delivery){const d=el('details');d.append(el('summary','结构化交付与文件哈希（待独立核验）'),el('pre',JSON.stringify(s.delivery,null,2)));card.append(d);}
  for(const [label,value]of [['最近恢复点',s.checkpoint],['交接（执行者声明，待核验）',s.handoff],['审阅记录',s.review]])if(value){const detail=el('details');detail.append(el('summary',label),el('pre',JSON.stringify(value,null,2)));card.append(detail);}
  if(current.collaboration?.enabled)resourceUI.renderRole(card,r,s);
  holder.append(card);
}
async function loadEvents(reset){
  if(!current)return;const id=current.id;if(reset)eventsAfter=0;const ticket=++eventEpoch;
  try{const data=await client.read('events',{id,after:eventsAfter,limit:30});if(current?.id!==id||ticket!==eventEpoch)return;const holder=$('taskEvents');if(reset)holder.replaceChildren();
    for(const e of data.events){const row=el('div','','task-event');row.append(el('span',`#${e.sequence} · ${e.action} · ${e.actor} · ${e.at}`));const detail=el('details');detail.append(el('summary','记录内容'),el('pre',JSON.stringify(e.payload,null,2)));row.append(detail);holder.append(row);}eventsAfter=data.next_after;$('moreEvents').hidden=eventsAfter==null;
  }catch(e){notice(e.message);}
}
async function exportTask(format,role=''){try{download(await client.read('export',{id:current.id,role,format}));}catch(e){notice(e.message);}}
function roleEditor(r={}){
  const box=el('section','','role-editor'),top=el('div','','panel-heading');top.append(el('h3','角色与边界'),button('移除此角色',()=>box.remove(),'link-button'));box.append(top);
  const row=el('div','','editor-row');field(row,'id','角色 ID',{type:'text',value:r.id||`R${$('editRoles').children.length+1}`,max:48});field(row,'name','角色名称',{type:'text',value:r.name||'开发角色',max:100});box.append(row);
  field(box,'objective','本角色完整目标',{value:r.objective||'',max:8000});
  const mode=el('div','','editor-row');field(mode,'executor','执行者',{type:'select',value:r.executor||'web',options:[['web','Web（开工前核对Session）'],['codex','Codex（当前为外部人工交接）'],['manual','人工 / 程序（声明引用）']]});field(mode,'access','读写类型',{type:'select',value:r.access||'write',options:[['write','写入'],['read','只读审查']]});box.append(mode);
  const p=projects.find(p=>p.id===r.project_id)||projects.find(p=>p.name==='clw-webcodex')||projects[0];
  const ps=field(box,'project_id','实际 Project',{type:'select',value:r.project_id||p?.id||'',options:[['','请选择项目'],...projects.map(p=>[p.id,p.name])]});
  if(r.project_id&&!projects.some(p=>p.id===r.project_id)){ps.append(option(r.project_id,r.project_id+'（未重新观测）'));ps.value=r.project_id;}
  const root=field(box,'project_root','Project根（关联时核对）',{type:'text',value:r.project_root||p?.path||'',max:2048});
  const work=field(box,'worktree','实际工作目录',{type:'text',value:r.worktree||p?.path||'',max:2048});
  ps.onchange=()=>{const chosen=projects.find(p=>p.id===ps.value);if(chosen){root.value=chosen.path;work.value=chosen.path;}};
  field(box,'scopes','相对写域前缀，每行一项；只读可留空',{value:(r.scopes||[]).join('\n'),required:false,max:32000});field(box,'depends_on','依赖角色ID，逗号分隔',{type:'text',value:(r.depends_on||[]).join(', '),required:false,max:1000});
  $('editRoles').append(box);
}
async function openEditor(task=null){
  try{actor();await catalog();editorTarget=task;$('editorHeading').textContent=task?(task.status==='draft'?'编辑草稿':'修订合同 · 保留历史'):'新建完整任务';const c=task?.contract;
    for(const [id,k]of [['editTitle','title'],['editGoal','goal'],['editConstraints','constraints'],['editBaseline','baseline'],['editSources','sources'],['editCoordinator','coordinator']])$(id).value=c?.[k]||'';
    $('editMode').value=c?.mode||'pure_web';$('editAcceptance').value=c?.acceptance.join('\n')||'';$('revisionReason').value='';$('revisionReasonField').hidden=!task||task.status==='draft';$('revisionReason').required=!!task&&task.status!=='draft';$('editorError').textContent='';$('editRoles').replaceChildren();for(const r of c?.roles||[{}])roleEditor(r);$('taskEditor').showModal();
  }catch(e){notice(e.message);}
}
function editorContract(){
  const c={};for(const [id,k]of [['editTitle','title'],['editGoal','goal'],['editConstraints','constraints'],['editBaseline','baseline'],['editSources','sources'],['editCoordinator','coordinator'],['editMode','mode']])c[k]=$(id).value;
  c.acceptance=lines($('editAcceptance').value);c.roles=[...$('editRoles').children].map(box=>{const values=Object.fromEntries([...box.querySelectorAll('[name]')].map(x=>[x.name,x.value]));values.scopes=lines(values.scopes);values.depends_on=values.depends_on.split(/[,，\s]+/u).filter(Boolean);return values;});return c;
}
async function openAction(action,rid=''){
  try{actor();}catch(e){notice(e.message);return;}
  const task=current,role=task.contract.roles.find(r=>r.id===rid),state=task.roles[rid];actionSpec={action,rid,task,connection:null};$('actionFields').replaceChildren();$('actionError').textContent='';$('rebaseTaskAction').hidden=true;$('rebaseTaskAction').disabled=false;$('saveTaskAction').disabled=false;
  const title={collaborate:'启用结构化协作',feedback:'登记中途意见',review_delivery:'审阅结构化交付',publish:'发布完整合同',pause:'暂停任务协调',resume:'恢复任务协调',cancel:'取消任务记录',bind:'核对实际 Session 并绑定',claim:'登记角色开工',checkpoint:'保存恢复点（不结束任务）',block:'记录阻塞（不释放写域）',unblock:'解除阻塞',release:'释放本角色的写入责任',submit:'提交完整交接',review:'审阅交接',accept:'逐条验收父任务'}[action];$('actionHeading').textContent=title;
  const holder=$('actionFields');holder.append(el('p',`任务 v${task.contract_version} / 数据版本 ${task.version}。只记录本机协调状态，不会开始或停止模型、Job。`));
  if(['pause','resume','cancel','block','unblock','release'].includes(action))field(holder,'reason','原因 / 下一步');
  if(action==='collaborate'){
    holder.append(el('p','仅对尚未开工的本任务启用。任务库能力标记将提升到2，旧G0不能再打开该任务库或直接回退；所有旧任务、事件和原回执保留。不启动工作者。'));
    const label=el('label','','check-row'),check=el('input');check.type='checkbox';check.required=true;check.name='confirm_schema_upgrade';label.append(check,el('span','确认启用当前任务并保留旧数据；理解旧版本不支持新协作规则。'));holder.append(label);
  }
  if(action==='feedback'){
    field(holder,'scope','影响范围',{type:'select',options:[['local','局部：只更新本角色意见版本'],['shared','共同：暂停协调，停写核对后修订合同']]});
    field(holder,'note','具体要求 / 反馈来源',{max:4000});
    holder.append(el('p','本机登记不保证网页模型立即收到。局部意见不会丢弃其他独立角色的交付；共同变更不自动停止原Job。'));
  }
  if(action==='publish')holder.append(el('p','发布后原合同不就地覆盖；修改目标需显式修订版本。发布不自动派发角色。'));
  if(action==='claim'){
    holder.append(el('p','只有确认本角色可以开工时才登记。写域检查仅覆盖本工作台的活动角色，其他开发者仍需按项目guard协调。'));
    if(role.executor!=='web')field(holder,'external_ref','操作者声明的外部线程 / 工作引用',{type:'text',max:500});
  }
  if(action==='checkpoint')for(const [name,label]of [['completed','已完成'],['remaining','尚未完成 / 未知结果'],['next_step','下一步'],['original_jobs','原Session / Job引用']])field(holder,name,label,{value:state.checkpoint?.[name]||'',required:false,max:6000});
  if(action==='submit'){
    for(const [name,label]of [['summary','完成摘要'],['changes','真实提交 / 差异范围'],['tests','实际测试与证据'],['limitations','未验证项 / 限制（没有可留空）'],['artifacts','产物路径 / hash / 原Job']])field(holder,name,label,{required:name!=='limitations',max:12000});
    const label=el('label','','check-row'),check=el('input');check.type='checkbox';check.name='stopped_writing';check.required=true;label.append(check,el('span','我确认本角色已停止写入，交接内容基于当前合同版本；不是声称程序自动核验了这些证据。'));holder.append(label);
  }
  if(['review','review_delivery'].includes(action)){
    holder.append(el('p','核对交接、实际成果和证据后记录意见。不因一句“完成”自动放行。'));
    field(holder,'outcome','审阅结论',{type:'select',options:[['accepted','通过角色审阅'],['rework','退回同一任务继续修正']]});field(holder,'note','核验依据 / 退回原因',{max:6000});
    if(action==='review_delivery'){holder.append(el('p','当前交付：'+state.delivery.id,'mono'));field(holder,'evidence','独立核对实际文件 / 输入版本 / 测试日志的依据',{max:6000});}
  }
  if(action==='accept'){
    for(const [i,c]of task.contract.acceptance.entries()){const panel=el('div','','check-evidence'),label=el('label','','check-row'),check=el('input');check.type='checkbox';check.required=true;check.name='passed_'+i;label.append(check,el('span',c));panel.append(label);field(panel,'evidence_'+i,'此条件的实际验证依据',{max:4000});holder.append(panel);}field(holder,'note','整体验收说明',{max:4000});
  }
  if(action==='bind'){
    const input=field(holder,'session_id','确切 Session ID',{type:'text',value:state.binding?.session_id||'',max:128});input.placeholder='wc_sess_…';
    const chooser=field(holder,'session_choice','已观测会话（较旧会话可手填确切ID）',{type:'select',required:false,options:[['','正在读取…']]});chooser.onchange=()=>{if(chooser.value)input.value=chooser.value;};
    const spec=actionSpec;$('taskAction').showModal();
    try{const data=await client.read('sessions',{id:task.id,role:rid});if(actionSpec!==spec)return;spec.connection=data.connection_id;chooser.replaceChildren(option('','选择已观测会话'),...data.sessions.map(s=>option(s.id,s.title.slice(0,100))));}
    catch(e){if(actionSpec===spec)$('actionError').textContent=e.message;}
    return;
  }
  $('taskAction').showModal();
}
function actionData(spec){
  const data=Object.fromEntries([...$('actionFields').querySelectorAll('[name]')].filter(x=>x.type!=='checkbox').map(x=>[x.name,x.value]));
  if(spec.rid)data.role_id=spec.rid;
  if(spec.action==='collaborate')data.confirm_schema_upgrade=$('actionFields').querySelector('[name=confirm_schema_upgrade]').checked;
  if(spec.action==='review_delivery')data.delivery_id=spec.task.roles[spec.rid].delivery.id;
  if(spec.action==='bind'){delete data.session_choice;data.connection_id=spec.connection||'';}
  if(spec.action==='submit'){data.contract_version=spec.task.contract_version;data.stopped_writing=$('actionFields').querySelector('[name=stopped_writing]').checked;}
  if(spec.action==='accept')return {note:data.note,checks:spec.task.contract.acceptance.map((_,i)=>({index:i,outcome:$('actionFields').querySelector(`[name=passed_${i}]`).checked?'passed':'not_run',evidence:data['evidence_'+i]}))};
  return data;
}
async function reobserveAction(){
  const spec=actionSpec;if(!spec||client.busy()||client.pending())return;
  const control=$('rebaseTaskAction');let adopted=null;control.disabled=true;$('saveTaskAction').disabled=true;
  try{
    const value=(await client.read('get',{id:spec.task.id})).task;if(actionSpec!==spec)return;
    if(value.contract_hash!==spec.task.contract_hash||value.contract_version!==spec.task.contract_version)throw Error('共同合同已变化，不能把原草稿套到新合同；原文字仍保留，请重新核对任务。');
    if(!['feedback','review_delivery','checkpoint'].includes(spec.action))throw Error('此动作不能自动换版本。原草稿保留；请核对当前状态后重新选择操作。');
    const old=spec.task.roles[spec.rid],state=value.roles[spec.rid];
    if(!state||state.attempt!==old.attempt||JSON.stringify(state.binding)!==JSON.stringify(old.binding))throw Error('本角色执行尝试或绑定已变化，不能自动转交原草稿。');
    if(spec.action==='review_delivery'&&(state.status!=='submitted'||state.delivery?.id!==old.delivery?.id||state.feedback_revision!==old.feedback_revision||value.status!=='open'))throw Error('原交付或意见已变化，不能用旧审阅批准新成果；原文字仍保留。');
    if(spec.action==='checkpoint'&&(JSON.stringify(state.checkpoint)!==JSON.stringify(old.checkpoint)||!['running','blocked'].includes(state.status)))throw Error('恢复点已被更新，不能覆盖较新的进展；原文字仍保留。');
    if(!['open','paused'].includes(value.status))throw Error('任务已结束，原草稿不自动写入。');
    adopted={...spec,task:value};actionSpec=adopted;
    $('actionFields').querySelector('p').textContent=`已核对合同 v${value.contract_version} / 数据版本 ${value.version} / ${phaseNames[value.phase]||value.phase}。尚未发送变更。`;
    $('actionError').textContent='已核对最新版本，草稿完整保留。确认内容仍适用后，再点击“确认记录”；没有自动重发。';control.hidden=true;
  }catch(e){if(actionSpec===spec)$('actionError').textContent=e.message;}
  finally{if(actionSpec===spec||actionSpec===adopted){control.disabled=false;$('saveTaskAction').disabled=false;}}
}
$('rebaseTaskAction').onclick=()=>void reobserveAction();
$('refreshInbox').onclick=()=>loadInbox();$('moreInbox').onclick=()=>{inboxAfter=inboxNext;void loadInbox(false);};
$('newTask').onclick=()=>openEditor();$('addTaskRole').onclick=()=>{if($('editRoles').children.length>=16){$('editorError').textContent='最多16个角色';return;}roleEditor();};
$('closeTaskEditor').onclick=()=>$('taskEditor').close();$('closeTaskAction').onclick=()=>{$('taskAction').close();actionSpec=null;};
$('taskAction').addEventListener('cancel',()=>{actionSpec=null;});
$('taskEditorForm').onsubmit=async e=>{e.preventDefault();$('saveTask').disabled=true;try{const c=editorContract();await perform(editorTarget?'revise':'create',editorTarget?{contract:c,reason:$('revisionReason').value||'更新未发布草稿'}:{contract:c},editorTarget);$('taskEditor').close();}catch(err){$('editorError').textContent=err.message;}finally{$('saveTask').disabled=false;}};
$('taskActionForm').onsubmit=async e=>{e.preventDefault();const spec=actionSpec;if(!spec)return;$('saveTaskAction').disabled=true;try{await perform(spec.action,actionData(spec),spec.task);if(actionSpec===spec){$('taskAction').close();actionSpec=null;}}catch(err){if(actionSpec===spec){$('actionError').textContent=err.message;$('rebaseTaskAction').hidden=err.code!=='version_conflict';}}finally{$('saveTaskAction').disabled=false;}};
$('refreshTasks').onclick=()=>refreshCurrent().catch(e=>notice(e.message));$('taskFilter').onchange=()=>list().catch(e=>notice(e.message));$('taskSearch').onkeydown=e=>{if(e.key==='Enter')void list().catch(e=>notice(e.message));};$('moreTasks').onclick=()=>{listAfter=nextAfter;void list(false).catch(e=>notice(e.message));};
$('taskImport').onchange=async e=>{const f=e.target.files?.[0];e.target.value='';try{actor();if(!f||f.size>2*1024*1024)throw Error('导入包超过2 MiB或未选择文件');const bundle=JSON.parse(await f.text());await perform('import',{bundle},null);}catch(err){notice(err.message);}};
async function recover(retry){try{const r=retry?await client.retrySame():await client.reconcile();if(r){await select(r.task_id);notice('已从原请求回执恢复；没有新建或重复执行任务。');}else notice('尚未找到已提交回执，原请求仍保留；可明确重试同一请求，不能换ID复制操作。');}catch(e){notice(e.message);}}
$('reconcileTask').onclick=()=>recover(false);$('retryTask').onclick=()=>recover(true);
let observingTasks=false;
async function observeTaskChanges(){
  if(observingTasks||document.hidden||resourceUI.active()||goalUI.active()||routingUI.active()||client.busy()||$('pendingRequest').hidden===false||$('taskEditor').open||$('taskAction').open)return;
  observingTasks=true;const ticket=epoch,id=current?.id;
  try{
    if(id){
      const value=await client.read('get',{id});
      if(ticket!==epoch||current?.id!==id||resourceUI.active()||goalUI.active()||routingUI.active()||$('taskEditor').open||$('taskAction').open)return;
      if(value.task.version>current.version){current=value.task;renderTask();}
    }
    await list(false);await loadInbox();await resourceUI.refresh();
  }catch{if(!document.hidden&&!$('taskEditor').open&&!$('taskAction').open)notice('任务同步暂不可用，保留当前记录；不会重发任何变更。');}
  finally{observingTasks=false;}
}
setInterval(()=>void observeTaskChanges(),5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void observeTaskChanges();});
$('taskActor').onchange=()=>{try{localStorage.setItem('clw.tasks.actor',$('taskActor').value);}catch{notice('别名仅当前页面有效，本地浏览器保存不可用。');}};
try{$('taskActor').value=localStorage.getItem('clw.tasks.actor')||'';}catch{}
(async()=>{try{const info=await client.init();$('taskStoreState').textContent='本机任务库已连接 · 可见页面约5秒同步 · '+info.store_id.slice(0,8);await list();await loadInbox();await resourceUI.refresh();}catch(e){$('taskStoreState').textContent='任务服务尚未可用';notice('请启动新版Control Center（不是重启WebCodex）。'+e.message);}})();
