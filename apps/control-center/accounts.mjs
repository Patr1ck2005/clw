import {createJournalClient} from './journal-client.mjs';
import {healthLabel,healthTone,age,profileMatches,createSelectionGate,activityOutcome} from './account-view.mjs';
const $=id=>document.getElementById(id), el=(tag,text,cls)=>{const x=document.createElement(tag);if(text!=null)x.textContent=text;if(cls)x.className=cls;return x;};
const option=(id,label)=>{const x=el('option',label);x.value=id;return x;};
const note=text=>{$('accountNotice').textContent=text;};
const pending=p=>{$('pendingAccount').hidden=!p;$('pendingAccountId').textContent=p?.command.request_id||'';};
const fetcher=async(url,opts)=>{if(opts?.method==='POST')return fetch(url,opts);const c=new AbortController(),timer=setTimeout(()=>c.abort(),28000);try{return await fetch(url,{...opts,signal:c.signal});}finally{clearTimeout(timer);}};
const api=createJournalClient('./api/accounts/',{fetcher,onPending:pending});
let catalog={accounts:[],sources:[]},dash=new Map(),selected='',binding='',timer=null,paused=false,refreshing=false,listEpoch=0,editing=null,editEpoch=0,bindState=null,bindEpoch=0,actionState=null,actionEpoch=0;
const gate=createSelectionGate();
const actor=()=>{try{return sessionStorage.getItem('clw.account.actor')||'本机操作者';}catch{return '本机操作者';}};
function remember(value){try{sessionStorage.setItem('clw.account.actor',value);}catch{/* Explicit actor still sent; no guarantee of local persistence. */}}
function controls(){const blocked=api.busy()||!!api.pending(),a=dash.get(selected)?.account;for(const id of ['newAccount','editAccount','reconfirmSource','archiveAccount','openBinding'])$(id).disabled=blocked||(id!=='newAccount'&&!a);$('openBinding').disabled=blocked||!a||a.archived;$('refreshAccounts').disabled=refreshing;}
function rememberDashboard(id,d){const old=dash.get(id);if(old&&old.account.version>d.account.version)return old;dash.set(id,d);return d;}
function observationFailed(id){const old=dash.get(id);if(old)dash.set(id,{...old,health:{state:'observation_stale',checked_at:old.health.checked_at,error_code:'workbench_read_failed',account_authentication:false}});drawCards();}
function ensureEditable(){if(api.busy()||api.pending())throw Error('请先核对正在处理或结果未知的请求。');}
function drawCards(){
 const holder=$('accountCards');holder.replaceChildren();
 for(const a of catalog.accounts){if((a.archived&&!$('showArchived').checked)||!profileMatches(a,$('accountSearch').value))continue;
  const h=dash.get(a.id)?.health||{},b=el('button',null,'account-card'+(selected===a.id?' selected':''));b.dataset.accountId=a.id;b.setAttribute('aria-pressed',String(selected===a.id));
  const top=el('div',null,'card-top');top.append(el('span',a.archived?'已归档':paused?'已暂停观察':healthLabel(h),'tag '+(paused?'muted':healthTone(h))),el('span',`${a.registered_bindings} 已登记会话`,'tag'));
  b.append(top,el('h2',a.name),el('div',a.tunnel_id,'mono'),el('p',a.browser_hint||'浏览器标签未填写'),el('small',a.source_current?'本地档案 · 非平台身份认证':'入口引用已变化，需重新确认'));
  b.append(el('small','最近观测：'+(h.checked_at||'尚未获取')));b.onclick=()=>selectAccount(a.id);holder.append(b);
 }
 if(!holder.children.length)holder.append(el('div',catalog.sources.length?'没有匹配的档案。已有入口可以添加一个本地档案。':'没有已配置入口。请在本机登记非敏感健康URL引用；不需要把Key输入本页。','empty'));
}
function clearActivity(){binding='';gate.select(selected);$('accountActivity').replaceChildren(el('div','请选择会话。','empty'));}
function selectAccount(id){selected=id;clearActivity();drawCards();$('selectedAccount').hidden=false;$('accountTitle').textContent='正在读取账号记录…';$('boundSessions').replaceChildren();$('ingressFacts').replaceChildren();$('accountHistory').replaceChildren();loadSelected();}
function renderSelected(d){
 const a=d.account;$('selectedAccount').hidden=false;$('accountTitle').textContent=a.name;$('accountIdentity').textContent=`${a.connection_id} / ${a.source_id} · 归属人工确认，不是独立后端身份`;
 $('archiveAccount').textContent=a.archived?'恢复记录':'归档记录';
 const h=d.health,holder=$('ingressFacts');holder.replaceChildren();
 const facts=[['入口状态',healthLabel(h)],['本机HTTP服务',h.health_live===true?'存活':h.health_live===false?'未通过':'未观测'],['本机ready',h.health_ready===true?'ready（不等于云端可达）':h.health_ready===false?'未就绪':'未观测'],['最近成功云端轮询',age(h.poll_age_secs)],['入口身份',h.tunnel_identity==='metric_match'?'匹配本条Tunnel标签':'未核验'],['进程启动时间',h.process_started_at?new Date(h.process_started_at*1000).toISOString():'未观测'],['观测时间',h.checked_at||'未观测'],['MCP目标单独探针','未单独观测'],['历史tools/list返回200',h.tools_list_http_200==null?'未观测':String(h.tools_list_http_200)+' 次 · 不保证当前可用'],['诊断代码',h.error_code||'无当前诊断错误']];
 for(const [k,v]of facts){const f=el('div',null,'ingress-fact');f.append(el('span',k),el('strong',v));holder.append(f);}
 const box=$('boundSessions');box.replaceChildren();
 for(const b of d.bindings){const row=el('article',null,'bound-session');row.dataset.bindingId=b.id;row.append(el('b',b.role||'未标注角色'),el('p',b.session_id,'mono'),el('p',b.project_id),el('p',b.source_current?'Session存在已观察；来源账号由操作者确认':'来源版本变化：旧归属需要重新确认'));
  const actions=el('div',null,'header-actions'),view=el('button','查看独立时间线','link-button'),remove=el('button','解绑记录','link-button');view.disabled=!b.source_current||a.archived;view.onclick=()=>{binding=b.id;gate.select(selected+'|'+binding);$('accountActivity').replaceChildren(el('div','读取确切会话…','empty'));loadActivity();};remove.onclick=()=>openAction('unbind',b.id);actions.append(view,remove);row.append(actions);box.append(row);
 }
 if(!d.bindings.length)box.append(el('div','尚未确认任何Session归属。不会用其他账号或同名会话填充这里。','empty'));
 if(binding&&!d.bindings.some(b=>b.id===binding&&b.source_current))clearActivity();
 $('openBinding').disabled=a.archived||api.busy()||!!api.pending();
 if(!$('accountHistory').children.length){const btn=el('button','查看审计记录','link-button');btn.onclick=()=>loadHistory(0);$('accountHistory').append(btn);}
}
async function loadSelected(){const t=gate.ticket(),id=selected;if(!id)return;try{const d=await api.read('dashboard',{id});if(!gate.valid(t)||id!==selected)return;const current=rememberDashboard(id,d);renderSelected(current);drawCards();controls();}catch(e){if(gate.valid(t)){observationFailed(id);$('boundSessions').replaceChildren(el('div',e.message,'empty'));clearActivity();}}}
async function loadActivity(){if(!binding||!selected)return;const t=gate.ticket(),id=selected,b= binding;try{const r=await api.read('activity',{id,binding:b});if(!gate.valid(t)||id!==selected||b!==binding)return;renderActivity(r);}catch(e){if(gate.valid(t))$('accountActivity').replaceChildren(el('div','未采用旧记录：'+e.message,'empty'));}}
function renderActivity(r){
 const host=$('accountActivity');host.replaceChildren();host.append(el('h3',r.session.title),el('p',r.binding.session_id,'mono'),el('p',`观测 ${r.observed_at}；来源：操作者确认。保留活动 ${r.session.activities?.length||0}/${r.session.activity_total||0}；不是精确工具调用统计。`,'hint'));
 const wrap=el('div',null,'table-scroll'),table=document.createElement('table'),head=el('tr');for(const s of ['时间 UTC','工具','结果 / 耗时','Job / 变化'])head.append(el('th',s));const thead=document.createElement('thead');thead.append(head);table.append(thead);const body=document.createElement('tbody');
 for(const a of r.session.activities||[]){const row=el('tr');const utc=a.started_at?new Date(a.started_at*1000).toISOString().slice(11,19):'未提供';const tool=el('td',a.tool||a.kind),state=el('td',activityOutcome(a)),job=el('td',a.job_id||'—');state.append(el('small',a.duration_ms==null?'耗时未提供':`${a.duration_ms} ms · 非思考时间`));job.append(el('small',(a.paths||[]).join('\n')));row.append(el('td',utc),tool,state,job);body.append(row);}
 table.append(body);wrap.append(table);host.append(wrap,el('h3','原 Job 的观察结果'));
 for(const j of r.jobs){const row=el('div',null,'job-row');row.append(el('span',j.id,'mono'),el('span',`${j.status} / exit ${j.exit_code??'未知'}`,'tag'));host.append(row);}
 if(!r.jobs.length)host.append(el('p','本次保留窗口未返回该Session的Job，不代表历史没有任务。','hint'));
 host.append(el('h3','已有任务中的角色关联'));
 for(const task of r.tasks){const x=el('div',null,'task-link');x.append(el('b',`${task.title} · ${task.role} · ${task.phase}`),el('p',task.task_id,'mono'),el('p',task.worktree));host.append(x);}
 if(!r.tasks.length)host.append(el('p','没有匹配的本地任务角色；账号绑定不会自行创建或接管任务。','hint'));
 const link=el('a','打开完整任务库','link-button');link.href='./tasks.html';host.append(link);
}
async function loadHistory(after){const id=selected,t=gate.ticket();try{const r=await api.read('history',{id,after});if(!gate.valid(t)||id!==selected)return;const host=$('accountHistory');host.replaceChildren(el('b','审计记录 · 当前分页'));
 for(const e of r.events)host.append(el('p',`${e.sequence} · ${e.at} · ${e.action} · ${e.actor}`));
 if(r.next_after){const btn=el('button','下一页记录','link-button');btn.onclick=()=>loadHistory(r.next_after);host.append(btn);}
 }catch(e){note(e.message);}}
