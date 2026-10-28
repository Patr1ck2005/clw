const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {installTurnJournal,failureForDisplay}=require('../turn-journal.cjs');
test('all saved conversations remain addressable beyond recent 20 and new turns retain account',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-history-list-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'turns'));
 for(let i=0;i<25;i++)fs.writeFileSync(path.join(home,'turns',`old-${i}.json`),JSON.stringify({traceId:`old-${i}`,status:'completed',startedAt:`2026-09-${String(i+1).padStart(2,'0')}`}));
 const wc=new EventEmitter();wc.getURL=()=> 'https://chatgpt.com/c/new';const tab={id:'tab',view:{webContents:wc}};
 const host={turnTabs:new Map([['tab',tab]]),async beginTurn(trace){tab.traceId=trace;return {tabId:'tab'};},async endTurn(){}};
 const journal=installTurnJournal(host,home,{account:'A'});
 assert.equal(journal.list().length,25);assert.equal(journal.recent().length,20);assert.equal(journal.get('old-0').traceId,'old-0');assert.equal(journal.get('unknown'),null);
 await host.beginTurn('new');assert.equal(journal.get('new').account,'A');
 assert.equal(JSON.parse(fs.readFileSync(path.join(home,'turns/new.json'),'utf8')).account,'A');
});
test('running turn uses exact durable Send proof without waiting for its final answer',t=>{
 const {submissionForDisplay}=require('../turn-journal.cjs');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-send-display-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const row={traceId:'123456abcdef',status:'running',submission:'not-observed'},dir=path.join(home,'diagnostics/browser-turns',row.traceId+'-one');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'19-send-accepted.json');fs.writeFileSync(file,JSON.stringify({traceId:row.traceId,checkpoint:'send-accepted'}));
 assert.equal(submissionForDisplay(home,row).submission,'confirmed');assert.equal(row.submission,'not-observed');
 fs.writeFileSync(file,JSON.stringify({traceId:'000000000000',checkpoint:'send-accepted'}));assert.equal(submissionForDisplay(home,row).submission,'not-observed');
 fs.writeFileSync(file,JSON.stringify({traceId:row.traceId,checkpoint:'send-ready'}));assert.equal(submissionForDisplay(home,row).submission,'not-observed');
});
test('native public login and quota stops use the shared reasons without claiming no Send',()=>{
 const {turnView}=require('../../web-host/codex-turns.js');
 for(const [flag,kind] of [['loginRequired','login_required'],['usageLimited','usage_limit']]){
  const row={traceId:'123456abcdef',status:'failed',submission:'unconfirmed',publicState:{[flag]:true}};
  const failure=failureForDisplay('',row);assert.equal(failure.kind,kind);assert.equal(failure.beforeSend,false);
  const view=turnView({...row,failure});assert.equal(view.sent,'送达待核对');assert.match(view.note,kind==='login_required'?/登录/:/额度/);
  assert.equal(failureForDisplay('',{...row,status:'completed'}),null);
 }
});

