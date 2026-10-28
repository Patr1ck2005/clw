/* Visible bounded state only; no transcript mirroring/private API/cookie reads. */
(() => {
  'use strict';
  if (globalThis.CLWControlPage) return; // Ordinary inspection must not reset a user stop.
  let composing = false, stopped = false;
  const url = location.href;
  const shown = n => !!n && n.getClientRects().length > 0;
  const unique = selector => {const xs=[...document.querySelectorAll(selector)].filter(shown);return xs.length===1?xs[0]:null;};
  const editor = () => unique('#prompt-textarea');
  const send = () => unique('[data-testid="send-button"], [data-testid="composer-send-button"]');
  const stopSelector = '[data-testid="stop-button"], [data-testid="composer-stop-button"]';
  const modelSelector = '[data-testid="model-switcher-dropdown-button"]';
  const effortSelector = '[data-testid="composer-thinking-effort-button"], [data-testid="thinking-effort-button"], [data-testid="thinking-effort-slider"]';
  const text = n => n?.getAttribute('aria-valuetext') || n?.textContent || '';
  const value = n => n ? String(n.value ?? n.textContent ?? '') : '';
  const hash = async x => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  function logicalUser() {
    const users=[...document.querySelectorAll('[data-message-author-role="user"]')];
    const user=users.at(-1),turn=user?.closest('[data-turn-id], [data-turn-id-container]');
    return turn?.getAttribute('data-turn-id') || turn?.getAttribute('data-turn-id-container') || user?.getAttribute('data-message-id') || null;
  }
  function terminalFailure() {
    const a=[...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);
    const turn=a?.closest('[data-turn-id], [data-testid^="conversation-turn-"]')||a;
    const id=turn?.getAttribute('data-turn-id')||a?.getAttribute('data-message-id');
    const labels=new Map([['无法思考','cannot_think'],['Unable to think','cannot_think'],['Something went wrong while generating the response','generation_failed'],['生成回复时出错','generation_failed']]);
    if(!turn||!id)return {kind:'',key:'none'};
    for(const n of turn.querySelectorAll('[role="alert"], [data-testid="response-error"], button, [role="button"]')){
      if(!shown(n)||n.closest('pre,code,blockquote,.markdown'))continue;
      const label=String(n.textContent||'').trim().replace(/[.!。！]$/,'');
      if(labels.has(label))return {kind:labels.get(label),key:id+'\n'+label};
    }
    return {kind:'',key:'none'};
  }
  async function inspect() {
    const ed=editor(),user=logicalUser(),m=unique(modelSelector),e=unique(effortSelector),failure=terminalFailure();
    const alerts=[...document.querySelectorAll('[role="alert"], [role="dialog"]')].filter(shown).map(n=>String(n.textContent||'').slice(0,400)).join('\n');
    return {visible:document.visibilityState==='visible', generating:[...document.querySelectorAll(stopSelector)].some(shown),
      draft:value(ed).trim().length>0,composing,focused:document.activeElement===ed,stopped:stopped||location.href!==url,
      blocked:!!unique('[data-testid="login-button"]') || /usage limit|too many requests|达到.*上限|limit resets|access denied|permission denied|安全.*拒绝|权限.*拒绝|无法确定.*安全/i.test(alerts),
      controls_known:!!ed&&!!user&&!!m&&!!e&&(typeof ed.value==='string'||ed.isContentEditable),
      model_label:text(m).trim().slice(0,96),effort_label:text(e).trim().slice(0,96),user_hash:await hash(String(user||'')),failure_hash:await hash(failure.key),failure_kind:failure.kind};
  }
  function gesture(ev) {
    if (!ev.isTrusted) return;
    if (ev.type==='click' && ev.target?.closest(stopSelector+', [data-testid="send-button"], [data-testid="composer-send-button"], #prompt-textarea')) stopped=true;
    if (ev.type==='keydown' && ev.key==='Enter' && !ev.shiftKey && !ev.isComposing && ev.target?.closest('#prompt-textarea')) stopped=true;
  }
  const begin=()=>{composing=true;},end=()=>{composing=false;};
  document.addEventListener('compositionstart',begin,true);document.addEventListener('compositionend',end,true);
  document.addEventListener('click',gesture,true);document.addEventListener('keydown',gesture,true);
  globalThis.__clwControlPageCleanup=()=>{document.removeEventListener('compositionstart',begin,true);document.removeEventListener('compositionend',end,true);document.removeEventListener('click',gesture,true);document.removeEventListener('keydown',gesture,true);};
  globalThis.CLWControlPage=Object.freeze({inspect,editor,send,value,url,logicalUser});
})();
