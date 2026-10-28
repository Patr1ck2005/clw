// One durable request identity per local metadata action. Never retries a POST automatically.
export function createTaskClient({fetcher=fetch,storage=sessionStorage,onPending=()=>{},key='clw.tasks.pending.v1',newId=()=>crypto.randomUUID()}={}){
  let info=null,busy=false;
  const pending=()=>{const text=storage.getItem(key);if(!text)return null;if(text.length>2200000)throw Error('待确认记录过大，请保留记录并检查');return JSON.parse(text);};
  function save(value){if(value)storage.setItem(key,JSON.stringify(value));else storage.removeItem(key);onPending(value);}
  async function read(path,params={}){
    const r=await fetcher('./api/tasks/'+path+'?'+new URLSearchParams(params),{cache:'no-store',credentials:'omit'});
    const text=await r.text();if(text.length>5000000)throw Error('响应超过当前读取上限');
    const data=JSON.parse(text);if(!r.ok||data.success!==true)throw Error(data.message||'无法读取任务数据');return data;
  }
  async function init(){info=await read('info');onPending(pending());return info;}
  async function transmit(saved){
    if(saved.store_id!==info.store_id)throw Error('待确认请求属于另一任务库，不会跨库重发');
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),35000);
    try{
      const r=await fetcher('./api/tasks/command',{method:'POST',cache:'no-store',credentials:'omit',headers:{'Content-Type':'application/json','X-CLW-Intent':info.intent},body:JSON.stringify(saved.command),signal:abort.signal});
      const text=await r.text();if(text.length>5000000)throw Error('响应过大');const data=JSON.parse(text);
      if(r.ok&&data.success===true&&data.request_id===saved.command.request_id&&data.store_id===saved.store_id){save(null);return data;}
      // An admission failure cannot prove a previous same-ID attempt did not commit.
      if(r.status===401||r.status===403)throw Error('页面访问状态变化，保留原请求待核对');
      if(r.status>=400&&r.status<500&&data.success===false){save(null);throw Object.assign(Error(data.message||'操作被拒绝'),{definite:true,code:data.error_code});}
      throw Error('未确认写入结果');
    }catch(error){if(error.definite)throw error;throw Error('结果未知，原请求已保留。先“核对原请求”，不要新建一次相同操作。');}
    finally{clearTimeout(timer);}
  }
  async function command(action,task,actor,data){
    if(busy)throw Error('已有请求正在处理');if(pending())throw Error('先核对上一条未确认请求');
    busy=true;
    try{
      if(!info)await init();
      const raw={request_id:newId(),action,actor,data,...(task?{task_id:task.id,expected_version:task.version}:{})};
      const saved={store_id:info.store_id,command:raw};save(saved);return await transmit(saved);
    }finally{busy=false;}
  }
  async function reconcile(){
    if(busy)throw Error('请等待当前请求');const saved=pending();if(!saved)return null;
    // Keep recovery exclusive through the GET and pending-record update. Otherwise
    // a delayed second receipt could clear a newer unresolved command.
    busy=true;
    try{
      if(!info)await init();if(saved.store_id!==info.store_id)throw Error('任务库不同，保留原请求；不向新库重发');
      const r=await read('receipt',{request_id:saved.command.request_id});
      if(r.store_id!==saved.store_id)throw Error('任务库身份变化');
      if(r.found){
        if(r.receipt?.request_id!==saved.command.request_id||r.receipt?.store_id!==saved.store_id)throw Error('原请求回执身份不匹配，保留待确认记录');
        save(null);return r.receipt;
      }
      return null;
    }finally{busy=false;}
  }
  async function retrySame(){
    if(busy)throw Error('已有请求正在处理');const saved=pending();if(!saved)throw Error('没有待确认请求');busy=true;
    try{await init();return await transmit(saved);}finally{busy=false;}
  }
  return {init,read,command,reconcile,retrySame,pending,busy:()=>busy};
}
