import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeTurnAdmission} from '../native-turn-admission';
import {hasFailedSettlement, observeFailedSettlement} from '../failed-turn-settlement';
import {ChatGptTurnSession, ChatGptTraceFeed, ChatGptTextFeed} from '../upstream/src/adapters/chatgpt-web/turn-execution';
import {chatGptTurnSessions, chatGptTurnExecutionKey} from '../upstream/src/adapters/chatgpt-web/turn-execution';
import {chatGptWebTraceId, chatGptWebExecutionNamespace} from '../upstream/src/adapters/chatgpt-web';
import {observedAdapter} from '../observed-adapter';

const identity = {threadId:'01a0dc7b-2a50-7140-a55b-eed50ff96b02',turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b03'};
const traceId='trace_failed01', next={...identity,turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b04'};
const at=(s:number)=>`2026-09-26T10:00:0${s}Z`;
function fixture(options:{tool?:boolean; terminal?:boolean; hostEnd?:boolean; submission?:string}={}) {
  const home=mkdtempSync(join(tmpdir(),'clw-failed-settlement-'));
  const sessions=join(home,'sessions'), day=join(sessions,'2026','09','26');
  const write=(dir:string,name:string,data:any)=>{mkdirSync(join(home,dir),{recursive:true});writeFileSync(join(home,dir,name),JSON.stringify(data));};
  const gate=createNativeTurnAdmission(home,'original-owner',sessions);
  gate.admit(identity,traceId);
  write('turn-sources',`${traceId}.json`,{...identity,traceId,purpose:'response'});
  write('turns',`${traceId}.json`,{traceId,status:'failed',submission:options.submission||'confirmed',startedAt:at(1),endedAt:at(2)});
  const activity=[{at:at(1),traceId,event:'browser.turn_started'}];
  if(options.hostEnd!==false)activity.push({at:at(3),traceId,event:'browser.turn_ended',status:'failed'} as any);
  writeFileSync(join(home,'activity.jsonl'),activity.map(v=>JSON.stringify(v)).join('\n'));
  mkdirSync(day,{recursive:true});
  const rows:any[]=[{type:'session_meta',payload:{id:identity.threadId}},
    {timestamp:at(0),type:'event_msg',payload:{type:'task_started',turn_id:identity.turnId}}];
  if(options.tool)rows.push({timestamp:at(1),type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'call_x'}});
  if(options.terminal!==false)rows.push({timestamp:at(4),type:'event_msg',payload:{type:'task_complete',turn_id:identity.turnId,last_agent_message:null,error:{message:'original error'}}});
  writeFileSync(join(day,`rollout-fixture-${identity.threadId}.jsonl`),rows.map(v=>JSON.stringify(v)).join('\n'));
  return {home,gate,sessions,clean:()=>rmSync(home,{recursive:true,force:true})};
}
test('exact failed no-tool native terminal releases the thread, preserves failure and forbids original replay',()=>{
  const f=fixture();try{
    const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);
    expect(gate.reconcileThread(identity.threadId)).toEqual({settledFailures:1,unresolved:0});
    expect(()=>gate.admit(identity,traceId)).toThrow();
    expect(()=>gate.admit(identity,'changed_trace')).toThrow();
    expect(JSON.parse(readFileSync(join(f.home,'turns',`${traceId}.json`),'utf8')).status).toBe('failed');
    expect(gate.admit(next,'trace_next001').replayOnly).toBe(false);
  }finally{f.clean();}
});
for(const options of [{tool:true},{terminal:false},{hostEnd:false},{submission:'unconfirmed'}]) {
  test(`uncertain historical failure stays closed: ${JSON.stringify(options)}`,()=>{
    const f=fixture(options);try{
      const gate=createNativeTurnAdmission(f.home,'new-owner',f.sessions);
      expect(gate.reconcileThread(identity.threadId)).toEqual({settledFailures:0,unresolved:1});
      expect(()=>gate.admit(next,'trace_next001')).toThrow();
    }finally{f.clean();}
  });
}
test('normal new turn reconciles old failure without a maintenance call',()=>{
  const f=fixture();try{
    expect(createNativeTurnAdmission(f.home,'new-owner',f.sessions).admit(next,'trace_next001').replayOnly).toBe(false);
  }finally{f.clean();}
});
test.each([false,true])('archived failed turn uses its original physical settlement, never a missing Send marker: %s',async missingReceipt=>{
  const f=fixture({submission:'not-observed'});
  try{
    if(!missingReceipt){
      const session=new ChatGptTurnSession({mode:'tools',browser:Promise.reject(Error('original before-Send failure')),
        physicalSettlement:Promise.resolve(),trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),token:Promise.resolve('test'),
        externalProgress:{} as any,submission:{phase:'prepared'},cancel(){},retireCapability(){}},traceId,'original-owner',identity.turnId,identity.threadId);
      await session.browserOutcome;
      expect(await observeFailedSettlement(f.home,identity,traceId,session)).toBe(true);
    }
    const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
    const directory=join(f.home,'runtime/native-turn-admission'),threadKey=digest(identity.threadId),key=digest(JSON.stringify([identity.threadId,identity.turnId]));
    const nativeProof={...identity,sessionSha256:'a'.repeat(64),eventSha256:'b'.repeat(64)};
    writeFileSync(join(directory,`thread-${threadKey}-terminal-${key}.json`),JSON.stringify({version:1,kind:'verified_native_turn_membership',threadKey,identityKey:key,ownerEpoch:'original-owner',...identity,nativeProof}));
    writeFileSync(join(directory,`owner-terminal-${traceId}.json`),JSON.stringify({...identity,traceId,state:'failed',sourceSha256:digest(readFileSync(join(f.home,'turn-sources',traceId+'.json')))}));
    writeFileSync(join(directory,`thread-${threadKey}.json`),JSON.stringify({version:1,threadKey,turns:{}}));
    const gate=createNativeTurnAdmission(f.home,'replacement-owner',f.sessions);
    expect(()=>gate.admit(identity,traceId)).toThrow('archived terminal');
    expect(()=>gate.admit(identity,'changed_trace')).toThrow('archived terminal');
    if(missingReceipt){
      expect(()=>gate.reconcileFailedTrace(identity,traceId)).toThrow('Original archived failure settlement');
      expect(()=>gate.inspectThread(identity.threadId)).toThrow('no matched terminal receipt');
      expect(()=>gate.admit(next,'trace_after_archive')).toThrow('no matched terminal receipt');
    }
    else{
      const originalFailure=readFileSync(join(f.home,'turns',traceId+'.json'));
      const originalReceipt=readFileSync(join(directory,`failed-settlement-${traceId}.json`));
      gate.reconcileFailedTrace(identity,traceId);
      expect(JSON.parse(readFileSync(join(directory,`trace-${traceId}.json`),'utf8')).state).toBe('settled_failed');
      expect(JSON.parse(readFileSync(join(directory,`thread-${threadKey}.json`),'utf8')).turns).toEqual({});
      expect(gate.inspectThread(identity.threadId)).toEqual({ready:true,threadId:identity.threadId,modelSends:0});
      expect(readFileSync(join(f.home,'turns',traceId+'.json'))).toEqual(originalFailure);
      expect(readFileSync(join(directory,`failed-settlement-${traceId}.json`))).toEqual(originalReceipt);
      expect(gate.admit(next,'trace_after_archive').replayOnly).toBe(false);
      expect(JSON.parse(readFileSync(join(f.home,'turns',traceId+'.json'),'utf8')).submission).toBe('not-observed');
    }
  }finally{f.clean();}
});
test('upstream physical cleanup and outstanding tools both precede settlement',async()=>{
  const f=fixture({terminal:false});let finish!:()=>void, retired=0;
  const physicalSettlement=new Promise<void>(resolve=>finish=resolve);
  const session=new ChatGptTurnSession({mode:'tools',browser:Promise.reject(Error('thinking failed')),
    physicalSettlement,trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),token:Promise.resolve('test'),
    externalProgress:{} as any,submission:{phase:'accepted'},cancel(){},retireCapability(){retired++;}},traceId,'owner',identity.turnId,identity.threadId);
  try{
    await session.browserOutcome;
    const pending=observeFailedSettlement(f.home,identity,traceId,session);
    expect(hasFailedSettlement(f.home,identity,traceId)).toBe(false);
    session.setOutstanding([{callId:'call_pending'} as any]);finish();
    expect(await pending).toBe(false);
    expect(hasFailedSettlement(f.home,identity,traceId)).toBe(false);
    session.markResultDelivered('call_pending');
    expect(await observeFailedSettlement(f.home,identity,traceId,session)).toBe(true);
    expect(retired).toBeGreaterThan(0);
    expect(f.gate.reconcileThread(identity.threadId)).toEqual({settledFailures:1,unresolved:0});
    expect(f.gate.admit(next,'trace_next001').replayOnly).toBe(false);
  }finally{f.clean();}
});
test('settlement receipt cannot authorize a changed original failure record',()=>{
  const f=fixture();try{
    f.gate.reconcileThread(identity.threadId);
    writeFileSync(join(f.home,'turns',`${traceId}.json`),JSON.stringify({traceId,status:'running'}));
    expect(()=>f.gate.admit(next,'trace_next001')).toThrow();
  }finally{f.clean();}
});

