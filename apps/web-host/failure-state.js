'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CLWFailure=api;})(globalThis,()=>{
  const states={
    preparation_required:['首次要求与模型需核对','这是发送前设置检查，消息尚未发送。完整研究或开发需求可直接使用 Pro；仅连接准备请使用极高。此提示不代表账号额度耗尽或模型不可用。','branch'],
    login_required:['需要重新登录','登录后核对原回执，再恢复此任务。不会重发已送达消息。','account'],
    usage_limit:['模型额度受限','保留当前模型与上下文，等待额度恢复后再继续；不会自动降档。','model'],
    model_unavailable:['指定模型暂不可用','核对网页模型选项；可能是额度或模型访问限制。其他可用模型的独立任务不受此分支暂停影响。','model'],
    model_mismatch:['网页模型与任务设置不一致','核对并采用网页设置，或选回原设置；没有用其他模型代发。','branch'],
    user_stopped:['已按要求停止','原执行和成果保留；确认恢复前不派发新工作。','branch'],
    control_failed:['网页操作未完成','核对原网页和发送回执；已保留原任务，不重复提交。','branch'],
    renderer_crashed:['网页异常退出','正在有限重连并核对原回执；原请求不会重发。','branch'],
    renderer_crash_limit:['网页恢复已停止','已达到本页恢复次数上限；核对原执行后可手动刷新，其他独立页面继续。','branch'],
    runtime_receipt_unknown_reconcile_original:['执行回执待核对','先核对原命令、文件和任务记录，不能把未知执行当作未执行重发。','branch'],
    bridge_login_required:['需要重新登录','登录后检查连接；原任务与成果保留，不发送模型探测消息。','account'],
    bridge_account_load_failed:['账号信息加载失败','检查网络与原网页；这不等于额度耗尽，也不会自动切换账号。','account'],
    bridge_connector_surface_not_ready:['连接页面尚未就绪','检查原网页与VPN；此状态不证明模型正在思考。','connection']
  };
  function describe(code){const s=states[code];return s?{key:code,title:s[0],detail:s[1],scope:s[2]}:null;}
  return {describe};
});
