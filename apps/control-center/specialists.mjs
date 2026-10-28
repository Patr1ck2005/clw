import {createJournalClient} from './journal-client.mjs';
const $=id=>document.getElementById(id),el=(tag,text='')=>{const x=document.createElement(tag);x.textContent=text;return x;};
const notice=s=>{$('specialistNotice').textContent=s;};
const actor=()=>{const s=$('specialistActor').value.trim();if(!s)throw Error('先填写本机操作者署名');return s;};
const opt=(v,text)=>{const o=el('option',text);o.value=v;return o;};
function pending(id,p){const box=$(id);box.hidden=!p;box.querySelector('.pending-text').textContent=p?p.command.request_id+' / '+p.command.action:'';}
const native=createJournalClient('./api/specialists/',{onPending:p=>pending('pendingSpecialist',p)});
const usage=createJournalClient('./api/usage/',{onPending:p=>pending('pendingUsage',p)});
let task=null,role=null,epoch=0,caps=null,enabled=false,taskAfter=0,usageAfter=0,entries=[],summary=null,editing=null,confirmation=null,watching=false;
async function taskRead(route,params={}){const r=await fetch('./api/tasks/'+route+'?'+new URLSearchParams(params),{cache:'no-store',credentials:'omit'});const text=await r.text();if(text.length>5000000)throw Error('任务响应超限');const d=JSON.parse(text);if(!r.ok||d.success!==true)throw Error(d.message||'读取任务失败');return d;}
async function tasks(reset=true){
  const page=await taskRead('list',{after:reset?0:taskAfter});if(reset)$('specialistTask').replaceChildren(opt('','选择任务'));
  for(const t of page.tasks)$('specialistTask').append(opt(t.id,t.title));taskAfter=page.next_after;$('moreSpecialistTasks').hidden=taskAfter==null;
  if(task)$('specialistTask').value=task.id;
}
async function loadTask(id,rid=''){
  const ticket=++epoch;caps=null;$('nativeProvider').replaceChildren(opt('','尚未核对'));$('providerNotice').textContent='';
  // A newly selected task is not loaded yet. Never leave old Run actions enabled
  // under the new selector label while its GET is pending or fails.
  task=role=null;$('specialistRole').replaceChildren(opt('','正在核对任务'));render();
  if(!id)return;
  const value=await taskRead('get',{id});if(ticket!==epoch)return;
  task=value.task;const roles=task.contract.roles.filter(r=>r.executor==='codex');$('specialistRole').replaceChildren(opt('','选择 Codex 角色'),...roles.map(r=>opt(r.id,r.id+' · '+r.name)));
  $('specialistRole').value=roles.some(r=>r.id===rid)?rid:(roles[0]?.id||'');role=roles.find(r=>r.id===$('specialistRole').value)||null;render();
}
const state=()=>role?task.roles[role.id]:null;
function render(){
  const s=state(),d=s?.delegation;const holder=$('nativeRun');holder.replaceChildren();
  $('roleScope').textContent=role?`${task.contract.title}\n${role.project_id}\n${role.worktree}\n写域：${role.scopes.join(' / ')||'只读'} · 协调状态：${s.status}`:'请选择含 Codex 角色的完整任务';
  $('prepareNative').disabled=!role||!caps?.providers?.length||s.status!=='running';$('discoverProvider').disabled=!role;
  $('nativeStart').disabled=!enabled||d?.phase!=='prepared';$('nativeObserve').disabled=!d?.run_id;
  $('nativeRetry').disabled=!enabled||!['dispatching','unknown'].includes(d?.phase)||!!d?.run_id;
  $('nativeCancel').disabled=!enabled||!d?.run_id||['completed','failed','cancelled','not_started','abandoned'].includes(d?.phase);
  $('nativeAbandon').disabled=d?.phase!=='prepared';
  if(!d){holder.append(el('p','本角色暂无专项。先核对 Provider 并冻结完整任务包；不会自动开始执行。'));return;}
  holder.append(el('h3','专项状态：'+d.phase),el('p',`原 Run：${d.run_id||'尚未返回'}\n原幂等键：${d.key}\nProvider：${d.provider}\n请求模型：${d.config.model} / 档位：${d.config.reasoning_effort} / 模式：${d.config.mode}\n有效模型 / 档位：未知（原生接口未提供）\n计费：${d.billing} · ${d.account_alias}（操作者声明，未核验）`));
  if(d.provider_advertisement_verified===false)holder.append(el('p','Provider ID来源：明确本机配置；只读接口未验证其注册明细，原生派发前核验。'));
  if(d.error_code)holder.append(el('p','原生拒绝：'+d.error_code));if(d.observation_error)holder.append(el('p',d.observation_error));
  if(d.cancel_requested)holder.append(el('p','已记录取消请求；以核对原 Run 的终态为准。'));
  if(d.terminal)holder.append(el('pre',JSON.stringify(d.terminal,null,2)));
  if(d.usage){holder.append(el('h3','原 Run 用量观察（不是官方额度或发票）'),el('pre',JSON.stringify(d.usage,null,2)));}
  if(d.history_lost)holder.append(el('p','原生历史窗口已重置 / 不完整；不拼造全部事件。'));
  if(d.has_more)holder.append(el('p','还有后续事件；再次核对原 Run 读取下一页。'));
  const detail=el('details');detail.append(el('summary','冻结启动包 · SHA256 '+d.instruction_hash),el('pre',d.instruction));holder.append(detail);
}
async function discover(){const ticket=epoch;if(!role)return;const r=await native.read('capabilities',{id:task.id,role:role.id});if(ticket!==epoch)return;caps=r;$('providerNotice').textContent=r.reason;$('nativeProvider').replaceChildren(opt('','选择 Provider 候选（核对来源）'),...r.providers.map(p=>opt(p.id,p.name+' / '+p.id)));if(r.providers.length===1)$('nativeProvider').value=r.providers[0].id;render();}
async function act(action,data,identity){
  const ticket=epoch;await native.command(action,data,identity);if(epoch===ticket)await loadTask(identity.task_id,data.role_id);notice('已登记本机动作；下方状态来自原 Run 核对，不代表父任务通过。');
}
function identity(){if(!task||!role)throw Error('先选择任务与角色');return {task_id:task.id,expected_version:task.version,actor:actor()};}
$('prepareSpecialist').onsubmit=async e=>{e.preventDefault();$('prepareNative').disabled=true;try{
  const id=identity(),p=caps?.providers.find(p=>p.id===$('nativeProvider').value);if(!p)throw Error('先重新核对 Provider');
  await act('prepare',{role_id:role.id,provider:p.id,binding:p.binding,config:{model:$('nativeModel').value,reasoning_effort:$('nativeEffort').value,mode:$('nativeMode').value},billing:'work_codex',account_alias:$('nativeAccount').value},id);
}catch(e){notice(e.message);}finally{render();}};
function confirm(action){try{if(native.busy()||native.pending())throw Error('先等待或核对原请求；关闭弹窗不取消已发出的操作。');const id=identity(),d=state()?.delegation;if(!d)throw Error('尚无准备包');confirmation={action,id,rid:role.id};$('nativeConsent').checked=false;$('nativeConfirmError').textContent='';$('nativeConfirmTitle').textContent={start:'确认派发原生专项',retry_start:'确认恢复原键（不是另开任务）',cancel:'请求取消原 Run'}[action];$('nativeConfirmText').textContent=`${task.contract.title} / ${role.id}\n${d.project}\n${d.provider} / ${d.config.model} / ${d.config.reasoning_effort}\n原键 ${d.key}\n原生单 Run 预算上限 ${d.timeout_secs} 秒；超时不是完成目标，不自动另起任务。\n该动作可能消耗已配置 Provider 的用量。请求模式：${d.config.mode}；真实计费身份、沙箱需本机核对。`;$('nativeConfirm').showModal();}catch(e){notice(e.message);}}
$('nativeConfirmForm').onsubmit=async e=>{e.preventDefault();const c=confirmation;if(!c)return;$('nativeConfirmGo').disabled=true;try{await act(c.action,{role_id:c.rid,confirmed:$('nativeConsent').checked},c.id);if(confirmation===c){$('nativeConfirm').close();confirmation=null;}}catch(e){if(confirmation===c)$('nativeConfirmError').textContent=e.message;else notice(e.message);}finally{$('nativeConfirmGo').disabled=false;}};
$('nativeConfirmClose').onclick=()=>{$('nativeConfirm').close();confirmation=null;};$('nativeConfirm').addEventListener('cancel',()=>{confirmation=null;});
$('nativeStart').onclick=()=>confirm('start');$('nativeRetry').onclick=()=>confirm('retry_start');$('nativeCancel').onclick=()=>confirm('cancel');
for(const [id,action]of [['nativeObserve','observe'],['nativeAbandon','abandon']])$(id).onclick=async()=>{try{const who=identity();await act(action,{role_id:role.id},who);}catch(e){notice(e.message);}};
$('discoverProvider').onclick=()=>discover().catch(e=>notice(e.message));$('specialistTask').onchange=()=>loadTask($('specialistTask').value).catch(e=>notice(e.message));
$('specialistRole').onchange=()=>{epoch++;caps=null;role=task?.contract.roles.find(r=>r.id===$('specialistRole').value)||null;render();};
$('refreshSpecialists').onclick=async()=>{try{await tasks();if(task)await loadTask(task.id,role?.id);}catch(e){notice(e.message);}};$('moreSpecialistTasks').onclick=()=>tasks(false).catch(e=>notice(e.message));
const bucketNames={chat:'Chat 消息窗口',work_codex:'Work / Codex 用量',api:'独立 API 账单'};
const sourceNames={operator_observation:'人工抄录 · 未自动核验',self_count:'自行计数',estimate:'估计 · 不是实际支出'};
function download(value){const a=el('a'),u=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.href=u;a.download='clw-usage-page.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
async function refreshUsage(reset=true){
  const [s,l]=await Promise.all([usage.read('summary'),usage.read('list',{after:reset?0:usageAfter})]);summary=s;entries=l.entries;usageAfter=l.next_after;$('moreUsage').hidden=usageAfter==null;
  $('usageCards').replaceChildren();for(const bucket of s.buckets){const c=el('article');c.className='ledger-card';c.append(el('h3',bucketNames[bucket]),el('strong','官方余量未知'));for(const g of s.totals.filter(g=>g.bucket===bucket))c.append(el('p',`${g.account_alias} / ${g.window} / ${sourceNames[g.source]}\n已知小计 ${g.known_subtotal} ${g.unit}；${g.unknown_count} 笔未知`));for(const x of s.snapshots.filter(x=>x.bucket===bucket))c.append(el('p',`${x.account_alias} / ${x.window} / ${sourceNames[x.source]}\n${x.amount??'未知'} ${x.unit} · ${x.observed_at} · ${x.expired?'已过期；不代表当前余量':'人工观察值'} · 重置 ${x.resets_at||'未知'}`));$('usageCards').append(c);}
  if(s.truncated)$('usageCards').append(el('p','分类较多，本页摘要截断；没有跨组总计。'));
  $('usageEntries').replaceChildren();for(const r of entries){const row=el('article');row.className='ledger-record';row.append(el('h3',`${bucketNames[r.bucket]} / ${r.account_alias} / ${r.amount??'未知'} ${r.unit}`),el('p',`${sourceNames[r.source]} · ${r.window} · 原引用 ${r.reference} · v${r.version}`),el('p',r.note));const b=el('button','修正原记录');b.type='button';b.className='link-button';b.onclick=()=>editUsage(r);row.append(b);const h=el('button','查看保留历史');h.type='button';h.className='link-button';h.onclick=async()=>{try{const d=await usage.read('history',{id:r.id});row.append(el('pre',JSON.stringify(d,null,2)));h.disabled=true;}catch(e){notice(e.message);}};row.append(h);$('usageEntries').append(row);}
}
const usageFields={bucket:'usageBucket',account_alias:'usageAccount',kind:'usageKind',unit:'usageUnit',amount:'usageAmount',source:'usageSource',reference:'usageReference',window:'usageWindow',observed_at:'usageObserved',resets_at:'usageReset',task_id:'usageTask',note:'usageNote',status:'usageStatus'};
function editUsage(r){editing=r;$('usageEditorTitle').textContent='修正原记录 · '+r.id;for(const[k,id]of Object.entries(usageFields)){$(id).value=r[k]??'';$(id).disabled=['bucket','account_alias','reference','kind','unit','window','task_id'].includes(k);}$('usageForm').scrollIntoView({block:'start'});}
function resetUsage(){editing=null;$('usageForm').reset();for(const id of Object.values(usageFields))$(id).disabled=false;$('usageEditorTitle').textContent='新增来源记录';$('usageObserved').value=new Date().toISOString();}
$('usageForm').onsubmit=async e=>{e.preventDefault();$('saveUsage').disabled=true;try{const data=Object.fromEntries(Object.entries(usageFields).map(([k,id])=>[k,$(id).value]));if(data.status==='unknown')data.amount=null;const who={actor:actor(),...(editing?{entry_id:editing.id,expected_version:editing.version}:{})};await usage.command(editing?'correct':'record',data,who);resetUsage();await refreshUsage();notice('已保存独立账本记录；没有调用模型或改变官方额度。');}catch(e){notice(e.message);}finally{$('saveUsage').disabled=false;}};
$('usageBucket').onchange=()=>{const api=$('usageBucket').value==='api';$('usageKind').value=api?'delta':'snapshot';$('usageUnit').value=api?'USD':'used_percent';};
$('usageKind').onchange=()=>{if($('usageBucket').value!=='api')$('usageUnit').value=$('usageKind').value==='snapshot'?'used_percent':'messages';};
$('resetUsage').onclick=resetUsage;$('refreshUsage').onclick=()=>refreshUsage().catch(e=>notice(e.message));$('moreUsage').onclick=()=>refreshUsage(false).catch(e=>notice(e.message));$('exportUsage').onclick=()=>download({format:'clw.usage.page.v1',exported_at:new Date().toISOString(),coverage:'current page and grouped summary; not a complete database backup',entries,summary});
async function recover(client,retry){try{const r=await client.recover(retry);notice(r?'原请求已有回执；继续核对当前记录，不额外派发。':'尚未找到原请求回执；不要复制同一操作。');if(r?.task_id)await loadTask(r.task_id,role?.id);await refreshUsage();}catch(e){notice(e.message);}}
$('reconcileSpecialist').onclick=()=>recover(native,false);$('retrySpecialistReceipt').onclick=()=>recover(native,true);$('reconcileUsage').onclick=()=>recover(usage,false);$('retryUsageReceipt').onclick=()=>recover(usage,true);
setInterval(async()=>{
  if(watching||document.hidden||native.busy()||native.pending()||$('nativeConfirm').open||!task)return;
  watching=true;const id=task.id,ticket=epoch;
  try{const data=await taskRead('get',{id});if(epoch===ticket&&task?.id===id&&data.task.version>task.version&&!$('nativeConfirm').open){const hash=task.contract_hash,rid=role?.id;task=data.task;role=task.contract.roles.find(r=>r.id===rid)||null;if(hash!==task.contract_hash)caps=null;render();}}catch{}finally{watching=false;}
},5000);
try{$('specialistActor').value=localStorage.getItem('clw.tasks.actor')||'';}catch{}
(async()=>{resetUsage();try{const [i]=await Promise.all([native.init(),usage.init()]);enabled=i.dispatch_enabled===true;$('specialistState').textContent=enabled?'已明确启用原生专项 · 每次派发仍须确认':'原生专项派发关闭 · 可记账、查看和准备';await Promise.all([tasks(),refreshUsage()]);render();}catch(e){notice(e.message);$('specialistState').textContent='新产品服务尚不可用；只重开 Control Center，不重启 WebCodex。';}})();
