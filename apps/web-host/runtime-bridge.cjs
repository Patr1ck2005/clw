'use strict';
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const PORT_IN_USE='CLW Harness port is in use. No process was stopped. Keep the original app or close only its terminal.';
function startupCode(error){
  const message=String(error?.message||'');
  if(['runtime_port_in_use','runtime_disconnected_reconcile_original','managed_protocol_mismatch','managed_protocol_store_changed','managed_protocol_invalid'].includes(message))return message;
  return message==='CLW 服务启动超时，请检查原进程。'?'runtime_startup_timeout':'runtime_startup_failed';
}
// Only this fixed startup diagnostic is inspected. Keep at most one short line,
// inspect no more than 4 KiB, and never return or persist stderr text.
function portDiagnostic(){
  let remaining=4096,line='',overflow=false,matched=false,truncated=false;
  const finish=(completeLine=false)=>{const found=(completeLine||!truncated)&&!overflow&&line.replace(/\r$/,'')===PORT_IN_USE;line='';overflow=false;matched||=found;return matched;};
  return {feed(chunk){if(matched)return true;const raw=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);if(raw.length>remaining)truncated=true;if(remaining===0)return false;const bytes=raw.subarray(0,remaining);remaining-=bytes.length;
    for(const value of bytes){if(value===10){finish(true);continue;}if(!overflow){line+=String.fromCharCode(value);if(line.length>PORT_IN_USE.length+1){line='';overflow=true;}}}return matched;},finish};
}

