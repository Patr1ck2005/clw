'use strict';
const {randomUUID}=require('node:crypto');
// Per read: at most 32MiB of encoded source JSON and 2MiB of projected metadata.
// JSON parsing also allocates transient strings/objects inside the renderer;
// unused message content/attachments never leave it or go to disk.
const ORIGIN='https://chatgpt.com',MAX_BYTES=32*1024*1024,MAX_PROJECTED=2*1024*1024,REQUEST_MS=60000;
const CODES=new Set(['timeout','request_failed','invalid_response','invalid_auth','response_too_large','redirect_refused','account_context_changed']);
const TYPES=new Set(['application/json','application/problem+json','text/html','text/plain','application/octet-stream','other']);
const READ_LANES=new WeakMap();
class HistoryPageError extends Error{constructor(code){super(CODES.has(code)?code:'request_failed');this.code=this.message;}}
function fail(code){throw new HistoryPageError(code);}
async function evaluateOwnedPage(wc,expression){
  // The caller first waits for the original account page to finish loading.
  // Reuse its ordinary main-world execution, as the vendor browser host does;
  // this private helper only receives the fixed read/cancel expressions below.
  return wc.executeJavaScript(expression,false);
}
function pageUrl(value){try{const u=new URL(value);return u.origin===ORIGIN&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function requestRoute(value,options){
  if(typeof value!=='string'||!options||typeof options!=='object'||
     Object.keys(options).some(k=>!['method','redirect','credentials','headers','signal'].includes(k))||
     (options.method!==undefined&&options.method!=='GET')||(options.redirect!==undefined&&options.redirect!=='error')||
     (options.credentials!==undefined&&options.credentials!=='include'))fail('invalid_response');
  let u;try{u=new URL(value);}catch{fail('redirect_refused');}
  if(u.origin!==ORIGIN||u.username||u.password||u.hash)fail('redirect_refused');
  let stage;
  if(u.pathname==='/api/auth/session'&&!u.search)stage='auth';
  else if(u.pathname==='/backend-api/conversations'&&[...u.searchParams].length===3&&
    /^(?:0|100|200|300|400)$/.test(u.searchParams.get('offset')||'')&&u.searchParams.get('limit')==='100'&&
    u.searchParams.get('order')==='updated')stage='list';
  else if(!u.search&&/^\/backend-api\/conversation\/[a-z0-9_-]{1,128}$/i.test(u.pathname))stage='detail';
  else fail('invalid_response');
  let authorization;
  if(options.headers!==undefined){
    if(!options.headers||typeof options.headers!=='object'||Array.isArray(options.headers)||
       Object.keys(options.headers).some(k=>k!=='Authorization'))fail('invalid_response');
    authorization=options.headers.Authorization;
    if(typeof authorization!=='string'||!/^Bearer [^\r\n]+$/.test(authorization)||authorization.length>16400)fail('invalid_auth');
  }
  if(stage==='auth'&&authorization!==undefined)fail('invalid_auth');
  if(stage!=='auth'&&authorization===undefined)fail('invalid_auth');
  const signal=options.signal;
  if(signal!==undefined&&(!signal||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'||typeof signal.aborted!=='boolean'))fail('invalid_response');
  return {route:u.pathname+u.search,stage,authorization,signal};
}

// Runs only in the owned page's existing main world. The document token
// prevents a same-URL reload between binding and request evaluation from
// turning an old read into a request on the replacement document.
function bindDocument(url,token){
  if(location.href!==url||location.origin!=='https://chatgpt.com')return {error:'account_context_changed'};
  const key=Symbol.for('clw.chat-history.reads.v1');let state=globalThis[key];
  if(!state||state.document!==document)state=globalThis[key]={document,token,requests:new Map(),cancelled:new Map()};
  return {documentToken:state.token};
}
function projectPayload(data,stage){
  const failure=code=>{throw Error(code);};
  if(!data||typeof data!=='object'||Array.isArray(data))failure('invalid_response');
  if(stage==='auth'){
    const id=data.user?.id,token=data.accessToken,expires=data.expires;
    if(typeof id!=='string'||!id||id.length>512||id.includes('\0')||typeof token!=='string'||!token||token.length>16384||
       typeof expires!=='string'||expires.length>64||!Number.isFinite(Date.parse(expires)))failure('invalid_auth');
    return {user:{id},accessToken:token,expires};
  }
  if(stage==='list'){
    if(!Array.isArray(data.items)||data.items.length>100)failure('invalid_response');
    const items=data.items.map(item=>{
      if(typeof item?.id!=='string'||!/^[a-z0-9_-]{1,128}$/i.test(item.id))failure('invalid_response');
      const row={id:item.id},at=item.update_time;
      if(typeof at==='number'&&Number.isFinite(at))row.update_time=at;
      else if(typeof at==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(at)&&at.length<=40&&Number.isFinite(Date.parse(at)))row.update_time=at;
      return row;
    });
    return {items,...(Number.isSafeInteger(data.total)&&data.total>=0?{total:data.total}:{}),
      ...(data.has_missing_conversations===true?{has_missing_conversations:true}:{})};
  }
  if(!data.mapping||typeof data.mapping!=='object'||Array.isArray(data.mapping))failure('invalid_response');
  const mapping={};let index=0;
  const model=value=>typeof value==='string'&&/^(?:gpt-[a-z0-9][a-z0-9._-]{0,95}|o[1-9][a-z0-9._-]{0,95}|chatgpt-[a-z0-9][a-z0-9._-]{0,95}|auto)$/i.test(value)?value:'unknown';
  for(const node of Object.values(data.mapping)){
    const source=node?.message;if(source?.author?.role!=='assistant')continue;
    const message={author:{role:'assistant'},end_turn:source.end_turn===true},metadata=source.metadata;
    if(typeof source.id==='string'&&source.id&&source.id.length<=256)message.id=source.id;
    // A non-null invalid create_time must still block update_time fallback.
    for(const field of ['create_time','update_time'])if(source[field]!==undefined&&source[field]!==null)
      message[field]=typeof source[field]==='number'&&Number.isFinite(source[field])?source[field]:false;
    if(source.recipient!==undefined&&source.recipient!==null)message.recipient=source.recipient==='all'?'all':'other';
    if(source.channel)message.channel=['final','commentary','analysis'].includes(source.channel)?source.channel:'other';
    if(source.hidden===true)message.hidden=true;
    const selected={};
    if(metadata?.resolved_model_slug)selected.resolved_model_slug=model(metadata.resolved_model_slug);
    if(metadata?.model_slug)selected.model_slug=model(metadata.model_slug);
    if(metadata?.is_visually_hidden_from_conversation===true)selected.is_visually_hidden_from_conversation=true;
    if(metadata?.is_hidden===true)selected.is_hidden=true;
    if(Object.keys(selected).length)message.metadata=selected;
    mapping['n'+index++]={message};
  }
  return {mapping};
}
async function rendererRead(input,project){
  const state=globalThis[Symbol.for('clw.chat-history.reads.v1')];
  const same=()=>location.href===input.url&&location.origin==='https://chatgpt.com'&&state?.document===document&&state?.token===input.documentToken;
  if(!same())return {error:'account_context_changed'};
  if(!Number.isFinite(input.deadlineAt)||Date.now()>=input.deadlineAt)return {error:'timeout'};
  if(state.cancelled.has(input.id)){clearTimeout(state.cancelled.get(input.id));state.cancelled.delete(input.id);return {error:'timeout'};}
  const controller=new AbortController();let timer,reader,settle;
  const done=new Promise(resolve=>{settle=resolve;});state.requests.set(input.id,{controller,done});
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({error:'timeout'});},Math.max(0,input.deadlineAt-Date.now()));});
  const work=(async()=>{
    try{
      // A queued page evaluation may start long after main cancelled it and
      // the short cancellation tombstone expired. Its original deadline never
      // extends, so this late evaluation cannot issue a new GET.
      if(Date.now()>=input.deadlineAt)return {error:'timeout'};
      const response=await fetch(input.route,{method:'GET',credentials:'include',redirect:'error',cache:'no-store',
        headers:{Accept:'application/json',...(input.authorization?{Authorization:input.authorization}:{})},signal:controller.signal});
      if(!same())return {error:'account_context_changed'};
      if(response.redirected||(response.url&&new URL(response.url).origin!=='https://chatgpt.com')||response.status>=300&&response.status<400)return {error:'redirect_refused'};
      const type=response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase(),retry=response.headers.get('retry-after');
      const types=['application/json','application/problem+json','text/html','text/plain','application/octet-stream'];
      const headers={...(type?{'content-type':types.includes(type)?type:'other'}:{}),
        ...(typeof retry==='string'&&(/^[0-9]{1,7}$/.test(retry)||/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry))?{'retry-after':retry}:{}),
        ...(response.headers.get('cf-mitigated')?.toLowerCase()==='challenge'?{'cf-mitigated':'challenge'}:{})};
      if(response.status<200||response.status>=300)return {id:input.id,status:response.status,headers,payload:null};
      const length=Number(response.headers.get('content-length'));
      if(Number.isFinite(length)&&length>input.maxBytes)return {error:'response_too_large'};
      reader=response.body?.getReader?.();if(!reader)return {error:'invalid_response'};
      let size=0;const chunks=[];
      for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
        if(size>input.maxBytes)return {error:'response_too_large'};chunks.push(part.value);}
      if(!same())return {error:'account_context_changed'};
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      let data;try{data=JSON.parse(new TextDecoder().decode(bytes));}catch{return {error:'invalid_response'};}
      let projected;try{projected=project(data,input.stage);}catch(e){return {error:e.message==='invalid_auth'?'invalid_auth':'invalid_response'};}
      const payload=JSON.stringify(projected);
      if(new TextEncoder().encode(payload).byteLength>input.maxProjected)return {error:'response_too_large'};
      return {id:input.id,status:response.status,headers,payload};
    }catch{return {error:controller.signal.aborted?'timeout':'request_failed'};}
  })();
  try{return await Promise.race([work,deadline]);}
  finally{clearTimeout(timer);controller.abort();state.requests.delete(input.id);settle();
    // Do not let a misbehaving body.cancel promise prolong a read or its owner.
    try{const cancelled=reader?.cancel();cancelled?.catch?.(()=>{});}catch{}
    try{reader?.releaseLock();}catch{}}
}
async function rendererCancel(input){
  const state=globalThis[Symbol.for('clw.chat-history.reads.v1')];
  if(location.href!==input.url||state?.document!==document||state?.token!==input.documentToken)return {state:'owner_changed'};
  const original=state.requests.get(input.id);
  if(original){original.controller.abort();await original.done;return {state:'cancelled'};}
  // A cancellation can arrive before the original page evaluation starts.
  // This tombstone only prevents that original read.
  if(!state.cancelled.has(input.id))state.cancelled.set(input.id,setTimeout(()=>state.cancelled.delete(input.id),60000));
  return {state:'not_started'};
}

