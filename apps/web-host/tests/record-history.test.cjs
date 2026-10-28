'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Records,summary,LIMIT,WINDOW}=require('../record-history.js');

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function web(seq,text='summary '+seq,extra={}){return {seq,kind:'requirements_note',data:{text},body_loaded:false,body_revision:'revision-'+seq,...extra};}
function native(n,thread='thread-A',extra={}){
  const traceId=String(n).padStart(12,'0');
  return {traceId,startedAt:new Date(Date.UTC(2026,8,1,0,0,n)).toISOString(),source:{traceId,threadId:thread,turnId:'turn-'+n},review:{finalSha256:'sha-'+n},bodyRevision:'revision-'+n,...extra};
}
function context(id='A',thread='thread-A'){return {mode:'web',id,thread,capable:true};}
function rows(first,last){return Array.from({length:last-first+1},(_,i)=>web(first+i));}
function page(events,{id='A',thread='thread-A',total=events.length,before=false,after=false}={}){
  return {page_id:id,thread_id:thread,events,total,has_before:before,has_after:after,first_seq:events[0]?.seq??null,last_seq:events.at(-1)?.seq??null};
}
function fixture(options={}){
  const calls=[],changes=[];
  const records=new Records({...options,command(action,payload){const pending=deferred();calls.push({action,payload,...pending});return pending.promise;},onChange:state=>changes.push(state?.key)});
  return {records,calls,changes};
}

test('A to B to A invalidates pending history and resets loading without losing the live seed',async()=>{
  const f=fixture(),a=f.records.use(context(),rows(81,120),{total:120,has_before:true});
  const pending=f.records.navigate('first');assert.equal(a.loading,true);
  f.records.use(context('B','thread-B'),[web(500)]);
  f.records.use(context(),rows(81,120),{total:120,has_before:true});
  assert.equal(f.records.active,a);assert.equal(a.loading,false);assert.equal(a.live,true);
  f.calls[0].resolve(page(rows(1,40),{total:120,after:true}));
  assert.equal(await pending,false);assert.deepEqual(a.rows.map(row=>row.seq),rows(81,120).map(row=>row.seq));
  assert.equal(a.loading,false);assert.equal(a.error,'');
});

test('A to B to A invalidates pending directory results and preserves the chosen task directory',async()=>{
  const f=fixture(),a=f.records.use(context(),[web(80)]);
  const pending=f.records.directory('find');assert.equal(a.indexLoading,true);
  f.records.use(context('B','thread-B'),[web(90)]);f.records.use(context(),[web(80)]);
  assert.equal(a.indexLoading,false);
  f.calls[0].resolve({page_id:'A',thread_id:'thread-A',items:[{seq:1,kind:'requirements_note'}],has_before:false,has_after:false,total:1});
  assert.equal(await pending,false);assert.deepEqual(a.index,[]);assert.equal(a.indexLoading,false);
});

test('leaving the task for the home view cancels pending history and directory loading before returning',async()=>{
  const f=fixture(),a=f.records.use(context(),[web(80)]);
  const history=f.records.navigate('first'),index=f.records.directory('find');
  f.records.use(null);assert.equal(f.records.active,null);
  f.records.use(context(),[web(80)]);
  assert.equal(a.loading,false);assert.equal(a.indexLoading,false);assert.equal(a.live,true);
  f.calls[0].resolve(page([web(1)],{total:80,after:true}));f.calls[1].resolve({page_id:'A',thread_id:'thread-A',items:[{seq:1}],total:1});
  assert.equal(await history,false);assert.equal(await index,false);assert.equal(a.rows[0].seq,80);assert.deepEqual(a.index,[]);
});

