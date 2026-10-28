import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import {webcrypto} from 'node:crypto';
const file=name=>fs.readFileSync(new URL('../apps/web-recovery-companion/'+name,import.meta.url),'utf8');
const chat='https://chatgpt.com/c/12345678-1234-1234-1234-123456789012',ext='chrome-extension://'+'a'.repeat(32)+'/',token='clwc_'+'t'.repeat(43);
const PAGE={visible:true,generating:false,draft:false,composing:false,focused:false,blocked:false,stopped:false,controls_known:true,model_pro_visible:false,effort_disallowed_visible:false,editor_known:true,user_known:true,mode_control_known:true,model_label:'GPT-5.6 Sol',effort_label:'Extra High',user_hash:'a'.repeat(64),failure_hash:'0'.repeat(64),failure_kind:''};
function runtime({multiple=false,failBootstrap=false,wrongPage=false,protocol=4,enrollmentRequired=false,backgroundProof=false,backgroundKnown=false,backgroundVisible=true,backgroundActive=true,windowState='normal',windowFocused=false}={}){
 let handler,onUpdated,onAlarm,onActivated,onFocusChanged;const calls=[],saved=new Map(),localSaved=new Map(),scriptCalls=[],tabMessages=[];
 const store={async setAccessLevel(){},async get(k){return {[k]:saved.get(k)};},async set(obj){for(const [k,v] of Object.entries(obj))saved.set(k,v);},async remove(k){saved.delete(k);}};
 const local={async get(k){return {[k]:localSaved.get(k)};},async set(obj){for(const [k,v] of Object.entries(obj))localSaved.set(k,v);},async remove(k){localSaved.delete(k);}};
 if(backgroundKnown)localSaved.set('clwKnownChatUrls',{[chat]:{title:'Known worker',model_label:'gpt-5.6 sol',effort_label:'extra high'}});
 const bgTab={id:7,url:chat,status:'complete',discarded:false,frozen:false,pendingUrl:null,active:backgroundActive,windowId:99};
 const crypto={subtle:webcrypto.subtle,randomUUID:()=> '11111111-2222-3333-4444-555555555555'};
 const ctx=vm.createContext({
  console,setTimeout,clearTimeout,AbortController,URL,crypto,TextEncoder,
  chrome:{
   storage:{session:store,local},
   runtime:{getURL:p=>ext+p,onMessage:{addListener:h=>handler=h}},
   tabs:{
    get:async id=>bgTab,
    query:async q=>(q?.active===true?[bgTab].filter(t=>t.active):[bgTab]),
    sendMessage:async(id,m)=>{tabMessages.push(m);if(m.type==='clw-background-probe')return {stale:false,url:chat,proof:backgroundProof?{enrollment_ticket:'clwi_'+'c'.repeat(43)}:null,page:{...PAGE,visible:backgroundVisible}};if(m.type==='clw-background-tick')return {closed:false,busy:false,nextReadAt:0};return null;},
    onRemoved:{addListener(){}},onUpdated:{addListener:h=>onUpdated=h},onActivated:{addListener:h=>onActivated=h}
   },
   scripting:{executeScript:async spec=>{scriptCalls.push(spec);return [];}},
   windows:{WINDOW_ID_NONE:-1,get:async id=>({id,type:'normal',state:windowState,focused:windowFocused}),onFocusChanged:{addListener:h=>onFocusChanged=h}},
   alarms:{create:async()=>{},get:async()=>null,clear:async()=>{},onAlarm:{addListener:h=>onAlarm=h}}
  },
  fetch:async(url,opt)=>{const body=JSON.parse(opt.body);calls.push({url,opt,body});if(failBootstrap&&body.action==='bootstrap')return {ok:false,text:async()=>JSON.stringify({success:false,code:'control_profile_not_previously_trusted'})};
   if(body.action==='capabilities')return {ok:true,text:async()=>JSON.stringify({success:true,control_protocol:protocol,receiver_enrollment:protocol===4,run_budgets:protocol===4,browser_public_result:protocol===4})};
   if(body.action==='bootstrap'){if(enrollmentRequired)return {ok:true,text:async()=>JSON.stringify({success:true,state:'enrollment_required',titles:['Logical receiver without a page']})};if(wrongPage)return {ok:true,text:async()=>JSON.stringify({success:true,state:'wrong_registered_page',current_titles:['ChatGPT Web · A 主对话'],pending_titles:['CLW 独立 Web 接入审查'],switch_required:true,internal_target_required:false,pair_code_required:false})};const candidates=multiple?[{discovery_id:'clwd_'+'a'.repeat(32),title:'审查甲',has_current_request:true,previously_bound:false},{discovery_id:'clwd_'+'b'.repeat(32),title:'审查乙',has_current_request:true,previously_bound:false}]:[{discovery_id:'clwd_'+'a'.repeat(32),title:'CLW 独立 Web 接入审查',has_current_request:true,previously_bound:backgroundKnown}];const auto=!!(body.enrollment||body.enrollment_ticket||backgroundKnown)&&!multiple;return {ok:true,text:async()=>JSON.stringify({success:true,state:auto?'one_confirmed_receiver':'choose_candidate',auto_bind_safe:auto,candidates})};}
   if(body.action==='bind')return {ok:true,text:async()=>JSON.stringify({success:true,control_token:token,generation:1,model_label:'gpt-5.6 sol',effort_label:'extra high',title:multiple?'审查乙':'CLW 独立 Web 接入审查',adopted_request_id:'clw-child-original'})};
   return {ok:true,text:async()=>JSON.stringify({success:true,state:'idle_or_old_request_not_adopted'})};}
 });
 ctx.importScripts=(...names)=>{for(const n of names)vm.runInContext(file(n),ctx);};vm.runInContext(file('worker.js'),ctx);
 const message=(m,s)=>new Promise(resolve=>handler(m,s,resolve));
 const flush=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
 return {message,calls,saved,localSaved,scriptCalls,tabMessages,flush,alarm:async name=>{await onAlarm?.({name});await flush();},updated:async()=>{await onUpdated?.(7,{status:'complete'},bgTab);await flush();},activated:async({focused=windowFocused}={})=>{bgTab.active=true;windowFocused=focused;await onActivated?.({tabId:7,windowId:99});await flush();},focusLost:async()=>{windowFocused=false;await onFocusChanged?.(-1);await flush();}};
}
const popup={url:ext+'popup.html'},page={tab:{id:7,url:chat},url:chat,frameId:0,documentId:'doc-a'};
test('0.6.6 keeps bounded host access and permission scope for manual Pro monitor and local control',()=>{const m=JSON.parse(file('manifest.json'));assert.equal(m.name,'CLW Web Companion');assert.equal(m.version,'0.6.6');assert.deepEqual(m.permissions,['scripting','storage','alarms']);assert.deepEqual(m.host_permissions,['http://127.0.0.1/*','https://chatgpt.com/*']);assert.equal(m.content_scripts.length,1);assert.deepEqual(m.content_scripts[0].matches,['https://chatgpt.com/*']);assert.ok(m.content_scripts[0].js.includes('background-bridge.js'));for(const forbidden of ['cookies','debugger','history','webRequest'])assert.ok(!m.permissions.includes(forbidden));assert.match(file('popup.html'),/monitorStart/);});
test('enrolled ChatGPT page auto-binds in a non-foreground browser window without popup',async()=>{
 const r=runtime({backgroundProof:true});await r.flush();
 assert.deepEqual(r.calls.map(x=>x.body.action),['capabilities','bootstrap','bind']);
 assert.ok(r.calls.find(x=>x.body.action==='bootstrap').body.enrollment_ticket);
 assert.equal(r.calls.find(x=>x.body.action==='bootstrap').body.confirm_page_binding,undefined);
 assert.ok(r.saved.get('clwUnifiedTab:7'));assert.ok(r.localSaved.get('clwKnownChatUrls')[chat]);
 assert.ok(r.scriptCalls.some(x=>x.files?.includes('control-content.js')));
});
test('unregistered ChatGPT page stays passive and makes no localhost request',async()=>{
 const r=runtime();await r.flush();assert.equal(r.calls.length,0);assert.equal(r.saved.size,0);
});