function schedule(){clearTimeout(timer);if(!paused&&!document.hidden)timer=setTimeout(()=>refresh(),5000);}
async function refresh(){
 if(refreshing)return;refreshing=true;controls();const epoch=++listEpoch;
 try{const r=await api.read('list');if(epoch!==listEpoch)return;catalog=r;drawCards();$('accountStoreState').textContent=`本地账户库已连接 · ${r.accounts.length} 个档案 / ${r.sources.length} 个已登记入口 · ${new Date().toLocaleTimeString()}`;
  const queue=r.accounts.filter(a=>!a.archived).map(a=>a.id);
  async function worker(){while(queue.length&&epoch===listEpoch&&!paused&&!document.hidden){const id=queue.shift();try{const d=await api.read('dashboard',{id});if(epoch!==listEpoch)return;const current=rememberDashboard(id,d);if(id===selected)renderSelected(current);drawCards();}catch(e){if(epoch!==listEpoch)return;observationFailed(id);if(id===selected){$('ingressFacts').replaceChildren(el('div','观察失败：'+e.message,'empty'));clearActivity();}}}}
  await Promise.all([worker(),worker()]);if(epoch!==listEpoch||paused||document.hidden)return;if(!selected&&r.accounts.some(a=>!a.archived))selectAccount(r.accounts.find(a=>!a.archived).id);
  if(binding&&!paused&&!document.hidden)await loadActivity();
 }catch(e){if(epoch===listEpoch){for(const a of catalog.accounts)observationFailed(a.id);clearActivity();note('未替换为虚假在线状态：'+e.message);$('accountStoreState').textContent='账户库读取失败，已有观测可能过期';}}
 finally{refreshing=false;controls();schedule();}
}
function openEditor(id=''){
 try{ensureEditable();const a=id?(dash.get(id)?.account||catalog.accounts.find(a=>a.id===id)):null;editing=a?structuredClone(a):null;editEpoch++;
 $('accountEditorTitle').textContent=a?'编辑本地档案':'添加账号档案';$('accountSource').replaceChildren(...catalog.sources.map(s=>option(s.id,s.name+' · '+s.tunnel_id)));$('accountSource').disabled=!!a;if(a)$('accountSource').value=a.source_id;
 $('accountActor').value=actor();$('accountName').value=a?.name||'';$('accountBrowser').value=a?.browser_hint||'';$('accountNotes').value=a?.notes||'';$('accountEditorError').textContent='';$('accountEditor').showModal();
 }catch(e){note(e.message);}
}
$('accountForm').onsubmit=async e=>{e.preventDefault();const version=editEpoch,a=editing;try{ensureEditable();const data={name:$('accountName').value,browser_hint:$('accountBrowser').value,notes:$('accountNotes').value},who=$('accountActor').value;remember(who);if(!a)data.source_id=$('accountSource').value;
 const promise=api.command(a?'update':'create',data,{actor:who,...(a?{account_id:a.id,expected_version:a.version}:{})});controls();await promise;
 if(version===editEpoch){$('accountEditor').close();editing=null;editEpoch++;}note('已保存本地档案；没有新增登录、授权或Tunnel。');await refresh();
 }catch(err){if(version===editEpoch)$('accountEditorError').textContent=err.message;note(err.message);}finally{controls();}};
