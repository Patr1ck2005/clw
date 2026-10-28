// Shared-resource UI uses canonical metadata commands, never a process launcher.
const $=id=>document.getElementById(id);
const el=(tag,text='',cls='')=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;};
const phases={queued:'等待整组资源',reserved:'窗口已保留 · 尚未执行',starting:'执行意图已登记 · 待核对原执行',running:'已关联原执行',unknown:'执行结果未知 · 保留占用',released:'原执行已核对结束',cancelled:'明确未执行 / 已取消'};
function button(text,fn){const b=el('button',text,'button secondary');b.type='button';b.onclick=fn;return b;}
function field(holder,name,label,value='',type='text'){
  const wrap=el('label',label,'field'),input=el(type==='textarea'?'textarea':'input');input.name=name;
  if(type!=='textarea')input.type=type;input.value=value;input.required=true;
  if(type==='textarea'){input.rows=4;input.maxLength=50000;}else if(type==='text')input.maxLength=2000;
  wrap.append(input);holder.append(wrap);return input;
}
function check(holder,name,label,required=true){const wrap=el('label','','check-row'),input=el('input');input.name=name;input.type='checkbox';input.required=required;wrap.append(input,el('span',label));holder.append(wrap);return input;}
function selection(holder,name,label,options){const wrap=el('label',label,'field'),select=el('select');select.name=name;for(const [value,text]of options){const o=el('option',text);o.value=value;select.append(o);}wrap.append(select);holder.append(wrap);return select;}

