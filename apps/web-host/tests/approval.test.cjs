'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {publicApproval}=require('../public-approval.cjs'),{ApprovalManager}=require('../approval-manager.cjs');
const {connectorForAccount,connectorNames}=require('../connector-identity.cjs');
const {dom}=require('../page-dom.cjs');
const {WebDriver}=require('../web-driver.cjs'),{EventEmitter}=require('node:events');
const {createHash}=require('node:crypto');
const user=id=>`<div data-turn-key="${id}"><div data-user-message-bubble>Work</div></div>`;
const card=(attrs='',button='Allow once<kbd>⏎</kbd>',app='Local-MCP-B')=>`<section ${attrs}><span>${app}</span><h3>允许文件实体化？</h3><p>ChatGPT 需要你的批准，才能对 ${app} 返回的 1 个文件附件进行实体化。</p><button>Deny<kbd>Esc</kbd></button><button>${button}</button></section>`;
function surface(html){
 const window=createWindow(html);let clicks=0;
 Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.closest('[hidden],[inert]')?0:100;}});
 Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return this.offsetWidth?20:0;}});
 window.HTMLElement.prototype.getClientRects=function(){return this.offsetWidth?[{}]:[];};
 for(const list of [window.document.querySelectorAll('button'),window.document.body.children])Object.defineProperty(Object.getPrototypeOf(list),Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
 for(const b of window.document.querySelectorAll('button'))b.addEventListener('click',()=>clicks++);
 window.document.hasFocus=()=>true;
 const context=vm.createContext({document:window.document,Node:window.Node,location:{href:'https://chatgpt.com/c/owned'}});
 return {window,clicks:()=>clicks,evaluate:async source=>vm.runInContext(source,context),inspect:()=>vm.runInContext(`(${publicApproval.toString()})()`,context),snapshot:()=>vm.runInContext(`(${dom.toString()})('snapshot',{},()=>{},()=>false,()=>(${publicApproval.toString()})())`,context)};
}
test('current Chinese file card survives adjacent keyboard glyphs; exact confirmation does not submit a message',async()=>{
 const p=surface(user('u1')+card());const s=p.inspect();assert.equal(s.required,true);assert.equal(s.eligible,true);assert.equal(s.connector,'Local-MCP-B');assert.equal(s.userId,'group:user:u1');
 await p.evaluate(`(${publicApproval.toString()})('allow-once',${JSON.stringify(s)})`);assert.equal(p.clicks(),1);
 const english=surface(user('u1')+card().replace(/允许文件实体化？/g,'Allow file materialization?').replace(/文件附件/g,'file attachments'));
 assert.equal(english.inspect().eligible,true);
});
test('the actual A public file card has the exact Local-MCP identity; aliases and mixed names are refused',()=>{
 const current=surface(user('u1')+card('','Allow once','Local-MCP')).inspect();
 assert.equal(current.required,true);assert.equal(current.eligible,true);assert.equal(current.connector,'Local-MCP');
 for(const name of ['Local-MCP-A','Local-MCP-A legacy','Local-MCP-Beta','Local-MCP-B-copy','Local-MCP.extra','myLocal-MCP','Local-MCP copy','Codex Native2','CLW T003 Stable No-OIDC']){
  const s=surface(user('u1')+card('','Allow once',name)).inspect();
  assert.equal(s.required,true,name);assert.equal(s.eligible,false,name);assert.equal(s.connector,'',name);
 }
 for(const html of [
  card('','Allow once','Local-MCP').replace('</section>','<span>Local-MCP-B</span></section>'),
  card('','Allow once','Local-MCP').replace('对 Local-MCP 返回的','对 Local-MCP-B 返回的'),
  card('','Allow once','Local-MCP').replace('对 Local-MCP 返回的','对 CLW T003 Stable No-OIDC 返回的'),
  card('','Allow once','Local-MCP').replace('对 Local-MCP 返回的','对 Codex Native2 返回的'),
  card('','Allow once','Local-MCP').replace('<span>Local-MCP</span>','<span>Local-MCP-A</span>'),
 ]){const s=surface(user('u1')+html).inspect();assert.equal(s.eligible,false);assert.equal(s.connector,'');}
});
test('Unicode names cannot acquire approval authority alongside a legitimate connector label',()=>{
 for(const connector of connectorNames()){
  const valid=card('','允许一次',connector);
  assert.equal(surface(user('u1')+valid).inspect().eligible,true,'the real Chinese returned-file description remains eligible');
  for(const name of ['假'+connector,connector+'新版',connector+'\u0301',connector+'—新版',connector+'\u200b新版','假\u200b'+connector]){
   const s=surface(user('u1')+valid.replace('</section>','<span>'+name+'</span></section>')).inspect();
   assert.equal(s.required,true,name);assert.equal(s.eligible,false,name);assert.equal(s.connector,'',name);
  }
 }
});
test('A file confirmation uses the configured whitelist and cannot substitute the other account',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-approval-a-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const p=surface(user('u1')+card('','Allow once','Local-MCP')),s=p.inspect(),file=path.join(folder,'events.jsonl');
 const manager=new ApprovalManager({journalFile:file,connectors:connectorNames()});
 const target={id:'owned-a',requestId:'original-a',userId:s.userId,url:s.url,connector:connectorForAccount('A'),authorized:()=>true,evaluate:p.evaluate};
 for(const change of [{connector:connectorForAccount('B')},{connector:'Local-MCP-A'},{userId:'group:user:other'},{url:s.url+'/other'}]){
  assert.equal((await manager.inspect({...target,...change})).state,'needs_confirmation');assert.equal(p.clicks(),0);
 }
 assert.equal((await manager.inspect(target)).state,'allowed_once');assert.equal(p.clicks(),1);
 const restored=new ApprovalManager({journalFile:file,connectors:connectorNames()});
 assert.equal((await restored.inspect(target)).state,'original_confirmation_pending');assert.equal(p.clicks(),1);
 const events=fs.readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(events.length,2);assert.equal(events[0].page,'owned-a');assert.equal(events[0].request,'original-a');assert.equal(events[0].connector,'Local-MCP');assert.equal(events[1].key,events[0].key);
});
test('hidden, historical, quoted, foreign and denied cards never acquire approval authority',()=>{
 for(const html of [user('u1')+card('hidden'),card()+user('u2'),user('u1')+'<div class="markdown">'+card()+'</div>'])assert.equal(surface(html).inspect().required,false);
 const wrong=surface(user('u1')+card('','Allow once','Unrelated app')).inspect();assert.equal(wrong.eligible,false);
 const denied=surface(user('u1')+card().replace('</h3>','</h3><p>安全检查已拦截</p>')).inspect();assert.equal(denied.eligible,false);
 const ambiguous=surface(user('u1')+card()+card('','Allow once','Local-MCP')).inspect();assert.equal(ambiguous.eligible,false);
 const tool=surface(user('u1')+'<div role="dialog">Allow ChatGPT to use Local-MCP-B?<button>Deny</button><button>Allow</button></div>').inspect();assert.equal(tool.required,true);assert.equal(tool.kind,'tool');assert.equal(tool.eligible,true);
 for(const name of ['Local-MCP-Beta','Local-MCP-A','Local-MCP-B copy']){
  const foreign=surface(user('u1')+`<div role="dialog">Allow ChatGPT to use ${name}?<button>Deny</button><button>Allow</button></div>`).inspect();assert.equal(foreign.eligible,false,name);
 }
});
test('full task consent prefers persistent permission and supports persistent-only cards',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-approval-persistent-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 for(const [index,label] of ['Always allow','始终允许'].entries())for(const only of [true,false]){
  const p=surface(user('u1')+card('',label)+(only?'':''));
  if(!only){const section=p.window.document.querySelector('section'),button=p.window.document.createElement('button');button.textContent='Allow once';section.appendChild(button);}
  const picked=[];for(const button of p.window.document.querySelectorAll('button'))button.addEventListener('click',()=>picked.push(button.textContent));
  const s=p.inspect();assert.equal(s.required,true);assert.equal(s.eligible,true);
  const manager=new ApprovalManager({journalFile:path.join(folder,index+'-'+only+'.jsonl'),connectors:connectorNames()});
  assert.equal((await manager.inspect({id:'owned',requestId:'original',url:s.url,userId:s.userId,connector:s.connector,authorized:()=>true,evaluate:p.evaluate})).state,'allowed_once');
  assert.equal(picked.length,1);assert.ok(picked[0].startsWith(label));
 }
});
test('authorization is live, and an unknown click receipt never clicks again after process restart',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-approval-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const file=path.join(folder,'events.jsonl'),p=surface(user('u1')+card());let enabled=false;
 const target={id:'page',requestId:'request',url:'https://chatgpt.com/c/owned',connector:'Local-MCP-B',authorized:()=>enabled,evaluate:p.evaluate};
 let m=new ApprovalManager({journalFile:file,connectors:['Local-MCP-B']});
 await m.inspect(target);assert.equal(p.clicks(),0);assert.equal(fs.existsSync(file),false);
 enabled=true;target.evaluate=async s=>{const r=await p.evaluate(s);if(s.includes('"allow-once"'))throw Error('lost receipt');return r;};
 assert.equal((await m.inspect(target)).state,'original_confirmation_pending');assert.equal(p.clicks(),1);
 m=new ApprovalManager({journalFile:file,connectors:['Local-MCP-B']});await m.inspect(target);assert.equal(p.clicks(),1);
 const log=fs.readFileSync(file,'utf8');assert.doesNotMatch(log,/ChatGPT 需要|signature|文件附件/);
});
test('multiple confirmations from the same current task are acknowledged in order with distinct original receipts',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-approval-multi-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const ids=['42643a91-efd4-434e-a648-0e92461f8982','42643a91-efd4-434e-a648-0e92461f8983'];
 const p=surface(user('u1')+ids.map(id=>`<div data-chatgpt-search-message-ids="${id}">${card()}</div>`).join(''));
 for(const button of p.window.document.querySelectorAll('section button'))if(button.textContent.startsWith('Allow'))button.addEventListener('click',()=>button.closest('[data-chatgpt-search-message-ids]').remove());
 const first=p.inspect(),manager=new ApprovalManager({journalFile:path.join(folder,'events.jsonl'),connectors:connectorNames()});
 const target={id:'owned',requestId:'original',url:first.url,userId:first.userId,connector:first.connector,authorized:()=>true,evaluate:p.evaluate};
 assert.equal((await manager.inspect(target)).state,'allowed_once');assert.equal((await manager.inspect(target)).state,'allowed_once');
 assert.equal((await manager.inspect(target)).required,false);assert.equal(p.clicks(),2);
 const rows=fs.readFileSync(path.join(folder,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(new Set(rows.filter(r=>r.event==='allow_once_attempted').map(r=>r.key)).size,2);
});

test('ordinary MCP tool confirmation uses its own explicit policy and never replays an unknown click',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-tool-approval-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const tool=()=>surface(user('u1')+'<section><span>Local-MCP-B</span><h3>Allow ChatGPT to use Local-MCP-B?</h3><button>Deny</button><button>Allow once</button></section>');
 const p=tool(),s=p.inspect(),file=path.join(folder,'events.jsonl');
 assert.equal(s.kind,'tool');assert.equal(s.eligible,true);
 let enabled=false;
 const target={id:'owned',requestId:'original',userId:s.userId,url:s.url,connector:s.connector,
  authorized:kind=>kind==='returned_file'||enabled,evaluate:p.evaluate};
 let manager=new ApprovalManager({journalFile:file,connectors:connectorNames()});
 assert.equal((await manager.inspect(target)).state,'needs_confirmation');assert.equal(p.clicks(),0);
 enabled=true;target.evaluate=async source=>{const result=await p.evaluate(source);if(source.includes('"allow-once"'))throw Error('lost receipt');return result;};
 assert.equal((await manager.inspect(target)).state,'original_confirmation_pending');assert.equal(p.clicks(),1);
 manager=new ApprovalManager({journalFile:file,connectors:connectorNames()});
 await manager.inspect(target);assert.equal(p.clicks(),1);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8').split('\n')[0]).kind,'tool');
});
test('changed URL, identity or connector and disabled policy cannot approve',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-approval-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const p=surface(user('u1')+card()),s=p.inspect();
 await assert.rejects(()=>p.evaluate(`(${publicApproval.toString()})('allow-once',${JSON.stringify({...s,signature:'other'})})`),/identity_changed/);
 const target={id:'page',requestId:'request',url:s.url,connector:'Local-MCP-B',authorized:()=>true,evaluate:p.evaluate};
 const m=new ApprovalManager({journalFile:path.join(folder,'events.jsonl')});await m.inspect(target);assert.equal(p.clicks(),0);
 const enabled=new ApprovalManager({journalFile:path.join(folder,'events2.jsonl'),connectors:['Local-MCP-B']});await enabled.inspect({...target,url:s.url+'/other'});await enabled.inspect({...target,connector:'Local-MCP-A'});assert.equal(p.clicks(),0);
});

