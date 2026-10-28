import {getConfigDir} from './upstream/src/config';
import {createChatGptWebAdapter,chatGptWebExecutionNamespace,chatGptWebTraceId} from './upstream/src/adapters/chatgpt-web';
import {chatGptTurnSessions} from './upstream/src/adapters/chatgpt-web/turn-execution';
import {chatGptTurnExecutionKey} from './upstream/src/adapters/chatgpt-web/turn-execution';
import {existingStructuredCompactionRun} from './upstream/src/adapters/chatgpt-web/compaction-handoff';
import {recoverCompactionInstruction} from './upstream/src/adapters/chatgpt-web/compaction-continuation';
import {decodeCompactionSummary,SUMMARY_PREFIX} from './upstream/src/responses/compaction';
import {createHash} from 'node:crypto';
import {extractChatGptTurnIdentity,extractChatGptTurnEnvironment} from './upstream/src/adapters/chatgpt-web/environment';
import type {ProviderAdapter} from './upstream/src/adapters/base';
import type {CodexProviderConfig} from './upstream/src/types';
import {createNativeTurnAdmission,NativeTurnReconciliationError,runtimeOwnerEpoch} from './native-turn-admission';
import {commitFinalReplay,finalReplayBinding,finalReplayJournalExists,finalReplayResponseId,NativeFinalReplayNotEligible,readFinalReplay} from './final-replay-journal';
import type {AdapterEvent} from './upstream/src/types';
import source from './turn-source.cjs';
import review from './turn-review.cjs';
import accountBinding from './account-binding.cjs';
import {observeFailedSettlement} from './failed-turn-settlement';

