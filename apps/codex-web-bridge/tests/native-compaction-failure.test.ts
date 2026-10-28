import {test, expect} from 'bun:test';
import fs,{mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeTurnAdmission} from '../native-turn-admission';
import {reconcileNativeCompactionFailure} from '../native-compaction-failure.cjs';

const identity = {threadId:'01a0dc7b-2a50-7140-a55b-eed50ff96b02',turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b03'};
const next = {...identity,turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b04'};
const traces = ['response_trace1', 'compact_trace01'];
const stamp = (n:number) => `2026-09-26T10:00:0${n}Z`;
function fixture(options:{missingOutput?:boolean; runningTool?:boolean; missingTerminal?:boolean; stopped?:boolean;
  missingEnd?:boolean; liveBrowser?:boolean; unknownTool?:boolean; patch?:boolean; badIdentity?:boolean}={}) {
  const home = mkdtempSync(join(tmpdir(), 'clw-compact-failure-')), sessions = join(home,'sessions');
  const write = (name:string,value:unknown) => {mkdirSync(join(home,name,'..'),{recursive:true});writeFileSync(join(home,name),JSON.stringify(value));};
  const gate = createNativeTurnAdmission(home,'old-owner',sessions);
  for (const [n,traceId] of traces.entries()) {
    gate.admit(identity,traceId);
    write(`turn-sources/${traceId}.json`,{traceId,...identity,purpose:n?'compaction':'response'});
  }
  if(options.badIdentity)write(`turn-sources/${traces[1]}.json`,{traceId:traces[1],...next,purpose:'compaction'});
  const url = 'https://chatgpt.com/c/exact-owned-conversation';
  write(`turns/${traces[0]}.json`,{traceId:traces[0],url,submission:'confirmed',status:'completed',startedAt:stamp(1),endedAt:stamp(3)});
  write('turns/handoff_trace01.json',{traceId:'handoff_trace01',url,submission:'confirmed',status:options.liveBrowser?'running':'completed',startedAt:stamp(4),endedAt:options.liveBrowser?undefined:stamp(6)});
  const events = [{at:stamp(1),traceId:traces[0],event:'browser.turn_started'},
    {at:stamp(3),traceId:traces[0],event:'browser.turn_ended',status:'completed'},
    {at:stamp(4),traceId:'handoff_trace01',event:'browser.turn_started'}];
  if(!options.missingEnd)events.push({at:stamp(6),traceId:'handoff_trace01',event:'browser.turn_ended',status:'completed'} as any);
  writeFileSync(join(home,'activity.jsonl'),events.map(v=>JSON.stringify(v)).join('\n'));
  const rows:any[]=[{type:'session_meta',payload:{id:identity.threadId}},
    {timestamp:stamp(0),type:'event_msg',payload:{type:'task_started',turn_id:identity.turnId}},
    {timestamp:stamp(2),type:'response_item',payload:{type:options.patch?'custom_tool_call':'function_call',name:options.unknownTool?'unverified_tool':options.patch?'apply_patch':'exec_command',call_id:'call_one',
      ...(options.patch?{input:'*** Begin Patch\n*** Update File: demo.cs\n@@\n-old\n+new\n*** End Patch'}:{arguments:JSON.stringify({cmd:'node fixture.cjs',workdir:'D:/fixture'})})}}];
  rows.push({timestamp:stamp(2),type:'event_msg',payload:{type:'item_completed',thread_id:identity.threadId,turn_id:identity.turnId,
    started_at_ms:Date.parse(stamp(2)),completed_at_ms:Date.parse(stamp(2)),item:options.patch?
      {type:'FileChange',id:'call_one',status:'completed',changes:{'demo.cs':{type:'update'}},stdout:'Success. Updated the following files:\nM demo.cs',stderr:''}:
      {type:'CommandExecution',id:'call_one',status:options.runningTool?'in_progress':'completed',exit_code:options.runningTool?null:0,
        command:['node','fixture.cjs','node fixture.cjs'],cwd:'D:/fixture',process_id:'32',aggregated_output:'ordinary result'}}});
  if(!options.missingOutput)rows.push({timestamp:stamp(2),type:'response_item',payload:{type:options.patch?'custom_tool_call_output':'function_call_output',call_id:'call_one',
    output:options.runningTool?'Chunk ID: x\nWall time: 1 seconds\nProcess running with session ID 32\nOutput:\nProcess exited with code 0\n':options.patch?'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM demo.cs':'Chunk ID: x\nWall time: 1 seconds\nProcess exited with code 0\nOutput:\nordinary result'}});
  if(options.stopped)rows.push({timestamp:stamp(7),type:'event_msg',payload:{type:'turn_aborted',turn_id:identity.turnId}});
  if(!options.missingTerminal)rows.push({timestamp:stamp(7),type:'event_msg',payload:{type:'task_complete',turn_id:identity.turnId,last_agent_message:null,error:{message:'Error running remote compact task: original error'}}});
  const day=join(sessions,'2026','09','26');mkdirSync(day,{recursive:true});
  writeFileSync(join(day,`rollout-fixture-${identity.threadId}.jsonl`),rows.map(v=>JSON.stringify(v)).join('\n'));
  return {home,sessions,clean:()=>rmSync(home,{recursive:true,force:true})};
}
test('settled compaction failure reconciles all original traces without replay or success',()=>{
  const f=fixture();try {
    const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);
    expect(gate.reconcileThread(identity.threadId)).toEqual({settledFailures:1,unresolved:0});
    expect(()=>gate.admit(identity,traces[0])).toThrow();
    expect(()=>gate.admit(identity,'changed_trace01')).toThrow();
    expect(gate.admit(next,'next_response01').replayOnly).toBe(false);
    expect(JSON.parse(readFileSync(join(f.home,'turns',traces[0]+'.json'),'utf8')).status).toBe('completed');
  } finally {f.clean();}
});
test('native terminal patch envelope is admissible and its body does not become a final answer',()=>{
  const f=fixture({patch:true});try {expect(reconcileNativeCompactionFailure(f.home,identity,traces,f.sessions)).toBe(true);}finally{f.clean();}
});

test('unrelated history above 4096 turns and 64 MiB activity cannot impose a lifetime refusal',()=>{
 const f=fixture();try{
  for(let n=0;n<4100;n++)writeFileSync(join(f.home,'turns',`history_trace_${String(n).padStart(5,'0')}.json`),JSON.stringify({traceId:`history_trace_${n}`,url:'https://chatgpt.com/c/unrelated-history',startedAt:'2026-09-25T10:00:00Z',endedAt:'2026-09-25T10:01:00Z',status:'completed',submission:'confirmed'}));
  const file=join(f.home,'activity.jsonl'),original=readFileSync(file),fd=fs.openSync(file,'w');
  const old=JSON.stringify({at:'2026-09-25T10:00:00Z',event:'old_history',traceId:'unrelated_history',padding:'x'.repeat(1024*1024)})+'\n';
  for(let n=0;n<66;n++)fs.writeSync(fd,old);fs.writeSync(fd,original);fs.closeSync(fd);expect(fs.statSync(file).size).toBeGreaterThan(64*1024*1024);
  const nativeRead=fs.readFileSync;let wholeReads=0;
  fs.readFileSync=((...args:any[])=>{if(args[0]===file){wholeReads++;throw Error('whole activity read forbidden');}return (nativeRead as any)(...args);}) as any;
  try{expect(reconcileNativeCompactionFailure(f.home,identity,traces,f.sessions)).toBeTrue();expect(wholeReads).toBe(0);}
  finally{fs.readFileSync=nativeRead;}
  // An original additional physical turn lacking its end remains unresolved.
  writeFileSync(join(f.home,'turns','late_unknown_trace.json'),JSON.stringify({traceId:'late_unknown_trace',url:'https://chatgpt.com/c/exact-owned-conversation',submission:'confirmed',status:'running',startedAt:stamp(4)}));
  expect(reconcileNativeCompactionFailure(f.home,identity,traces,f.sessions)).toBeFalse();
 }finally{f.clean();}
},30000);

test('a complete 802-trace original group is sharded without dropping late source/physical hashes',()=>{
 const f=fixture(),group=[...traces],url='https://chatgpt.com/c/exact-owned-conversation';try{
  const activity=readFileSync(join(f.home,'activity.jsonl'),'utf8');let extra='';
  for(let n=0;n<800;n++){
   const traceId='long_response_'+String(n).padStart(5,'0')+'_'+'x'.repeat(100);group.push(traceId);
   writeFileSync(join(f.home,'turn-sources',traceId+'.json'),JSON.stringify({...identity,traceId,purpose:'response'}));
   writeFileSync(join(f.home,'turns',traceId+'.json'),JSON.stringify({traceId,url,submission:'confirmed',status:'completed',startedAt:stamp(1),endedAt:stamp(3)}));
   extra+=JSON.stringify({at:stamp(1),event:'browser.turn_started',traceId})+'\n'+JSON.stringify({at:stamp(3),event:'browser.turn_ended',traceId,status:'completed'})+'\n';
  }
  writeFileSync(join(f.home,'activity.jsonl'),activity+'\n'+extra);
  expect(reconcileNativeCompactionFailure(f.home,identity,group,f.sessions)).toBeTrue();
  const evidence=require('../native-compaction-evidence.cjs'),dir=join(f.home,'runtime/native-turn-admission');
  const file=join(dir,fs.readdirSync(dir).find((name:string)=>name.startsWith('compaction-failure-')&&name.endsWith('.json'))!);
  const manifest=JSON.parse(readFileSync(file,'utf8'));expect(manifest.kind).toBe('native_compaction_group_manifest');
  const record=JSON.parse(evidence.read(file));expect(record.sources).toHaveLength(802);expect(record.physical).toHaveLength(802);
  expect(record.sources.at(-1).traceId).toBe(group.at(-1));expect(reconcileNativeCompactionFailure(f.home,identity,group,f.sessions)).toBeTrue();
  const originalPart=join(file+'.parts','sources-0.json'),originalBytes=readFileSync(originalPart),nativeRead=fs.readFileSync;let reads=0;
  fs.readFileSync=((...args:any[])=>{const result=(nativeRead as any)(...args);if(typeof args[0]==='number'&&++reads===3)writeFileSync(originalPart,Buffer.concat([originalBytes,Buffer.from('\n')]));return result;}) as any;
  try{expect(()=>evidence.read(file)).toThrow('group_changed');}finally{fs.readFileSync=nativeRead;writeFileSync(originalPart,originalBytes);}
  const last=group.at(-1)!;writeFileSync(join(f.home,'turns',last+'.json'),JSON.stringify({traceId:last,url,submission:'confirmed',status:'running',startedAt:stamp(1)}));
  expect(reconcileNativeCompactionFailure(f.home,identity,group,f.sessions)).toBeFalse();
  const parts=join(file+'.parts'),part=join(parts,fs.readdirSync(parts)[0]!);writeFileSync(part,'{"changed":true}');
  expect(()=>evidence.read(file)).toThrow();
 }finally{f.clean();}
},30000);
for(const options of [{missingOutput:true},{runningTool:true},{missingTerminal:true},{stopped:true},
  {missingEnd:true},{liveBrowser:true},{unknownTool:true},{badIdentity:true}]) {
  test(`incomplete compaction evidence remains closed: ${JSON.stringify(options)}`,()=>{
    const f=fixture(options);try {
      const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);
      expect(gate.reconcileThread(identity.threadId)).toEqual({settledFailures:0,unresolved:1});
      expect(()=>gate.admit(next,'next_response01')).toThrow();
    } finally {f.clean();}
  });
}
test('changed original browser evidence invalidates a saved failure settlement',()=>{
  const f=fixture();try {
    const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);gate.reconcileThread(identity.threadId);
    writeFileSync(join(f.home,'turns/handoff_trace01.json'),JSON.stringify({traceId:'handoff_trace01',status:'running'}));
    expect(()=>gate.admit(next,'next_response01')).toThrow();
  } finally {f.clean();}
});

