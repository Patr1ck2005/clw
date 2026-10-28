'use strict';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const {evaluate}=require('../web-host/page-input.cjs');
const {publicAccessLimit}=require('../web-host/account-access.cjs');
const SURFACE_URL='https://chatgpt.com/?temporary-chat=true';
const visibleComposer=String.raw`(() => {
 const u=new URL(location.href);
 const visible=e=>{const b=e.getBoundingClientRect(),s=getComputedStyle(e);return b.width>0&&b.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
 const editors=[...document.querySelectorAll('[data-testid="prompt-textarea"],#prompt-textarea,[contenteditable="true"][data-lexical-editor="true"],form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]')].filter(visible);
 const editor=editors.length===1?editors[0]:null;
 const controlsReady=!!editor&&(!editor.hasAttribute('data-composer-markdown')||[...editor.closest('form').querySelectorAll('button[aria-haspopup="menu"]')].some(e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'));
 return {supportedHome:u.origin==='https://chatgpt.com'&&u.pathname==='/'&&u.searchParams.get('temporary-chat')==='true',
   loginPage:u.origin==='https://chatgpt.com'&&['/auth/login','/auth/login/','/auth/signup','/auth/signup/'].includes(u.pathname),
   accessLimited:(${publicAccessLimit.toString()})(),
   composer:!!editor,controlsReady,emptyDocument:!(document.body?.innerText||'').trim(),
   login:[...document.querySelectorAll('[data-testid="login-button"],button,a')].some(e=>visible(e)&&
     (e.getAttribute?.('data-testid')==='login-button'||
      /^(?:log in|login|sign in|登录)$/i.test((e.getAttribute?.('aria-label')||e.innerText||'').trim())||
      /^\/auth\/login(?:\/|\?|$)/.test(e.getAttribute?.('href')||''))),
   accountLoadFailed:/无法加载你的账户|(?:unable to|could not|couldn't) load your account/i.test(document.body?.innerText||'')};
})()`;
async function prepareConnectorSurface(host,{timeoutMs=180000,blankReloadTimeoutMs=120000,delay=sleep,now=Date.now,readSurface=evaluate}={}){
 const contents=host.view.webContents;
 host.clearHomeNavigationTimeout();
 // This is only the bridge-owned empty surface. Never navigate an existing
 // research/game conversation or infer readiness from document.readyState.
 if(contents.getURL()!==SURFACE_URL)contents.loadURL(SURFACE_URL).catch(()=>{});
 let deadline=now()+timeoutMs,blankReloaded=false;
 let readySince=null,lastState;
 for(;;){
  if(now()>=deadline){
   // A blank, never-committed inspection document can stall on a slow link.
   // Retry only this empty surface once; never refresh login/error/content pages
   // or any task conversation, and never submit a message during this repair.
   if(!blankReloaded&&lastState?.emptyDocument){
    blankReloaded=true;deadline=now()+blankReloadTimeoutMs;readySince=null;
    contents.loadURL(SURFACE_URL).catch(()=>{});
   }else break;
  }
  if(contents.isDestroyed())throw Error('bridge_connector_surface_closed');
  let state,timer;
  try{
   // executeJavaScript waits for full load; reuse CLW's public-DOM inspection
   // channel so a pending font/image cannot hold startup past its deadline.
   state=await Promise.race([readSurface(contents,visibleComposer),new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error('bridge_surface_probe_timeout')),Math.min(1500,Math.max(1,deadline-now())));
   })]);
  }catch{}finally{clearTimeout(timer);}
  if(state)lastState=state;
  if(state?.accessLimited)throw Error('account_access_cooldown');
  if(state?.loginPage||(state?.supportedHome&&state.login))throw Error('bridge_login_required');
  if(state?.supportedHome&&state.accountLoadFailed)throw Error('bridge_account_load_failed');
  if(state?.supportedHome&&state.composer&&state.controlsReady!==false){
   readySince??=now();
   if(now()-readySince>=1500){
   // The connector helper still proves account access by selecting the actual
   // named app. This observation is not authentication or tool-execution proof.
   return {surfaceReady:true,connectorVerified:false};
   }
  }else readySince=null;
  await delay(500);
 }
 throw Error('bridge_connector_surface_not_ready');
}
module.exports={prepareConnectorSurface};