function managedFileFixture(t,account='B',kind='returned_file'){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-driver-approval-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const connector=connectorForAccount(account);
 const page=surface(user('u1')+(kind==='tool'?`<section><span>${connector}</span><h3>Allow ChatGPT to use ${connector}?</h3><button>Deny</button><button>Allow once</button></section>`:card('','允许一次<kbd>⏎</kbd>',connector)));
 const id='owned',attempt='control_'+'1'.repeat(32),url='https://chatgpt.com/c/owned';
 const snapshot={url,userId:'group:user:u1',editor:true,approvalRequired:true,attemptMarker:'[CLW:'+attempt+']',attemptMarkerCount:1};
 const record={page_id:id,account,phase:'bound',url,paused:false,latest_request:{id:'original-request',phase:'processing',attempt_id:attempt,sent_user_hash:createHash('sha256').update(snapshot.userId).digest('hex')}};
 const target={id,account,closed:false,documentGeneration:1,view:{webContents:{getURL:()=>url,isDestroyed:()=>false}}};
 const runtime=new EventEmitter();runtime.call=async()=>{throw Error('approval must never execute or resend a tool');};
 let enabled=true,tools=true;
 const driver=new WebDriver({runtime,pool:{pages:new Map([[id,target]]),running(){}},onNotice(){},dom:async()=>snapshot,input:{evaluate:(_wc,source)=>page.evaluate(source)},
  approvals:new ApprovalManager({journalFile:path.join(folder,'events.jsonl'),connectors:connectorNames()}),fileApprovalAuthorized:kind=>enabled&&(kind!=='tool'||tools)});
 driver.records.set(id,record);
 return {page,snapshot,record,target,driver,disable:()=>{enabled=false;},disableTools:()=>{tools=false;}};
}

