import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeTurnAdmission} from '../native-turn-admission';
import {verifyNativeCompactionFailureReceipt} from '../native-terminal-receipt.cjs';
import {encodeCompactionSummary} from '../upstream/src/responses/compaction';

const identity={threadId:'01a0dc7b-2a50-7140-a55b-eed50ff96b22',turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b23'};
const next={...identity,turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b24'};
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const summary='Keep the returned build and Player evidence, then implement the remaining content.';
const summaryHash=createHash('sha256').update(summary).digest('hex');
const stamp=(n:number)=>new Date(Date.UTC(2026,8,26,10,0,n)).toISOString();
const unavailable='ChatGPT model controls are unavailable. Reload ChatGPT and retry the task. ChatGPT: page.evaluate: Error: ChatGPT owned effort control is not unique';

function fixture(){
  const home=mkdtempSync(join(tmpdir(),'clw-checkpoint-recovery-')),sessions=join(home,'sessions');
  const write=(file:string,value:unknown)=>{mkdirSync(join(home,file,'..'),{recursive:true});writeFileSync(join(home,file),JSON.stringify(value));};
  const traces=['response_old1','compact_old01','response_fail1'];
  const old=createNativeTurnAdmission(home,'owner-old',sessions);
  for(const trace of traces)old.admit(identity,trace);
  const sources=traces.map((traceId,n)=>({traceId,...identity,purpose:n===1?'compaction':'response',account:'A',model:'chatgpt-web/pro',workingDirectory:home}));
  for(const source of sources)write('turn-sources/'+source.traceId+'.json',source);
  write('turn-reviews/'+traces[1]+'.json',{traceId:traces[1],...identity,finalSha256:summaryHash});
  const url='https://chatgpt.com/c/exact-owned-conversation';
  const turns=[{traceId:traces[0],url,account:'A',submission:'confirmed',status:'completed',startedAt:stamp(1),endedAt:stamp(4)},
    {traceId:'physical_compact1',url,account:'A',submission:'confirmed',status:'completed',startedAt:stamp(4),endedAt:stamp(6)},
    {traceId:traces[2],url:null,account:'A',submission:'not-observed',status:'failed',startedAt:stamp(8),endedAt:stamp(10),
      publicState:{alerts:[],assistantTurns:0,loginRequired:false,usageLimited:false,userTurns:0}}];
  for(const turn of turns)write('turns/'+turn.traceId+'.json',turn);
  const events=turns.flatMap(t=>[{at:t.startedAt,traceId:t.traceId,event:'browser.turn_started'},
    {at:t.endedAt,traceId:t.traceId,event:'browser.turn_ended',status:t.status}]);
  const activity=()=>writeFileSync(join(home,'activity.jsonl'),events.map(e=>JSON.stringify(e)).join('\n'));
  activity();
  const diagnostic={traceId:traces[2],checkpoint:'turn-failed',capturedAt:stamp(9),error:unavailable,
    state:{location:{origin:'https://chatgpt.com',pathSegments:0},surfaceBound:true,
      composer:{visibleCount:1,textChars:[0]},effortControls:[],turns:{user:0,assistant:[],stopButtonCount:0}}};
  const diagnosticFile='diagnostics/browser-turns/'+traces[2]+'-original/05-turn-failed.json';write(diagnosticFile,diagnostic);
  const settlement={version:1,...identity,traceId:traces[2],kind:'upstream_physical_settlement',sourceSha256:sha(sources[2]),
    turnSha256:sha(turns[2]),receiptSha256:'a'.repeat(64),observedAt:stamp(10),automaticReplay:false};
  const settlementFile='runtime/native-turn-admission/failed-settlement-'+traces[2]+'.json';write(settlementFile,settlement);
  const rows:any[]=[{type:'session_meta',payload:{id:identity.threadId}},
    {timestamp:stamp(0),type:'event_msg',payload:{type:'task_started',turn_id:identity.turnId}},
    {timestamp:stamp(2),type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'call_build'}},
    {timestamp:stamp(2),type:'response_item',payload:{type:'function_call_output',call_id:'call_build',output:'Chunk ID: x\nWall time: 1 seconds\nProcess running with session ID 77\nOutput:\n'}},
    {timestamp:stamp(3),type:'event_msg',payload:{type:'item_completed',thread_id:identity.threadId,turn_id:identity.turnId,
      started_at_ms:Date.parse(stamp(2)),completed_at_ms:Date.parse(stamp(3)),item:{type:'CommandExecution',id:'call_build',process_id:'77',status:'completed',exit_code:0}}},
    {timestamp:stamp(3),type:'response_item',payload:{type:'function_call',name:'write_stdin',call_id:'call_poll'}},
    {timestamp:stamp(3),type:'response_item',payload:{type:'function_call_output',call_id:'call_poll',output:'Chunk ID: y\nWall time: 1 seconds\nProcess exited with code 0\nOutput:\n'}},
    {timestamp:stamp(3),type:'response_item',payload:{type:'custom_tool_call',name:'apply_patch',call_id:'call_patch'}},
    {timestamp:stamp(3),type:'response_item',payload:{type:'custom_tool_call_output',call_id:'call_patch',output:'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated files.'}},
    {timestamp:stamp(3),type:'response_item',payload:{type:'function_call',name:'view_image',call_id:'call_image'}},
    {timestamp:stamp(3),type:'event_msg',payload:{type:'item_completed',thread_id:identity.threadId,turn_id:identity.turnId,
      started_at_ms:Date.parse(stamp(3)),completed_at_ms:Date.parse(stamp(3)),item:{type:'ImageView',id:'call_image',path:'file:///exact.png'}}},
    {timestamp:stamp(3),type:'response_item',payload:{type:'function_call_output',call_id:'call_image',output:[{type:'input_image',image_url:'data:image/png;base64,YQ=='}]}},
    {timestamp:stamp(3),type:'response_item',payload:{type:'tool_search_call',call_id:'call_search',status:'completed',execution:'client'}},
    {timestamp:stamp(3),type:'response_item',payload:{type:'tool_search_output',call_id:'call_search',status:'completed',execution:'client',tools:[]}},
    {timestamp:stamp(7),type:'compacted',payload:{replacement_history:[{type:'compaction',encrypted_content:encodeCompactionSummary(summary)}]}},
    {timestamp:stamp(11),type:'event_msg',payload:{type:'task_complete',turn_id:identity.turnId,last_agent_message:null,error:{message:'stream disconnected before completion: '+unavailable}}}];
  const day=join(sessions,'2026','09','26');mkdirSync(day,{recursive:true});
  const sessionFile=join(day,`rollout-fixture-${identity.threadId}.jsonl`);
  const native=()=>writeFileSync(sessionFile,rows.map(r=>JSON.stringify(r)).join('\n'));native();
  return {home,sessions,traces,sources,turns,events,activity,rows,native,write,diagnostic,diagnosticFile,settlement,settlementFile,
    clean:()=>rmSync(home,{recursive:true,force:true})};
}

test('accepted checkpoint and exact tool terminals settle the whole ended turn and preserve original browser results',()=>{
  const f=fixture();try{
    const before=readFileSync(join(f.home,'turns/'+f.traces[0]+'.json'));
    const proof=verifyNativeCompactionFailureReceipt({...identity,sessionsRoot:f.sessions,expectedCheckpointSha256:summaryHash});
    expect(proof.returnedTools).toBe(5);expect(proof.kind).toBe('native_failed_after_matching_checkpoint');
    const gate=createNativeTurnAdmission(f.home,'owner-new',f.sessions);
    expect(gate.reconcileThread(identity.threadId)).toEqual({settledFailures:1,unresolved:0});
    expect(()=>gate.admit(identity,'changed_old01')).toThrow();expect(()=>gate.admit(identity,f.traces[0])).toThrow();
    expect(gate.admit(next,'next_response1').replayOnly).toBe(false);
    expect(readFileSync(join(f.home,'turns/'+f.traces[0]+'.json'))).toEqual(before);
  }finally{f.clean();}
});

test.each(['text','image'])('canonical native MCP completion binds the same call, arguments and returned %s',kind=>{
  const f=fixture();try{
    const content=kind==='text'?[{type:'text',text:'Actual terminal result'}]:
      [{type:'image',data:'YQ==',mimeType:'image/png',_meta:{'codex/imageDetail':'original'}}];
    const output=kind==='text'?[{type:'input_text',text:'Actual terminal result'}]:
      [{type:'input_image',image_url:'data:image/png;base64,YQ==',detail:'original'}];
    f.rows.splice(14,0,
      {timestamp:stamp(3),type:'response_item',payload:{type:'function_call',call_id:'call_mcp',name:'js',arguments:'{"code":"actual call"}'}},
      {timestamp:stamp(3),type:'event_msg',payload:{type:'item_completed',thread_id:identity.threadId,turn_id:identity.turnId,
        started_at_ms:Date.parse(stamp(3)),completed_at_ms:Date.parse(stamp(3)),item:{type:'McpToolCall',id:'call_mcp',
          server:'node_repl',tool:'js',arguments:{code:'actual call'},status:'completed',result:{isError:false,content}}}},
      {timestamp:stamp(3),type:'response_item',payload:{type:'function_call_output',call_id:'call_mcp',
        output:[{type:'input_text',text:'Wall time: 1 seconds\nOutput:'},...output]}});
    f.native();
    expect(verifyNativeCompactionFailureReceipt({...identity,sessionsRoot:f.sessions,expectedCheckpointSha256:summaryHash}).returnedTools).toBe(6);
    for(const change of [
      ()=>{f.rows[15].payload.item.status='in_progress';},
      ()=>{f.rows[15].payload.item.arguments={code:'foreign call'};},
      ()=>{f.rows[15].payload.item.tool='unknown_tool';},
      ()=>{f.rows[15].payload.thread_id=next.turnId;},
      ()=>{f.rows[16].payload.output[1]={type:'input_text',text:'Foreign result'};},
    ]){
      const saved=JSON.parse(JSON.stringify(f.rows));change();f.native();
      expect(()=>verifyNativeCompactionFailureReceipt({...identity,sessionsRoot:f.sessions,expectedCheckpointSha256:summaryHash})).toThrow();
      f.rows.splice(0,f.rows.length,...saved);
    }
  }finally{f.clean();}
});

function idleAcquisitionFixture(){
  const f=fixture();
  rmSync(join(f.home,'diagnostics/browser-turns/'+f.traces[2]+'-original'),{recursive:true});
  const error='stream disconnected before completion: The original in-memory browser round is no longer available for replay. Reconcile the original turn; no new Web message was sent.';
  f.rows.at(-1).payload.error.message=error;f.native();
  f.turns[2].tabId='owned_failed_tab';f.write('turns/'+f.traces[2]+'.json',f.turns[2]);
  const proof=verifyNativeCompactionFailureReceipt({...identity,sessionsRoot:f.sessions,expectedCheckpointSha256:summaryHash});
  const url='data:text/html;charset=utf-8,owned-empty-document#codex-web-gpt-browser-host';
  const audit={version:1,kind:'original_idle_acquisition_failure',at:stamp(12),...identity,traceId:f.traces[2],
    sourceSha256:sha(f.sources[2]),turnSha256:sha(f.turns[2]),nativeReceiptSha256:proof.receiptSha256,ownerAlive:false,claimState:'released',
    host:{account:'A',status:'error',traceId:f.traces[2],tabId:'owned_failed_tab',url,ownerPid:123,runtimePid:124,
      message:'Launcher browser CDP endpoint is not ready: This operation was aborted'},
    health:{pid:124,active_http_turns:0,active_browser_turns:0},
    pages:[{url,userTurns:0,assistantTurns:0,stopButtons:0,composers:0,bodyChars:0,readyState:'complete'}],modelSends:0};
  const auditFile='runtime/native-turn-admission/prepage-audit-'+f.traces[2]+'.json';f.write(auditFile,audit);
  return {...f,audit,auditFile};
}

test('an original idle-surface audit closes only its failed checkpoint group and forbids replay',()=>{
  const f=idleAcquisitionFixture();try{
    const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);
    expect(gate.reconcileThread(identity.threadId)).toEqual({settledFailures:1,unresolved:0});
    expect(()=>gate.admit(identity,f.traces[0])).toThrow();expect(()=>gate.admit(identity,'old_trace_changed')).toThrow();
    expect(gate.admit(next,'next_response1').replayOnly).toBe(false);
  }finally{f.clean();}
});
test.each(['live_owner','held_claim','active_native','foreign_native','foreign_trace','nonempty_page','draft','duplicate_pages','before_terminal','unmatched_receipt'])
  ('uncertain original acquisition audit keeps its checkpoint group held: %s',change=>{
    const f=idleAcquisitionFixture();try{
      if(change==='live_owner')f.audit.ownerAlive=true;
      if(change==='held_claim')f.audit.claimState='terminal_pending';
      if(change==='active_native')f.audit.health.active_browser_turns=1;
      if(change==='foreign_native')f.audit.health.pid=125;
      if(change==='foreign_trace')f.audit.host.traceId='foreign_trace1';
      if(change==='nonempty_page')f.audit.pages[0].bodyChars=1;
      if(change==='draft')f.audit.pages[0].composers=1;
      if(change==='duplicate_pages')f.audit.pages.push({...f.audit.pages[0]});
      if(change==='before_terminal')f.audit.at=stamp(10);
      if(change==='unmatched_receipt')f.audit.nativeReceiptSha256='f'.repeat(64);
      f.write(f.auditFile,f.audit);
      const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);
      expect(gate.reconcileThread(identity.threadId)).toEqual({settledFailures:0,unresolved:1});
      expect(()=>gate.admit(next,'next_response1')).toThrow();
    }finally{f.clean();}
  });

