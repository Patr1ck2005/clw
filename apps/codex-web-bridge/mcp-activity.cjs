'use strict';
// Read-only, bounded projection of the shared union's metadata journal.
// The journal has no exact trace/turn binding. Never attach these events to a
// Codex turn. Arguments and full results require an original receipt source;
// they are not present in this metadata journal.
const fs=require('node:fs'),path=require('node:path');
const EVENTS=new Set(['mcp_call_started','mcp_call_finished','mcp_transport_interrupted',
  'mcp_client_disconnected','mcp_response_sent','native_call','native_result',
  'native_error','native_duplicate_rejected','union_error','mcp_call_details']);
const CALL=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL=/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;
const HASH=/^[a-f0-9]{64}$/;
const TIME=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const RESULT=/^result_[a-f0-9]{32}$/;

function project(row){
  if(!row||typeof row!=='object'||Array.isArray(row)||!EVENTS.has(row.event)||
     !CALL.test(row.callId||'')||!TOOL.test(row.tool||'')||
     !['native','webcodex'].includes(row.route)||!TIME.test(row.at||'')||
     !Number.isFinite(Date.parse(row.at)))return null;
  const result={id:row.callId+':'+row.event,source:'mcp_union_metadata',
    at:row.at,callId:row.callId,event:row.event,tool:row.tool,route:row.route,
    attribution:HASH.test(row.sessionHash||'')?'session_argument_hash':'unattributed'};
  if(result.attribution==='session_argument_hash')result.sessionHash=row.sessionHash;
  if(row.event==='mcp_call_details'){
    if(!['arguments','response'].includes(row.part))return null;
    result.id+=':'+row.part;result.part=row.part;
    if(RESULT.test(row.resultId||''))result.resultId=row.resultId;
    if(typeof row.complete==='boolean')result.complete=row.complete;
    if(/^call_details_[a-z_]{1,64}$/.test(row.code||''))result.code=row.code;
  }
  if(Number.isInteger(row.httpStatus)&&row.httpStatus>=100&&row.httpStatus<=599)result.httpStatus=row.httpStatus;
  if(Number.isInteger(row.durationMs)&&row.durationMs>=0&&row.durationMs<=7*86400000)result.durationMs=row.durationMs;
  if(Number.isInteger(row.itemFailureCount)&&row.itemFailureCount>=0&&row.itemFailureCount<=1000000)result.itemFailureCount=row.itemFailureCount;
  for(const key of ['bodyInspected','rpcError','isError','applicationSuccess'])
    if(typeof row[key]==='boolean')result[key]=row[key];
  return result;
}

function stamp(file){
  try{
    const stat=fs.lstatSync(file,{bigint:true});
    if(!stat.isFile())return null;
    return {size:Number(stat.size),key:[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':')};
  }catch{return null;}
}

function tail(file,size,maxBytes){
  const length=Math.min(size,maxBytes);
  if(!length)return [];
  const fd=fs.openSync(file,'r');
  try{
    const data=Buffer.alloc(length),actual=fs.readSync(fd,data,0,length,size-length);
    let raw=data.subarray(0,actual).toString('utf8');
    if(size>length){const first=raw.indexOf('\n');raw=first<0?'':raw.slice(first+1);}
    const last=raw.lastIndexOf('\n');
    return last<0?[]:raw.slice(0,last).split('\n');
  }finally{fs.closeSync(fd);}
}

function callDetails(events,resultHome){
  const saved=new Map();
  for(const row of events){
    if(row.event!=='mcp_call_details')continue;
    const details=saved.get(row.callId)||{};
    const available=RESULT.test(row.resultId||'')&&fs.existsSync(path.join(resultHome,row.resultId,'meta.json'));
    details[row.part]={available,...(row.resultId?{result_id:row.resultId}:{}),
      ...(typeof row.complete==='boolean'?{complete:row.complete}:{}),
      ...(!available?{reason:row.code||(row.resultId?'original_call_details_expired':'original_call_details_not_recorded')}: {})};
    saved.set(row.callId,details);
  }
  const absent=()=>({available:false,reason:'original_call_details_not_recorded'});
  return events.map(row=>{
    const parts=saved.get(row.callId)||{};
    return {...row,details:{available:parts.arguments?.available===true||parts.response?.available===true,
      arguments:parts.arguments||absent(),response:parts.response||absent()}};
  });
}
function createActivityProjection(home,{maxEvents=160,maxReadBytes=65536,resultHome=path.join(home,'result-cache')}={}){
  if(!Number.isInteger(maxEvents)||maxEvents<1||maxEvents>500||
     !Number.isInteger(maxReadBytes)||maxReadBytes<1024||maxReadBytes>1024*1024)
    throw Error('mcp_activity_bounds_invalid');
  const file=path.join(home,'mcp-activity.jsonl');
  let signature=null,cached=null;
  return ()=>{
    const files=[file+'.previous',file],stats=files.map(stamp);
    const next=stats.map(stat=>stat?.key||'-').join('|');
    if(next===signature&&cached)return cached;
    const rows=[],seen=new Set();let windowTruncated=false,readFailed=false;
    for(let i=0;i<files.length;i++){
      const stat=stats[i];if(!stat)continue;
      if(stat.size>maxReadBytes)windowTruncated=true;
      try{
        for(const line of tail(files[i],stat.size,maxReadBytes)){
          let value;try{value=JSON.parse(line);}catch{continue;}
          const event=project(value);
          if(!event||seen.has(event.id))continue;
          seen.add(event.id);rows.push(event);
        }
      }catch{windowTruncated=true;readFailed=true;}
    }
    if(rows.length>maxEvents)windowTruncated=true;
    cached={source:'mcp_union_metadata',turnAttribution:'unavailable',
      sessionAttribution:'request_argument_hash_unverified',history:'bounded_rotating_journal',
      windowTruncated,events:callDetails(rows.slice(-maxEvents),resultHome)};
    signature=readFailed?null:next;
    return cached;
  };
}
module.exports={createActivityProjection,project};
