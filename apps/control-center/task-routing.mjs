// Explicit route policy and retained notice outcomes. No browser-side automatic sends.
const $=id=>document.getElementById(id);
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
function button(text,fn){const n=el('button',text,'button secondary');n.type='button';n.onclick=fn;return n;}
function field(holder,name,label,value='',type='text'){
  const wrap=el('label',label,'field'),input=el(type==='textarea'?'textarea':'input');input.name=name;input.required=true;input.value=value;
  if(type==='textarea'){input.rows=3;input.maxLength=4000;}else{input.type=type;input.maxLength=200;if(type==='number'){input.min='0';input.max=name==='failure_limit'?'10':'9007199254740991';}}
  wrap.append(input);holder.append(wrap);return input;
}
function confirm(holder,text){const wrap=el('label','','check-row'),input=el('input');input.type='checkbox';input.name='confirm';input.required=true;wrap.append(input,el('span',text));holder.append(wrap);}
const labels={blocked_before_dispatch:'发送前核对未通过 · 尚未投递',pending:'已保存 · 待发送',dispatching:'已记录发送意图 · 原请求进行中',delivery_unknown:'发送结果未知 · 不自动重发',posted:'原生消息已保存 · 尚非新回合证明',consumed:'原生收件已消费 · 尚非任务完成',cancelled:'发送前取消'};

export function createRoutingUI({client,getTask,perform,onError}){
  let spec=null;
  function open(action,notice=null){
    if(client.busy()||client.pending()){onError('先核对上一条原请求；不能并行创建替代操作。');return;}
    const task=getTask();spec={action,task,notice};const holder=$('routingFields');holder.replaceChildren();$('routingError').textContent='';$('saveRouting').disabled=false;
    $('routingHeading').textContent={'routing.bind':'绑定原生收件目标','routing.enable':'明确启用任务通知','routing.disable':'停止新通知投递','routing.retry_same':'核对后重试原通知','routing.discard_pending':'取消尚未发送的通知'}[action];
    holder.append(el('p',`任务数据版本 ${task.version}。这里只管理消息投递；不能替代项目权限、当前任务暂停或真实宿主验收。`));
    if(action==='routing.bind'){
      const wrap=el('label','本任务收件职责','field'),select=el('select');select.name='target';
      for(const [value,text]of [['coordinator','主控'],...task.contract.roles.map(r=>['role:'+r.id,r.id+' · '+r.name])]){const o=el('option',text);o.value=value;select.append(o);}wrap.append(select);holder.append(wrap);
      field(holder,'agent_id','已经在原生通信中创建的确切 Agent ID');field(holder,'conversation_id','确切 Conversation ID');field(holder,'controller_generation','当前控制代次','0','number');
      holder.append(el('p','服务会实际核对固定上游提交、Agent参与关系及代次。账号标签不是认证，创建卡片或绑定Agent也不等于模型正在工作。'));
    }else if(action==='routing.enable'){
      field(holder,'failure_limit','连续失败停发上限（1–10）',String(task.routing?.failure_limit||3),'number');
      confirm(holder,'确认仅向本任务已绑定目标投递。理解宿主载体可能请求新回合；不会切账号/模型。此确认恢复失败计数，但不自动重试未知通知。');
      holder.append(el('p','本机进程还须通过 --enable-workflow-routing 交互启用。原只读连接和启动工作台不会隐式授权投递。'));
    }else{
      if(notice)holder.append(el('p','原通知：'+notice.id+' / '+labels[notice.phase],'mono'));
      field(holder,'reason','明确操作依据 / 原消息核对结果','','textarea');
      if(action!=='routing.disable')confirm(holder,action==='routing.retry_same'?'确认使用原封包、原收件目标及同一原生幂等键；不创建新的替代消息。':'确认通知从未进入发送，取消不代表已撤销其他原消息。');
    }
    $('routingDialog').showModal();
  }
  function payload(s){
    const get=n=>$('routingFields').querySelector(`[name="${n}"]`);
    if(s.action==='routing.bind')return {target:get('target').value,agent_id:get('agent_id').value,conversation_id:get('conversation_id').value,controller_generation:Number(get('controller_generation').value)};
    if(s.action==='routing.enable')return {confirm:get('confirm').checked,failure_limit:Number(get('failure_limit').value)};
    if(s.action==='routing.disable')return {reason:get('reason').value};
    return {notice_id:s.notice.id,confirm:get('confirm').checked,reason:get('reason').value};
  }
  function render(holder,task){
    if(!task.collaboration?.enabled)return;
    const panel=el('details','','task-role');panel.id='routingPanel';panel.append(el('summary','原生通知与宿主接续 · '+(task.routing?.enabled?'已明确授权任务投递':'尚未启用任务投递')));
    panel.append(el('p','原生消息回执、宿主新回合和任务实际进展分别记录；消费消息不自动验收。用户暂停、未发送草稿和原Job核对仍优先。'));
    const actions=el('div','','task-toolbar'),mutable=['draft','open','paused'].includes(task.status),routing=task.routing;
    if(mutable){actions.append(button('绑定原生收件目标',()=>open('routing.bind')),button(routing?.enabled?'重新确认投递授权':'启用任务通知',()=>open('routing.enable')));if(routing?.enabled)actions.append(button('停止新通知',()=>open('routing.disable')));}
    panel.append(actions);
    if(routing){
      if(routing.failures>=routing.failure_limit)panel.append(el('p','连续失败已达上限，程序已停发。先核对原请求，再明确恢复；不自动切账号或模型。','task-warning'));
      if(routing.queue_full)panel.append(el('p','近期未决通知达到上限；保留原记录，不丢弃未知消息。','task-warning'));
      for(const [key,route]of Object.entries(routing.routes)){const row=el('p',`${key} → ${route.agent_id}\nConversation ${route.conversation_id} · 代次 ${route.controller_generation}\n来源：实际原生参与关系观察；本次观测宿主可用 ${route.native_host_available?'是':'否/尚未挂载'}，不是自动恢复验收。`,'mono');row.dataset.routingTarget=key;panel.append(row);}
      for(const notice of routing.outbox){const row=el('article','','task-event');row.dataset.noticeId=notice.id;row.append(el('b',notice.target+' · '+labels[notice.phase]),el('p',notice.id,'mono'));
        if(notice.native_receipt)row.append(el('p','原消息 '+notice.native_receipt.message_id+' / Delivery '+notice.native_receipt.delivery_id,'mono'));
        if(notice.error)row.append(el('p','待核对：'+notice.error));
        if(mutable&&['delivery_unknown','blocked_before_dispatch'].includes(notice.phase))row.append(button('重试同一原通知',()=>open('routing.retry_same',notice)));
        if(mutable&&notice.phase==='pending'&&!notice.ever_dispatched)row.append(button('取消未发送通知',()=>open('routing.discard_pending',notice)));
        panel.append(row);
      }
    }
    holder.append(panel);
  }
  $('closeRouting').onclick=()=>{spec=null;$('routingDialog').close();};$('routingDialog').addEventListener('cancel',()=>{spec=null;});
  $('routingForm').onsubmit=async event=>{event.preventDefault();const own=spec;if(!own)return;$('saveRouting').disabled=true;
    try{await perform(own.action,payload(own),own.task);if(spec===own){spec=null;$('routingDialog').close();}}
    catch(error){if(spec===own)$('routingError').textContent=error.message+' 原输入保留；没有自动重发或替换原消息。';}
    finally{if(spec===own)$('saveRouting').disabled=false;}
  };
  return {render,active:()=>$('routingDialog').open};
}
