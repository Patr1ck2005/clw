'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CLWQuotaView=api;})(globalThis,()=>{
  const status={exhausted:'额度耗尽',available:'可选 · 余额未知',unavailable:'暂不可选 · 原因未确认',unknown:'尚未核验'};
  function summary(q){const pro=q?.models?.find(m=>m.id==='latest-pro'),g=q?.usage?.lastGood;
    return g?(q.account+' · Pro '+g.completedProResponses+' 次 · 本机缓存'):(q?.account||'B')+' · Pro '+(pro?status[pro.status]:'尚未核验');}
  function render(container,q){
    container.replaceChildren();
    for(const m of q?.models||[]){
      const card=document.createElement('section');card.className='quota-model';card.dataset.status=m.status;
      const title=document.createElement('strong');title.textContent=m.label;
      const value=document.createElement('span');value.textContent=status[m.status]||status.unknown;
      const meta=document.createElement('small');const at=m.source==='user_report'?m.reportedAt:m.observedAt;
      meta.textContent=(m.source==='user_report'?'本机手动记录':m.source==='public_model_menu'?'已保存的模型菜单观察':'没有已保存的额度证据')+(at?' · '+new Date(at).toLocaleString():'')+(m.stale&&m.observedAt?' · 菜单观察已过期':'');
      const reset=document.createElement('p');reset.textContent=m.resetText?'重置：'+m.resetText+'（你提供的时间）':'重置时间：未知';
      card.append(title,value,meta,reset);container.append(card);
    }
    if(q?.readFailed){const e=document.createElement('p');e.textContent='本地额度记录暂不可读；这不会阻止原任务回收结果。';container.append(e);}
  }
  const reasons={invalid_auth:'需要登录此账号',http_401:'登录已失效',http_403:'网页服务拒绝历史读取',rate_limited:'历史读取暂时受限',timeout:'读取超时',account_identity_changed:'登录账号已变化',account_context_changed:'连接状态已变化',conversation_limit:'达到本次读取上限',invalid_response:'网页历史接口已变化',conversation_read_failed:'部分对话未读取',request_failed:'历史读取未完成',http_5xx:'网页服务暂不可用',http_error:'部分历史请求未成功',response_too_large:'部分对话超出单次读取容量',redirect_refused:'历史读取返回了其他页面'};
  function historyLines(q){
    const usage=q?.usage,g=usage?.lastGood,a=usage?.lastAttempt;
    const lines=[];
    if(g){
      const window=g.window||{},label=window.source==='custom_start'?'已保存的指定起点统计':'已保存的 7 天统计';
      const unknown=(g.byModel||[]).filter(m=>m.model==='unknown'||m.model==='auto').reduce((n,m)=>n+m.completedResponses,0);
      lines.push(label+' · '+(unknown?'已识别 ':'')+g.completedProResponses+' 次完成的 Pro 回复','涉及 '+g.proConversations+' 个对话',
        '采集区间：'+new Date(window.start).toLocaleString()+' — '+new Date(window.end).toLocaleString(),
        '采集时间：'+new Date(g.checkedAt).toLocaleString());
      if(unknown)lines.push('另有 '+unknown+' 次完成回复的模型未明确，未算作 Pro。');
      if(g.coverage?.state!=='complete')lines.push('缓存仅含已读取部分 · 已核对 '+(g.coverage?.conversationsRead||0)+' 个对话');
      if(usage.stale)lines.push('显示已保存的'+(g.coverage?.state==='complete'?'完整':'')+'缓存；之后的采集未完成。');
    }else{
      lines.push(a?'Pro 用量未知 · 本机尚无完整统计':'本机尚无已保存的历史统计');
      if(a?.checkedAt)lines.push('采集时间：'+new Date(a.checkedAt).toLocaleString());
    }
    if(a?.coverage?.state==='partial'&&a.coverage.conversationsRead>0)
      lines.push('上次未完成的采集 · 已核对 '+a.coverage.conversationsRead+' / '+a.coverage.conversationsListed+' 个对话；结果未读全。');
    if(a&&a.coverage?.state!=='complete')lines.push('上次采集：'+(a.coverage.diagnostic?.browserVerification===true?
      '网页访问验证未完成':reasons[a.coverage?.reason]||'部分历史未读取')+'。');
    const models=g?.byModel?.filter(m=>m.completedProResponses>0).map(m=>m.model+'：'+m.completedProResponses+' 次');
    if(models?.length)lines.push(models.join(' · '));
    return lines;
  }
  function renderHistory(container,quotas){
    container.replaceChildren();
    for(const account of ['A','B']){
      const q=quotas.find(q=>q.account===account),card=document.createElement('section');card.className='quota-model';
      const title=document.createElement('strong');title.textContent='账号 '+account+' · 本机缓存';card.append(title);
      for(const [i,text]of historyLines(q).entries()){
        const line=document.createElement(i===0?'span':'small');line.textContent=text;card.append(line);
      }
      container.append(card);
    }
  }
  return {summary,render,historyLines,renderHistory};
});
