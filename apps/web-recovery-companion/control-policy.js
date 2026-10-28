/* Unified CLW control policy. No provider calls or model/effort selection. */
(() => {
  'use strict';
  const normal = x => typeof x === 'string' ? x.trim().replace(/\s+/g, ' ').toLowerCase() : '';
  const chat = /^https:\/\/chatgpt\.com\/(?:g\/[A-Za-z0-9_-]+\/)?c\/(?:WEB:)?[A-Za-z0-9-]{16,128}$/;
  const allowedEffort=x=>['medium','中等','extra high','极高'].includes(normal(x));
  const permitted = (model, effort) => /\bsol\b/.test(normal(model)) && !/\bpro\b/.test(normal(model)) && allowedEffort(effort);
  const confirmedModel=x=>normal(x)==='@confirmed-sol-nonpro';
  const confirmedEffort=x=>normal(x)==='@confirmed-medium-or-extra-high';
  function confirmable(page){
    if(!page||page.controls_known!==true||page.model_pro_visible===true||page.effort_disallowed_visible===true)return false;
    if(page.model_label && (!/\bsol\b/.test(normal(page.model_label))||/\bpro\b/.test(normal(page.model_label))))return false;
    if(page.effort_label && !allowedEffort(page.effort_label))return false;
    return page.blocked===false&&page.stopped===false;
  }
  const bindingPermitted=(model,effort)=>(confirmedModel(model)||(/\bsol\b/.test(normal(model))&&!/\bpro\b/.test(normal(model))))&&(confirmedEffort(effort)||allowedEffort(effort));
  function safe(page, expected) {
    if(!confirmable(page))return false;
    const modelOk=confirmedModel(expected.model_label)
      ? (!page.model_label||/\bsol\b/.test(normal(page.model_label)))
      : normal(page.model_label)===normal(expected.model_label);
    const effortOk=confirmedEffort(expected.effort_label)
      ? (!page.effort_label||allowedEffort(page.effort_label))
      : normal(page.effort_label)===normal(expected.effort_label);
    const transportOk=page.visible===true||expected?.transport_active===true;
    return transportOk&&modelOk&&effortOk&&/^[0-9a-f]{64}$/.test(page.user_hash)&&/^[0-9a-f]{64}$/.test(page.failure_hash)&&
      ['', 'cannot_think','generation_failed'].includes(page.failure_kind)&&
      ['generating','draft','composing','focused','blocked','stopped','model_pro_visible','effort_disallowed_visible'].every(k=>page[k]===false);
  }
  function readRetry(error,count,now,readOnly){
    const message=String(error?.message||error);
    const transient=/Failed to fetch|NetworkError|Load failed|control_transport_unavailable|control_transport_unknown_no_retry|service_error_reconcile_original/i.test(message);
    const delays=[15000,45000,120000];
    return readOnly&&transient&&Number.isInteger(count)&&count>=1&&count<=delays.length
      ? {closed:false,nextReadAt:now+delays[count-1]} : {closed:true,nextReadAt:0};
  }
  const fields=Object.freeze({pulse:['page'],dispatch:['attempt_id','page'],sent:['attempt_id','page','assistant_before_hash'],result:['attempt_id','page','assistant_turn_hash','text'],finish:['attempt_id','result'],disable:[]});
  function actionValid(x){return !!x&&Object.hasOwn(fields,x.action)&&Object.keys(x).sort().join('|')===['action',...fields[x.action]].sort().join('|');}
  globalThis.CLWControlPolicy=Object.freeze({normal,allowedEffort,permitted,bindingPermitted,confirmable,safe,readRetry,actionValid,isChat:url=>chat.test(url)});
})();
