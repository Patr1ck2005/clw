'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {BrowserPool}=require('../browser-pool.cjs');const {markdown}=require('../markdown.cjs');const {configureNetworkFlags,proxyEndpoint,NetworkGuard}=require('../network-guard.cjs');
const {WorkspaceState}=require('../workspace-state.cjs');const {WebDriver}=require('../web-driver.cjs');
const {TaskSubmission}=require('../task-submission.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');

test('resume reports time, sends and maintenance distinctly without changing task owner',async()=>{
 for(const [code,expected] of [
  ['managed_resume_window_expired',/运行时间已到期/],
  ['managed_resume_sends_exhausted',/发送次数已用完/],
  ['managed_resume_controller_paused',/主控运行仍暂停/],
  ['team_use_resume_maintenance',/维护暂停/]]){
  const runtime=new EventEmitter();runtime.ready=true;
  runtime.call=async(op,args)=>{assert.equal(op,'pause');assert.deepEqual(args,{page_id:'games',paused:false,expected_request_id:'original'});throw Error(code);};
  const driver=new WebDriver({runtime,pool:{pages:new Map()},onNotice(){}});
  await assert.rejects(()=>driver.resume({id:'games'},'original'),expected);
 }
});

test('a definitive refill readiness rejection leaves no phantom submission to reconcile',async()=>{
 const workspace={pendingStarts:{},save(){}};
 const runtime={call:async()=>{throw Error('managed_budget_needs_time_and_sends');}};
 const submission=new TaskSubmission(runtime,workspace);
 await assert.rejects(()=>submission.start('original-page','Continue original goal'),/续杯/);
 assert.deepEqual(workspace.pendingStarts,{});
});

test('closed tasks survive migration and restart without reopening or losing their conversation',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-workspace-test-'));
 try{
  const id='web-11111111-1111-4111-8111-111111111111',url='https://chatgpt.com/c/original';
  fs.writeFileSync(path.join(folder,'pages.json'),JSON.stringify([{id,url,title:'旧名称',selected:true}]));
  const allowed=u=>u.startsWith('https://chatgpt.com/');const first=new WorkspaceState(folder,allowed);
  first.update(id,{title:'新的研究任务',closed:true,closedAt:123});first.selected=null;first.theme='light';first.save();
  const recovered=new WorkspaceState(folder,allowed);
  assert.equal(recovered.selected,null);assert.equal(recovered.tasks.size,1);assert.equal(recovered.closed()[0].url,url);
  assert.equal(recovered.closed()[0].title,'新的研究任务');assert.equal(recovered.theme,'light');
  recovered.update(id,{closed:false});recovered.selected=id;recovered.save();
  const reopened=new WorkspaceState(folder,allowed);assert.equal(reopened.closed().length,0);assert.equal(reopened.selected,id);
 }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
test('recovery applies a saved close intent before creating a managed page or dispatching',async()=>{
 const runtime=new EventEmitter();runtime.ready=true;const calls=[];
 const record={page_id:'closed-worker',paused:false};
 runtime.call=async(op,p)=>{calls.push(op);if(op==='pause'){assert.equal(p.page_id,record.page_id);record.paused=true;return {};}return {pages:[record]};};
 const driver=new WebDriver({runtime,pool:{pages:new Map(),create:()=>assert.fail('closed page reopened')},isClosed:()=>true,onNotice:()=>{},dom:()=>assert.fail('closed page operated')});
 await driver.reconcileAll();await driver.reconcileAll();assert.deepEqual(calls,['list','pause','list']);
});
test('idle health checks leave the public model menu untouched; a changed model pauses before dispatch',async()=>{
 const runtime=new EventEmitter();runtime.ready=true;let offered=false;const calls=[],actions=[];
 runtime.call=async(op,p)=>{calls.push({op,p});return op==='wire'?{state:offered?'offer':'idle_or_old_request_not_adopted',attempt_id:'attempt-1'}:{};};
 const row={page_id:'page-1',phase:'bound',url:'https://chatgpt.com/c/own',model:'gpt-5.6 · 最新',effort:'极高'};
 const p={id:row.page_id,view:{webContents:{sendInputEvent(){}}}};
 const dom=async(_wc,action)=>{actions.push(action);if(action==='snapshot')return {url:row.url,editor:true,controlKnown:true,userId:'original'};if(action==='model')return {model:'GPT-6 · 最新',effort:'极高'};return {};};
 const driver=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom,input:{key:async()=>{}}});
 await driver.tick(row);assert.deepEqual(actions,['snapshot']);
 offered=true;await driver.tick(row);
 assert.ok(calls.some(x=>x.op==='page-issue'&&x.p.kind==='model_mismatch'));
 assert.ok(!calls.some(x=>x.op==='wire'&&x.p.data.action==='dispatch'));
 assert.ok(!actions.includes('send'));
});
test('a tool-confirmed turn reconciles its public browser marker without another Send',async()=>{
 const runtime=new EventEmitter(),calls=[];
 runtime.call=async(op,p)=>{calls.push({op,p});if(op==='prepared')return {assistant_before_hash:'c'.repeat(64)};if(op==='wire'&&p.data.action==='pulse')return {state:'model_received_browser_confirmation_pending',attempt_id:'control_original'};return {};};
 const row={page_id:'same-page',phase:'bound',url:'https://chatgpt.com/c/own',model:'gpt-5.6 · 最新',effort:'中'};
 const page={id:row.page_id,view:{webContents:{}}};
 const d=new WebDriver({runtime,pool:{pages:new Map([[page.id,page]]),running(){}},onNotice(){},dom:async(_wc,op)=>{assert.equal(op,'snapshot');return {url:row.url,editor:true,controlKnown:true,userId:'actual-user-turn',userText:'original goal [CLW:control_original]',attemptMarker:'[CLW:control_original]',attemptMarkerCount:1};}});
 await d.tick(row);assert.deepEqual(calls.map(x=>x.op),['wire','prepared','wire']);assert.equal(calls.at(-1).p.data.action,'sent');
 assert.equal(calls.at(-1).p.data.attempt_id,'control_original');
});