test('newer history and directory requests win when older requests finish later',async()=>{
  const f=fixture();f.records.use(context(),[web(90)]);
  const oldHistory=f.records.navigate('first'),newHistory=f.records.navigate('around',55);
  f.calls[1].resolve(page(rows(41,80),{total:120,before:true,after:true}));assert.equal(await newHistory,true);
  f.calls[0].resolve(page(rows(1,40),{total:120,after:true}));assert.equal(await oldHistory,false);
  assert.equal(f.records.active.rows[0].seq,41);
  const oldIndex=f.records.directory('old'),newIndex=f.records.directory('new');
  f.calls[3].resolve({page_id:'A',thread_id:'thread-A',items:[{seq:60,label:'new'}],total:1});assert.equal(await newIndex,true);
  f.calls[2].resolve({page_id:'A',thread_id:'thread-A',items:[{seq:1,label:'old'}],total:1});assert.equal(await oldIndex,false);
  assert.equal(f.records.active.query,'new');assert.equal(f.records.active.index[0].seq,60);
});

test('latest history merges with a partial periodic seed and keeps fetched older rows',async()=>{
  const f=fixture();f.records.use(context(),[web(120)],{total:120,has_before:true});
  const pending=f.records.navigate('latest');f.calls[0].resolve(page(rows(81,120),{total:120,before:true}));assert.equal(await pending,true);
  f.records.use(context(),[web(121)],{total:121,has_before:true});
  assert.equal(f.records.active.rows.length,LIMIT);assert.equal(f.records.active.rows[0].seq,82);assert.equal(f.records.active.rows.at(-1).seq,121);
  assert.equal(f.records.active.meta.has_before,true);assert.equal(f.records.active.meta.has_after,false);assert.equal(f.records.active.meta.total,121);
});

test('freshly fetched latest summaries replace an older seed of the same saved record',async()=>{
  const f=fixture();f.records.use(context(),[web(120,'old summary',{body_revision:'old'})],{total:120,has_before:true});
  const pending=f.records.navigate('latest');
  f.calls[0].resolve(page([...rows(81,119),web(120,'fresh summary',{body_revision:'fresh'})],{total:120,before:true}));
  assert.equal(await pending,true);assert.equal(f.records.active.rows.at(-1).data.text,'fresh summary');assert.equal(f.records.active.rows.at(-1).body_revision,'fresh');
});

for(const mode of ['web','codex'])test(mode+' repeated unchanged older heartbeat cannot revert a fetched summary or body revision',async()=>{
  const f=fixture(),old=mode==='web'?web(7,'old summary',{body_revision:'old'}):native(7,'thread-A',{bodyRevision:'old'});
  const ctx=mode==='web'?context():{mode:'codex',id:'thread-A',capable:true};
  const fresh=mode==='web'?web(7,'fresh summary',{body_revision:'fresh'}):native(7,'thread-A',{bodyRevision:'fresh',review:{finalSha256:'sha-fresh',title:'fresh'}});
  f.records.use(ctx,[old]);const pending=f.records.navigate('latest');
  f.calls[0].resolve(mode==='web'?page([fresh]):{task_key:'thread-A',rows:[fresh],total:1,has_before:false,has_after:false});assert.equal(await pending,true);
  for(let i=0;i<4;i++)f.records.use(ctx,[old]);
  const row=f.records.active.rows[0];assert.equal(mode==='web'?row.body_revision:row.bodyRevision,'fresh');
  if(mode==='web')assert.equal(row.data.text,'fresh summary');
  const body=f.records.body(row);f.calls[1].resolve(mode==='web'?{page_id:'A',thread_id:'thread-A',event:{...fresh,body_loaded:true,data:{text:'fresh full'}}}:
    {task_key:'thread-A',row:{...fresh,review:{finalSha256:'sha-fresh',finalText:'fresh full'}}});
  const full=await body;assert.equal(mode==='web'?full.data.text:full.review.finalText,'fresh full');
  for(let i=0;i<4;i++)f.records.use(ctx,[old]);
  const cached=await f.records.body(f.records.active.rows[0]);assert.equal(mode==='web'?cached.data.text:cached.review.finalText,'fresh full');assert.equal(f.calls.length,2);
  const newer=mode==='web'?web(7,'new heartbeat',{body_revision:'newer'}):native(7,'thread-A',{bodyRevision:'newer'});
  f.records.use(ctx,[newer]);assert.equal(mode==='web'?f.records.active.rows[0].body_revision:f.records.active.rows[0].bodyRevision,'newer');
});