test('task polling handles only approved ordinary MCP tools and exposes the result separately from file approval',async t=>{
 for(const account of ['A','B']){
  const denied=managedFileFixture(t,account,'tool');denied.disableTools();await denied.driver.tick(denied.record);assert.equal(denied.page.clicks(),0);
  assert.equal(denied.target.observation.confirmation.kind,'tool');assert.equal(denied.target.observation.confirmation.state,'needs_confirmation');
  const allowed=managedFileFixture(t,account,'tool');await allowed.driver.tick(allowed.record);assert.equal(allowed.page.clicks(),1);
  assert.equal(allowed.target.observation.confirmation.kind,'tool');assert.equal(allowed.target.observation.confirmation.state,'allowed_once');
  await allowed.driver.tick(allowed.record);assert.equal(allowed.page.clicks(),1);
 }
});

test('actual task polling approves returned files for both accounts once without a model or tool replay',async t=>{
 for(const account of ['A','B']){
  const f=managedFileFixture(t,account);await f.driver.tick(f.record);
  assert.equal(f.page.clicks(),1);assert.equal(f.target.observation.fileApproval,'allowed_once');
  await f.driver.tick(f.record);assert.equal(f.page.clicks(),1);assert.equal(f.target.observation.fileApproval,'original_confirmation_pending');
 }
});

