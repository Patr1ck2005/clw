'use strict';
(function(scope,factory){
  const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else scope.CLWWorkTimer=api;
})(globalThis,()=>{
  const terminal=new Set(['completed','blocked','cancelled','failed','aborted']);
  const storageKey='clw-work-timer-ends-v1';
  function timestamp(value){
    if(typeof value==='number')return Number.isFinite(value)&&value>0?(value<1e12?value*1000:value):null;
    if(typeof value!=='string'||!value.trim())return null;
    const number=Number(value);if(Number.isFinite(number))return timestamp(number);
    const parsed=Date.parse(value);return Number.isFinite(parsed)&&parsed>0?parsed:null;
  }
  function duration(ms){
    const seconds=Math.max(0,Math.floor(ms/1000)),hours=Math.floor(seconds/3600);
    return String(hours).padStart(2,'0')+':'+String(Math.floor(seconds/60)%60).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
  }
  function web(context,ends,now=Date.now()){
    const {page,view}=context;
    if(!page?.id||!view||view.page_id!==page.id||
      page.thread_id&&view.thread_id!==page.thread_id)return null;
    const request=view.latest_request||view.request;
    if(!request?.id||view.request&&view.request.id!==request.id||
      page.latest_request?.id&&page.latest_request.id!==request.id)return null;
    const attempt=view.attempt;
    const validAttempt=!!attempt?.id&&(!request.attempt_id||request.attempt_id===attempt.id);
    const start=validAttempt?timestamp(attempt.acknowledged):null;
    const key=JSON.stringify([page.id,view.thread_id||'',request.id,validAttempt?attempt.id:'']);
    let end=null;
    if(start){
      const matching=(view.events||[]).filter(row=>{
        const data=row.data||{};
        if(data.request_id!==request.id)return false;
        if(['host_turn_yielded','host_turn_attention','control_browser_result_failed'].includes(row.kind))return data.attempt_id===attempt.id;
        return row.kind==='assistant_message'&&data.source==='bound_browser_public_reply'&&
          data.item_id==='clw-browser-reply-'+attempt.id.replace(/^control_/,'');
      }).map(row=>timestamp(row.at)).filter(at=>at!==null&&at>=start);
      if(matching.length)end=Math.min(...matching);
      const cached=ends?.get(key);if(cached?.start===start&&cached.end>=start)end=end===null?cached.end:Math.min(end,cached.end);
      if(end===null&&terminal.has(request.phase)){
        const finished=timestamp(request.finished_at);if(finished!==null&&finished>=start)end=finished;
      }
    }
    const observed=page.observation||{},observedAt=timestamp(observed.at);
    const sameObservedTurn=validAttempt&&(observed.attemptId===attempt.id||
      !!request.sent_user_hash&&observed.userTurnHash===request.sent_user_hash);
    const observedEnd=sameObservedTurn&&observed.historyAtLatest===true&&observed.generating!==true&&
      observedAt!==null&&observedAt>=start&&observedAt<=now+5000&&now-observedAt<=30000&&
      !!(observed.failure||observed.stopped);
    const unresolved=!!start&&end===null&&(terminal.has(request.phase)||observedEnd);
    return {mode:'web',key,requestId:request.id,attemptId:validAttempt?attempt.id:null,start,end,unresolved,
      goalStart:timestamp(request.created_at),goalEnd:timestamp(request.finished_at),goalTerminal:terminal.has(request.phase),
      roundNote:'从本轮消息确认送达起计时，包含思考、工具执行与回收等待；暂停后续自动推进不停止当前回合计时。',
      goalNote:'本次需求从保存到结束的历时，包含排队、暂停和等待；不是整个 Goal 的累计工作时长。'};
  }
  function codex(context){
    const row=context.row;if(!row?.traceId||!row.startedAt)return null;
    const start=timestamp(row.startedAt),candidate=timestamp(row.endedAt)||
      (terminal.has(row.nativeState?.state)?timestamp(row.nativeState.endedAt):null);
    const end=candidate!==null&&candidate>=start?candidate:null;
    return {mode:'codex',key:JSON.stringify(['codex',row.source?.threadId||'',row.traceId]),
      requestId:null,attemptId:row.traceId,start,end,
      unresolved:!end&&row.status!=='running',goalStart:null,goalEnd:null,goalTerminal:false,
      roundNote:'此 Codex＋Web 网页回合的历时，包含准备、思考与工具等待；失联时间不作为执行结束。',goalNote:''};
  }
  function display(model,now=Date.now()){
    if(!model)return {visible:false,running:false,round:'',goal:''};
    const round=model.start?(model.unresolved?'本轮用时 · 结束时间待确认':'本轮用时 '+duration((model.end??now)-model.start)):'尚未确认送达';
    const goal=model.goalStart?(model.goalTerminal&&!model.goalEnd?'需求历时 · 结束时间待确认':'需求历时 '+duration((model.goalEnd??now)-model.goalStart)):'';
    return {...model,visible:!!model.start||!!model.goalStart,round,goal,
      state:model.unresolved?'end_pending':model.end!==null?'ended':model.start?'running':'queued',
      running:!!model.start&&model.end===null&&!model.unresolved||!!model.goalStart&&!model.goalEnd&&!model.goalTerminal};
  }
  class Clock{
    constructor({storage,onChange=()=>{},now=()=>Date.now(),hidden=()=>false,
      setTimer=(callback,delay)=>setTimeout(callback,delay),clearTimer=id=>clearTimeout(id)}={}){
      Object.assign(this,{storage,onChange,now,hidden,setTimer,clearTimer});this.ends=new Map();this.model=null;this.timer=null;
      try{const saved=JSON.parse(storage?.getItem(storageKey)||'[]');if(Array.isArray(saved))for(const entry of saved.slice(-128)){
        if(Array.isArray(entry)&&typeof entry[0]==='string'&&entry[0].length<600&&
          Number.isFinite(entry[1]?.start)&&entry[1].start>0&&Number.isFinite(entry[1]?.end)&&entry[1].end>=entry[1].start)this.ends.set(entry[0],entry[1]);
      }}catch{/* An unavailable preference store never blocks work or the timer. */}
    }
    update(context){
      this.model=context?.mode==='web'?web(context,this.ends,this.now()):context?.mode==='codex'?codex(context):null;
      const m=this.model;
      if(m?.mode==='web'&&m.start&&m.end!==null&&this.ends.get(m.key)?.end!==m.end){
        this.ends.delete(m.key);this.ends.set(m.key,{start:m.start,end:m.end});
        while(this.ends.size>128)this.ends.delete(this.ends.keys().next().value);
        try{this.storage?.setItem(storageKey,JSON.stringify([...this.ends]));}catch{}
      }
      this.paint();
    }
    snapshot(){return display(this.model,this.now());}
    paint(){
      if(this.timer!==null){this.clearTimer(this.timer);this.timer=null;}
      const value=this.snapshot();this.onChange(value);
      if(value.running&&!this.hidden())this.timer=this.setTimer(()=>{this.timer=null;this.paint();},1000-this.now()%1000);
    }
    visibility(){if(this.hidden()){if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;}else this.paint();}
    dispose(){if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;this.model=null;}
  }
  return {timestamp,duration,web,codex,display,Clock};
});