test('older heartbeat body revisions remain ignored when status metadata changes',async()=>{
  for(const mode of ['web','codex']){
    const f=fixture(),old=mode==='web'?web(7,'old summary',{body_revision:'old',status:'running'}):native(7,'thread-A',{bodyRevision:'old',status:'running'});
    const ctx=mode==='web'?context():{mode:'codex',id:'thread-A',capable:true};
    const fresh=mode==='web'?web(7,'fresh summary',{body_revision:'fresh',status:'running'}):native(7,'thread-A',{bodyRevision:'fresh',status:'running',review:{finalSha256:'sha-fresh'}});
    f.records.use(ctx,[old]);const pending=f.records.navigate('latest');
    f.calls[0].resolve(mode==='web'?page([fresh]):{task_key:'thread-A',rows:[fresh],total:1,has_before:false,has_after:false});assert.equal(await pending,true);
    for(const status of ['completed','reviewed','archived'])f.records.use(ctx,[{...old,status,observedAt:'metadata-'+status}]);
    const selected=f.records.active.rows[0];assert.equal(mode==='web'?selected.body_revision:selected.bodyRevision,'fresh',mode);
    if(mode==='web')assert.equal(selected.data.text,'fresh summary');
    const body=f.records.body(selected);f.calls[1].resolve(mode==='web'?{page_id:'A',thread_id:'thread-A',event:{...fresh,body_loaded:true,data:{text:'fresh full'}}}:
      {task_key:'thread-A',row:{...fresh,review:{finalSha256:'sha-fresh',finalText:'fresh full'}}});
    assert.equal(mode==='web'?(await body).data.text:(await body).review.finalText,'fresh full');
    f.records.use(ctx,[{...old,status:'status changed again',observedAt:'later'}]);
    const cached=await f.records.body(f.records.active.rows[0]);assert.equal(mode==='web'?cached.data.text:cached.review.finalText,'fresh full');assert.equal(f.calls.length,2);
  }
});

test('a live seed arriving during latest-history loading preserves newer summaries and new events',async()=>{
  const f=fixture();f.records.use(context(),[web(120,'old summary',{body_revision:'old'})],{total:120,has_before:true});
  const pending=f.records.navigate('latest');
  f.records.use(context(),[web(120,'live amendment',{body_revision:'live'}),web(121)],{total:121,has_before:true});
  f.calls[0].resolve(page([...rows(81,119),web(120,'older response',{body_revision:'old'})],{total:120,before:true}));
  assert.equal(await pending,true);const state=f.records.active;
  assert.equal(state.rows.length,40);assert.equal(state.rows[0].seq,82);assert.equal(state.rows.at(-1).seq,121);
  assert.equal(state.rows.find(row=>row.seq===120).data.text,'live amendment');assert.equal(state.rows.find(row=>row.seq===120).body_revision,'live');
  assert.equal(state.meta.total,121);assert.equal(state.meta.has_after,false);
});

test('reading an early page survives live updates while overlapping saved summaries refresh',async()=>{
  const f=fixture();f.records.use(context(),rows(81,120),{total:120,has_before:true});
  const pending=f.records.navigate('first');f.calls[0].resolve(page(rows(1,40),{total:120,after:true}));await pending;
  f.records.use(context(),[web(40,'amended'),...rows(121,125)],{total:125,has_before:true});
  const state=f.records.active;assert.equal(state.live,false);assert.equal(state.rows.length,40);
  assert.equal(state.rows[0].seq,1);assert.equal(state.rows.at(-1).seq,40);assert.equal(state.rows.at(-1).data.text,'amended');
  assert.equal(state.newer,true);assert.equal(state.meta.has_after,true);assert.equal(state.meta.total,125);
});