export function createResourceUI({client,getTask,perform,onError}){
  let rows=[],epoch=0,spec=null;
  const active=()=>$('resourceDialog').open;
  async function refresh(){
    const token=++epoch;
    try{
      const response=await client.read('resources');if(token!==epoch)return;
      rows=response.resources;const holder=$('resourceRows');holder.replaceChildren();holder.dataset.state='observed';
      for(const resource of rows){
        const card=el('article','','task-role');card.dataset.resourceId=resource.id;
        card.append(el('h3',resource.label),el('p',`${resource.namespace} / ${resource.name}`,'mono'),
          el('p',`登记容量 ${resource.capacity} · 当前占用 ${resource.occupied} · 可分配 ${resource.grantable} · 排队 ${resource.queued}`),
          el('p',resource.observation_current?`有效观测：${resource.observation.availability}；来源为明确登记，不是系统自动认证。`:'来源观测缺失或已过期；不授予新的执行机会。','task-warning'),
          el('p','原权威来源：'+resource.authority_ref));
        for(const h of resource.holders)card.append(el('p',`${h.role_id} · ${phases[h.phase]||h.phase} · ${h.inputs_current?'输入版本当前':'输入版本已失效'}${h.original_job?' · 原执行 '+h.original_job.id:''}`));
        card.append(button('登记实际观测',()=>open('resource.observe','',resource)));
        holder.append(card);
      }
      $('resourceNotice').textContent=rows.length?'普通程序协调整组资源；执行未知不会因时间到期释放。资源登记不能代替原项目权限或guard。':'尚未登记共享资源。选择一个已启用协作的任务后，可明确登记资源；不会启动模型或程序。';
    }catch(e){if(token===epoch){$('resourceRows').dataset.state='unknown';$('resourceNotice').textContent='资源观察不可用，下面保留的是旧记录，不是当前可用性。'+e.message;for(const b of $('resourceRows').querySelectorAll('button'))b.disabled=true;}}
  }
  async function open(action,rid='',resource=null){
    if(client.busy()||client.pending()){onError('先核对原请求，不创建第二个动作。');return;}
    const task=getTask();if(!task?.collaboration?.enabled){onError('先选择已启用结构化协作的任务。');return;}
    spec={action,rid,task,resource};const own=spec;const holder=$('resourceFields');holder.replaceChildren();$('resourceError').textContent='';$('saveResource').hidden=false;$('saveResource').disabled=false;
    $('resourceHeading').textContent={'resource.define':'登记通用共享资源','resource.observe':'登记实际资源观测','resource.request':'申请整组资源','resource.attach':'关联已接纳的原执行','resource.unknown':'标记未知并保留占用','resource.finish':'核对原执行结束','resource.cancel':'取消明确未开始的申请','resource.reconcile_not_started':'核对确实未发生执行',guide:'启动前实际文件核验'}[action];
    holder.append(el('p',`任务版本 ${task.version}；保存是产品协调记录，不会启动、停止、取消任何外部Job。`));
    if(action==='resource.define'){
      field(holder,'namespace','稳定资源作用域（同一实体始终使用相同值）');field(holder,'name','逻辑名称，例如 compiler-window');field(holder,'label','显示名称');field(holder,'capacity','总容量','1','number');field(holder,'authority_ref','原资源 / guard的准确依据');check(holder,'requires_frozen_inputs','执行此资源必须冻结实际输入',false);check(holder,'confirm_schema_upgrade','确认在原任务库启用资源规则（schema 3）；旧G1/G0不支持新规则，不能直接回退。');
    }else if(action==='resource.observe'){
      holder.append(el('p',`${resource.label} · 定义/观测版本 ${resource.version}`));selection(holder,'availability','实际可用性',[['unknown','未知（可用容量必须为0）'],['available','已核对可用'],['blocked','明确阻塞（可用容量必须为0）']]);
      field(holder,'available_capacity','可供本任务库协调的总容量（包含已经保留的份额）','0','number');field(holder,'source_observed_at','实际观测时刻（Unix秒；不自动刷新为当前时间）',String(Math.floor(Date.now()/1000)),'number');field(holder,'valid_for_seconds','有效秒数（1–600；过期不释放原占用）','120','number');field(holder,'evidence','实际核对依据与来源','','textarea');
    }else if(action==='resource.request'){
      await refresh();if(spec!==own)return;
      try{const packet=(await client.read('assignment',{id:task.id,role:rid})).assignment;if(spec!==own)return;spec.packet=packet;spec.task={...task,version:packet.task_version};}catch(e){onError(e.message);return;}
      holder.append(el('p','输入清单只列本次实际使用文件。可用 {role_id,artifacts:[{path,bytes,sha256}]} 引用本角色停写文件，或 {role_id,delivery_id,paths:[...]} 引用已交付角色的子集。'));
      spec.resources=rows.slice();
      for(const r of spec.resources){const input=field(holder,'units_'+r.id,`${r.label}（容量${r.capacity}，0表示不申请）`,'0','number');input.min='0';input.max=String(r.capacity);}
      field(holder,'inputs','冻结输入清单 JSON','[]','textarea');check(holder,'freeze_confirmed','确认相关输入停写；实际开始前仍需执行者重新核验字节',false);field(holder,'guard_evidence','原项目guard / 停写核对依据','','textarea');
    }else{
      const group=task.roles[rid]?.resource_request;if(!group){onError('当前角色没有资源申请。');return;}spec.group=group;
      holder.append(el('p',`${phases[group.phase]}\n${group.id}\n输入快照：${group.input_snapshot_hash}`,'mono'));
      if(action==='guide'){
        $('saveResource').hidden=true;holder.append(el('p','先导出最新职责包。执行者使用 task_resource_worker.py，显式提供获准输入根目录清单，检查文件字节后准备 begin。先核对其原回执，再调用原有执行入口；本页面不代替文件核验，不执行命令。'));
        holder.append(el('pre','prepare-begin --origin <明确产品地址> --store-id <明确任务库ID> --root <本角色根> --packet <当前职责包.json> --allowed-roots <授权输入根.json> --actor <本次署名> --guard-evidence <真实依据> --out <新的原请求封包.json>\n\nsend / receipt 使用同一原封包。输入根清单格式：[{"role_id":"输入角色","root":"明确获准的绝对目录"}]。\n完整原生argv见本角色启动包。'));
      }else if(action==='resource.attach'){
        field(holder,'original_job','原执行身份 JSON',JSON.stringify({executor:'',id:'',project_id:task.contract.roles.find(r=>r.id===rid).project_id,session_id:task.roles[rid].binding?.session_id??null},null,2),'textarea');field(holder,'evidence','实际原执行回执/查询依据','','textarea');
      }else if(action==='resource.finish'){
        holder.append(el('pre',JSON.stringify(group.execution?.original_job??null,null,2)));selection(holder,'terminal_status','已核对的终态',[['completed','完成'],['failed','失败'],['cancelled','原执行确已取消']]);check(holder,'process_stopped','已经核对同一原执行及其进程确实结束；不是仅凭超时/租约。');field(holder,'evidence','终态与停止的真实依据','','textarea');
      }else if(action==='resource.reconcile_not_started'){
        check(holder,'confirmed_no_execution','已从原执行入口核对确实没有接纳或启动任何进程，且没有已知Job。');field(holder,'evidence','原请求和执行入口核对依据','','textarea');
      }else field(holder,'reason',action==='resource.unknown'?'未知原因（继续保留占用）':'取消原因（只能尚未开始）','','textarea');
    }
    if(spec===own)$('resourceDialog').showModal();
  }
  function data(s){
    const f=$('resourceFields'),value=name=>f.querySelector(`[name="${name}"]`).value,yes=name=>f.querySelector(`[name="${name}"]`).checked;
    if(s.action==='resource.define')return {namespace:value('namespace'),name:value('name'),label:value('label'),capacity:Number(value('capacity')),requires_frozen_inputs:yes('requires_frozen_inputs'),authority_ref:value('authority_ref'),confirm_schema_upgrade:yes('confirm_schema_upgrade'),expected_resource_version:null};
    if(s.action==='resource.observe')return {resource_id:s.resource.id,expected_resource_version:s.resource.version,availability:value('availability'),available_capacity:Number(value('available_capacity')),source_observed_at:Number(value('source_observed_at')),valid_for_seconds:Number(value('valid_for_seconds')),evidence:value('evidence')};
    if(s.action==='resource.request')return {role_id:s.rid,assignment_fence:s.packet.assignment_fence,requirements:s.resources.map(r=>({resource_id:r.id,units:Number(value('units_'+r.id))})).filter(r=>r.units!==0),inputs:JSON.parse(value('inputs')),freeze_confirmed:yes('freeze_confirmed'),guard_evidence:value('guard_evidence')};
    const common={role_id:s.rid,resource_request_id:s.group.id,resource_fence:s.group.fence};
    if(s.action==='resource.attach')return {...common,original_job:JSON.parse(value('original_job')),evidence:value('evidence')};
    if(s.action==='resource.finish')return {...common,original_job:s.group.execution.original_job,terminal_status:value('terminal_status'),process_stopped:yes('process_stopped'),evidence:value('evidence')};
    if(s.action==='resource.reconcile_not_started')return {...common,confirmed_no_execution:yes('confirmed_no_execution'),evidence:value('evidence')};
    return {...common,reason:value('reason')};
  }
  function renderRole(card,role,state){
    const group=state.resource_request,actions=el('div','','role-actions');
    if(['running','blocked'].includes(state.status)){
      if(!group||['released','cancelled'].includes(group.phase))actions.append(button('申请整组资源',()=>open('resource.request',role.id)));
      if(group){
        if(group.phase==='reserved')actions.append(button('启动前核验入口',()=>open('guide',role.id)));
        if(['queued','reserved'].includes(group.phase))actions.append(button('取消未开始申请',()=>open('resource.cancel',role.id)));
        if(['reserved','starting','running','unknown'].includes(group.phase))actions.append(button('执行结果未知',()=>open('resource.unknown',role.id)));
        if(['starting','unknown'].includes(group.phase)&&!group.execution){
          if(group.start_intent)actions.append(button('关联原执行',()=>open('resource.attach',role.id)));
          actions.append(button('核对确未启动',()=>open('resource.reconcile_not_started',role.id)));
        }
        if(['running','unknown'].includes(group.phase)&&group.execution)actions.append(button('核对原执行结束',()=>open('resource.finish',role.id)));
      }
    }
    if(group){const box=el('details');box.append(el('summary','资源窗口：'+(phases[group.phase]||group.phase)),el('pre',JSON.stringify(group,null,2)));card.append(box);}
    if(state.resource_input_invalidated)card.append(el('p','本成果的输入版本已失效，需重新开工和执行；旧交付只保留为历史。','task-warning'));
    card.append(actions);
  }
  $('defineResource').onclick=()=>open('resource.define');$('refreshResources').onclick=()=>refresh();
  $('closeResource').onclick=()=>{spec=null;$('resourceDialog').close();};$('resourceDialog').addEventListener('cancel',()=>{spec=null;});
  $('resourceForm').onsubmit=async e=>{
    e.preventDefault();const s=spec;if(!s||s.action==='guide')return;$('saveResource').disabled=true;
    try{await perform(s.action,data(s),s.task);if(spec===s){spec=null;$('resourceDialog').close();}await refresh();}
    catch(err){if(spec===s)$('resourceError').textContent=err.message+' 原输入保留，不自动换版本或重发；先核对最新任务及原回执。';}
    finally{$('saveResource').disabled=false;}
  };
  return {refresh,renderRole,active};
}