async function openBind(){
 try{ensureEditable();const a=dash.get(selected)?.account;if(!a)return;bindState={account:structuredClone(a),verified:null};const epoch=++bindEpoch;
 $('bindingAccountTarget').textContent=`来源由你确认：${a.name} / ${a.tunnel_id}`;$('bindingActor').value=actor();for(const id of ['bindingExact','bindingRole','bindingNotes'])$(id).value='';$('bindingConsent').checked=false;$('bindingProject').replaceChildren();$('bindingNativeSession').replaceChildren();$('sessionBindingError').textContent='正在读取可见Project…';$('sessionBinding').showModal();
 const r=await api.read('inspect',{id:a.id});if(epoch!==bindEpoch)return;const p=r.observation.projection.projects;$('bindingProject').replaceChildren(...p.map(p=>option(p.id,p.name)));$('sessionBindingError').textContent=`当前返回 ${p.length} 个项目，不是账号授权清单。`;if(p.length)await loadBindSessions();
 }catch(err){$('sessionBindingError').textContent=err.message;}
}
async function loadBindSessions(exact=''){
 if(!bindState)return;const id=bindState.account.id,project=$('bindingProject').value;const epoch=++bindEpoch;bindState.verified=null;$('bindingConsent').checked=false;$('bindingNativeSession').replaceChildren();$('sessionBindingError').textContent='读取确切Project的会话…';
 try{const r=await api.read('inspect',{id,project,...(exact?{session:exact}:{})});if(epoch!==bindEpoch||!bindState)return;const sessions=r.observation.projection.sessions;$('bindingNativeSession').replaceChildren(...sessions.map(s=>option(s.id,(s.title||s.id).slice(0,110))));if(exact)$('bindingNativeSession').value=exact;bindState.verified={connection_id:r.observation.connection_id,project_id:project,sessions:sessions.map(s=>s.id)};$('sessionBindingError').textContent=`已观察 ${sessions.length} 个Session；最终账号归属仍需你确认。`;
 }catch(e){if(epoch===bindEpoch)$('sessionBindingError').textContent=e.message;}
}
$('bindingAccountForm').onsubmit=async e=>{e.preventDefault();const state=bindState,epoch=bindEpoch;try{ensureEditable();const v=state?.verified,sid=$('bindingNativeSession').value;if(!v||!v.sessions.includes(sid)||!$('bindingConsent').checked)throw Error('先观察确切会话，并勾选来源确认。');
 const data={project_id:v.project_id,session_id:sid,connection_id:v.connection_id,role:$('bindingRole').value,notes:$('bindingNotes').value,confirmed:true},who=$('bindingActor').value;remember(who);
 const promise=api.command('bind',data,{account_id:state.account.id,expected_version:state.account.version,actor:who});controls();await promise;
 if(epoch===bindEpoch){$('sessionBinding').close();bindState=null;bindEpoch++;}note('Session归属已保存：会话存在已观察，账号归属为操作者确认。');await refresh();await loadSelected();
 }catch(err){if(epoch===bindEpoch)$('sessionBindingError').textContent=err.message;note(err.message);}finally{controls();}};
