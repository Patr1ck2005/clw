'use strict';
(function(scope){
  const LIMIT=40,WINDOW=120;
  const identity=(mode,row)=>mode==='web'?row.seq:row.traceId;
  const nativeKey=row=>row.source?.threadId||'unmapped:'+row.traceId;
  const ascending=(mode,rows)=>[...rows].sort((a,b)=>mode==='web'?a.seq-b.seq:
    String(a.startedAt||'').localeCompare(String(b.startedAt||''))||String(a.traceId).localeCompare(String(b.traceId)));
  function summary(mode,row){
    if(mode==='web'){
      const text=typeof row.data?.text==='string'?row.data.text:'';
      const data={};for(const key of ['text','reason','source','author_markdown_saved','operation_id','request_id','note_id']){
        const value=row.data?.[key];if(['string','number','boolean'].includes(typeof value))data[key]=typeof value==='string'?value.slice(0,600):value;
      }
      return {...row,data,body_loaded:row.body_loaded!==false&&text.length<=600,
        text_length:Math.max(text.length,Number(row.text_length)||0),truncated:row.truncated===true||text.length>600};
    }
    const result={...row};if(row.review){const {finalText,...review}=row.review;result.review=review;
      result.bodyAvailable=row.bodyAvailable??typeof finalText==='string';
      if(typeof finalText==='string'&&finalText.length<=600)result.review.finalText=finalText;
    }return result;
  }
  function validResponse(state,value,kind){
    if(!value||typeof value!=='object')return false;
    if(state.mode==='web')return value.page_id===state.id&&typeof value.thread_id==='string'&&
      (!state.thread||state.thread===value.thread_id)&&Array.isArray(value[kind==='index'?'items':'events']);
    return value.task_key===state.id&&Array.isArray(value[kind==='index'?'items':'rows']);
  }
  class Records {
    constructor({command,onChange=()=>{},maxTasks=8,maxBodyBytes=8*1024*1024}={}){
      Object.assign(this,{command,onChange,maxTasks,maxBodyBytes});this.states=new Map();this.active=null;
      this.version=0;this.bodies=new Map();this.bodyBytes=0;
    }
    changed(){this.onChange(this.active);}
    use(context,rows=[],meta=null){
      if(!context){if(this.active){const state=this.active;if(state.loading)state.live=state.requestWasLive;state.request++;state.indexRequest++;state.loading=false;state.indexLoading=false;this.active=null;this.version++;}return null;}
      const key=context.mode+':'+context.id;
      if(this.active?.key!==key){
        if(this.active){if(this.active.loading)this.active.live=this.active.requestWasLive;this.active.request++;this.active.indexRequest++;this.active.loading=false;this.active.indexLoading=false;}
        this.version++;let state=this.states.get(key);
        if(!state){state={key,mode:context.mode,id:context.id,rows:[],meta:{},live:true,loading:false,
          request:0,indexRequest:0,index:[],indexMeta:{},query:'',indexOpen:false,error:'',newer:false,following:true,revision:0};this.states.set(key,state);}
        this.states.delete(key);this.states.set(key,state);this.active=state;
        while(this.states.size>this.maxTasks)this.states.delete(this.states.keys().next().value);
      }
      const state=this.active;state.capable=!!context.capable;
      if(state.thread&&context.thread&&state.thread!==context.thread){
        this.version++;state.request++;state.indexRequest++;state.loading=false;state.indexLoading=false;
        state.rows=[];state.meta={};state.live=true;state.following=true;state.index=[];state.indexMeta={};state.query='';state.indexOpen=false;
        state.seedSignature='';state.historyFetched=false;state.revision++;
        for(const [bodyKey,body]of this.bodies)if(bodyKey.startsWith(state.key+':')){this.bodyBytes-=body.size;this.bodies.delete(bodyKey);}
      }
      if(context.thread)state.thread=context.thread;
      const seed=ascending(state.mode,rows).slice(-LIMIT);
      for(const row of seed){const full=state.mode==='web'?row.body_loaded!==false&&typeof row.data?.text==='string':typeof row.review?.finalText==='string';
        const text=state.mode==='web'?row.data?.text:row.review?.finalText;
        // Inline summaries need no body-cache entry. Repeated heartbeats must
        // not rotate those entries and evict a reply the reader just opened.
        if(full&&text.length>600&&!this.bodies.has(this.bodyKey(state,row)))this.cache(state,row,row);}
      state.seed=seed.map(row=>summary(state.mode,row));state.seedMeta=meta||{total:rows.length,has_before:rows.length>LIMIT,has_after:false};
      const acceptedSeed=state.seed.filter(row=>{const id=identity(state.mode,row),ignored=state.ignoredSeed?.get(id);
        if(ignored===this.bodyKey(state,row))return false;state.ignoredSeed?.delete(id);return true;});
      if(state.live){
        const merged=state.historyFetched||state.following===false?new Map([...state.rows,...acceptedSeed].map(row=>[identity(state.mode,row),row])):null;
        const next=merged?ascending(state.mode,[...merged.values()]).slice(-(state.following===false?WINDOW:LIMIT)):state.seed;
        const fingerprint=JSON.stringify(next);
        if(fingerprint!==state.seedSignature){state.seedSignature=fingerprint;state.rows=next;state.revision++;}
        state.meta={...state.seedMeta,total:Math.max(state.seedMeta.total||0,state.historyFetched?state.meta.total||0:0),
          has_before:state.seedMeta.has_before||(state.historyFetched&&state.meta.has_before),has_after:false};
        const newest=state.seed.at(-1),id=newest&&identity(state.mode,newest);
        if(state.following!==false){state.seenLatest=id;state.newer=false;}
        else state.newer=id!==undefined&&state.seenLatest!==undefined&&id!==state.seenLatest;
      }else{
        const overlapping=new Map(acceptedSeed.map(row=>[identity(state.mode,row),row]));
        const updated=state.rows.map(row=>overlapping.get(identity(state.mode,row))||row);
        if(JSON.stringify(updated)!==JSON.stringify(state.rows)){state.rows=updated;state.revision++;}
        const newest=state.seed.at(-1),last=state.rows.at(-1);
        state.newer=!!newest&&!!last&&(state.mode==='web'?newest.seq>last.seq:
          ascending('codex',[newest,last]).at(-1)===newest&&newest.traceId!==last.traceId);
        if(state.newer)state.meta={...state.meta,has_after:true,total:Math.max(state.meta.total||0,state.seedMeta.total||0)};
      }
      return state;
    }
    payload(state,extra={}){return {mode:state.mode,...(state.mode==='web'?{id:state.id}:{task_key:state.id}),...extra};}
    cursor(state,row,direction){return {[state.mode==='web'?direction+'_seq':direction+'_trace']:identity(state.mode,row)};}
    async navigate(direction,target=null){
      const state=this.active;if(!state||!state.capable)return false;
      const version=this.version,request=++state.request,wasLive=state.live;
      const seedAtRequest=new Map((state.seed||[]).map(row=>[identity(state.mode,row),this.bodyKey(state,row)]));
      const extra={limit:LIMIT};
      if(direction==='before'||direction==='after'){
        const edge=direction==='before'?state.rows[0]:state.rows.at(-1);if(!edge)return false;
        Object.assign(extra,this.cursor(state,edge,direction));
      }else if(direction==='around')Object.assign(extra,this.cursor(state,state.mode==='web'?{seq:target}:{traceId:target},'around'));
      else extra.position=direction;
      state.requestWasLive=wasLive;state.loading=true;state.error='';state.live=false;this.changed();
      try{
        const value=await this.command('record-history',this.payload(state,extra));
        if(this.version!==version||this.active!==state||state.request!==request)return false;
        if(!validResponse(state,value,'history'))throw Error('历史记录尚未就绪，请稍后再试。');
        state.thread=value.thread_id||state.thread;
        const incoming=(state.mode==='web'?value.events:value.rows).map(row=>summary(state.mode,row));
        const combined=['before','after'].includes(direction)?[...state.rows,...incoming]:incoming;
        const unique=new Map(combined.map(row=>[identity(state.mode,row),row]));let sorted=ascending(state.mode,[...unique.values()]);
        const clipped=sorted.length>WINDOW;
        if(clipped)sorted=direction==='before'?sorted.slice(0,WINDOW):sorted.slice(-WINDOW);
        state.rows=sorted;state.historyFetched=true;
        const hasBefore=direction==='after'?(clipped||state.meta.has_before):value.has_before;
        const hasAfter=direction==='before'?(clipped||state.meta.has_after):value.has_after;
        state.meta={...value,has_before:!!hasBefore,has_after:!!hasAfter};
        delete state.meta.events;delete state.meta.rows;
        state.live=direction==='latest';state.following=direction==='latest';state.newer=false;
        if(state.live&&state.seed.length){
          const merged=new Map(state.rows.map(row=>[identity(state.mode,row),row]));state.ignoredSeed=new Map();
          for(const row of state.seed){const id=identity(state.mode,row),fingerprint=this.bodyKey(state,row);
            if(!merged.has(id)||seedAtRequest.get(id)!==fingerprint)merged.set(id,row);
            else if(this.bodyKey(state,merged.get(id))!==fingerprint)state.ignoredSeed.set(id,fingerprint);
          }
          state.rows=ascending(state.mode,[...merged.values()]).slice(-LIMIT);
          state.meta={...state.meta,total:Math.max(state.meta.total||0,state.seedMeta.total||0,merged.size),
            has_before:state.meta.has_before||state.seedMeta.has_before||merged.size>LIMIT,has_after:false};
        }
        state.intent={direction,target,serial:request};state.revision++;this.changed();return true;
      }catch(error){
        if(this.version===version&&this.active===state&&state.request===request){state.error=String(error.message||error).replace(/^Error invoking remote method '[^']+': Error: /,'');state.live=wasLive;this.changed();}
        return false;
      }finally{if(this.version===version&&this.active===state&&state.request===request){state.loading=false;this.changed();}}
    }
    follow(){const state=this.active;if(!state)return false;
      if(!state.live)return this.navigate('latest');
      state.following=true;state.newer=false;state.seenLatest=state.seed?.at(-1)&&identity(state.mode,state.seed.at(-1));
      state.intent={direction:'latest',serial:++state.request};state.revision++;this.changed();return true;
    }
    async directory(query='',direction='latest'){
      const state=this.active;if(!state||!state.capable)return false;
      const version=this.version,request=++state.indexRequest;
      query=String(query).trim().slice(0,200);
      if(query!==state.query){state.index=[];state.indexMeta={};state.indexRevision=(state.indexRevision||0)+1;}
      state.query=query;state.indexLoading=true;state.error='';
      const extra={query,limit:LIMIT};
      if(['before','after'].includes(direction)){
        const edge=direction==='before'?state.index[0]:state.index.at(-1);
        if(edge)Object.assign(extra,this.cursor(state,edge,direction));else extra.position='latest';
      }else extra.position=direction;
      this.changed();
      try{
        const value=await this.command('record-index',this.payload(state,extra));
        if(this.version!==version||this.active!==state||state.indexRequest!==request)return false;
        if(!validResponse(state,value,'index'))throw Error('目录暂不可用，请稍后再试。');
        state.thread=value.thread_id||state.thread;state.index=value.items;state.indexMeta={...value};delete state.indexMeta.items;
        state.indexRevision=(state.indexRevision||0)+1;this.changed();return true;
      }catch(error){if(this.version===version&&this.active===state&&state.indexRequest===request){state.error=String(error.message||error);this.changed();}return false;}
      finally{if(this.version===version&&this.active===state&&state.indexRequest===request){state.indexLoading=false;this.changed();}}
    }
    bodyKey(state,row){return state.key+':'+JSON.stringify([state.thread||'',identity(state.mode,row),row.source?.threadId,row.source?.turnId,row.source?.model,row.source?.account,row.account,row.bodyRevision||row.body_revision||row.review?.finalSha256||'']);}
    cache(state,row,value){
      const key=this.bodyKey(state,row),text=state.mode==='web'?value.data?.text:value.review?.finalText;
      if(typeof text!=='string')return;const size=text.length*2;if(size>this.maxBodyBytes)return;
      const existing=this.bodies.get(key);if(existing){this.bodyBytes-=existing.size;this.bodies.delete(key);}
      this.bodies.set(key,{value,size});this.bodyBytes+=size;
      while(this.bodyBytes>this.maxBodyBytes||this.bodies.size>32){const oldest=this.bodies.keys().next().value;this.bodyBytes-=this.bodies.get(oldest).size;this.bodies.delete(oldest);}
    }
    async body(row,expectedKey=this.active?.key){
      const state=this.active;if(!state)throw Error('请先选择任务。');
      if(state.key!==expectedKey)throw Error('任务已切换，正文读取已取消。');
      const key=this.bodyKey(state,row),cached=this.bodies.get(key);
      const current=state.rows.find(current=>identity(state.mode,current)===identity(state.mode,row));
      if(current&&this.bodyKey(state,current)!==key)throw Error('保存的正文已更新，请重新展开。');
      const inline=state.mode==='web'?row.data?.text:row.review?.finalText;
      if(typeof inline==='string'&&!row.truncated&&(state.mode!=='web'||row.body_loaded!==false))return row;
      if(cached){this.bodies.delete(key);this.bodies.set(key,cached);return cached.value;}
      if(!state.capable)throw Error('完整正文需在更新后的工作区读取；原记录仍保留。');
      const version=this.version,id=identity(state.mode,row);
      const value=await this.command('record-body',this.payload(state,state.mode==='web'?{seq:id}:{traceId:id}));
      if(this.version!==version||this.active!==state)throw Error('任务已切换，正文读取已取消。');
      const full=state.mode==='web'?value?.event:value?.row;
      if(!full||identity(state.mode,full)!==id||
        (state.mode==='web'?(value.page_id!==state.id||value.thread_id!==state.thread):nativeKey(full)!==state.id))throw Error('正文与当前记录不匹配。');
      if(state.mode==='codex'&&row.source&&(!full.source||['traceId','threadId','turnId'].some(field=>full.source[field]!==row.source[field])))throw Error('正文与原回合不匹配。');
      if((row.bodyRevision||row.body_revision||row.review?.finalSha256)&&this.bodyKey(state,full)!==key)throw Error('保存的正文已更新，请重新展开。');
      const refreshed=state.rows.find(current=>identity(state.mode,current)===id);
      if(refreshed&&this.bodyKey(state,refreshed)!==key)throw Error('保存的正文已更新，请重新展开。');
      if(value.body_unavailable||full.body_unavailable)throw Error('完整正文暂不可用；已保存的摘要仍保留。');
      this.cache(state,row,full);return full;
    }
  }
  const api={Records,summary,identity,ascending,LIMIT,WINDOW};if(typeof module!=='undefined')module.exports=api;else scope.CLWRecordHistory=api;
})(globalThis);