function retainedBeforePageFixture(options:Parameters<typeof fixture>[0]={}) {
  const f=fixture(options),logical=traces[1],physical='handoff_trace01';
  const update=(name:string,fields:unknown)=>{const file=join(f.home,name);writeFileSync(file,JSON.stringify({...JSON.parse(readFileSync(file,'utf8')),...fields as object}));};
  for(const trace of traces)update(`turn-sources/${trace}.json`,{account:'A'});
  update(`turns/${traces[0]}.json`,{account:'A',tabId:'original-owned-tab'});
  update(`turns/${physical}.json`,{account:'A',tabId:'original-owned-tab',status:'failed',submission:'not-observed',
    publicState:{userTurns:1,assistantTurns:1,loginRequired:false,usageLimited:false,alerts:[]}});
  const diagnostics=join(f.home,'diagnostics/browser-turns',traces[0]+'-original');mkdirSync(diagnostics,{recursive:true});
  writeFileSync(join(diagnostics,'18-turn-completed.json'),JSON.stringify({traceId:traces[0],checkpoint:'turn-completed',capturedAt:stamp(3),
    state:{location:{origin:'https://chatgpt.com',pathSegments:2},turns:{user:1,assistant:[{}],stopButtonCount:0}}}));
  const events=readFileSync(join(f.home,'activity.jsonl'),'utf8').split('\n').map(line=>JSON.parse(line));
  for(const event of events)if(event.traceId===physical&&event.event==='browser.turn_ended')event.status='failed';
  writeFileSync(join(f.home,'activity.jsonl'),events.map(v=>JSON.stringify(v)).join('\n'));
  const audit={version:1,kind:'original_retained_viewport_failure',...identity,logicalTrace:logical,physicalTrace:physical,responseTrace:traces[0],at:stamp(8),
    host:{ownerPid:111,runtimePid:222,account:'A',status:'error',activeTabId:'original-owned-tab',traceId:physical,url:'https://chatgpt.com/c/exact-owned-conversation',
      message:'ChatGPT browser surface did not expose an operational viewport: page.waitForFunction: Timeout 10000ms exceeded.'},
    page:{url:'https://chatgpt.com/c/exact-owned-conversation',users:1,assistants:1,generating:false,draft:false,approvalRequired:false,stopped:false,failure:''}};
  const auditFile=join(f.home,'original-retained-failure.json');writeFileSync(auditFile,JSON.stringify(audit));
  return {...f,logical,physical,audit,auditFile};
}