test('standalone manual-page binding is ticked without localhost and excludes legacy control',async()=>{
 const r=runtime();await r.flush();
 const start=await r.message({type:'monitor-start',tabId:7,chatUrl:chat,confirm:true},popup);
 assert.equal(start.ok,true);assert.equal(start.value.started,true);assert.equal(r.calls.length,0);
 const old=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true},popup);
 assert.equal(old.ok,false);assert.match(old.error,/monitor_already_owns_page/);assert.equal(r.calls.length,0);
 await r.alarm('clw-background-bound-scan');assert.ok(r.tabMessages.some(m=>m.type==='clw-monitor-tick'));assert.equal(r.calls.length,0);
 await r.updated();assert.equal(r.calls.length,0);
});
test('previously known exact page rebinds after browser restart without a foreground click',async()=>{
 const r=runtime({backgroundKnown:true});await r.flush();
 assert.deepEqual(r.calls.map(x=>x.body.action),['capabilities','bootstrap','bind']);
 assert.equal(r.calls.find(x=>x.body.action==='bootstrap').body.enrollment_ticket,undefined);
 assert.ok(r.saved.get('clwUnifiedTab:7'));
});
test('covered non-foreground browser window can auto-bind while DOM visibility is hidden',async()=>{
 const r=runtime({backgroundProof:true,backgroundVisible:false});await r.flush();
 assert.deepEqual(r.calls.map(x=>x.body.action),['capabilities','bootstrap','bind']);assert.ok(r.saved.get('clwUnifiedTab:7'));
});
test('inactive tab or minimized browser window never auto-binds or sends',async()=>{
 for(const opts of [{backgroundActive:false},{windowState:'minimized'}]){const r=runtime({backgroundProof:true,backgroundVisible:false,...opts});await r.flush();assert.equal(r.calls.length,0);assert.equal(r.saved.size,0);}
});
test('background alarm ticks an already bound page without focusing its window',async()=>{
 const r=runtime({backgroundProof:true});await r.flush();r.tabMessages.length=0;
 await r.alarm('clw-background-bound-scan');
 assert.ok(r.tabMessages.some(x=>x.type==='clw-background-tick'));
 assert.equal(r.scriptCalls.some(x=>x.func&&String(x.func).includes('focus')),false);
});
test('reload while worker tab is inactive waits; losing Edge foreground later binds exact proof without popup',async()=>{
 const r=runtime({backgroundProof:true,backgroundVisible:false,backgroundActive:false,windowFocused:true});await r.flush();
 assert.equal(r.calls.length,0);
 await r.activated({focused:true});assert.equal(r.calls.length,0);
 await r.focusLost();
 assert.deepEqual(r.calls.map(x=>x.body.action),['capabilities','bootstrap','bind']);
 assert.ok(r.saved.get('clwUnifiedTab:7'));
});
test('tab activated inside an already-background Edge window can bind exact proof',async()=>{
 const r=runtime({backgroundProof:true,backgroundVisible:false,backgroundActive:false,windowFocused:false});await r.flush();
 assert.equal(r.calls.length,0);await r.activated({focused:false});
 assert.deepEqual(r.calls.map(x=>x.body.action),['capabilities','bootstrap','bind']);
});
test('activation and focus-loss race serializes one exact bind for the same tab',async()=>{
 const r=runtime({backgroundProof:true,backgroundVisible:false,backgroundActive:false,windowFocused:true});await r.flush();
 await Promise.all([r.activated({focused:false}),r.focusLost()]);
 assert.deepEqual(r.calls.map(x=>x.body.action),['capabilities','bootstrap','bind']);
 assert.ok(r.saved.get('clwUnifiedTab:7'));
});
test('focus-loss rescan of an unregistered active ChatGPT page remains passive and never reaches localhost',async()=>{
 const r=runtime({backgroundVisible:false,backgroundActive:true,windowFocused:true});await r.flush();assert.equal(r.calls.length,0);
 await r.focusLost();assert.equal(r.calls.length,0);assert.equal(r.saved.size,0);
});
test('one explicit enable click binds the only runnable CLW request and auto-adopts without target or pair code',async()=>{
 const r=runtime();const out=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true},popup);
 assert.equal(out.ok,true);assert.equal(out.value.paired,true);assert.equal(out.value.title,'CLW 独立 Web 接入审查');assert.equal(out.value.adopted_request_id,'clw-child-original');
 assert.deepEqual(r.calls.map(x=>x.body.action),['capabilities','bootstrap','bind']);
 const raw=JSON.stringify({reply:out,calls:r.calls});
 assert.equal(r.calls.find(x=>x.body.action==='bootstrap').body.confirm_page_binding,true);for(const forbidden of ['target_id','session_id','pair_code'])assert.ok(!raw.includes(forbidden));
 const hello=await r.message({type:'control-hello'},page);assert.equal(hello.ok,true);assert.equal(hello.value.model_label,'gpt-5.6 sol');assert.ok(!JSON.stringify(hello).includes(token));
});
test('explicit page authorization keeps task transport inactive while Edge is foreground and arms after focus loss',async()=>{
 const r=runtime({windowFocused:true});
 const out=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true},popup);
 assert.equal(out.ok,true);assert.equal(out.value.paired,true);
 const hello=await r.message({type:'control-hello'},page);
 assert.equal(hello.ok,true);assert.equal(hello.value.transport_active,false);
 const foreground=await r.message({type:'control-transport'},page);
 assert.equal(foreground.ok,true);assert.equal(foreground.value.active,false);
 await r.focusLost();
 const background=await r.message({type:'control-transport'},page);
 assert.equal(background.ok,true);assert.equal(background.value.active,true);
});
test('multiple candidates expose titles only and require one explicit title choice',async()=>{
 const r=runtime({multiple:true});const first=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true},popup);
 assert.equal(first.ok,true);assert.equal(first.value.needs_selection,true);assert.deepEqual(Array.from(first.value.candidates,x=>x.title),['审查甲','审查乙']);
 assert.ok(!JSON.stringify(first).includes('target_id'));const pick=first.value.candidates[1];
 const second=await r.message({type:'control-select',tabId:7,chatUrl:chat,page:PAGE,confirm:true,nonce:first.value.nonce,discoveryId:pick.discovery_id},popup);
 assert.equal(second.ok,true);assert.equal(second.value.title,'审查乙');assert.deepEqual(r.calls.map(x=>x.body.action),['capabilities','bootstrap','capabilities','bind']);
});
test('known idle main page is not rebound to a pending independent child',async()=>{
 const r=runtime({wrongPage:true});const out=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true},popup);
 assert.equal(out.ok,true);assert.equal(out.value.wrong_page,true);
 assert.deepEqual(Array.from(out.value.current_titles),['ChatGPT Web · A 主对话']);
 assert.deepEqual(Array.from(out.value.pending_titles),['CLW 独立 Web 接入审查']);
 assert.deepEqual(r.calls.map(x=>x.body.action),['capabilities','bootstrap']);assert.equal(r.saved.size,0);
});

