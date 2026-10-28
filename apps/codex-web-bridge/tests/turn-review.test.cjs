const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {saveSource}=require('../turn-source.cjs'),{classify,saveReview,readReview}=require('../turn-review.cjs'),{importReview}=require('../import-review.cjs');
const {turnView}=require('../../web-host/codex-turns.js');
const identity={traceId:'123456abcdef',threadId:'01a0dc7b-2a50-7140-a55b-eed50ff96b02',turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b03',model:'chatgpt-web/pro'};
test('the exact English ChatGPT safety message is reported without claiming platform telemetry',()=>{
 const message="This tool call was blocked by OpenAI because we couldn't determine the safety status of the request.";
 const blockers=classify(message);
 assert.equal(blockers.length,1);
 assert.equal(blockers[0].code,'platform_safety_block_reported');
 assert.equal(blockers[0].evidence,'reported_not_independently_verified');
 assert.equal(blockers[0].automaticRetry,false);
});
test('local path denial is not platform refusal or successful task completion',()=>{
 const blockers=classify('Local-MCP returned path\\_outside\\_allowed\\_roots. No files changed.');
 assert.deepEqual(blockers.map(b=>b.code),['local_path_denied_reported']);
 assert.equal(blockers[0].automaticRetry,false);
 assert.equal(blockers[0].evidence,'reported_not_independently_verified');
 const view=turnView({status:'completed',review:{reportedBlockers:blockers}});
 assert.equal(view.needsAttention,true);
 assert.match(view.status,/报告待核对/);
 assert.match(blockers[0].label,/目录访问被拒/);
});
test('reported errors remain distinct from completed transport and never expose output or credentials',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-review-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));saveSource(home,identity);
 const text="PRIVATE_BODY unknown model-visible runtime tool 'codex\\_tool\\_call'";
 assert.equal(saveReview(home,identity.traceId,text),true);const review=readReview(home,identity.traceId);
 assert.equal(review.finalSha256,crypto.createHash('sha256').update(text).digest('hex'));
 assert.equal(review.reportedBlockers[0].code,'tool_discovery_unavailable_reported');assert.equal(review.reportedBlockers[0].automaticRetry,false);
 const row={source:identity,status:'completed',review},v=turnView(row);
 assert.equal(row.status,'completed');assert.equal(v.needsAttention,true);assert.match(v.status,/本轮结束.*报告待核对/);assert.match(v.note,/尚未经独立核验/);assert.equal(v.step,null);
 assert.ok(!fs.readFileSync(path.join(home,'turn-reviews',identity.traceId+'.json'),'utf8').includes('PRIVATE_BODY'));
 assert.equal(saveReview(home,'not-owned',text),false);assert.equal(readReview(home,'../../outside'),null);
 const sourceFile=path.join(home,'turn-sources',identity.traceId+'.json');fs.writeFileSync(sourceFile,JSON.stringify({...identity,turnId:identity.threadId}));assert.equal(readReview(home,identity.traceId),null);
 assert.equal(classify('Completed successfully.').length,0);
 const offline=classify('ERR\\_NGROK\\_3200: MCP endpoint offline');
 assert.deepEqual(offline.map(r=>r.code),['connector_endpoint_offline_reported']);
 assert.equal(offline[0].automaticRetry,false);
 const offlineView=turnView({status:'completed',review:{reportedBlockers:offline}});
 assert.equal(offlineView.needsAttention,true);
 assert.match(offlineView.status,/报告待核对/);
 assert.match(offline[0].label,/连接器离线/);
});
test('a successful native turn still flags an earlier reported safety refusal for review',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-mixed-review-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));saveSource(home,identity);
 const final='Readback and two tests passed. One initial combined read call was blocked with: 因 OpenAI 无法确定请求的安全状态，已拦截此工具调用。 Subsequent scoped reads succeeded.';
 assert.equal(saveReview(home,identity.traceId,final),true);
 const review=readReview(home,identity.traceId),blocker=review.reportedBlockers[0];
 assert.equal(blocker.code,'platform_safety_block_reported');
 assert.equal(blocker.source,'assistant_final');
 assert.equal(blocker.evidence,'reported_not_independently_verified');
 assert.equal(blocker.automaticRetry,false);
 const v=turnView({source:identity,status:'completed',submission:'confirmed',review});
 assert.equal(v.needsAttention,true);
 assert.match(v.status,/本轮结束.*报告待核对/);
 assert.match(v.note,/核对后续工具回执和实际成果.*尚未经独立核验/);
 assert.equal(v.sent,'已确认送达');
});
test('a reported fault does not erase a real failed or stopped transport',()=>{
 const review={reportedBlockers:classify('ERR_NGROK_3200: MCP endpoint offline')};
 assert.match(turnView({status:'failed',review}).status,/网页回合异常/);
 assert.match(turnView({status:'aborted',review}).status,/已停止/);
 assert.match(turnView({status:'completed',nativeState:{state:'failed'},review}).status,/执行失败/);
});
test('historical imports require the exact native identity, model, execution window and final receipt',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-import-review-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));saveSource(home,identity);
 const dir=path.join(home,'packet');fs.mkdirSync(dir);fs.mkdirSync(path.join(home,'turns'));
 const sessionsRoot=path.join(home,'sessions'),sessionDir=path.join(sessionsRoot,'2026','09','26');fs.mkdirSync(sessionDir,{recursive:true});
 const sessionFile=path.join(sessionDir,`rollout-2026-09-26T06-50-54-${identity.threadId}.jsonl`);
 fs.writeFileSync(path.join(home,'turns',identity.traceId+'.json'),JSON.stringify({traceId:identity.traceId,status:'completed',startedAt:'2026-09-26T10:00:01Z'}));
 const execution={state:'turn_completed',exitCode:0,model:identity.model,sourceThread:identity.threadId,startedAt:'2026-09-26T10:00:00Z',endedAt:'2026-09-26T10:00:02Z'};
 fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify(execution));const text='409 Duplicate active request ID';fs.writeFileSync(path.join(dir,'final.md'),text);
 const events=thread=>[{type:'thread.started',thread_id:thread},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed'}].map(e=>JSON.stringify(e)).join('\n');
 const session=(turnId=identity.turnId,finalText=text,withFinal=true)=>[
  {timestamp:'2026-09-26T06:50:54Z',type:'session_meta',payload:{id:identity.threadId}},
  {timestamp:'2026-09-26T10:00:00Z',type:'event_msg',payload:{type:'task_started',turn_id:turnId}},
  ...(withFinal?[{timestamp:'2026-09-26T10:00:01Z',type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:finalText}]}}]:[]),
  {timestamp:'2026-09-26T10:00:02Z',type:'event_msg',payload:{type:'task_complete',turn_id:turnId,last_agent_message:finalText}},
 ].map(e=>JSON.stringify(e)).join('\n');
 fs.writeFileSync(sessionFile,session());
 fs.writeFileSync(path.join(dir,'events.jsonl'),'\uFEFF'+events(identity.threadId),'utf16le');
 assert.equal(importReview(home,identity.traceId,dir,{sessionsRoot}).exactNativeTurn,true);
 assert.equal(readReview(home,identity.traceId).nativeProof.turnId,identity.turnId);
 fs.rmSync(path.join(home,'turn-reviews',identity.traceId+'.json'));
 fs.writeFileSync(path.join(dir,'events.jsonl'),events(identity.turnId));assert.throws(()=>importReview(home,identity.traceId,dir),/receipt_mismatch/);
 fs.writeFileSync(path.join(dir,'events.jsonl'),events(identity.threadId));
 fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({...execution,model:'chatgpt-web/extra-high'}));assert.throws(()=>importReview(home,identity.traceId,dir,{sessionsRoot}),/binding_mismatch/);
 fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify(execution));
 fs.writeFileSync(sessionFile,session('01a0dc7b-2a50-7140-a55b-eed50ff96b04'));
 assert.throws(()=>importReview(home,identity.traceId,dir,{sessionsRoot}),/native_receipt_terminal_missing/);
 fs.writeFileSync(sessionFile,session(identity.turnId,text,false));
 assert.throws(()=>importReview(home,identity.traceId,dir,{sessionsRoot}),/native_receipt_terminal_missing/);
 fs.writeFileSync(sessionFile,session());
 fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({...execution,sourceThread:identity.turnId}));
 assert.throws(()=>importReview(home,identity.traceId,dir,{sessionsRoot}),/binding_mismatch/);
 fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({...execution,exitCode:1}));
 assert.throws(()=>importReview(home,identity.traceId,dir,{sessionsRoot}),/binding_mismatch/);
 fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify(execution));
 fs.writeFileSync(sessionFile,session().replace('2026-09-26T10:00:00Z','2026-09-26T09:00:00Z'));
 assert.throws(()=>importReview(home,identity.traceId,dir,{sessionsRoot}),/native_receipt_window_mismatch/);
 fs.writeFileSync(sessionFile,session());
 fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({...execution,startedAt:'2026-09-26T10:00:03Z'}));
 assert.throws(()=>importReview(home,identity.traceId,dir,{sessionsRoot}),/binding_mismatch|native_receipt_window_mismatch/);
 fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify(execution));
 fs.writeFileSync(path.join(dir,'events.jsonl'),[{type:'thread.started',thread_id:identity.threadId},{type:'turn.completed'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text}}].map(e=>JSON.stringify(e)).join('\n'));
 assert.throws(()=>importReview(home,identity.traceId,dir,{sessionsRoot}),/receipt_mismatch/);
 assert.equal(readReview(home,identity.traceId),null);
});