const invalid:Record<string,(f:ReturnType<typeof fixture>)=>void>={
  missing_checkpoint:f=>{f.rows.splice(14,1);f.native();},
  foreign_checkpoint:f=>{f.rows[14].payload.replacement_history[0].encrypted_content=encodeCompactionSummary('foreign');f.native();},
  missing_command_terminal:f=>{f.rows.splice(4,1);f.native();},
  foreign_process:f=>{f.rows[4].payload.item.process_id='88';f.native();},
  unfinished_command:f=>{f.rows[4].payload.item.status='running';f.rows[4].payload.item.exit_code=null;f.native();},
  foreign_native_turn:f=>{f.rows[4].payload.turn_id=next.turnId;f.native();},
  missing_tool_return:f=>{f.rows.splice(6,1);f.native();},
  unknown_tool:f=>{f.rows[5].payload.name='unverified_tool';f.native();},
  wrong_output_kind:f=>{f.rows[6].payload.type='custom_tool_call_output';f.native();},
  missing_image_receipt:f=>{f.rows.splice(10,1);f.native();},
  incomplete_tool_search:f=>{f.rows[13].payload.status='running';f.native();},
  user_stop:f=>{f.rows[15].payload={type:'turn_aborted',turn_id:identity.turnId};f.native();},
  known_final:f=>{f.rows.splice(15,0,{timestamp:stamp(10),type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'final'}]}});f.native();},
  draft_present:f=>{f.diagnostic.state.composer.textChars=[8];f.write(f.diagnosticFile,f.diagnostic);},
  control_ambiguous:f=>{(f.diagnostic.state.effortControls as any[]).push({});f.write(f.diagnosticFile,f.diagnostic);},
  prompt_attached:f=>f.write(f.diagnosticFile.replace('05-turn-failed','04-prompt-attached'),{}),
  different_error:f=>{f.diagnostic.error='Explicit policy rejection';f.write(f.diagnosticFile,f.diagnostic);},
  different_native_error:f=>{f.rows[15].payload.error.message='Explicit policy rejection';f.native();},
  changed_cleanup:f=>{f.settlement.turnSha256='b'.repeat(64);f.write(f.settlementFile,f.settlement);},
  missing_browser_end:f=>{f.events.pop();f.activity();},
  source_account_changed:f=>{f.sources[2].account='B';f.write('turn-sources/'+f.traces[2]+'.json',f.sources[2]);},
  live_physical_handoff:f=>{f.turns[1].status='running';f.write('turns/'+f.turns[1].traceId+'.json',f.turns[1]);},
};
for(const [name,modify] of Object.entries(invalid))test('checkpoint recovery remains closed: '+name,()=>{
  const f=fixture();try{
    modify(f);const gate=createNativeTurnAdmission(f.home,'owner-new',f.sessions);
    expect(gate.reconcileThread(identity.threadId)).toEqual({settledFailures:0,unresolved:1});
    expect(()=>gate.admit(next,'next_response1')).toThrow();
  }finally{f.clean();}
});

test('changed evidence invalidates a saved group settlement on the next admission',()=>{
  const f=fixture();try{
    const gate=createNativeTurnAdmission(f.home,'owner-new',f.sessions);gate.reconcileThread(identity.threadId);
    f.turns[1].status='running';f.write('turns/'+f.turns[1].traceId+'.json',f.turns[1]);
    expect(()=>gate.admit(next,'next_response1')).toThrow();
  }finally{f.clean();}
});
