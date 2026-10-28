'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {WebDriver}=require('../web-driver.cjs');
const URL='https://chatgpt.com/c/original';
const existingConnectorDom=read=>async(wc,action,arg)=>{
 if(action==='connector-state')return {editorCount:1,text:'',selected:['Local-MCP-B'],visibleSelectedCount:1};
 const value=await read(wc,action,arg);return action==='snapshot'?{url:URL,...value}:value;
};
function inputPage(d){const p={id:'original-input',view:{webContents:{getURL:()=>URL}}};d.pool.pages.set(p.id,p);return p;}
function driver(options={}){return new WebDriver({runtime:new EventEmitter(),pool:{pages:new Map()},onNotice(){},sleep:async()=>{},...options,
 ...(options.dom?{dom:existingConnectorDom(options.dom)}:{})});}
test('shutdown during a public snapshot does not issue a late runtime poll',async()=>{
 const runtime=new EventEmitter();runtime.call=async()=>assert.fail('late runtime call');
 const page={id:'original',view:{webContents:{}}};
 const d=driver({runtime,pool:{pages:new Map([[page.id,page]])},dom:async()=>{d.stop();return {url:'https://chatgpt.com/c/original',userId:'user'};}});
 await d.tick({page_id:page.id,phase:'bound',paused:true});assert.equal(d.busy.size,0);
});

test('shutdown after composer verification fences Send without fabricating a receipt',async()=>{
 const marker='[CLW:control_'+ 'e'.repeat(32)+']',prompt='goal '+marker;let sends=0;
 const d=driver({dom:async(_wc,action)=>{
  if(action==='editor-text')return {text:prompt};
  if(action==='snapshot'){d.stop();return {url:URL,userId:'old'};}
  if(action==='send')sends++;
 }});
 await assert.rejects(d.send(inputPage(d),prompt,{url:URL,userId:'old'},marker),e=>e.code==='workspace_stopping'&&e.notSent===undefined);
 assert.equal(sends,0);
});

