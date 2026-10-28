/* Passive ChatGPT page bridge. It never sends a prompt, exports transcript
   content, or chooses a CLW target. It only exposes bounded page-safety state
   and exact CLW enrollment proofs to the extension service worker. */
(() => {
  'use strict';
  if (globalThis.__clwBackgroundBridgeInstalled) return;
  globalThis.__clwBackgroundBridgeInstalled = true;
  let proofSent=false,observer=null,timer=null;
  const currentProof=()=>{
    const v=globalThis.CLWEnrollmentReceipt?.();
    if(typeof v==='string')return {enrollment:v};
    if(v?.ticket)return {enrollment_ticket:v.ticket};
    return null;
  };
  const stale=()=>!!globalThis.CLWControlPage&&globalThis.CLWControlPage.url!==location.href;
  async function probe(){
    const proof=currentProof();
    if(stale())return {stale:true,needs_page:true,url:location.href,proof,page:null};
    if(!globalThis.CLWControlPage)return {stale:false,needs_page:true,url:location.href,proof,page:null};
    const page=await globalThis.CLWControlPage.inspect();
    return {stale:false,needs_page:false,url:location.href,proof,page};
  }
  async function announce(){
    if(proofSent)return;
    const proof=currentProof();if(!proof)return;
    proofSent=true;
    try{await chrome.runtime.sendMessage({type:'clw-background-proof-found',proof,url:location.href});}catch{}
    observer?.disconnect();observer=null;if(timer)clearTimeout(timer);
  }
  const schedule=()=>{
    if(proofSent)return;
    if(timer)clearTimeout(timer);
    timer=setTimeout(()=>{timer=null;void announce();},250);
  };
  if(document.documentElement){
    observer=new MutationObserver(schedule);
    observer.observe(document.documentElement,{childList:true,subtree:true});
    setTimeout(()=>{observer?.disconnect();observer=null;},120000);
  }
  void announce();
  const listener=(m,sender,reply)=>{
    if(sender.id!==chrome.runtime.id)return false;
    if(m?.type==='clw-background-probe'){
      void probe().then(reply).catch(()=>reply({stale:true,url:location.href,proof:null,page:null}));
      return true;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  globalThis.__clwBackgroundBridgeCleanup=()=>{
    observer?.disconnect();if(timer)clearTimeout(timer);
    chrome.runtime.onMessage.removeListener(listener);
    delete globalThis.__clwBackgroundBridgeInstalled;
  };
})();