test('an enrolled first task can collect its file without waiting for a second model send',async t=>{
 const f=managedFileFixture(t);f.record.phase='receiver_enrolled';f.record.first_turn_mode='task_v1';f.record.latest_request.attempt_id=null;
 f.snapshot.bootstrapMarker='[CLW-BOOTSTRAP:owned]';f.snapshot.bootstrapMarkerCount=1;
 await f.driver.tick(f.record);assert.equal(f.page.clicks(),1);
});

test('paused, finished, foreign-turn and disabled tasks retain their confirmation',async t=>{
 for(const change of [f=>{f.record.paused=true;f.record.pause_origin={source:'page_or_legacy_pause'};},f=>{f.record.latest_request.phase='completed';},f=>{f.snapshot.userId='other';},f=>f.disable()]){
  const f=managedFileFixture(t);change(f);await f.driver.tick(f.record);assert.equal(f.page.clicks(),0);
 }
});

test('live task changes between inspection and click cancel returned-file approval',async t=>{
 const f=managedFileFixture(t),evaluate=f.page.evaluate;
 f.driver.input.evaluate=async(_wc,source)=>{const value=await evaluate(source);if(source.includes('"inspect"')){f.record.paused=true;f.record.issue_kind='user_stopped';}return value;};
 await f.driver.tick(f.record);assert.equal(f.page.clicks(),0);
});
test('late file confirmations cannot cross the original page, renderer, connection or accepted request',async t=>{
 const changes=[
  ['records removed',f=>f.driver.records.delete(f.target.id)],
  ['accepted request changed',f=>{f.record.latest_request.id='another-request';}],
  ['page replaced',f=>f.driver.pool.pages.set(f.target.id,{...f.target})],
  ['view replaced',f=>{f.target.view={webContents:f.target.view.webContents};}],
  ['renderer replaced',f=>{f.target.view.webContents={...f.target.view.webContents};}],
  ['document changed',f=>{f.target.documentGeneration++;}],
  ['account changed',f=>{f.target.account=f.target.account==='A'?'B':'A';}],
  ['connection changed',f=>{f.driver.connectionGeneration++;}],
  ['URL changed',f=>{f.target.view.webContents.getURL=()=>f.snapshot.url+'/other';}],
  ['renderer destroyed',f=>{f.target.view.webContents.isDestroyed=()=>true;}],
  ['page closed',f=>{f.target.closed=true;}],
  ['runtime closed',f=>{f.driver.runtime.closed=true;}],
  ['driver stopped',f=>{f.driver.stopped=true;}],
 ];
 for(const account of ['A','B'])for(const [reason,change] of changes){
  const f=managedFileFixture(t,account),evaluate=f.page.evaluate;
  f.driver.input.evaluate=async(_wc,source)=>{const value=await evaluate(source);if(source.includes('"inspect"'))change(f);return value;};
  await f.driver.tick(f.record);assert.equal(f.page.clicks(),0,account+': '+reason);
 }
});

