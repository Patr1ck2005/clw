'use strict';
const {createHash}=require('node:crypto');
const MAX_CHUNK=64*1024;
const rejected=code=>Object.assign(Error(code),{code,accepted:false});
function requestOptions(payload){
  const offset=payload.byte_offset??0,limit=payload.byte_limit??MAX_CHUNK;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>MAX_CHUNK)
    throw rejected('record_chunk_cursor_invalid');
  if(payload.expected_sha256!==undefined&&!/^[a-f0-9]{64}$/.test(payload.expected_sha256||''))
    throw rejected('record_chunk_revision_invalid');
  if(offset>0&&!payload.expected_sha256)throw rejected('record_chunk_revision_required');
  return {offset,limit};
}
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function createControlBodyReader({maxBytes=64*1024*1024,maxSnapshots=4,ttlMs=120000,now=Date.now}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxSnapshots)||maxSnapshots<1||!Number.isFinite(ttlMs)||ttlMs<1)
    throw Error('record_snapshot_options_invalid');
  const snapshots=new Map();let totalBytes=0,timer=null;
  function remove(key){const value=snapshots.get(key);if(value){totalBytes-=value.bytes.length;snapshots.delete(key);}}
  function expire(){for(const [key,value] of snapshots)if(value.expires<=now())remove(key);}
  function scheduleExpiry(){
    if(timer)clearTimeout(timer);timer=null;
    if(!snapshots.size)return;
    const earliest=Math.min(...[...snapshots.values()].map(value=>value.expires));
    timer=setTimeout(()=>{timer=null;expire();scheduleExpiry();},Math.max(1,earliest-now()));timer.unref?.();
  }
  async function readControlBody(payload,read){
    const {offset,limit}=requestOptions(payload);
    const original={...payload};
    delete original.byte_offset;delete original.byte_limit;delete original.expected_sha256;
    const identity=createHash('sha256').update(JSON.stringify(canonical(original))).digest('hex');
    expire();let snapshot;
    if(payload.expected_sha256){
      snapshot=snapshots.get(identity+':'+payload.expected_sha256);
      if(!snapshot)throw rejected('record_chunk_snapshot_expired_restart_read');
    }else{
      const record=await read(original);
      const bytes=Buffer.from(JSON.stringify(record),'utf8');
      if(bytes.length>maxBytes)throw rejected('record_chunk_snapshot_too_large');
      const sha256=createHash('sha256').update(bytes).digest('hex'),key=identity+':'+sha256;
      remove(key);
      while(snapshots.size>=maxSnapshots||totalBytes+bytes.length>maxBytes)remove(snapshots.keys().next().value);
      snapshot={bytes,sha256,expires:now()+ttlMs};snapshots.set(key,snapshot);totalBytes+=bytes.length;scheduleExpiry();
    }
    const {bytes,sha256}=snapshot;
    if(offset>bytes.length)throw rejected('record_chunk_cursor_invalid');
    const end=Math.min(bytes.length,offset+limit);
    return {encoding:'json-utf8-base64',sha256,byte_length:bytes.length,byte_offset:offset,
      next_offset:end,complete:end===bytes.length,data:bytes.subarray(offset,end).toString('base64')};
  }
  return {readControlBody,stats(){expire();return {snapshots:snapshots.size,bytes:totalBytes};},dispose(){if(timer)clearTimeout(timer);timer=null;snapshots.clear();totalBytes=0;}};
}
const defaultReader=createControlBodyReader();
module.exports={readControlBody:defaultReader.readControlBody,createControlBodyReader,MAX_CHUNK};