// The CLW seam observes the original adapter and durably admits its native turn before
// the upstream adapter can register a broker token or activate a browser Send.
export function observedAdapter(provider:CodexProviderConfig,home=getConfigDir(),factory=createChatGptWebAdapter,ownerEpoch=runtimeOwnerEpoch):ProviderAdapter{
  const account=process.env.CLW_WEB_ACCOUNT||'B';
  return {name:'chatgpt-web',async runTurn(parsed,incoming,emit){
    let traceId:string|undefined,finalText='',overflow=false,trace:string;
    let identity:ReturnType<typeof extractChatGptTurnIdentity>;
    try{
      identity=extractChatGptTurnIdentity(parsed);
      if(!source.uuid(identity.threadId)||!source.uuid(identity.turnId))throw new Error('Missing native turn identity');
      trace=chatGptWebTraceId(provider,parsed);
    }catch{
      emit({type:'error',message:'Native turn identity is unavailable; no Web send was admitted.',status:409,errorType:'invalid_request_error',code:'native_turn_reconciliation_required',retryable:false});
      return;
    }
    // Only a committed, exact final may bypass the admission gate. This path never
    // constructs a broker token or enters the browser adapter.
    try{accountBinding.bindThreadAccount(home,identity.threadId,account);}catch{
      emit({type:'error',message:'This native thread belongs to a different Web account or its account history needs review. No Web send was admitted.',status:409,errorType:'invalid_request_error',code:'bridge_thread_account_mismatch',retryable:false});return;
    }
    let replayBinding:ReturnType<typeof finalReplayBinding>|undefined;
    try{
      replayBinding=finalReplayBinding(parsed,{threadId:identity.threadId!,turnId:identity.turnId!},trace);
      if(finalReplayJournalExists(home,trace)){
        const replay=readFinalReplay(home,replayBinding);
        if(!replay)throw new Error('Missing replay journal');
        (parsed as typeof parsed & {_clwReplayResponseId?:string;_clwReplayCreatedAt?:number})._clwReplayResponseId=replay.responseId;
        (parsed as typeof parsed & {_clwReplayCreatedAt?:number})._clwReplayCreatedAt=replay.createdAt;
        for(const event of replay.events)emit(event);
        return;
      }
      (parsed as typeof parsed & {_clwReplayResponseId?:string;_clwReplayCreatedAt?:number})._clwReplayResponseId=finalReplayResponseId(replayBinding);
      (parsed as typeof parsed & {_clwReplayCreatedAt?:number})._clwReplayCreatedAt=Math.floor(Date.now()/1000);
    }catch(error){
      if(finalReplayJournalExists(home,trace)||!(error instanceof NativeFinalReplayNotEligible)){
        emit({type:'error',message:error instanceof Error?error.message:'Native final replay is unavailable.',status:409,errorType:'invalid_request_error',code:'native_turn_reconciliation_required',retryable:false});
        return;
      }
      // A non-final-only first execution still uses the original admission path.
      replayBinding=undefined;
    }
    let admitted:{replayOnly:boolean;complete(kind?:'final'|'checkpoint'):void};
    const admission=createNativeTurnAdmission(home,ownerEpoch,undefined,(threadId,turnId,traceId)=>{
      if(chatGptTurnSessions.hasCanonicalNativeTrace(traceId,threadId,turnId))return true;
      if(!parsed._compactionRequest||identity.threadId!==threadId||identity.turnId!==turnId||traceId!==trace)return false;
      const executionKey=`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`;
      return existingStructuredCompactionRun(executionKey)!==undefined;
    },(threadId,turnId)=>{
      if(identity.threadId!==threadId||identity.turnId!==turnId)return undefined;
      const accepted=recoverCompactionInstruction(parsed,identity);
      if(!accepted)return undefined;
      const item=(parsed._rawBody as {input?:any[]})?.input?.[accepted.summaryIndex];
      let summary:string|null=null;
      if(['compaction','compaction_summary','context_compaction'].includes(item?.type))summary=decodeCompactionSummary(item.encrypted_content);
      else if(item?.type==='message'&&item.role==='user'){
        const text=typeof item.content==='string'?item.content:item.content?.map((part:any)=>part?.text??'').join('\n');
        if(typeof text==='string')summary=text.slice(SUMMARY_PREFIX.length+1);
      }
      return summary?createHash('sha256').update(summary.trim()).digest('hex'):undefined;
    });
    try{admitted=admission.admit(identity,trace);}
    catch(error){
      const message=error instanceof NativeTurnReconciliationError?error.message:'Native turn admission failed; reconcile the original turn before another Web send.';
      emit({type:'error',message,status:409,errorType:'invalid_request_error',code:'native_turn_reconciliation_required',retryable:false});
      return;
    }
    try{
      const model=(parsed._rawBody as {model?:unknown})?.model;
      let workingDirectory:string|undefined;
      try{workingDirectory=extractChatGptTurnEnvironment(parsed).cwd;}catch{/* Historical envelope may be omitted. */}
      if(source.saveSource(home,{traceId:trace,...identity,account,model,workingDirectory,
        purpose:parsed._compactionRequest?'compaction':'response'})!==true)throw new Error('Native turn source binding was rejected');
      traceId=trace;
    }catch{
      emit({type:'error',message:'Native turn source binding could not be saved; reconcile the original turn before another Web send.',status:409,errorType:'invalid_request_error',code:'native_turn_reconciliation_required',retryable:false});
      return;
    }
    // The upstream creation point must also enforce replay-only. The canonical
    // cache can retire between the admission check and adapter.runTurn().
    (parsed as typeof parsed & {_clwReplayOnly?:boolean})._clwReplayOnly=admitted.replayOnly;
    const adapter=factory(provider);
    let terminalErrorSeen=false,terminalProtocolError=false,pendingFinal:Extract<AdapterEvent,{type:'done'}>|undefined;
    let failedSession:ReturnType<typeof chatGptTurnSessions.find>;
    const originalExecutionKey=`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`;
    let replayEvents:AdapterEvent[]|undefined=replayBinding?[]:undefined;
    let replayBytes=0;
    try { await adapter.runTurn(parsed,incoming,event=>{
      if(terminalProtocolError)return;
      if(pendingFinal){
        // Do not release a proposed terminal when a later adapter event proves
        // that the round did not end there.
        pendingFinal=undefined;replayEvents=undefined;terminalErrorSeen=true;terminalProtocolError=true;
        emit(event.type==='error'||event.type==='incomplete'?event:{type:'error',message:'Native adapter emitted after its terminal marker; reconcile the original turn.',status:409,errorType:'invalid_request_error',code:'native_turn_reconciliation_required',retryable:false});
        return;
      }
      if(event.type==='error'||event.type==='incomplete'){
        terminalErrorSeen=true;
        // Keep the original session while the upstream error event still owns
        // it. The adapter may remove it from the registry before returning.
        failedSession??=chatGptTurnSessions.find(originalExecutionKey);
      }
      if(event.type==='assistant_boundary'){finalText='';overflow=false;}
      if(event.type==='text_delta'&&event.phase==='final_answer'&&!overflow){
        if(finalText.length+event.text.length>4*1024*1024){finalText='';overflow=true;}else finalText+=event.text;
      }
      if(replayEvents){
        if(event.type==='tool_call_start'||event.type==='tool_call_delta'||event.type==='tool_call_end'
          ||event.type==='error'||event.type==='incomplete'
          ||event.type==='done'&&(event.endTurn!==true||event.stopReason!=='stop')){replayEvents=undefined;}
        else{
          try{
            replayBytes+=Buffer.byteLength(JSON.stringify(event));
            if(replayBytes>7*1024*1024)replayEvents=undefined;
            else replayEvents.push(event);
          }catch{replayEvents=undefined;}
        }
      }
      if(event.type==='done'&&event.endTurn===true){pendingFinal=event;return;}
      emit(event);
    }); } finally {
      if (!pendingFinal) {
        // Upstream owns the cleanup. Observe it without delaying an error or
        // cancelling accepted tools. Missing/unknown settlement stays closed.
        void observeFailedSettlement(home,{threadId:identity.threadId!,turnId:identity.turnId!},trace,
          failedSession??chatGptTurnSessions.find(originalExecutionKey));
      }
    }
    if(!pendingFinal)return;
    let finalReviewSaved=false;
    try{
      if(traceId&&finalText&&!overflow&&!terminalErrorSeen)finalReviewSaved=review.saveReview(home,traceId,finalText)===true;
    }catch{/* Review metadata must never alter original output or execution. */}
    if(finalReviewSaved&&!terminalErrorSeen){
      try{
        admitted.complete(parsed._compactionRequest?'checkpoint':'final');
        if(replayBinding&&replayEvents){
          const createdAt=(parsed as typeof parsed & {_clwReplayCreatedAt?:number})._clwReplayCreatedAt;
          commitFinalReplay(home,replayBinding,createdAt!,replayEvents);
        }
      }catch(error){
        emit({type:'error',message:error instanceof Error?error.message:'Native final replay could not be saved.',status:409,errorType:'invalid_request_error',code:'native_turn_reconciliation_required',retryable:false});
        return;
      }
    }
    emit(pendingFinal);
  }};
}
