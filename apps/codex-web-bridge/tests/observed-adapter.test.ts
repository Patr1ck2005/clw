import {test,expect} from 'bun:test';
import {existsSync,mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observedAdapter} from '../observed-adapter';
import {chatGptWebExecutionNamespace,chatGptWebTraceId} from '../upstream/src/adapters/chatgpt-web';
import {chatGptTurnExecutionKey} from '../upstream/src/adapters/chatgpt-web/turn-execution';
import {runStructuredCompactionOnce} from '../upstream/src/adapters/chatgpt-web/compaction-handoff';
import {createNativeTurnAdmission} from '../native-turn-admission';
import {readReview} from '../turn-review.cjs';
import source from '../turn-source.cjs';
const thread='01a0dc7b-2a50-7140-a55b-eed50ff96b02',turn='01a0dc7b-2a50-7140-a55b-eed50ff96b03';
const provider:any={adapter:'chatgpt-web',baseUrl:'http://127.0.0.1:1'};
const parsedFor=(threadId:string|null=thread):any=>({modelId:'gpt-5.6-pro',context:{messages:[]},options:{reasoning:'max'},_rawBody:{
 model:'chatgpt-web/pro',client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:threadId,turn_id:turn})},
 input:[{type:'message',role:'user',id:'message-1',content:'fixture',internal_chat_message_metadata_passthrough:{turn_id:turn}}]}});