function openAction(kind,bindingId=''){
 try{ensureEditable();const a=dash.get(selected)?.account;if(!a)return;actionState={kind,account:structuredClone(a),bindingId};actionEpoch++;
 $('accountActionTitle').textContent={archive:'归档此账号记录',restore:'恢复此账号记录',reconfirm_source:'重新确认入口引用',unbind:'解绑此会话归属'}[kind];$('accountActionDescription').textContent=`${a.name}：只修改本地组织记录，不停止进程、不注销账号。入口变化不会自动迁移旧Session归属。`;$('accountActionActor').value=actor();$('accountActionReason').value='';$('accountActionError').textContent='';$('accountAction').showModal();
 }catch(e){note(e.message);}
}
$('accountActionForm').onsubmit=async e=>{e.preventDefault();const s=actionState,epoch=actionEpoch;try{ensureEditable();const data={reason:$('accountActionReason').value};if(s.kind==='unbind')data.binding_id=s.bindingId;if(s.kind==='reconfirm_source')data.confirmed=true;const who=$('accountActionActor').value;remember(who);
 const promise=api.command(s.kind,data,{account_id:s.account.id,expected_version:s.account.version,actor:who});controls();await promise;
 if(epoch===actionEpoch){$('accountAction').close();actionState=null;actionEpoch++;}clearActivity();await refresh();await loadSelected();note('本地记录已更新；稳定入口和工作任务未改变。');
 }catch(err){if(epoch===actionEpoch)$('accountActionError').textContent=err.message;}finally{controls();}};
