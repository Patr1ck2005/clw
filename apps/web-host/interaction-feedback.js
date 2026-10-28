'use strict';
(function(scope){
  const labels={select:'正在切换任务',refresh:'正在刷新原对话',inspect:'正在核对任务设置',
    'adopt-model':'正在保存模型设置','set-model':'正在保存模型设置',pause:'正在暂停自动推进',resume:'正在核对并恢复自动推进',
    'team-maintenance':'正在更新自动推进状态','team-resume':'正在核对并恢复自动推进',
    new:'正在创建任务',login:'正在打开账号',reopen:'正在打开原任务',close:'正在保存任务现场',
    rename:'正在保存名称','delete-task':'正在删除本机记录',quit:'正在保存现场并核对退出条件',
    'pick-root':'等待选择目录','pick-context':'等待选择项目引用','reconcile-submission':'正在核对原提交回执','connection-read':'正在读取连接设置','connection-save':'正在保存连接设置',
    'connection-pick-file':'等待选择连接文件','codex-verify':'正在核对连接',
    'codex-start':'正在打开 Codex＋Web','codex-resume-turn':'正在打开原 Codex 任务',
    'codex-view-turn':'正在打开原对话','native-codex-start':'正在打开本地 Codex',
    start:'正在保存要求','start-first-turn':'正在保存首次要求',enroll:'正在接入原任务',
    'goal-save':'正在保存目标','goal-stop':'正在关闭目标并保存现场','goal-review':'正在保存验收','goal-continue':'正在核对下一包',
    'goal-discard':'正在核对待发请求','goal-read':'正在读取目标','refill-budget':'正在保存本地发送预算',
    'quota-history':'正在读取账号历史用量','budget-continue':'正在核对原任务','record-history':'正在读取记录','record-index':'正在查找记录',
    'record-body':'正在读取正文',withdraw:'正在核对并撤回','stop-generation':'正在停止原生成'};
  class Feedback {
    constructor({onChange=()=>{},now=()=>Date.now()}={}){this.onChange=onChange;this.now=now;this.operations=new Map();this.serial=0;this.nodes=new WeakMap();}
    begin(action,{node=null,owner=null}={}){
      const id=++this.serial,operation={id,action,label:labels[action]||'正在处理操作',owner,startedAt:this.now()};
      this.operations.set(id,operation);
      if(node){const prior=this.nodes.get(node)||{count:0,aria:node.getAttribute('aria-busy')};prior.count++;this.nodes.set(node,prior);
        node.setAttribute('aria-busy','true');node.classList.add('interaction-pending');}
      this.onChange();let ended=false;
      return ()=>{if(ended)return;ended=true;this.operations.delete(id);
        if(node){const state=this.nodes.get(node);if(state&&--state.count===0){node.classList.remove('interaction-pending');
          if(state.aria===null)node.removeAttribute('aria-busy');else node.setAttribute('aria-busy',state.aria);this.nodes.delete(node);}}
        this.onChange();};
    }
    snapshot(accept=()=>true){return [...this.operations.values()].filter(operation=>accept(operation.owner)).at(-1)||null;}
  }
  const api={Feedback,labels};if(typeof module!=='undefined')module.exports=api;else scope.CLWInteractionFeedback=api;
})(globalThis);
