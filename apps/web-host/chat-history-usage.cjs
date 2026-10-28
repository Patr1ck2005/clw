'use strict';
const {createHash}=require('node:crypto');
const ORIGIN='https://chatgpt.com',DAY=86400000,MAX_BYTES=8*1024*1024,REQUEST_MS=10000,DETAIL_MS=60000;
const CODES=new Set(['complete','conversation_limit','conversation_read_failed','http_401','http_403','rate_limited','http_5xx','http_error','timeout','redirect_refused','response_too_large','invalid_response','invalid_auth','account_identity_changed','account_context_changed','request_failed']);
const NETWORK_CODES=new Set(['timeout','request_failed']),HALT_CODES=new Set(['http_401','http_403','rate_limited','account_context_changed']);
const STAGES=new Set(['auth','list','detail','auth_recheck']);
const CONTENT_TYPES=new Set(['application/json','application/problem+json','text/html','text/plain','application/octet-stream','other']);
class UsageError extends Error {constructor(code,diagnostic){super(code);this.code=code;if(diagnostic)this.diagnostic=diagnostic;}}
function accountIdentity(account,id){return createHash('sha256').update(account+'\0'+id).digest('hex');}
function modelSlug(value){return typeof value==='string'&&/^(?:gpt-[a-z0-9][a-z0-9._-]{0,95}|o[1-9][a-z0-9._-]{0,95}|chatgpt-[a-z0-9][a-z0-9._-]{0,95}|auto)$/i.test(value)?value:'unknown';}
function isPro(model){return /(?:^|[-_.])pro(?:$|[-_.])/i.test(model);}
function count(n){return Number.isSafeInteger(n)&&n>=0?n:null;}
function code(e){return CODES.has(e?.code)?e.code:'request_failed';}
function time(value){return typeof value==='number'&&Number.isFinite(value)?value*1000:null;}
function updateTime(value){
  if(typeof value==='number')return time(value);
  return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
}
function statusCode(status){return status===401?'http_401':status===403?'http_403':status===429?'rate_limited':status>=500?'http_5xx':'http_error';}
function diagnostic(value){
  if(!value||!STAGES.has(value.stage)||!CODES.has(value.code))return null;
  const retryAfter=value.retryAfter;
  return {stage:value.stage,code:value.code,status:Number.isInteger(value.status)&&value.status>=100&&value.status<=599?value.status:null,
    elapsedMs:Number.isSafeInteger(value.elapsedMs)&&value.elapsedMs>=0?Math.min(value.elapsedMs,120000):0,
    contentType:CONTENT_TYPES.has(value.contentType)?value.contentType:null,
    retryAfter:Number.isSafeInteger(retryAfter)&&retryAfter>=0&&retryAfter<=604800?retryAfter:
      typeof retryAfter==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(retryAfter)&&Number.isFinite(Date.parse(retryAfter))?retryAfter:null,
    ...(value.browserVerification===true?{browserVerification:true}:{})};
}
function header(response,name){try{return response.headers?.get?.(name)||null;}catch{return null;}}
function responseMetadata(response){
  const type=header(response,'content-type')?.split(';',1)[0].trim().toLowerCase(),retry=header(response,'retry-after');
  const retryDate=typeof retry==='string'&&/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry)?Date.parse(retry):NaN;
  return {status:response.status,contentType:type?(CONTENT_TYPES.has(type)?type:'other'):null,
    retryAfter:typeof retry==='string'&&/^\d{1,7}$/.test(retry)?Number(retry):Number.isFinite(retryDate)?new Date(retryDate).toISOString():null,
    ...(header(response,'cf-mitigated')==='challenge'?{browserVerification:true}:{})};
}