test('an explicitly audited original viewport failure settles its complete native group without replaying it',()=>{
  const f=retainedBeforePageFixture();try {
    const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);
    expect(gate.reconcileThread(identity.threadId)).toEqual({settledFailures:0,unresolved:1});
    expect(gate.reconcileRetainedCompactionBeforePage(identity,f.logical,f.physical,f.auditFile)).toEqual({settledFailures:1,unresolved:0});
    expect(()=>gate.admit(identity,traces[0])).toThrow();expect(()=>gate.admit(identity,'changed_trace01')).toThrow();
    expect(gate.admit(next,'next_response01').replayOnly).toBe(false);
    expect(JSON.parse(readFileSync(join(f.home,`turns/${f.physical}.json`),'utf8')).submission).toBe('not-observed');
  }finally{f.clean();}
});

test.each(['wrong-tab','wrong-account','changed-page','generating','draft','unmatched-error','send-marker','missing-end','missing-tool-result','stopped'])
  ('retained viewport reconciliation preserves uncertainty: %s',variant=>{
    const f=retainedBeforePageFixture(variant==='missing-end'?{missingEnd:true}:variant==='missing-tool-result'?{missingOutput:true}:variant==='stopped'?{stopped:true}:{});
    try {
      if(variant==='wrong-tab')f.audit.host.activeTabId='another-tab';
      if(variant==='wrong-account')f.audit.host.account='B';
      if(variant==='changed-page')f.audit.page.users=2;
      if(variant==='generating')f.audit.page.generating=true;
      if(variant==='draft')f.audit.page.draft=true;
      if(variant==='unmatched-error')f.audit.host.message='Send timed out';
      if(variant==='send-marker'){
        const dir=join(f.home,'diagnostics/browser-turns',f.physical+'-original');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'01-send-ready.json'),'{}');
      }
      writeFileSync(f.auditFile,JSON.stringify(f.audit));
      const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);
      if(variant==='missing-end')expect(gate.reconcileRetainedCompactionBeforePage(identity,f.logical,f.physical,f.auditFile)).toEqual({settledFailures:0,unresolved:1});
      else expect(()=>gate.reconcileRetainedCompactionBeforePage(identity,f.logical,f.physical,f.auditFile)).toThrow();
      expect(()=>gate.admit(next,'next_response01')).toThrow();
    }finally{f.clean();}
  });

