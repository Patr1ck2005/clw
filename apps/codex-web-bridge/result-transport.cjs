'use strict';
// A tunnel response is wrapped by the control plane. Keep the original HTTP
// body below 6 MiB, leaving room for base64 and JSON framing in its 10 MiB cap.
// Larger finite replies become durable, readable continuations, never retries.
const zlib=require('node:zlib');
const INLINE_BYTES=6*1024*1024;
const STORE_CODES=new Set(['RESULT_STORE_BUSY','RESULT_STORE_FULL','RESULT_STORAGE_ERROR','RESULT_TOO_LARGE',
  'RESULT_INCOMPLETE','RESULT_CORRUPT','RESULT_INVALID_ARGUMENT','RESULT_INVALID_PRINCIPAL','RESULT_NOT_FOUND']);
function storageDiagnosis(error,context,phase,started){
  return {callId:context.callId,phase,storeCode:STORE_CODES.has(error?.code)?error.code:'RESULT_STORE_UNAVAILABLE',
    durationMs:Math.round(performance.now()-started)};
}
const GUIDANCE='The original response has been preserved in full and is available in pages. This is a delivery continuation, not a reason to end the conversation or abandon the task. Read the required pages with clw_read_result, then continue the current work. Do not rerun the original action: it may already have executed. Use the original result to determine execution success or failure.';
function boundedContext(context){
  const short=(value,limit)=>typeof value==='string'?value.slice(0,limit):value;
  let protocolMeta=context.protocolMeta;
  // Metadata is part of the original durable response too. Repeating an
  // oversized _meta block in its receipt would recreate the delivery failure.
  if(protocolMeta&&Buffer.byteLength(JSON.stringify(protocolMeta))>16384){
    const info=protocolMeta['io.modelcontextprotocol/serverInfo'];
    protocolMeta=info?{'io.modelcontextprotocol/serverInfo':{name:short(info.name,256),version:short(info.version,64)}}:undefined;
  }
  return {...context,tool:short(context.tool,256),method:short(context.method,128),
    contentType:short(context.contentType,256),contentEncoding:short(context.contentEncoding,128),
    uri:typeof context.uri==='string'&&context.uri.length<=2048?context.uri:undefined,protocolMeta};
}
function cleanHeaders(source){
  const out={...source};
  for(const key of ['content-length','content-encoding','transfer-encoding','connection','keep-alive'])delete out[key];
  return out;
}
function suggested(descriptor,offset=0,format='text'){
  const args={result_id:descriptor.result_id,offset,max_bytes:65536,format};
  return {tool:'call_runtime_tool',arguments:{tool:'clw_read_result',arguments:args}};
}
function receipt(descriptor,context={}){
  return {delivery:{...descriptor,status:descriptor.complete===false?'partial_result_preserved':'result_preserved',
    complete:descriptor.complete!==false,original_execution_replayed:false,
    continue_current_task:true,original_method:context.method||null,original_tool:context.tool||null,
    original_http_status:context.status??200,original_content_type:context.contentType||'application/json',
    original_content_encoding:context.contentEncoding||null,original_outcome:context.originalOutcome||'read_original_result_to_determine'},
    instruction:descriptor.complete===false?GUIDANCE+' The upstream response was interrupted; the stored bytes are partial, not a complete outcome. Reconcile the original Job/request before proceeding.':GUIDANCE,
    suggested_call:suggested(descriptor,0,context.binary?'base64':'text')};
}
function envelope(id,value,context={}){
  const text=JSON.stringify(value);
  if(context.method==='resources/read')return {jsonrpc:'2.0',id:id??null,result:{
    contents:[{uri:typeof context.uri==='string'?context.uri:'clw://result/'+value.delivery.result_id,
      mimeType:'text/plain',text}],...(context.protocolMeta?{_meta:context.protocolMeta}:{})}};
  return {jsonrpc:'2.0',id:id??null,result:{content:[{type:'text',text}],
    structuredContent:value,...(typeof context.isError==='boolean'?{isError:context.isError}:{}),
    ...(context.resultType?{resultType:context.resultType}:{}),
    ...(context.protocolMeta?{_meta:context.protocolMeta}:{})}};
}
function wireReceipt(id,value,context={}){
  context=boundedContext(context);
  const serialized=JSON.stringify(envelope(id,value,context));
  return String(context.contentType).includes('text/event-stream')?
    Buffer.from('event: message\ndata: '+serialized+'\n\n'):Buffer.from(serialized);
}
function unavailable(id,code,context={},details={}){
  const value={delivery:{status:'result_delivery_incomplete',original_execution_replayed:false,
    continue_current_task:true,original_method:context.method||null,original_tool:context.tool||null,
    original_http_status:context.status??200,reason:code},instruction:
      'The original action was not replayed. Result delivery needs reconciliation; this does not cancel the current task. Inspect the original Job/request or use its existing bounded file/artifact/log interface. Do not rerun an accepted action.',
    ...(details.result?{preserved_partial_result:details.result,suggested_call:suggested(details.result,0,context.binary?'base64':'text')}:{})};
  return wireReceipt(id,value,context);
}
function createResultTransport({store,inlineBytes=INLINE_BYTES,onEvent=()=>{},maxObservationBytes=32*1024*1024,maxObservations=8}){
  if(!Number.isSafeInteger(inlineBytes)||inlineBytes<1024||inlineBytes>INLINE_BYTES)throw Error('result_inline_limit_invalid');
  if(!Number.isSafeInteger(maxObservationBytes)||maxObservationBytes<1024||!Number.isSafeInteger(maxObservations)||maxObservations<1)throw Error('result_observation_bounds_invalid');
  const event=row=>{try{onEvent(row);}catch{}};
  const observations=new Set();let observationBytes=0;
  function observe(raw,context,descriptor){
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(context?.callId||'')||context.observeCall===false)return;
    const part=context.part||'response';
    if(!['arguments','response'].includes(part))return;
    try{context.onObservation?.();}catch{}
    const base={event:'mcp_call_details',callId:context.callId,part,method:context.method,tool:context.tool,
      route:context.route,sessionHash:context.sessionHash,turnHash:context.turnHash};
    const publish=saved=>event({...base,resultId:saved.result_id,complete:saved.complete!==false});
    if(descriptor){publish(descriptor);return;}
    const size=raw?.length||0;
    if(observations.size>=maxObservations||observationBytes+size>maxObservationBytes){event({...base,code:'call_details_observer_busy'});return;}
    let snapshot;try{snapshot=Buffer.from(raw);}catch{event({...base,code:'call_details_storage_unavailable'});return;}
    observationBytes+=snapshot.length;
    const started=performance.now();
    const operation=Promise.resolve().then(()=>store.put(snapshot,{principal:context.principal,contentType:context.contentType,
      status:context.status,tool:context.tool,callId:context.callId,part,activityOnly:true,complete:context.complete!==false}))
      .then(publish,error=>{if(error?.details?.result)publish(error.details.result);else event({...base,code:'call_details_storage_unavailable',
        ...storageDiagnosis(error,context,'observer_store',started)});})
      .catch(()=>event({...base,code:'call_details_storage_unavailable'}))
      .finally(()=>{observations.delete(operation);observationBytes-=snapshot.length;});
    observations.add(operation);
  }
  const flushObserved=async({timeoutMs=1000}={})=>{
    if(!observations.size)return true;
    let timer;try{return await Promise.race([Promise.allSettled([...observations]).then(()=>true),
      new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);})]);}finally{clearTimeout(timer);}
  };
  async function protect(raw,context){
    if(raw.length<=inlineBytes){observe(raw,context);return {raw,stored:false};}
    context=boundedContext(context);
    const started=performance.now();
    try{
      const descriptor=await store.put(raw,{principal:context.principal,contentType:context.contentType,
        status:context.status,tool:context.tool,...(context.callId?{callId:context.callId,part:context.part||'response'}:{})});
      observe(null,context,descriptor);
      event({event:'mcp_result_preserved',method:context.method,tool:context.tool,bytes:raw.length});
      return {raw:wireReceipt(context.id,receipt(descriptor,context),context),stored:true,descriptor};
    }catch(error){
      if(error.details?.result)observe(null,context,error.details.result);
      event({event:'mcp_result_delivery_attention',method:context.method,tool:context.tool,bytes:raw.length,code:'result_store_unavailable',
        ...storageDiagnosis(error,context,'buffer_store',started)});
      return {raw:unavailable(context.id,/^RESULT_[A-Z_]+$/.test(error.code||'')?error.code:'RESULT_STORE_UNAVAILABLE',context,error.details),stored:false,attention:true};
    }
  }
  async function relay(reply,res,context){
    context=boundedContext(context);
    let stream=reply,bytes=0;
    const encoding=String(reply.headers['content-encoding']||'').toLowerCase();
    const decoder=encoding==='gzip'?zlib.createGunzip():encoding==='br'?zlib.createBrotliDecompress():encoding==='deflate'?zlib.createInflate():null;
    if(encoding&&!decoder){
      // Keep the raw bytes recoverable for an unfamiliar encoding rather than
      // incorrectly decoding them or flattening media to lossy text.
      context={...context,contentEncoding:encoding,binary:true};
    }else if(decoder){
      reply.once('error',error=>decoder.destroy(error));
      reply.once('aborted',()=>decoder.destroy(Error('result_upstream_interrupted')));
      reply.pipe(decoder);stream=decoder;context={...context,contentEncoding:encoding};
    }
    const parts=[],iterator=stream[Symbol.asyncIterator]();let result;
    try{
      while(true){
        const next=await iterator.next();
        if(next.done){result={raw:Buffer.concat(parts,bytes),stored:false};break;}
        const chunk=Buffer.from(next.value);parts.push(chunk);bytes+=chunk.length;
        if(bytes>inlineBytes){
          async function* remaining(){
            for(const part of parts)yield part;
            while(true){const more=await iterator.next();if(more.done)break;bytes+=more.value.length;yield more.value;}
          }
          const started=performance.now();
          try{
            const descriptor=await store.putStream(remaining(),{principal:context.principal,
              contentType:context.contentType,status:context.status,tool:context.tool,...(context.callId?{callId:context.callId,part:context.part||'response'}:{})});
            result={raw:wireReceipt(context.id,receipt(descriptor,context),context),stored:true,descriptor};
            event({event:'mcp_result_preserved',method:context.method,tool:context.tool,bytes});
          }catch(error){
            event({event:'mcp_result_delivery_attention',method:context.method,tool:context.tool,bytes,code:'result_store_unavailable',
              ...storageDiagnosis(error,context,'stream_store',started)});
            // Continue draining this original response; a downstream disconnect
            // or local storage fault must not cancel/replay a business command.
            try{while(!(await iterator.next()).done){}}catch{}
            result={raw:unavailable(context.id,/^RESULT_[A-Z_]+$/.test(error.code||'')?error.code:'RESULT_STORE_UNAVAILABLE',context,error.details),attention:true,
              ...(error.details?.result?{descriptor:error.details.result}:{})};
          }
          break;
        }
      }
    }catch(error){
      // Even a short interrupted stream may contain the only copy of a tool
      // outcome. Preserve that prefix before reporting the incomplete reply.
      let details;
      if(bytes){
        try{details={result:await store.put(Buffer.concat(parts,bytes),{principal:context.principal,
          contentType:context.contentType,status:context.status,tool:context.tool,complete:false,
          ...(context.callId?{callId:context.callId,part:context.part||'response'}:{}),
          incompleteReason:'upstream_interrupted'})};}catch(storeError){details=storeError.details;}
      }
      result={raw:unavailable(context.id,'RESULT_UPSTREAM_INTERRUPTED',context,details),attention:true};
      if(details?.result)result.descriptor=details.result;
      event({event:'mcp_transport_interrupted',method:context.method,tool:context.tool,bytes});
    }
    if(result.descriptor)observe(null,context,result.descriptor);
    else if(!result.attention)observe(result.raw,context);
    if(res&&!res.destroyed){
      const responseHeaders=cleanHeaders(reply.headers);
      if(result.stored||result.attention){responseHeaders['content-type']=String(context.contentType).includes('text/event-stream')?'text/event-stream':'application/json';}
      else if(encoding&&!decoder)responseHeaders['content-encoding']=encoding;
      res.writeHead(reply.statusCode,{...responseHeaders,'content-length':result.raw.length});res.end(result.raw);
    }
    return {...result,bytes};
  }
  return {protect,relay,inlineBytes,observe,flushObserved};
}
module.exports={createResultTransport,INLINE_BYTES,receipt,envelope,wireReceipt,GUIDANCE};