// Reused by the quota store: only numeric summaries, a hashed account owner,
// known source codes, and model/day labels can leave the collector.
function sanitizeUsage(value,expectedAccount){
  if(!value||!['A','B'].includes(value.account)||value.account!==expectedAccount||
     value.source!=='chat_history_reconstruction'||!Number.isFinite(value.checkedAt)||
     !Number.isFinite(value.window?.start)||!Number.isFinite(value.window?.end)||
     value.window.start>value.window.end||!['rolling_7d','custom_start'].includes(value.window.source)||
     !['complete','partial','failed'].includes(value.coverage?.state))throw new UsageError('invalid_response');
  const identity=typeof value.accountIdentity==='string'&&/^[a-f0-9]{64}$/.test(value.accountIdentity)?value.accountIdentity:null;
  const coverage=value.coverage;
  const result={version:1,account:expectedAccount,accountIdentity:identity,source:'chat_history_reconstruction',
    window:{start:value.window.start,end:value.window.end,source:value.window.source},checkedAt:value.checkedAt,
    completedProResponses:count(value.completedProResponses),proConversations:count(value.proConversations),
    allCompletedResponses:count(value.allCompletedResponses),totalConversations:count(value.totalConversations),
    byDayTimezone:'UTC',byDay:[],byModel:[],officialRemaining:null,
    coverage:{state:coverage.state,reason:CODES.has(coverage.reason)?coverage.reason:'request_failed',
      conversationsRead:count(coverage.conversationsRead)||0,conversationsListed:count(coverage.conversationsListed)||0,
      failedConversations:count(coverage.failedConversations)||0,truncated:coverage.truncated===true,
      pagesRead:count(coverage.pagesRead)||0,paginationComplete:coverage.paginationComplete===true}};
  const detail=diagnostic(coverage.diagnostic);if(detail)result.coverage.diagnostic=detail;
  result.byDay=(Array.isArray(value.byDay)?value.byDay:[]).slice(0,92).filter(x=>
    typeof x?.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x.date)&&Number.isFinite(Date.parse(x.date))&&
    count(x.completedProResponses)!==null&&count(x.allCompletedResponses)!==null).map(x=>
    ({date:x.date,completedProResponses:x.completedProResponses,allCompletedResponses:x.allCompletedResponses}));
  result.byModel=(Array.isArray(value.byModel)?value.byModel:[]).slice(0,128).filter(x=>
    count(x?.completedResponses)!==null&&count(x?.completedProResponses)!==null).map(x=>
    ({model:modelSlug(x.model),completedResponses:x.completedResponses,completedProResponses:x.completedProResponses}));
  if(result.coverage.state==='complete'&&(!identity||!result.coverage.paginationComplete||result.coverage.truncated||
     result.coverage.failedConversations||result.coverage.conversationsRead!==result.coverage.conversationsListed||
     [result.completedProResponses,result.proConversations,result.allCompletedResponses,result.totalConversations].some(x=>x===null)))
    throw new UsageError('invalid_response');
  return result;
}