test('shutdown after an accepted click still observes the original receipt without another Send',async()=>{
 const marker='[CLW:control_'+ 'd'.repeat(32)+']',prompt='goal '+marker;let sends=0;
 const d=driver({dom:async(_wc,action)=>{
  if(action==='editor-text')return {text:prompt};
  if(action==='send'){sends++;d.stop();}
  if(action==='snapshot')return sends?{userId:'original-accepted',draft:false,attemptMarker:marker,attemptMarkerCount:1}:{url:URL,userId:'old'};
 }});
 const original=await d.send(inputPage(d),prompt,{url:URL,userId:'old'},marker);
 assert.equal(original.userId,'original-accepted');assert.equal(sends,1);
});
test('Windows line endings are normalized before insertion without accepting altered spaces',async()=>{
  const marker='[CLW:control_'+ 'f'.repeat(32)+']',prompt='goal\r\n```text\r\n  indented\r\n```\n'+marker;
  let inserted='',sends=0;
  const d=driver({dom:async(_wc,action,arg)=>{
    if(action==='insert-plain-text')inserted=arg.text;
    if(action==='editor-text')return {text:inserted};
    if(action==='send')sends++;
    if(action==='snapshot')return sends?{userId:'new',draft:false,attemptMarker:marker,attemptMarkerCount:1}:{url:URL,userId:'old'};
  }});
  await d.send(inputPage(d),prompt,{url:URL,userId:'old'},marker);
  assert.equal(inserted,prompt.replace(/\r\n/g,'\n'));assert.equal(sends,1);
  sends=0;
  d.dom=existingConnectorDom(async(_wc,action)=>{
    if(action==='editor-text')return {text:prompt.replace(/\r/g,' ')};
    if(action==='snapshot')return {userId:'old',draft:true};
    if(action==='send')sends++;
  });
  await assert.rejects(()=>d.send(inputPage(d),prompt,{url:URL,userId:'old'},marker),e=>e.code==='editor_prompt_mismatch');
  assert.equal(sends,0);
});
test('an unrelated user message cannot confirm an accepted Send; a matching message confirms once',async()=>{
  let reads=0,sends=0;const marker='[CLW:control_'+ 'a'.repeat(32)+']';
  const d=driver({dom:async(_wc,action,arg)=>{
    if(action==='editor-text')return {text:'goal '+marker};
    if(action==='send')assert.equal(arg.expectedText,'goal '+marker);
    if(action==='send')sends++;
    if(action==='snapshot')return ++reads<=2?{userId:'old',draft:false}:reads===3?{userId:'unrelated',draft:false,userText:'manual message'}:{userId:'ours',draft:false,userText:'goal '+marker,attemptMarker:marker,attemptMarkerCount:1};
  }});
  const observed=await d.send(inputPage(d),'goal '+marker,{url:URL,userId:'old'},marker);
  assert.equal(observed.userId,'ours');assert.equal(sends,1);assert.equal(reads,4);
});
test('a unique trailing attempt marker confirms a long collapsed public user turn',async()=>{
  let sends=0;const marker='[CLW:control_'+ 'd'.repeat(32)+']';
  const prompt='first paragraph\nsecond paragraph\n'+marker;
  const d=driver({dom:async(_wc,action,arg)=>{
    if(action==='editor-text')return {text:prompt};
    if(action==='send'){assert.equal(arg.expectedText,prompt);sends++;}
    if(action==='snapshot')return sends
      ?{userId:'new',draft:false,userText:prompt+'…显示更多',attemptMarker:marker,attemptMarkerCount:1}
      :{userId:'old',draft:false};
  }});
  const observed=await d.send(inputPage(d),prompt,{url:URL,userId:'old'},marker);
  assert.equal(observed.userId,'new');assert.equal(sends,1);
});
test('an unknown Send is never retried and cannot accept a stale marker or user draft',async()=>{
  let sends=0;const d=driver({dom:async(_wc,action)=>{
    if(action==='send')sends++;
    if(action==='editor-text')return {text:'[CLW:ours]'};
    if(action==='snapshot')return sends?{userId:'another',draft:false,userText:'[CLW:different-attempt]',complete:false}:{userId:'old',draft:false};
  }});
  await assert.rejects(()=>d.send(inputPage(d),'[CLW:ours]',{url:URL,userId:'old'},'[CLW:ours]'),/发送结果未知/);
  assert.equal(sends,1);
});
test('an incomplete composer cannot trigger Send, even when its first line is intact',async()=>{
  let sends=0,reads=0;const marker='[CLW:control_'+ 'b'.repeat(32)+']';
  const d=driver({dom:async(_wc,action)=>{
    if(action==='editor-text'){reads++;return {text:'CLW 简洁协作 v1。'};}
    if(action==='snapshot')return {userId:'old',draft:true};
    if(action==='send')sends++;
  }});
  await assert.rejects(()=>d.send(inputPage(d),'CLW 简洁协作 v1。\nB.md\n'+marker,{url:URL,userId:'old'},marker),e=>e.code==='editor_prompt_mismatch');
  assert.equal(reads,100);assert.equal(sends,0);
});
test('a completed foreign public turn after one click is reported without a second Send',async()=>{
  let sends=0;const marker='[CLW:control_'+ 'c'.repeat(32)+']';
  const d=driver({dom:async(_wc,action)=>{
    if(action==='editor-text')return {text:'goal\n'+marker};
    if(action==='snapshot')return sends?{userId:'partial',draft:false,userText:'goal',complete:true,historyAtLatest:true,generating:false}:{userId:'old',draft:false};
    if(action==='send')sends++;
  }});
  await assert.rejects(()=>d.send(inputPage(d),'goal\n'+marker,{url:URL,userId:'old'},marker),e=>e.code==='public_send_identity_mismatch'&&e.snapshot.userId==='partial');
  assert.equal(sends,1);
});
test('a complete markerless worker turn is handed off once with its original identities',async()=>{
  const calls=[],runtime=new EventEmitter();
  runtime.call=async(op,p)=>{calls.push([op,p]);return op==='prepared'?{previous_user_hash:'a'.repeat(64),assistant_before_hash:'b'.repeat(64)}:{state:'partial_or_foreign_public_send'};};
  const d=driver({runtime});
  const p={id:'worker-B'},r={url:'https://chatgpt.com/c/worker-B',collaboration_protocol:'text_v1'};
  const s={url:r.url,userId:'group:user:fallback-turn-1:0:user',assistantId:'group:assistant:fallback-turn-1:2:assistant',userText:'CLW 简洁协作 v1。',userTextComplete:true,html:'<div class="markdown"><p>Acknowledged.</p></div>',complete:true,historyAtLatest:true,generating:false,draft:false,composing:false};
  assert.equal(await d.capturePartialPublicSend(p,r,'control_'+ 'e'.repeat(32),s),true);
  assert.deepEqual(calls.map(([op])=>op),['prepared','partial-public-send']);
  assert.equal(calls[1][1].previous_user_hash,'a'.repeat(64));
  assert.equal(calls[1][1].user_text,s.userText);
  assert.equal(calls[1][1].assistant_text,'Acknowledged.');
  assert.equal(calls[1][1].user_text_complete,true);
  assert.equal(p.status,'公开网页消息不完整，原任务待核对');
});
test('model inheritance compares normalized labels on both sides without changing a model',async()=>{
  const d=driver({input:{key:async(_wc,key)=>assert.equal(key,'Escape')},dom:async()=>assert.fail('matching model must not be changed')});d.inspect=async()=>({model:'GPT-5.6 · 最新',effort:'极高'});
  for(const model of ['gpt-5.6 · 最新','GPT-5.6 · 最新'])assert.equal((await d.selectModel({view:{webContents:{getURL:()=>URL}}}, {model,effort:'极高'})).model,'GPT-5.6 · 最新');
});
