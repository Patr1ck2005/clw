'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{performance}=require('node:perf_hooks'),{spawn}=require('node:child_process');
const {installTurnJournal}=require('../turn-journal.cjs'),{createTurnDisplayIndex}=require('../turn-journal-cache.cjs');
const {saveSource}=require('../turn-source.cjs'),{saveReview}=require('../turn-review.cjs');
const trace=n=>n.toString(16).padStart(12,'0');
const thread='11111111-1111-4111-8111-111111111111',otherThread='22222222-2222-4222-8222-222222222222';
async function fixture(t,count=2,options={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-journal-display-'));
  fs.mkdirSync(path.join(home,'turns'));fs.mkdirSync(path.join(home,'runtime','native-final-replay'),{recursive:true});
  for(let i=1;i<=count;i++){
    const traceId=trace(i),row={traceId,status:'completed',submission:'confirmed',startedAt:new Date(2026,8,1,0,i).toISOString()};
    fs.writeFileSync(path.join(home,'turns',traceId+'.json'),JSON.stringify(row));
    if(count<100){saveSource(home,{traceId,threadId:thread,turnId:`33333333-3333-4333-8333-${String(i).padStart(12,'0')}`,model:'chatgpt-web/pro'});saveReview(home,traceId,'Original saved answer '+i);}
  }
  const wc=new EventEmitter();wc.getURL=()=> 'https://chatgpt.com/c/current';
  const tab={id:'tab',helperPid:1,view:{webContents:wc}},host={turnTabs:new Map([['tab',tab]]),
    async beginTurn(traceId){tab.traceId=traceId;return {tabId:tab.id};},async endTurn(){return {};}};
  const journal=installTurnJournal(host,home,{account:'A',displayIndexOptions:{pollMs:100000,fullScanMs:100000,...options}});
  t.after(async()=>{await journal.closeDisplay();fs.rmSync(home,{recursive:true,force:true});});
  journal.cachedList();await journal.refreshDisplay({full:true});
  return {home,journal,host,tab,wc};
}
test('thousands of historical rows are served repeatedly without any main-thread filesystem read or Session traversal',async t=>{
  const {journal}=await fixture(t,3000);const before=journal.cachedList().metrics.snapshotReads,original={};let calls=0;
  for(const key of ['statSync','readFileSync','readdirSync','openSync','readSync']){original[key]=fs[key];fs[key]=function(...args){calls++;return original[key].apply(this,args);};}
  let snapshot,elapsed,canonicalElapsed,canonicalCalls;
  try{const start=performance.now();for(let n=0;n<2500;n++)snapshot=journal.cachedList();elapsed=performance.now()-start;}
  finally{Object.assign(fs,original);}
  assert.equal(snapshot.rows.length,3000);assert.equal(calls,0);assert.equal(snapshot.status.unavailable,false);
  assert.equal(snapshot.metrics.snapshotReads-before,2500);
  canonicalCalls=0;
  for(const key of ['statSync','readFileSync','readdirSync','openSync','readSync'])fs[key]=function(...args){canonicalCalls++;return original[key].apply(this,args);};
  try{const start=performance.now();assert.equal(journal.list().length,3000);canonicalElapsed=performance.now()-start;}
  finally{Object.assign(fs,original);}
  assert.ok(canonicalCalls>3000);t.diagnostic(JSON.stringify({fixture:true,rows:3000,snapshots:2500,
    mainThreadFsCalls:calls,elapsedMs:elapsed,previousCanonicalSnapshotMs:canonicalElapsed,previousCanonicalFsCalls:canonicalCalls}));
});
test('host save events appear immediately and a late worker result cannot replace a newer event',async t=>{
  const {journal,host}=await fixture(t,1);await host.beginTurn(trace(9));
  const instant=journal.cachedList().rows.find(row=>row.traceId===trace(9));assert.equal(instant.status,'running');assert.equal(instant.account,'A');
  await host.endTurn(trace(9),1,'aborted');
  assert.equal(journal.cachedList().rows.find(row=>row.traceId===trace(9)).status,'aborted');
  await journal.refreshDisplay({full:true});
  assert.equal(journal.cachedList().rows.find(row=>row.traceId===trace(9)).status,'aborted');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-journal-late-'));let worker;
  const record={traceId:trace(1),status:'running'},index=createTurnDisplayIndex(home,new Map([[record.traceId,record]]),
    {pollMs:100000,fullScanMs:100000,workerFactory:()=>{worker=new EventEmitter();worker.sent=[];worker.postMessage=value=>worker.sent.push(value);worker.terminate=async()=>{};return worker;}});
  t.after(async()=>{await index.close();fs.rmSync(home,{recursive:true,force:true});});
  const first=index.refresh(),request=worker.sent[0].request;
  index.upsert({...record,status:'completed'});
  worker.emit('message',{type:'batch',request,rows:[{traceId:record.traceId,version:0,row:record}]});
  worker.emit('message',{type:'done',request,status:{stale:false,unavailable:false,errorCode:null}});await first;
  assert.equal(index.snapshot().rows[0].status,'completed');assert.equal(index.snapshot().metrics.rejectedLate,1);
});
test('external source, review and replay changes refresh metadata, while canonical task/body reads keep exact ownership',async t=>{
  const {home,journal}=await fixture(t,1),traceId=trace(1),original=journal.cachedList().rows[0];
  assert.equal(original.source.threadId,thread);assert.equal(original.review.finalText,undefined);
  const sourceFile=path.join(home,'turn-sources',traceId+'.json'),source=JSON.parse(fs.readFileSync(sourceFile));
  source.threadId=otherThread;fs.writeFileSync(sourceFile,JSON.stringify(source));
  await journal.refreshDisplay({full:true});assert.equal(journal.cachedList().rows[0].source.threadId,otherThread);
  assert.equal(journal.history({task_key:thread}).total,0);assert.equal(journal.history({task_key:otherThread}).total,1);
  const reviewFile=path.join(home,'turn-reviews',traceId+'.json'),review=JSON.parse(fs.readFileSync(reviewFile));
  review.threadId=otherThread;review.finalSha256='a'.repeat(64);fs.writeFileSync(reviewFile,JSON.stringify(review));
  fs.writeFileSync(path.join(home,'runtime','native-final-replay',traceId+'.json'),'NEVER_CACHE_FULL_REPLY');
  await journal.refreshDisplay({full:true});const updated=journal.cachedList().rows[0];
  assert.equal(updated.review.finalSha256,'a'.repeat(64));assert.equal(updated.bodyAvailable,true);assert.equal(updated.review.finalText,undefined);
  assert.equal(JSON.stringify(journal.cachedList()).includes('NEVER_CACHE_FULL_REPLY'),false);
  assert.equal(journal.get(traceId).review.finalText,null);
});
test('a file watcher refreshes an older task outside the recent window without requesting a full catalogue',async t=>{
  const {home,journal}=await fixture(t,40),file=path.join(home,'turn-sources',trace(1)+'.json');
  const source=JSON.parse(fs.readFileSync(file));source.threadId=otherThread;fs.writeFileSync(file,JSON.stringify(source));
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{clearInterval(check);reject(Error('watch_refresh_timeout'));},5000);
    const check=setInterval(()=>{if(journal.cachedList().rows.find(row=>row.traceId===trace(1))?.source?.threadId===otherThread){clearTimeout(timeout);clearInterval(check);resolve();}},10);});
  assert.equal(journal.cachedList().rows.length,40);
});
test('restored display data excludes unexpected transcript fields and never supplies canonical authority',async t=>{
  const {home,journal}=await fixture(t,1);await journal.closeDisplay();
  const file=path.join(home,'turn-display-index.json'),saved=JSON.parse(fs.readFileSync(file));
  saved.rows[0].row.finalText='UNEXPECTED_CACHED_BODY';saved.rows[0].row.review.finalText='UNEXPECTED_CACHED_BODY';
  saved.rows[0].row.source.secretToken='UNEXPECTED_CACHED_BODY';saved.rows[0].row.nativeState.transcript='UNEXPECTED_CACHED_BODY';
  fs.writeFileSync(file,JSON.stringify(saved));
  const host={turnTabs:new Map(),async beginTurn(){},async endTurn(){}},reopened=installTurnJournal(host,home,{displayIndexOptions:{pollMs:100000,fullScanMs:100000}});
  t.after(()=>reopened.closeDisplay());assert.equal(JSON.stringify(reopened.cachedList()).includes('UNEXPECTED_CACHED_BODY'),false);
  assert.equal(reopened.get(trace(1)).source.threadId,thread);
});
test('malformed or changing record/source data retains the last complete entry and marks the source stale',async t=>{
  const {home,journal}=await fixture(t,1),file=path.join(home,'turns',trace(1)+'.json'),before=fs.readFileSync(file,'utf8');
  fs.writeFileSync(file,'{"traceId":');await journal.refreshDisplay({full:true});
  let cached=journal.cachedList();assert.equal(cached.rows.length,1);assert.equal(cached.rows[0].source.threadId,thread);
  assert.equal(cached.rows[0].status,'needs_reconciliation');assert.equal(cached.rows[0].display_read.unavailable,true);
  assert.equal(cached.status.unavailable,true);assert.equal(journal.get(trace(1)),null);
  assert.throws(()=>journal.list({strict:true}),/native_record_unavailable/);
  fs.writeFileSync(file,before);await journal.refreshDisplay({full:true});assert.equal(journal.cachedList().rows[0].status,'completed');
  fs.writeFileSync(path.join(home,'turn-sources',trace(1)+'.json'),'broken');await journal.refreshDisplay({full:true});
  cached=journal.cachedList();assert.equal(cached.rows[0].source.threadId,thread);assert.equal(cached.rows[0].display_read.stale,true);
  assert.equal(journal.get(trace(1)).source,null);
});
test('a removed directory keeps the prior index; a successful complete pass can remove an actually deleted record',async t=>{
  const {home,journal}=await fixture(t,2),folder=path.join(home,'turns'),saved=path.join(home,'temporarily-unavailable-turns');
  fs.renameSync(folder,saved);await journal.refreshDisplay({full:true});assert.equal(journal.cachedList().rows.length,2);
  assert.equal(journal.cachedList().status.unavailable,true);
  fs.renameSync(saved,folder);fs.unlinkSync(path.join(folder,trace(1)+'.json'));
  await journal.refreshDisplay({full:true});assert.equal(journal.cachedList().rows.length,1);assert.equal(journal.cachedList().status.unavailable,false);
});
test('worker restart rejects the old generation, recovers without model replay, and crash loops remain bounded',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-journal-worker-recovery-'));const workers=[];let now=0;
  const record={traceId:trace(1),status:'completed'},index=createTurnDisplayIndex(home,new Map([[record.traceId,record]]),
    {pollMs:100000,fullScanMs:100000,now:()=>now,workerFactory:()=>{const worker=new EventEmitter();worker.sent=[];
      worker.postMessage=value=>worker.sent.push(value);worker.terminate=async()=>{};workers.push(worker);return worker;}});
  t.after(async()=>{await index.close();fs.rmSync(home,{recursive:true,force:true});});
  const pending=index.refresh();workers[0].emit('error',Error('failed'));assert.equal(await pending,false);
  assert.equal(index.snapshot().rows[0].status,'needs_reconciliation');now=1000;
  const recovered=index.refresh(),request=workers[1].sent[0].request;
  workers[0].emit('message',{type:'batch',request,rows:[{traceId:record.traceId,row:{...record,status:'running'}}]});
  assert.equal(index.snapshot().rows[0].status,'needs_reconciliation');
  workers[1].emit('message',{type:'batch',request,rows:[{traceId:record.traceId,row:record}]});
  workers[1].emit('message',{type:'done',request,status:{stale:false,unavailable:false,errorCode:null}});
  assert.equal(await recovered,true);assert.equal(index.snapshot().rows[0].status,'completed');
  workers[1].emit('error',Error('again'));now=6000;const last=index.refresh();workers[2].emit('error',Error('again'));
  await last;now=50000;assert.equal(await index.refresh(),false);assert.equal(workers.length,3);
});
test('native Session append is checked off-thread without caching its prose or final reply',async t=>{
  const {home,journal}=await fixture(t,1);await journal.closeDisplay();
  const sessionsRoot=path.join(home,'sessions'),folder=path.join(sessionsRoot,'2026','09','26');fs.mkdirSync(folder,{recursive:true});
  const threadId='01a0dc7b-2a50-7140-a55b-eed50ff96b02',turnId='01a0dc7b-2a50-7140-a55b-eed50ff96b03';
  const file=path.join(folder,'rollout-2026-09-26T10-00-00-'+threadId+'.jsonl');
  const meta={type:'session_meta',payload:{id:threadId}},start={type:'event_msg',payload:{type:'task_started',turn_id:turnId}};
  fs.writeFileSync(file,[meta,start].map(row=>JSON.stringify(row)).join('\n')+'\n');
  fs.writeFileSync(path.join(home,'turn-sources',trace(1)+'.json'),JSON.stringify({traceId:trace(1),threadId,turnId,model:'chatgpt-web/pro'}));
  const record=JSON.parse(fs.readFileSync(path.join(home,'turns',trace(1)+'.json')));
  const index=createTurnDisplayIndex(home,new Map([[record.traceId,record]]),{sessionsRoot,pollMs:100000,fullScanMs:100000});
  t.after(()=>index.close());await index.refresh({full:true});assert.equal(index.snapshot().rows[0].nativeState.state,'unavailable');
  fs.appendFileSync(file,JSON.stringify({timestamp:'2026-09-26T10:00:02Z',type:'event_msg',payload:{type:'task_complete',turn_id:turnId,last_agent_message:'PRIVATE_NATIVE_REPLY'}})+'\n');
  await index.refresh();assert.equal(index.snapshot().rows[0].nativeState.state,'completed');
  assert.equal(JSON.stringify(index.snapshot()).includes('PRIVATE_NATIVE_REPLY'),false);
});
test('explicit action reads fully prove the original Session and reject a newer native turn absent from the display catalogue',async t=>{
  const {home,journal,host}=await fixture(t,1);await journal.closeDisplay();
  const sessionsRoot=path.join(home,'sessions'),folder=path.join(sessionsRoot,'2026','09','26');fs.mkdirSync(folder,{recursive:true});
  const threadId='01a0dc7b-2a50-7140-a55b-eed50ff96b02',turnId='01a0dc7b-2a50-7140-a55b-eed50ff96b03';
  const nextTurn='01a0dc7b-2a50-7140-a55b-eed50ff96b04',session=path.join(folder,'rollout-2026-09-26T10-00-00-'+threadId+'.jsonl');
  const row=(type,payload,second)=>({timestamp:`2026-09-26T10:00:0${second}Z`,type,payload});
  const complete=[row('session_meta',{id:threadId,cwd:home},0),row('event_msg',{type:'task_started',turn_id:turnId},1),
    row('response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'NATIVE_FINAL_PRIVATE'}]},2),
    row('event_msg',{type:'task_complete',turn_id:turnId,last_agent_message:'NATIVE_FINAL_PRIVATE'},3)].map(value=>JSON.stringify(value)).join('\n')+'\n';
  fs.writeFileSync(session,complete);
  for(const number of [1,2]){
    fs.writeFileSync(path.join(home,'turns',trace(number)+'.json'),JSON.stringify({traceId:trace(number),status:'completed',submission:'confirmed'}));
    fs.writeFileSync(path.join(home,'turn-sources',trace(number)+'.json'),JSON.stringify({traceId:trace(number),threadId,turnId,model:'chatgpt-web/pro',workingDirectory:home}));
  }
  const actionJournal=installTurnJournal(host,home,{account:'A',displayIndexOptions:{sessionsRoot,pollMs:100000,fullScanMs:100000}});
  t.after(()=>actionJournal.closeDisplay());actionJournal.cachedList();await actionJournal.refreshDisplay({full:true});
  assert.equal(actionJournal.cachedList().rows[0].nativeState.state,'completed');
  const originalOpen=fs.openSync;let sessionOpens=0;
  fs.openSync=function(file,...args){if(file===session)sessionOpens++;return originalOpen.call(this,file,...args);};
  let rows;try{rows=actionJournal.list({strict:true});}finally{fs.openSync=originalOpen;}
  assert.equal(sessionOpens,1,'one operation scans a shared Session once');
  assert.ok(rows.every(value=>value.nativeState.nativeProof?.kind==='canonical_full_session'&&value.nativeState.threadActive===false));
  const {nativeMaintenanceTurns}=require('../../web-host/native-turn-reads.cjs');
  assert.equal(nativeMaintenanceTurns({turns:()=>rows}).length,2);
  assert.equal(JSON.stringify(rows).includes('NATIVE_FINAL_PRIVATE'),false);
  fs.appendFileSync(session,JSON.stringify(row('event_msg',{type:'task_started',turn_id:nextTurn},4))+'\n');
  rows=actionJournal.list({strict:true});
  assert.equal(rows[0].nativeState.state,'completed');assert.equal(rows[0].nativeState.threadActive,true);
  assert.equal(rows[0].nativeState.activeTurnId,nextTurn);
  assert.throws(()=>nativeMaintenanceTurns({turns:()=>rows}),/maintenance_exit_requires_original_receipt/);
  fs.writeFileSync(path.join(home,'turn-sources',trace(1)+'.json'),'{broken');
  assert.throws(()=>actionJournal.list({strict:true}),/native_source_unavailable/);
  assert.equal(actionJournal.cachedList().rows.length,2);
});
test('a real Windows exclusive file lock preserves the original row and later settles through readonly refresh',
  {skip:process.platform!=='win32'},async t=>{
  const {home,journal}=await fixture(t,1),file=path.join(home,'turns',trace(1)+'.json');
  const script='$stream = [System.IO.File]::Open($args[0], [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); [Console]::Out.WriteLine("locked"); [Console]::In.ReadLine() | Out-Null; $stream.Dispose()';
  const helper=path.join(home,'hold-file.ps1');fs.writeFileSync(helper,script);
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',helper,file],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  t.after(()=>child.kill());await new Promise((resolve,reject)=>{child.stdout.on('data',data=>{if(String(data).includes('locked'))resolve();});child.on('error',reject);child.on('exit',code=>{if(code)reject(Error('lock_helper_failed'));});});
  await journal.refreshDisplay({full:true});const locked=journal.cachedList();assert.equal(locked.rows.length,1);
  assert.equal(locked.status.unavailable,true);assert.equal(locked.rows[0].display_read.stale,true);
  child.stdin.end('\n');await new Promise(resolve=>child.once('exit',resolve));
  await journal.refreshDisplay({full:true});assert.equal(journal.cachedList().status.unavailable,false);assert.equal(journal.cachedList().rows[0].status,'completed');
});