async function collectChatHistoryUsage({account,fetchSession,now=Date.now(),since,assertCurrent=()=>{},onProgress=()=>{},requestIntervalMs=0}={}){
  if(!['A','B'].includes(account)||typeof fetchSession!=='function'||!Number.isSafeInteger(requestIntervalMs)||requestIntervalMs<0||requestIntervalMs>60000)
    throw new UsageError('invalid_response');
  const end=typeof now==='function'?now():now;
  if(!Number.isFinite(end)||end<=0||(since!==undefined&&(!Number.isFinite(since)||since>end||since<end-90*DAY)))
    throw new UsageError('invalid_response');
  const window={start:since===undefined?end-7*DAY:since,end,source:since===undefined?'rolling_7d':'custom_start'};
  let token=null,user=null,owner=null,reason='complete',failureDiagnostic=null,paginationComplete=false,truncated=false,pagesRead=0,read=0,failed=0;
  const listed=new Set(),seenMessages=new Set(),proConversations=new Set(),days=new Map(),models=new Map();
  let allCompletedResponses=0,completedProResponses=0,lastRequestStart=null;
  async function current(){
    try{if(await assertCurrent({account,accountIdentity:owner})===false)throw new Error();}
    catch{throw new UsageError('account_context_changed');}
  }
  function progress(wait){try{onProgress({account,conversationsRead:read,conversationsListed:listed.size,pagesRead,failedConversations:failed,...wait});}catch{}}
  async function wait(ms,why){
    await current();progress({waitUntil:Date.now()+ms,reason:why});
    try{await new Promise(resolve=>setTimeout(resolve,ms));await current();}
    finally{progress({waitUntil:null,reason:null});}
  }
  function retryWait(error){
    if(code(error)!=='rate_limited'||error.diagnostic?.status!==429)return null;
    const value=error.diagnostic.retryAfter;
    const seconds=Number.isSafeInteger(value)?value:typeof value==='string'?Math.ceil((Date.parse(value)-Date.now())/1000):NaN;
    return Number.isFinite(seconds)&&seconds>=1&&seconds<=60?seconds*1000:null;
  }
  async function jsonRequest(route,authorized=false,options={}){
    for(let attempt=0;attempt<3;attempt++){
      await current();
      const pace=lastRequestStart===null?0:Math.max(0,lastRequestStart+requestIntervalMs-Date.now());
      if(pace>0)await wait(Math.min(pace,60000),'request_interval');
      try{return await jsonAttempt(route,authorized,options);}
      catch(e){
        if(attempt===2)throw e;
        const rateDelay=retryWait(e);
        if(rateDelay!==null)await wait(rateDelay,'rate_limited');
        else if(options.stage==='detail'&&NETWORK_CODES.has(code(e)))await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
        else throw e;
      }
    }
  }
  async function jsonAttempt(route,authorized=false,{stage='auth',timeoutMs=REQUEST_MS}={}){
    await current();
    const url=new URL(route,ORIGIN);
    if(url.origin!==ORIGIN)throw new UsageError('redirect_refused');
    const controller=new AbortController(),started=Date.now();let timer,metadata={};
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new UsageError('timeout'));},timeoutMs);});
    const request=(async()=>{
      let response;
      try{lastRequestStart=Date.now();response=await fetchSession(url.href,{method:'GET',redirect:'error',credentials:'include',
          headers:authorized?{Authorization:'Bearer '+token}:undefined,signal:controller.signal});}
      catch(e){
        const local=new Set(['account_context_changed','response_too_large','redirect_refused','invalid_response','invalid_auth']);
        throw controller.signal.aborted?new UsageError('timeout'):new UsageError(local.has(e?.code)?e.code:'request_failed');
      }
      await current();
      if(response?.redirected||(response?.url&&new URL(response.url).origin!==ORIGIN))throw new UsageError('redirect_refused');
      if(!response||typeof response.status!=='number')throw new UsageError('invalid_response');
      metadata=responseMetadata(response);
      if(response.status>=300&&response.status<400)throw new UsageError('redirect_refused');
      if(response.status<200||response.status>=300)throw new UsageError(statusCode(response.status));
      const length=Number(response.headers?.get?.('content-length'));
      if(Number.isFinite(length)&&length>MAX_BYTES)throw new UsageError('response_too_large');
      const reader=response.body?.getReader?.();
      if(!reader)throw new UsageError('invalid_response');
      let size=0;const chunks=[];
      try{
        for(;;){const part=await reader.read();if(part.done)break;
          const bytes=Buffer.from(part.value);size+=bytes.length;
          if(size>MAX_BYTES)throw new UsageError('response_too_large');chunks.push(bytes);
        }
      }catch(e){try{await reader.cancel();}catch{}throw e;}
      finally{try{reader.releaseLock();}catch{}}
      await current();
      try{return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}
      catch{throw new UsageError('invalid_response');}
    })();
    try{return await Promise.race([request,deadline]);}
    catch(e){throw new UsageError(code(e),diagnostic({stage,code:code(e),...metadata,elapsedMs:Math.max(0,Date.now()-started)}));}
    finally{clearTimeout(timer);}
  }
  async function detailRequest(id){
    return jsonRequest('/backend-api/conversation/'+encodeURIComponent(id),true,{stage:'detail',timeoutMs:DETAIL_MS});
  }
  function auth(session){
    const id=session?.user?.id,expires=Date.parse(session?.expires);
    if(typeof id!=='string'||!id||id.length>512||id.includes('\0')||!Number.isFinite(expires)||expires<=end||
       typeof session?.accessToken!=='string'||!session.accessToken||session.accessToken.length>16384)
      throw new UsageError('invalid_auth');
    return {id,token:session.accessToken};
  }
  function addConversation(id,conversation){
    if(!conversation||!conversation.mapping||typeof conversation.mapping!=='object'||Array.isArray(conversation.mapping))
      throw new UsageError('invalid_response');
    let hasPro=false;
    for(const node of Object.values(conversation.mapping)){
      const message=node?.message,metadata=message?.metadata;
      if(!message||message.author?.role!=='assistant'||message.end_turn!==true||
         (message.recipient!==undefined&&message.recipient!==null&&message.recipient!=='all')||
         metadata?.is_visually_hidden_from_conversation===true||metadata?.is_hidden===true||message.hidden===true||
         (message.channel&& !['final','commentary'].includes(message.channel)))continue;
      const at=time(message.create_time??message.update_time);
      if(at===null||at<window.start||at>=window.end||typeof message.id!=='string'||!message.id||message.id.length>256)continue;
      const model=modelSlug(metadata?.resolved_model_slug||metadata?.model_slug),pro=isPro(model);
      if(pro)hasPro=true;
      if(seenMessages.has(message.id))continue;
      seenMessages.add(message.id);allCompletedResponses++;if(pro)completedProResponses++;
      const date=new Date(at).toISOString().slice(0,10),day=days.get(date)||{date,completedProResponses:0,allCompletedResponses:0};
      day.allCompletedResponses++;if(pro)day.completedProResponses++;days.set(date,day);
      const group=models.get(model)||{model,completedResponses:0,completedProResponses:0};
      group.completedResponses++;if(pro)group.completedProResponses++;models.set(model,group);
    }
    if(hasPro)proConversations.add(id);
  }
  let identityChanged=false;
  try{
    const session=auth(await jsonRequest('/api/auth/session'));
    user=session.id;token=session.token;owner=accountIdentity(account,user);await current();
    const seenConversations=new Set();let priorUpdate=Infinity,unknownUpdate=false;
    for(let page=0;page<5;page++){
      let data;
      try{data=await jsonRequest('/backend-api/conversations?offset='+(page*100)+'&limit=100&order=updated',true,{stage:'list'});}
      catch(e){reason=code(e);failureDiagnostic=e.diagnostic;break;}
      if(!Array.isArray(data?.items)||data.items.length>100){reason='invalid_response';break;}
      pagesRead++;
      let windowBoundary=false;
      for(const item of data.items){
        if(typeof item?.id!=='string'||!/^[a-z0-9_-]{1,128}$/i.test(item.id)){reason='invalid_response';break;}
        seenConversations.add(item.id);
        const updated=updateTime(item.update_time);
        if(updated===null){unknownUpdate=true;listed.add(item.id);continue;}
        if(updated>priorUpdate){reason='invalid_response';break;}
        priorUpdate=updated;
        if(updated>=window.start)listed.add(item.id);else windowBoundary=true;
      }
      progress();if(reason!=='complete')break;
      const total=Number.isSafeInteger(data.total)&&data.total>=0?data.total:null;
      if(data.has_missing_conversations===true){reason='invalid_response';break;}
      // order=updated and the checked descending timestamps bound this window.
      // Missing timestamps cannot establish that bound; scan conservatively.
      if(windowBoundary&&!unknownUpdate){paginationComplete=true;break;}
      if(data.items.length<100||(total!==null&&(page+1)*100>=total)){
        if(total!==null&&seenConversations.size<total){reason='invalid_response';break;}
        paginationComplete=true;break;
      }
      if(page===4){truncated=true;reason='conversation_limit';}
    }
    let consecutiveNetworkFailures=0,networkStopped=false;
    if(!HALT_CODES.has(reason)&&!NETWORK_CODES.has(reason))for(const id of listed){
      try{addConversation(id,await detailRequest(id));read++;consecutiveNetworkFailures=0;}
      catch(e){failed++;const failure=code(e);
        consecutiveNetworkFailures=NETWORK_CODES.has(failure)?consecutiveNetworkFailures+1:0;
        if(reason==='complete'){reason=failure;failureDiagnostic=e.diagnostic;}
        if(HALT_CODES.has(failure)||consecutiveNetworkFailures>=3){
          reason=failure;failureDiagnostic=e.diagnostic;networkStopped=consecutiveNetworkFailures>=3;progress();break;}}
      progress();
    }
    if(!HALT_CODES.has(reason)&&!networkStopped&&(!NETWORK_CODES.has(reason)||read>0)){
      const last=auth(await jsonRequest('/api/auth/session',false,{stage:'auth_recheck'}));
      if(last.id!==user){owner=accountIdentity(account,last.id);identityChanged=true;throw new UsageError('account_identity_changed');}
      await current();
    }
  }catch(e){reason=code(e);failureDiagnostic=e.diagnostic;if(reason==='account_identity_changed'||reason==='account_context_changed')identityChanged=true;}
  finally{token=null;user=null;}
  if(reason==='account_context_changed')identityChanged=true;
  if(identityChanged){allCompletedResponses=0;completedProResponses=0;proConversations.clear();days.clear();models.clear();}
  const complete=reason==='complete'&&paginationComplete&&failed===0;
  const state=complete?'complete':identityChanged||read===0?'failed':'partial';
  return sanitizeUsage({version:1,account,accountIdentity:owner,source:'chat_history_reconstruction',window,checkedAt:end,
    completedProResponses,proConversations:proConversations.size,allCompletedResponses,totalConversations:read,
    byDay:[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)),byModel:[...models.values()].sort((a,b)=>a.model.localeCompare(b.model)),
    coverage:{state,reason,conversationsRead:read,conversationsListed:listed.size,failedConversations:failed,
      truncated,pagesRead,paginationComplete,diagnostic:failureDiagnostic},officialRemaining:null},account);
}
module.exports={collectChatHistoryUsage,sanitizeUsage};
