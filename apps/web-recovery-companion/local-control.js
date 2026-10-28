/* Optional trusted-worker peer. Importing this file never starts network or tab work. */
(() => {
  'use strict';
  const BASE='http://127.0.0.1:18946';
  const PROFILE_KEY='clwLocalControlProfile',PEER_KEY='clwLocalControlPeer',RECEIPTS_KEY='clwLocalControlReceipts';
  const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CHAT=/^https:\/\/chatgpt\.com\/(?:g\/[A-Za-z0-9_-]{1,128}\/)?c\/[A-Za-z0-9-]{16,128}$/;
  const TYPES=new Set(['inspect','watch','unwatch','continue','send','reload','stop_generation','reload_extension','approve_tool']);
  const STATES=new Set(['completed','failed','unknown']);
  const BACKOFF=[5000,15000,30000],MAX_PENDING=16,MAX_SEEN=256,MAX_RESULT=65536;
  const INSPECTION_WAIT=10000,METADATA_WAIT=1500,READ_TIMEOUT=Object.freeze({});
  let execute=null,requested=false,task=null,current=null;
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
  const text=(x,max)=>typeof x==='string'&&x.length>0&&x.length<=max;
  const identifier=x=>text(x,128)&&/^[A-Za-z0-9_-]+$/.test(x);
  const token=x=>text(x,512)&&/^[A-Za-z0-9._~-]+$/.test(x);
  const byteLength=value=>new TextEncoder().encode(value).length;
  const literalText=value=>typeof value==='string'&&Array.from(value).length<=65536;
  const live=run=>requested&&current===run&&!run.cancelled;
  const requireLive=run=>{if(!live(run))throw Error('local_control_stopped');};
  const store=()=>chrome.storage.session;
  const bounded=value=>{
    try{
      const json=JSON.stringify(value);if(typeof json!=='string')return null;
      if(byteLength(json)>MAX_RESULT)return {code:'result_too_large'};
      const normalized=JSON.parse(json),stack=[[normalized,0]];let nodes=0;
      while(stack.length){
        const [item,depth]=stack.pop();
        if(depth>16||++nodes>8192)return {code:'result_structure_too_large'};
        if(object(item)&&Object.keys(item).some(k=>Array.from(k).length>256))return {code:'result_structure_too_large'};
        if(item!==null&&typeof item==='object')for(const child of Object.values(item))stack.push([child,depth+1]);
      }
      return normalized;
    }
    catch{return {code:'result_not_json'};}
  };
  const validReceipt=r=>exact(r,['peer_id','command_id','state','result'])&&identifier(r.peer_id)&&UUID.test(r.command_id)&&STATES.has(r.state)&&byteLength(JSON.stringify(r.result))<=MAX_RESULT;
  async function load(){
    // This random extension-owned identifier distinguishes Edge profiles sharing
    // an extension Origin. It reads no native browser profile information.
    let profileId=(await chrome.storage.local.get(PROFILE_KEY))[PROFILE_KEY];
    if(typeof profileId!=='string'||!UUID.test(profileId)){
      profileId=crypto.randomUUID();await chrome.storage.local.set({[PROFILE_KEY]:profileId});
    }
    const saved=await store().get([PEER_KEY,RECEIPTS_KEY]);
    let peer=saved[PEER_KEY];
    if(!exact(peer,['version','instance_nonce','peer_id','peer_token'])||peer.version!==1||!UUID.test(peer.instance_nonce)||!(peer.peer_id===null||identifier(peer.peer_id))||!(peer.peer_token===null||token(peer.peer_token))||(!peer.peer_id&&peer.peer_token)){
      peer={version:1,instance_nonce:crypto.randomUUID(),peer_id:null,peer_token:null};
      await store().set({[PEER_KEY]:peer});
    }
    const receipts=saved[RECEIPTS_KEY]??{version:1,pending:[],seen:[]};
    // Corrupt delivery records must never be silently reset and executed again.
    if(!exact(receipts,['version','pending','seen'])||receipts.version!==1||!Array.isArray(receipts.pending)||receipts.pending.length>MAX_PENDING||!receipts.pending.every(validReceipt)||!Array.isArray(receipts.seen)||receipts.seen.length>MAX_SEEN||!receipts.seen.every(id=>typeof id==='string'&&UUID.test(id)))throw Error('local_control_receipts_invalid');
    return {profileId,peer,receipts};
  }
  const savePeer=state=>store().set({[PEER_KEY]:state.peer});
  const saveReceipts=state=>store().set({[RECEIPTS_KEY]:state.receipts});
  async function clearPeer(state){state.peer={...state.peer,peer_id:null,peer_token:null};await savePeer(state);}
  function pause(run,ms){
    if(!live(run))return Promise.resolve();
    return new Promise(resolve=>{run.wake=resolve;run.timer=setTimeout(()=>{run.timer=null;run.wake=null;resolve();},ms);});
  }
  async function readWithin(operation,ms){
    let timer;
    try{
      // The losing read has no receipt callback. Its late result is ignored.
      return await Promise.race([Promise.resolve().then(operation),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(READ_TIMEOUT),ms);})]);
    }finally{clearTimeout(timer);}
  }
  async function post(run,path,body,peerToken=null,timeout=8000){
    requireLive(run);
    const controller=new AbortController();run.controller=controller;
    const timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const response=await fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json',...(peerToken?{'X-CLW-Peer':peerToken}:{})},body:JSON.stringify(body),credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
      requireLive(run);
      if(!response.ok){const error=Error('local_control_http');error.status=response.status;throw error;}
      const raw=await response.text();requireLive(run);
      if(byteLength(raw)>524288)throw Error('local_control_response_too_large');
      const data=JSON.parse(raw);
      if(!object(data)||data.success!==true)throw Error('local_control_response_invalid');
      return data;
    }finally{clearTimeout(timer);if(run.controller===controller)run.controller=null;}
  }
  async function pages(run){
    const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});requireLive(run);
    const selected=tabs.filter(t=>Number.isSafeInteger(t.id)&&t.id>=0&&typeof t.url==='string'&&CHAT.test(t.url)&&!t.pendingUrl).slice(0,32);
    const keys=selected.map(t=>'clwPageMonitorTab:'+t.id);
    const bindings=keys.length?await store().get(keys):{};requireLive(run);
    const result=await Promise.all(selected.map(async t=>{
      const b=bindings['clwPageMonitorTab:'+t.id];
      const enabled=object(b)&&b.tabId===t.id&&b.chatUrl===t.url;
      let documentId=null;
      // Obtain current top-document metadata before watch and after refresh.
      // Never wake a discarded/frozen/loading tab or substitute a stale binding.
      if(chrome.scripting?.executeScript&&!t.discarded&&!t.frozen&&t.status!=='loading'){
        try{
          const currentTab=await readWithin(()=>chrome.tabs.get(t.id),METADATA_WAIT);requireLive(run);
          if(currentTab.id===t.id&&currentTab.url===t.url&&!currentTab.pendingUrl&&!currentTab.discarded&&!currentTab.frozen&&currentTab.status!=='loading'){
            const frames=await readWithin(()=>chrome.scripting.executeScript({target:{tabId:t.id},func:()=>location.href}),METADATA_WAIT);requireLive(run);
            const frame=frames?.length===1?frames[0]:null;
            if(frame&&(!Object.hasOwn(frame,'frameId')||frame.frameId===0)&&frame.result===t.url&&text(frame.documentId,128))documentId=frame.documentId;
          }
        }catch{} // Unsupported/inaccessible metadata remains unknown, never cached.
      }
      return {tabId:t.id,url:t.url,documentId,enabled:!!enabled};
    }));
    requireLive(run);return result;
  }
  async function register(run,state){
    const data=await post(run,'/extension/register',{extension_version:chrome.runtime.getManifest().version,profile_id:state.profileId,instance_nonce:state.peer.instance_nonce,pages:await pages(run)});
    if(Object.keys(data).some(k=>!['success','approved','peer_id','peer_token','pairing_nonce'].includes(k))||typeof data.approved!=='boolean'||!identifier(data.peer_id)||(data.approved?!token(data.peer_token):!text(data.pairing_nonce,256)))throw Error('local_control_registration_invalid');
    state.peer={...state.peer,peer_id:data.peer_id,peer_token:data.approved?data.peer_token:null};await savePeer(state);
    return data.approved;
  }
  function validCommand(c){
    if(!exact(c,['id','type','tabId','chatUrl','documentId','payload'])||typeof c.id!=='string'||!UUID.test(c.id)||!TYPES.has(c.type)||!Number.isSafeInteger(c.tabId)||c.tabId<0||typeof c.chatUrl!=='string'||!CHAT.test(c.chatUrl)||!(c.documentId===null||text(c.documentId,256))||!object(c.payload))return false;
    if(c.type==='send')return exact(c.payload,['text'])&&literalText(c.payload.text);
    if(c.type==='continue')return exact(c.payload,[])||(exact(c.payload,['text'])&&literalText(c.payload.text));
    return exact(c.payload,[]);
  }
  const unreadable=(tab,code='page_not_readable')=>({state:'failed',result:{code,public_title:String(tab.title||'').slice(0,240),discarded:!!tab.discarded,frozen:!!tab.frozen,status:typeof tab.status==='string'?tab.status.slice(0,32):null}});
  async function inspect(run,c,tab){
    if(!tab.frozen)return readWithin(()=>execute(c),INSPECTION_WAIT);
    const windowId=tab.windowId;
    if(!Number.isSafeInteger(windowId)||!chrome.windows?.get||!chrome.tabs.update)return unreadable(tab);
    let original=null,activated=false,interacted=false;
    const focused=id=>{if(id===windowId)interacted=true;};
    const switched=info=>{if(info.windowId===windowId&&info.tabId!==tab.id)interacted=true;};
    chrome.windows.onFocusChanged?.addListener(focused);chrome.tabs.onActivated?.addListener(switched);
    try{
      const window=await readWithin(()=>chrome.windows.get(windowId),METADATA_WAIT);
      if(window.focused!==false)return unreadable(tab,'page_frozen_foreground_window');
      const active=await readWithin(()=>chrome.tabs.query({windowId,active:true}),METADATA_WAIT);
      if(active.length!==1||!Number.isSafeInteger(active[0].id))return unreadable(tab,'page_frozen_active_tab_unknown');
      original=active[0];
      const currentTab=await readWithin(()=>chrome.tabs.get(tab.id),METADATA_WAIT);
      const currentActive=await readWithin(()=>chrome.tabs.query({windowId,active:true}),METADATA_WAIT);
      const currentWindow=await readWithin(()=>chrome.windows.get(windowId),METADATA_WAIT);requireLive(run);
      if(currentWindow.focused!==false)return unreadable(tab,'page_frozen_foreground_window');
      if(interacted||currentActive.length!==1||currentActive[0].id!==original.id)return unreadable(tab,'page_frozen_user_interaction');
      if(currentTab.windowId!==windowId||currentTab.url!==c.chatUrl||currentTab.pendingUrl)return {state:'failed',result:{code:'tab_changed'}};
      if(currentTab.discarded||currentTab.status==='loading')return unreadable(currentTab);
      // Selecting a tab does not focus its window. No navigation or reload is used.
      await chrome.tabs.update(tab.id,{active:true});activated=true;
      return await readWithin(()=>execute(c),INSPECTION_WAIT);
    }finally{
      try{
        if(activated&&original.id!==tab.id&&!interacted){
          const prior=await readWithin(()=>chrome.tabs.get(original.id),METADATA_WAIT);
          const active=await readWithin(()=>chrome.tabs.query({windowId,active:true}),METADATA_WAIT);
          const window=await readWithin(()=>chrome.windows.get(windowId),METADATA_WAIT);
          if(!interacted&&window.focused===false&&prior.windowId===windowId&&active.length===1&&active[0].id===tab.id)await chrome.tabs.update(original.id,{active:true});
        }
      }catch{} // A closed/moved tab or unavailable window is never recreated or focused.
      finally{chrome.windows.onFocusChanged?.removeListener(focused);chrome.tabs.onActivated?.removeListener(switched);}
    }
  }
  async function command(run,state,c){
    if(!object(c)||typeof c.id!=='string'||!UUID.test(c.id))throw Error('local_control_command_id_invalid');
    if(state.receipts.seen.includes(c.id)||state.receipts.pending.some(r=>r.command_id===c.id))return;
    if(state.receipts.pending.length>=MAX_PENDING)throw Error('local_control_receipts_full');
    const receipt={peer_id:state.peer.peer_id,command_id:c.id,state:'unknown',result:{code:'execution_interrupted'}};
    state.receipts.pending.push(receipt);state.receipts.seen.push(c.id);
    state.receipts.seen=state.receipts.seen.slice(-MAX_SEEN);
    // Commit an uncertainty marker before any action. A rebuilt worker uploads this only.
    await saveReceipts(state);requireLive(run);
    if(!validCommand(c)){receipt.state='failed';receipt.result={code:'command_invalid'};}
    else{
      let tab=null;
      try{tab=await chrome.tabs.get(c.tabId);}catch{}
      requireLive(run);
      if(!tab||tab.id!==c.tabId||tab.url!==c.chatUrl||tab.pendingUrl){receipt.state='failed';receipt.result={code:'tab_changed'};}
      else if(!['unwatch','reload_extension'].includes(c.type)&&(tab.discarded||(tab.frozen&&c.type!=='inspect')||tab.status==='loading')){
        Object.assign(receipt,unreadable(tab));
      }
      else{
        try{
          const output=await (c.type==='inspect'?inspect(run,c,tab):execute(c));
          if(exact(output,['state','result'])&&STATES.has(output.state)){receipt.state=output.state;receipt.result=bounded(output.result);}
          else{receipt.state='unknown';receipt.result={code:'execution_result_invalid'};}
        }catch(error){
          if(error===READ_TIMEOUT){receipt.state='failed';receipt.result={code:'inspection_timeout'};}
          else{receipt.state='unknown';receipt.result={code:'execution_exception'};}
        }
      }
    }
    // Finish recording even if stop occurred while the executor was in flight.
    await saveReceipts(state);
  }
  async function flush(run,state){
    const pending=state.receipts.pending.filter(r=>r.peer_id===state.peer.peer_id).slice(0,4);
    for(const receipt of pending){
      await post(run,'/extension/result',receipt,state.peer.peer_token);
      state.receipts.pending=state.receipts.pending.filter(r=>r!==receipt);await saveReceipts(state);
    }
  }
  async function loop(run){
    const state=await load();let failures=0;
    while(live(run)){
      try{
        if(!state.peer.peer_token){
          if(!await register(run,state)){failures=0;await pause(run,2000);continue;}
        }
        await flush(run,state);requireLive(run);
        if(state.receipts.pending.length>=MAX_PENDING){await pause(run,5000);continue;}
        const since=Date.now();
        const data=await post(run,'/extension/poll',{peer_id:state.peer.peer_id,pages:await pages(run)},state.peer.peer_token,25000);
        if(!exact(data,['success','command'])||(data.command!==null&&!object(data.command)))throw Error('local_control_poll_invalid');
        if(data.command!==null){await command(run,state,data.command);await flush(run,state);}
        failures=0;
        // A healthy server holds an empty poll for 20s; guard against a fast empty server.
        await pause(run,Math.max(0,1000-(Date.now()-since)));
      }catch(error){
        if(!live(run))break;
        if([401,403,404].includes(error?.status))await clearPeer(state);
        await pause(run,BACKOFF[Math.min(failures++,BACKOFF.length-1)]);
      }
    }
  }
  function kick(){
    if(task||!requested)return;
    const run={cancelled:false,controller:null,timer:null,wake:null};current=run;
    task=loop(run).catch(()=>{requested=false;}).finally(()=>{task=null;if(current===run)current=null;if(requested)kick();});
  }
  function configure(options){
    if(!exact(options,['execute'])||typeof options.execute!=='function')throw Error('local_control_configuration_invalid');
    if(requested||task)throw Error('local_control_already_running');
    execute=options.execute;
  }
  function start(){
    if(!execute||!globalThis.chrome?.runtime?.id||!chrome.storage?.session)return;
    requested=true;kick();
  }
  function stop(){
    requested=false;
    if(current){current.cancelled=true;current.controller?.abort();if(current.timer!==null)clearTimeout(current.timer);current.timer=null;current.wake?.();current.wake=null;}
  }
  globalThis.CLWLocalControl=Object.freeze({configure,start,stop});
})();
