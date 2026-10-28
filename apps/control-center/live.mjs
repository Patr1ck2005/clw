import {validateSnapshot,MAX_BYTES,NATIVE_SESSION_RE as SESSION} from './model.mjs';
const states=new Set(['connected','stale','connecting','not_configured','auth_required','access_denied','not_found','incompatible_version','upstream_invalid','upstream_unreachable','upstream_timeout','rate_limited','redirect_rejected','busy']);
export function liveSelection(project='',session='',query=''){
  if(typeof project!=='string'||project.length>512||typeof query!=='string'||query.length>200||typeof session!=='string'||(session&&(!project||!SESSION.test(session))))throw Error('项目或Session选择无效');
  return {project,session,query};
}
export function parseLiveEnvelope(raw,selected){
  if(!raw||raw.schema_version!==1||!states.has(raw.state)||!raw.selection||Object.keys(selected).some(k=>selected[k]!==raw.selection[k]))throw Error('实时响应与当前视图不匹配');
  const projection=raw.projection==null?null:validateSnapshot(raw.projection);
  if(projection){
    if(projection.runtime.id!==raw.connection_id)throw Error('实时后端身份不一致');
    if(projection.sessions.some(s=>s.project_id!==selected.project)||projection.jobs.some(j=>j.project_id!==selected.project))throw Error('跨项目响应被拒绝');
  }
  if(raw.unchanged&&projection)throw Error('增量信封冲突');
  if(raw.revision!=null&&(typeof raw.revision!=='string'||raw.revision.length>120))throw Error('无效revision');
  const interval=Number(raw.refresh_after_ms);
  return {...raw,projection,refresh_after_ms:Number.isFinite(interval)?Math.max(1000,Math.min(300000,interval)):5000};
}
/** One foreground poll per controller, bounded shared cache on service. No tasks are launched. */
export function createLiveController({fetcher=fetch,onData,onState,isHidden=()=>false,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}){
  let active=false,selected=liveSelection(),generation=0,timer=null,controller=null,revision='',failures=0,lastSuccess=0,connection=null;
  const clear=()=>{if(timer!==null)clearTimer(timer);timer=null;};
  const schedule=(delay,ticket)=>{clear();if(active&&ticket===generation&&!isHidden())timer=setTimer(()=>poll(ticket),delay);};
  async function poll(ticket){
    if(!active||ticket!==generation||isHidden())return;
    controller=new AbortController();const current=controller;let timeout=null;
    try{
      timeout=setTimer(()=>current.abort(),28000);
      const params=new URLSearchParams({...selected,...(revision?{after:revision}:{})});
      const response=await fetcher('./api/live/state?'+params,{signal:current.signal,cache:'no-store',credentials:'omit'});
      if(!response.ok)throw Error('只读观察请求失败');
      const body=await response.text();
      if(new TextEncoder().encode(body).length>MAX_BYTES+32768)throw Error('只读响应超过限制');
      const result=parseLiveEnvelope(JSON.parse(body),selected);
      if(!active||ticket!==generation)return;
      if(connection&&connection!==result.connection_id){revision='';onData(null);}
      connection=result.connection_id??null;
      if(result.unchanged&&(!revision||revision!==result.revision))throw Error('未持有此增量基线');
      if(result.projection){revision=result.revision??'';onData(result.projection,result);}
      else if(!result.unchanged&&!['stale','connecting','busy'].includes(result.state)){revision='';onData(null,result);}
      if(result.state==='connected'){lastSuccess=now();failures=0;}
      const halted=['auth_required','access_denied','not_found','incompatible_version','not_configured','upstream_invalid','redirect_rejected'].includes(result.state);
      if(halted){active=false;clear();}
      onState({...result,age_ms:result.age_ms??(lastSuccess?now()-lastSuccess:null)});
      if(halted)return;
      schedule(Math.max(5000,result.refresh_after_ms),ticket);
    }catch(error){
      if(!active||ticket!==generation)return;
      failures++;
      onState({state:'disconnected',message:'工作台与只读服务暂时断连；没有重放开发任务。',age_ms:lastSuccess?now()-lastSuccess:null});
      schedule(Math.min(60000,5000*2**Math.min(failures-1,4)),ticket);
    }finally{if(timeout!==null)clearTimer(timeout);if(controller===current)controller=null;}
  }
  function restart(next=selected){
    selected=liveSelection(next.project,next.session,next.query);active=true;generation++;clear();controller?.abort();revision='';failures=0;lastSuccess=0;
    onState({state:isHidden()?'paused':'connecting',message:'正在读取正式接口；尚未采用新观测。'});
    void poll(generation);
  }
  return {
    start:restart,
    select:next=>{if(active)restart(next);},
    retry:()=>{if(active)restart();},
    stop:()=>{active=false;generation++;clear();controller?.abort();controller=null;revision='';onState({state:'paused',message:'已暂停只读刷新；不会停止WebCodex或后台Job。'});},
    visibility:()=>{
      if(!active)return;
      generation++;clear();controller?.abort();controller=null;
      if(isHidden())onState({state:'paused',message:'页面隐藏，暂停轮询；显示的是上次观测。'});
      else {onState({state:'connecting',message:'页面恢复，核对当前状态。'});void poll(generation);}
    },
    active:()=>active,
  };
}
