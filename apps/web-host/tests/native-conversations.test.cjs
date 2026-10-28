'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNativeConversations}=require('../native-conversations.cjs');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {render}=require('../codex-turns.js');
const trace='123456abcdef',url='https://chatgpt.com/c/original';
function fixture({live=true,account='A'}={}){
 const calls=[],source={traceId:trace,threadId:'01a0dc7b-2a50-7140-a55b-eed50ff96b02',turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b03',model:'chatgpt-web/high',account:'A',workingDirectory:__dirname};
 const row={traceId:trace,url,status:'completed',browserStatus:'completed',source,nativeState:{state:'completed',threadId:source.threadId,turnId:source.turnId,endedAt:'2026-10-04T10:00:00.000Z',source:'native_session_canonical',threadActive:false,activeTurnId:null,nativeProof:{version:1,kind:'canonical_full_session',threadId:source.threadId,turnId:source.turnId,terminal:'task_complete_with_matching_final',sessionSha256:'a'.repeat(64),eventSha256:'b'.repeat(64)}}};
 const tab={id:'tab1',traceId:trace,status:'running',view:{webContents:{isDestroyed:()=>false,getURL:()=>url,reload:()=>calls.push('reload')}}};
 const host={turnTabs:new Map(live?[[tab.id,tab]]:[]),visible:false,selectedTabId:'home',setBounds:b=>calls.push(['bounds',b]),selectTab(id){this.selectedTabId=id;},show(){this.visible=true;},hide(){this.visible=false;}};
 const rows=[row],bridge={host,turn:id=>id===trace?row:null,turns:()=>rows,snapshot:()=>({account})};
 const pool={native:false,pages:new Map(),create:async(...args)=>{calls.push(['create',...args]);if(!pool.pages.has(args[0]))pool.pages.set(args[0],{status:'idle',view:{webContents:{getURL:()=>args[1],isDestroyed:()=>false}}});},select:id=>calls.push(['select',id]),layout:()=>{},reload:async(id,url,options)=>{options?.assertCurrent();calls.push(['reload',id,url]);}};
 const control={dom:async wc=>({url:wc.getURL(),editor:true,controlKnown:true,generating:false,draft:false,composing:false,approvalRequired:false})};
 return {controller:createNativeConversations({getBridge:()=>bridge,pool,dom:(...args)=>control.dom(...args)}),host,pool,calls,row,rows,tab,control,bridge};
}
test('view original running tab without creating or interrupting execution',async()=>{
 const f=fixture();assert.equal((await f.controller.open(trace)).kind,'live');
 f.controller.layout({visible:true,bounds:{x:1,y:2,width:600,height:400}});
 assert.equal(f.host.selectedTabId,'tab1');assert.equal(f.host.visible,true);
 assert.equal(f.calls.some(c=>c[0]==='create'),false);
 await assert.rejects(f.controller.refresh(),/正在执行/);
 f.controller.layout({visible:false});assert.equal(f.host.visible,false);assert.equal(f.tab.status,'running');
});
test('history uses saved account even while bridge belongs to another account',async()=>{
 const f=fixture({account:'B'});await f.controller.open(trace);f.controller.layout({visible:true});
 assert.equal(f.calls.find(c=>c[0]==='create')[3].account,'A');assert.equal(f.pool.native,true);assert.equal(f.host.visible,false);
 await f.controller.refresh();assert.equal(f.calls.filter(c=>c[0]==='reload').length,1);
});
test('legacy source records keep historical B ownership',async()=>{
 const f=fixture({live:false});delete f.row.source.account;
 assert.equal((await f.controller.open(trace)).account,'B');
});
test('reopening cached history returns to saved URL after manual navigation elsewhere',async()=>{
 const f=fixture({live:false});const first=await f.controller.open(trace);
 f.pool.pages=new Map([[first.pageId,{status:'idle',view:{webContents:{getURL:()=>url+'-elsewhere'}}}]]);
 await f.controller.open(trace);
 assert.deepEqual(f.calls.find(c=>c[0]==='reload'),['reload',first.pageId,url]);
});
test('a cached history preview never reloads an active Native source or an active manual page',async()=>{
 for(const reason of ['source','page']){const f=fixture({live:false}),first=await f.controller.open(trace);f.pool.pages.get(first.pageId).view.webContents.getURL=()=>url+'-elsewhere';
  if(reason==='source')f.row.nativeState.state='running';else f.control.dom=async()=>({url:url+'-elsewhere',editor:true,controlKnown:true,generating:true,draft:false,composing:false,approvalRequired:false});
  await assert.rejects(f.controller.open(trace),/正在执行|仍在工作/);assert.equal(f.calls.some(c=>c[0]==='reload'),false);
 }
});
test('a retained startup owner without a BrowserHost remains safe to present without implying owner absence',()=>{
 const pool={layout(){},pages:new Map()},bridge={snapshot:()=>({state:'unavailable'}),host:undefined};
 const c=createNativeConversations({getBridge:()=>bridge,pool});assert.doesNotThrow(()=>c.layout({visible:true}));assert.equal(c.snapshot(),null);
});
test('unknown identity or unsafe URL cannot create a new conversation',async()=>{
 const f=fixture({live:false});delete f.row.source;
 await assert.rejects(f.controller.open(trace),/账号/);
 f.row.account='A';f.row.url='https://example.com/c/anything';
 await assert.rejects(f.controller.open(trace),/尚未保存/);
 await assert.rejects(f.controller.open('unknown'),/记录不存在/);assert.deepEqual(f.calls,[]);
});
test('reused tab identity is not enough to display an unrelated conversation',async()=>{
 const f=fixture();await f.controller.open(trace);f.tab.traceId='other';f.tab.view.webContents.getURL=()=>url+'-other';
 f.controller.layout({visible:true});assert.equal(f.controller.snapshot().available,false);assert.equal(f.host.visible,false);
 assert.equal((await f.controller.open(trace)).kind,'history');
});
test('turn card webpage button only opens view and does not resume task',()=>{
 const prev=global.document,w=createWindow('<div id="cards"></div>');global.document=w.document;
 if(!w.Element.prototype.replaceChildren)w.Element.prototype.replaceChildren=function(...children){while(this.firstChild)this.removeChild(this.firstChild);for(const c of children)this.appendChild(c);};
 if(!w.Element.prototype.append)w.Element.prototype.append=function(...children){for(const c of children)this.appendChild(c);};
 if(!('dataset' in w.Element.prototype))Object.defineProperty(w.Element.prototype,'dataset',{get(){return new Proxy({}, {set:(_,key,value)=>{this.setAttribute('data-'+key,String(value));return true;}});}});
 try{
  const f=fixture(),container=w.document.getElementById('cards');let opened=null,resumed=false;
  render(container,[f.row],{onView:id=>opened=id,onResume:()=>resumed=true});
  const button=Array.from(container.querySelectorAll('button')).find(b=>b.textContent.includes('查看对话网页'));
  assert.ok(button);assert.equal(button.disabled,false);button.click();assert.equal(opened,trace);assert.equal(resumed,false);
 }finally{global.document=prev;}
});

test('a history preview cannot refresh a running or unknown original Native thread',async()=>{
 for(const state of ['running','unavailable']){const f=fixture({live:false});await f.controller.open(trace);f.row.nativeState.state=state;await assert.rejects(f.controller.refresh(),/正在执行或回执待核对/);assert.equal(f.calls.filter(c=>c[0]==='reload').length,0);}
 const f=fixture({live:false});await f.controller.open(trace);f.rows.push({...f.row,traceId:'abcdef123456',status:'running',browserStatus:'running',source:{...f.row.source,traceId:'abcdef123456'}});await assert.rejects(f.controller.refresh(),/回执待核对/);assert.equal(f.calls.filter(c=>c[0]==='reload').length,0);
});
test('a new Native turn or preview draft during the DOM read prevents refresh without replay',async()=>{
 for(const change of ['draft','later-turn','identity']){const f=fixture({live:false});await f.controller.open(trace);f.control.dom=async wc=>{if(change==='later-turn')f.rows.push({...f.row,traceId:'abcdef123456',status:'unknown'});if(change==='identity')f.row.source={...f.row.source,turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b04'};return {url:wc.getURL(),editor:true,controlKnown:true,generating:false,draft:change==='draft',composing:false,approvalRequired:false};};await assert.rejects(f.controller.refresh(),/未刷新|待核对/);assert.equal(f.calls.filter(c=>c[0]==='reload').length,0);}
});
test('unrelated historical source attention is not an authority for the selected refresh',async()=>{const f=fixture({live:false});await f.controller.open(trace);f.rows.push({traceId:'abcdef123456',url:'https://chatgpt.com/c/other',status:'unknown',source:{threadId:'foreign'}});await f.controller.refresh();assert.equal(f.calls.filter(c=>c[0]==='reload').length,1);});