test('before and after paging deduplicates boundaries, clips to a bounded window, and retains navigation flags',async()=>{
  const f=fixture();f.records.use(context(),rows(121,160),{total:200,has_before:true});
  for(const [direction,incoming]of [['before',rows(81,121)],['before',rows(41,81)],['before',rows(1,41)]]){
    const pending=f.records.navigate(direction),call=f.calls.at(-1);
    assert.equal(call.payload.before_seq,f.records.active.rows[0].seq);
    call.resolve(page(incoming,{total:200,before:incoming[0].seq>1,after:true}));assert.equal(await pending,true);
  }
  assert.equal(f.records.active.rows.length,WINDOW);assert.equal(f.records.active.rows[0].seq,1);assert.equal(f.records.active.rows.at(-1).seq,120);
  assert.equal(new Set(f.records.active.rows.map(row=>row.seq)).size,WINDOW);assert.equal(f.records.active.meta.has_before,false);assert.equal(f.records.active.meta.has_after,true);
  const pending=f.records.navigate('after');assert.equal(f.calls.at(-1).payload.after_seq,120);
  f.calls.at(-1).resolve(page(rows(120,160),{total:200,before:true,after:true}));await pending;
  assert.equal(f.records.active.rows.length,WINDOW);assert.equal(f.records.active.rows[0].seq,41);assert.equal(f.records.active.rows.at(-1).seq,160);
  assert.equal(f.records.active.meta.has_before,true);assert.equal(f.records.active.meta.has_after,true);
});

test('native paging uses exact trace cursors and stable chronological tie ordering',async()=>{
  const f=fixture(),a=native(2),b=native(1);b.startedAt=a.startedAt;
  f.records.use({mode:'codex',id:'thread-A',capable:true},[a,b]);
  assert.deepEqual(f.records.active.rows.map(row=>row.traceId),[b.traceId,a.traceId]);
  const pending=f.records.navigate('before');assert.deepEqual(f.calls[0].payload,{mode:'codex',task_key:'thread-A',limit:40,before_trace:b.traceId});
  f.calls[0].resolve({task_key:'thread-A',rows:[native(0)],total:3,has_before:false,has_after:true});assert.equal(await pending,true);
  assert.deepEqual(f.records.active.rows.map(row=>row.traceId),[native(0).traceId,b.traceId,a.traceId]);
});

test('query changes clear a previous directory and query paging is bounded to one response',async()=>{
  const f=fixture();f.records.use(context(),[web(80)]);
  let pending=f.records.directory('old');f.calls[0].resolve({page_id:'A',thread_id:'thread-A',items:[{seq:70}],has_before:true,total:2});await pending;
  pending=f.records.directory('old','before');assert.equal(f.calls[1].payload.before_seq,70);
  f.calls[1].resolve({page_id:'A',thread_id:'thread-A',items:[{seq:10}],has_before:false,has_after:true,total:2});await pending;
  assert.deepEqual(f.records.active.index,[{seq:10}]);
  pending=f.records.directory('  new  ');assert.deepEqual(f.records.active.index,[]);assert.deepEqual(f.records.active.indexMeta,{});
  assert.equal(f.calls[2].payload.query,'new');assert.equal(f.calls[2].payload.position,'latest');
  f.calls[2].resolve({page_id:'A',thread_id:'thread-A',items:[{seq:50}],total:1});await pending;
});

test('task state LRU remains bounded and reopening an evicted task starts with its current seed',()=>{
  const f=fixture({maxTasks:2});f.records.use(context(),[web(1)]);f.records.use(context('B','thread-B'),[web(2)]);
  f.records.use(context(),[web(3)]);f.records.use(context('C','thread-C'),[web(4)]);
  assert.deepEqual([...f.records.states.keys()],['web:A','web:C']);
  const b=f.records.use(context('B','thread-B'),[web(5)]);assert.deepEqual(b.rows.map(row=>row.seq),[5]);assert.equal(b.live,true);assert.equal(f.records.states.size,2);
});

