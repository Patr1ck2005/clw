// Binary receipt recovery keeps only the file hash and metadata, not image bytes, in tab storage.
import {createJournalClient} from './journal-client.mjs';
export const MAX_UPLOAD=8*1024*1024;
export const channels={chat_image:'chat',codex_image:'work_codex',external_api:'api',manual:'none'};
export const phaseLabel=p=>({draft:'草稿',queued:'待领取',working:'外部工作中',review:'待审阅',reconcile:'需核对原结果',ready:'可导出交付'}[p]||p);
export const stateLabel=p=>({reserved:'已预留 · 尚未发送',in_progress:'外部进行中',outcome_unknown:'结果未知',completed:'外部完成（人工回报）',failed:'外部失败',not_sent:'确认未发送'}[p]||p);
export function availableKeys(batch){return batch.contract.items.filter(i=>!batch.selected[i.key]&&!batch.attempts.some(a=>a.asset_key===i.key&&['reserved','in_progress','outcome_unknown'].includes(a.state))).map(i=>i.key);}
export async function hashBytes(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export function importedContract(raw){
 const c=raw?.contract||raw;
 if(!c||typeof c!=='object'||!Array.isArray(c.items)||!c.items.length||c.items.length>32)throw Error('需求JSON需包含1至32个items；不导入运行或批准记录。');
 const keys=['title','project_id','project_root','task_id','style_brief','executor','provider','model','account_alias','billing_bucket','budget','items'];
 return Object.fromEntries(keys.filter(k=>Object.hasOwn(c,k)).map(k=>[k,structuredClone(c[k])]));
}
export function createAssetClient({fetcher=fetch,storage=sessionStorage,newId=()=>crypto.randomUUID(),onPending=()=>{}}={}){
 const key='clw.pending.asset.upload';let info=null,uploadBusy=false;
 const pendingUpload=()=>{const s=storage.getItem(key);if(!s)return null;if(s.length>20000)throw Error('待确认上传记录超限');return JSON.parse(s);};
 const journal=createJournalClient('./api/assets/',{fetcher,storage,newId,onPending:()=>onPending()});
 const busy=()=>uploadBusy||journal.busy(),pending=()=>({metadata:journal.pending(),upload:pendingUpload()});
 function save(p){if(p)storage.setItem(key,JSON.stringify(p));else storage.removeItem(key);onPending();}
 async function init(){info=await journal.init();onPending();return info;}
 async function exclusive(fn){if(busy())throw Error('原请求正在处理中');uploadBusy=true;try{return await fn();}finally{uploadBusy=false;}}
 async function send(p,file,recovery=false){
  if(info.store_id!==p.store_id)throw Error('素材库已变化，不跨库上传');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),45000);
  try{
   const r=await fetcher('./api/assets/upload',{method:'POST',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/octet-stream','X-CLW-Intent':info.intent,'X-CLW-Metadata':encodeURIComponent(JSON.stringify(p.command))},body:file,signal:abort.signal});
   const value=await r.json();
   if(r.ok&&value.success===true&&value.request_id===p.command.request_id&&value.store_id===p.store_id){save(null);return value;}
   if(!recovery&&r.status>=400&&r.status<500&&![401,403].includes(r.status)&&value.success===false){save(null);throw Object.assign(Error(value.message||'上传被拒绝'),{definite:true});}
   throw Error('未确认');
  }catch(e){if(e.definite)throw e;throw Error('上传结果未知；先查原回执。重传需重新选择完全相同的文件，不新建请求。');}finally{clearTimeout(timer);}
 }
 async function upload(file,identity){return exclusive(async()=>{
  if(journal.pending()||pendingUpload())throw Error('先核对上一条元数据或图片请求');
  if(!file||!Number.isInteger(file.size)||file.size<1||file.size>MAX_UPLOAD)throw Error('图片必须小于等于8 MiB');
  if(!info)await init();const sha=await hashBytes(await file.arrayBuffer());
  const p={store_id:info.store_id,command:{...identity,request_id:newId(),source_sha256:sha,name:file.name}};save(p);return send(p,file);
 });}
 async function recoverUpload(){return exclusive(async()=>{
  const p=pendingUpload();if(!p)return null;await init();if(info.store_id!==p.store_id)throw Error('素材库身份变化，保留原请求');
  const r=await journal.read('receipt',{request_id:p.command.request_id});
  if(r.store_id!==p.store_id)throw Error('回执库身份不符');
  if(!r.found)return null;
  if(r.receipt?.request_id!==p.command.request_id||r.receipt?.store_id!==p.store_id)throw Error('原回执身份不符');save(null);return r.receipt;
 });}
 async function retryUpload(file){return exclusive(async()=>{
  const p=pendingUpload();if(!p)throw Error('没有待核对的上传');if(journal.pending())throw Error('先核对元数据请求');
  await init();if(!file||file.size>MAX_UPLOAD||await hashBytes(await file.arrayBuffer())!==p.command.source_sha256)throw Error('必须重新选择哈希完全相同的原文件');
  return send(p,file,true);
 });}
 async function command(action,data,identity){if(uploadBusy||pendingUpload())throw Error('先核对原图片上传');return journal.command(action,data,identity);}
 async function recoverMetadata(retry=false){if(uploadBusy||pendingUpload())throw Error('先核对原图片上传');return journal.recover(retry);}
 return {init,read:journal.read,command,busy,pending,upload,recoverUpload,retryUpload,recoverMetadata};
}