test('a changed original user identity cannot approve a still-visible old file card',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-approval-user-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const page=surface(user('u1')+card());
 const manager=new ApprovalManager({journalFile:path.join(folder,'events.jsonl'),connectors:['Local-MCP-B']});
 await manager.inspect({id:'owned',requestId:'request',userId:'new-user',url:'https://chatgpt.com/c/owned',connector:'Local-MCP-B',authorized:()=>true,evaluate:page.evaluate});
 assert.equal(page.clicks(),0);
});

test('grouped and legacy file cards bind the identical user identity as the real task snapshot',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-approval-group-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const layouts=[
  {html:user('group-id'),expected:'group:user:group-id'},
  {html:'<div data-content-search-turn-key="search"><div data-content-search-unit-key="search:1:user"><div data-user-message-bubble data-message-id="nested-id">Work</div></div></div>',expected:'group:user:search:1:user'},
  {html:'<div data-content-search-turn-key="fallback-turn-4"><div data-content-search-unit-key="fallback-turn-4:0:user"><div data-user-message-bubble data-message-id="nested-id">Work [CLW:control_518d3b7f055a4cf183110b04720fc227]</div></div></div>',expected:'managed-public:[CLW:control_518d3b7f055a4cf183110b04720fc227]:user'},
  {html:'<article data-testid="conversation-turn-0" data-turn="user" data-turn-id="legacy-id"><div data-message-author-role="user" data-message-id="nested-id">Work</div></article>',expected:'legacy-id'},
 ];
 for(const [i,layout] of layouts.entries()){
  const p=surface(layout.html+card()),snapshot=p.snapshot(),s=p.inspect();
  assert.equal(snapshot.userId,layout.expected);assert.equal(s.userId,snapshot.userId);
  const m=new ApprovalManager({journalFile:path.join(folder,'events-'+i+'.jsonl'),connectors:['Local-MCP-B']});
  const target={id:'owned',requestId:'original',userId:snapshot.userId,url:snapshot.url,connector:'Local-MCP-B',authorized:()=>true,evaluate:p.evaluate};
  assert.equal((await m.inspect(target)).state,'allowed_once');await m.inspect(target);assert.equal(p.clicks(),1);
 }
});

