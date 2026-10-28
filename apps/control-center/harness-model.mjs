// Pure public event projection. No HTML interpretation or provider-side state inference.
export const isWebProvider=provider=>['native_web','chatgpt_web_host'].includes(provider);
export function projectEvents(events){
 const out=[],byItem=new Map();
 for(const e of events){
  const d=e.data||{};
  if(['user_message','user_steering','host_user_note'].includes(e.kind))out.push({id:'u'+e.seq,role:'user',text:d.text||'',steering:e.kind!=='user_message'});
  else if(e.kind==='assistant_delta'||e.kind==='assistant_message'){
   const id=String(d.item_id||('event-'+e.seq));let m=byItem.get(id);
   if(!m){m={id,role:'assistant',text:'',provider:d.provider||'codex'};byItem.set(id,m);out.push(m);}
   m.text=e.kind==='assistant_message'?String(d.text||''):m.text+String(d.text||'');
  }else if(e.kind==='tool')out.push({id:'t'+e.seq,role:'tool',text:d.command||d.type||'原生工具',detail:d.output||JSON.stringify(d.changes||[],null,2),status:d.status});
  else if(e.kind==='turn_completed')out.push({id:'s'+e.seq,role:'system',text:d.status==='completed'?'本轮已完成':d.status==='interrupted'?'原生运行时已确认中断':'本轮未成功完成：'+(d.status||'未知')});
  else if(e.kind==='host_delegated_input')out.push({id:'b'+e.seq,role:'system',text:'父对话委派：\n'+(d.text||'')});
   else if(e.kind==='host_delegated')out.push({id:'b'+e.seq,role:'system',text:'任务已交给已连接的独立分支；尚不代表模型开始工作。'});
   else if(e.kind==='host_waiting_children')out.push({id:'b'+e.seq,role:'system',text:'等待 '+d.pending+' 个分支返回；保留原请求和已有成果。'});
   else if(e.kind==='host_parent_resumed')out.push({id:'b'+e.seq,role:'system',text:'已恢复原主任务；分支结果不会自动当作验收通过。'});
   else if(e.kind==='host_child_result')out.push({id:'b'+e.seq,role:'system',text:'分支已返回：'+d.status+'。主任务仍需整合。'});
   else if(e.kind==='host_cancel_requested')out.push({id:'b'+e.seq,role:'system',text:'收到父任务的取消要求；尚未确认已运行工具停止。'});
   else if(e.kind==='host_bound')out.push({id:'h'+e.seq,role:'system',text:'已配对当前 Web 工作会话，使用获准的本机项目工具。不是原生聊天历史镜像。'});
  else if(e.kind==='host_queued')out.push({id:'h'+e.seq,role:'system',text:'要求已保存，等待 ChatGPT Web 接收；尚未执行。'});
  else if(e.kind==='host_claimed')out.push({id:'h'+e.seq,role:'system',text:'配对的 Web 工作会话已领取要求。'});
  else if(e.kind==='host_result')out.push({id:'h'+e.seq,role:'system',text:d.status==='completed'?'Web 已返回本次结果；验收依据见回复和产物。':'Web 返回状态：'+d.status});
  else if(e.kind==='host_paused')out.push({id:'h'+e.seq,role:'system',text:d.enabled?'已恢复接收新要求。':'已暂停接收；正在运行的工具未被假定停止。'});
  else if(e.kind==='recovery_scheduled')out.push({id:'r'+e.seq,role:'system',text:'检测到明确生成错误：'+d.reason+'；'+d.delay_seconds+'秒后尝试恢复原请求（'+d.ordinal+'/3）。'});
  else if(e.kind==='recovery_dispatch')out.push({id:'r'+e.seq,role:'system',text:'已开始发送原请求的恢复提示；尚未确认 Web 模型恢复。'});
  else if(e.kind==='recovery_acknowledged')out.push({id:'r'+e.seq,role:'system',text:'Web 接收端已确认恢复原请求；没有重新派发任务。'});
  else if(e.kind==='recovery_blocked'||e.kind==='recovery_disabled')out.push({id:'r'+e.seq,role:'system',text:'自动恢复已暂停：'+(d.reason||'用户停用')+'。原执行未被强制停止。'});
  else if(e.kind==='web_bound')out.push({id:'w'+e.seq,role:'system',text:'已绑定真实 ChatGPT Web 对话；这里显示正式通信回复，不镜像全部原网页历史。'});
  else if(e.kind==='web_delivery')out.push({id:'w'+e.seq,role:'system',text:'消息已写入原生收件箱，等待 Web 接收并返回结果；投递不代表工作完成。'});
  else if(e.kind==='web_result')out.push({id:'w'+e.seq,role:'system',text:d.status==='completed'?'ChatGPT Web 已返回本次结果（不是独立验收结论）':'ChatGPT Web 报告本次请求受阻'});
  else if(e.kind==='operation_error'||e.kind==='connection_lost')out.push({id:'s'+e.seq,role:'system',text:'需要核对原执行：'+(d.code||'连接变化')});
  else if(e.kind==='thread_created'&&d.inherited_history)out.push({id:'s'+e.seq,role:'system',text:'已创建原生历史分叉。它保留父会话上下文；这里展示分叉后的新增工作。'});
  else if(e.kind==='native_sync')out.push({id:'s'+e.seq,role:'system',text:'已核对原生线程；最后状态：'+(d.last_turn_status||'尚未开始')+'。未知发送没有重放。'});
 }
 return out;
}
export function mergeEvents(previous,incoming){
 const seen=new Set(previous.map(x=>x.seq)),added=[];for(const x of incoming){if(Number.isSafeInteger(x.seq)&&x.seq>0&&!seen.has(x.seq)){seen.add(x.seq);added.push(x);}}return [...previous,...added].sort((a,b)=>a.seq-b.seq);
}
export function canSend(thread,pending){return !!thread&&!pending&&!['working','stopping','unknown','web_waiting','web_processing','waiting','processing','waiting_children','host_paused'].includes(thread.status);}
export function composerAction(thread,pending){
 if(!thread||pending)return null;
 if(thread.provider==='chatgpt_web_host'&&['waiting','processing','waiting_children'].includes(thread.status))return typeof thread.active_turn==='string'&&thread.active_turn.length>0?'message.append':null;
  if(isWebProvider(thread.provider))return canSend(thread,pending)?'message.send':null;
 if(thread.status==='working')return typeof thread.active_turn==='string'&&thread.active_turn.length>0?'message.steer':null;
 return canSend(thread,pending)?'message.send':null;
}
export function canClearSubmittedDraft(current,submitted){return typeof current==='string'&&typeof submitted==='string'&&current===submitted;}
export function draftKey(store,thread){return 'clw.harness.draft.'+store+'.'+thread;}
export function statusLabel(state){return ({idle:'就绪',working:'正在工作',stopping:'等待停止确认',interrupted:'已中断',unknown:'待核对',error:'本轮失败',waiting:'等待 Web 接收',processing:'Web 正在处理',waiting_children:'等待分支返回',host_paused:'已暂停接收',web_waiting:'等待 Web 回复',web_processing:'Web 已回报进展'})[state]||state;}
