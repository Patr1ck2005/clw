'use strict';
// One authenticated MCP entry. WebCodex HTTP identity/body/resources pass through;
// only the additional codex_* catalog and calls use the upstream native broker.
const http=require('node:http'),fs=require('node:fs'),crypto=require('node:crypto');
const path=require('node:path'),{pathToFileURL}=require('node:url');
const {nativeResultCode}=require('./native-errors.cjs');
const {adaptManifest,manifestArguments,resultTool}=require('./union-manifest.cjs');
const {createResultStore}=require('./result-store.cjs');
const {createResultTransport,INLINE_BYTES}=require('./result-transport.cjs');
const {createCatalogPages}=require('./catalog-pages.cjs');
const LIMIT=16*1024*1024;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
function localTarget(raw){
  const u=new URL(raw);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/mcp'||u.username||u.password||u.search||u.hash)throw Error('union_local_mcp_target_required');
  return u;
}
function headers(source){
  const out={...source};
  for(const name of ['host','connection','keep-alive','transfer-encoding','upgrade','proxy-authorization','proxy-authenticate'])delete out[name];
  return out;
}
async function body(stream){
  let size=0;const chunks=[];
  for await(const chunk of stream){size+=chunk.length;if(size>LIMIT)throw Error('union_body_too_large');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
function json(res,status,value,extra={}){
  if(res.destroyed)return;
  const raw=Buffer.from(JSON.stringify(value));res.writeHead(status,{...extra,'content-type':'application/json','content-length':raw.length});res.end(raw);
}
function nativeOutcome(status,value,extra={}){
  return {status,raw:Buffer.from(JSON.stringify(value)),headers:{...extra,'content-type':'application/json'}};
}
function sendNativeOutcome(res,outcome){
  if(res.destroyed)return;
  res.writeHead(outcome.status,{...outcome.headers,'content-length':outcome.raw.length});res.end(outcome.raw);
}
function rpcError(res,id,code,message,status=200){json(res,status,{jsonrpc:'2.0',id:id??null,error:{code,message}});}
function relayObserved(reply,res,event,meta,started){
  // Inspect only a bounded JSON envelope; forward the original bytes, including
  // SSE/image content, unchanged. Disconnect is not an instruction to replay.
  const chunks=[];let bytes=0,ended=false;
  reply.on('data',chunk=>{bytes+=chunk.length;if(bytes<=128*1024)chunks.push(chunk);else chunks.length=0;});
  const finish=kind=>{
    if(ended)return;ended=true;let message;
    if(kind==='mcp_call_finished'&&bytes<=128*1024&&String(reply.headers['content-type']).includes('application/json')){
      try{message=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
    }
    const inspected=!!message&&(Object.hasOwn(message,'result')||Object.hasOwn(message,'error'));
    // WebCodex can report an application failure inside an otherwise successful
    // HTTP/MCP envelope. Record only its boolean, never the error text or args.
    const structured=message?.result?.structuredContent;
    const applicationSuccess=structured?.success;
    const failedCount=structured?.output?.failed_count??structured?.failed_count;
    event({...meta,event:kind,httpStatus:reply.statusCode,bytes,durationMs:Date.now()-started,bodyInspected:inspected,
      ...(typeof applicationSuccess==='boolean'?{applicationSuccess}:{}),
      ...(Number.isInteger(failedCount)&&failedCount>=0&&failedCount<=1000000?{itemFailureCount:failedCount}:{}),
      ...(inspected?{rpcError:!!message.error,isError:message.result?.isError===true,...(Number.isInteger(message.error?.code)?{rpcErrorCode:message.error.code}:{})}:{})});
  };
  reply.once('end',()=>finish('mcp_call_finished'));
  reply.once('aborted',()=>{finish('mcp_transport_interrupted');res.destroy();});
  reply.once('error',()=>{finish('mcp_transport_interrupted');res.destroy();});
  res.writeHead(reply.statusCode,headers(reply.headers));reply.pipe(res);
}
function upstream(target,req,raw){
  return new Promise((resolve,reject)=>{
    const outgoing=http.request(target,{method:req.method,headers:{...headers(req.headers),...(raw?{'content-length':raw.length}:{})}},resolve);
    outgoing.on('error',reject);
    // Never retry an accepted request or interpret downstream disconnect as cancel.
    if(raw)outgoing.end(raw);else req.pipe(outgoing);
  });
}
async function nativeProvider({command,args,env,cwd}){
  const sdk=part=>import(pathToFileURL(path.join(__dirname,'upstream/node_modules/@modelcontextprotocol/sdk/dist/esm',part)).href);
  const [{Client},{StdioClientTransport}]=await Promise.all([sdk('client/index.js'),sdk('client/stdio.js')]);
  const transport=new StdioClientTransport({command,args,env,cwd,stderr:'pipe'});
  const client=new Client({name:'clw-unified-tools',version:'1.0.0'});
  try{
    await client.connect(transport);transport.stderr?.resume();
    const listed=await client.listTools();
    if(listed.nextCursor||!listed.tools.length||listed.tools.some(t=>!t.name.startsWith('codex_')))throw Error('union_native_catalog_invalid');
    return {tools:listed.tools,call:(params,signal)=>client.callTool(params,undefined,{signal,timeout:100000}),close:()=>client.close()};
  }catch(e){await client.close().catch(()=>{});throw e;}
}
async function startUnion({target,authorizationFile,native,port=0,onEvent=()=>{},resultHome,resultStore,inlineResultBytes=INLINE_BYTES,observeCallDetails=true}){
  const destination=localTarget(target),pending=new Map();
  const nativeNames=new Set(native.tools.map(t=>t.name));
  if(nativeNames.size!==native.tools.length||[...nativeNames].some(n=>!n.startsWith('codex_')))throw Error('union_native_catalog_invalid');
  // Read the existing local file reference only in memory. Nothing is reissued,
  // embedded in settings, logged, sent to the model, or returned in diagnostics.
  const authorized=req=>{
    const expected=Buffer.from(fs.readFileSync(authorizationFile,'utf8').trim()),actual=Buffer.from(req.headers.authorization||'');
    return expected.length>0&&actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);
  };
  const identity=(req,id)=>crypto.createHash('sha256').update(JSON.stringify([req.headers.authorization,req.headers['mcp-session-id']||'',typeof id,id])).digest('hex');
  const statelessRequest=(req,message)=>req.headers['mcp-protocol-version']==='2026-07-28'||message.params?._meta?.['io.modelcontextprotocol/protocolVersion']==='2026-07-28';
  // JSON-RPC IDs are not globally unique. Stateless ChatGPT conversations share
  // the authenticated tunnel and often reuse 0/1, so native turn authority is
  // also part of the active-call key. Do not change the wire ID or capability.
  const nativeIdentity=(req,message)=>crypto.createHash('sha256').update(JSON.stringify([
    identity(req,message.id),message.params?.arguments?.turn_token||'',
    // A stateless client may also reuse IDs for parallel calls inside one turn.
    // Distinguish actual operations; a repeated in-flight operation still holds.
    ...(statelessRequest(req,message)?[message.params?.name,canonical(message.params?.arguments||{})]:[])
  ])).digest('hex');
  const nativeRequestFingerprint=(req,message)=>{
    // Compare the full parsed request and forwarded authority/metadata. Framing
    // headers are omitted so reordered JSON remains the same canonical call.
    const forwarded=headers(req.headers);delete forwarded['content-length'];
    return crypto.createHash('sha256').update(JSON.stringify([req.method,req.url,canonical(forwarded),canonical(message)])).digest('hex');
  };
  const event=value=>{try{onEvent(value);}catch{}};
  const store=resultStore||createResultStore({home:resultHome||path.join(path.dirname(authorizationFile),'mcp-results')});
  const resultTransport=createResultTransport({store,inlineBytes:inlineResultBytes,onEvent:event});
  const catalogPages=createCatalogPages({inlineBytes:inlineResultBytes});
  let activeUpstream=0,activeRequests=0;
  const resultContext=(req,message,meta,reply)=>({id:message.id,method:message.method,tool:meta?.tool,
    ...(meta?{callId:meta.callId,part:'response',route:meta.route,sessionHash:meta.sessionHash,turnHash:meta.turnHash,
      observeCall:observeCallDetails,onObservation:()=>{meta.responseCaptured=true;}}:{}),
    uri:message.params?.uri,principal:req.headers.authorization,status:reply?.statusCode??200,
    contentType:reply?.headers?.['content-type']||'application/json',
    ...(statelessRequest(req,message)?{resultType:'complete',protocolMeta:{'io.modelcontextprotocol/serverInfo':{name:'clw-result-continuation',version:'1.0.0'}}}:{})});
  const sendProtected=async(res,outcome,context)=>{
    const bounded=await resultTransport.protect(outcome.raw,context);
    const responseHeaders=headers(outcome.headers);delete responseHeaders['content-length'];
    if(bounded.stored||bounded.attention)delete responseHeaders['content-encoding'];
    sendNativeOutcome(res,{...outcome,headers:responseHeaders,raw:bounded.raw});
    return {...outcome,headers:responseHeaders,raw:bounded.raw};
  };
  const authorityCheck=async(req,message)=>{
    const checkMethod=statelessRequest(req,message)?'server/discover':'ping';
    const raw=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,method:checkMethod,
      ...(message.params?{params:{_meta:message.params._meta}}:{})}));
    const checkedHeaders={...req.headers,'mcp-method':checkMethod};
    delete checkedHeaders['mcp-name'];delete checkedHeaders['mcp-tool-name'];
    const reply=await upstream(destination,{method:req.method,headers:checkedHeaders},raw);
    const bytes=await body(reply);let check;try{check=JSON.parse(bytes);}catch{}
    const responseHeaders=headers(reply.headers);delete responseHeaders['content-length'];
    return {allowed:reply.statusCode===200&&!!check&&!check.error&&Object.hasOwn(check,'result'),
      outcome:{status:reply.statusCode===200&&(!check||check.error)?502:reply.statusCode,headers:responseHeaders,raw:bytes}};
  };
  const server=http.createServer(async(req,res)=>{
    const tracked=req.method==='POST'&&req.url==='/mcp';if(tracked)activeRequests++;
    let message,callMeta,started;
    try{
      const address=server.address();
      if(req.headers.host!==`127.0.0.1:${address.port}`||req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${address.port}`){res.writeHead(403).end();return;}
      if(req.url==='/healthz'&&req.method==='GET'){json(res,200,{service:'clw-mcp-union',pid:process.pid,nativeToolCount:nativeNames.size,pendingNative:pending.size,
        activeUpstream,activeRequests,resultPaging:true,inlineResultBytes:resultTransport.inlineBytes});return;}
      if(req.url!=='/mcp'){res.writeHead(404).end();return;}
      if(!authorized(req)){res.writeHead(401).end();return;}
      if(req.method!=='POST'){
        const reply=await upstream(destination,req);res.writeHead(reply.statusCode,headers(reply.headers));reply.pipe(res);return;
      }
      const raw=await body(req);
      try{message=JSON.parse(raw);}catch{rpcError(res,null,-32700,'Invalid JSON',400);return;}
      if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'){rpcError(res,null,-32600,'Invalid request',400);return;}
      // A request ID is echoed in every response, including a continuation.
      // Reject an unbounded ID before accepting any original operation.
      if(typeof message.id==='string'&&Buffer.byteLength(message.id)>1024){rpcError(res,null,-32600,'MCP request ID exceeds the response framing budget',400);return;}
      const name=message.method==='tools/call'?message.params?.name:null;
      if(name||message.method==='resources/read'){
        started=Date.now();const args=message.params?.arguments||{};
        const fingerprint=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
        callMeta={callId:crypto.randomUUID(),method:message.method,tool:name,route:nativeNames.has(name)?'native':'webcodex',
          ...(args.session_id||args.recording_session_id?{sessionHash:fingerprint(args.session_id||args.recording_session_id)}:{}),
          ...(args.turn_token?{turnHash:fingerprint(args.turn_token)}:{})};
        event({...callMeta,event:'mcp_call_started'});
        // Resource URIs can contain private paths. Correlate their delivery
        // metadata without persisting an extra arguments observation.
        if(observeCallDetails&&name){
          resultTransport.observe(Buffer.from(JSON.stringify(args)),{...callMeta,part:'arguments',principal:req.headers.authorization,
            contentType:'application/json'});
          const originalEnd=res.end;
          res.end=function(...endArgs){
            const raw=endArgs[0];
            if(!callMeta.responseCaptured&&(typeof raw==='string'||Buffer.isBuffer(raw))){
              resultTransport.observe(Buffer.from(raw),{...resultContext(req,message,callMeta),status:res.statusCode,
                contentType:res.getHeader('content-type')||'application/json'});
            }
            return originalEnd.apply(this,endArgs);
          };
        }
        res.once('finish',()=>event({...callMeta,event:'mcp_response_sent',httpStatus:res.statusCode,durationMs:Date.now()-started}));
        res.once('close',()=>{if(!res.writableFinished)event({...callMeta,event:'mcp_client_disconnected',durationMs:Date.now()-started});});
      }
      if(message.method==='tools/list'&&catalogPages.handles(message.params?.cursor)){
        if(statelessRequest(req,message)&&req.headers['mcp-method']!==message.method){rpcError(res,message.id,-32020,'MCP method header does not match the request body',400);return;}
        const checked=await authorityCheck(req,message);
        if(!checked.allowed){sendNativeOutcome(res,checked.outcome);return;}
        try{json(res,200,catalogPages.read(message.params.cursor,{principal:req.headers.authorization,id:message.id}),checked.outcome.headers);}
        catch(error){rpcError(res,message.id,-32603,(error.code||'CATALOG_UNAVAILABLE')+': '+error.message);}
        return;
      }
      const localArgs=name==='clw_read_result'?message.params?.arguments:
        name==='call_runtime_tool'&&message.params?.arguments?.tool==='clw_read_result'?message.params.arguments.arguments:null;
      if(name==='clw_read_result'||name==='call_runtime_tool'&&message.params?.arguments?.tool==='clw_read_result'){
        if(!['string','number'].includes(typeof message.id)){rpcError(res,null,-32600,'Result read requires an ID',400);return;}
        if(statelessRequest(req,message)&&(req.headers['mcp-method']!==message.method||
          ![name,'=?base64?'+Buffer.from(name).toString('base64')+'?='].includes(req.headers['mcp-name']))){
          rpcError(res,message.id,-32020,'MCP method/name header does not match the request body',400);return;
        }
        const checked=await authorityCheck(req,message);
        if(!checked.allowed){sendNativeOutcome(res,checked.outcome);return;}
        try{
          if(!localArgs||typeof localArgs!=='object'||Array.isArray(localArgs)||
            Object.keys(localArgs).some(k=>!['result_id','offset','max_bytes','format'].includes(k)))throw Object.assign(Error('Invalid result read arguments'),{code:'RESULT_INVALID_ARGUMENT'});
          const page=await store.read(localArgs,req.headers.authorization);
          const next=!page.eof?{tool:'call_runtime_tool',arguments:{tool:'clw_read_result',arguments:{result_id:page.result_id,offset:page.next_offset,max_bytes:localArgs.max_bytes||65536,format:page.format}}}:null;
          const sidecars=['recording_session_id','ack_session_message_ids','context_request','session_message_resolution']
            .filter(key=>name==='call_runtime_tool'&&Object.hasOwn(message.params.arguments,key));
          const value={...page,...(next?{suggested_call:next}:{}),
            ...(sidecars.length?{unprocessed_workflow_sidecars:sidecars}:{}),instruction:page.eof?
            page.complete===false?'The saved prefix ends here; the original response was incomplete. Reconcile the original Job/request using its existing bounded read interfaces, then continue the current task. Do not re-execute an accepted action.':'This preserved result has been read to its end. Continue the original task using its actual outcome. Do not rerun the original action.':
            'Continue with suggested_call for additional required pages, then proceed with the original task. The original action was not replayed.'};
          // Keep page text in one model-visible content block. Duplicating a
          // heavily JSON-escaped page in structuredContent can exceed the wire
          // budget even though its original UTF-8 page is bounded.
          const {data,...pageMetadata}=value;
          const result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:{...pageMetadata,data_in_content:true},
            ...(statelessRequest(req,message)?{resultType:'complete',_meta:{'io.modelcontextprotocol/serverInfo':{name:'clw-result-continuation',version:'1.0.0'}}}:{})};
          json(res,200,{jsonrpc:'2.0',id:message.id,result},checked.outcome.headers);
          event({...callMeta,event:'mcp_call_finished',httpStatus:200,bodyInspected:true,isError:false,bytes:page.bytes_returned,durationMs:Date.now()-started});
        }catch(error){
          const code=/^RESULT_[A-Z_]+$/.test(error.code||'')?error.code:'RESULT_STORE_UNAVAILABLE';
          json(res,200,{jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:code+': Inspect the original Job/request or its existing bounded artifact/file interface; do not replay an accepted action. This does not cancel the current task.'}],structuredContent:{delivery:{status:'result_read_attention',reason:code,original_execution_replayed:false,continue_current_task:true}},
            ...(statelessRequest(req,message)?{resultType:'complete',_meta:{'io.modelcontextprotocol/serverInfo':{name:'clw-result-continuation',version:'1.0.0'}}}:{})}},checked.outcome.headers);
          event({...callMeta,event:'mcp_result_delivery_attention',code:'result_read_attention',durationMs:Date.now()-started});
        }
        return;
      }
      if(message.method==='notifications/cancelled'){
        const transportKey=identity(req,message.params?.requestId);
        const active=[...pending.values()].filter(p=>p.transportKey===transportKey);
        if(active.length){
          // Stateless cancellation lacks a native turn capability. Even one
          // active match does not prove it owns this notification; preserve it.
          if(!statelessRequest(req,message)&&req.headers['mcp-session-id']&&active.length===1&&!active[0].stateless)active[0].cancellation.abort();
          else event({event:'native_cancel_unresolved',code:'request_identity_ambiguous'});
          res.writeHead(202).end();return;
        }
      }
      if(nativeNames.has(name)){
        if(!['string','number'].includes(typeof message.id)){rpcError(res,null,-32600,'Native tool call requires an ID',400);return;}
        const stateless=statelessRequest(req,message);
        if(stateless&&(req.headers['mcp-method']!==message.method||
          ![name,'=?base64?'+Buffer.from(name).toString('base64')+'?='].includes(req.headers['mcp-name']))){
          rpcError(res,message.id,-32020,'Native MCP method/name header does not match the request body',400);return;
        }
        const key=nativeIdentity(req,message);
        const fingerprint=nativeRequestFingerprint(req,message),active=pending.get(key);
        if(active){
          if(active.fingerprint!==fingerprint){event({...callMeta,event:'native_duplicate_rejected',code:'same_turn_request_active'});rpcError(res,message.id,-32600,'Duplicate active request ID',409);return;}
          event({...callMeta,event:'native_duplicate_attached'});
          sendNativeOutcome(res,await active.completed);return;
        }
        const cancellation=new AbortController();let complete;
        const completed=new Promise(resolve=>{complete=resolve;});
        pending.set(key,{cancellation,transportKey:identity(req,message.id),stateless,fingerprint,completed});
        let outcome;
        try{
          // Let the existing authority validate current authentication, protocol,
          // and MCP session. Native authority additionally requires turn_token.
          // The stateless facade deliberately has no ping method. Discovery is
          // its read-only authority check; legacy sessions retain their ping.
          const checkMethod=stateless?'server/discover':'ping';
          const ping=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,method:checkMethod,...(message.params?{params:{_meta:message.params._meta}}:{})}));
          // Stateless MCP also declares method/name in HTTP metadata. This is
          // an auth/session check, not the user's tools/call; keep its headers
          // consistent while retaining the original protocol and identity.
          const pingHeaders={...req.headers,'mcp-method':checkMethod};
          delete pingHeaders['mcp-name'];delete pingHeaders['mcp-tool-name'];
          const checked=await upstream(destination,{method:req.method,headers:pingHeaders},ping),checkedRaw=await body(checked);
          const authHeaders=headers(checked.headers);delete authHeaders['content-length'];
          let check;try{check=JSON.parse(checkedRaw);}catch{}
          if(checked.statusCode!==200||!check||check.error||!Object.hasOwn(check,'result')){
            outcome={status:checked.statusCode===200?502:checked.statusCode,headers:authHeaders,raw:checkedRaw};return;
          }
          if(cancellation.signal.aborted)throw Error('cancelled');
          event({...callMeta,event:'native_call',tool:name});
          const result=await native.call(message.params,cancellation.signal);
          // Adapt only the protocol envelope. Native content/image blocks and
          // structuredContent retain their exact values and execution origin.
          const wireResult=stateless?{...result,resultType:'complete',_meta:{...result._meta,
            'io.modelcontextprotocol/serverInfo':{name:'clw-native-bridge',version:'1.0.0'}}}:result;
          outcome=nativeOutcome(200,{jsonrpc:'2.0',id:message.id,result:wireResult},authHeaders);
          const bounded=await resultTransport.protect(outcome.raw,{...resultContext(req,message,callMeta),
            isError:result.isError,resultType:wireResult.resultType,protocolMeta:wireResult._meta,
            originalOutcome:{...(typeof result.isError==='boolean'?{is_error:result.isError}:{}),
              ...(typeof result.structuredContent?.success==='boolean'?{success:result.structuredContent.success}:{}),
              ...(typeof result.structuredContent?.error_code==='string'?{error_code:result.structuredContent.error_code.slice(0,128)}:{}),
              ...(Number.isInteger(result.structuredContent?.output?.failed_count)?{failed_count:result.structuredContent.output.failed_count}:{})}});
          outcome={...outcome,raw:bounded.raw};
          const applicationSuccess=result.structuredContent?.success;
          const failedCount=result.structuredContent?.output?.failed_count??result.structuredContent?.failed_count;
          event({...callMeta,event:'native_result',tool:name,isError:result.isError===true,
            ...(typeof applicationSuccess==='boolean'?{applicationSuccess}:{}),
            ...(Number.isInteger(failedCount)&&failedCount>=0&&failedCount<=1000000?{itemFailureCount:failedCount}:{}),
            code:nativeResultCode(result),durationMs:Date.now()-started});
        }catch(error){
          outcome=nativeOutcome(200,{jsonrpc:'2.0',id:message.id,error:{code:Number.isInteger(error.code)?error.code:-32603,message:'Native tool failed; original execution was not replayed'}});
          event({...callMeta,event:'native_error',tool:name,durationMs:Date.now()-started});
        }finally{
          // Keep only active calls. All attached requests receive this exact
          // envelope, including an authority denial or an unknown result.
          complete(outcome);pending.delete(key);sendNativeOutcome(res,outcome);
        }
        return;
      }
      activeUpstream++;
      const reply=await upstream(destination,req,raw).catch(error=>{activeUpstream--;throw error;});
      let accounted=false;
      const account=()=>{if(!accounted){accounted=true;activeUpstream--;}};
      reply.once('end',account);reply.once('error',account);reply.once('aborted',account);
      const manifestArgs=message.method==='tools/call'?manifestArguments(message.params):null;
      if(manifestArgs&&reply.statusCode===200&&String(reply.headers['content-type']).includes('application/json')){
        // The original service validates the unchanged request and sidecars.
        // Extend only successful discovery or the exact native missing-name
        // error; denial and all other errors pass through unchanged.
        const collected=await resultTransport.relay(reply,null,{...resultContext(req,message,callMeta,reply),observeCall:false});
        const original=collected.raw;
        const responseHeaders=headers(reply.headers);delete responseHeaders['content-length'];delete responseHeaders['content-encoding'];
        if(collected.stored||collected.attention){
          if(collected.descriptor)resultTransport.observe(null,resultContext(req,message,callMeta,reply),collected.descriptor);
          sendNativeOutcome(res,{status:reply.statusCode,headers:responseHeaders,raw:original});return;
        }
        const envelope=JSON.parse(original);
        const adapted=adaptManifest(envelope,manifestArgs,native.tools,[resultTool]);
        await sendProtected(res,{status:200,headers:responseHeaders,raw:adapted===envelope?original:Buffer.from(JSON.stringify(adapted))},
          {...resultContext(req,message,callMeta,reply),isError:adapted.result?.isError,
            resultType:adapted.result?.resultType,protocolMeta:adapted.result?._meta,
            originalOutcome:{...(typeof adapted.result?.structuredContent?.success==='boolean'?{success:adapted.result.structuredContent.success}:{})}});
        event({...callMeta,event:'mcp_call_finished',httpStatus:200,bodyInspected:true,rpcError:!!adapted.error,
          isError:adapted.result?.isError===true,manifestExtended:adapted!==envelope,
          // Public catalog names and fixed flags only; no arguments, sidecar
          // identities, tool response text or native turn capabilities.
          manifestQuery:nativeNames.has(manifestArgs.tool_name)?manifestArgs.tool_name:manifestArgs.tool_name?'other':'catalog',
          manifestOriginalSuccess:envelope.result?.structuredContent?.success===true,
          manifestResultSuccess:adapted.result?.structuredContent?.success===true,
          durationMs:Date.now()-started});
        return;
      }
      if(message.method!=='tools/list'||reply.statusCode!==200){
        const delivered=await resultTransport.relay(reply,res,resultContext(req,message,callMeta,reply));
        let inspected;
        if(!delivered.stored&&!delivered.attention&&delivered.bytes<=128*1024&&String(reply.headers['content-type']).includes('application/json')){
          try{inspected=JSON.parse(delivered.raw.toString('utf8'));}catch{}
        }
        const structured=inspected?.result?.structuredContent;
        event({...callMeta,method:message.method,event:'mcp_call_finished',httpStatus:reply.statusCode,bytes:delivered.bytes,
          bodyInspected:!!inspected,rpcError:!!inspected?.error,isError:inspected?.result?.isError===true,
          ...(typeof structured?.success==='boolean'?{applicationSuccess:structured.success}:{}),
          ...(Number.isInteger(structured?.output?.failed_count)?{itemFailureCount:structured.output.failed_count}:{}),
          durationMs:Date.now()-(started||Date.now())});
        return;
      }
      // Current WebCodex returns JSON for its catalog. Other calls, including
      // streaming resources, are forwarded byte-for-byte without flattening.
      if(!String(reply.headers['content-type']).includes('application/json')){reply.resume();throw Error('union_catalog_transport_changed');}
      const catalog=JSON.parse(await body(reply));
      if(catalog.result?.tools){
        if(catalog.result.tools.some(t=>nativeNames.has(t.name)||t.name===resultTool.name))throw Error('union_tool_name_collision');
        for(const tool of catalog.result.tools)if(tool.name==='tool_manifest')tool.description+=' This unified entry also includes the codex_native category and exact codex_* contracts. Their turn_token authority is separate from Workflow Sessions.';
        if(!catalog.result.nextCursor)catalog.result.tools.push(...native.tools,resultTool);
        const names=catalog.result.tools.map(t=>t.name);
        event({event:'mcp_catalog',toolCount:names.length,runProcessPresent:names.includes('run_process'),catalogHash:crypto.createHash('sha256').update(JSON.stringify(names)).digest('hex')});
      }
      const responseHeaders=headers(reply.headers);delete responseHeaders['content-length'];delete responseHeaders['content-encoding'];
      // Catalog discovery retains MCP's ListToolsResult shape and cursor
      // protocol. A tool-result receipt is only valid for tools/call.
      try{json(res,200,catalogPages.paginate(catalog,{principal:req.headers.authorization}),responseHeaders);}
      catch(error){rpcError(res,message.id,-32603,(error.code||'CATALOG_UNAVAILABLE')+': '+error.message);}
    }catch(error){
      if(res.headersSent)res.destroy();else rpcError(res,message?.id,-32603,'Unified MCP unavailable; no call replayed',502);
      event({...callMeta,event:'union_error',code:['union_tool_name_collision','union_body_too_large','union_catalog_transport_changed'].includes(error.message)?error.message:'transport'});
    }finally{if(tracked)activeRequests--;}
  });
  server.requestTimeout=120000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}/mcp`,close:async()=>{
    for(const p of pending.values())p.cancellation.abort();
    const done=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await done;await native.close();await resultTransport.flushObserved();
  }};
}
module.exports={startUnion,nativeProvider,localTarget};