test('changing a web thread resets history, directory, cached bodies and in-flight body ownership',async()=>{
  const f=fixture(),old=web(1,'old'.repeat(300),{body_loaded:true});f.records.use(context(),[old]);
  assert.equal(f.records.bodies.size,1);f.records.active.index=[{seq:1}];f.records.active.live=false;
  const pending=f.records.body(web(2),f.records.active.key);
  f.records.use(context('A','thread-replaced'),[web(1,'new'.repeat(300),{body_loaded:true})]);
  assert.equal(f.records.active.live,true);assert.deepEqual(f.records.active.index,[]);assert.equal(f.records.bodies.size,1);
  f.calls[0].resolve({page_id:'A',thread_id:'thread-A',event:web(2,'full',{body_loaded:true})});
  await assert.rejects(pending,/任务已切换/);assert.equal((await f.records.body(f.records.active.rows[0])).data.text,'new'.repeat(300));
});

test('same event identity with a revised body does not reuse the old cached body',async()=>{
  const f=fixture();f.records.use(context(),[web(7,'old full',{body_loaded:true,body_revision:'old'})]);
  const updated=web(7,'new summary',{body_revision:'new'});f.records.use(context(),[updated]);
  const pending=f.records.body(updated);assert.equal(f.calls[0].action,'record-body');
  f.calls[0].resolve({page_id:'A',thread_id:'thread-A',event:web(7,'new full',{body_loaded:true,body_revision:'new'})});
  assert.equal((await pending).data.text,'new full');assert.equal((await f.records.body(updated)).data.text,'new full');assert.equal(f.calls.length,1);
  await assert.rejects(f.records.body(web(7,'stale',{body_revision:'old'})),/正文已更新/);
});

test('a summary revision changing while a body request is pending rejects the late old body',async()=>{
  const f=fixture(),row=web(7);f.records.use(context(),[row]);const pending=f.records.body(row);
  f.records.use(context(),[web(7,'replacement',{body_revision:'revision-new'})]);
  f.calls[0].resolve({page_id:'A',thread_id:'thread-A',event:web(7,'old full',{body_loaded:true})});
  await assert.rejects(pending,/正文已更新/);assert.equal(f.records.bodies.size,0);
});

for(const mode of ['web','codex'])test(mode+' body response from a newer saved revision cannot be cached under the old summary revision',async()=>{
    const f=fixture(),row=mode==='web'?web(7):native(7);
    f.records.use(mode==='web'?context():{mode:'codex',id:'thread-A',capable:true},[row]);
    const pending=f.records.body(row);
    f.calls[0].resolve(mode==='web'?{page_id:'A',thread_id:'thread-A',event:{...row,body_revision:'revision-new',body_loaded:true,data:{text:'new full'}}}:
      {task_key:'thread-A',row:{...row,bodyRevision:'revision-new',review:{finalSha256:'sha-new',finalText:'new full'}}});
    await assert.rejects(pending,/正文已更新|不匹配/);assert.equal(f.records.bodies.size,0);
});

test('native body cache binds trace, source thread and turn instead of only saved text hash',async()=>{
  const f=fixture(),old=native(7,'thread-A',{review:{finalSha256:'unchanged',finalText:'old full'.repeat(100)}});
  f.records.use({mode:'codex',id:'thread-A',capable:true},[old]);assert.equal(f.records.bodies.size,1);
  const row=native(7);row.source.turnId='replacement-turn';row.review.finalSha256='unchanged';f.records.use({mode:'codex',id:'thread-A',capable:true},[row]);
  const pending=f.records.body(row);assert.equal(f.calls[0].payload.traceId,row.traceId);
  f.calls[0].resolve({task_key:'thread-A',row:{...row,review:{finalSha256:'unchanged',finalText:'new full'}}});
  assert.equal((await pending).review.finalText,'new full');
});

