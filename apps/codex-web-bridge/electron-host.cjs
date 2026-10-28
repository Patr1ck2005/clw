'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),http=require('node:http');
const {spawn}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const {createNativeMaintenanceExit,waitNormalChildExit}=require('./native-maintenance-exit.cjs');
const {settleNativeStartupFailure}=require('./native-startup-cleanup.cjs');
const cfg=require('./bridge-config.cjs');
const {writePrivateFileAtomic}=require('./upstream/launcher/electron/atomic-file.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
function localJson(url,method='GET',body,token,{maintenance=false}={}){
  const u=new URL(url);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')return Promise.reject(Error('bridge_local_only'));
  return new Promise((resolve,reject)=>{const raw=body===undefined?null:Buffer.from(JSON.stringify(body));
    const req=http.request(u,{method,timeout:5000,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(raw?{'Content-Type':'application/json','Content-Length':raw.length}:{})}},res=>{
      let text='';res.on('data',x=>{text+=x;if(text.length>1048576)req.destroy(Error('bridge_response_too_large'));});
      res.on('end',()=>{try{if(res.statusCode!==200&&!(maintenance&&res.statusCode===409))throw Error('bridge_http_'+res.statusCode);
        let value;try{value=JSON.parse(text);}catch{throw Error('bridge_response_invalid');}
        if(res.statusCode!==200&&!(value.status==='refused'&&/^native_maintenance_[a-z_]+$/.test(value.code||'')))throw Error('bridge_http_'+res.statusCode);resolve(value);}catch(e){reject(e);}});
    });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('bridge_local_timeout')));req.end(raw);
  });
}
const NATIVE_PHASES=new Set(['queued','delivered','result','error','retired']);
const NATIVE_TOOLS=new Set(['exec_command','shell_command','write_stdin','apply_patch','view_image','exec_gateway','other']);
function nativeActivityEvent(value){
  if(!value||typeof value!=='object'||value.version!==1||!Number.isSafeInteger(value.eventId)||value.eventId<1||
     !Number.isSafeInteger(value.atMs)||value.atMs<1||typeof value.traceId!=='string'||
     !/^([0-9a-f]{12}|trace_hash_[0-9a-f]{32})$/.test(value.traceId)||
     typeof value.callId!=='string'||!/^call_[A-Za-z0-9_-]{16,128}$/.test(value.callId)||
     !NATIVE_PHASES.has(value.phase)||!NATIVE_TOOLS.has(value.tool))
    throw Error('native_activity_invalid_event');
  // Never forward unknown fields supplied by the HTTP peer.
  return {eventId:value.eventId,atMs:value.atMs,traceId:value.traceId,callId:value.callId,phase:value.phase,tool:value.tool};
}
function createNativeActivityProjection(endpoint,token,{maxEvents=160,pollMs=2500}={}){
  if(!Number.isInteger(maxEvents)||maxEvents<1||maxEvents>256||!Number.isInteger(pollMs)||pollMs<100||pollMs>60000)
    throw Error('native_activity_projection_bounds_invalid');
  let events=[],cursor=0,oldestEventId=null,latestEventId=null,windowTruncated=false,
    readFailed=false,unavailable=false,loading=true,lastReadAtMs=null,initialized=false,inflight=null,timer=null,stopped=false;
  const snapshot=()=>({source:'native_broker_metadata',history:'recent_window',events:events.slice(),cursor,
    oldestEventId,latestEventId,windowTruncated,readFailed,unavailable,loading,lastReadAtMs,
    backlog:latestEventId!==null&&cursor<latestEventId});
  async function poll(){
    if(stopped||inflight)return inflight;
    inflight=(async()=>{
      try{
        const query=initialized?`afterEventId=${cursor}&limit=${maxEvents}`:`recent=1&limit=${maxEvents}`;
        const page=await localJson(endpoint+'/admin/native-tool-activity?'+query,'GET',undefined,token);
        if(stopped)return;
        if(!page||!Array.isArray(page.events)||typeof page.windowTruncated!=='boolean'||
           !(page.oldestEventId===null||(Number.isSafeInteger(page.oldestEventId)&&page.oldestEventId>0))||
           !(page.latestEventId===null||(Number.isSafeInteger(page.latestEventId)&&page.latestEventId>0))||
           (page.oldestEventId===null)!==(page.latestEventId===null)||
           (page.oldestEventId!==null&&page.oldestEventId>page.latestEventId)||
           page.events.length>maxEvents)throw Error('native_activity_invalid_page');
        const received=page.events.map(nativeActivityEvent);
        for(let index=1;index<received.length;index++){
          if(received[index].eventId<=received[index-1].eventId)throw Error('native_activity_unordered_page');
        }
        if(received.length>0&&(page.oldestEventId===null||received[0].eventId<page.oldestEventId||
           received.at(-1).eventId>page.latestEventId))throw Error('native_activity_invalid_page');
        if(initialized&&cursor>0&&(page.latestEventId===null||page.latestEventId<cursor)){
          // The journal was reset or replaced. Keep the gap visible and rebuild from a recent window.
          events=[];cursor=0;oldestEventId=null;latestEventId=null;initialized=false;windowTruncated=true;
          throw Error('native_activity_cursor_reset');
        }
        if(page.windowTruncated||(!initialized&&received.length>0&&received[0].eventId>page.oldestEventId)||
           (initialized&&received.length>0&&received[0].eventId>cursor+1))windowTruncated=true;
        if(page.oldestEventId!==null&&page.oldestEventId>1)windowTruncated=true;
        for(const event of received){if(event.eventId>cursor){events.push(event);cursor=event.eventId;}}
        if(events.length>maxEvents){events=events.slice(-maxEvents);windowTruncated=true;}
        oldestEventId=page.oldestEventId;latestEventId=page.latestEventId;
        lastReadAtMs=Date.now();readFailed=false;unavailable=false;loading=false;initialized=true;
      }catch{
        if(!stopped){readFailed=true;unavailable=!initialized;loading=false;}
      }
    })();
    try{return await inflight;}finally{inflight=null;}
  }
  function start(){if(stopped||timer)return;void poll();timer=setInterval(()=>{void poll();},pollMs);timer.unref?.();}
  function stop(){stopped=true;if(timer){clearInterval(timer);timer=null;}}
  return {poll,start,stop,snapshot};
}
function createListenerSupervisor({executable,script,publicPort,ownerPort,cwd,env,onState=()=>{},
  ownerPid,restartDelays=[250,500,1000,2000,4000],readyTimeoutMs=5000,stableAfterMs=30000}){
  let child=null,restartTimer=null,stableTimer=null,closed=false,failures=0,state='stopped',maintenanceIntent=null;
  const report=(next,extra={})=>{state=next;onState({state,pid:child?.pid||null,...extra});};
  const snapshot=()=>({state,pid:child?.pid||null,failures});
  function schedule(){
    if(closed||maintenanceIntent)return;
    if(failures>=restartDelays.length){report('failed');return;}
    const delayMs=restartDelays[failures++];
    report('restarting',{delayMs});
    restartTimer=setTimeout(()=>{restartTimer=null;void launch(false).catch(()=>{});},delayMs);
    restartTimer.unref?.();
  }
  function launch(initial){
    if(closed)return Promise.reject(Error('bridge_listener_closed'));
    if(child&&child.exitCode===null&&!child.signalCode)return Promise.reject(Error('bridge_listener_original_start_unresolved'));
    return new Promise((resolve,reject)=>{
      const capability=randomBytes(32).toString('hex');
      const next=spawn(executable,[script,String(publicPort),String(ownerPort),...(ownerPid?[String(ownerPid)]:[])],
        {cwd,env:{...env,CLW_LISTENER_PARENT_CAPABILITY:capability},windowsHide:true,stdio:['pipe','pipe','pipe']});
      next.listenerCapability=capability;
      next.stdin.on('error',()=>{});
      child=next;report('starting');
      let ready=false,settled=false,output='',readinessFailed=false;
      const settle=(error)=>{if(settled)return;settled=true;error?reject(error):resolve(next);};
      const failReady=code=>{if(ready||readinessFailed)return;readinessFailed=true;clearTimeout(timeout);try{report('startup_unresolved');}catch{}settle(Error(code));};
      // A missing READY receipt does not prove this listener never accepted a
      // stream. Retain its original process and private shutdown capability.
      const timeout=setTimeout(()=>failReady('bridge_listener_start_timeout'),readyTimeoutMs);
      next.stdout.on('data',chunk=>{
        if(ready||readinessFailed)return;
        output+=chunk.toString('utf8');
        if(output.length>4096){failReady('bridge_listener_invalid_ready');return;}
        const end=output.indexOf('\n');if(end<0)return;
        try{
          const message=JSON.parse(output.slice(0,end));
          if(message.ready!==true||message.pid!==next.pid||message.port!==publicPort)
            throw Error('bridge_listener_invalid_ready');
          ready=true;clearTimeout(timeout);report('ready');
          stableTimer=setTimeout(()=>{failures=0;},stableAfterMs);stableTimer.unref?.();
          settle();
        }catch{failReady('bridge_listener_invalid_ready');}
      });
      next.stderr.resume();
      next.once('error',error=>{clearTimeout(timeout);settle(error);});
      next.once('close',()=>{
        clearTimeout(timeout);clearTimeout(stableTimer);stableTimer=null;
        if(child===next)child=null;
        if(!ready)settle(Error('bridge_listener_stopped_before_ready'));
        if(!closed){report('stopped');if(ready||!initial)schedule();}
      });
    });
  }
  async function stop(){
    if(closed)return;closed=true;clearTimeout(restartTimer);clearTimeout(stableTimer);
    const active=child;
    if(active){
      const ended=new Promise(resolve=>{active.once('close',resolve);setTimeout(resolve,2000).unref?.();});
      active.kill();await ended;
    }
    report('stopped');
  }
  function prepareMaintenance({operationId,ownerPid:expectedOwnerPid}){
    if(expectedOwnerPid!==ownerPid||!child||!['ready','startup_unresolved'].includes(state)||closed)throw Error('native_maintenance_listener_unknown');
    if(maintenanceIntent){if(maintenanceIntent.operationId!==operationId||maintenanceIntent.child!==child)throw Error('native_maintenance_listener_changed');return {pid:child.pid};}
    maintenanceIntent={operationId,child,dispatched:false};clearTimeout(restartTimer);clearTimeout(stableTimer);
    return {pid:child.pid};
  }
  async function stopMaintenance({operationId,ownerPid:expectedOwnerPid,timeoutMs}){
    const intent=maintenanceIntent;
    if(!intent||intent.operationId!==operationId||expectedOwnerPid!==ownerPid)throw Error('native_maintenance_listener_unknown');
    const original=intent.child;
    if(!intent.dispatched){
      if(child!==original||original.exitCode!==null||original.signalCode||original.stdin.destroyed)throw Error('native_maintenance_listener_changed');
      intent.dispatched=true;
      // Retain the key before writing. An ACK/exit timeout does not replay or kill.
      original.stdin.write(JSON.stringify({kind:'native_listener_shutdown',listenerPid:original.pid,ownerPid,operationId,capability:original.listenerCapability})+'\n',()=>{});
    }
    const receipt=await waitNormalChildExit(original,timeoutMs);closed=true;report('stopped');return receipt;
  }
  function resumeMaintenance(operationId){
    if(!maintenanceIntent)return;
    if(maintenanceIntent.operationId!==operationId||maintenanceIntent.dispatched)throw Error('native_maintenance_listener_original_operation_required');
    maintenanceIntent=null;
  }
  return {start:()=>launch(true),stop,snapshot,prepareMaintenance,stopMaintenance,resumeMaintenance};
}
function createRuntimeFailureState(onFailure=()=>{}){
  let failure=null;
  const fail=state=>{if(failure)return;failure=state;onFailure();};
  return {
    watch:child=>{child.once('error',()=>fail('runtime_failed'));child.once('exit',()=>fail('runtime_stopped'));},
    get failed(){return failure!==null;},
    apply:status=>failure?{...status,state:failure,lastError:'bridge_owner_unavailable',automaticReplay:false}:status,
  };
}
function canReverifyTools({status,tools,closed,runtimeFailed,accessBlocked}){
  return !closed&&!runtimeFailed&&!accessBlocked&&tools.ready===true&&
    status.state==='tool_service_unavailable'&&status.lastError==='bridge_tool_discovery_unavailable';
}
async function configure(app,root){
  const selected=cfg.settings(root);if(!selected.enabled)return null;
  cfg.validateTunnel(root,selected.tunnel,{shared:selected.transport==='shared-mcp'});
  const cdpPort=await freePort();app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');app.commandLine.appendSwitch('remote-debugging-port',String(cdpPort));
  return {selected,cdpPort};
}
async function start({root,window,guard,configured,accountAccess=new (require('../web-host/account-access.cjs').AccountAccess)(root)}){
  const account=cfg.webAccount(configured.selected,root),network=guard.options||{mode:'legacy',proxyUrl:cfg.PROXY};
  const p=cfg.paths(root),env={...cfg.isolatedEnvironment(root,undefined,network),CLW_WEB_ACCOUNT:account},logs=path.join(p.home,'activity.jsonl');fs.mkdirSync(p.home,{recursive:true});
  const mcpActivity=require('./mcp-activity.cjs').createActivityProjection(p.home);
  const activitySnapshot=()=>configured.selected.transport==='shared-mcp'?mcpActivity():null;
  // The verification helper is spawned by the embedded upstream host. Keep its
  // local config/diagnostics in this application, as for the server child.
  process.env.CODEX_CHATGPT_WEB_HOME=p.home;
  const logger=Object.fromEntries(['info','warn','error','debug'].map(level=>[level,(event,data={})=>{
    // No prompt, tool arguments, browser auth or connector capabilities in support logs.
    const safe={at:new Date().toISOString(),level,event};for(const key of ['port','traceId','status'])if(data[key]!==undefined)safe[key]=data[key];
    fs.appendFileSync(logs,JSON.stringify(safe)+'\n');
  }]));
  let host,control,serverChild,listenerSupervisor,tunnelChild,closed=false,journal,verification=null,verificationTicket=null,accessMonitor,maintenanceController,maintenanceProof=null,maintenanceExit=null,maintenanceClosePromise=null,maintenanceExitReceipt=null;
  const maintenanceObservers=new Set();
  const emitMaintenanceExit=receipt=>{if(maintenanceExitReceipt===receipt)return;maintenanceExitReceipt=receipt;for(const callback of maintenanceObservers)try{callback(receipt);}catch{}};
  const maintenanceMethods={
    prepareMaintenance:async()=>{if(!maintenanceController)throw Error('native_maintenance_owner_unavailable');maintenanceProof=await maintenanceController.prepareMaintenance();return maintenanceProof;},
    verifyMaintenance:async proof=>{if(!maintenanceController)throw Error('native_maintenance_owner_unavailable');maintenanceProof=await maintenanceController.verifyMaintenance(proof);return maintenanceProof;},
    finalVerifyMaintenance:proof=>{if(!maintenanceController||proof!==maintenanceProof)throw Error('native_maintenance_original_fence_required');return maintenanceController.finalVerifyMaintenance(proof);},
    resumeMaintenance:async proof=>{if(maintenanceExit?.shutdownDispatched)throw Error('native_maintenance_shutdown_original_unresolved');if(!maintenanceController)throw Error('native_maintenance_owner_unavailable');const receipt=await maintenanceController.resumeMaintenance(proof);listenerSupervisor?.resumeMaintenance(receipt.fenceId);maintenanceProof=null;return receipt;},
    onMaintenanceExit:callback=>{if(typeof callback!=='function')throw Error('native_maintenance_observer_invalid');maintenanceObservers.add(callback);if(maintenanceExitReceipt)queueMicrotask(()=>{if(maintenanceObservers.has(callback))callback(maintenanceExitReceipt);});return ()=>maintenanceObservers.delete(callback);},
  };
  const toolCheck=require('./tool-readiness.cjs').createToolCheck(root,{transport:configured.selected.transport});
  const accessSnapshot=()=>accountAccess.snapshot();
  const publicLimit='('+require('../web-host/account-access.cjs').publicAccessLimit.toString()+')()';
  async function observeAccess(contents){
    if(!contents||contents.isDestroyed()||!contents.getURL().startsWith('https://chatgpt.com/'))return false;
    let timer;
    try{const limited=await Promise.race([require('../web-host/page-input.cjs').evaluate(contents,publicLimit),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('access_observation_timeout')),1500);})]);if(limited)accountAccess.hold();return limited;}
    catch{return false;}finally{clearTimeout(timer);}
  }
  const port=await freePort();
  let ownerPort=await freePort();while(ownerPort===port)ownerPort=await freePort();
  const config=cfg.runtimeConfig(root,configured.selected,ownerPort);
  const endpoint='http://127.0.0.1:'+port,ownerEndpoint='http://127.0.0.1:'+ownerPort;
  const nativeActivity=createNativeActivityProjection(ownerEndpoint,config.controlToken);
  const runtimeFailure=createRuntimeFailureState(()=>{if(!maintenanceExit?.shutdownDispatched){journal?.ownerClosed('native_owner_closed');publish();}else publishMaintenanceStatus();});
  const publish=()=>writePrivateFileAtomic(p.status,JSON.stringify({at:new Date().toISOString(),pid:process.pid,endpoint:endpoint+'/v1',
    state:closed?'stopped':'starting',account,connector:config.appName,transport:configured.selected.transport||'dedicated',proxy:network.proxyUrl||null,networkMode:network.mode,officialQuota:false,
    ...(closed?status:runtimeFailure.apply(status)),tools:toolCheck.snapshot()})+'\n');
  let status={account};
  const publishMaintenanceStatus=()=>{try{publish();return true;}catch{status={...status,supportStatusUnavailable:true};return false;}};
  function verify(){
    // Multiple projects share one account check; they must not independently
    // type mentions, refresh the home page or overwrite each other's result.
    if(verification)return verification;
    verification=require('./connector-verification.cjs').verifyWithRecovery(verifyOnce,{
      stopped:()=>closed||!guard.ready||runtimeFailure.failed,
      onRetry:retry=>{status={...status,state:'connector_verification_retrying',verificationRetry:retry};publish();}
    }).finally(()=>{verification=null;});return verification;
  }
  async function verifyOnce(){
    if(closed||!host||!guard.ready||runtimeFailure.failed)throw Error('bridge_not_available');
    const tools=await toolCheck.check({fresh:true});
    if(runtimeFailure.failed)throw Error('bridge_owner_unavailable');
    if(!tools.ready){status={...status,state:'tool_service_unavailable',lastError:'bridge_tool_discovery_unavailable'};publish();throw Error(tools.message);}
    const ticket=accountAccess.beginCheck();
    verificationTicket=ticket;
    status={...status,state:'verifying_connector',lastError:null};publish();
    try{
      if(await observeAccess(host.view.webContents))throw Error('account_access_cooldown');
      if(runtimeFailure.failed)throw Error('bridge_owner_unavailable');
      const result=await host.verifyConnector(config.appName);
      if(runtimeFailure.failed)throw Error('bridge_owner_unavailable');
      if(await observeAccess(host.view.webContents))throw Error('account_access_cooldown');
      accountAccess.verified(ticket);
      status={...status,state:'ready',connectorVerifiedAt:new Date().toISOString(),liveWebAcceptance:false};publish();
      writePrivateFileAtomic(path.join(p.home,'connector-proof.json'),JSON.stringify({at:status.connectorVerifiedAt,account,ownerPid:process.pid,runtimePid:serverChild.pid,endpoint:endpoint+'/v1',connector:config.appName,result,modelSends:0})+'\n');
      return {connector:config.appName,verified:true,modelCalled:false,result};
    }catch(e){
      if(e.message==='account_access_cooldown')accountAccess.hold();
      accountAccess.checkFailed();
      const known=['bridge_login_required','bridge_account_load_failed','bridge_connector_surface_not_ready'];
      status={...status,state:'connector_verification_required',lastError:known.includes(e.message)?e.message:'bridge_connector_verification_failed'};
      publish();throw e;
    }finally{verificationTicket=null;}
  }
  const {BrowserControlServer}=require('./upstream/launcher/electron/control-server.cjs');
  const {BrowserHost}=require('./upstream/launcher/electron/browser-host.cjs');
  const requireJournal=()=>{if(!journal)throw Error('native_owner_startup_unresolved');return journal;};
  // Retain this exact owner object if initialization cannot safely clean up.
  // Display metadata may be unavailable; action reads must never become empty idle proof.
  const originalOwner={get host(){return host;},close,verify,...maintenanceMethods,endpoint,
    turn:traceId=>requireJournal().get(traceId),turns:()=>requireJournal().list({strict:true}),history:request=>requireJournal().history(request),
    recordIndex:request=>requireJournal().recordIndex(request),index:request=>requireJournal().recordIndex(request),checkTools:()=>toolCheck.check({fresh:true}),
    snapshot:()=>{const cached=journal?journal.cachedList():{rows:[],status:{unavailable:true,errorCode:'native_owner_startup_unresolved'}};return {...runtimeFailure.apply(status),tools:toolCheck.snapshot(),accountAccess:accessSnapshot(),endpoint:endpoint+'/v1',recent:cached.rows,displayIndex:cached.status,mcpActivity:activitySnapshot(),nativeActivity:nativeActivity.snapshot()};},health:()=>localJson(endpoint+'/healthz')};
  async function close(){
    if(closed)return maintenanceExitReceipt|| (maintenanceExit?maintenanceExit.close():undefined);
    if(maintenanceProof){
      if(maintenanceClosePromise)return maintenanceClosePromise;
      if(!maintenanceExit){maintenanceExit=createNativeMaintenanceExit({child:serverChild,listener:listenerSupervisor,hasOwnedTunnel:()=>!!tunnelChild,
        getProof:()=>maintenanceProof,verify:maintenanceMethods.verifyMaintenance,finalVerify:maintenanceMethods.finalVerifyMaintenance,
        shutdown:identity=>localJson(ownerEndpoint+'/admin/shutdown','POST',{operationId:identity.fenceId,expectedPid:identity.runtimePid,expectedOwnerEpoch:identity.ownerEpoch,expectedNativeTurns:maintenanceProof.nativeTurns},config.controlToken,{maintenance:true})});
        maintenanceExit.onSettlement(receipt=>{if(receipt?.state==='exited')queueMicrotask(()=>{void close().catch(()=>{});});else emitMaintenanceExit(receipt);});}
      maintenanceClosePromise=(async()=>{const receipt=await maintenanceExit.close();
      try{nativeActivity.stop();clearInterval(accessMonitor);host?.destroy();await control.close();}
      catch{const error=Error('native_maintenance_local_cleanup_unknown');error.maintenanceClose={...receipt,state:'unknown',stage:'shutdown_dispatched'};throw error;}
      closed=true;status={state:'stopped'};const published=publishMaintenanceStatus(),finalReceipt=published?receipt:Object.freeze({...receipt,supportStatusPublished:false});emitMaintenanceExit(finalReceipt);return finalReceipt;})().finally(()=>{maintenanceClosePromise=null;});return maintenanceClosePromise;
    }
    const error=Error('native_maintenance_original_fence_required');
    error.maintenanceClose={version:1,kind:'native_maintenance_exit',state:'refused',runtimePid:serverChild?.pid??null,
      ownerEpoch:null,fenceId:null,stage:'before_shutdown',shutdownDispatched:false};throw error;
  }
  try{
    if(!fs.existsSync(p.helper)||!fs.existsSync(p.bun))throw Error('bridge_build_required');
    if(!guard.ready)throw Error(network.mode==='legacy'?'bridge_vpn_not_verified':'bridge_network_not_ready');
    control=new BrowserControlServer({logger,getBrowserHost:()=>host,getPreferences:()=>({showBrowserDuringTurns:false}),
      resolveProxy:async url=>{
        if(!guard.ready)throw Error('网页网络设置尚未应用。');
        const ses=host?.view?.webContents?.session;if(!ses)throw Error('网页网络会话尚未准备好。');
        return guard.resolveProxy(ses,url);
      }});
    await control.start();
    host=new BrowserHost({window,descriptorPath:p.descriptor,cdpPort:configured.cdpPort,control:control.descriptor(),
      cancelTurn:(traceId,reason)=>localJson(ownerEndpoint+'/admin/cancel-turn','POST',{traceId,...(reason?{reason}:{})},config.controlToken),
      getConnectorName:()=>config.appName,helper:{executable:process.execPath,script:p.helper},logger,
      loginWithPasskey:async()=>{throw Error('请在账号 '+account+' 登录页完成本人登录。');},partition:'persist:clw-account-'+account.toLowerCase(),profile:'production',
      getUseSavedChats:()=>true,publishState:s=>{status={...status,browser:s};publish();},showWindow:()=>window.show()});
    await host.ready();
    // The hidden native carrier also needs measured bounds before UI checks;
    // its current shell may never display the upstream browser panel.
    const [width,height]=window.getContentSize();
    host.setBounds({x:0,y:0,width,height});
    if(guard.protect&&host.view?.webContents?.session)await guard.protect(host.view.webContents.session);
    journal=require('./turn-journal.cjs').installTurnJournal(host,p.home,{account});
    const beginTurn=host.beginTurn.bind(host);
    host.beginTurn=async(...args)=>{await accountAccess.admitNavigation();return beginTurn(...args);};
    let observing=false;
    accessMonitor=setInterval(async()=>{
      if(observing||closed)return;observing=true;
      try{await Promise.all([toolCheck.check().then(async tools=>{
        publish();
        if(canReverifyTools({status,tools,closed,runtimeFailed:runtimeFailure.failed,accessBlocked:accessSnapshot().blocked})){
          // One connector check after local service recovery; never a model
          // send. A login/platform/verification failure remains user-visible.
          await verify().catch(()=>{});
        }
      }),...[host.view.webContents,...[...host.turnTabs.values()].map(t=>t.view.webContents)].map(observeAccess)]);}
      finally{observing=false;}
    },10000);accessMonitor.unref?.();
    // Keep the upstream empty Temporary Chat inspection surface: its helper
    // enables Personalized connector access and verifies the exact identity.
    // Wait for the visible composer, not every slow subresource or a 60 s load
    // promise. Actual work still uses saved conversations via getUseSavedChats.
    host.refreshChatGptHomeDocument=async()=>{await accountAccess.admitNavigation({checkTicket:verificationTicket});return require('./connector-surface.cjs').prepareConnectorSurface(host);};
    require('./home-navigation.cjs').installSlowNavigationNotice(host);
    writePrivateFileAtomic(p.config,JSON.stringify(config,null,2)+'\n');
    serverChild=spawn(p.bun,['run',path.join(__dirname,'serve.ts')],{cwd:p.upstream,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    serverChild.stdout.resume();serverChild.stderr.resume();
    runtimeFailure.watch(serverChild);
    maintenanceController=require('./native-maintenance.cjs').createNativeMaintenanceController({runtimePid:serverChild.pid,home:p.home,account,
      request:(route,method,body)=>localJson(ownerEndpoint+route,method,body,config.controlToken,{maintenance:true})});
    let healthy=false;for(let i=0;i<60;i++){try{const h=await localJson(ownerEndpoint+'/healthz');if(h.pid!==serverChild.pid)throw Error('bridge_owner_changed');healthy=true;break;}catch{await delay(250);}}
    if(!healthy)throw Error('bridge_runtime_start_failed');
    listenerSupervisor=createListenerSupervisor({executable:p.bun,script:path.join(__dirname,'public-listener.cjs'),
      publicPort:port,ownerPort,ownerPid:serverChild.pid,cwd:p.upstream,env,onState:listener=>{
        status={...status,listenerState:listener.state,listenerPid:listener.pid};if(maintenanceExit?.shutdownDispatched)publishMaintenanceStatus();else publish();
      }});
    await listenerSupervisor.start();
    const publicHealth=await localJson(endpoint+'/healthz');
    if(publicHealth.pid!==serverChild.pid)throw Error('bridge_public_owner_changed');
    nativeActivity.start();
    if(configured.selected.transport==='shared-mcp'){
      // Existing B tunnel has a single owner. Its independent union endpoint
      // keeps ordinary Local-MCP available even if this optional bridge closes.
      status={...status,state:'connector_verification_required',runtimePid:serverChild.pid,sharedTunnelOwner:'account-'+account.toLowerCase()};publish();
      void verify().catch(()=>{});
      return originalOwner;
    }
    const command=[...config.runtimeCommand,'mcp','--contract','native','--broker-socket',config.brokerSocketPath]
      .map(s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"').join(' ');
    const t=config.tunnel,health=path.join(p.home,'tunnel-health-url.txt');
    const profile=path.join(p.home,'tunnel-profile.yaml');
    // Explicit profile contains references, never key bytes. Manual proxy has no DIRECT option.
    const quote=s=>JSON.stringify(s);
    writePrivateFileAtomic(profile,`config_version: 1\ncontrol_plane:\n  base_url: "https://api.openai.com"\n  tunnel_id: ${quote(t.tunnelId)}\n  api_key: ${quote('file:'+t.runtimeKeyFile.replaceAll('\\','/'))}\nhealth:\n  listen_addr: "127.0.0.1:0"\n  url_file: ${quote(health.replaceAll('\\','/'))}\nadmin_ui:\n  open_browser: false\nmcp:\n  commands:\n    - channel: main\n      command: ${quote(command)}\n`);
    tunnelChild=spawn(t.binaryPath,cfg.tunnelArguments(root,profile,network),{cwd:p.home,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    tunnelChild.stdout.resume();tunnelChild.stderr.resume();
    tunnelChild.on('error',()=>{status={...status,state:'tunnel_failed'};publish();});
    tunnelChild.on('exit',()=>{if(!closed){status={...status,state:'tunnel_stopped'};publish();}});
    status={...status,state:'connector_verification_required',runtimePid:serverChild.pid,tunnelPid:tunnelChild.pid};publish();
    return originalOwner;
  }catch(e){throw await settleNativeStartupFailure(e,{owner:originalOwner,serverChild,host,
    cleanupUnstarted:async()=>{await control?.close();},
    prepare:async()=>{if(!maintenanceController)throw Error('native_maintenance_owner_unavailable');maintenanceProof=await maintenanceController.prepareStartupCleanup();return maintenanceProof;},
    close,release:proof=>maintenanceMethods.resumeMaintenance(proof)});}
}
module.exports={configure,start,freePort,localJson,createNativeActivityProjection,createListenerSupervisor,createRuntimeFailureState,canReverifyTools};
