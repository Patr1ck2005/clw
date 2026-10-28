// Same-ID recovery for local records. No automatic POST and no execution triggered by reload.
export function createJournalClient(base,{fetcher=fetch,storage=sessionStorage,newId=()=>crypto.randomUUID(),onPending=()=>{}}={}){
  if(!['./api/specialists/','./api/usage/','./api/accounts/','./api/assets/'].includes(base))throw Error('Unknown journal');
  const key='clw.pending.'+base;let info=null,busy=false;
  const pending=()=>{const text=storage.getItem(key);if(!text)return null;if(text.length>2200000)throw Error('待确认记录超限');return JSON.parse(text);};
  function save(p){if(p)storage.setItem(key,JSON.stringify(p));else storage.removeItem(key);onPending(p);}
  async function read(route,params={}){
    const r=await fetcher(base+route+'?'+new URLSearchParams(params),{cache:'no-store',credentials:'omit'}),text=await r.text();
    if(text.length>5000000)throw Error('响应超限');const value=JSON.parse(text);if(!r.ok||value.success!==true)throw Error(value.message||'读取失败');return value;
  }
  async function init(){info=await read('info');onPending(pending());return info;}
  async function send(p,recovery=false){
    if(p.store_id!==info.store_id)throw Error('库身份变化，原请求保留');
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),55000);
    try{
      const r=await fetcher(base+'command',{method:'POST',cache:'no-store',credentials:'omit',headers:{'Content-Type':'application/json','X-CLW-Intent':info.intent},body:JSON.stringify(p.command),signal:abort.signal});
      const text=await r.text();if(text.length>5000000)throw Error('响应超限');const value=JSON.parse(text);
      if(r.ok&&value.success===true&&value.request_id===p.command.request_id&&value.store_id===p.store_id){save(null);return value;}
      if(!recovery&&r.status>=400&&r.status<500&&r.status!==401&&r.status!==403&&value.success===false){save(null);throw Object.assign(Error(value.message||'请求拒绝'),{definite:true});}
      throw Error('未确认');
    }catch(e){if(e.definite)throw e;throw Error('结果未知；先核对原请求和当前记录，不复制派发。');}finally{clearTimeout(timer);}
  }
  async function exclusive(fn){if(busy)throw Error('正在处理原请求');busy=true;try{return await fn();}finally{busy=false;}}
  async function command(action,data,identity={}){return exclusive(async()=>{
    if(pending())throw Error('先核对上一条请求');if(!info)await init();
    const raw={...identity,action,data,request_id:newId()};const p={store_id:info.store_id,command:raw};save(p);return send(p);
  });}
  async function recover(retry=false){return exclusive(async()=>{
    const p=pending();if(!p)return null;await init();if(info.store_id!==p.store_id)throw Error('库已变化，不跨库重发');
    const r=await read('receipt',{request_id:p.command.request_id});
    if(r.store_id!==p.store_id)throw Error('回执库身份不符');
    if(r.found){if(r.receipt?.request_id!==p.command.request_id||r.receipt?.store_id!==p.store_id)throw Error('原回执身份不符');save(null);return r.receipt;}
    // A later admission failure cannot disprove an older concurrent same-ID attempt.
    return retry?send(p,true):null;
  });}
  return {init,read,command,recover,pending,busy:()=>busy};
}