test('only a matching navigation checkpoint explains an unsent failure',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-navigation-receipt-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const traceId='123456abcdef',dir=path.join(home,'diagnostics/browser-turns',traceId+'-case');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'02-turn-failed.json');
 fs.writeFileSync(file,JSON.stringify({traceId,checkpoint:'turn-failed',error:'page.goto: Timeout 60000ms exceeded.'}));
 const row={traceId,status:'failed',submission:'not-observed'};
 assert.equal(failureForDisplay(home,row).beforeSend,true);
 assert.equal(failureForDisplay(home,{...row,submission:'unconfirmed'}).beforeSend,false);
 fs.writeFileSync(file,JSON.stringify({traceId:'000000000000',checkpoint:'turn-failed',error:'page.goto: Timeout 60000ms exceeded.'}));
 assert.equal(failureForDisplay(home,row),null);
 const {turnView}=require('../../web-host/codex-turns.js');
 const view=turnView({...row,failure:{kind:'page_navigation_timeout',beforeSend:true}});
 assert.equal(view.sent,'尚未发送');assert.match(view.note,/打开网页超时/);
 assert.doesNotMatch(view.note,/安全.*拒绝|VPN/);
});
test('a new owner and explicit shutdown preserve unknown execution instead of claiming it is still running or retryable',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-turn-owner-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'turns'));
 fs.writeFileSync(path.join(home,'turns/previous.json'),JSON.stringify({traceId:'previous',status:'running',url:'https://chatgpt.com/c/original',submission:'confirmed'}));
 const wc=new EventEmitter();wc.getURL=()=> 'https://chatgpt.com/';const tab={id:'live',helperPid:1,view:{webContents:wc}};
 const host={turnTabs:new Map([['live',tab]]),async beginTurn(trace){tab.traceId=trace;return {tabId:'live'};},async endTurn(){}};
 const journal=installTurnJournal(host,home);const previous=journal.recent()[0];
 assert.equal(previous.status,'needs_reconciliation');assert.equal(previous.submission,'confirmed');assert.equal(previous.automaticReplay,false);
 await host.beginTurn('current');journal.ownerClosed();
 const current=journal.recent().find(r=>r.traceId==='current');assert.equal(current.status,'needs_reconciliation');assert.equal(current.submission,'not-observed');assert.equal(current.reason,'browser_owner_closed');
});
test('retained native tab navigation belongs to the current trace and preserves prior receipts',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-turn-journal-'));
 try{
  let url='https://chatgpt.com/';const wc=new EventEmitter();wc.getURL=()=>url;
  const tab={id:'tab-1',helperPid:123,view:{webContents:wc}},host={turnTabs:new Map([['tab-1',tab]]),async beginTurn(trace){tab.traceId=trace;return {tabId:tab.id};},async endTurn(){return {cancelledByUser:false};}};
  const journal=installTurnJournal(host,home);
  await host.beginTurn('trace-a');url='https://chatgpt.com/c/chat-a';wc.emit('did-navigate');
  const d=path.join(home,'diagnostics/browser-turns/trace-a-test');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'01-submission-accepted.json'),'{}');
  await host.endTurn('trace-a',123,'completed');
  await host.beginTurn('trace-b');url='https://chatgpt.com/c/chat-b';wc.emit('did-navigate-in-page');await host.endTurn('trace-b',123,'aborted');
  const rows=new Map(journal.recent().map(x=>[x.traceId,x]));
  assert.equal(rows.get('trace-a').url,'https://chatgpt.com/c/chat-a');assert.equal(rows.get('trace-a').submission,'confirmed');
  assert.equal(rows.get('trace-b').url,url);assert.equal(rows.get('trace-b').status,'aborted');assert.equal(wc.listenerCount('did-navigate'),1);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('destroyed browser page stops its current work label without altering the prior completed turn',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-page-exit-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const wc=new EventEmitter();wc.getURL=()=> 'https://chatgpt.com/c/original';
 const tab={id:'tab',helperPid:5,view:{webContents:wc}},host={turnTabs:new Map([['tab',tab]]),
  async beginTurn(trace){tab.traceId=trace;return {tabId:tab.id};},async endTurn(){}};
 const journal=installTurnJournal(host,home);await host.beginTurn('old');await host.endTurn('old',5,'completed');
 await host.beginTurn('current');wc.emit('render-process-gone');
 assert.equal(journal.get('current').status,'needs_reconciliation');assert.equal(journal.get('current').reason,'browser_page_closed');
 assert.equal(journal.get('current').automaticReplay,false);assert.equal(journal.get('old').status,'completed');
});

test('native owner loss labels only live turns for reconciliation without rewriting completed work',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-native-owner-journal-'));
 try{
  const wc=new EventEmitter();wc.getURL=()=> 'https://chatgpt.com/c/current';
  const tab={id:'current-tab',traceId:'live-native',view:{webContents:wc}};
  const host={turnTabs:new Map([[tab.id,tab]]),async beginTurn(){return {tabId:tab.id};},async endTurn(){}};
  const journal=installTurnJournal(host,home);
  await host.beginTurn();
  journal.ownerClosed('native_owner_closed');
  const row=journal.recent().find(item=>item.traceId==='live-native');
  assert.equal(row.status,'needs_reconciliation');
  assert.equal(row.reason,'native_owner_closed');
  assert.equal(row.automaticReplay,false);
  journal.ownerClosed('browser_owner_closed');
  assert.equal(journal.recent().find(item=>item.traceId==='live-native').reason,'native_owner_closed');
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
