/* Unified one-tab control carrier. Every physical Send still requires one durable server grant. */
(() => {
  'use strict';
  if(globalThis.__clwControlStop)globalThis.__clwControlStop();
  if(globalThis.__clwRecoveryStop)globalThis.__clwRecoveryStop();
  const policy=globalThis.CLWControlPolicy,page=globalThis.CLWControlPage;
  let closed=false,busy=false,expected=null,failures=0,nextReadAt=0,active=null,resultCandidate=null;
  const call=async data=>{const r=await chrome.runtime.sendMessage({type:'control-wire',data});if(!r?.ok)throw Error(r?.error||'control_transport_unavailable');return r.value;};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const transport=async()=>{const r=await chrome.runtime.sendMessage({type:'control-transport'});return r?.ok&&r.value?.active===true;};
  async function deliver(offer){
    let state=await page.inspect();
    const before=await page.latestAssistant();
    if(!policy.safe(state,expected)||state.user_hash!==offer.user_hash||state.failure_hash!==offer.failure_hash)return;
    const grant=await call({action:'dispatch',attempt_id:offer.attempt_id,page:state});
    if(grant.dispatch!==true)return;
    if(grant.attempt_id!==offer.attempt_id||typeof grant.prompt!=='string'||grant.prompt.length>96000||!grant.prompt.startsWith('CLW 原请求接管通知'))throw Error('control_grant_mismatch');
    let result='not_sent',inserted=false,sentState=null;
    try{
      state=await page.inspect();
      if(closed||!policy.safe(state,expected)||state.user_hash!==offer.user_hash||state.failure_hash!==offer.failure_hash||location.href!==page.url)throw Error('control_page_changed');
      if(!await transport())throw Error('control_background_transport_inactive');
      const ed=page.editor();
      if(!ed||document.activeElement===ed||page.value(ed).trim())throw Error('control_composer_in_use');
      if(typeof ed.value==='string'){
        const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
        if(!setter)throw Error('control_editor_unsupported');setter.call(ed,grant.prompt);
      }else if(ed.isContentEditable){
        ed.focus();const selection=getSelection(),range=document.createRange();range.selectNodeContents(ed);selection.removeAllRanges();selection.addRange(range);
        if(!document.execCommand('insertText',false,grant.prompt))throw Error('control_editor_rejected');
      }else throw Error('control_editor_unsupported');
      inserted=true;ed.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:grant.prompt}));
      for(let i=0;i<8;i++){const b=page.send();if(b&&!b.disabled&&b.getAttribute('aria-disabled')!=='true')break;await pause(250);}
      state=await page.inspect();const check={...state,draft:false,focused:false};
      if(closed||!policy.safe(check,expected)||state.user_hash!==offer.user_hash||state.failure_hash!==offer.failure_hash||location.href!==page.url||page.editor()!==ed||page.value(ed)!==grant.prompt)throw Error('control_composer_changed');
      const button=page.send();if(!button||button.disabled||button.getAttribute('aria-disabled')==='true')throw Error('control_send_unavailable');
      if(!await transport())throw Error('control_background_transport_inactive');
      result='unknown';button.click();
      for(let i=0;i<12;i++){await pause(250);const now=await page.inspect();if(location.href!==page.url)break;if(now.user_hash!==offer.user_hash&&!page.value(ed).trim()){result='sent';sentState=now;break;}}
    }finally{
      if(result==='sent'&&sentState){
        const receipt=await call({action:'sent',attempt_id:offer.attempt_id,page:sentState,assistant_before_hash:before?.turn_hash||'0'.repeat(64)});
        if(receipt.state!=='browser_result_pending')throw Error('control_sent_receipt_unconfirmed');
        active={attempt_id:receipt.attempt_id,sent_user_hash:receipt.sent_user_hash,assistant_before_hash:receipt.assistant_before_hash};
        resultCandidate=null;
      }else{
        try{const receipt=await call({action:'finish',attempt_id:offer.attempt_id,result});if(receipt.state==='acknowledged')result='sent';}finally{closed=true;}
      }
      if(inserted&&result!=='sent')closed=true;
    }
  }
  async function capture(){
    if(!active)return false;
    const state=await page.inspect();
    if(location.href!==page.url||state.stopped||state.blocked){closed=true;return false;}
    if(state.user_hash!==active.sent_user_hash){closed=true;return false;}
    if(state.generating||state.draft||state.composing||state.focused)return true;
    if(state.failure_kind){
      const transition=await call({action:'pulse',page:state});
      if(transition.state==='browser_result_pending')return true;
      if(transition.state==='browser_result_failed_recovery_pending'||transition.state==='offer'||transition.state==='idle_or_old_request_not_adopted'){
        active=null;resultCandidate=null;return false;
      }
      throw Error('control_failure_transition_unconfirmed');
    }
    if(!policy.safe(state,expected))return true;
    const answer=await page.latestAssistant();
    if(!answer||!answer.text||answer.turn_hash===active.assistant_before_hash)return true;
    if(answer.text.length>48000){closed=true;throw Error('control_public_reply_too_large_manual_reconcile');}
    const signature=answer.turn_hash+'\n'+answer.text;
    if(!resultCandidate||resultCandidate.signature!==signature){resultCandidate={signature,seenAt:Date.now()};return true;}
    if(Date.now()-resultCandidate.seenAt<1500)return true;
    const done=await call({action:'result',attempt_id:active.attempt_id,page:state,assistant_turn_hash:answer.turn_hash,text:answer.text});
    if(!['completed','yielded'].includes(done.state))throw Error('control_browser_result_unconfirmed');
    active=null;resultCandidate=null;return false;
  }
  async function tick(){
    if(closed||busy||Date.now()<nextReadAt)return;busy=true;let readOnly=true;
    try{
      if(!expected){const r=await chrome.runtime.sendMessage({type:'control-hello'});if(!r?.ok)throw Error(r?.error||'control_pair_required');expected=r.value;}
      const state=await page.inspect();
      if(!policy.isChat(location.href)||location.href!==page.url){closed=true;return;}
      if(active){await capture();failures=0;nextReadAt=0;return;}
      if(!await transport()){failures=0;nextReadAt=0;return;}
      const result=await call({action:'pulse',page:state});failures=0;nextReadAt=0;
      if(result.state==='disabled'){closed=true;return;}
      if(result.state==='browser_result_pending'){active={attempt_id:result.attempt_id,sent_user_hash:result.sent_user_hash,assistant_before_hash:result.assistant_before_hash};resultCandidate=null;await capture();return;}
      if(result.state==='offer'){readOnly=false;await deliver(result);}
      if(result.state==='original_attempt_requires_reconciliation')return;
    }catch(e){failures++;const recovery=policy.readRetry(e,failures,Date.now(),readOnly);closed=recovery.closed;nextReadAt=recovery.nextReadAt;}
    finally{busy=false;}
  }
  const checkListener=(message,sender,reply)=>{
    if(sender.id!==chrome.runtime.id)return false;
    if(message?.type==='clw-pool-check'){
      void page.inspect().then(snapshot=>reply({closed,busy,nextReadAt,page:snapshot})).catch(()=>reply({closed:true,busy:false,page:null}));return true;
    }
    if(message?.type==='clw-background-tick'){
      void tick().then(()=>reply({closed,busy,nextReadAt})).catch(()=>reply({closed:true,busy:false,nextReadAt:0}));return true;
    }
    return false;
  };
  chrome.runtime.onMessage?.addListener(checkListener);
  const timer=setInterval(tick,3000);
  globalThis.__clwControlStop=()=>{closed=true;clearInterval(timer);chrome.runtime.onMessage?.removeListener(checkListener);};
  void tick();
})();