test('native cache cannot cross a model or account binding change on the same trace and source turn',async()=>{
  for(const field of ['source.model','source.account','account']){
    const f=fixture(),old=native(7,'thread-A',{account:'A',review:{finalSha256:'unchanged',finalText:'shared full'.repeat(100)}});
    old.source={...old.source,model:'GPT-6',account:'A'};
    const ctx={mode:'codex',id:'thread-A',capable:true};f.records.use(ctx,[old]);assert.equal(f.records.bodies.size,1);
    const row={...old,source:{...old.source},review:{finalSha256:'unchanged'}};
    if(field==='account')row.account='B';else row.source[field.slice(7)]=field==='source.model'?'GPT-6.1':'B';
    f.records.use(ctx,[row]);const pending=f.records.body(row);
    assert.equal(f.calls.length,1,field+' requires a fresh body read');assert.equal(f.calls[0].payload.traceId,row.traceId);
    f.calls[0].resolve({task_key:'thread-A',row:{...row,review:{finalSha256:'unchanged',finalText:'shared full'}}});
    const full=await pending;assert.equal(full.review.finalText,'shared full');
    assert.equal(field==='account'?full.account:full.source[field.slice(7)],field==='source.model'?'GPT-6.1':'B');
    await assert.rejects(f.records.body(old),/正文已更新/);
  }
});

test('body response must match current web page, thread and event identity',async()=>{
  for(const mismatch of [{page_id:'B'},{thread_id:'thread-B'},{event:web(8,'wrong',{body_loaded:true})}]){
    const f=fixture(),row=web(7);f.records.use(context(),[row]);const pending=f.records.body(row);
    f.calls[0].resolve({page_id:'A',thread_id:'thread-A',event:web(7,'full',{body_loaded:true}),...mismatch});
    await assert.rejects(pending,/正文与当前记录不匹配/);assert.equal(f.records.bodies.size,0);
  }
});

test('native body rejects a replay from another trace, task thread or source turn',async()=>{
  for(const mutate of [r=>({...r,traceId:native(8).traceId}),r=>({...r,source:{...r.source,threadId:'thread-B'}}),r=>({...r,source:{...r.source,traceId:'another'}}),r=>({...r,source:{...r.source,turnId:'another'}})]){
    const f=fixture(),row=native(7);f.records.use({mode:'codex',id:'thread-A',capable:true},[row]);const pending=f.records.body(row);
    f.calls[0].resolve({task_key:'thread-A',row:mutate({...row,review:{finalText:'full'}})});
    await assert.rejects(pending,/不匹配/);assert.equal(f.records.bodies.size,0);
  }
});

test('failed or unavailable bodies retain the summary and never enter the body cache',async()=>{
  const f=fixture(),row=web(7);f.records.use(context(),[row]);const pending=f.records.body(row);
  f.calls[0].resolve({page_id:'A',thread_id:'thread-A',body_unavailable:true,event:{...row,body_unavailable:true}});
  await assert.rejects(pending,/完整正文暂不可用/);assert.equal(f.records.active.rows[0].data.text,'summary 7');assert.equal(f.records.bodies.size,0);
  const retry=f.records.body(row);f.calls[1].reject(Error('read failed'));await assert.rejects(retry,/read failed/);assert.equal(f.records.bodies.size,0);
});

test('body byte budget and entry limit bound cached full text while summaries stay short',()=>{
  const f=fixture({maxBodyBytes:24});f.records.use(context(),[web(1),web(2)]);
  f.records.cache(f.records.active,web(1),web(1,'12345678',{body_loaded:true}));
  f.records.cache(f.records.active,web(2),web(2,'abcdefgh',{body_loaded:true}));
  assert.equal(f.records.bodies.size,1);assert.equal(f.records.bodyBytes,16);
  f.records.cache(f.records.active,web(3),web(3,'x'.repeat(13),{body_loaded:true}));assert.equal(f.records.bodyBytes,16);
  const many=fixture();many.records.use(context(),rows(1,40).map(row=>({...row,data:{text:'full body '.repeat(100)},body_loaded:true})));
  assert.equal(many.records.bodies.size,32);assert.ok(many.records.bodyBytes<=many.records.maxBodyBytes);
  const shortened=summary('web',web(1,'x'.repeat(900),{data:{text:'x'.repeat(900),nested:{text:'hidden large'},source:'s'.repeat(900)},body_loaded:true}));
  assert.equal(shortened.data.text.length,600);assert.equal(shortened.data.source.length,600);assert.equal(shortened.data.nested,undefined);
  assert.equal(shortened.body_loaded,false);assert.equal(shortened.text_length,900);assert.equal(shortened.truncated,true);
});

