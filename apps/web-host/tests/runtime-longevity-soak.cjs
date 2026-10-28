'use strict';
// Explicit bounded transport/observer soak, never contacts the original app.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const {RuntimeBridge}=require('../runtime-bridge.cjs'),{WebDriver}=require('../web-driver.cjs'),{TaskSubmission}=require('../task-submission.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('soak_original_recovery_timeout');await wait(5);}}
(async()=>{
  const folder=path.resolve(process.argv[2]),durationMs=Number(process.argv[3]||20000);assert.ok(durationMs>=1000&&durationMs<=60000);fs.mkdirSync(folder,{recursive:true});
  const receipt=path.join(folder,'soak-validation.json');assert.equal(fs.existsSync(receipt),false,'evidence is immutable');
  const children=[],notices=[];let dispatches=0;
  const runtime=new RuntimeBridge(folder,{startupTimeoutMs:30,receiptTimeoutMs:1500,closeTimeoutMs:3000,restartDelays:[5,10,15],recoveryCooldownMs:60,stableAfterMs:60000,
    spawnProcess:()=>{const child=spawn(process.execPath,[path.join(__dirname,'fixtures/longevity-process.cjs'),folder],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CLW_FIXTURE_READY_DELAY_MS:children.length?0:80}});children.push(child);return child;}});
  runtime.on('notice',message=>notices.push(message));let driver;
  const start=Date.now();let reads=0,restores=0,crashes=0,maxPending=0,lateStartupRecovered=false;
  try{
    await assert.rejects(runtime.start(),/启动超时/);await until(()=>runtime.ready);lateStartupRecovered=children.length===1;
    const workspace={pendingStarts:{},save(){fs.writeFileSync(path.join(folder,'fixture-pending.json'),JSON.stringify(this.pendingStarts));}};
    const submissions=new TaskSubmission(runtime,workspace);
    await assert.rejects(submissions.start('fixture-paused-page','fixture original complete package'),/disconnected_reconcile_original/);dispatches++;
    const original=workspace.pendingStarts['fixture-paused-page'].operation_id;await until(()=>runtime.ready);
    const collected=await submissions.start('fixture-paused-page','fixture original complete package');assert.equal(collected.request_id,original);assert.equal(runtime.pending.size,0);
    const pool={pages:new Map(),selected:null,emit(){},running(){},work(){},register(id,url,meta){const page={id,url,...meta,documentGeneration:0,view:null};this.pages.set(id,page);return page;},
      async ensure(id){const p=this.pages.get(id);p.view={webContents:{getURL:()=>p.url,isDestroyed:()=>false}};return p;}};
    driver=new WebDriver({runtime,pool,observeIntervalMs:8,onNotice:message=>notices.push(message),
      dom:async wc=>({url:wc.getURL(),editor:true,controlKnown:true,generating:false,draft:false,composing:false,historyAtLatest:true,userId:'fixture-original-public-turn'})});
    const deadline=Date.now()+durationMs;
    while(Date.now()<deadline){
      if(!runtime.ready){await until(()=>runtime.ready);continue;}
      const state=await runtime.call('list');reads++;assert.equal(state.pages[0].paused,true);assert.equal(state.pages[0].latest_request.id,'fixture-original-request');
      maxPending=Math.max(maxPending,runtime.pending.size);
      if(reads%35===0){const restore=driver.restore();await Promise.all(Array.from({length:20},()=>driver.restore()));await restore;restores+=20;driver.stop();driver.stopped=false;await driver.restore();}
      if(reads%80===0&&crashes<20){await assert.rejects(runtime.call('fixture-crash'),/disconnected_reconcile_original/);crashes++;await until(()=>runtime.ready);}
      await wait(2);
    }
    driver.dispose();assert.equal(runtime.listenerCount('ready'),0);assert.equal(runtime.listenerCount('disconnected'),0);await runtime.close();
    await Promise.all(children.map(child=>child.exitCode!==null?undefined:new Promise(resolve=>child.once('exit',resolve))));
    const saved=JSON.parse(fs.readFileSync(path.join(folder,'fixture-original-receipt.json')));assert.equal(saved.effects,1);assert.equal(saved.operation_id,original);
    const result={state:'passed',scope:'isolated_actual_node_stdio_and_observer',elapsed_ms:Date.now()-start,duration_ms:durationMs,read_operations:reads,restore_requests:restores,
      confirmed_crash_recoveries:crashes,children:children.map(child=>({pid:child.pid,exit_code:child.exitCode})),late_original_startup_recovered:lateStartupRecovered,
      original_operation_id:original,accepted_effects:saved.effects,accepted_dispatches:dispatches,max_pending_at_sample:maxPending,final_pending:runtime.pending.size,
      ready_listeners:runtime.listenerCount('ready'),disconnected_listeners:runtime.listenerCount('disconnected'),driver_timer_cleared:driver.timer===null,
      original_task_paused:true,model_calls:0,browser_calls:0,production_processes_touched:0,notices_count:notices.length};
    result.source_sha256=Object.fromEntries(['../runtime-bridge.cjs','../web-driver.cjs','fixtures/longevity-process.cjs','runtime-longevity-soak.cjs'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')]));
    fs.writeFileSync(receipt,JSON.stringify(result,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify(result)+'\n');
  }finally{driver?.dispose();await runtime.close();for(const child of children)if(child.exitCode===null)child.kill();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