test('a changed audit invalidates a settled retained acquisition group',()=>{
  const f=retainedBeforePageFixture();try {
    const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);gate.reconcileRetainedCompactionBeforePage(identity,f.logical,f.physical,f.auditFile);
    f.audit.page.users=2;writeFileSync(f.auditFile,JSON.stringify(f.audit));
    expect(()=>gate.admit(next,'next_response01')).toThrow();
  }finally{f.clean();}
});

test.each(['valid','missing','wrong-error','wrong-count','unbound','new-send'])
  ('an unavailable end observation requires the exact original viewport diagnostic: %s',variant=>{
    const f=retainedBeforePageFixture();try {
      const file=join(f.home,`turns/${f.physical}.json`),turn=JSON.parse(readFileSync(file,'utf8'));
      delete turn.publicState;turn.observationUnavailable=true;writeFileSync(file,JSON.stringify(turn));
      Object.assign(f.audit.page,{loginRequired:false,usageLimited:false,alerts:[]});writeFileSync(f.auditFile,JSON.stringify(f.audit));
      const folder=join(f.home,'diagnostics/browser-turns',f.physical+'-original');mkdirSync(folder,{recursive:true});
      const failed={traceId:f.physical,checkpoint:'turn-failed',capturedAt:stamp(4),error:f.audit.host.message,
        state:{location:{origin:'https://chatgpt.com',pathSegments:2},surfaceBound:true,turns:{user:1,assistant:[{}],stopButtonCount:0}}};
      if(variant==='wrong-error')failed.error='Send timed out';
      if(variant==='wrong-count')failed.state.turns.user=2;
      if(variant==='unbound')failed.state.surfaceBound=false;
      if(variant!=='missing')writeFileSync(join(folder,'01-turn-failed.json'),JSON.stringify(failed));
      if(variant==='new-send')writeFileSync(join(folder,'02-send-ready.json'),'{}');
      const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);
      if(variant==='valid'){
        expect(gate.reconcileRetainedCompactionBeforePage(identity,f.logical,f.physical,f.auditFile)).toEqual({settledFailures:1,unresolved:0});
        expect(()=>gate.admit(identity,traces[0])).toThrow();expect(gate.admit(next,'next_response01').replayOnly).toBe(false);
      }else{
        expect(()=>gate.reconcileRetainedCompactionBeforePage(identity,f.logical,f.physical,f.auditFile)).toThrow();
        expect(()=>gate.admit(next,'next_response01')).toThrow();
      }
    }finally{f.clean();}
  });

