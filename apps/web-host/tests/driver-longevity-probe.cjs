'use strict';
// Compare an immutable previously installed driver with the current source.
// Timer inventory is simulated; all Runtime/BrowserPool objects are fixtures.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{EventEmitter}=require('node:events');
const source=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
if(fs.existsSync(output))throw Error('immutable_probe_output_exists');
const intervals=[];global.setInterval=(callback,ms)=>{const handle={callback,ms,active:true,unref(){}};intervals.push(handle);return handle;};global.clearInterval=handle=>{if(handle)handle.active=false;};
const {WebDriver}=require(source),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(rows=[],read){const runtime=new EventEmitter();runtime.ready=true;runtime.call=async op=>{if(op!=='list')throw Error('probe_unexpected_operation');return read?read():{pages:rows};};
  const pool={pages:new Map(),register(id,url,metadata){const p={id,url,...metadata,view:null};this.pages.set(id,p);return p;},emit(){}};
  const driver=new WebDriver({runtime,pool,onNotice(){},observeIntervalMs:1000000});driver.tick=async()=>{};return {driver,pool,runtime};}
(async()=>{
  const a=fixture();await Promise.all(Array.from({length:20},()=>a.driver.restore()));const activeAfterRestores=intervals.filter(t=>t.active).length;
  a.driver.dispose?.();if(!a.driver.disposed)a.driver.stop();const orphanIntervalsAfterStop=intervals.filter(t=>t.active).length;for(const timer of intervals)timer.active=false;
  const b=fixture([],async()=>{throw Error('probe_initial_read_failure');});await b.driver.restore().catch(()=>{});
  const observerAfterInitialFailure=!!b.driver.timer;b.driver.dispose?.();if(!b.driver.disposed)b.driver.stop();
  const rows=['slow-original','healthy-original'].map(id=>({page_id:id,account:'A',phase:'bound',paused:true,url:'https://chatgpt.com/c/'+id,latest_request:{id:'same-'+id,phase:'processing'}}));
  const c=fixture(rows);let release;c.pool.ensure=async id=>{if(id==='slow-original')return new Promise(resolve=>{release=resolve;});const p=c.pool.pages.get(id);p.view={webContents:{isDestroyed:()=>false}};return p;};
  const restore=c.driver.restore();const restoreReturnedWhilePagePending=await Promise.race([restore.then(()=>true),wait(25).then(()=>false)]);
  const healthyPageAdmittedWhileOriginalPending=!!c.pool.pages.get('healthy-original')?.view;
  const localRecordsLoaded=c.driver.recordsLoaded;c.driver.dispose?.();if(!c.driver.disposed)c.driver.stop();release?.();await restore;
  const histories=Array.from({length:30},(_,n)=>({page_id:'closed-history-'+n,account:'A',phase:'bound',paused:true,
    url:'https://chatgpt.com/c/closed-history-'+n,attention:'original persisted problem',issue_kind:'control_failed',latest_request:{id:'original-completed-'+n,phase:'completed'}}));
  const d=fixture(histories);d.driver.isClosed=()=>true;let historicalHydrations=0;
  d.pool.ensure=async id=>{historicalHydrations++;const page=d.pool.pages.get(id);page.view={webContents:{isDestroyed:()=>false}};return page;};
  await d.driver.reconcileAll();const historicalProblemsPreserved=histories.every(row=>d.driver.records.get(row.page_id)?.attention==='original persisted problem');
  d.driver.dispose?.();if(!d.driver.disposed)d.driver.stop();
  const result={source,source_sha256:createHash('sha256').update(fs.readFileSync(source)).digest('hex'),scope:'fixture_timer_inventory_and_stalled_page_reproduction',
    concurrent_restores:20,active_intervals_after_restores:activeAfterRestores,orphan_intervals_after_stop:orphanIntervalsAfterStop,
    observer_after_initial_read_failure:observerAfterInitialFailure,restore_returned_while_page_pending:restoreReturnedWhilePagePending,
    healthy_page_admitted_while_original_pending:healthyPageAdmittedWhileOriginalPending,local_records_loaded:localRecordsLoaded,
    closed_terminal_attention_rows:histories.length,closed_terminal_renderer_hydrations:historicalHydrations,historical_problems_preserved:historicalProblemsPreserved,
    runtime_ready_listeners_after_final_disposal:c.runtime.listenerCount('ready'),model_calls:0,browser_calls:0,production_processes_touched:0};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
