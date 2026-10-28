/* Opt-in dedicated CLW window. Rotate known bound tabs, NEVER focus a window,
   create a model turn, reload a page, read other tabs, or bypass Send guards. */
(() => {
 'use strict';
 const STORAGE='clwManagedWindow',ALARM='clw-managed-window-rotation';
 const snapshot=async()=> (await chrome.storage.session.get(STORAGE))[STORAGE]||null;
 const save=async v=>chrome.storage.session.set({[STORAGE]:v});
 async function inspectTab(id){
  let timer;
  try{return await Promise.race([chrome.tabs.sendMessage(id,{type:'clw-pool-check'}),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1500);})]);}
  finally{clearTimeout(timer);}
 }
 const stable=tab=>tab&&!tab.discarded&&!tab.frozen&&!tab.pendingUrl&&tab.status!=='loading';
 let tickRunning=false,serial=Promise.resolve();
 const exclusive=fn=>{const next=serial.catch(()=>{}).then(fn);serial=next.catch(()=>{});return next;};
 async function join(tab,lookup){
  const bound=await lookup(tab.id);if(!bound||bound.chatUrl!==tab.url)throw Error('pool_exact_bound_tab_required');
  let p=await snapshot();
  if(p?.state==='creating'||p?.state==='unknown'||p?.state==='needs_attention')throw Error('pool_prior_window_effect_requires_reconciliation');
  if(p?.state==='active'){
   const window=await chrome.windows.get(p.windowId);
   if(window.type!=='normal')throw Error('pool_window_changed');
   if(p.tabs.includes(tab.id))return {managed:true,tab_count:p.tabs.length};
   if(p.tabs.length>=8)throw Error('pool_tab_limit');
   await save({...p,state:'moving',movingTab:tab.id});
   try{await chrome.tabs.move(tab.id,{windowId:p.windowId,index:-1});}
   catch(e){await save({...p,state:'unknown',movingTab:tab.id});throw e;}
   p={...p,tabs:[...p.tabs,tab.id]};
  }else{
   if(p?.state==='moving')throw Error('pool_prior_window_effect_requires_reconciliation');
   await save({state:'creating',tabs:[tab.id]});
   try{
    const window=await chrome.windows.create({tabId:tab.id,focused:false,type:'normal'});
    if(!Number.isInteger(window.id))throw Error('pool_window_identity_missing');
    p={windowId:window.id,tabs:[tab.id],cursor:0};
   }catch(e){await save({state:'unknown',tabs:[tab.id]});throw e;}
  }
  p.state='active';await save(p);
  await chrome.alarms.create(ALARM,{periodInMinutes:0.5});
  return {managed:true,tab_count:p.tabs.length,window_focus_changed:false,model_created:false};
 }
 async function halt(){await save({state:'stopped',tabs:[]});await chrome.alarms.clear(ALARM);return {stopped:true,tabs_closed:false,models_interrupted:false};}
 async function rotate(lookup){
  if(tickRunning)return;tickRunning=true;
  try{
   const p=await snapshot();if(!p||p.state!=='active')return;
   const window=await chrome.windows.get(p.windowId);
   if(window.focused||window.state==='minimized')return;
   const inWindow=await chrome.tabs.query({windowId:p.windowId});
   if(inWindow.some(t=>!p.tabs.includes(t.id)))return; // User added an unrelated tab.
   const active=inWindow.find(t=>t.active);
   if(active){
    const current=await chrome.tabs.get(active.id),binding=await lookup(active.id);
    if(!binding||current.url!==binding.chatUrl||!stable(current))return;
    const check=await inspectTab(active.id);
    if(!check||check.closed||check.busy||!check.page?.controls_known||['draft','focused','composing','stopped','blocked'].some(k=>check.page[k]))return;
   }
   const start=active?p.tabs.indexOf(active.id):-1;
   for(let step=1;step<=p.tabs.length;step++){
    const id=p.tabs[(start+step)%p.tabs.length],binding=await lookup(id);
    if(!binding)continue;
    const tab=await chrome.tabs.get(id);
    if(tab.windowId!==p.windowId||tab.url!==binding.chatUrl||!stable(tab))continue;
    const check=await inspectTab(id);
    if(!check||check.closed||['draft','focused','composing','stopped','blocked'].some(k=>check.page?.[k]))continue;
    const currentWindow=await chrome.windows.get(p.windowId),currentTab=await chrome.tabs.get(id);
    if(currentWindow.focused||currentWindow.state==='minimized')return;
    if(currentTab.windowId!==p.windowId||currentTab.url!==binding.chatUrl||!stable(currentTab))continue;
    await chrome.tabs.update(id,{active:true});
    await save({...p,cursor:(start+step)%p.tabs.length});break;
   }
  }catch{const p=await snapshot();if(p?.state==='active')await save({...p,state:'needs_attention'});}
  finally{tickRunning=false;}
 }
 async function restore(){
  const p=await snapshot();
  if(p?.state==='active'&&chrome.alarms.get&&!await chrome.alarms.get(ALARM))await chrome.alarms.create(ALARM,{periodInMinutes:0.5});
 }
 globalThis.CLWManagedWindow=Object.freeze({join:(...a)=>exclusive(()=>join(...a)),halt:()=>exclusive(halt),rotate:(...a)=>exclusive(()=>rotate(...a)),restore:()=>exclusive(restore),ALARM,snapshot});
})();
