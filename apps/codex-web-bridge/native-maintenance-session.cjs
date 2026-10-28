'use strict';
// Idle-only canonical timeline evidence. Never accepted by resume/release/claim APIs.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {cleanSource}=require('./turn-source.cjs');
const {createSessionScan,sessionRevision}=require('./native-session-stream.cjs');
const nativeReceipt=require('./native-terminal-receipt.cjs');
const cache=new Map(); // Eviction bounds retained metadata, never lifetime admission.
const WORKFLOW_CALL=/\b(?:run_process|run_job|work_on_project)\s*(?:\(|["']?\s*[:,])|\b(?:harness_mcp_tool|workflow_client|webcodex_client)\.(?:py|ps1)\b/i;
const REFERENCE=/["'](job_id|jobId|session_id|sessionId)["']\s*:\s*["']([A-Za-z0-9][A-Za-z0-9_-]{0,127})["']/g;
const v7=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const identity=value=>typeof value==='string'&&path.isAbsolute(value)&&!value.includes('\0')?path.resolve(value).replace(/\/$/,'').toLowerCase():null;
const revision=stat=>['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(stat[key])).join(':');
const records=new Set(['session_meta','event_msg','response_item','turn_context','compacted','world_state','token_usage_record']);
const events=new Set(['task_started','task_complete','turn_aborted','token_count','item_completed','agent_message','agent_reasoning','agent_reasoning_raw_content','user_message','context_compacted','warning','error','thread_settings_applied']);
const requireValue=(ok,code)=>{if(!ok)throw Error(code);};
function instant(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN;
 const [year,month,day,hour,minute,second]=value.match(/^\d+|\d+/g).slice(0,6).map(Number),calendar=new Date(0);calendar.setUTCFullYear(year,month,0);
 return month<1||month>12||day<1||day>calendar.getUTCDate()||hour>23||minute>59||second>59?NaN:Date.parse(value);
}
function session(threadId,root){
 const created=parseInt(threadId.replaceAll('-','').slice(0,12),16),found=[];
 for(const d of [-1,0,1]){const day=new Date(created+d*86400000).toISOString().slice(0,10).split('-'),dir=path.join(root,...day);
  if(!fs.existsSync(dir))continue;requireValue(fs.lstatSync(dir).isDirectory(),'native_maintenance_session_unavailable');
  for(const item of fs.readdirSync(dir,{withFileTypes:true}))if(item.name.startsWith('rollout-')&&item.name.endsWith('-'+threadId+'.jsonl')){requireValue(item.isFile(),'native_maintenance_session_unavailable');found.push(path.join(dir,item.name));}}
 requireValue(found.length===1,'native_maintenance_session_not_unique');return found[0];
}
function parse(scan,threadId){
 let meta=null,active=null,lastTime=-Infinity;const turns=new Map();
 for(const line of scan){
  const row=JSON.parse(line),p=row.payload;requireValue(object(row)&&records.has(row.type)&&object(p),'native_maintenance_record_invalid');
  const at=instant(row.timestamp);requireValue(Number.isFinite(at)&&at>=lastTime,'native_maintenance_time_invalid');lastTime=at;
  if(row.type==='session_meta'){requireValue(!meta&&turns.size===0&&p.id===threadId&&identity(p.cwd),'native_maintenance_metadata_invalid');meta={cwd:identity(p.cwd)};continue;}
  requireValue(meta,'native_maintenance_metadata_invalid');if(p.thread_id!==undefined)requireValue(p.thread_id===threadId,'native_maintenance_identity_changed');
  const event=row.type==='event_msg'?p:null;if(event)requireValue(events.has(event.type),'native_maintenance_event_unknown');
  if(event?.type==='thread_settings_applied')requireValue(event.thread_id===threadId&&object(event.thread_settings)&&identity(event.thread_settings.cwd)===meta.cwd&&typeof event.thread_settings.model==='string'&&event.thread_settings.model.trim()&&typeof event.thread_settings.model_provider_id==='string'&&event.thread_settings.model_provider_id.trim(),'native_maintenance_settings_invalid');
  if(event?.type==='task_started'){requireValue(v7(event.turn_id)&&event.turn_id!==threadId&&!active&&!turns.has(event.turn_id),'native_maintenance_turn_order_invalid');active={turnId:event.turn_id,index:turns.size,state:'running',startedAt:row.timestamp,endedAt:null,final:null,hasTools:false,workflowCall:false,workflowJobs:new Set(),workflowSessions:new Set(),eventHash:crypto.createHash('sha256')};turns.set(active.turnId,active);}
  else if(p.turn_id!==undefined)requireValue(v7(p.turn_id)&&active&&p.turn_id===active.turnId,'native_maintenance_identity_changed');
  if(event?.type==='item_completed')requireValue(active&&p.turn_id===active.turnId&&p.thread_id===threadId&&object(p.item)&&typeof p.item.id==='string'&&typeof p.item.type==='string','native_maintenance_item_invalid');
  if(active){
   active.eventHash.update(line).update('\n');
   if(row.type==='response_item'&&!['message','reasoning','compaction'].includes(p.type)||event?.type==='item_completed'&&!['UserMessage','AgentMessage','Reasoning'].includes(event.item?.type))active.hasTools=true;
   const texts=[];
   if(row.type==='response_item'&&p.type==='function_call'&&p.name==='exec_command'){let args;try{args=JSON.parse(p.arguments);}catch{throw Error('native_maintenance_tool_unknown');}if(typeof args.cmd!=='string')throw Error('native_maintenance_tool_unknown');texts.push(args.cmd);}
   if(event?.type==='item_completed'&&event.item?.type==='CommandExecution'&&typeof event.item.aggregated_output==='string')texts.push(event.item.aggregated_output);
   for(const text of texts){active.workflowCall ||= WORKFLOW_CALL.test(text);for(const match of text.matchAll(REFERENCE)){if(match[1]==='job_id'||match[1]==='jobId')active.workflowJobs.add(match[2]);else if(match[2].startsWith('wc_sess_'))active.workflowSessions.add(match[2]);}}
  }
  if(row.type==='response_item'){
   requireValue(typeof p.type==='string'&&p.type.length,'native_maintenance_response_invalid');
   if(p.type==='message'){requireValue(['system','developer','user','assistant','tool'].includes(p.role)&&Array.isArray(p.content)&&p.content.every(part=>object(part)&&typeof part.type==='string'),'native_maintenance_response_invalid');
    if(p.phase==='final_answer'){requireValue(active&&!active.final&&p.role==='assistant'&&p.content.length&&p.content.every(part=>part.type==='output_text'&&typeof part.text==='string'),'native_maintenance_final_invalid');const final=p.content.map(part=>part.text).join('').trim();requireValue(final,'native_maintenance_final_invalid');active.final=sha(final);}}
   else if(!['reasoning','compaction'].includes(p.type))requireValue(active,'native_maintenance_response_invalid');
  }
  if(event&&['task_complete','turn_aborted'].includes(event.type)){
   requireValue(active&&event.turn_id===active.turnId,'native_maintenance_terminal_invalid');
   if(event.type==='turn_aborted'){active.state='aborted';active.terminal='turn_aborted';}
   else{
    const error=typeof event.error==='string'?event.error:object(event.error)?event.error.message:null;
    requireValue(event.error===undefined||event.error===null||typeof error==='string'&&error.trim(),'native_maintenance_error_invalid');
    if(error){active.state='failed';active.terminal='task_complete_with_error';}
    else{active.state='completed';active.terminal='task_complete';active.finalMatches=typeof event.last_agent_message==='string'&&sha(event.last_agent_message.trim())===active.final;}
   }
   active.endedAt=row.timestamp;active.eventSha256=active.eventHash.digest('hex');delete active.eventHash;active=null;
  }
 }
 requireValue(meta,'native_maintenance_metadata_invalid');return {cwd:meta.cwd,turns,threadActive:!!active,activeTurnId:active?.turnId||null,sessionSha256:scan.sessionSha256};
}
function parsedSession(threadId,sessionsRoot){
 const file=session(threadId,sessionsRoot),key=sessionRevision(file),old=cache.get(file);
 if(old?.key===key&&old.threadId===threadId){cache.delete(file);cache.set(file,old);return {...old.value,file,revision:key};}
 const scan=createSessionScan(file,{prefix:'native_maintenance',preserveCarriageReturn:true}),value=parse(scan,threadId);
 while(cache.size>=32)cache.delete(cache.keys().next().value);
 cache.set(file,{key:scan.revision,threadId,value});return {...value,file,revision:scan.revision};
}
function boundSource(bound,account){
 const source=cleanSource(bound.source);requireValue(source&&source.workingDirectory&&['A','B'].includes(source.account)&&source.traceId===bound.traceId&&source.threadId===bound.threadId&&source.turnId===bound.turnId&&v7(source.threadId)&&v7(source.turnId)&&source.threadId!==source.turnId&&(!account||source.account===account),'native_maintenance_source_unknown');return source;
}
function proofFor(source,s,turn){
 return {traceId:source.traceId,threadId:source.threadId,turnId:source.turnId,state:turn.state,endedAt:turn.endedAt,threadActive:false,activeTurnId:null,
  nativeProof:{version:1,kind:'canonical_native_maintenance_session',threadId:source.threadId,turnId:source.turnId,sessionSha256:s.sessionSha256,eventSha256:turn.eventSha256,terminal:turn.terminal},
  taskAcceptance:'unverified',claimReleaseAuthorized:false,workflowJobAbsenceProven:false};
}
// Admission retirement is narrower than idle timeline display. Unknown tools or
// original Workflow references remain pending; native final is not Job absence.
function readNativeOwnerTerminals(admitted,{sessionsRoot=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions'),account}={}){
 requireValue(Array.isArray(admitted)&&path.isAbsolute(sessionsRoot),'native_maintenance_admission_unknown');
 const results=new Map(),verified=new Map(),parsed=new Map(),finals=new Map();
 for(const bound of admitted)if(bound.state==='completed'&&/^[a-f0-9]{64}$/.test(bound.finalSha256||''))finals.set(JSON.stringify([bound.threadId,bound.turnId]),bound.finalSha256);
 for(const bound of admitted){try{
  const source=boundSource(bound,account);if(!parsed.has(source.threadId))parsed.set(source.threadId,parsedSession(source.threadId,sessionsRoot));const s=parsed.get(source.threadId),turn=s.turns.get(source.turnId);
  requireValue(identity(source.workingDirectory)===s.cwd&&turn&&turn.state!=='running'&&(turn.state!=='completed'||turn.finalMatches),'native_maintenance_original_turn_unsettled');
  if(turn.state==='completed')requireValue(finals.get(JSON.stringify([source.threadId,source.turnId]))===turn.final,'native_maintenance_original_final_unverified');
  requireValue(!turn.workflowCall&&!turn.workflowJobs.size&&!turn.workflowSessions.size,'native_maintenance_original_jobs_unverified');
  let toolProof=null;
  if(turn.hasTools){
   const key=JSON.stringify([source.threadId,source.turnId,s.sessionSha256]);
   if(!verified.has(key)){
    requireValue(turn.state==='completed','native_maintenance_original_tools_unverified');
    verified.set(key,nativeReceipt.verifyNativeCompletedToolsReceipt({threadId:source.threadId,turnId:source.turnId,expectedFinalSha256:turn.final,startedAt:turn.startedAt,endedAt:turn.endedAt,sessionsRoot}));
   }
   toolProof=verified.get(key);requireValue(toolProof.sessionSha256===s.sessionSha256,'native_maintenance_session_changed');
  }
  requireValue(sessionRevision(s.file)===s.revision,'native_maintenance_session_changed');
  results.set(source.traceId,{...proofFor(source,s,turn),startedAt:turn.startedAt,nativeToolsTerminal:true,toolProof,workflowJobs:[],workflowSessions:[],sessionFile:s.file,sessionRevision:s.revision});
 }catch{/* Unavailable/unknown original work stays in the current owner set. */}}
 return results;
}
function readMaintenanceSessions(admitted,{sessionsRoot=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions'),account}={}){
 requireValue(Array.isArray(admitted)&&path.isAbsolute(sessionsRoot),'native_maintenance_admission_unknown');const parsed=new Map();
 return admitted.map(bound=>{
  const source=boundSource(bound,account);
  if(!parsed.has(source.threadId))parsed.set(source.threadId,parsedSession(source.threadId,sessionsRoot));
  const s=parsed.get(source.threadId),turn=s.turns.get(source.turnId);requireValue(identity(source.workingDirectory)===s.cwd,'native_maintenance_cwd_changed');
  requireValue(turn&&turn.state!=='running'&&!s.threadActive&&s.activeTurnId===null,'native_maintenance_original_turn_unsettled');
  for(const next of s.turns.values())if(next.index>=turn.index)requireValue(next.state!=='completed'||next.finalMatches,'native_maintenance_original_final_unverified');
  return proofFor(source,s,turn);
 });
}
module.exports={readMaintenanceSessions,readNativeOwnerTerminals};
