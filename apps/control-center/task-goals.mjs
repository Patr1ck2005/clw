// Sustained Goal controls extend the canonical task; no timers or model dispatch.
const $=id=>document.getElementById(id);
const el=(tag,text='',cls='')=>{const node=document.createElement(tag);node.textContent=text;if(cls)node.className=cls;return node;};
function button(text,fn){const b=el('button',text,'button secondary');b.type='button';b.onclick=fn;return b;}
function field(holder,name,label,value='',type='textarea'){
  const wrap=el('label',label,'field'),input=el(type==='textarea'?'textarea':'input');input.name=name;input.required=true;input.value=value;
  if(type==='textarea'){input.rows=4;input.maxLength=name==='roles'?90000:6000;}else{input.type=type;input.min='1';input.max=name==='max_cycles'?'100':'20';}
  wrap.append(input);holder.append(wrap);return input;
}
function check(holder,name,text,required=true){const wrap=el('label','','check-row'),input=el('input');input.type='checkbox';input.name=name;input.required=required;wrap.append(input,el('span',text));holder.append(wrap);}

export function createGoalUI({client,getTask,perform,onError}){
  let spec=null;
  function open(action){
    if(client.busy()||client.pending()){onError('先核对原请求，不创建第二条计划动作。');return;}
    const task=getTask();if(!task?.collaboration?.enabled){onError('先启用当前任务的结构化协作。');return;}
    spec={action,task};const g=task.goal,holder=$('goalFields');holder.replaceChildren();$('goalError').textContent='';$('saveGoal').disabled=false;
    $('goalHeading').textContent={'goal.enable':'启用持续目标','goal.checkpoint':'保存目标恢复点','goal.review_cycle':'审阅当前工作轮次','goal.next_cycle':'安排下一轮计划','goal.extend_budget':'明确调整循环授权','goal.replan':'处理共同变更并重订计划'}[action];
    holder.append(el('p',`任务版本 ${task.version}${g?' · 当前第 '+g.cycle+' 轮':''}。保留原目标和验收条件；此操作不唤醒模型或执行命令。`));
    if(action==='goal.enable'){
      field(holder,'max_cycles','授权的最多计划轮数（不是按时长拆轮）','6','number');field(holder,'failure_limit','连续无进展/失败路线的停止上限','3','number');
      check(holder,'confirm_schema_upgrade','确认持续目标、原授权范围及任务库能力升级到4；旧G4/G1不能绕过新规则使用此库。');
    }else if(action==='goal.checkpoint'){
      field(holder,'completed','已有可核对进展',g.checkpoint?.completed||'').required=false;
      field(holder,'remaining','尚未完成和真实阻塞',g.checkpoint?.remaining||'');field(holder,'next_step','下一项实际工作',g.checkpoint?.next_step||'');field(holder,'evidence','实际证据引用，每行一项',(g.checkpoint?.evidence||[]).join('\n'));
    }else if(action==='goal.review_cycle'){
      const label=el('label','本轮结果','field'),select=el('select');select.name='outcome';
      for(const [value,text]of [['progress','有实际进展'],['inconclusive','尚无结论，保留有效信息'],['failed_route','路线失败，保留可复核证据']]){const o=el('option',text);o.value=value;select.append(o);}label.append(select);holder.append(label);
      holder.append(el('p','所有角色须已停写、交付并经独立审阅；未结原Job或资源占用不能跳过。轮次结论不是原目标最终验收。'));
      field(holder,'note','路线判断与下一步理由');field(holder,'evidence','实际证据引用，每行一项');
    }else if(action==='goal.replan'){
      field(holder,'roles','原授权范围内的新职责计划 JSON',JSON.stringify(task.contract.roles,null,2));field(holder,'reason','共同变更如何进入新计划');field(holder,'evidence','原执行结束与停写证据，每行一项');
      check(holder,'confirm','确认旧轮中断而非完成；原资源/Job和写入责任均已核对结束。只重订计划，不解除暂停、不清零失败记录。');
    }else if(action==='goal.next_cycle'){
      holder.append(el('p','引用当前轮次审阅：'+(g.review?.id||'尚无有效审阅'),'mono'));
      field(holder,'roles','下一轮角色计划 JSON（仅原授权范围；可调整目标、依赖和缩小写域）',JSON.stringify(task.contract.roles,null,2));
      check(holder,'resolve_shared_change','已明确处理共同意见；原文字保留，当前暂停不会因此解除。',!!task.collaboration.shared_change_pending);
    }else{
      field(holder,'max_cycles','新的计划轮数上限',String(g.max_cycles),'number');field(holder,'failure_limit','新的连续无进展上限',String(g.failure_limit),'number');field(holder,'reason','这次明确增加授权的依据');
      check(holder,'confirm','确认提高当前目标的授权上限，不清零失败记录，不扩大工程权限或更换模型。');
    }
    $('goalDialog').showModal();
  }
  function data(s){
    const holder=$('goalFields'),value=n=>holder.querySelector(`[name="${n}"]`).value,yes=n=>holder.querySelector(`[name="${n}"]`).checked;
    if(s.action==='goal.enable')return {confirm_schema_upgrade:yes('confirm_schema_upgrade'),max_cycles:Number(value('max_cycles')),failure_limit:Number(value('failure_limit'))};
    const common={expected_cycle:s.task.goal.cycle};
    if(s.action==='goal.checkpoint')return {...common,completed:value('completed'),remaining:value('remaining'),next_step:value('next_step'),evidence:value('evidence').split('\n').map(x=>x.trim()).filter(Boolean)};
    if(s.action==='goal.review_cycle')return {...common,outcome:value('outcome'),note:value('note'),evidence:value('evidence').split('\n').map(x=>x.trim()).filter(Boolean)};
    if(s.action==='goal.replan')return {...common,roles:JSON.parse(value('roles')),confirm:yes('confirm'),reason:value('reason'),evidence:value('evidence').split('\n').map(x=>x.trim()).filter(Boolean)};
    if(s.action==='goal.next_cycle')return {...common,review_id:s.task.goal.review?.id,roles:JSON.parse(value('roles')),resolve_shared_change:yes('resolve_shared_change')};
    return {...common,max_cycles:Number(value('max_cycles')),failure_limit:Number(value('failure_limit')),confirm:yes('confirm'),reason:value('reason')};
  }
  function render(holder,task){
    if(!task.collaboration?.enabled)return;
    const box=el('section','','task-role');box.id='goalPanel';box.append(el('h3','持续目标与工作轮次'));
    const actions=el('div','','task-toolbar'),mutable=['draft','open','paused'].includes(task.status),g=task.goal;
    if(!g){
      box.append(el('p','可把原完整任务持续推进为多轮计划。每轮需实际交付和独立审阅，原目标、权限和验收条件不变。'));
      if(mutable&&Object.values(task.roles).every(s=>s.status==='pending'&&s.attempt===0))actions.append(button('启用持续目标',()=>open('goal.enable')));
    }else{
      box.append(el('p',`第 ${g.cycle} 轮 / 授权最多 ${g.max_cycles} 轮 · 连续无进展 ${g.review?.consecutive_failures??g.consecutive_failures} / ${g.failure_limit}`),el('p','原目标 SHA256：'+g.intent_hash,'mono'));
      if(task.goal_state?.limit_reason)box.append(el('p','已达循环或连续无进展上限：保留证据，先明确调整授权，不能自动开新工作。','task-warning'));
      if(mutable){
        actions.append(button('保存目标恢复点',()=>open('goal.checkpoint')),button('审阅工作轮次',()=>open('goal.review_cycle')));
        if(task.goal_state?.cycle_review_current&&!task.goal_state.limit_reason)actions.append(button('安排下一轮计划',()=>open('goal.next_cycle')));
        if(task.collaboration.shared_change_pending)actions.append(button('处理共同变更',()=>open('goal.replan')));
        actions.append(button('调整循环授权',()=>open('goal.extend_budget')));
      }
      for(const [label,value]of [['目标恢复点',g.checkpoint],['本轮决策（非最终验收）',g.review],['上一轮交付与决策',g.last_cycle]])if(value){const d=el('details');d.append(el('summary',label),el('pre',JSON.stringify(value,null,2)));box.append(d);}
      box.append(el('small','当前任务仍是唯一完成状态；下一轮不继承旧会话绑定、不自动开工。历史证据在原任务事件中。'));
    }
    box.append(actions);holder.append(box);
  }
  $('closeGoal').onclick=()=>{spec=null;$('goalDialog').close();};$('goalDialog').addEventListener('cancel',()=>{spec=null;});
  $('goalForm').onsubmit=async event=>{
    event.preventDefault();const own=spec;if(!own)return;$('saveGoal').disabled=true;
    try{await perform(own.action,data(own),own.task);if(spec===own){spec=null;$('goalDialog').close();}}
    catch(error){if(spec===own)$('goalError').textContent=error.message+' 原草稿保留；不自动套用新任务版本或重复发送。';}
    finally{if(spec===own)$('saveGoal').disabled=false;}
  };
  return {render,active:()=>$('goalDialog').open};
}
