const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {saveSource,readSource,sourceForDisplay}=require('../turn-source.cjs');
const {resumeTurnPayload,launchArguments}=require('../launch-codex.cjs');
const {turnView}=require('../../web-host/codex-turns.js');
const {groupRows,filterRows}=require('../../web-host/codex-turns.js');
const source={traceId:'123456abcdef',threadId:'01a0dc7b-2a50-7140-a55b-eed50ff96b02',turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b03',model:'chatgpt-web/pro'};
const canonicalNative=(identity,state='completed')=>({state,threadId:identity.threadId,turnId:identity.turnId,
  source:'native_session_canonical',endedAt:'2026-10-04T10:00:00Z',threadActive:false,activeTurnId:null,
  nativeProof:{version:1,kind:'canonical_full_session',threadId:identity.threadId,turnId:identity.turnId,
    terminal:{completed:'task_complete_with_matching_final',failed:'task_complete_with_error',aborted:'turn_aborted'}[state],
    sessionSha256:'a'.repeat(64),eventSha256:'b'.repeat(64)}});
test('source keeps exact native identity and ignores secrets, malformed IDs and reassignment',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-source-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 assert.equal(saveSource(home,{...source,turn_token:'SECRET',prompt:'PRIVATE'}),true);
 assert.equal(saveSource(home,{...source,threadId:source.turnId}),false);
 assert.equal(saveSource(home,{...source,traceId:'../../outside'}),false);
 assert.equal(saveSource(home,{...source,purpose:'compaction'}),true);
 assert.equal(readSource(home,source.traceId).purpose,'compaction');
 assert.equal(saveSource(home,{...source,purpose:'response'}),false);
 assert.equal(readSource(home,source.traceId).threadId,source.threadId);
 const raw=fs.readFileSync(path.join(home,'turn-sources',source.traceId+'.json'),'utf8');assert.equal(raw.includes('SECRET'),false);assert.equal(raw.includes('PRIVATE'),false);
 fs.mkdirSync(path.join(home,'runtime'));fs.writeFileSync(path.join(home,'runtime/thread-environments.json'),JSON.stringify({version:1,threads:{[source.threadId]:{cwd:home}}}));
 assert.equal(sourceForDisplay(home,source.traceId).workingDirectory,home);
});
test('source binding keeps the first working directory and will not replace an unreadable record',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-source-binding-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const first=path.join(home,'first'),other=path.join(home,'other');
 assert.equal(saveSource(home,source),true);
 assert.equal(saveSource(home,{...source,workingDirectory:first}),true);
 assert.equal(saveSource(home,{...source,workingDirectory:other}),true);
 assert.equal(readSource(home,source.traceId).workingDirectory,first);
 const {resumeTurnPayload}=require('../launch-codex.cjs');
 assert.equal(resumeTurnPayload({turns:()=>[{traceId:source.traceId,status:'completed',browserStatus:'completed',nativeState:canonicalNative(source),source:sourceForDisplay(home,source.traceId)}],snapshot:()=>({account:'B'})},source.traceId).workingDirectory,first);
 const file=path.join(home,'turn-sources',source.traceId+'.json');
 fs.writeFileSync(file,'{broken source');
 assert.equal(saveSource(home,{...source,workingDirectory:other}),false);
 assert.equal(fs.readFileSync(file,'utf8'),'{broken source');
 assert.equal(readSource(home,source.traceId),null);
});
test('resume opens exact original task and model without a prompt, and refuses live or unknown owners',()=>{
 const root=path.resolve(__dirname,'../../..'),row={traceId:source.traceId,status:'completed',browserStatus:'completed',nativeState:canonicalNative(source),source:{...source,workingDirectory:root}};
 const rows=[row],bridge={turns:()=>rows,snapshot:()=>({account:'B'})};
 const p=resumeTurnPayload(bridge,source.traceId),args=launchArguments(root,p);
 assert.equal(p.model,'pro');assert.deepEqual(args.slice(-2),['-Resume',source.threadId]);assert.equal(args.includes('-PromptFile'),false);
 rows.push({...row,traceId:'other',status:'running'});assert.throws(()=>resumeTurnPayload(bridge,source.traceId),/还有运行中/);
 rows.pop();row.status='needs_reconciliation';assert.throws(()=>resumeTurnPayload(bridge,source.traceId),/待核对/);
 row.status='completed';row.source=null;assert.throws(()=>resumeTurnPayload(bridge,source.traceId),/来源任务未核对/);
 assert.throws(()=>launchArguments(root,{model:'pro',workingDirectory:root,resume:'--evil'}));
});
test('resume uses canonical records even when the display cache advertises a different task',()=>{
 const root=path.resolve(__dirname,'../../..'),canonical={traceId:source.traceId,status:'completed',browserStatus:'completed',nativeState:canonicalNative(source),source:{...source,account:'A',workingDirectory:root}};
 const display={...canonical,source:{...canonical.source,threadId:source.turnId,model:'chatgpt-web/high',workingDirectory:root+'-old'}};
 const bridge={turns:()=>[canonical],snapshot:()=>({account:'A',recent:[display]})};
 const p=resumeTurnPayload(bridge,source.traceId);
 assert.equal(p.resume,source.threadId);assert.equal(p.model,'pro');assert.equal(p.workingDirectory,root);assert.equal(p.account,'A');
 const args=launchArguments(root,p);assert.equal(args[args.indexOf('-Account')+1],'A');
 bridge.turns=()=>[canonical,{...canonical,traceId:'another-trace',status:'running'}];
 assert.throws(()=>resumeTurnPayload(bridge,source.traceId),/还有运行中/);
});
test('native failure overlays and an unknown original browser state never grant resume',()=>{
 const root=path.resolve(__dirname,'../../..'),row={traceId:source.traceId,status:'failed',browserStatus:'completed',nativeState:canonicalNative(source,'failed'),source:{...source,workingDirectory:root}};
 let rows=[row];const bridge={turns:()=>rows,snapshot:()=>({account:'B'})};
 for(const browserStatus of ['running','preparing','needs_reconciliation','unexpected',undefined]){
   rows=[{...row,browserStatus}];assert.throws(()=>resumeTurnPayload(bridge,source.traceId),/运行或待核对/);
   rows=[row,{...row,traceId:'other',browserStatus}];assert.throws(()=>resumeTurnPayload(bridge,source.traceId),/还有运行中/);
 }
 for(const state of ['running','unavailable',undefined]){
   rows=[{...row,nativeState:{state}}];assert.throws(()=>resumeTurnPayload(bridge,source.traceId),/运行或待核对/);
   rows=[row,{...row,traceId:'other',nativeState:{state}}];assert.throws(()=>resumeTurnPayload(bridge,source.traceId),/还有运行中/);
 }
 for(const nativeState of [{state:'completed'}, {state:'completed',threadId:source.turnId,turnId:source.turnId},
     {state:'completed',threadId:source.threadId,turnId:source.threadId}]){
   rows=[{...row,nativeState}];assert.throws(()=>resumeTurnPayload(bridge,source.traceId),/运行或待核对/);
 }
});
test('display terminal evidence and an unmapped active native successor cannot authorize resume',()=>{
 const row={traceId:source.traceId,status:'completed',browserStatus:'completed',source:{...source,workingDirectory:__dirname},nativeState:canonicalNative(source)};
 const native=row.nativeState;
 for(const next of [{...native,source:'native_session_terminal'},
   {...native,nativeProof:undefined},{...native,nativeProof:{...native.nativeProof,kind:'display_cache'}},
   {...native,nativeProof:{...native.nativeProof,sessionSha256:'invalid'}},
   {...native,nativeProof:{...native.nativeProof,turnId:source.threadId}},
   {...native,nativeProof:{...native.nativeProof,terminal:'turn_aborted'}},
   {...native,threadActive:true,activeTurnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b04'},
   {...native,threadActive:undefined},{...native,activeTurnId:undefined},{...native,endedAt:'invalid'}])
   assert.throws(()=>resumeTurnPayload({turns:()=>[{...row,nativeState:next}],snapshot:()=>({account:'B'})},source.traceId),/运行或待核对/);
});
test('a missing, broken or malformed canonical reader never falls back to cached resume authority',()=>{
 const row={traceId:source.traceId,status:'completed',source:{...source,workingDirectory:__dirname}},snapshot=()=>({recent:[row]});
 for(const turns of [undefined,()=>null,()=>[null],()=>{throw Error('PRIVATE_READ_ERROR');}])
   assert.throws(()=>resumeTurnPayload({snapshot,turns},source.traceId),error=>/原始工作记录暂不可用/.test(error.message)&&!error.message.includes('PRIVATE'));
 assert.throws(()=>resumeTurnPayload({turns:()=>[row],snapshot:()=>({account:'A'})},source.traceId),/账号不同/);
});
test('ended webpage is not shown as business success or live local authority',()=>{
 const old=turnView({status:'completed',traceId:'123',submission:'confirmed'});
 assert.equal(old.canResume,false);assert.equal(old.title,'来源待核对');assert.match(old.note,/核对原任务/);assert.match(old.status,/等待／回收.*网页已结束/);assert.equal(old.step,2);
 assert.equal(turnView({status:'running',source:{...source,workingDirectory:'D:\\work'}}).canResume,false);
});
test('task grouping preserves native ownership across rounds and isolates unmapped history',()=>{
 const rows=[{traceId:'old',source,startedAt:'2026-01-01'},{traceId:'new',source,startedAt:'2026-02-01'},{traceId:'unknown1'},{traceId:'unknown2'}];
 const groups=groupRows(rows);assert.equal(groups.length,3);assert.equal(groups[0].latest.traceId,'new');
 assert.equal(groups[0].turns.length,2);assert.equal(filterRows(rows,source.threadId).length,2);
 assert.equal(filterRows(rows,'unmapped:unknown1').length,1);
 assert.match(turnView({status:'completed',publicState:{alerts:['Failed to fetch']}}).note,/连接失败/);
});
test('display environment parses the shared bounded file once per real revision across missing-cwd sources',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-display-env-cache-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const traces=['123456abcdef','abcdef123456','aabbccddeeff'];for(const traceId of traces)saveSource(home,{...source,traceId});
 fs.mkdirSync(path.join(home,'runtime'));const file=path.join(home,'runtime','thread-environments.json'),cwd=path.join(home,'first');
 const environment={version:1,threads:{[source.threadId]:{cwd}},unrelated:'x'.repeat(2*1024*1024)};
 fs.writeFileSync(file,JSON.stringify(environment));const original=fs.readFileSync;let reads=0;
 fs.readFileSync=function(target,...args){if(String(target)===file)reads++;return original.call(this,target,...args);};
 try{
  for(let iteration=0;iteration<3;iteration++)for(const traceId of traces)assert.equal(sourceForDisplay(home,traceId).workingDirectory,cwd);
  assert.equal(reads,1);
  const before=fs.statSync(file);environment.threads[source.threadId].cwd=path.join(home,'other');fs.writeFileSync(file,JSON.stringify(environment));fs.utimesSync(file,before.atime,before.mtime);
  for(const traceId of traces)assert.equal(sourceForDisplay(home,traceId).workingDirectory,environment.threads[source.threadId].cwd);assert.equal(reads,2);
  fs.writeFileSync(file,'{broken');for(const traceId of traces)assert.equal(sourceForDisplay(home,traceId).workingDirectory,undefined);assert.equal(reads,3);
  fs.truncateSync(file,4*1024*1024+1);for(const traceId of traces)assert.equal(sourceForDisplay(home,traceId).workingDirectory,undefined);assert.equal(reads,3);
 }finally{fs.readFileSync=original;}
});