test('old or ambiguous server protocol is rejected before any bind or send',async()=>{for(const protocol of [0,2,3,5,null]){const r=runtime({protocol});const out=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true},popup);assert.equal(out.ok,false);assert.match(out.error,/protocol_update_required/);assert.deepEqual(r.calls.map(x=>x.body.action),['capabilities']);assert.equal(r.saved.size,0);}});
test('unbound logical worker returns enrollment required without selecting a random page',async()=>{const r=runtime({enrollmentRequired:true});const out=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true},popup);assert.equal(out.ok,true);assert.equal(out.value.enrollment_required,true);assert.deepEqual(r.calls.map(x=>x.body.action),['capabilities','bootstrap']);assert.equal(r.saved.size,0);});
test('only explicit popup can submit its exact public receiver proof',async()=>{const enrollment='CLW-ENROLL:'+'a'.repeat(32)+':'+'b'.repeat(32),r=runtime();const denied=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true,enrollment},page);assert.equal(denied.ok,false);assert.equal(r.calls.length,0);const accepted=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true,enrollment},popup);assert.equal(accepted.ok,true);const body=r.calls.find(x=>x.body.action==='bootstrap').body;assert.equal(body.enrollment,enrollment);assert.equal(body.confirm_page_binding,undefined);});
test('one-time enrollment ticket is forwarded only from explicit popup',async()=>{const enrollment_ticket='clwi_'+'c'.repeat(43),r=runtime();const denied=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true,enrollment_ticket},page);assert.equal(denied.ok,false);assert.equal(r.calls.length,0);const accepted=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true,enrollment_ticket},popup);assert.equal(accepted.ok,true);const body=r.calls.find(x=>x.body.action==='bootstrap').body;assert.equal(body.enrollment_ticket,enrollment_ticket);assert.equal(body.confirm_page_binding,undefined);});
test('malformed enrollment receipt makes no localhost request',async()=>{const r=runtime();const out=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true,enrollment:'made-up-id'},popup);assert.equal(out.ok,false);assert.equal(r.calls.length,0);});
test('server trust failure cannot be bypassed by extension popup',async()=>{const r=runtime({failBootstrap:true});const out=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:PAGE,confirm:true},popup);assert.equal(out.ok,false);assert.match(out.error,/control_profile_not_previously_trusted/);assert.equal(r.calls.length,2);});
test('visible Pro or disallowed effort is rejected locally; hidden exact labels may use the explicit enable confirmation',async()=>{for(const patch of [{model_label:'GPT-5.6 Sol Pro',model_pro_visible:true},{effort_label:'High',effort_disallowed_visible:true}]){const r=runtime();const out=await r.message({type:'control-enable',tabId:7,chatUrl:chat,page:{...PAGE,...patch},confirm:true},popup);assert.equal(out.ok,false);assert.equal(r.calls.length,0);}const hidden=runtime();const ok=await hidden.message({type:'control-enable',tabId:7,chatUrl:chat,page:{...PAGE,model_label:'',effort_label:''},confirm:true},popup);assert.equal(ok.ok,true);assert.equal(hidden.calls[1].body.confirm_low_cost,true);});
