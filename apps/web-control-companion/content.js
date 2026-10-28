/* One explicitly paired tab. Every physical Send requires one durable grant. */
(() => {
  'use strict';
  if(globalThis.__clwControlStop)globalThis.__clwControlStop();
  // Only one carrier in this document. This stops the old observer, not its server pair.
  if(globalThis.__clwRecoveryStop)globalThis.__clwRecoveryStop();
  const policy=globalThis.CLWControlPolicy,page=globalThis.CLWControlPage;
  let closed=false,busy=false,expected=null,failures=0;
  const call=async data=>{const r=await chrome.runtime.sendMessage({type:'wire',data});if(!r?.ok)throw Error(r?.error||'control_transport_unavailable');return r.value;};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function deliver(offer) {
    let state=await page.inspect();
    if(!policy.safe(state,expected)||state.user_hash!==offer.user_hash||state.failure_hash!==offer.failure_hash)return;
    const grant=await call({action:'dispatch',attempt_id:offer.attempt_id,page:state});
    if(grant.dispatch!==true)return;
    if(grant.attempt_id!==offer.attempt_id||typeof grant.prompt!=='string'||grant.prompt.length>4096||!grant.prompt.startsWith('CLW 原请求接管通知'))throw Error('control_grant_mismatch');
    let result='not_sent',inserted=false;
    try {
      state=await page.inspect();
      if(closed||!policy.safe(state,expected)||state.user_hash!==offer.user_hash||state.failure_hash!==offer.failure_hash||location.href!==page.url)throw Error('control_page_changed');
      const ed=page.editor();
      if(!ed||document.activeElement===ed||page.value(ed).trim())throw Error('control_composer_in_use');
      if(typeof ed.value==='string') {
        const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
        if(!setter)throw Error('control_editor_unsupported');setter.call(ed,grant.prompt);
      } else if(ed.isContentEditable) {
        ed.focus();const selection=getSelection(),range=document.createRange();range.selectNodeContents(ed);selection.removeAllRanges();selection.addRange(range);
        if(!document.execCommand('insertText',false,grant.prompt))throw Error('control_editor_rejected');
      } else throw Error('control_editor_unsupported');
      inserted=true;ed.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:grant.prompt}));
      for(let i=0;i<8;i++){const b=page.send();if(b&&!b.disabled&&b.getAttribute('aria-disabled')!=='true')break;await pause(250);}
      state=await page.inspect();
      const check={...state,draft:false,focused:false};
      if(closed||!policy.safe(check,expected)||state.user_hash!==offer.user_hash||state.failure_hash!==offer.failure_hash||location.href!==page.url||page.editor()!==ed||page.value(ed)!==grant.prompt)throw Error('control_composer_changed');
      const button=page.send();
      if(!button||button.disabled||button.getAttribute('aria-disabled')==='true')throw Error('control_send_unavailable');
      // Once granted, no retry path leads back here. Lost click acceptance stays unknown.
      result='unknown';button.click();
      for(let i=0;i<12;i++){
        await pause(250);const now=await page.inspect();
        if(location.href!==page.url)break;
        if(now.user_hash!==offer.user_hash&&!page.value(ed).trim()){result='sent';break;}
      }
    } finally {
      try{const receipt=await call({action:'finish',attempt_id:offer.attempt_id,result});if(receipt.state==='acknowledged')result='sent';}finally{if(result!=='sent')closed=true;}
      // On failure leave drafts intact; never erase user text to make a retry possible.
      if(inserted&&result!=='sent')closed=true;
    }
  }
  async function tick() {
    if(closed||busy)return;busy=true;
    try {
      if(!expected){const r=await chrome.runtime.sendMessage({type:'hello'});if(!r?.ok)throw Error(r?.error||'control_pair_required');expected=r.value;}
      const state=await page.inspect();
      if(!policy.isChat(location.href)||location.href!==page.url){closed=true;return;}
      const result=await call({action:'pulse',page:state});failures=0;
      if(result.state==='disabled'){closed=true;return;}
      if(result.state==='offer')await deliver(result);
      if(result.state==='original_attempt_requires_reconciliation')return;
    } catch(e) {
      failures++;
      if(failures>=3||/pair_|disabled|mismatch|unknown|no_retry|changed|expired|foreign|stale/.test(String(e.message)))closed=true;
    } finally {busy=false;}
  }
  const timer=setInterval(tick,3000);
  globalThis.__clwControlStop=()=>{closed=true;clearInterval(timer);};
  void tick();
})();