class RuntimeBridge extends EventEmitter {
  constructor(root,{spawnProcess=spawn,python=process.env.CLW_PYTHON||'python',restartDelays=[1000,4000,15000],stableAfterMs=60000,recoveryCooldownMs=30000,environment,startupTimeoutMs=30000,receiptTimeoutMs=20000,closeTimeoutMs=6000,harnessPort}={}){
    super();Object.assign(this,{root,spawnProcess,python,restartDelays,stableAfterMs,recoveryCooldownMs,environment,startupTimeoutMs,receiptTimeoutMs,closeTimeoutMs});
    this.pending=new Map();this.ready=false;this.closed=false;this.restarts=0;this.phase='idle';this.lastError=null;this.launchVersion=0;
    if(harnessPort!==undefined&&harnessPort!==0)throw Error('runtime_isolated_port_invalid');
    this.harnessPort=harnessPort;
  }
  snapshot(){return {state:this.ready?'ready':this.phase,code:this.ready?null:this.lastError};}
  start(){
    if(this.closed)return Promise.reject(Error('runtime_closed'));
    if(this.ready)return Promise.resolve(this.info);
    if(this.starting)return this.starting;
    // A broken pipe or startup deadline is not proof that the process exited.
    if(this.child)return Promise.reject(Error('runtime_previous_process_not_exited'));
    clearTimeout(this.restartTimer);
    this.restartTimer=null;this.phase='starting';this.lastError=null;
    let resolve,reject;
    const starting=new Promise((yes,no)=>{resolve=yes;reject=no;});
    this.starting=starting;
    const settle=error=>{
      if(this.starting!==starting)return;
      this.starting=null;this.rejectStartup=null;
      error?reject(error):resolve(this.info);
    };
    let child;const launchVersion=++this.launchVersion;
    try{
      child=this.spawnProcess(this.python,['-X','utf8','-B',path.join(this.root,'scripts','serve_harness.py'),...(this.harnessPort===0?['--port','0']:[]),'--managed-host-stdio','--launch-owner','supervised-terminal'],{
        cwd:this.root,windowsHide:true,stdio:['pipe','pipe','pipe'],...(this.environment?{env:this.environment}:{})});
    }catch(error){this.phase='unavailable';this.lastError=startupCode(error);settle(error);return starting;}
    this.child=child;
    const diagnostic=portDiagnostic();
    let startup=true,startupTimedOut=false,failed=false,exited=false,everReady=false,startupPortOccupied=false;
    const failStartup=(error,{recoverable=false}={})=>{
      if(!startup)return;
      startup=false;startupTimedOut=recoverable;failed=!recoverable;this.phase='unavailable';this.lastError=startupCode(error);clearTimeout(timer);settle(error);
    };
    this.rejectStartup=failStartup;
    const timer=setTimeout(()=>failStartup(Error('CLW 服务启动超时，请检查原进程。'),{recoverable:true}),this.startupTimeoutMs);
    const loseTransport=()=>{
      failed=true;startupTimedOut=false;failStartup(Error('runtime_disconnected_reconcile_original'));
      this.transportFailed(child);
    };
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      if(this.closed&&this.maintenanceCloseChild!==child||this.child!==child||failed||exited)return;
      if(line.startsWith('CLW_MANAGED_READY ')){
        // A deadline settles the original caller, but does not kill or replace
        // this owned process. Its later verified READY may recover the same
        // transport; no accepted call is retried and a changed store is denied.
        if(!startup&&!startupTimedOut)return;
        let info;
        try{
          info=JSON.parse(line.slice(18));
          if(!info||info.protocol!=='clw.managed-browser.v1'||typeof info.store_id!=='string'||!info.store_id)
            throw Error('managed_protocol_mismatch');
          if(this.store&&this.store!==info.store_id)throw Error('managed_protocol_store_changed');
        }catch(error){
          const invalid=Error(error.message.startsWith('managed_protocol')?error.message:'managed_protocol_invalid');
          if(startup)failStartup(invalid);
          else{startupTimedOut=false;failed=true;this.phase='unavailable';this.lastError=startupCode(invalid);this.emit('notice',this.lastError);}
          return;
        }
        this.info=info;this.store=info.store_id;this.ready=true;everReady=true;this.phase='ready';this.lastError=null;startup=false;startupTimedOut=false;clearTimeout(timer);
        clearTimeout(this.healthyTimer);
        this.healthyTimer=setTimeout(()=>{if(this.child===child&&this.ready&&!this.closed)this.restarts=0;},this.stableAfterMs);
        this.healthyTimer.unref?.();settle();this.emit('ready');return;
      }
      if(!line.startsWith('CLW_MANAGED ')||!this.ready&&this.maintenanceCloseChild!==child)return;
      try{
        const result=JSON.parse(line.slice(12)),pending=this.pending.get(result.id);
        if(!pending||pending.child!==child)return;
        if(typeof result.ok!=='boolean'||(!result.ok&&typeof result.code!=='string'))throw Error('invalid_response');
        clearTimeout(pending.timer);this.pending.delete(result.id);
        if(result.ok)pending.resolve(result.result);else {
          const blockers=Array.isArray(result.blockers)?result.blockers.slice(0,32).map(row=>({...Object.fromEntries(['code','kind','page_id','thread_id','request_id','attempt_id','job_id','job_state','project','session_id','status','command_execution_state','scope','reason','operation_id'].filter(key=>typeof row?.[key]==='string'||Number.isSafeInteger(row?.[key])).map(key=>[key,typeof row[key]==='string'?row[key].slice(0,200):row[key]])),
            ...(Array.isArray(row?.job_ids)?{job_ids:row.job_ids.slice(0,16).filter(id=>typeof id==='string'&&id.length).map(id=>id.slice(0,200))}:{})})):[];
          pending.reject(Object.assign(Error(result.code),{code:result.code,protocolRefused:true,...(blockers.length?{blockedReasons:blockers}:{})}));
        }
      }catch{this.emit('notice','运行时返回格式异常；保留原请求等待核对。');}
    });
    // EOF, errors and late events never authorize a second live process or a replay.
    child.stdout.on('error',loseTransport);lines.on('close',loseTransport);
    const diagnosePort=()=>{if(everReady||this.closed||this.launchVersion!==launchVersion)return;
      startupPortOccupied=true;failStartup(Error('runtime_port_in_use'));startupTimedOut=false;failed=true;this.phase='unavailable';this.lastError='runtime_port_in_use';
      clearTimeout(this.restartTimer);this.restartTimer=null;this.emit('notice','runtime_port_in_use');};
    child.stderr.on('data',chunk=>{if(!everReady&&this.launchVersion===launchVersion&&diagnostic.feed(chunk))diagnosePort();});
    child.stderr.on('end',()=>{if(diagnostic.finish())diagnosePort();});child.stderr.on('error',()=>{});
    child.stdin.on('error',loseTransport);
    child.on('error',error=>{failStartup(error);this.transportFailed(child);});
    const onExit=()=>{
      if(exited)return;exited=true;clearTimeout(timer);
      failStartup(Error('CLW 服务无法启动；现有服务可能占用了入口。'));
      this.rejectPending(child);
      if(this.child!==child)return;
      this.child=null;this.ready=false;clearTimeout(this.healthyTimer);
      if(!this.closed&&(startupPortOccupied||String(this.lastError||'').startsWith('managed_protocol_'))){this.phase='unavailable';if(startupPortOccupied)this.lastError='runtime_port_in_use';this.emit('notice',this.lastError);}
      else if(!this.closed&&this.restarts<this.restartDelays.length){
        const delay=this.restartDelays[this.restarts++];
        this.phase='recovering';this.lastError||='runtime_disconnected_reconcile_original';
        this.restartTimer=setTimeout(()=>{if(!this.closed)this.start().catch(()=>this.emit('notice','服务恢复失败，请检查工作区。'));},delay);
      }else if(!this.closed&&this.restartDelays.length){
        // Only a confirmed exit reaches here. Retry another bounded batch
        // after cooldown instead of leaving a long-running workspace dead.
        this.phase='recovering';this.lastError||='runtime_disconnected_reconcile_original';
        this.emit('notice','本机服务恢复暂未完成；原执行保留，冷却后会继续核对恢复。');
        this.restartTimer=setTimeout(()=>{if(!this.closed&&!this.child){this.restarts=0;this.start().catch(()=>this.emit('notice','服务恢复尚未完成，原执行仍保留。'));}},this.recoveryCooldownMs);
        this.restartTimer.unref?.();
      }else if(!this.closed){this.phase='unavailable';this.lastError||='runtime_disconnected_reconcile_original';this.emit('notice','本机服务未恢复，原执行保留。');}
      this.emit('disconnected');
    };
    child.on('exit',onExit);child.on('close',onExit);
    return starting;
  }
  rejectPending(child){
    for(const [id,p] of this.pending){
      if(p.child!==child)continue;
      clearTimeout(p.timer);this.pending.delete(id);p.reject(Error('runtime_disconnected_reconcile_original'));
    }
  }
  transportFailed(child){
    this.rejectPending(child);
    if(this.child!==child)return;
    const wasReady=this.ready;this.ready=false;clearTimeout(this.healthyTimer);
    if(wasReady&&!this.closed){
      this.phase='unavailable';this.lastError='runtime_disconnected_reconcile_original';
      this.emit('notice','本机通信中断；原请求保留，请核对原执行。');this.emit('disconnected');
    }
  }
  call(op,payload={}){
    const child=this.child,stream=child?.stdin;
    // This error proves that no byte of this call entered the pipe.
    if(this.closed||!this.ready||!stream?.writable||stream.writableEnded||stream.destroyed)return Promise.reject(Error('runtime_not_connected'));
    const id=randomUUID();return new Promise((resolve,reject)=>{
      const message=JSON.stringify({id,op,payload})+'\n';
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('runtime_receipt_unknown_reconcile_original'));},this.receiptTimeoutMs);
      this.pending.set(id,{resolve,reject,timer,child});
      try{stream.write(message,error=>{if(error)this.transportFailed(child);});}catch{this.transportFailed(child);}
    });
  }
  close(){
    if(this.closing)return this.closing;
    this.closed=true;this.ready=false;this.phase='closed';clearTimeout(this.restartTimer);clearTimeout(this.healthyTimer);
    this.rejectStartup?.(Error('runtime_closed'));
    const child=this.child;
    if(!child)return Promise.resolve();
    this.rejectPending(child);
    this.closing=new Promise(resolve=>{
      const done=()=>{clearTimeout(timer);child.removeListener('exit',done);child.removeListener('close',done);resolve();};
      const timer=setTimeout(done,this.closeTimeoutMs);child.once('exit',done);child.once('close',done);
      if(child.stdin.writable&&!child.stdin.writableEnded&&!child.stdin.destroyed){
        try{child.stdin.end(JSON.stringify({id:randomUUID(),op:'shutdown'})+'\n',error=>{if(error)done();});}catch{done();}
      }else done();
    });return this.closing;
  }
  closeMaintenance(proof){
    if(this.maintenanceExitReceipt)return Promise.resolve(this.maintenanceExitReceipt);
    if(this.maintenanceClosing)return this.maintenanceClosing;
    const child=this.child,instance=this.info?.instance_id,store=this.store;
    const identity={version:1,kind:'original_host_maintenance_exit',hostPid:child?.pid,instanceId:instance,storeId:store,permitId:proof?.permitId};
    const failure=(code,stage,state='unknown')=>Object.assign(Error(code),{maintenanceClose:{...identity,stage,state,shutdownDispatched:stage==='shutdown_dispatched'}});
    if(this.closed||!this.ready||this.pending.size||!child||child.exitCode!==null||!Number.isSafeInteger(child.pid)||!child.stdin?.writable||child.stdin.writableEnded||child.stdin.destroyed||
       !/^[a-f0-9]{32}$/.test(instance||'')||proof?.instanceId!==instance||proof.storeId!==store||proof.hostPid!==child.pid||
       !/^[a-f0-9]{32}$/.test(proof.permitId||'')||!/^[a-f0-9]{64}$/.test(proof.ledgerFingerprint||''))return Promise.reject(failure('maintenance_original_host_unavailable','before_shutdown','refused'));
    let resolveExit,exitReceipt,exitCandidate,receiptDisposition='pending';
    const exitPromise=new Promise(resolve=>{resolveExit=resolve;});
    const publishExit=()=>{
      if(!exitCandidate||exitReceipt||receiptDisposition==='pending'||receiptDisposition==='refused')return;
      exitReceipt=exitCandidate;this.maintenanceExitReceipt=exitReceipt;
      resolveExit({receipt:exitReceipt});this.emit('maintenance-exit',exitReceipt);
    };
    const onExit=(code,signal)=>{
      if(code!==0||signal!=null){const error=failure('maintenance_original_host_exit_unverified','shutdown_dispatched','failed');this.emit('maintenance-exit-unresolved',error.maintenanceClose);resolveExit({error});return;}
      // The pipe may have already received a refusal while its Promise
      // continuation is still queued. Preserve that original disposition
      // before attributing a coincident child exit to this maintenance permit.
      exitCandidate={...identity,state:'exited',shutdownDispatched:true,runtimeExit:{pid:child.pid,code,signal:null}};publishExit();
    };
    child.once('exit',onExit);
    this.maintenanceCloseChild=child;
    const accepted=this.call('maintenance-shutdown',{instance_id:instance,store_id:store,permit_id:proof.permitId,ledger_fingerprint:proof.ledgerFingerprint,...(proof.exitMode?{exit_mode:proof.exitMode}:{})})
      .then(receipt=>{
        if(receipt?.kind!=='original_host_maintenance_shutdown'||receipt.state!=='maintenance_shutdown_accepted'||receipt.instanceId!==instance||receipt.storeId!==store||receipt.permitId!==proof.permitId||receipt.hostPid!==child.pid)
          return {unknown:true};return {accepted:true};
      },error=>({error,refused:error.protocolRefused===true||error.message==='runtime_not_connected'}))
      .then(reply=>{receiptDisposition=reply.refused?'refused':'accepted_or_unknown';if(reply.refused)exitCandidate=null;else publishExit();return reply;});
    // Fence retries before any acknowledgement can be lost. Unknown keeps
    // this exact child and promise; only its later exit event can complete it.
    this.closed=true;this.ready=false;this.phase='maintenance-closing';clearTimeout(this.restartTimer);clearTimeout(this.healthyTimer);
    this.maintenanceClosing=(async()=>{
      let timer;const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve({timeout:true}),this.closeTimeoutMs);});
      try{
        const reply=await Promise.race([accepted,deadline]);
        if(reply.refused){
          child.removeListener('exit',onExit);
          this.maintenanceCloseChild=null;
          if(this.child===child&&child.exitCode===null){this.closed=false;this.ready=true;this.phase='ready';}
          this.maintenanceClosing=null;
          throw Object.assign(failure(reply.error.message,'before_shutdown','refused'),{...(reply.error.blockedReasons?{blockedReasons:reply.error.blockedReasons}:{})});
        }
        const result=exitReceipt?{receipt:exitReceipt}:await Promise.race([exitPromise,deadline]);
        if(result.receipt)return result.receipt;
        if(result.error)throw result.error;
        throw failure('maintenance_original_host_exit_unknown','shutdown_dispatched');
      }finally{clearTimeout(timer);}
    })();return this.maintenanceClosing;
  }
}
module.exports={RuntimeBridge};