function beforeSendFixture(options:{sendUnknown?:boolean;wrongAccount?:boolean;draft?:boolean;missingEnd?:boolean}={}) {
  const home=mkdtempSync(join(tmpdir(),'clw-compact-presend-')),sessions=join(home,'sessions');
  const logical='0fc1313e9943',physical='000abc111fff_fallback';
  const write=(name:string,value:unknown)=>{mkdirSync(join(home,name,'..'),{recursive:true});writeFileSync(join(home,name),JSON.stringify(value));};
  const gate=createNativeTurnAdmission(home,'old-owner',sessions);gate.admit(identity,logical);
  write('turn-sources/'+logical+'.json',{...identity,traceId:logical,purpose:'compaction',account:'A'});
  write('turns/'+physical+'.json',{traceId:physical,status:'failed',submission:'not-observed',url:null,
    account:options.wrongAccount?'B':'A',startedAt:stamp(2),endedAt:stamp(5),publicState:{loginRequired:false,usageLimited:false}});
  write('diagnostics/browser-turns/'+physical+'-original/05-turn-failed.json',{traceId:physical,checkpoint:'turn-failed',capturedAt:stamp(4),
    error:'ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.',state:{location:{origin:'https://chatgpt.com',pathSegments:0},
      turns:{user:0,stopButtonCount:0,assistant:[]},composer:{visibleCount:1,textChars:[options.draft?1:0]}}});
  if(options.sendUnknown)write('diagnostics/browser-turns/'+physical+'-original/04-send-ready.json',{traceId:physical});
  const events:any[]=[{at:stamp(2),traceId:physical,event:'browser.turn_started'}];
  if(!options.missingEnd)events.push({at:stamp(5),traceId:physical,event:'browser.turn_ended',status:'failed'});
  writeFileSync(join(home,'activity.jsonl'),events.map(v=>JSON.stringify(v)).join('\n'));
  const day=join(sessions,'2026','09','26');mkdirSync(day,{recursive:true});
  writeFileSync(join(day,`rollout-fixture-${identity.threadId}.jsonl`),[
    {type:'session_meta',payload:{id:identity.threadId}},
    {timestamp:stamp(0),type:'event_msg',payload:{type:'task_started',turn_id:identity.turnId}},
    {timestamp:stamp(7),type:'event_msg',payload:{type:'task_complete',turn_id:identity.turnId,last_agent_message:null,error:{message:'Error running remote compact task: original error'}}},
  ].map(v=>JSON.stringify(v)).join('\n'));
  return {home,sessions,logical,physical,clean:()=>rmSync(home,{recursive:true,force:true})};
}
test('before-Send compaction requires an explicit original attempt and forbids the old native turn',()=>{
  const f=beforeSendFixture();try {
    const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);
    expect(gate.reconcileThread(identity.threadId)).toEqual({settledFailures:0,unresolved:1});
    expect(gate.reconcileCompactionBeforeSend(identity,f.physical)).toEqual({settledFailures:1,unresolved:0});
    expect(()=>gate.admit(identity,f.logical)).toThrow();
    expect(gate.admit(next,'next_response01').replayOnly).toBe(false);
  } finally {f.clean();}
});
for(const options of [{sendUnknown:true},{wrongAccount:true},{draft:true},{missingEnd:true}])test(`before-Send uncertainty stays closed: ${JSON.stringify(options)}`,()=>{
  const f=beforeSendFixture(options);try {
    const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);
    expect(()=>gate.reconcileCompactionBeforeSend(identity,f.physical)).toThrow();
    expect(()=>gate.admit(next,'next_response01')).toThrow();
  } finally {f.clean();}
});