test('periodic inline summaries never evict an already read long reply',async()=>{
  for(const mode of ['web','codex']){
    const f=fixture(),ctx=mode==='web'?context():{mode:'codex',id:'thread-A',capable:true};
    const seed=Array.from({length:40},(_,i)=>mode==='web'?web(i+1,'short',{body_loaded:i!==39}):
      native(i+1,'thread-A',{review:i===39?{finalSha256:'sha-40'}:{finalSha256:'sha-'+(i+1),finalText:'short'}}));
    f.records.use(ctx,seed);assert.equal(f.records.bodies.size,0);
    const pending=f.records.body(f.records.active.rows.at(-1)),fullText='complete original reply '.repeat(1000);
    const full=mode==='web'?{...seed[39],body_loaded:true,data:{text:fullText}}:
      {...seed[39],review:{...seed[39].review,finalText:fullText}};
    f.calls[0].resolve(mode==='web'?{page_id:'A',thread_id:'thread-A',event:full}:{task_key:'thread-A',row:full});
    await pending;for(let i=0;i<60;i++)f.records.use(ctx,seed);
    const read=await f.records.body(f.records.active.rows.at(-1));
    assert.equal(mode==='web'?read.data.text:read.review.finalText,fullText);
    assert.equal(f.calls.length,1);assert.equal(f.records.bodies.size,1);
  }
});

test('new records appear automatically while following and keep arriving while reading earlier rows',async()=>{
  const f=fixture();f.records.use(context(),rows(1,40));
  assert.equal(f.records.active.following,true);
  f.records.use(context(),rows(2,41));
  assert.equal(f.records.active.rows.at(-1).seq,41);assert.equal(f.records.active.newer,false);
  f.records.active.following=false;
  f.records.use(context(),rows(3,42));
  assert.equal(f.records.active.live,true);assert.equal(f.records.active.rows[0].seq,2);
  assert.equal(f.records.active.rows.at(-1).seq,42);assert.equal(f.records.active.newer,true);
  assert.equal(await f.records.follow(),true);assert.equal(f.records.active.following,true);
  assert.equal(f.records.active.newer,false);assert.equal(f.calls.length,0);
  f.records.use(context(),rows(4,43));assert.equal(f.records.active.rows.at(-1).seq,43);
  assert.equal(f.records.active.newer,false);
});

test('history and directory identity failures restore a usable selected task without stale rows',async()=>{
  const f=fixture();f.records.use(context(),[web(7)]);const history=f.records.navigate('first');
  f.calls[0].resolve(page([web(1)],{id:'B',thread:'thread-B'}));assert.equal(await history,false);
  assert.equal(f.records.active.live,true);assert.equal(f.records.active.loading,false);assert.equal(f.records.active.rows[0].seq,7);assert.match(f.records.active.error,/历史记录尚未就绪/);
  const index=f.records.directory('find');f.calls[1].resolve({page_id:'A',thread_id:'wrong-thread',items:[{seq:1}]});assert.equal(await index,false);
  assert.equal(f.records.active.indexLoading,false);assert.deepEqual(f.records.active.index,[]);assert.match(f.records.active.error,/目录暂不可用/);
});

test('an unsupported history source keeps available local summaries and sends no read request',async()=>{
  const f=fixture();f.records.use({...context(),capable:false},[web(7)]);
  assert.equal(await f.records.navigate('first'),false);assert.equal(await f.records.directory('find'),false);
  await assert.rejects(f.records.body(web(7)),/完整正文需在更新后的工作区读取/);assert.equal(f.calls.length,0);assert.equal(f.records.active.rows[0].seq,7);
});