function createPageHistoryFetch({page,session,assertCurrent=()=>{},evaluate=evaluateOwnedPage}={}){
  let view,wc,url,account,id,generation;
  try{view=page?.view;wc=view?.webContents;url=pageUrl(wc?.getURL?.());account=page?.account||'B';id=page?.id;generation=page?.documentGeneration;}
  catch{fail('account_context_changed');}
  if(!page||!view||!wc||!session||wc.session!==session||!url||!['A','B'].includes(account)||
     typeof id!=='string'||!id||!Number.isInteger(generation)||generation<0||typeof assertCurrent!=='function'||typeof evaluate!=='function')fail('account_context_changed');
  let disposed=false,active=null,binding=null,documentToken=null;
  const intrinsic=()=>{try{return !page.closed&&page.id===id&&page.view===view&&view.webContents===wc&&!wc.isDestroyed?.()&&
    (page.account||'B')===account&&page.documentGeneration===generation&&wc.session===session&&wc.getURL?.()===url;}catch{return false;}};
  function release(op){if(active===op)active=null;if(READ_LANES.get(wc)===op)READ_LANES.delete(wc);}
  async function current(){
    if(disposed||!intrinsic())fail('account_context_changed');
    try{if(await assertCurrent()===false)fail('account_context_changed');}catch{fail('account_context_changed');}
    if(disposed||!intrinsic())fail('account_context_changed');
  }
  async function safeEvaluate(expression){try{return await evaluate(wc,expression);}catch{fail('request_failed');}}
  function bound(){
    return binding??=(async()=>{await current();const result=await safeEvaluate(`(${bindDocument.toString()})(${JSON.stringify(url)},${JSON.stringify(randomUUID())})`);
      await current();if(result?.error)fail(result.error);
      if(typeof result?.documentToken!=='string'||!/^[a-f0-9-]{36}$/.test(result.documentToken))fail('invalid_response');
      return documentToken=result.documentToken;})();
  }
  function cancelOriginal(op){
    if(op.cancelRequested||!documentToken||!intrinsic())return;op.cancelRequested=true;
    const args={url,documentToken,id:op.id};
    // Its only effect is aborting the original read. A replacement page is
    // never evaluated, and cancellation never uses a new account/session.
    const cancel=safeEvaluate(`(${rendererCancel.toString()})(${JSON.stringify(args)})`);
    void cancel.then(result=>{if(result?.state==='cancelled')release(op);},()=>{});
  }
  const listeners=[];
  function dispose(){
    if(disposed)return;disposed=true;
    for(const [event,fn] of listeners)wc.removeListener?.(event,fn);listeners.length=0;
    if(active)active.abort('account_context_changed');
  }
  const navigation=(details,_url,inPlace,isMainFrame)=>{
    if(details?.isMainFrame===false||isMainFrame===false)return;
    const target=typeof details?.url==='string'?details.url:typeof _url==='string'?_url:null;
    if((details?.isSameDocument===true||inPlace===true)&&intrinsic()&&(target===null||target===url))return;
    dispose();
  };
  for(const [event,fn] of [['did-start-navigation',navigation],['destroyed',dispose],['render-process-gone',dispose]]){
    wc.on?.(event,fn);listeners.push([event,fn]);
  }
  async function fetchSession(value,options={}){
    const request=requestRoute(value,options);await current();if(request.signal?.aborted)fail('timeout');
    // No hidden queue: an unconfirmed cancelled page evaluation retains its
    // lane until its original completion or explicit abort acknowledgement.
    const prior=READ_LANES.get(wc);
    if(active||prior&&prior.view===view&&prior.generation===generation&&prior.session===session)fail('request_failed');
    const op={id:randomUUID(),cancelRequested:false,aborted:false,view,generation,session,deadlineAt:Date.now()+REQUEST_MS};active=op;READ_LANES.set(wc,op);
    let timer,abortListener,rejectAbort;
    const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
    op.abort=error=>{if(op.aborted)return;op.aborted=true;cancelOriginal(op);rejectAbort(new HistoryPageError(error));};
    timer=setTimeout(()=>op.abort('timeout'),REQUEST_MS);
    if(request.signal){abortListener=()=>op.abort('timeout');request.signal.addEventListener('abort',abortListener,{once:true});
      if(request.signal.aborted)op.abort('timeout');}
    const work=(async()=>{
      await bound();await current();if(op.aborted)fail('timeout');
      const input={...request,signal:undefined,id:op.id,url,documentToken,maxBytes:MAX_BYTES,maxProjected:MAX_PROJECTED,deadlineAt:op.deadlineAt};
      const result=await safeEvaluate(`(${rendererRead.toString()})(${JSON.stringify(input)},${projectPayload.toString()})`);
      await current();if(op.aborted)fail('timeout');if(result?.error)fail(result.error);
      if(!result||result.id!==op.id||!Number.isInteger(result.status)||result.status<200||result.status>599||
         !result.headers||typeof result.headers!=='object'||Array.isArray(result.headers))fail('invalid_response');
      const headers={};for(const name of Object.keys(result.headers)){
        const value=result.headers[name];
        if(name==='content-type'&&TYPES.has(value)||name==='cf-mitigated'&&value==='challenge'||
          name==='retry-after'&&typeof value==='string'&&(/^[0-9]{1,7}$/.test(value)||/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)))headers[name]=value;
        else fail('invalid_response');
      }
      const success=result.status<300;
      if(success&&(typeof result.payload!=='string'||Buffer.byteLength(result.payload,'utf8')>MAX_PROJECTED))fail('response_too_large');
      if(!success&&result.payload!==null)fail('invalid_response');
      try{return new Response(success?result.payload:null,{status:result.status,headers});}catch{fail('invalid_response');}
    })();
    void work.finally(()=>release(op)).catch(()=>{});
    try{return await Promise.race([work,aborted]);}
    finally{clearTimeout(timer);request.signal?.removeEventListener('abort',abortListener);}
  }
  fetchSession.dispose=dispose;return fetchSession;
}
module.exports={createPageHistoryFetch};
