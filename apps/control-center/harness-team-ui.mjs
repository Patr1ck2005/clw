/* Same-origin operator view. Never starts a model or invents a browser binding. */
const el=(tag,text='')=>{const n=document.createElement(tag);n.textContent=text;return n;};
const labels={logical_only:'仅逻辑登记 · 没有已确认的真实网页',receiver_enrolled:'接收对话已登记 · 等待网页绑定',receiver_confirmed:'实际页面与接收端均已确认',unavailable:'已有物理绑定 · 当前载体不可用',revoked:'已撤销'};
export async function renderTeam({box,get,command,selected,info,refresh}){
 const data=await get('team');box.append(el('h3','自动协作'));
 box.append(el('p','M 负责拆分、审阅、返工和总结；CLW 只管理真实对话、原任务、预算、工作区与故障恢复。正常使用不需要 target、Session、claim 或配对码。'));
 for(const c of data.carriers){
  const card=el('section','','team-card');card.append(el('h4',c.title),el('p',labels[c.state]||c.state,'team-state'));
  if(!c.physical_conversation_bound)card.append(el('p',c.recovery_pending?'这是历史逻辑分支，尚未绑定真实页面。正常的新 worker 不会走这条恢复流程。':'添加一个真实 ChatGPT 对话后即可长期复用；CLW 不会假装后台已创建页面。','small'));
  if(selected?.provider==='chatgpt_web_host'){
   const button=el('button',c.state==='logical_only'?'生成接入／恢复邀请':'重新核对接入');
   button.onclick=async()=>{
    button.disabled=true;
    try{
     const rebind=c.state==='logical_only'&&selected.id!==c.thread_id;
     if(!confirm(rebind?'确认修复没有已验证页面的逻辑分支？只有未领取、未发出的原请求可交给新的真实接收 Session；历史不删除。':'为这个对话生成一次接入邀请？不会新建模型或派发研究任务。'))return;
     const result=await command('team.invite',{confirm:true,existing_thread_id:c.thread_id,allow_rebind:rebind,ttl_seconds:3600,reason:'Operator requested real page enrollment'},selected.id);
     showInvitation(card,result);
    }catch(e){card.append(el('p',String(e.message||e)));}finally{button.disabled=false;}
   };card.append(button);
   if(c.state==='logical_only'&&c.recovery_pending){
    const recovery=el('details','','diagnostic');recovery.append(el('summary','高级：恢复历史 orphan 分支'));
    const session=el('input');session.placeholder='wc_sess_...';session.setAttribute('aria-label','接收对话 Runtime Session');
    const event=el('input');event.placeholder='evt_...';event.setAttribute('aria-label','Runtime 账本事件');
    const recover=el('button','确认恢复到这个真实接收 Session');
    recover.onclick=async()=>{recover.disabled=true;try{
     if(!/^wc_sess_(?:[A-Za-z0-9_-]{16}|[0-9a-f]{32})$/.test(session.value.trim()))throw Error('Session 格式不正确');
     if(!/^evt_[0-9a-f]{32}$/.test(event.value.trim()))throw Error('Runtime 事件格式不正确');
     if(!confirm('只适用于旧分支从未有真实页面、原请求未领取且没有发送记录的情况。确认使用外部 Runtime 账本已核实的接收 Session？'))return;
     const result=await command('team.recover-enroll',{confirm:true,existing_thread_id:c.thread_id,receiver_session:session.value.trim(),runtime_event_id:event.value.trim(),reason:'Operator explicitly confirmed externally verified Runtime Session evidence'},selected.id);
     if(result.state!=='receiver_enrolled')throw Error(result.code||'恢复未确认');
     card.append(el('p','后端恢复已确认；原 request/delegation 保留。现在在同一个接收 ChatGPT 页面用 Companion 识别并启用。'));await refresh();
    }catch(e){card.append(el('p',String(e.message||e)));}finally{recover.disabled=false;}};
    recovery.append(el('p','仅用于迁移旧调试状态。Session / event 是审计身份，不是正常产品输入，也不是账号或执行密钥。'),session,event,recover);card.append(recovery);
   }
  }
  box.append(card);
 }
 if(selected?.provider==='chatgpt_web_host'){
  const form=el('details','','team-add');form.open=!data.carriers.some(c=>c.physical_conversation_bound);form.append(el('summary','添加工作对话'));
  const title=el('input');title.placeholder='人类可读职责名，例如数学验证';title.setAttribute('aria-label','新对话职责');
  const project=el('input');project.placeholder='Runtime Project ID';project.setAttribute('aria-label','实际工作项目');
  const root=el('input');root.value=info.root||'';root.setAttribute('aria-label','实际工作根目录');
  const button=el('button','生成一次接入邀请');
  button.onclick=async()=>{
   button.disabled=true;
   try{
    if(!title.value.trim())throw Error('请填写职责名');
    const payload={confirm:true,title:title.value.trim(),root:root.value,ttl_seconds:3600,allow_rebind:false,reason:'Operator adds an actual receiving conversation'};
    if(project.value.trim())payload.project=project.value.trim();
    const result=await command('team.invite',payload,selected.id);showInvitation(form,result);
   }catch(e){form.append(el('p',String(e.message||e)));}finally{button.disabled=false;}
  };form.append(title,project,root,button);box.append(form);
 }else box.append(el('p','添加工作对话时先在左侧选择项目的 Web 主控；已有 worker 的状态查看不需要选择内部 target。','small'));
 for(const run of data.runs){
  const card=el('section','','run-card');card.append(el('h4',run.goal_ref),el('p',run.state+' · 回合 '+run.dispatches+'/'+run.max_dispatches+' · 并行 '+(run.max_parallel||'不限'),'team-state'),el('p','截止 '+new Date(run.deadline*1000).toLocaleString()+' · 重启不重置','small'));
  if(run.state!=='closed'){
   const pause=el('button','暂停新发送（不假装中断在途模型）');pause.onclick=async()=>{await command('team.pause',{confirm:true,run_id:run.id,reason:'operator pause'},run.controller_thread);await refresh();};card.append(pause);
   if(run.state==='paused'){
    const resume=el('button','恢复原剩余预算');resume.onclick=async()=>{await command('team.resume',{confirm:true,run_id:run.id,expected_revision:run.revision},run.controller_thread);await refresh();};card.append(resume);
   }
  }box.append(card);
 }
 const advanced=el('details','','diagnostic');advanced.append(el('summary','协议与安全边界'),el('p','真实页面只在首次加入项目时确认一次。之后复用该对话；任务正文和最终公开回复由浏览器载体自动交付/回传。CLW 不读取隐藏推理，不自动切模型，不把本地预算称作官方额度。工作区、冻结要求和共享资源仍服从原项目负责人。'));box.append(advanced);
 const refreshButton=el('button','刷新真实状态');refreshButton.onclick=refresh;box.append(refreshButton);
}
function showInvitation(box,result){
 if(!result.bootstrap_text)throw Error('接入邀请未确认；请核对原操作，不重复生成。');
 const text=el('textarea');text.value=result.bootstrap_text;text.readOnly=true;text.rows=10;text.setAttribute('aria-label','一次接入文本');
 const copy=el('button','复制接入文本');copy.onclick=async()=>{await navigator.clipboard.writeText(result.bootstrap_text);copy.textContent='已复制（尚未发送）';};
 const open=el('a','打开 ChatGPT 新页（不会自动发送）');open.href='https://chatgpt.com/';open.target='_blank';open.rel='noopener noreferrer';
 box.append(el('p','一次性接入能力，不是项目执行密钥。只发给你指定的真实对话；不从后台读取其他账号聊天。'),text,copy,open);
}
