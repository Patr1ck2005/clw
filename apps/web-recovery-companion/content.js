/* Visible status observation and ordinary composer input in ONE opt-in tab.
 * No private API, DOM text mirroring, cookies, credential access or global clicks.
 */
(() => {
 'use strict';
 if(globalThis.__clwRecoveryStop)globalThis.__clwRecoveryStop();
 if(globalThis.__clwControlStop)globalThis.__clwControlStop();
 const policy=globalThis.CLWRecoveryPolicy,boundUrl=location.href;
 let closed=false,busy=false,composing=false,stopped=false,newUserInput=false,requestId=null,baseline=null,previousFailureKey=null,diagnosticsSupported=false,failures=0;
 const shown=n=>!!n&&n.getClientRects().length>0;
 const unique=selector=>{const a=[...document.querySelectorAll(selector)].filter(shown);return a.length===1?a[0]:null;};
 const editor=()=>unique('#prompt-textarea');
 const send=()=>unique('[data-testid="send-button"], [data-testid="composer-send-button"]');
 const stopSelector='[data-testid="stop-button"], [data-testid="composer-stop-button"]';
 const hash=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 function identity(n){return n?.getAttribute('data-message-id')||n?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid')||null;}
 function state(){
  const ed=editor(),assistants=[...document.querySelectorAll('[data-message-author-role="assistant"]')],last=assistants.at(-1),turn=last?.closest('[data-testid^="conversation-turn-"]')||last;
  const user=[...document.querySelectorAll('[data-message-author-role="user"]')].at(-1);
  let marker=null,label='';
  if(turn){
   for(const n of turn.querySelectorAll('[role="alert"], [data-testid="response-error"], button, [role="button"]')){
    if(!shown(n)||n.closest('pre,code,blockquote,.markdown'))continue;
    const t=(n.textContent||'').trim().replace(/[.!。！]$/,'');
    if(policy.errors.includes(t)){marker=n;label=t;break;}
   }
  }
  const alerts=[...document.querySelectorAll('[role="alert"], [role="dialog"]')].filter(shown).map(n=>(n.textContent||'').slice(0,400)).join('\n');
  const x={url:location.href,boundUrl,visible:document.visibilityState==='visible',generating:[...document.querySelectorAll(stopSelector)].some(shown),draft:!!ed&&(ed.value??ed.textContent??'').trim().length>0,composing,stopped,newUserInput,login:[...document.querySelectorAll('[data-testid="login-button"]')].some(shown),limited:/usage limit|too many requests|达到.*上限|limit resets/i.test(alerts),safety:/access denied|permission denied|request.*safety|无法确定.*安全|权限.*拒绝/i.test(alerts),controlsKnown:!!ed&&(typeof ed.value==='string'||ed.isContentEditable),terminalMarker:!!marker,errorLabel:label,assistantTurnId:identity(last),userTurnId:identity(user),inQuotedContent:false};
  x.kind=policy.classify(x);return x;
 }
 async function call(data){const r=await chrome.runtime.sendMessage({type:'wire',data});if(!r?.ok)throw Error(r?.error||'recovery_channel_unavailable');return r.value;}
 function userAction(e){
  if(!e.isTrusted)return;
  if(e.type==='click'&&e.target?.closest(stopSelector))stopped=true;
  if(requestId!==null&&e.type==='click'&&e.target?.closest('[data-testid="send-button"], [data-testid="composer-send-button"]'))newUserInput=true;
  if(requestId!==null&&e.type==='keydown'&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.target?.closest('#prompt-textarea'))newUserInput=true;
 }
 const begin=()=>{composing=true;},end=()=>{composing=false;};
 document.addEventListener('compositionstart',begin,true);document.addEventListener('compositionend',end,true);
 document.addEventListener('click',userAction,true);document.addEventListener('keydown',userAction,true);
 async function tick(){
  if(closed||busy)return;busy=true;
  try{
   let x=state();
   const page={adapter_version:'0.2.0',kind:x.kind,visible:x.visible,controls_known:x.controlsKnown,assistant_identity_known:!!x.assistantTurnId,user_identity_known:!!x.userTurnId,terminal_marker:x.terminalMarker,draft:x.draft,composing:x.composing,generating:x.generating};
   const status=await call({action:'status',...(diagnosticsSupported?{page}:{})});
   diagnosticsSupported=status.page_diagnostics_supported===true;failures=0;
   x=state();
   const failureKey=await hash(boundUrl+'\n'+x.assistantTurnId+'\n'+x.errorLabel),userKey=await hash(String(x.userTurnId));
   if(!status.request_id){requestId=null;baseline=null;newUserInput=false;previousFailureKey=failureKey;return;}
   if(requestId!==status.request_id){
    requestId=status.request_id;
    // Compare against the actual prior idle snapshot, not the first sight of a
    // new request: a fast failure may have already appeared between two polls.
    baseline=previousFailureKey??failureKey;
   }
   previousFailureKey=failureKey;
   // Never act on an error that was already present when monitoring began.
   if(['cannot_think','generation_failed'].includes(x.kind)&&baseline===failureKey)return;
   const offer=await call({action:'observe',request_id:requestId,kind:x.kind,failure_key:failureKey,user_key:userKey,safe:!x.draft&&!x.composing&&!x.generating&&x.visible&&x.controlsKnown});
   if(offer.decision==='disabled'){closed=true;return;}
   if(offer.decision!=='offer')return;
   x=state();if(!['cannot_think','generation_failed'].includes(x.kind)||await hash(boundUrl+'\n'+x.assistantTurnId+'\n'+x.errorLabel)!==offer.failure_key||await hash(String(x.userTurnId))!==offer.user_key)return;
   const fence=await call({action:'dispatch',request_id:requestId,attempt_id:offer.attempt_id});
   if(fence.dispatch!==true)return;
   let result='not_sent',inserted=false;
   try{
    x=state();if(!['cannot_think','generation_failed'].includes(x.kind))throw Error('page_changed');
    const ed=editor();if(!ed||document.activeElement===ed)throw Error('composer_in_use');
    if(typeof ed.value==='string'){
     const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
     if(!setter)throw Error('unsupported_editor');setter.call(ed,offer.prompt);
    }else if(ed.isContentEditable){
     ed.focus();const selection=getSelection(),range=document.createRange();range.selectNodeContents(ed);selection.removeAllRanges();selection.addRange(range);
     if(!document.execCommand('insertText',false,offer.prompt))throw Error('editor_input_not_accepted');
    }else throw Error('unsupported_editor');
    inserted=true;ed.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:offer.prompt}));
    // Some hosts show the send button only after receiving editor input.
    for(let i=0;i<8;i++){
     const b=send();if(b&&!b.disabled&&b.getAttribute('aria-disabled')!=='true')break;
     if(stopped||newUserInput||composing||(ed.value??ed.textContent)!==offer.prompt)break;
     await new Promise(resolve=>setTimeout(resolve,250));
    }
    const button=send();if(stopped||newUserInput||composing||location.href!==boundUrl||(ed.value??ed.textContent)!==offer.prompt||!button||button.disabled||button.getAttribute('aria-disabled')==='true')throw Error('composer_changed');
    // Fence has committed: one ordinary click only. A lost response is not retried.
    result='unknown';button.click();result='sent';baseline=failureKey;
   }finally{
    await call({action:'finish',attempt_id:offer.attempt_id,result});
    if(result!=='sent'&&inserted)closed=true; // Preserve any draft; never erase user input.
   }
   failures=0;
  }catch(e){
   failures++;if(failures>=3||/pair_|disabled|mismatch|unknown|no_replay|changed|expired/.test(e.message))closed=true;
  }finally{busy=false;}
 }
 const timer=setInterval(tick,3000);
 globalThis.__clwRecoveryStop=()=>{closed=true;clearInterval(timer);document.removeEventListener('compositionstart',begin,true);document.removeEventListener('compositionend',end,true);document.removeEventListener('click',userAction,true);document.removeEventListener('keydown',userAction,true);};
 void tick();
})();
