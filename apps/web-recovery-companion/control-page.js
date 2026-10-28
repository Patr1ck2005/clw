/* Visible bounded state only; no transcript mirroring/private API/cookie reads. */
(() => {
  'use strict';
  if (globalThis.CLWControlPage) return;
  let composing=false,stopped=false;
  const url=location.href;
  const shown=n=>!!n&&n.getClientRects().length>0;
  const unique=selector=>{const xs=[...document.querySelectorAll(selector)].filter(shown);return xs.length===1?xs[0]:null;};
  const editorSelector='[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][data-lexical-editor="true"]';
  const editor=()=>unique(editorSelector);
  const send=()=>unique('[data-testid="send-button"], [data-testid="composer-send-button"]');
  const stopSelector='[data-testid="stop-button"], [data-testid="composer-stop-button"]';
  const modeSelector=[
    'button[data-testid="model-switcher-dropdown-button"]',
    'button[data-testid="composer-thinking-effort-button"]',
    'button[data-testid="thinking-effort-button"]',
    'button[aria-haspopup="menu"][data-tone="neutral"]',
    'button.__composer-pill[aria-haspopup="menu"]',
    '[data-model-reasoning-effort-slider] [role="slider"]'
  ].join(', ');
  const text=n=>n?.getAttribute('aria-valuetext')||n?.getAttribute('aria-label')||n?.textContent||'';
  const value=n=>n?String(n.value??n.textContent??''):'';
  const hash=async x=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  function logicalUser(){
    const turns=[...document.querySelectorAll(
      '[data-testid^="conversation-turn-"][data-turn="user"], '+
      '[data-testid^="conversation-turn-"][data-message-author-role="user"], '+
      '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])'
    )].filter(shown);
    const turn=turns.at(-1);
    if(turn)return turn.getAttribute('data-turn-id')||turn.getAttribute('data-turn-id-container')||turn.getAttribute('data-testid')||null;
    const users=[...document.querySelectorAll('[data-message-author-role="user"]')],user=users.at(-1),legacy=user?.closest('[data-turn-id], [data-turn-id-container], [data-testid^="conversation-turn-"]');
    return legacy?.getAttribute('data-turn-id')||legacy?.getAttribute('data-turn-id-container')||legacy?.getAttribute('data-testid')||user?.getAttribute('data-message-id')||null;
  }
  function modeEvidence(ed){
    const scope=ed?.closest('form')||document;
    const nodes=[...new Set([...document.querySelectorAll('button[data-testid="model-switcher-dropdown-button"]'),...scope.querySelectorAll(modeSelector)].filter(shown))];
    const labels=[];
    for(const n of nodes){
      for(const raw of [n.getAttribute('aria-valuetext'),n.getAttribute('aria-label'),n.getAttribute('title'),n.textContent]){
        const s=String(raw||'').trim().replace(/\s+/g,' ');if(s&&!labels.includes(s))labels.push(s);
      }
    }
    const joined=labels.join(' | '),compact=joined.replace(/\s+/g,'');
    const pro=/pro/i.test(joined);
    const sol=/sol/i.test(joined)||/5(?:\.|-)6sol/i.test(compact);
    let effort='';
    if(/extra\s*high|极高/i.test(joined))effort='Extra High';
    else if(/medium|中等/i.test(joined))effort='Medium';
    else if(/(?:^|[^a-z])high(?:$|[^a-z])/i.test(joined)||/(?:^|[^极])高(?:$|[^\u4e00-\u9fff])/.test(joined))effort='High';
    else if(/(?:^|[^a-z])low(?:$|[^a-z])/i.test(joined)||/低/.test(joined))effort='Low';
    else if(/instant|即时|快速/i.test(joined))effort='Instant';
    else if(pro)effort='Pro';
    return {nodes,labels,model_label:pro?'Pro':sol?'GPT-5.6 Sol':'',effort_label:effort,
      model_pro_visible:pro,effort_disallowed_visible:!!effort&&!['Medium','Extra High'].includes(effort)};
  }
  function assistantTurn(){
    const assistants=[...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(shown);
    const node=assistants.at(-1);if(!node)return null;
    const turn=node.closest('[data-turn-id], [data-turn-id-container], [data-testid^="conversation-turn-"]')||node;
    const key=turn.getAttribute?.('data-turn-id')||turn.getAttribute?.('data-turn-id-container')||
      turn.getAttribute?.('data-testid')||node.getAttribute?.('data-message-id')||'';
    return key?{node,turn,key}:null;
  }
  async function latestAssistant(){
    const current=assistantTurn();if(!current)return null;
    const blocks=[...(current.turn.querySelectorAll?.('.markdown')||[])].filter(shown);
    let body=(blocks.length?blocks.map(n=>String(n.textContent||'').trim()).filter(Boolean).join('\n\n'):
      String(current.node.textContent||'').trim());
    body=body.replace(/\u0000/g,'').trim();
    if(!body)return {turn_hash:await hash(current.key),text:''};
    return {turn_hash:await hash(current.key),text:body};
  }
  function terminalFailure(){
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
  async function inspect(){
    const ed=editor(),user=logicalUser(),mode=modeEvidence(ed),failure=terminalFailure();
    const alerts=[...document.querySelectorAll('[role="alert"], [role="dialog"]')].filter(shown).map(n=>String(n.textContent||'').slice(0,400)).join('\n');
    const editorKnown=!!ed&&(typeof ed.value==='string'||ed.isContentEditable);
    return {visible:document.visibilityState==='visible',generating:[...document.querySelectorAll(stopSelector)].some(shown),
      draft:value(ed).trim().length>0,composing,focused:!!ed&&(document.activeElement===ed||ed.contains(document.activeElement)),stopped:stopped||location.href!==url,
      blocked:!!unique('[data-testid="login-button"]')||/usage limit|too many requests|达到.*上限|limit resets|access denied|permission denied|安全.*拒绝|权限.*拒绝|无法确定.*安全/i.test(alerts),
      controls_known:editorKnown&&!!user&&mode.nodes.length>0,
      model_pro_visible:mode.model_pro_visible,effort_disallowed_visible:mode.effort_disallowed_visible,
      model_label:mode.model_label.slice(0,96),effort_label:mode.effort_label.slice(0,96),
      editor_known:editorKnown,user_known:!!user,mode_control_known:mode.nodes.length>0,
      user_hash:await hash(String(user||'')),failure_hash:await hash(failure.key),failure_kind:failure.kind};
  }
  function gesture(ev){
    if(!ev.isTrusted)return;
    if(ev.type==='click'&&ev.target?.closest(stopSelector+', [data-testid="send-button"], [data-testid="composer-send-button"], '+editorSelector))stopped=true;
    if(ev.type==='keydown'&&ev.key==='Enter'&&!ev.shiftKey&&!ev.isComposing&&ev.target?.closest(editorSelector))stopped=true;
  }
  const begin=()=>{composing=true;},end=()=>{composing=false;};
  document.addEventListener('compositionstart',begin,true);document.addEventListener('compositionend',end,true);
  document.addEventListener('click',gesture,true);document.addEventListener('keydown',gesture,true);
  globalThis.__clwControlPageCleanup=()=>{document.removeEventListener('compositionstart',begin,true);document.removeEventListener('compositionend',end,true);document.removeEventListener('click',gesture,true);document.removeEventListener('keydown',gesture,true);};
  globalThis.CLWControlPage=Object.freeze({inspect,editor,send,value,url,logicalUser,latestAssistant});
})();