test.each(['proved-stage','missing-stage','send-click','attached-prompt'])('model-menu timeout settlement needs the exact original before-Send stage: %s',variant=>{
  const f=beforeSendFixture();try {
    const folder=join(f.home,'diagnostics/browser-turns',f.physical+'-original');
    const file=join(folder,'05-turn-failed.json');const failed=JSON.parse(readFileSync(file,'utf8'));
    failed.error='locator.click: Timeout 3000ms exceeded.\nCall log: data-codex-intelligence-trigger data-composer-navigation-target scrolling into view if needed'+(variant==='send-click'?' send-button':'');
    writeFileSync(file,JSON.stringify(failed));
    if(variant!=='missing-stage')writeFileSync(join(folder,'04-effort-control-ready.json'),JSON.stringify({traceId:f.physical,checkpoint:'effort-control-ready',capturedAt:stamp(3)}));
    if(variant==='attached-prompt')writeFileSync(join(folder,'04-prompt-attachment-complete.json'),'{}');
    const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);
    if(variant==='proved-stage'){
      expect(gate.reconcileCompactionBeforeSend(identity,f.physical)).toEqual({settledFailures:1,unresolved:0});
      expect(()=>gate.admit(identity,f.logical)).toThrow();
      expect(gate.admit(next,'next_response01').replayOnly).toBe(false);
    } else expect(()=>gate.reconcileCompactionBeforeSend(identity,f.physical)).toThrow();
  } finally {f.clean();}
});