test('changed DOM identity reconciles once then collects the same result without touching model or Send',async()=>{
 const {createHash}=require('node:crypto'),hash=s=>createHash('sha256').update(s).digest('hex');
 const attempt='control_'+ 'a'.repeat(32),runtime=new EventEmitter(),calls=[];
 let userHash=hash('optimistic-id');
 runtime.call=async(op,p)=>{calls.push({op,p});if(op==='wire'&&p.data.action==='pulse')return {state:'browser_result_pending',attempt_id:attempt,sent_user_hash:userHash,assistant_before_hash:hash('before')};if(op==='reconcile-user'){assert.equal(p.previous_user_hash,userHash);userHash=p.user_hash;return {};}if(op==='artifact')return {path:'result.md'};return {state:'completed'};};
 const row={page_id:'original-page',phase:'bound',url:'https://chatgpt.com/c/original',model:'GPT-6',effort:'Pro'},p={id:row.page_id,view:{webContents:{}}};
 const driver=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:async(_wc,action)=>{assert.equal(action,'snapshot');return {url:row.url,editor:true,controlKnown:true,userId:'persisted-id',assistantId:'completed-answer',complete:true,html:'<p>original result</p>',attemptMarker:`[CLW:${attempt}]`,attemptMarkerCount:1};}});
 await driver.tick(row);assert.deepEqual(calls.map(c=>c.op),['wire','reconcile-user']);
 await driver.tick(row);driver.resultCandidates.get(attempt).at-=2000;await driver.tick(row);
 assert.equal(calls.filter(c=>c.op==='reconcile-user').length,1);assert.equal(calls.filter(c=>c.op==='wire'&&c.p.data.action==='result').length,1);
 assert.ok(!calls.some(c=>c.op==='wire'&&['dispatch','sent'].includes(c.p.data.action)));
});
test('paused pages report a ready public editor even while DOMContentLoaded is delayed',async()=>{
 const runtime=new EventEmitter();runtime.call=async()=>assert.fail('a paused task issued a command');
 const page={id:'ready-dom',status:'loading',domReady:false,view:{webContents:{getURL:()=> 'https://chatgpt.com/c/own'}}};
 const driver=new WebDriver({runtime,pool:{pages:new Map([[page.id,page]]),running(){}},onNotice(){},dom:async(_wc,op)=>{assert.equal(op,'snapshot');return {editor:true,effortLabel:'中'};}});
 await driver.tick({page_id:page.id,phase:'bound',paused:true});
 assert.equal(page.observation.effortLabel,'中');assert.equal(page.observation.editorReady,true);assert.equal(page.domReady,true);
});
test('repeated pre-send errors back off without reopening menus forever or hiding the cause',async()=>{
 const runtime=new EventEmitter(),calls=[];let menuOpens=0;
 const row={page_id:'queued',phase:'bound',url:'https://chatgpt.com/c/own',model:'gpt-5.6 · 最新',effort:'极高'};
 const page={id:row.page_id,observation:{error:'original failure'},view:{webContents:{}}};
 runtime.call=async(op,p)=>{calls.push({op,p});if(op==='wire'){if(p.data.action==='dispatch')throw Error('control_offer_expired_no_retry');return {state:'offer',attempt_id:'same-original'};}return {};};
 const driver=new WebDriver({runtime,pool:{pages:new Map([[page.id,page]]),running(){}},onNotice(){},input:{key:async()=>{}},dom:async(_wc,op)=>{
  if(op==='snapshot')return {url:row.url,editor:true,controlKnown:true,userId:'original'};
  if(op==='open-model')menuOpens++;
  if(op==='model')return {model:row.model,effort:row.effort};return {};
 }});
 await assert.rejects(()=>driver.tick(row),/control_offer_expired/);
 await driver.tick(row);assert.equal(menuOpens,1);assert.equal(page.observation.error,'original failure');
 for(let n=0;n<2;n++){driver.failures.get(page.id).next=0;await assert.rejects(()=>driver.tick(row),/control_offer_expired/);}
 assert.equal(menuOpens,3);assert.equal(calls.filter(x=>x.op==='page-issue'&&x.p.kind==='control_failed').length,1);
 await driver.tick({...row,paused:true});assert.equal(menuOpens,3);
});
test('rejected goals stay rejected and an unknown submission is reconciled after restart without sending twice',async()=>{
 let saved='{}';const workspace={pendingStarts:{},save(){saved=JSON.stringify(this.pendingStarts);}};
 const rejected=new TaskSubmission({call:async()=>({state:'rejected',code:'workspace_busy_or_unreconciled'})},workspace);
 await assert.rejects(()=>rejected.start('page','goal'),/目标没有发送/);assert.equal(Object.keys(workspace.pendingStarts).length,0);
 const calls=[];let original;
 const runtime={call:async(op,p)=>{calls.push(op);if(op==='start'){original=p.operation_id;throw Error('runtime_receipt_unknown_reconcile_original');}assert.equal(p.operation_id,original);return {state:'completed',result:{state:'queued_for_web_host',request_id:original}};}};
 await assert.rejects(()=>new TaskSubmission(runtime,workspace).start('page','goal'));
 const recovered={pendingStarts:JSON.parse(saved),save:workspace.save};
 const next=new TaskSubmission(runtime,recovered);
 await assert.rejects(()=>next.start('page','different goal'),/上一目标/);
 const result=await next.start('page','goal');assert.equal(result.request_id,original);assert.deepEqual(calls,['start','receipt']);assert.deepEqual(recovered.pendingStarts,{});
});
test('worker page pool has no five, sixteen or sixty-four page cap',async()=>{
 class View{constructor(options){this.options=options;this.webContents=Object.assign(new EventEmitter(),{setWindowOpenHandler(){},loadURL:async()=>{},getURL:()=>'',close(){},isDestroyed:()=>false});}setBounds(b){this.bounds=b;}setVisible(v){this.visible=v;}}
 const p=new BrowserPool({window:{getContentSize:()=>[1440,960],contentView:{addChildView(){},removeChildView(){}}},WebContentsView:View,partition:'test',allowedUrl:()=>true,powerSaveBlocker:{start:()=>1,stop(){}}});
 await Promise.all(Array.from({length:70},(_,n)=>p.create(String(n))));assert.equal(p.pages.size,70);assert.ok([...p.pages.values()].every(x=>x.view.visible&&x.view.bounds.width>0));
 p.running('69',true);assert.equal(p.blocker,1);p.close('69');assert.equal(p.blocker,null);
 p.work('0',true);assert.equal(p.blocker,1);p.running('0',false);assert.equal(p.blocker,1);p.work('0',false);assert.equal(p.blocker,null);
});
test('minimized zero-sized windows preserve a usable viewport for the selected worker',async()=>{
 let size=[1440,960];class View{constructor(){this.webContents=Object.assign(new EventEmitter(),{setWindowOpenHandler(){},loadURL:async()=>{},getURL:()=>'',isDestroyed:()=>false});}setBounds(b){this.bounds=b;}setVisible(){}}
 const pool=new BrowserPool({window:{getContentSize:()=>size,contentView:{addChildView(){}}},WebContentsView:View,allowedUrl:()=>true});
 const p=await pool.create('selected');pool.native=true;pool.select('selected');const before=p.view.bounds;
 size=[0,0];pool.layout();assert.deepEqual(p.view.bounds,before);assert.ok(p.view.bounds.width>800&&p.view.bounds.height>600);
 pool.viewport={x:0,y:0,width:0,height:0};pool.layout();assert.deepEqual(p.view.bounds,before);
});
test('owned keyboard input emulates renderer focus before sending keys, without OS focus',async()=>{
 const calls=[];const wc={debugger:{isAttached:()=>true,sendCommand:async(method,params)=>calls.push({method,params})}};
 await require('../page-input.cjs').key(wc,'ArrowLeft');
 assert.deepEqual(calls.map(x=>x.method),['Emulation.setFocusEmulationEnabled','Input.dispatchKeyEvent','Input.dispatchKeyEvent']);
 assert.equal(calls[0].params.enabled,true);
});
test('public DOM evaluation does not wait for the full navigation and stays in an isolated world',async()=>{
 const calls=[];const wc={executeJavaScriptInIsolatedWorld:()=>assert.fail('would wait for a stalled navigation'),debugger:{isAttached:()=>true,sendCommand:async(method,p)=>{
  calls.push({method,p});if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'own-frame'}}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:17};return {result:{value:{editor:true}}};
 }}};
 assert.deepEqual(await require('../page-input.cjs').evaluate(wc,'publicDOM()'),{editor:true});
 assert.equal(calls[1].p.frameId,'own-frame');assert.equal(calls[1].p.worldName,'clw-managed-dom');assert.equal(calls[2].p.contextId,17);
});
test('append keeps the exact original request and reconciles its receipt without resending',async()=>{
 const workspace={pendingStarts:{},save(){}};let intent;
 const runtime={call:async(op,p)=>{if(op==='start'){intent=p;throw Error('unknown receipt');}assert.equal(op,'receipt');assert.equal(p.operation_id,intent.operation_id);return {state:'completed',result:{state:'note_saved_not_native_interrupt',request_id:'original'}};}};
 const submission=new TaskSubmission(runtime,workspace);
 await assert.rejects(()=>submission.start('page','new instructions','original'));
 assert.equal(workspace.pendingStarts.page.expected_request_id,'original');
 const receipt=await submission.start('page','new instructions','changed-in-ui');
 assert.equal(receipt.request_id,'original');assert.deepEqual(workspace.pendingStarts,{});
});
test('a page whose load never finishes cannot stall pool admission or local operations',async()=>{
 class View{constructor(){this.webContents=Object.assign(new EventEmitter(),{setWindowOpenHandler(){},loadURL:()=>new Promise(()=>{}),getURL:()=>'',close(){},isDestroyed:()=>false});}setBounds(){}setVisible(){}}
 const p=new BrowserPool({window:{getContentSize:()=>[1440,960],contentView:{addChildView(){},removeChildView(){}}},WebContentsView:View,partition:'test',allowedUrl:()=>true,powerSaveBlocker:{start:()=>1,stop(){}}});
 const page=await p.create('slow','https://chatgpt.com/',{status:'idle',domReady:true});assert.equal(page.status,'loading');assert.equal(page.domReady,false);p.select('slow');p.close('slow');assert.equal(p.pages.size,0);
});
test('account pages and authentication popups stay in their own protected partition',async()=>{
 const protectedSessions=[];
 class View{constructor(options){this.options=options;this.webContents=Object.assign(new EventEmitter(),{session:{partition:options.webPreferences.partition},setWindowOpenHandler(fn){this.popup=fn;},loadURL:async()=>{},getURL:()=>'',close(){},isDestroyed:()=>false});}setBounds(){}setVisible(){}}
 const p=new BrowserPool({window:{getContentSize:()=>[1440,960],contentView:{addChildView(){},removeChildView(){}}},WebContentsView:View,partitionForAccount:a=>'persist:test-'+a,networkGuard:{ready:true,protect:async s=>protectedSessions.push(s.partition),protectContents(){}},allowedUrl:()=>true,powerSaveBlocker:{start:()=>1,stop(){}}});
 for(const account of ['A','B']){
  const page=await p.create(account,'https://chatgpt.com/',{account});
  assert.equal(page.view.options.webPreferences.partition,'persist:test-'+account);
  assert.equal(page.view.webContents.popup({url:'https://auth.openai.com/'}).overrideBrowserWindowOptions.webPreferences.partition,'persist:test-'+account);
 }
 assert.deepEqual(protectedSessions,['persist:test-A','persist:test-B']);
 assert.deepEqual(p.inspect().map(x=>x.account),['A','B']);
});
test('passive failed enrollment is reported once even while its parent is paused, without a Send',async()=>{
 const runtime=new EventEmitter();const calls=[];
 runtime.call=async(op,data)=>{calls.push({op,data});return {};};
 const row={page_id:'failed-enrollment',phase:'reserved',paused:true,bootstrap_state:'sent'};
 const page={id:row.page_id,view:{webContents:{getURL:()=> 'https://chatgpt.com/c/own'}}};
 const driver=new WebDriver({runtime,pool:{pages:new Map([[page.id,page]]),running(){}},onNotice(){},dom:async(_wc,op)=>{assert.equal(op,'snapshot');return {complete:true,publicText:'Original enrollment was blocked.'};}});
 await driver.tick(row);await driver.tick({...row,attention:'already recorded'});
 assert.equal(calls.length,1);assert.equal(calls[0].op,'page-issue');assert.equal(calls[0].data.kind,'bootstrap_receipt_missing');
});
test('a loading editor without its model control waits without spending a retry or pausing the worker',async()=>{
 const runtime=new EventEmitter();runtime.call=async()=>assert.fail('page still loading');
 const page={id:'loading-worker',view:{webContents:{getURL:()=> 'https://chatgpt.com/'}}};
 const d=new WebDriver({runtime,pool:{pages:new Map([[page.id,page]]),running(){}},onNotice(){},dom:async(_wc,op)=>{assert.equal(op,'snapshot');return {url:'https://chatgpt.com/',editor:true,controlKnown:false};}});
 await d.tick({page_id:page.id,phase:'reserved',bootstrap_state:'pending'});assert.equal(d.failures.size,0);
});
test('Markdown keeps exact LaTeX, code, table and file links',()=>{
 const source='<p>Inline <span class="katex"><math><semantics><annotation encoding="application/x-tex">x_1^2 + \\alpha</annotation></semantics></math><span>x flattened</span></span>.</p><span class="katex-display"><span class="katex"><math><semantics><annotation encoding="application/x-tex">\\int_0^1 f(x) dx</annotation></semantics></math></span></span><pre><code class="language-python">print("a_1")\n# \\path\n</code></pre><a href="D:/math/result.md">result</a><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>2</td></tr></tbody></table>';
 const result=markdown(source);assert.ok(result.includes('\\(x_1^2 + \\alpha\\)'));assert.ok(result.includes('\\[\n\\int_0^1 f(x) dx\n\\]'));assert.ok(result.includes('```python\nprint("a_1")\n# \\path\n```'));assert.ok(result.includes('[result](D:/math/result.md)'));assert.ok(result.includes('| A |'));assert.ok(!result.includes('flattened'));
 const long='x'.repeat(100000);assert.equal(markdown('<p>'+long+'</p>'),long);
});
test('captured ChatGPT code widget preserves its header as a fenced language and its exact code body',()=>{
 const captured=fs.readFileSync(path.resolve(__dirname,'../../../evidence/CONTRACT-AUDIT-20260926/native-public-3.html'),'utf8');
 const existing=markdown(captured);assert.match(existing,/```\nsample=CLW-CONTRACT-AUDIT-20260926\n/);assert.doesNotMatch(existing,/纯文本|启用自动换行/);
 const plan='{"version":1,"action":"completed","summary":"checked"}';
 const labeled=captured.replace('>纯文本</div>','>clw-plan-v1</div>').replace(/(<code class="[^"]*CodeContent-[^"]*">)[\s\S]*?(<\/code>)/,(_all,start,end)=>start+plan.replace(/"/g,'&quot;')+end);
 assert.notEqual(labeled,captured);
 const result=markdown(labeled);
 assert.match(result,/```clw-plan-v1\n\{"version":1,"action":"completed","summary":"checked"\}\n```$/);
 assert.doesNotMatch(result,/纯文本|启用自动换行|sample=CLW-CONTRACT-AUDIT/);
});
test('AI proxy never accepts the campus-direct listener or credential URLs',()=>{assert.throws(()=>proxyEndpoint('http://127.0.0.1:17891'));assert.throws(()=>proxyEndpoint('http://user:secret@127.0.0.1:17890'));assert.throws(()=>proxyEndpoint('https://remote.test:443'));});
test('all Chromium traffic uses fixed proxy with DNS and WebRTC direct paths disabled',async()=>{
 const flags={};configureNetworkFlags({commandLine:{appendSwitch:(key,value)=>flags[key]=value}});assert.equal(flags['proxy-server'],'http://127.0.0.1:17890');assert.equal(flags['proxy-bypass-list'],'<-loopback>');assert.ok(flags['host-resolver-rules'].includes('MAP * ~NOTFOUND'));assert.equal(flags['force-webrtc-ip-handling-policy'],'disable_non_proxied_udp');
 let config;const ses={setProxy:async c=>config=c,closeAllConnections:async()=>{},setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onBeforeRequest(){}},resolveProxy:async()=> 'DIRECT'};const guard=new NetworkGuard();await assert.rejects(()=>guard.protect(ses));assert.equal(config.mode,'fixed_servers');assert.equal(guard.ready,false);
});

test('native directory conflict identifies its package and preserves unsent input',async()=>{
 const workspace={pendingStarts:{},save(){}};
 const submission=new TaskSubmission({call:async()=>({state:'rejected',code:'workspace_busy_or_unreconciled',
   blocker:{kind:'native_work',state:'running',workspace:'D:/Games/tenet',result_path:'D:/Games/tenet/.local/demo-check'}})},workspace);
 await assert.rejects(()=>submission.start('games','continue original'),error=>
   error.message.includes('demo-check')&&error.message.includes('D:/Games/tenet')&&error.message.includes('本目标未发送'));
 assert.deepEqual(workspace.pendingStarts,{});
});
