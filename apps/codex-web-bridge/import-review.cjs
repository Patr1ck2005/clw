'use strict';
// Explicit, local-only import for receipts created before review observation
// existed. Never infer a Codex identity from a title or neighbouring task.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readSource}=require('./turn-source.cjs');
const {saveReview}=require('./turn-review.cjs');
const {exactNativeSessionFinal}=require('./native-session-proof.cjs');
function read(file,limit){const raw=fs.readFileSync(file);if(raw.length>limit)throw Error('review_file_too_large');return raw;}
function importReview(home,traceId,directory,{sessionsRoot}={}){
  const source=readSource(home,traceId);if(!source)throw Error('review_source_missing');
  const row=JSON.parse(read(path.join(home,'turns',traceId+'.json'),16384).toString('utf8'));
  const packet=JSON.parse(read(path.join(directory,'execution.json'),32768).toString('utf8').replace(/^\uFEFF/,''));
  const started=Date.parse(packet.startedAt),ended=Date.parse(packet.endedAt),at=Date.parse(row.startedAt);
  if(row.traceId!==traceId||row.status!=='completed'||!['turn_completed','completed'].includes(packet.state)||packet.exitCode!==0||
    packet.model!==source.model||(packet.sourceThread&&packet.sourceThread!==source.threadId)||
    ![started,ended,at].every(Number.isFinite)||at<started||at>ended)throw Error('review_packet_binding_mismatch');
  const file=path.resolve(directory,'final.md'),raw=read(file,4*1024*1024),text=raw.toString('utf8').replace(/^\uFEFF/,'');
  const events=read(path.join(directory,'events.jsonl'),32*1024*1024);
  const decoded=events.toString(events[0]===255&&events[1]===254?'utf16le':'utf8').replace(/^\uFEFF/,'');
  const entries=decoded.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const threads=entries.filter(e=>e.type==='thread.started').map(e=>e.thread_id);
  const finals=entries.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').map(e=>e.item.text);
  const turnStartIndex=entries.findIndex(e=>e.type==='turn.started');
  const finalIndex=entries.findLastIndex(e=>e.type==='item.completed'&&e.item?.type==='agent_message');
  const turnEndIndex=entries.findIndex(e=>e.type==='turn.completed');
  if(threads.length!==1||threads[0]!==source.threadId||
    entries.filter(e=>e.type==='turn.started').length!==1||entries.filter(e=>e.type==='turn.completed').length!==1||
    turnStartIndex<0||turnStartIndex>=finalIndex||finalIndex>=turnEndIndex||
    typeof finals.at(-1)!=='string'||finals.at(-1).trim()!==text.trim())throw Error('review_native_receipt_mismatch');
  // Browser completion and CLI output do not identify the exact Codex turn by
  // themselves. Bind the saved final to that turn's durable session receipt.
  const nativeProof=exactNativeSessionFinal(source.threadId,source.turnId,text,packet.startedAt,packet.endedAt,{sessionsRoot});
  if(!saveReview(home,traceId,text,{sourceFile:file,sourceSha256:crypto.createHash('sha256').update(raw).digest('hex'),nativeProof}))throw Error('review_save_failed');
  return {traceId,imported:true,exactNativeTurn:true,originalExecutionUnchanged:true,modelSends:0};
}
module.exports={importReview};
