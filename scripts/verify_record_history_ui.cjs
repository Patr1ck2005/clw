'use strict';
const {chromium}=require('../apps/web-host/node_modules/playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const output=path.resolve(process.argv[2]||'.local/record-history-ui-check');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1380,height:960}}),errors=[],timings={};page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith('file:')?r.continue():r.abort());
  await page.addInitScript(()=>{
   localStorage.clear();window.commands=[];
   const pageId='history-web',thread='history-thread',count=2200;
   const long='开头：这是保存的长回复。\n'+('正文内容保持可读，每段有明确的结论。\n'.repeat(52000))+'\n检索深处独特标记\n结尾：验收与下一步。';
   window.fullEvents=Array.from({length:count},(_,i)=>({seq:i+1,kind:i%3===0?'user_message':i%3===1?'control_received':'assistant_message',
    at:new Date(1790881200000+i*1000).toISOString(),data:{text:i===2?long:i%3===1?'网页已收到':'记录 '+(i+1)+'：'+(i%3===0?'请核对计划与结果。':'结果已保存，继续推进目标。')}}));
   const sum=e=>({...e,body_loaded:e.data.text.length<=600,text_length:e.data.text.length,body_revision:'revision-'+e.seq,
    data:{text:e.data.text.slice(0,600)},truncated:e.data.text.length>600});
   window.nativeRows=Array.from({length:count},(_,i)=>({traceId:'trace_'+String(i+1).padStart(5,'0'),status:'completed',submission:'confirmed',account:'A',
    source:{traceId:'trace_'+String(i+1).padStart(5,'0'),threadId:'native-history',turnId:'turn_'+i,workingDirectory:'D:/Example',model:'chatgpt-web/pro'},
    startedAt:new Date(1790881200000+i*1000).toISOString(),url:'https://chatgpt.com/c/fixture',bodyAvailable:true,bodyRevision:'revision-'+i,
    review:{finalPreview:i===2?long.slice(0,500):'网页回复 '+(i+1)+'：结果已经保存。',finalChars:i===2?long.length:30}}));
   const slice=(rows,p,mode)=>{
    let from=Math.max(0,rows.length-p.limit),to=rows.length;const id=r=>mode==='web'?r.seq:r.traceId;
    if(p.position==='first'){from=0;to=p.limit;}
    const before=p.before_seq??p.before_trace,after=p.after_seq??p.after_trace,around=p.around_seq??p.around_trace;
    if(before!==undefined){to=rows.findIndex(r=>id(r)===before);from=Math.max(0,to-p.limit);}
    if(after!==undefined){from=rows.findIndex(r=>id(r)===after)+1;to=from+p.limit;}
    if(around!==undefined){const n=rows.findIndex(r=>id(r)===around);from=Math.max(0,n-Math.floor(p.limit/2));to=from+p.limit;}
    to=Math.min(to,rows.length);return {values:rows.slice(from,to),total:rows.length,has_before:from>0,has_after:to<rows.length};
   };
   window.fixture={root:'D:/CLW-source',selected:pageId,pages:[{id:pageId,title:'长记录体验验证',root:'D:/Example',account:'A',kind:'task',bound:true,paused:true,access:'read',model:'GPT-6',effort:'Pro'}],closed:[],theme:'dark',connected:true,taskStateReady:true,recordHistory:{web:true,codex:true},
    view:{page_id:pageId,thread_id:thread,events:window.fullEvents.slice(-40).map(sum),record_history:{total:count,has_before:true,has_after:false}},
    codexWeb:{state:'ready',account:'A',tools:{ready:true},recent:window.nativeRows}};
   window.clw={onState:cb=>{window.updateFixture=cb;setTimeout(()=>cb(window.fixture),0);},onIntent:()=>{},command:async(action,p)=>{
    window.commands.push({action,payload:p});
    if(action==='copy-record-text'){window.copiedRecord=p.text;return {copied:true};}
    if(action==='record-body'){
     if(p.mode==='web')return {page_id:p.id,thread_id:thread,event:{...window.fullEvents.find(e=>e.seq===p.seq),body_revision:'revision-'+p.seq}};
     const row=window.nativeRows.find(r=>r.traceId===p.traceId);return {task_key:p.task_key,row:{...row,review:{...row.review,finalText:p.traceId==='trace_00003'?long:'网页回复 '+p.traceId}}};
    }
    if(action==='record-history'||action==='record-index'){
     const mode=p.mode;let rows=mode==='web'?window.fullEvents:window.nativeRows;
     if(action==='record-index')rows=rows.filter(r=>(mode==='web'?r.data.text:r.traceId==='trace_00003'?long:r.review.finalPreview).includes(p.query||''));
     const result=slice(rows,p,mode),base={...result};delete base.values;
     if(mode==='web')Object.assign(base,{page_id:p.id,thread_id:thread,first_seq:result.values[0]?.seq,last_seq:result.values.at(-1)?.seq});
     else Object.assign(base,{task_key:p.task_key,newest_trace:window.nativeRows.at(-1).traceId,oldest_trace:window.nativeRows[0].traceId});
     if(action==='record-history')base[mode==='web'?'events':'rows']=mode==='web'?result.values.map(sum):result.values;
     else base.items=result.values.map(r=>mode==='web'?{seq:r.seq,kind:r.kind,at:r.at,label:r.data.text.slice(0,110)}:{traceId:r.traceId,at:r.startedAt,label:r.review.finalPreview.slice(0,110)});
     return base;
    }
    return {};
   }};
  });
  const ready=async()=>{await page.waitForFunction(()=>!recordHistory.active?.loading);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
  let started=Date.now();await page.goto('file:///'+path.resolve('apps/web-host/index.html').replaceAll('\\','/'));await page.locator('#events>.record-message').first().waitFor();await ready();timings.initial_ms=Date.now()-started;
  assert.equal(await page.locator('#events [data-seq]').count(),40);assert.equal(await page.evaluate(()=>recordHistory.active.rows.length),40);
  const preserved=await page.locator('#events>.record-message').last().evaluate(e=>{window.preservedNode=e;return e.dataset.seq;});
  await page.evaluate(()=>window.updateFixture({...window.fixture,network:'VPN 已连接'}));await ready();
  assert.equal(await page.evaluate(()=>window.preservedNode===document.querySelector('#events>[data-seq="'+window.preservedNode.dataset.seq+'"]')),true);
  started=Date.now();await page.locator('#record-directory-toggle').click();await page.locator('#record-first').click();await ready();timings.first_ms=Date.now()-started;
  assert.equal(await page.evaluate(()=>recordHistory.active.rows[0].seq),1);
  await page.locator('#events>[data-seq="3"]>summary').click();
  const longBody=page.locator('#events>[data-seq="3"] .record-body');
  assert.ok((await longBody.innerText()).length<2600);await longBody.locator('.record-body-toggle').click();
  await page.waitForFunction(()=>document.querySelector('#events>[data-seq="3"] .text')?.textContent.length===window.fullEvents[2].data.text.length);
  assert.match(await longBody.innerText(),/检索深处独特标记/);await longBody.locator('.record-body-toggle').click();assert.ok((await longBody.innerText()).length<2600);
  await longBody.getByRole('button',{name:'复制全文'}).click();assert.equal(await page.evaluate(()=>window.copiedRecord),await page.evaluate(()=>window.fullEvents[2].data.text));
  await page.locator('#events>[data-seq="3"]>summary').click();await page.waitForFunction(()=>!document.querySelector('#events>[data-seq="3"] .text'));
  await page.keyboard.press('Control+f');await page.locator('#record-find').fill('检索深处独特标记');await page.locator('#record-find-form').evaluate(e=>e.requestSubmit());
  await page.waitForFunction(()=>!recordHistory.active.indexLoading&&recordHistory.active.index.length===1);
  await page.locator('#record-index>button').click();await ready();assert.equal(await page.locator('#events>[data-seq="3"]').getAttribute('open'),'');
  await page.locator('#record-directory-toggle').click();await page.locator('#record-find').fill('不存在的查询');await page.locator('#record-find-form').evaluate(e=>e.requestSubmit());
  await page.locator('#record-index').getByText('没有找到匹配记录。').waitFor();await page.keyboard.press('Escape');
  const early=await page.evaluate(()=>({ids:recordHistory.active.rows.map(e=>e.seq),top:document.getElementById('conversation').scrollTop}));
  await page.evaluate(()=>{const e={seq:2201,kind:'assistant_message',data:{text:'刚刚到达的新记录'}};window.fullEvents.push(e);window.fixture.view.events=window.fullEvents.slice(-40).map(row=>({...row,body_loaded:true,text_length:row.data.text.length}));window.fixture.view.record_history.total=2201;window.updateFixture(window.fixture);});await ready();
  assert.deepEqual(await page.evaluate(()=>recordHistory.active.rows.map(e=>e.seq)),early.ids);assert.match(await page.locator('#record-latest').innerText(),/有新记录/);
  assert.ok(Math.abs((await page.locator('#conversation').evaluate(e=>e.scrollTop))-early.top)<4);
  await page.locator('#record-latest').click();await ready();assert.equal(await page.evaluate(()=>recordHistory.active.rows.at(-1).seq),2201);
  for(let n=0;n<5;n++){await page.locator('#record-directory-toggle').click();await page.locator('#record-earlier').click();await ready();}assert.equal(await page.evaluate(()=>recordHistory.active.rows.length),120);
  assert.ok(await page.locator('#events [data-seq]').count()<150);await page.locator('#record-directory-toggle').click();await page.locator('#record-collapse').click();
  await page.waitForFunction(()=>document.querySelectorAll('#events details[open]').length===0);assert.equal(await page.locator('#events .text').count(),0);
  await page.screenshot({path:path.join(output,'web-history.png')});
  await page.locator('#workflow-selector>summary').click();await page.locator('#mode-codex').click();await page.locator('#codex-pages button').first().click();await ready();
  assert.equal(await page.evaluate(()=>recordHistory.active.mode),'codex');assert.equal(await page.locator('#codex-turns [data-trace]').count(),40);
  await page.locator('#record-directory-toggle').click();await page.locator('#record-first').click();await ready();assert.equal(await page.evaluate(()=>recordHistory.active.rows[0].traceId),'trace_00001');
  await page.keyboard.press('Control+f');await page.locator('#record-find').fill('检索深处独特标记');await page.locator('#record-find-form').evaluate(e=>e.requestSubmit());
  await page.waitForFunction(()=>!recordHistory.active.indexLoading&&recordHistory.active.index.length===1);await page.locator('#record-index>button').click();await ready();
  await page.waitForFunction(()=>document.querySelector('#codex-turns [data-trace="trace_00003"] .native-turn-body-content')?.textContent.includes('检索深处独特标记'));
  await page.locator('#record-directory-toggle').click();await page.locator('#record-collapse').click();await page.waitForFunction(()=>document.querySelectorAll('#codex-turns .native-turn-body-content pre').length===0);
  await page.locator('#record-latest').click();await ready();
  await page.screenshot({path:path.join(output,'native-history.png')});
  await page.setViewportSize({width:1000,height:760});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(output,'native-compact.png')});
  await page.locator('#workflow-selector>summary').click();await page.locator('#mode-web').click();await ready();assert.equal(await page.locator('#events details[open]').count(),0);
  await page.screenshot({path:path.join(output,'web-compact.png')});
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.commands.some(c=>['submit','resume','start-first-turn','codex-start','codex-resume-turn','pause','maintenance'].includes(c.action))),false);
  const result={ok:true,records:2201,long_body_chars:await page.evaluate(()=>window.fullEvents[2].data.text.length),timings,preserved_seq:preserved,commands:await page.evaluate(()=>Object.fromEntries([...new Set(window.commands.map(c=>c.action))].map(action=>[action,window.commands.filter(c=>c.action===action).length]))),page_errors:errors};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await browser.close();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
