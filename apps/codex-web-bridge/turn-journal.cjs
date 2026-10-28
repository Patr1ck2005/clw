'use strict';
const fs=require('node:fs'),path=require('node:path');
const {evaluate}=require('../web-host/page-input.cjs');
const {writePrivateFileAtomic}=require('./upstream/launcher/electron/atomic-file.cjs');
const {sourceForDisplay,readSource}=require('./turn-source.cjs');
const {readReview}=require('./turn-review.cjs');
const {nativeTurnStateForDisplay}=require('./native-terminal-receipt.cjs');
const chatUrl=raw=>/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(raw||'')?raw:null;
const validTrace=value=>typeof value==='string'&&/^[a-f0-9]{12}$/.test(value);
const statKey=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
function fileRevision(file){try{const stat=fs.statSync(file);return stat.isFile()?statKey(stat):null;}catch{return null;}}
const taskKey=row=>row.source?.threadId||'unmapped:'+row.traceId;
const sourceIdentity=source=>JSON.stringify([source?.traceId,source?.threadId,source?.turnId,source?.model,source?.account]);
function pageRecords(rows,request={}){
 const {task_key,position='latest',before_trace,after_trace,around_trace,limit=40}=request;
 if(typeof task_key!=='string'||!task_key||task_key.length>128||
   task_key.startsWith('unmapped:')&&!validTrace(task_key.slice(9)))throw Error('native_record_task_invalid');
 if(!['latest','first'].includes(position)||!Number.isInteger(limit)||limit<1||limit>100)throw Error('native_record_page_invalid');
 const cursors=[before_trace,after_trace,around_trace].filter(value=>value!==undefined);
 if(cursors.length>1||cursors.some(value=>!validTrace(value)))throw Error('native_record_trace_invalid');
 const ordered=rows.filter(row=>validTrace(row.traceId)&&taskKey(row)===task_key)
   .sort((a,b)=>String(a.startedAt||'').localeCompare(String(b.startedAt||''))||a.traceId.localeCompare(b.traceId));
 let index=-1;
 if(cursors.length){index=ordered.findIndex(row=>row.traceId===cursors[0]);if(index<0)throw Error('native_record_cursor_not_found');}
 const total=ordered.length;
 let start=position==='first'?0:Math.max(0,total-limit),end=Math.min(total,start+limit);
 if(before_trace!==undefined){end=index;start=Math.max(0,end-limit);}
 if(after_trace!==undefined){start=index+1;end=Math.min(total,start+limit);}
 if(around_trace!==undefined){start=Math.max(0,Math.min(index-Math.floor(limit/2),total-limit));end=Math.min(total,start+limit);}
 const selected=ordered.slice(start,end);
 return {task_key,rows:selected,has_before:start>0,has_after:end<total,total,
   first_trace:selected[0]?.traceId||null,last_trace:selected.at(-1)?.traceId||null,
   oldest_trace:ordered[0]?.traceId||null,newest_trace:ordered.at(-1)?.traceId||null};
}
function submissionForDisplay(home,row){
 if(!['running','needs_reconciliation'].includes(row.status)||row.submission==='confirmed'||!(/^[a-f0-9]{12}$/).test(row.traceId||''))return row;
 try{
  const dir=path.join(home,'diagnostics/browser-turns');
  const matches=fs.readdirSync(dir).filter(n=>n.startsWith(row.traceId+'-'));
  if(matches.length!==1)return row;
  const folder=path.join(dir,matches[0]);
  for(const name of fs.readdirSync(folder).filter(n=>/^\d+-(submission-accepted|send-accepted)\.json$/.test(n))){
   const file=path.join(folder,name);if(fs.statSync(file).size>65536)continue;
   const proof=JSON.parse(fs.readFileSync(file,'utf8'));
   if(proof.traceId===row.traceId&&['submission-accepted','send-accepted'].includes(proof.checkpoint))return {...row,submission:'confirmed'};
  }
 }catch{}
 return row;
}
function failureForDisplay(home,row){
 if(row.status!=='failed'||!(/^[a-f0-9]{12}$/).test(row.traceId||''))return null;
 if(row.publicState?.loginRequired===true||row.publicState?.usageLimited===true)return {kind:row.publicState.loginRequired?'login_required':'usage_limit',source:'public_failure_snapshot',submissionObserved:row.submission==='confirmed',beforeSend:false};
 const directory=path.join(home,'diagnostics/browser-turns');
 try{
  for(const name of fs.readdirSync(directory).filter(n=>n.startsWith(row.traceId+'-'))){
   const folder=path.join(directory,name);
   if(!fs.statSync(folder).isDirectory())continue;
   for(const file of fs.readdirSync(folder).filter(n=>/^\d+-turn-failed\.json$/.test(n))){
    const source=path.join(folder,file);if(fs.statSync(source).size>65536)continue;
    const evidence=JSON.parse(fs.readFileSync(source,'utf8'));
    if(evidence.traceId!==row.traceId||evidence.checkpoint!=='turn-failed')continue;
    if(/^page\.goto: Timeout \d+ms exceeded\./.test(evidence.error||''))return {
     kind:'page_navigation_timeout',source,submissionObserved:row.submission==='confirmed',
     beforeSend:row.submission==='not-observed'};
   }
  }
 }catch{}
 return null;
}
function createTurnDisplay(home,{sessionsRoot}={}){
 const sourceCache=new Map();
 const displaySource=traceId=>{
   if(!validTrace(traceId))return null;
   const key=[fileRevision(path.join(home,'turn-sources',traceId+'.json')),fileRevision(path.join(home,'runtime','thread-environments.json'))].join('|');
   if(sourceCache.get(traceId)?.key===key)return sourceCache.get(traceId).source;
   const source=sourceForDisplay(home,traceId);
   if(sourceCache.size>=2048)sourceCache.delete(sourceCache.keys().next().value);
   sourceCache.set(traceId,{key,source});return source;
 };
 const display=(row,{includeText=false,nativeStateForSource=nativeTurnStateForDisplay,sourceForTrace=displaySource}={})=>{
   const source=sourceForTrace(row.traceId),nativeState=source?nativeStateForSource({...source,...(sessionsRoot?{sessionsRoot}:{})}):{state:'unavailable'};
   const status=nativeState.state==='failed'?'failed':nativeState.state==='aborted'?'aborted':row.status;
   const review=readReview(home,row.traceId,{includeText}),bodyFile=path.join(home,'runtime','native-final-replay',row.traceId+'.json'),bodyStat=validTrace(row.traceId)?fileRevision(bodyFile):null;
   const observed=submissionForDisplay(home,row),metadata=includeText?observed:Object.fromEntries(['traceId','tabId','startedAt','endedAt','interruptedAt','status','account','url','submission','publicState','observationUnavailable','reason','automaticReplay']
     .filter(key=>Object.hasOwn(observed,key)).map(key=>[key,observed[key]]));
   return {...metadata,status,browserStatus:row.status,nativeState,
     failure:failureForDisplay(home,row),source,review,
     bodyAvailable:!!(review?.finalSha256&&bodyStat),
     bodyRevision:review?[source?.threadId,source?.turnId,review.finalSha256,bodyStat].join(':'):null};
 };
 return {display,displaySource};
}
function installTurnJournal(host,home,{account,displayIndexOptions={}}={}){
 const directory=path.join(home,'turns');fs.mkdirSync(directory,{recursive:true});
 const records=new Map(),revisions=new Map();let displayIndex=null;
 const {display,displaySource}=createTurnDisplay(home);
 function refreshRecord(traceId,{strict=false}={}){
  const file=path.join(directory,traceId+'.json'),revision=fileRevision(file);
  if(revisions.get(traceId)===revision)return records.get(traceId);
  try{
   if(!revision||fs.statSync(file).size>1024*1024)throw Error('turn_record_unavailable');
   const row=JSON.parse(fs.readFileSync(file,'utf8'));
   if(row.traceId!==traceId||fileRevision(file)!==revision)throw Error('turn_record_changed');
   records.set(traceId,row);revisions.set(traceId,revision);return row;
  }catch{records.delete(traceId);revisions.delete(traceId);if(strict)throw Error('native_record_unavailable');return null;}
 }
 function refresh({strict=false}={}){
  const seen=new Set();
  for(const name of fs.readdirSync(directory).filter(n=>/^[A-Za-z0-9_-]+\.json$/.test(n))){
   const traceId=name.slice(0,-5);seen.add(traceId);refreshRecord(traceId,{strict});
  }
  for(const traceId of records.keys())if(!seen.has(traceId)){records.delete(traceId);revisions.delete(traceId);}
 }
 refresh();
 const save=row=>{writePrivateFileAtomic(path.join(directory,row.traceId+'.json'),JSON.stringify(row)+'\n');records.set(row.traceId,row);revisions.set(row.traceId,fileRevision(path.join(directory,row.traceId+'.json')));displayIndex?.upsert(row);};
 // The new BrowserHost owns none of the previous process's live tabs. A stale
 // 'running' record is not evidence of ongoing execution or an unsent prompt.
 const interrupt=(row,reason)=>save({...row,status:'needs_reconciliation',interruptedAt:new Date().toISOString(),reason,automaticReplay:false});
 for(const row of records.values())if(row.status==='running')interrupt(row,'browser_owner_restarted');
 const watched=new WeakSet(),begin=host.beginTurn.bind(host);
 host.beginTurn=async function(...args){
  const result=await begin(...args),tab=host.turnTabs.get(result.tabId);
  if(!tab)return result;
  const wc=tab.view.webContents;
  const row=records.get(tab.traceId)||{traceId:tab.traceId,tabId:tab.id,startedAt:new Date().toISOString(),status:'running',url:null,submission:'not-observed'};
  row.url=chatUrl(wc.getURL())||row.url;if(['A','B'].includes(account))row.account=account;save(row);
  if(!watched.has(wc)){
   watched.add(wc);
   const captureUrl=()=>{const current=records.get(tab.traceId),url=chatUrl(wc.getURL());if(current?.status==='running'&&url&&url!==current.url){current.url=url;save(current);}};
   wc.on('did-navigate',captureUrl);wc.on('did-navigate-in-page',captureUrl);
   const pageGone=()=>{const current=records.get(tab.traceId);if(current?.status==='running')interrupt(current,'browser_page_closed');};
   wc.on('destroyed',pageGone);wc.on('render-process-gone',pageGone);
  }
  return result;
 };
 const end=host.endTurn.bind(host);
 host.endTurn=async function(traceId,helperPid,status,...rest){
  const tab=[...host.turnTabs.values()].find(t=>t.traceId===traceId);
  if(tab?.helperPid!==helperPid)return end(traceId,helperPid,status,...rest);
  const row=records.get(traceId)||{traceId,tabId:tab.id,startedAt:new Date().toISOString()};
  row.url=chatUrl(tab.view.webContents.getURL())||row.url;row.status=status;row.endedAt=new Date().toISOString();
  const diagnostics=path.join(home,'diagnostics/browser-turns');
  const dirs=fs.existsSync(diagnostics)?fs.readdirSync(diagnostics).filter(n=>n.startsWith(traceId+'-')):[];
  const checkpoints=dirs.flatMap(dir=>fs.readdirSync(path.join(diagnostics,dir)));
  row.submission=checkpoints.some(n=>n.endsWith('-submission-accepted.json')||n.endsWith('-send-accepted.json'))?'confirmed':checkpoints.some(n=>n.endsWith('-send-ready.json'))?'unconfirmed':'not-observed';
  if(status==='failed'){
   let timer;
   try{row.publicState=await Promise.race([evaluate(tab.view.webContents,`(()=>{const alerts=[...document.querySelectorAll('[role="alert"],[role="dialog"],[role="alertdialog"]')].filter(e=>e.getBoundingClientRect().height>0&&!e.closest('[data-message-author-role],[data-conversation-role],[data-turn-key],[data-content-search-turn-key]')).map(e=>e.innerText.slice(0,500)).slice(-5);return {alerts,loginRequired:location.origin==='https://chatgpt.com'&&['/auth/login','/auth/signup'].includes(location.pathname),usageLimited:alerts.some(t=>/(?:reached|hit|exceeded).{0,60}(?:usage|message|Pro).{0,30}limit|用量上限|已(?:达到|用完).{0,30}(?:上限|额度)/i.test(t)),userTurns:document.querySelectorAll('[data-user-message-bubble],[data-message-author-role="user"]').length,assistantTurns:document.querySelectorAll('[data-conversation-role="assistant"],[data-message-author-role="assistant"]').length};})()`),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('observation_timeout')),2000);})]);}catch{row.observationUnavailable=true;}finally{clearTimeout(timer);}
  }
  save(row);return end(traceId,helperPid,status,...rest);
 };
 const list=({strict=false}={})=>{
   refresh({strict});
   // Explicit action reads receive one fresh full-Session batch. Display's
   // incremental cache remains confined to history and normal status reads.
   const batch=strict?require('./native-action-receipt.cjs').createNativeActionReadBatch({
     ...(displayIndexOptions.sessionsRoot?{sessionsRoot:displayIndexOptions.sessionsRoot}:{})}):null;
   const sourceForAction=traceId=>{
     const file=path.join(home,'turn-sources',traceId+'.json');let before;
     try{const stat=fs.statSync(file);if(!stat.isFile())throw Error('native_source_unavailable');before=statKey(stat);}
     catch(error){if(error.code==='ENOENT')return null;throw Error('native_source_unavailable');}
     const source=readSource(home,traceId);
     if(!source||fileRevision(file)!==before)throw Error('native_source_unavailable');
     return source;
   };
   return [...records.values()].sort((a,b)=>String(b.startedAt||'').localeCompare(String(a.startedAt||''))||String(b.traceId).localeCompare(String(a.traceId)))
     .map(row=>display(row,batch?{nativeStateForSource:source=>batch.read(source),sourceForTrace:sourceForAction}:undefined));
 };
 const queryFor=request=>{
  if(typeof request.query!=='undefined'&&(typeof request.query!=='string'||request.query.length>4096||request.query.includes('\0')))throw Error('native_record_query_invalid');
  return (request.query||'').trim().toLowerCase();
 };
 const history=(request={})=>{
  if(queryFor(request))throw Error('native_record_query_requires_index');
  return pageRecords(list(),request);
 };
 const indexPage=result=>{
  const {rows,...page}=result;
  return {...page,items:rows.map(row=>({traceId:row.traceId,at:row.startedAt||null,
   label:({running:'思考／工作',completed:'本轮结束',failed:'本轮失败',aborted:'已停止',needs_reconciliation:'状态待核对'})[row.status]||'状态待核对'}))};
 };
 async function searchIndex(request,query){
  const candidates=list().filter(row=>validTrace(row.traceId)&&taskKey(row)===request.task_key);
  // Reject invalid/cross-task cursors before opening any reply body.
  pageRecords(candidates,request);
  const matches=[];let unavailable=0;
  for(let index=0;index<candidates.length;index++){
   if(index%4===0)await new Promise(resolve=>setImmediate(resolve));
   const traceId=candidates[index].traceId,current=refreshRecord(traceId);
   if(!current)continue;
   let row=display(current);
   if(taskKey(row)!==request.task_key)continue;
   const identity=sourceIdentity(row.source),review=row.review?readReview(home,traceId):null;
   const latest=refreshRecord(traceId);
   if(!latest)continue;
   const source=displaySource(traceId);
   if(sourceIdentity(source)!==identity||taskKey({traceId,source})!==request.task_key)continue;
   row=display(latest);
   if(review&&row.review?.finalSha256!==review.finalSha256)continue;
   const text=review?.finalText;
   if(row.review&&typeof text!=='string')unavailable++;
   if([row.traceId,row.startedAt,row.status,row.source?.workingDirectory,row.source?.threadId,row.source?.model,text]
      .filter(Boolean).join(' ').toLowerCase().includes(query))matches.push(row);
  }
  return indexPage({...pageRecords(matches,request),unavailable_body_count:unavailable,search_scope:'saved_web_replies'});
 }
 const recordIndex=(request={})=>{const query=queryFor(request);return query?searchIndex(request,query):indexPage(history(request));};
 const cachedList=()=>{displayIndex??=require('./turn-journal-cache.cjs').createTurnDisplayIndex(home,records,displayIndexOptions);return displayIndex.snapshot();};
 return {ownerClosed:(reason='browser_owner_closed')=>{try{refresh();for(const row of records.values())if(row.status==='running')interrupt(row,reason);}finally{void displayIndex?.close();}},
   get:traceId=>{refresh();return records.has(traceId)?display(records.get(traceId),{includeText:true}):null;},list,history,recordIndex,index:recordIndex,
   cachedList,refreshDisplay:options=>{cachedList();return displayIndex.refresh(options);},
   closeDisplay:()=>displayIndex?.close(),
   recent:()=>list().filter((row,index)=>index<20||['running','needs_reconciliation'].includes(row.status))};
}
module.exports={installTurnJournal,chatUrl,failureForDisplay,submissionForDisplay,pageRecords,createTurnDisplay};