test('collapsed long user text binds the same original marker for tool and file confirmations',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-approval-collapsed-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const marker='[CLW:control_518d3b7f055a4cf183110b04720fc227]';
 for(const kind of ['tool','returned_file']){
  const confirmation=kind==='tool'?'<section><span>Local-MCP-B</span><h3>Allow ChatGPT to use Local-MCP-B?</h3><button>Deny</button><button>Allow once</button></section>':card();
  const p=surface('<div data-content-search-turn-key="fallback-turn-0"><div data-content-search-unit-key="fallback-turn-0:0:user"><div data-user-message-bubble>Long original requirement '+marker+'</div></div></div>'+confirmation);
  Object.defineProperty(p.window.document.querySelector('[data-user-message-bubble]'),'innerText',{configurable:true,value:'Long original requirement...'});
  const snapshot=p.snapshot(),inspection=p.inspect();
  assert.equal(snapshot.userId,`managed-public:${marker}:user`);assert.equal(inspection.userId,snapshot.userId);assert.equal(inspection.kind,kind);
  const manager=new ApprovalManager({journalFile:path.join(folder,kind+'.jsonl'),connectors:connectorNames()});
  assert.equal((await manager.inspect({id:'owned',requestId:'original',userId:snapshot.userId,url:snapshot.url,connector:inspection.connector,authorized:()=>true,evaluate:p.evaluate})).state,'allowed_once');
  assert.equal(p.clicks(),1);await manager.inspect({id:'owned',requestId:'original',userId:snapshot.userId,url:snapshot.url,connector:inspection.connector,authorized:()=>true,evaluate:p.evaluate});assert.equal(p.clicks(),1);
 }
});

test('fallback file identity rejects duplicate markers, quoted markers and a later foreign user',async t=>{
 const marker='[CLW:control_518d3b7f055a4cf183110b04720fc227]',expected=`managed-public:${marker}:user`;
 const bubble=body=>`<div data-content-search-turn-key="fallback-turn-4"><div data-content-search-unit-key="fallback-turn-4:0:user"><div data-user-message-bubble>${body}</div></div></div>`;
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-approval-fallback-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 for(const [index,html] of [user('old').replace('Work',marker)+bubble('Work '+marker),bubble('Quoted '+marker+' then another instruction'),bubble('Work '+marker)+user('foreign')].entries()){
   const page=surface(html+card());
   const manager=new ApprovalManager({journalFile:path.join(folder,index+'.jsonl'),connectors:['Local-MCP-B']});
   await manager.inspect({id:'owned',requestId:'request',userId:expected,url:'https://chatgpt.com/c/owned',connector:'Local-MCP-B',authorized:()=>true,evaluate:page.evaluate});
   assert.equal(page.clicks(),0);assert.notEqual(page.inspect().userId,expected);
 }
});

