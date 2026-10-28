'use strict';
const ORIGIN='https://chatgpt.com';
class VerificationError extends Error{constructor(){super('history_verification_unavailable');this.code=this.message;}}
function reject(){throw new VerificationError();}
function targetFor(account,stage){
  if(!['A','B'].includes(account)||!['auth','auth_recheck','list','detail'].includes(stage))reject();
  // A normal browser navigation has no Bearer header and may say Unauthorized.
  // It still lets the user complete browser verification without ever opening
  // the session endpoint, whose JSON can expose the account's access token.
  return ORIGIN+'/backend-api/conversations?offset=0&limit=100&order=updated';
}
function allowedNavigation(value){try{const u=new URL(value);return u.origin===ORIGIN&&!u.username&&!u.password;}catch{return false;}}
function createHistoryVerification({BrowserWindow,guard,partitionForAccount,onFailure=()=>{}}={}){
  if(typeof BrowserWindow!=='function'||typeof guard?.protect!=='function'||typeof partitionForAccount!=='function'||typeof onFailure!=='function')reject();
  const windows=new Map();let disposed=false;
  const receipt=account=>({account,state:'verification_opened',model_sends:0});
  function close(entry){
    if(windows.get(entry.account)===entry)windows.delete(entry.account);
    try{if(!entry.window.isDestroyed())entry.window.destroy();}catch{}
  }
  function loadFailed(entry){
    if(disposed||entry.failureNotified||windows.get(entry.account)!==entry||entry.window.isDestroyed())return;
    entry.failureNotified=true;close(entry);
    try{onFailure({account:entry.account,code:'history_verification_load_failed'});}catch{}
  }
  function show(entry){
    if(disposed||windows.get(entry.account)!==entry||entry.window.isDestroyed())reject();
    if(entry.window.isMinimized?.())entry.window.restore();entry.window.show();entry.window.focus();return receipt(entry.account);
  }
  async function open(account,stage){
    const target=targetFor(account,stage);if(disposed||guard.ready!==true)reject();
    const current=windows.get(account);
    if(current&&!current.window.isDestroyed()){
      try{await current.opening;return show(current);}catch{reject();}
    }
    let entry;
    try{
      const partition=partitionForAccount(account);if(typeof partition!=='string'||!partition)reject();
      const window=new BrowserWindow({width:900,height:680,minWidth:650,minHeight:420,show:false,autoHideMenuBar:true,
        title:'CLW · 账号 '+account+' 网页验证',webPreferences:{partition,sandbox:true,nodeIntegration:false,contextIsolation:true}});
      entry={account,window,opening:null,failureNotified:false};windows.set(account,entry);
      window.on('closed',()=>{if(windows.get(account)===entry)windows.delete(account);});
      const contents=window.webContents;
      contents.setWindowOpenHandler(()=>({action:'deny'}));
      const navigate=(event,url)=>{if(!allowedNavigation(url||event?.url))event.preventDefault();};
      contents.on('will-navigate',navigate);contents.on('will-redirect',navigate);
      // The original account partition retains its own cookies. Protect it
      // before any remote load; never change the guard's fixed proxy/permissions.
      entry.opening=(async()=>{
        try{
          await guard.protect(contents.session);
          if(disposed||guard.ready!==true||windows.get(account)!==entry||window.isDestroyed())reject();
          guard.protectContents?.(contents);
          const loading=window.loadURL(target);
          // Loading/verification must not occupy the app's command channel.
          // A load failure only closes this separate window; no response body,
          // credential or guessed verification result is returned or recorded.
          void Promise.resolve(loading).catch(()=>loadFailed(entry));
          return show(entry);
        }catch{close(entry);reject();}
      })();
      const result=await entry.opening;
      // An already-rejected load settles before this continuation. Preserve
      // the nonblocking load, but never report a window it has already closed.
      if(disposed||windows.get(account)!==entry||entry.window.isDestroyed())reject();
      return result;
    }catch{if(entry)close(entry);reject();}
  }
  function dispose(){if(disposed)return;disposed=true;for(const entry of [...windows.values()])close(entry);windows.clear();}
  return {open,dispose};
}
module.exports={createHistoryVerification};