test('adapter observation preserves the original call, event and exception; source is bound to native IDs',async()=>{
 const home=mkdtempSync(join(tmpdir(),'clw-adapter-'));let calls=0;
 const parsed:any={modelId:'gpt-5.6-pro',context:{messages:[]},options:{reasoning:'max'},_rawBody:{model:'chatgpt-web/pro',
  client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:thread,turn_id:turn})},
  input:[{type:'message',role:'user',id:'message-1',content:'PRIVATE_USER_PROMPT',internal_chat_message_metadata_passthrough:{turn_id:turn}}]}};
 const incoming={headers:new Headers()},event:any={type:'text_delta',text:'unchanged'},sent:any[]=[];
 const failure=Error('original adapter failure');
 const factory=()=>({name:'fixture',async runTurn(p:any,i:any,emit:any){calls++;expect(p).toBe(parsed);expect(i).toBe(incoming);emit(event);throw failure;}});
 try{
  const adapter=observedAdapter({adapter:'chatgpt-web',baseUrl:'http://127.0.0.1:1'},home,factory as any);
  await expect(adapter.runTurn(parsed,incoming,e=>sent.push(e))).rejects.toBe(failure);
  expect(calls).toBe(1);expect(sent[0]).toBe(event);
  const files=readdirSync(join(home,'turn-sources'));expect(files).toHaveLength(1);
  const raw=readFileSync(join(home,'turn-sources',files[0]!), 'utf8'),row=JSON.parse(raw);
  expect(row.threadId).toBe(thread);expect(row.turnId).toBe(turn);expect(row.model).toBe('chatgpt-web/pro');
  expect(raw).not.toContain('PRIVATE_USER_PROMPT');
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('missing native thread ID is rejected before admission and browser delegation',async()=>{
 const home=mkdtempSync(join(tmpdir(),'clw-adapter-no-thread-')),events:any[]=[];let delegated=0;
 try{
  const factory=()=>({name:'fixture',async runTurn(){delegated++;}});
  await observedAdapter(provider,home,factory as any).runTurn(parsedFor(null),{headers:new Headers()},event=>events.push(event));
  expect(delegated).toBe(0);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({type:'error',status:409,code:'native_turn_reconciliation_required',retryable:false});
  expect(existsSync(join(home,'runtime','native-turn-admission'))).toBe(false);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('an incomplete structured-compaction observer reattaches to its own upstream canonical run',async()=>{
 const home=mkdtempSync(join(tmpdir(),'clw-adapter-compact-reconnect-'));
 const parsed={...parsedFor(),_compactionRequest:true},trace=chatGptWebTraceId(provider,parsed);
 const owner='compact-owner';let delegated=0;
 try{
  const factory=()=>({name:'fixture',async runTurn(){delegated++;}});
  const adapter=observedAdapter(provider,home,factory as any,owner);
  await adapter.runTurn(parsed,{headers:new Headers()},()=>{}); // Detached observer; no final yet.
  const key=`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`;
  await runStructuredCompactionOnce(key,{ownerKey:'compact-fixture',traceIds:[trace],nativeThreadId:thread,nativeTurnId:turn},async()=> 'checkpoint');
  const events:any[]=[];
  await adapter.runTurn(parsed,{headers:new Headers()},event=>events.push(event));
  expect(delegated).toBe(2);expect(events).toEqual([]);
  expect(source.readSource(home,trace).purpose).toBe('compaction');
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('conflicting source binding blocks delegation without replacing the earlier record',async()=>{
 const home=mkdtempSync(join(tmpdir(),'clw-adapter-source-conflict-')),parsed=parsedFor();
 const trace=chatGptWebTraceId(provider,parsed),owner='owner-source-conflict',events:any[]=[];let delegated=0;
 try{
  createNativeTurnAdmission(home,owner).admit({threadId:thread,turnId:turn},trace);
  expect(source.saveSource(home,{traceId:trace,threadId:thread,turnId:turn,model:'chatgpt-web/extra-high'})).toBe(true);
  const file=join(home,'turn-sources',`${trace}.json`),before=readFileSync(file,'utf8');
  const factory=()=>({name:'fixture',async runTurn(){delegated++;}});
  await observedAdapter(provider,home,factory as any,owner).runTurn(parsed,{headers:new Headers()},event=>events.push(event));
  expect(delegated).toBe(0);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({type:'error',status:409,code:'native_turn_reconciliation_required',retryable:false});
  expect(readFileSync(file,'utf8')).toBe(before);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('source write exception blocks delegation without replacing the earlier record',async()=>{
 const home=mkdtempSync(join(tmpdir(),'clw-adapter-source-throw-')),parsed=parsedFor();
 const trace=chatGptWebTraceId(provider,parsed),owner='owner-source-throw',events:any[]=[];let delegated=0;
 const originalSave=source.saveSource;
 try{
  createNativeTurnAdmission(home,owner).admit({threadId:thread,turnId:turn},trace);
  expect(source.saveSource(home,{traceId:trace,threadId:thread,turnId:turn,model:'chatgpt-web/pro'})).toBe(true);
  const file=join(home,'turn-sources',`${trace}.json`),before=readFileSync(file,'utf8');
  source.saveSource=()=>{throw new Error('source write failed');};
  const factory=()=>({name:'fixture',async runTurn(){delegated++;}});
  await observedAdapter(provider,home,factory as any,owner).runTurn(parsed,{headers:new Headers()},event=>events.push(event));
  expect(delegated).toBe(0);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({type:'error',status:409,code:'native_turn_reconciliation_required',retryable:false});
  expect(readFileSync(file,'utf8')).toBe(before);
 }finally{source.saveSource=originalSave;rmSync(home,{recursive:true,force:true});}
});
test('only the current completed public final is classified; hidden reasoning and commentary are ignored',async()=>{
 const home=mkdtempSync(join(tmpdir(),'clw-adapter-review-'));
 const parsed:any={modelId:'gpt-5.6-pro',context:{messages:[]},options:{reasoning:'max'},_rawBody:{model:'chatgpt-web/pro',client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:thread,turn_id:turn})},input:[{type:'message',role:'user',id:'message-1',content:'fixture',internal_chat_message_metadata_passthrough:{turn_id:turn}}]}};
 const events:any[]=[
  {type:'thinking_delta',thinking:'turn token is invalid, expired, or revoked'},
  {type:'text_delta',phase:'commentary',text:'409 Duplicate active request ID'},
  {type:'text_delta',phase:'final_answer',text:'409 Duplicate active request ID'},
  {type:'assistant_boundary'},
  {type:'text_delta',phase:'final_answer',text:"unknown model-visible runtime tool 'codex\\_"},
  {type:'text_delta',phase:'final_answer',text:"tool\\_call'"},
  {type:'done',endTurn:true,stopReason:'stop'}
 ];
 const forwarded:any[]=[];
 try{
  const factory=()=>({name:'fixture',async runTurn(_p:any,_i:any,emit:any){events.forEach(emit);}});
  await observedAdapter({adapter:'chatgpt-web',baseUrl:'http://127.0.0.1:1'},home,factory as any).runTurn(parsed,{headers:new Headers()},e=>forwarded.push(e));
  expect(forwarded).toEqual(events);for(let i=0;i<events.length;i++)expect(forwarded[i]).toBe(events[i]);
  const name=readdirSync(join(home,'turn-sources'))[0]!;
  const result=readReview(home,name.replace('.json',''));
  expect(result.reportedBlockers.map((r:any)=>r.code)).toEqual(['tool_discovery_unavailable_reported']);
 }finally{rmSync(home,{recursive:true,force:true});}
});
