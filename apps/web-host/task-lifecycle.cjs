'use strict';
const fs=require('node:fs'),path=require('node:path');

function taskLocation({root,id,home}){
  const requested=String(root||'').trim();
  if(requested){
    if(!path.isAbsolute(requested))throw Error('请选择完整的项目目录路径。');
    const resolved=path.resolve(requested);
    if(!fs.statSync(resolved,{throwIfNoEntry:false})?.isDirectory())throw Error('项目目录不存在，请重新选择。');
    return {root:resolved,automaticWorkspace:false};
  }
  if(!/^web-[0-9a-f-]{36}$/.test(id))throw Error('任务身份无效。');
  const resolved=path.join(home,'CLW','Tasks',id);
  fs.mkdirSync(resolved,{recursive:true});
  const guidance=path.join(resolved,'AGENTS.md');
  if(!fs.existsSync(guidance))fs.writeFileSync(guidance,'# CLW 任务工作区\n\n这是为本任务自动准备的独立目录。成果和交接保存在这里；不代表已有工程已迁入。\n按本轮用户任务与实际工具权限工作。需要已有项目资料时使用用户提供的路径，不扫描无关目录。\n已有操作先核对回执和文件，不重复初始化或覆盖成果。区分准备、实际执行与验收。\n','utf8');
  return {root:resolved,automaticWorkspace:true};
}

async function removeClosedTask({id,workspace,pool,driver,runtime,snapshot}){
  const task=workspace.tasks.get(id);
  if(!task?.closed)throw Error('请先关闭任务，再删除本机记录。');
  if(workspace.pendingStarts[id])throw Error('原提交尚未核对，请重新打开任务检查后再删除。');
  const record=driver?.records.get(id);
  if(driver?.busy.has(id)||driver?.pending.has(id))throw Error('正在核对原网页，请稍后删除。');
  // A closed row can still own accepted work. Do not turn list cleanup into cancellation.
  if(record){
    if(!runtime?.ready)throw Error('本机连接恢复后才能核对并删除此记录。');
    const current=await runtime.call('view',{page_id:id});
    if(!record.paused||current.request||current.partial_public_send||current.pending_notes||
       current.children?.some(c=>c.latest_request&&['queued','processing','suspended'].includes(c.latest_request.phase)))
      throw Error('原任务或协作者仍有未结束工作。请重新打开核对并收尾后再删除。');
    if(record.phase!=='bound'&&record.bootstrap_state!=='pending')throw Error('首次接入已发送，需先核对原回执再删除。');
    if(record.parent_target){
      const parent=await runtime.call('view',{page_id:record.parent_target});
      if(parent.request||parent.run&&parent.run.state!=='closed')throw Error('主控仍保留这位协作者，请待整组收尾后删除。');
    }
  }
  const page=pool.pages.get(id);
  if(page?.view?.webContents&&!page.view.webContents.isDestroyed?.()){
    const state=await snapshot(page.view.webContents,'snapshot');
    if(!state||state.generating||state.draft||state.composing||state.approvalRequired)
      throw Error('原网页仍在工作或有未发送内容。请重新打开处理后再删除。');
  }
  // Persist suppression before releasing a page. Durable execution/audit data and files stay intact.
  workspace.remove(id);workspace.save();
  if(page)pool.close(id);
  return {deleted:true,title:task.title,webConversationDeleted:false,filesDeleted:false};
}
module.exports={taskLocation,removeClosedTask};