$('newAccount').onclick=()=>openEditor();$('editAccount').onclick=()=>openEditor(selected);$('archiveAccount').onclick=()=>openAction(dash.get(selected)?.account.archived?'restore':'archive');$('reconfirmSource').onclick=()=>openAction('reconfirm_source');$('openBinding').onclick=openBind;
$('closeAccountEditor').onclick=()=>{editEpoch++;editing=null;$('accountEditor').close();};$('closeSessionBinding').onclick=()=>{bindEpoch++;bindState=null;$('sessionBinding').close();};$('closeAccountAction').onclick=()=>{actionEpoch++;actionState=null;$('accountAction').close();};
$('accountEditor').addEventListener('cancel',()=>{editEpoch++;editing=null;});$('sessionBinding').addEventListener('cancel',()=>{bindEpoch++;bindState=null;});$('accountAction').addEventListener('cancel',()=>{actionEpoch++;actionState=null;});
$('bindingProject').onchange=()=>{ $('bindingExact').value='';loadBindSessions();};$('bindingNativeSession').onchange=()=>{$('bindingConsent').checked=false;};$('lookupBinding').onclick=()=>loadBindSessions($('bindingExact').value.trim());
$('accountSearch').oninput=drawCards;$('showArchived').onchange=drawCards;$('refreshAccounts').onclick=()=>refresh();
$('pauseAccounts').onclick=()=>{paused=!paused;listEpoch++;clearTimeout(timer);gate.select(selected+'|'+binding);$('pauseAccounts').textContent=paused?'恢复观察':'暂停观察';drawCards();note(paused?'只暂停本页观察；入口、Job、网页回合均不受影响。':'恢复前台只读观察。');if(!paused)refresh();};
for(const [id,retry]of [['reconcileAccount',false],['retryAccount',true]])$(id).onclick=async()=>{try{const r=await api.recover(retry);note(r?'原请求已核对，没有生成第二个变更。':'暂未找到回执；请核对后再明确重试同一请求。');await refresh();await loadSelected();}catch(e){note(e.message);}finally{controls();}};
$('exportAccounts').onclick=async()=>{try{const data=await api.read('export'),blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='clw-accounts.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){note(e.message);}};
document.addEventListener('visibilitychange',()=>{if(document.hidden){listEpoch++;clearTimeout(timer);}else if(!paused)refresh();});
try{await api.init();controls();await refresh();}catch(e){note('账户管理未连接：'+e.message);$('accountStoreState').textContent='请重开本产品进程加载新增API；不重启WebCodex或Tunnel。';}