test.each([false,true])('wrapper keeps original failure cleanup when the upstream session is evicted: %s',async evicted=>{
  const home=mkdtempSync(join(tmpdir(),'clw-failed-wrapper-'));
  const provider:any={adapter:'chatgpt-web',baseUrl:'http://127.0.0.1:1'};
  const parsed:any={modelId:'gpt-5.6-pro',context:{messages:[]},options:{reasoning:'max'},_rawBody:{model:'chatgpt-web/pro',
    client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:identity.threadId,turn_id:identity.turnId})},
    input:[{type:'message',role:'user',content:'fixture',internal_chat_message_metadata_passthrough:{turn_id:identity.turnId}}]}};
  const trace=chatGptWebTraceId(provider,parsed), key=`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`;
  let revoked=0;
  try{
    const factory=()=>({name:'fixture',async runTurn(_p:any,_i:any,emit:any){
      const session=chatGptTurnSessions.getOrCreate(key,()=>({mode:'tools',browser:Promise.reject(Error('original browser failure')),
        physicalSettlement:Promise.resolve(),trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),
        token:Promise.resolve('test'),externalProgress:{} as any,submission:{phase:'accepted'},cancel(){},retireCapability(){revoked++;}}),trace,'fixture-owner',identity.turnId,identity.threadId);
      mkdirSync(join(home,'turns'),{recursive:true});
      writeFileSync(join(home,'turns',trace+'.json'),JSON.stringify({traceId:trace,status:'failed',submission:'confirmed'}));
      await session.browserOutcome;
      emit({type:'error',message:'original browser failure',code:'fixture_failure',retryable:false});
      if(evicted)chatGptTurnSessions.retire(key,session);
    }});
    const events:any[]=[];
    await observedAdapter(provider,home,factory as any,'fixture-owner').runTurn(parsed,{headers:new Headers()},e=>events.push(e));
    for(let n=0;n<30&&!hasFailedSettlement(home,identity,trace);n++)await new Promise(r=>setTimeout(r,5));
    expect(events).toHaveLength(1);expect(events[0].code).toBe('fixture_failure');
    expect(revoked).toBeGreaterThan(0);
    const admission=createNativeTurnAdmission(home,'next-owner');
    expect(admission.reconcileThread(identity.threadId)).toEqual({settledFailures:1,unresolved:0});
    expect(admission.admit(next,'trace_after_failure').replayOnly).toBe(false);
  }finally{await chatGptTurnSessions.retireAndWait(key);rmSync(home,{recursive:true,force:true});}
});
