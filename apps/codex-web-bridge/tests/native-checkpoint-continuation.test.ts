import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {observedAdapter} from '../observed-adapter';
import {createNativeTurnAdmission} from '../native-turn-admission';
import {chatGptWebTraceId} from '../upstream/src/adapters/chatgpt-web';
import {rememberCompactionContinuation} from '../upstream/src/adapters/chatgpt-web/compaction-continuation';
import {encodeCompactionSummary} from '../upstream/src/responses/compaction';
const identity={threadId:'01a0dc7b-2a50-7140-a55b-eed50ff96b12',turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b13'};
const provider:any={adapter:'chatgpt-web',baseUrl:'http://127.0.0.1:1'};
const summary='Preserve the accepted tool outputs; write the remaining result and read it back.';
const sha=createHash('sha256').update(summary).digest('hex');
const message={type:'message',role:'user',content:'original task',internal_chat_message_metadata_passthrough:{turn_id:identity.turnId}};
const parsed=(compact=false):any=>({modelId:'gpt-5.6-pro',context:{messages:[]},options:{reasoning:'max'},
  ...(compact?{_compactionRequest:true}:{}),_rawBody:{model:'chatgpt-web/pro',
  client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:identity.threadId,turn_id:identity.turnId})},input:[message]}});

test('accepted native checkpoint continues the same turn; forged summary, wrong model and missing checkpoint cannot delegate',async()=>{
  const home=mkdtempSync(join(tmpdir(),'clw-checkpoint-'));let calls=0;
  try{
    const compact=parsed(true),trace=chatGptWebTraceId(provider,compact);
    const summarizer=()=>({name:'fixture',async runTurn(_p:any,_i:any,emit:any){
      calls++;emit({type:'text_delta',phase:'final_answer',text:summary});emit({type:'done',endTurn:true,stopReason:'stop'});
    }});
    await observedAdapter(provider,home,summarizer as any,'owner-checkpoint').runTurn(compact,{headers:new Headers()},()=>{});
    const record=JSON.parse(readFileSync(join(home,'runtime/native-turn-admission',`trace-${trace}.json`),'utf8'));
    expect(record).toMatchObject({state:'checkpoint',checkpointSha256:sha});
    rememberCompactionContinuation(compact,identity,[{turnId:identity.turnId,content:message.content}],summary);
    const next=parsed();next._rawBody.input.push({type:'compaction',encrypted_content:encodeCompactionSummary(summary)});
    const continuation=()=>({name:'fixture',async runTurn(_p:any,_i:any,emit:any){calls++;
      emit({type:'text_delta',phase:'final_answer',text:'result written and read back'});emit({type:'done',endTurn:true,stopReason:'stop'});}});
    for(const invalid of [parsed(),{...next,_rawBody:{...next._rawBody,input:[message,{type:'compaction',encrypted_content:encodeCompactionSummary(summary+' forged')}]}},
      {...next,modelId:'gpt-5.6',options:{reasoning:'high'}}]){
      const events:any[]=[];await observedAdapter(provider,home,continuation as any,'owner-checkpoint').runTurn(invalid,{headers:new Headers()},e=>events.push(e));
      expect(events[0]?.type).toBe('error');expect(calls).toBe(1);
    }
    const events:any[]=[];await observedAdapter(provider,home,continuation as any,'owner-checkpoint').runTurn(next,{headers:new Headers()},e=>events.push(e));
    expect(calls).toBe(2);expect(events.at(-1)?.type).toBe('done');
    const changed=structuredClone(next);changed._rawBody.input.push({type:'message',role:'user',content:'changed task',internal_chat_message_metadata_passthrough:{turn_id:identity.turnId}});
    const rejected:any[]=[];await observedAdapter(provider,home,continuation as any,'owner-checkpoint').runTurn(changed,{headers:new Headers()},e=>rejected.push(e));
    expect(rejected[0]?.type).toBe('error');expect(calls).toBe(2);
  }finally{rmSync(home,{recursive:true,force:true});}
});

function checkpointFixture(options:{legacyFinal?:boolean;badHash?:boolean;missingAck?:boolean;stopped?:boolean;missingEnd?:boolean}={}){
  const home=mkdtempSync(join(tmpdir(),'clw-native-checkpoint-')),sessions=join(home,'sessions'),trace='checkpoint_001';
  const write=(file:string,value:any)=>{mkdirSync(join(home,file,'..'),{recursive:true});writeFileSync(join(home,file),JSON.stringify(value));};
  const old=createNativeTurnAdmission(home,'owner-old',sessions);const admitted=old.admit(identity,trace);
  write(`turn-sources/${trace}.json`,{traceId:trace,...identity,purpose:'compaction'});
  write(`turn-reviews/${trace}.json`,{traceId:trace,...identity,finalSha256:sha});
  admitted.complete(options.legacyFinal?'final':'checkpoint');
  const stamp=(n:number)=>`2026-09-26T10:00:0${n}Z`;
  const rows:any[]=[{type:'session_meta',payload:{id:identity.threadId}},
    {timestamp:stamp(0),type:'event_msg',payload:{type:'task_started',turn_id:identity.turnId}}];
  if(!options.missingAck)rows.push({timestamp:stamp(2),type:'compacted',payload:{message:'',replacement_history:[{type:'compaction',encrypted_content:encodeCompactionSummary(options.badHash?'wrong summary':summary)}]}});
  if(options.stopped)rows.push({timestamp:stamp(3),type:'event_msg',payload:{type:'turn_aborted',turn_id:identity.turnId}});
  if(!options.missingEnd)rows.push({timestamp:stamp(4),type:'event_msg',payload:{type:'task_complete',turn_id:identity.turnId,last_agent_message:null,error:{message:'native continuation gate rejected the trace'}}});
  const day=join(sessions,'2026','09','26');mkdirSync(day,{recursive:true});writeFileSync(join(day,`rollout-fixture-${identity.threadId}.jsonl`),rows.map(r=>JSON.stringify(r)).join('\n'));
  return {home,sessions,trace,old,clean:()=>rmSync(home,{recursive:true,force:true})};
}
for(const legacyFinal of [false,true])test(`native checkpoint acknowledgement settles its ended failure, including old completion state: ${legacyFinal}`,()=>{
  const f=checkpointFixture({legacyFinal});try{
    const gate=createNativeTurnAdmission(f.home,'owner-new',f.sessions);
    expect(gate.reconcileThread(identity.threadId)).toEqual({settledFailures:1,unresolved:0});
    expect(()=>gate.admit(identity,f.trace)).toThrow();
    expect(gate.admit({...identity,turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b14'},'new_trace_001').replayOnly).toBe(false);
  }finally{f.clean();}
});
for(const options of [{badHash:true},{missingAck:true},{stopped:true},{missingEnd:true}])test(`unverified checkpoint cannot settle or restart: ${JSON.stringify(options)}`,()=>{
  const f=checkpointFixture(options);try{
    const gate=createNativeTurnAdmission(f.home,'owner-new',f.sessions);
    expect(gate.reconcileThread(identity.threadId)).toEqual({settledFailures:0,unresolved:1});
    expect(()=>gate.admit({...identity,turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b14'},'new_trace_001')).toThrow();
  }finally{f.clean();}
});
test('a checkpoint cannot release another native turn even under the same owner',()=>{
  const f=checkpointFixture({missingEnd:true});try{
    expect(()=>f.old.admit({...identity,turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b14'},'new_trace_001')).toThrow();
  }finally{f.clean();}
});
