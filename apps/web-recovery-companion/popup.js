'use strict';
document.getElementById('openNew').onclick=()=>show(async()=>{const r=await chrome.runtime.sendMessage({type:'open-new-page',confirm:true});if(!r?.ok)throw Error(r?.error||'打开结果未知，不自动重试');return '只打开新页；尚未创建模型对话，请粘贴一次接入邀请。';});
document.getElementById('managedJoin').onclick=()=>show(async()=>{const t=await active();if(!confirm('将这个已绑定页面移入CLW专用窗口？离开该窗口后才自动轮换已加入的页面；不自动发送新研究任务。'))return '未加入';const r=await chrome.runtime.sendMessage({type:'managed-join',tabId:t.id,chatUrl:t.url,confirm:true});if(!r?.ok)throw Error(r?.error||'窗口状态未确认');return '已加入托管窗口：'+r.value.tab_count+' 页。不要最小化；聚焦或编辑时不会自动切页。';});
document.getElementById('managedStop').onclick=()=>show(async()=>{const r=await chrome.runtime.sendMessage({type:'managed-stop',confirm:true});if(!r?.ok)throw Error(r?.error||'未确认');return '已停止轮换；没有关闭页面或中断模型。';});
const status=document.getElementById('status'),choices=document.getElementById('choices');
let monitorView=true,popupBusy=0,refreshing=false;
const monitorLabels={watching:'监护中',waiting:'等待',backoff:'等待短接续',planned:'等待短接续',dispatching:'发送待核对',clicked:'已点击发送，待网页确认',unknown:'发送待核对，不重复发送',paused:'监护已暂停',stopped:'监护已停止',disabled:'监护已停止',unbound:'尚未启用',not_bound:'尚未启用',not_started:'尚未启用',idle:'等待明确故障',generating:'网页仍在思考／工作',cannot_think:'网页思考失败',generation_failed:'网页生成失败',connection_lost:'网页连接中断',offline:'等待网络恢复',draft:'等待你的输入结束',blocked:'登录、额度或权限需处理',unsupported:'网页控件暂未识别',exhausted:'连续三次接续已用尽',retry_limit:'连续三次接续已用尽',manual_takeover:'已让给你的手动操作',delivery_pending:'等待原发送在网页中确认'};
Object.assign(monitorLabels,{attached_waiting_baseline:'正在核对原回合',initial_snapshot_observed:'已核对当前回合',existing_failure_observed:'启用前已有此错误；保留观察，不补发历史消息',watching_for_explicit_failure:'等待明确故障',failure_backoff:'等待短接续',retry_due:'接续时间已到',focused:'输入框正在使用',composing:'输入法正在编辑',controls_unknown:'等待网页控件就绪',user_stopped:'已让给你的停止操作',manual_gesture:'已让给你的手动操作',dispatch_committed:'接续发送待核对',click_reported_delivery_unconfirmed:'等待原页出现接续消息',delivery_unknown:'发送结果未知，请核对原页；不会重复发送',continuation_delivered:'原页已确认接续消息，不等于模型已恢复',not_sent:'本次未发送，保留原页',failure_already_granted:'此错误已有发送记录，不再发送',retry_limit_reached:'连续三次接续已用尽，请处理原页',explicit_stop:'你已停止监护',tab_removed:'原标签页已关闭',waiting_delivery_confirmation:'等待原发送在网页中确认',storage_uncertain_explicit_start_required:'本地记录保存未确认，请核对后重新启用',monitor_not_started:'尚未启用'});
Object.assign(monitorLabels,{idle:'当前未识别到生成或终止错误',connection_wait:'连接中断，网页仍在等待答复',connection_wait_long:'连接等待已持续较久；仍在核对公开进展',reload_requested:'正在刷新同一原页面',reload_unknown:'原刷新回执待核对，不重复刷新',reload_failed:'原刷新失败，需要处理',reload_not_confirmed:'新页面尚未确认，需要处理',reload_limit_reached:'本轮两次连接刷新已用尽，需要处理'});
function monitorSummary(s){
  const name=x=>monitorLabels[x]||x||'';
  const stale=s.bound&&(s.observer_recent===false||!s.updated_at||Date.now()-s.updated_at>45000);
  return [stale?'页面观察已过期':name(s.state),s.reason&&name(s.reason),s.kind&&'网页：'+name(s.kind),Number.isInteger(s.attempts)&&'接续：'+s.attempts+' / 3',
    s.connection_wait_ms>0&&'连接等待：'+Math.floor(s.connection_wait_ms/1000)+' 秒',Number.isInteger(s.reload_count)&&'本轮刷新：'+s.reload_count+' / 2',
    s.next_retry_at&&'计划接续：'+new Date(s.next_retry_at).toLocaleTimeString(),s.updated_at&&'最近观察：'+new Date(s.updated_at).toLocaleTimeString(),stale&&'尚未确认观察仍在更新；请核对原页是否休眠／刷新。'].filter(Boolean).join('\n');
}
async function monitorCall(type,t,extra={}){
  const r=await chrome.runtime.sendMessage({type,tabId:t.id,chatUrl:t.url,...extra});
  if(!r?.ok)throw Error(r?.error||'监护状态尚未确认');return r.value;
}
document.getElementById('monitorStart').onclick=()=>show(async()=>{
  const t=await active(),s=await monitorCall('monitor-start',t,{confirm:true});
  await chrome.scripting.executeScript({target:{tabId:t.id},files:['page-monitor-page.js']});
  await chrome.scripting.executeScript({target:{tabId:t.id},func:async generation=>{
    globalThis.__clwControlStop?.();globalThis.__clwRecoveryStop?.();
    await globalThis.CLWPageMonitorPage.start(generation);
  },args:[s.generation]});
  return monitorSummary(await monitorCall('monitor-status',t));
},true);
document.getElementById('monitorStatus').onclick=()=>show(async()=>monitorSummary(await monitorCall('monitor-status',await active())),true);
document.getElementById('monitorStop').onclick=()=>show(async()=>{
  const t=await active();let localError=null;
  // Human Stop takes effect on the page before waiting on durable storage.
  // Still attempt the backend stop when injection fails, and report either fault.
  try{await chrome.scripting.executeScript({target:{tabId:t.id},func:()=>globalThis.__clwPageMonitorStop?.()});}catch(e){localError=e;}
  const s=await monitorCall('monitor-stop',t);
  if(localError)throw Error('后台已停止；原页观察器停止未确认：'+localError.message);
  return monitorSummary(s)+'\n网页当前回合和本地 Job 继续运行。';
},true);
async function active(){const [t]=await chrome.tabs.query({active:true,currentWindow:true});if(!t||!CLWControlPolicy.isChat(t.url))throw Error('请打开确切的已有ChatGPT对话，而不是新建页。');return t;}
async function prepare(t,reset=false){
  if(reset)await chrome.scripting.executeScript({target:{tabId:t.id},func:()=>{globalThis.__clwControlStop?.();globalThis.__clwRecoveryStop?.();globalThis.__clwControlPageCleanup?.();delete globalThis.CLWControlPage;}});
  await chrome.scripting.executeScript({target:{tabId:t.id},files:['control-policy.js','control-page.js']});
}
async function inspect(t){await prepare(t);const r=await chrome.scripting.executeScript({target:{tabId:t.id},func:()=>globalThis.CLWControlPage.inspect()});return r[0]?.result;}
async function enrollment(t){await chrome.scripting.executeScript({target:{tabId:t.id},files:['enrollment-page.js']});const r=await chrome.scripting.executeScript({target:{tabId:t.id},func:()=>globalThis.CLWEnrollmentReceipt()});const v=r[0]?.result||null;return typeof v==='string'?{marker:v}:v;}
async function start(t){await chrome.scripting.executeScript({target:{tabId:t.id},files:['control-content.js']});}
async function show(fn,monitor=false){monitorView=monitor;popupBusy++;try{status.textContent=await fn();}catch(e){status.textContent=String(e.message||e);}finally{popupBusy--;}}
async function refreshMonitor(){
 if(!monitorView||popupBusy||refreshing)return;refreshing=true;
 try{
  const t=await active(),s=await monitorCall('monitor-status',t);
  const control=await chrome.runtime.sendMessage({type:'local-control-status'});
  if(monitorView&&!popupBusy)status.textContent=monitorSummary(s)+(control?.ok?'\n本地 Codex：'+(control.value.connected?'已连接':'等待本机连接／配对'):'');
 }catch(e){if(monitorView&&!popupBusy)status.textContent='监护状态读取失败，未确认观察仍在更新。\n'+String(e.message||e);}
 finally{refreshing=false;}
}
setInterval(()=>{void refreshMonitor();},2000);void refreshMonitor();
function summary(p){return JSON.stringify({model:p?.model_label||'(当前UI未直接暴露)',effort:p?.effort_label||'(当前UI未直接暴露)',controls_known:p?.controls_known,editor_known:p?.editor_known,user_known:p?.user_known,mode_control_known:p?.mode_control_known,pro_visible:p?.model_pro_visible,disallowed_effort_visible:p?.effort_disallowed_visible,visible:p?.visible,generating:p?.generating,draft:p?.draft},null,2);}
async function bindSelection(t,page,pending,discoveryId){
  const r=await chrome.runtime.sendMessage({type:'control-select',tabId:t.id,chatUrl:t.url,page,discoveryId,nonce:pending.nonce,confirm:true});
  if(!r?.ok)throw Error(r?.error||'接管未确认');await prepare(t,true);await start(t);
  return '已绑定：'+r.value.title+(r.value.adopted_request_id?'；已自动接续当前原请求。':'；等待该CLW对话的新请求。');
}
document.getElementById('inspect').onclick=()=>show(async()=>{const t=await active(),p=await inspect(t);return summary(p);});
document.getElementById('enable').onclick=()=>show(async()=>{
  choices.replaceChildren();const t=await active(),page=await inspect(t);
  if(!page?.controls_known)throw Error('当前ChatGPT页面控件未识别；请点“查看当前页识别状态”查看是哪一项，未发送。');
  if(!CLWControlPolicy.confirmable(page))throw Error('当前页检测到Pro/不允许档位/阻断状态，未发送。');
  // The explicit enable click confirms the user's current low-cost Sol policy when
  // the latest ChatGPT UI hides exact model/effort text behind its Radix menu.
  const receipt=await enrollment(t);
  const proof=receipt?.marker?{enrollment:receipt.marker}:receipt?.ticket?{enrollment_ticket:receipt.ticket}:{};
  const r=await chrome.runtime.sendMessage({type:'control-enable',tabId:t.id,chatUrl:t.url,page,confirm:true,...proof});
  if(!r?.ok)throw Error(r?.error||'接管未确认');
  if(r.value.wrong_page){
    const here=(r.value.current_titles||[]).join(' / ')||'当前已登记CLW对话';
    const pending=(r.value.pending_titles||[]).join(' / ')||'其他待处理CLW对话';
    return '当前页是：'+here+'；这里没有当前请求。待处理：'+pending+'。已知页面身份不会自动更换。若待处理分支没有真实页面，请在CLW生成一次接入邀请。';
  }
  if(r.value.enrollment_required)return '这个分支只有逻辑登记，还没有确认真实对话。请在 CLW“持续运行与对话”生成接入邀请，在实际对话接受一次；不要寻找系统从未创建的页面。';
  if(r.value.needs_selection){
    for(const c of r.value.candidates){const b=document.createElement('button');b.textContent='绑定：'+c.title;b.onclick=()=>show(()=>bindSelection(t,page,r.value,c.discovery_id));choices.append(b);}
    return '当前页需要一次人类标题确认；若有多个候选同样只按标题选择，内部target不会显示。';
  }
  await prepare(t,true);await start(t);
  return '已绑定：'+r.value.title+(r.value.adopted_request_id?'；已自动接续当前原请求。':'；等待该CLW对话的新请求。');
});
document.getElementById('resume').onclick=()=>show(async()=>{
 const t=await active(),page=await inspect(t),receipt=await enrollment(t),proof=receipt?.marker?{enrollment:receipt.marker}:receipt?.ticket?{enrollment_ticket:receipt.ticket}:{};
 const r=await chrome.runtime.sendMessage({type:'control-resume',tabId:t.id,chatUrl:t.url,page,confirm:true,...proof});
 if(!r?.ok)throw Error(r?.error||'恢复失败');
 if(r.value.wrong_page||r.value.enrollment_required||r.value.needs_selection||r.value.paired!==true)throw Error('当前页没有已确认可恢复的原绑定；先查看接入状态，不启动观察或重新发送。');
 await prepare(t,true);await start(t);return '已恢复当前页观察；旧dispatch/unknown不会重发。';
});
document.getElementById('stop').onclick=()=>show(async()=>{const t=await active();await chrome.scripting.executeScript({target:{tabId:t.id},func:()=>{globalThis.__clwControlStop?.();globalThis.__clwRecoveryStop?.();}});const r=await chrome.runtime.sendMessage({type:'control-disable',tabId:t.id,chatUrl:t.url});if(!r?.ok)throw Error(r?.error||'停用状态未知');return '当前页CLW接管已停用；没有声称中断已开始的模型执行。';});
