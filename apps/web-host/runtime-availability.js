'use strict';
(function(scope){
  const messages={
    runtime_port_in_use:'本机服务入口（18944）已被占用。请检查已打开的 CLW 实例；保留原实例，或在原任务停稳后安全退出它，再正常启动工作区。',
    runtime_startup_timeout:'本机服务启动超时。请检查原进程与工作区；当前任务和回执保留。',
    runtime_startup_failed:'本机服务未能启动。请检查本机运行环境，处理后正常重新打开工作区；原任务和回执保留。',
    runtime_previous_process_not_exited:'原本机服务进程尚未退出。请先核对原任务与进程，再安全退出并正常启动工作区。',
    runtime_disconnected_reconcile_original:'本机通信中断；原请求保留，请核对原执行。',
    runtime_receipt_unknown_reconcile_original:'执行回执尚未确认，请核对原命令、文件和任务记录，不要重复提交。',
    runtime_not_connected:'本机服务尚未连接。请检查原实例和运行环境；当前任务保留。',
    runtime_task_state_unavailable:'原任务记录暂时无法读取。请检查本机服务与原工作区；原任务和未知执行保留。',
    runtime_network_unavailable:'VPN 尚未就绪，原任务记录与网页待核对。请恢复原代理后正常重新打开工作区；不会改用直连或重发任务。',
    managed_protocol_mismatch:'本机服务版本不匹配。请核对原工作区并正常重新打开，当前任务保留。',
    managed_protocol_store_changed:'本机服务的任务账本发生变化。请核对原工作区，不能借用其他实例的执行身份。',
    managed_protocol_invalid:'本机服务未返回有效的启动回执。请检查原服务，当前任务保留。',
  };
  function notice(code){return messages[code]||null;}
  function isNotice(value){return !!messages[value]||Object.values(messages).includes(value);}
  function currentNotice(value,{networkReady=false}={}){
    // A late restoration callback can report the pre-verification guard after
    // the same guard has already verified. Retire only that resolved condition;
    // page-load failures and original execution receipts remain diagnostics.
    const guardPending=['VPN 尚未通过核验，网页保持离线。','VPN 尚未通过核验，不能刷新网页。',messages.runtime_network_unavailable];
    return networkReady===true&&guardPending.includes(value)?'':value;
  }
  function presentation(state={}){
    const blocked=state.connected!==true||state.taskStateReady===false;
    if(!blocked)return {blocked:false,loading:false};
    const runtime=state.runtime||{},read=state.taskStateRead||{};
    const loading=runtime.state==='starting'||runtime.state==='recovering'||state.connected===true&&read.state==='loading'||!Object.hasOwn(state,'connected');
    if(loading)return {blocked:true,loading:true,title:runtime.state==='recovering'?'正在恢复本机连接':'正在恢复工作区',detail:'正在读取原任务、对话和运行记录，请稍候。',hint:'加载不会重新接入，也不会发送模型消息。'};
    const code=runtime.code||read.code||'runtime_not_connected';
    return {blocked:true,loading:false,code,title:code==='runtime_port_in_use'?'已有实例占用本机服务入口':'本机服务尚未就绪',detail:notice(code)||messages.runtime_startup_failed,hint:'原任务与回执保留；请核对后再继续。'};
  }
  const api={notice,isNotice,currentNotice,presentation};if(typeof module!=='undefined')module.exports=api;else scope.CLWRuntimeAvailability=api;
})(globalThis);