test('a pre-correction unknown card receipt still forbids another click',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-approval-prior-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const p=surface(user('u1')+card()),s=p.inspect();
 const oldSignature=JSON.stringify([s.url,'u1',s.kind,JSON.parse(s.signature)[3]]);
 assert.equal(s.signature,oldSignature);assert.equal(s.userId,'group:user:u1');
 const key=createHash('sha256').update(JSON.stringify(['owned','original',oldSignature])).digest('hex'),file=path.join(folder,'events.jsonl');
 fs.writeFileSync(file,JSON.stringify({event:'allow_once_attempted',key})+'\n');
 const m=new ApprovalManager({journalFile:file,connectors:['Local-MCP-B']});
 const result=await m.inspect({id:'owned',requestId:'original',userId:s.userId,url:s.url,connector:s.connector,authorized:()=>true,evaluate:p.evaluate});
 assert.equal(result.state,'original_confirmation_pending');assert.equal(p.clicks(),0);
});

test('identical file cards in one user turn have separate public message identities and survive restart',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-approval-repeated-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const file=path.join(folder,'events.jsonl'),firstId='42643a91-efd4-434e-a648-0e92461f8982',secondId='42643a91-efd4-434e-a648-0e92461f8983';
 const make=id=>surface(user('u1')+`<div data-chatgpt-search-message-ids="${id}">`+card()+'</div>');
 const first=make(firstId),second=make(secondId),a=first.inspect(),b=second.inspect();
 assert.equal(a.signature,b.signature);assert.notEqual(a.approvalIdentity,b.approvalIdentity);
 const target=p=>({id:'owned',requestId:'original',userId:p.inspect().userId,url:a.url,connector:a.connector,authorized:()=>true,evaluate:p.evaluate});
 let manager=new ApprovalManager({journalFile:file,connectors:['Local-MCP-B']});
 assert.equal((await manager.inspect(target(first))).state,'allowed_once');
 assert.equal((await manager.inspect(target(second))).state,'allowed_once');
 manager=new ApprovalManager({journalFile:file,connectors:['Local-MCP-B']});
 const restored=make(secondId);await manager.inspect(target(restored));assert.equal(restored.clicks(),0);
 assert.equal(first.clicks(),1);assert.equal(second.clicks(),1);
 await assert.rejects(()=>second.evaluate(`(${publicApproval.toString()})('allow-once',${JSON.stringify(a)})`),/identity_changed/);
});

test('message identity migration preserves an unknown legacy receipt and can identify a later card after a confirmed click',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-approval-migration-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 for(const confirmed of [false,true]){
  const p=surface(user('u1')+'<div data-chatgpt-search-message-ids="42643a91-efd4-434e-a648-0e92461f8982">'+card()+'</div>'),s=p.inspect();
  const key=createHash('sha256').update(JSON.stringify(['owned','original',s.signature])).digest('hex'),file=path.join(folder,String(confirmed)+'.jsonl');
  fs.writeFileSync(file,JSON.stringify({event:'allow_once_attempted',key})+'\n'+(confirmed?JSON.stringify({event:'allow_once_clicked',key})+'\n':''));
  const m=new ApprovalManager({journalFile:file,connectors:['Local-MCP-B']});
  const result=await m.inspect({id:'owned',requestId:'original',userId:s.userId,url:s.url,connector:s.connector,authorized:()=>true,evaluate:p.evaluate});
  assert.equal(result.state,confirmed?'allowed_once':'original_confirmation_pending');assert.equal(p.clicks(),confirmed?1:0);
 }
});

test('operator hold and list hiding preserve the exact accepted turn file confirmation once',async t=>{
 for(const account of ['A','B'])for(const closed of [false,true]){const f=managedFileFixture(t,account);f.record.paused=true;f.record.pause_origin={source:'operator'};f.record.receipt_collection_allowed=true;f.driver.isClosed=()=>closed;await f.driver.tick(f.record);assert.equal(f.page.clicks(),1);assert.equal(f.record.paused,true);await f.driver.tick(f.record);assert.equal(f.page.clicks(),1);}
});
test('explicit stop, real attention and ancestor receipt rejection cannot be masked by an operator hold',async t=>{
 for(const change of [f=>{f.record.issue_kind='user_stopped';},f=>{f.record.attention='original permission refused';},f=>{f.record.receipt_collection_allowed=false;}]){const f=managedFileFixture(t);f.record.paused=true;f.record.pause_origin={source:'operator'};change(f);await f.driver.tick(f.record);assert.equal(f.page.clicks(),0);}
});
