import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../apps/web-recovery-companion/local-control.js',import.meta.url),'utf8');
const BASE='http://127.0.0.1:18946';
const CHAT='https://chatgpt.com/c/12345678-1234-1234-1234-123456789012';
const OTHER='https://chatgpt.com/g/project-one/c/23456789-1234-1234-1234-123456789012';
const PROFILE='clwLocalControlProfile',PEER='clwLocalControlPeer',RECEIPTS='clwLocalControlReceipts';
const uuid=n=>`11111111-2222-4333-8444-${n.toString(16).padStart(12,'0')}`;
const clone=x=>structuredClone(x);
const cmd=(patch={})=>({id:uuid(1),type:'inspect',tabId:7,chatUrl:CHAT,documentId:null,payload:{},...patch});
const approved=(patch={})=>({success:true,approved:true,peer_id:'peer-one',peer_token:'private-peer-token',...patch});
const response=(body,status=200)=>({ok:status>=200&&status<300,status,text:async()=>JSON.stringify(body)});

function runtime(options={}){
  const session=options.session??new Map(),local=options.local??new Map(),tabs=options.tabs??new Map([[7,{id:7,url:CHAT}]]);
  const windows=options.windows??new Map(),activationListeners=new Set(),focusListeners=new Set();
  const clock={now:1000000},timers=new Map(),calls=[],executions=[],ops=[],controllers=[];
  let timerId=0,nextUUID=options.uuidSeed??100,query=()=>[...tabs.values()],executor=async()=>({state:'completed',result:{ready:true}});
  const handlers={register:()=>approved(),poll:null,result:()=>({success:true}),...options.handlers};
  class FakeDate extends Date{static now(){return clock.now;}}
  const setTimer=(fn,delay)=>{const id=++timerId;timers.set(id,{fn,at:clock.now+Math.max(0,delay)});return id;};
  const activate=id=>{
    const target=tabs.get(id);assert.ok(target,'the activated tab exists');
    for(const tab of tabs.values())if(tab.windowId===target.windowId)tab.active=tab.id===id;
    target.frozen=false;for(const listener of activationListeners)listener({windowId:target.windowId,tabId:id});
  };
  const chrome={runtime:{id:'a'.repeat(32),getManifest:()=>({version:'0.6.2'})},storage:{session:{
    async get(keys){ops.push(['get',clone(keys)]);return Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>session.has(k)).map(k=>[k,clone(session.get(k))]));},
    async set(values){ops.push(['set',clone(values)]);for(const [key,value] of Object.entries(values))session.set(key,clone(value));},
  },local:{
    async get(keys){ops.push(['localGet',clone(keys)]);return Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>local.has(k)).map(k=>[k,clone(local.get(k))]));},
    async set(values){ops.push(['localSet',clone(values)]);for(const [key,value] of Object.entries(values))local.set(key,clone(value));},
  }},tabs:{
    async query(filter){ops.push(['query',clone(filter)]);return clone((await query()).filter(tab=>(filter.windowId===undefined||tab.windowId===filter.windowId)&&(filter.active===undefined||tab.active===filter.active)));},
    async get(id){ops.push(['getTab',id]);if(!tabs.has(id))throw Error('no_tab');return clone(tabs.get(id));},
    async update(id,properties){ops.push(['updateTab',id,clone(properties)]);assert.deepEqual(clone(properties),{active:true});activate(id);return clone(tabs.get(id));},
    onActivated:{addListener:fn=>activationListeners.add(fn),removeListener:fn=>activationListeners.delete(fn)},
  },windows:{
    async get(id){ops.push(['getWindow',id]);if(!windows.has(id))throw Error('no_window');return clone(windows.get(id));},
    onFocusChanged:{addListener:fn=>focusListeners.add(fn),removeListener:fn=>focusListeners.delete(fn)},
  }};
  if(options.scripting)chrome.scripting={async executeScript(injection){ops.push(['probe',clone(injection.target),String(injection.func)]);return await options.scripting(injection);}};
  const context=vm.createContext({chrome,Date:FakeDate,AbortController,TextEncoder,crypto:{randomUUID:()=>uuid(nextUUID++)},setTimeout:setTimer,clearTimeout:id=>timers.delete(id),
    fetch:async(url,init)=>{
      const action=url.slice(url.lastIndexOf('/')+1),call={url,init,body:JSON.parse(init.body),action};calls.push(call);controllers.push(init.signal);
      assert.equal(url,BASE+'/extension/'+action);
      const handler=handlers[action];
      if(handler)return await handler(call);
      return await new Promise((resolve,reject)=>{call.resolve=body=>resolve(response(body));init.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});
    },
  });
  for(const action of ['register','result']){
    const handler=handlers[action];handlers[action]=async call=>{const out=await handler(call);return out?.text?out:response(out);};
  }
  const originalPoll=handlers.poll;
  if(originalPoll)handlers.poll=async call=>{const out=await originalPoll(call);return out?.text?out:response(out);};
  vm.runInContext(source,context);
  const control=context.CLWLocalControl;
  control.configure({execute:async command=>{executions.push(clone(command));return await executor(command);}});
  const drain=async()=>{for(let i=0;i<100;i++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));};
  const r={session,local,tabs,windows,timers,calls,executions,ops,context,control,handlers,controllers,drain,activate,activationListeners,focusListeners,
    focus:(id,focused)=>{windows.get(id).focused=focused;for(const listener of focusListeners)listener(focused?id:-1);},
    start:async()=>{assert.equal(control.start(),undefined);await drain();},
    stop:async()=>{assert.equal(control.stop(),undefined);await drain();},
    execute:fn=>{executor=fn;},query:fn=>{query=fn;},
    count:action=>calls.filter(c=>c.action===action).length,
    pending:()=>session.get(RECEIPTS)?.pending,
    resolvePoll:async(command=null)=>{const p=calls.findLast(c=>c.action==='poll'&&c.resolve);assert.ok(p,'a poll is waiting');const resolve=p.resolve;delete p.resolve;resolve({success:true,command});await drain();},
    advance:async ms=>{
      const end=clock.now+ms;
      for(let i=0;i<1000;i++){
        const due=[...timers.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!due){clock.now=end;await drain();return;}
        clock.now=due[1].at;timers.delete(due[0]);due[1].fn();await drain();
      }
      throw Error('fake_timer_loop');
    },
  };
  return r;
}

function frozenRuntime(){
  return runtime({windows:new Map([[70,{id:70,focused:false}]]),tabs:new Map([
    [7,{id:7,url:CHAT,windowId:70,active:false,frozen:true,status:'complete'}],
    [8,{id:8,url:OTHER,windowId:70,active:true}],
    [9,{id:9,url:CHAT,windowId:70,active:false}],
  ])});
}

test('import and configuration are passive, with only a worker API and no page listener',()=>{
  const ctx=vm.createContext({});vm.runInContext(source,ctx);
  assert.deepEqual(Object.keys(ctx.CLWLocalControl),['configure','start','stop']);
  assert.equal(ctx.CLWLocalControl.configure({execute:async()=>null}),undefined);
  assert.equal(ctx.CLWLocalControl.start(),undefined);ctx.CLWLocalControl.stop();
  assert.ok(!/onMessage|postMessage|cookies|chrome\.tabs\.reload|chrome\.windows\.(update|create)|document\.(body|querySelector)/.test(source));
});

test('register targets fixed localhost with metadata only, no cookies or Origin spoofing; unsupported probes never trust old document ids',async()=>{
  const r=runtime();r.session.set('clwPageMonitorTab:7',{tabId:7,chatUrl:CHAT,documentId:'document-a'});
  r.tabs.set(8,{id:8,url:OTHER});r.tabs.set(9,{id:9,url:'https://chatgpt.com/'});r.tabs.set(10,{id:10,url:CHAT+'?q=private'});
  r.tabs.set(11,{id:11,url:CHAT,pendingUrl:OTHER});await r.start();
  const call=r.calls[0];assert.equal(call.url,BASE+'/extension/register');
  assert.deepEqual(Object.keys(call.body),['extension_version','profile_id','instance_nonce','pages']);
  assert.equal(call.body.profile_id,r.local.get(PROFILE));
  assert.deepEqual(call.body.pages,[{tabId:7,url:CHAT,documentId:null,enabled:true},{tabId:8,url:OTHER,documentId:null,enabled:false}]);
  assert.equal(call.init.credentials,'omit');assert.equal(call.init.redirect,'error');
  assert.deepEqual(Object.keys(call.init.headers),['Content-Type']);
  assert.deepEqual(r.ops.find(o=>o[0]==='query')[1],{url:'https://chatgpt.com/*'});
  assert.ok(!JSON.stringify(call.body).includes('private-peer-token'));assert.equal(r.executions.length,0);await r.stop();
});

test('inventory probes only location metadata and has the actual top document before watch',async()=>{
  const documentId=uuid(700);
  const r=runtime({scripting:async injection=>{
    assert.deepEqual(Object.keys(injection),['target','func']);assert.deepEqual(clone(injection.target),{tabId:7});
    assert.match(String(injection.func),/^\(\)=>location\.href$/);
    const result=vm.runInNewContext('('+String(injection.func)+')()',{location:{href:CHAT}});
    return [{frameId:0,documentId,result}];
  }});
  r.execute(async()=>{r.session.set('clwPageMonitorTab:7',{tabId:7,chatUrl:CHAT,documentId});return {state:'completed',result:{watching:true}};});
  await r.start();assert.deepEqual(r.calls[0].body.pages,[{tabId:7,url:CHAT,documentId,enabled:false}]);
  assert.equal(r.calls[1].body.pages[0].documentId,documentId);
  await r.resolvePoll(cmd({type:'watch',documentId}));await r.advance(1000);
  assert.deepEqual(r.calls.findLast(c=>c.action==='poll').body.pages,[{tabId:7,url:CHAT,documentId,enabled:true}]);await r.stop();
});

test('manual refresh document metadata overrides a stale monitor binding on every inventory',async()=>{
  let documentId=uuid(701);
  const r=runtime({scripting:async()=>[{frameId:0,documentId,result:CHAT}]});
  r.session.set('clwPageMonitorTab:7',{tabId:7,chatUrl:CHAT,documentId:'stale-monitor-document'});
  await r.start();assert.equal(r.calls[0].body.pages[0].documentId,documentId);
  documentId=uuid(702);await r.resolvePoll(null);await r.advance(1000);
  assert.equal(r.calls.findLast(c=>c.action==='poll').body.pages[0].documentId,documentId);
  assert.equal(r.session.get('clwPageMonitorTab:7').documentId,'stale-monitor-document');await r.stop();
});

test('wrong URL, subframe, ambiguous results, missing identity, and inaccessible probes never publish a document id',async()=>{
  for(const probe of [
    async()=>[{frameId:0,documentId:uuid(700),result:OTHER}],
    async()=>[{frameId:1,documentId:uuid(700),result:CHAT}],
    async()=>[{frameId:0,documentId:uuid(700),result:CHAT},{frameId:0,documentId:uuid(701),result:CHAT}],
    async()=>[{frameId:0,result:CHAT}],async()=>{throw Error('tab_inaccessible');},
  ]){
    const r=runtime({scripting:probe});r.session.set('clwPageMonitorTab:7',{tabId:7,chatUrl:CHAT,documentId:'stale'});
    await r.start();assert.equal(r.calls[0].body.pages[0].documentId,null);assert.equal(r.calls[0].body.pages[0].url,CHAT);await r.stop();
  }
});

test('discarded, frozen, loading, and pending-navigation tabs are never probed or activated',async()=>{
  const tabs=new Map([[7,{id:7,url:CHAT,discarded:true}],[8,{id:8,url:CHAT,frozen:true}],
    [9,{id:9,url:CHAT,status:'loading'}],[10,{id:10,url:CHAT,pendingUrl:OTHER}],[11,{id:11,url:CHAT,status:'complete'}]]);
  const r=runtime({tabs,scripting:async injection=>{
    assert.equal(injection.target.tabId,11);return [{frameId:0,documentId:uuid(700),result:CHAT}];
  }});await r.start();
  assert.deepEqual(r.calls[0].body.pages.map(p=>[p.tabId,p.documentId]),[[7,null],[8,null],[9,null],[11,uuid(700)]]);
  assert.ok(r.ops.filter(op=>op[0]==='probe').every(op=>op[1].tabId===11));await r.stop();
});

test('a stalled metadata probe cannot block registration or later inventories, and late metadata stays unknown',async()=>{
  const late=[];
  const tabs=new Map([[7,{id:7,url:CHAT}],[8,{id:8,url:OTHER}]]);
  const r=runtime({tabs,scripting:injection=>injection.target.tabId===7?new Promise(resolve=>late.push(resolve)):
    Promise.resolve([{frameId:0,documentId:uuid(708),result:OTHER}])});
  await r.start();assert.equal(r.count('register'),0);assert.equal(late.length,1);
  await r.advance(1499);assert.equal(r.count('register'),0);
  await r.advance(1);assert.equal(r.count('register'),1);assert.equal(late.length,2);
  const inventory=[{tabId:7,url:CHAT,documentId:null,enabled:false},{tabId:8,url:OTHER,documentId:uuid(708),enabled:false}];
  assert.deepEqual(r.calls[0].body.pages,inventory);
  await r.advance(1500);assert.equal(r.count('poll'),1);
  assert.deepEqual(r.calls.findLast(c=>c.action==='poll').body.pages,inventory);
  for(const resolve of late)resolve([{frameId:0,documentId:uuid(707),result:CHAT}]);
  await r.drain();assert.deepEqual(r.calls[0].body.pages,inventory);
  assert.deepEqual(r.calls.findLast(c=>c.action==='poll').body.pages,inventory);
  await r.resolvePoll(null);await r.advance(1000);await r.advance(1500);
  assert.equal(r.count('poll'),2);assert.deepEqual(r.calls.findLast(c=>c.action==='poll').body.pages,inventory);
  late.at(-1)([]);await r.drain();await r.stop();assert.equal(r.timers.size,0);
});

test('a stalled metadata tab lookup also leaves inventory unknown without injecting after its deadline',async()=>{
  const r=runtime({scripting:async()=>{throw Error('probe_must_not_run');}}),late=[];
  r.context.chrome.tabs.get=()=>new Promise(resolve=>late.push(resolve));
  await r.start();await r.advance(1500);assert.equal(r.count('register'),1);
  assert.equal(r.calls[0].body.pages[0].documentId,null);
  late[0]({id:7,url:CHAT});await r.drain();assert.equal(r.ops.filter(op=>op[0]==='probe').length,0);
  await r.advance(1500);assert.equal(r.count('poll'),1);
  late[1]({id:7,url:CHAT});await r.drain();await r.stop();assert.equal(r.timers.size,0);
});

test('inventory caps matching conversations at 32 and never reads unrelated storage',async()=>{
  const r=runtime();r.query(()=>Array.from({length:45},(_,i)=>({id:i,url:CHAT})));
  r.session.set('unrelated-secret','must-not-be-read');await r.start();
  assert.equal(r.calls[0].body.pages.length,32);
  assert.ok(r.ops.filter(o=>o[0]==='get').every(o=>!o[1].includes('unrelated-secret')));await r.stop();
});

test('independent Edge extension profiles sharing an Origin register distinct persistent profile ids',async()=>{
  const a=runtime({uuidSeed:100}),b=runtime({uuidSeed:200});await a.start();await b.start();
  assert.equal(a.context.chrome.runtime.id,b.context.chrome.runtime.id);
  assert.notEqual(a.calls[0].body.profile_id,b.calls[0].body.profile_id);
  assert.match(a.local.get(PROFILE),/^[0-9a-f-]{36}$/);assert.match(b.local.get(PROFILE),/^[0-9a-f-]{36}$/);
  for(const r of [a,b]){
    assert.deepEqual([...r.local.keys()],[PROFILE]);
    assert.ok(r.ops.filter(op=>op[0]==='localGet').every(op=>op[1]===PROFILE));
    assert.ok(!JSON.stringify([...r.local]).includes('private-peer-token'));await r.stop();
  }
});

test('worker reconstruction preserves profile and instance; browser restart preserves profile with a fresh session instance',async()=>{
  const handlers={register:()=>({success:true,approved:false,peer_id:'peer-one',pairing_nonce:'pairing-display-code'})};
  const first=runtime({handlers,uuidSeed:100});first.local.set('unrelated-local-data',{keep:true});await first.start();
  const initial=first.calls[0].body;await first.stop();
  const worker=runtime({handlers,local:first.local,session:first.session,uuidSeed:300});await worker.start();
  assert.equal(worker.calls[0].body.profile_id,initial.profile_id);assert.equal(worker.calls[0].body.instance_nonce,initial.instance_nonce);
  assert.ok(!worker.ops.some(op=>op[0]==='localSet'));await worker.stop();
  const restarted=runtime({handlers,local:first.local,uuidSeed:500});await restarted.start();
  assert.equal(restarted.calls[0].body.profile_id,initial.profile_id);assert.notEqual(restarted.calls[0].body.instance_nonce,initial.instance_nonce);
  assert.ok(!restarted.ops.some(op=>op[0]==='localSet'));assert.deepEqual(first.local.get('unrelated-local-data'),{keep:true});await restarted.stop();
});

test('approval pending re-registers at two seconds with the same instance and never polls or executes',async()=>{
  const r=runtime({handlers:{register:()=>({success:true,approved:false,peer_id:'peer-one',pairing_nonce:'pairing-display-code'})}});
  await r.start();assert.equal(r.count('register'),1);assert.equal(r.count('poll'),0);
  await r.advance(1999);assert.equal(r.count('register'),1);await r.advance(1);assert.equal(r.count('register'),2);
  assert.equal(r.calls[0].body.instance_nonce,r.calls[1].body.instance_nonce);assert.equal(r.executions.length,0);
  assert.equal(r.session.get(PEER).peer_token,null);assert.ok(!r.calls.some(c=>c.init.headers['X-CLW-Peer']));await r.stop();
});

test('pending approval retains the exact instance when the worker is rebuilt',async()=>{
  const handlers={register:()=>({success:true,approved:false,peer_id:'peer-one',pairing_nonce:'pairing-display-code'})};
  const first=runtime({handlers});await first.start();const nonce=first.calls[0].body.instance_nonce;await first.stop();
  const next=runtime({session:first.session,local:first.local,handlers});await next.start();
  assert.equal(next.calls[0].body.instance_nonce,nonce);assert.equal(next.count('poll'),0);assert.equal(next.executions.length,0);await next.stop();
});

test('only approval enables authenticated polling, and start is idempotent while one poll is live',async()=>{
  const r=runtime();await r.start();await r.start();await r.start();
  assert.equal(r.count('register'),1);assert.equal(r.count('poll'),1);
  assert.equal(r.calls[1].init.headers['X-CLW-Peer'],'private-peer-token');assert.equal(r.executions.length,0);
  assert.equal(r.control.start(),undefined);assert.equal(r.control.stop(),undefined);await r.drain();
});

test('a command runs only after an exact current tab URL check and an uncertainty marker is saved',async()=>{
  const r=runtime();r.execute(async command=>{
    assert.equal(r.pending()[0].state,'unknown');assert.equal(r.pending()[0].command_id,command.id);
    assert.equal(r.ops.findLast(o=>o[0]==='getTab')[1],7);
    return {state:'completed',result:{documentId:'actual-document'}};
  });await r.start();await r.resolvePoll(cmd());
  assert.equal(r.executions.length,1);assert.equal(r.count('result'),1);
  assert.deepEqual(r.calls.find(c=>c.action==='result').body,{peer_id:'peer-one',command_id:uuid(1),state:'completed',result:{documentId:'actual-document'}});
  assert.deepEqual(r.pending(),[]);await r.stop();
});

test('navigation, pending navigation, closed tab, and malformed or foreign commands never execute',async()=>{
  const cases=[
    {tab:{id:7,url:OTHER}}, {tab:{id:7,url:CHAT,pendingUrl:OTHER}}, {tab:null},
    {command:cmd({chatUrl:'https://chatgpt.com.evil.test/c/1234567890123456'})},
    {command:cmd({chatUrl:CHAT+'#fragment'})}, {command:cmd({tabId:'7'})},
    {command:cmd({type:'fetch'})}, {command:cmd({target:BASE})},
    {command:cmd({payload:{url:'https://example.test/'}})}, {command:cmd({documentId:''})},
    {command:cmd({type:'send',payload:{text:'x'.repeat(65537)}})},
    {command:cmd({type:'send',payload:{text:42}})}, {command:cmd({payload:{text:'implicit send'}})},
  ];
  for(const c of cases){
    const r=runtime();await r.start();if(Object.hasOwn(c,'tab')){if(c.tab)r.tabs.set(7,c.tab);else r.tabs.delete(7);}
    await r.resolvePoll(c.command??cmd());assert.equal(r.executions.length,0);
    assert.equal(r.calls.find(call=>call.action==='result').body.state,'failed');await r.stop();
  }
});

test('unreadable tabs fail before execution and the same peer can inspect a later readable page',async()=>{
  for(const unreadable of [{discarded:true},{frozen:true},{status:'loading'}]){
    for(const type of ['inspect','watch','continue','send','reload','stop_generation']){
      const r=runtime();await r.start();r.tabs.set(7,{id:7,url:CHAT,...unreadable});
      await r.resolvePoll(cmd({type,payload:type==='send'?{text:'must not be sent'}:{}}));
      assert.equal(r.executions.length,0);assert.equal(r.count('result'),1);
      const receipt=r.calls.find(c=>c.action==='result').body;
      assert.equal(receipt.state,'failed');assert.equal(receipt.result.code,'page_not_readable');
      assert.equal(receipt.result.discarded,!!unreadable.discarded);assert.equal(receipt.result.frozen,!!unreadable.frozen);
      assert.equal(receipt.result.status,unreadable.status??null);
      r.tabs.set(8,{id:8,url:OTHER,status:'complete'});await r.advance(1000);
      await r.resolvePoll(cmd({id:uuid(2),tabId:8,chatUrl:OTHER}));
      assert.equal(r.executions.length,1);assert.equal(r.executions[0].tabId,8);
      assert.equal(r.calls.findLast(c=>c.action==='result').body.state,'completed');
      await r.stop();assert.equal(r.timers.size,0);
    }
  }
});

test('unwatch and extension self-reload remain available when their bound page is discarded, frozen, or loading',async()=>{
  for(const unreadable of [{discarded:true},{frozen:true},{status:'loading'}]){
    for(const type of ['unwatch','reload_extension']){
      const r=runtime();await r.start();r.tabs.set(7,{id:7,url:CHAT,...unreadable});
      const command=cmd({type});await r.resolvePoll(command);
      assert.deepEqual(r.executions,[command]);assert.equal(r.calls.find(c=>c.action==='result').body.state,'completed');await r.stop();
    }
  }
});

test('inspection briefly activates a frozen tab in a background window and restores the original active tab',async()=>{
  const r=frozenRuntime();r.execute(async command=>{
    assert.equal(command.type,'inspect');assert.equal(r.tabs.get(7).active,true);assert.equal(r.tabs.get(8).active,false);
    assert.equal(r.windows.get(70).focused,false);return {state:'completed',result:{read:true}};
  });await r.start();assert.equal(r.ops.filter(op=>op[0]==='updateTab').length,0);
  await r.resolvePoll(cmd());assert.equal(r.executions.length,1);
  assert.deepEqual(r.ops.filter(op=>op[0]==='updateTab'),[['updateTab',7,{active:true}],['updateTab',8,{active:true}]]);
  assert.equal(r.tabs.get(8).active,true);assert.equal(r.windows.get(70).focused,false);
  assert.deepEqual(r.calls.find(c=>c.action==='result').body.result,{read:true});
  assert.equal(r.activationListeners.size,0);assert.equal(r.focusListeners.size,0);await r.stop();
});

test('a frozen tab in a foreground window fails explicitly without changing the active tab or executing',async()=>{
  const r=frozenRuntime();r.windows.get(70).focused=true;await r.start();await r.resolvePoll(cmd());
  assert.equal(r.executions.length,0);assert.equal(r.tabs.get(8).active,true);
  assert.equal(r.ops.filter(op=>op[0]==='updateTab').length,0);
  const receipt=r.calls.find(c=>c.action==='result').body;assert.equal(receipt.state,'failed');
  assert.equal(receipt.result.code,'page_frozen_foreground_window');
  assert.equal(r.activationListeners.size,0);assert.equal(r.focusListeners.size,0);await r.stop();
});

test('focus or active-tab changes during frozen preflight prevent the temporary activation',async()=>{
  for(const kind of ['focus','active']){
    const r=frozenRuntime();await r.start();
    if(kind==='focus'){
      const get=r.context.chrome.windows.get;let calls=0;
      r.context.chrome.windows.get=async id=>{if(++calls===2)r.focus(70,true);return get(id);};
    }else{
      const get=r.context.chrome.tabs.get;let calls=0;
      r.context.chrome.tabs.get=async id=>{if(id===7&&++calls===2)r.activate(9);return get(id);};
    }
    await r.resolvePoll(cmd());assert.equal(r.executions.length,0);
    assert.equal(r.ops.filter(op=>op[0]==='updateTab').length,0);
    assert.equal(r.calls.find(c=>c.action==='result').body.result.code,kind==='focus'?'page_frozen_foreground_window':'page_frozen_user_interaction');
    assert.equal(r.activationListeners.size,0);assert.equal(r.focusListeners.size,0);await r.stop();
  }
});

test('user tab changes or a focus visit during frozen inspection prevent restoration even if later reversed',async()=>{
  for(const interaction of [r=>r.activate(9),r=>{r.activate(9);r.activate(7);},r=>r.focus(70,true),r=>{r.focus(70,true);r.focus(70,false);}]){
    let complete;const r=frozenRuntime();r.execute(()=>new Promise(resolve=>{complete=resolve;}));
    await r.start();await r.resolvePoll(cmd());assert.equal(r.tabs.get(7).active,true);
    interaction(r);complete({state:'completed',result:{read:true}});await r.drain();
    assert.deepEqual(r.ops.filter(op=>op[0]==='updateTab'),[['updateTab',7,{active:true}]]);
    assert.equal(r.calls.find(c=>c.action==='result').body.state,'completed');
    assert.equal(r.activationListeners.size,0);assert.equal(r.focusListeners.size,0);await r.stop();
  }
});

test('a frozen inspection timeout restores in finally and a late result never changes or repeats its receipt',async()=>{
  let complete;const r=frozenRuntime();r.execute(()=>new Promise(resolve=>{complete=resolve;}));
  await r.start();await r.resolvePoll(cmd());await r.advance(9999);assert.equal(r.count('result'),0);
  await r.advance(1);assert.equal(r.count('result'),1);assert.equal(r.count('poll'),2);
  assert.equal(r.tabs.get(8).active,true);
  assert.deepEqual(r.ops.filter(op=>op[0]==='updateTab'),[['updateTab',7,{active:true}],['updateTab',8,{active:true}]]);
  const receipt=clone(r.calls.find(c=>c.action==='result').body),journal=clone(r.session.get(RECEIPTS));
  assert.equal(receipt.state,'failed');assert.deepEqual(receipt.result,{code:'inspection_timeout'});
  complete({state:'completed',result:{late:true}});await r.drain();
  assert.equal(r.count('result'),1);assert.deepEqual(r.session.get(RECEIPTS),journal);
  assert.deepEqual(r.calls.find(c=>c.action==='result').body,receipt);
  await r.resolvePoll(cmd());assert.equal(r.executions.length,1);assert.equal(r.count('result'),1);
  assert.equal(r.activationListeners.size,0);assert.equal(r.focusListeners.size,0);await r.stop();
});

test('a closed or moved original active tab is never recreated or restored after frozen inspection',async()=>{
  for(const change of [r=>r.tabs.delete(8),r=>{r.tabs.get(8).windowId=71;}]){
    let complete;const r=frozenRuntime();r.execute(()=>new Promise(resolve=>{complete=resolve;}));
    await r.start();await r.resolvePoll(cmd());change(r);complete({state:'completed',result:{read:true}});await r.drain();
    assert.deepEqual(r.ops.filter(op=>op[0]==='updateTab'),[['updateTab',7,{active:true}]]);
    assert.equal(r.calls.find(c=>c.action==='result').body.state,'completed');
    assert.equal(r.activationListeners.size,0);assert.equal(r.focusListeners.size,0);await r.stop();
  }
});

test('an inspection exception still restores the background active tab and keeps the original unknown semantics',async()=>{
  const r=frozenRuntime();r.execute(async()=>{throw Error('inspection_failed');});await r.start();await r.resolvePoll(cmd());
  assert.equal(r.tabs.get(8).active,true);assert.equal(r.calls.find(c=>c.action==='result').body.state,'unknown');
  assert.deepEqual(r.calls.find(c=>c.action==='result').body.result,{code:'execution_exception'});await r.stop();
});

test('a hung inspection fails after ten seconds, polling continues, and its late result never changes or reuploads the receipt',async()=>{
  let complete;const r=runtime();
  r.execute(command=>command.id===uuid(1)?new Promise(resolve=>{complete=resolve;}):Promise.resolve({state:'completed',result:{ready:true}}));
  await r.start();await r.resolvePoll(cmd());assert.equal(r.executions.length,1);
  await r.advance(9999);assert.equal(r.count('result'),0);assert.equal(r.pending()[0].state,'unknown');
  await r.advance(1);assert.equal(r.count('result'),1);assert.equal(r.count('poll'),2);
  const timedOut=r.calls.find(c=>c.action==='result').body;
  assert.deepEqual(timedOut,{peer_id:'peer-one',command_id:uuid(1),state:'failed',result:{code:'inspection_timeout'}});
  r.tabs.set(8,{id:8,url:OTHER});await r.resolvePoll(cmd({id:uuid(2),tabId:8,chatUrl:OTHER}));
  assert.equal(r.executions.length,2);assert.equal(r.calls.findLast(c=>c.action==='result').body.state,'completed');
  const journal=clone(r.session.get(RECEIPTS)),uploads=r.count('result');
  complete({state:'completed',result:{late:true}});await r.drain();
  assert.deepEqual(r.session.get(RECEIPTS),journal);assert.equal(r.count('result'),uploads);
  assert.deepEqual(r.calls.find(c=>c.action==='result').body,timedOut);
  await r.advance(1000);await r.resolvePoll(cmd());
  assert.equal(r.executions.length,2);assert.equal(r.count('result'),uploads);
  await r.stop();assert.equal(r.timers.size,0);
});

test('side-effect execution stays pending beyond the inspection deadline and is never replayed',async()=>{
  let complete;const r=runtime();r.execute(()=>new Promise(resolve=>{complete=resolve;}));
  const command=cmd({type:'send',payload:{text:'only once'}});await r.start();await r.resolvePoll(command);
  await r.advance(30000);assert.equal(r.executions.length,1);assert.equal(r.count('poll'),1);assert.equal(r.count('result'),0);
  assert.equal(r.pending()[0].state,'unknown');assert.deepEqual(r.pending()[0].result,{code:'execution_interrupted'});
  complete({state:'completed',result:{sent:true}});await r.drain();await r.advance(0);
  assert.equal(r.calls.find(c=>c.action==='result').body.state,'completed');
  await r.resolvePoll(command);assert.equal(r.executions.length,1);assert.equal(r.count('result'),1);await r.stop();
});

test('all supported allowed types and literal send text reach the configured executor unchanged',async()=>{
  for(const [i,type] of ['inspect','watch','unwatch','continue','send','reload','stop_generation','reload_extension','approve_tool'].entries()){
    const r=runtime();await r.start();
    const command=cmd({id:uuid(i+1),type,payload:type==='send'?{text:'原文\n$(do not evaluate) `literal` \\"'}:{}});
    await r.resolvePoll(command);assert.deepEqual(r.executions,[command]);await r.stop();
  }
  const boundary=runtime();await boundary.start();const command=cmd({type:'send',payload:{text:'a'.repeat(65536)}});
  await boundary.resolvePoll(command);assert.deepEqual(boundary.executions,[command]);await boundary.stop();
});

test('duplicate ids are never executed again after a successful result upload or worker reconstruction',async()=>{
  const r=runtime();await r.start();await r.resolvePoll(cmd());await r.advance(1000);await r.resolvePoll(cmd({type:'reload'}));
  assert.equal(r.executions.length,1);assert.equal(r.count('result'),1);await r.stop();
  const next=runtime({session:r.session,local:r.local});await next.start();await next.resolvePoll(cmd());
  assert.equal(next.executions.length,0);assert.equal(next.count('register'),0);assert.equal(next.count('result'),0);await next.stop();
});

test('lost result reply retries the original receipt without repeating execution',async()=>{
  let tries=0;const r=runtime({handlers:{result:call=>{if(++tries===1)throw Error('reply_lost');return {success:true};}}});
  await r.start();await r.resolvePoll(cmd({type:'send',payload:{text:'send once'}}));
  assert.equal(r.executions.length,1);assert.equal(r.pending().length,1);const first=r.calls.find(c=>c.action==='result').body;
  await r.advance(5000);assert.equal(r.count('result'),2);assert.deepEqual(r.calls.filter(c=>c.action==='result')[1].body,first);
  assert.equal(r.executions.length,1);assert.deepEqual(r.pending(),[]);await r.stop();
});

test('recreated worker uploads saved receipts before polling and never reconstructs a command',async()=>{
  const r=runtime({handlers:{result:()=>{throw Error('offline');}}});await r.start();await r.resolvePoll(cmd());await r.stop();
  const saved=clone(r.session.get(RECEIPTS));assert.ok(!JSON.stringify(saved).includes(CHAT));
  const next=runtime({session:r.session,local:r.local});await next.start();
  assert.deepEqual(next.calls.map(c=>c.action),['result','poll']);assert.equal(next.executions.length,0);
  assert.deepEqual(next.calls[0].body,saved.pending[0]);await next.stop();
});

test('a pre-execution crash marker is uploaded as unknown, and its id is never replayed',async()=>{
  const session=new Map([[PEER,{version:1,instance_nonce:uuid(100),peer_id:'peer-one',peer_token:'private-peer-token'}],
    [RECEIPTS,{version:1,pending:[{peer_id:'peer-one',command_id:uuid(1),state:'unknown',result:{code:'execution_interrupted'}}],seen:[uuid(1)]}]]);
  const r=runtime({session});await r.start();assert.equal(r.calls[0].body.state,'unknown');await r.resolvePoll(cmd());
  assert.equal(r.executions.length,0);await r.stop();
});

test('execution exceptions and invalid executor responses are unknown; explicit failure remains failure',async()=>{
  for(const [executor,state,result] of [
    [async()=>{throw Error('private diagnostic');},'unknown',{code:'execution_exception'}],
    [async()=>({success:true}),'unknown',{code:'execution_result_invalid'}],
    [async()=>({state:'failed',result:{code:'draft_present'}}),'failed',{code:'draft_present'}],
  ]){
    const r=runtime();r.execute(executor);await r.start();await r.resolvePoll(cmd());
    const receipt=r.calls.find(c=>c.action==='result').body;assert.equal(receipt.state,state);assert.deepEqual(receipt.result,result);await r.stop();
  }
});

test('results are bounded JSON and unsafe shapes never escape through the receipt',async()=>{
  const circular={};circular.self=circular;
  const deep={};let child=deep;for(let i=0;i<17;i++){child.next={};child=child.next;}
  for(const [value,expected] of [['x'.repeat(70000),{code:'result_too_large'}],['中'.repeat(24000),{code:'result_too_large'}],[deep,{code:'result_structure_too_large'}],[circular,{code:'result_not_json'}],[undefined,null]]){
    const r=runtime();r.execute(async()=>({state:'completed',result:value}));await r.start();await r.resolvePoll(cmd());
    assert.deepEqual(r.calls.find(c=>c.action==='result').body.result,expected);await r.stop();
  }
});

test('continue supports optional literal text, including 65536 Unicode code points or escaped control characters',async()=>{
  for(const text of ['继续原任务。','😀'.repeat(65536),'\u0001'.repeat(65536)]){
    const r=runtime();await r.start();const command=cmd({type:'continue',payload:{text}});
    await r.resolvePoll(command);assert.deepEqual(r.executions,[command]);await r.stop();
  }
  const r=runtime();await r.start();await r.resolvePoll(cmd({type:'continue',payload:{text:'😀'.repeat(65537)}}));
  assert.equal(r.executions.length,0);assert.equal(r.calls.find(c=>c.action==='result').body.state,'failed');await r.stop();
});

test('401/403/404 invalidate only registration and retain original receipts without leaking tokens across peers',async()=>{
  for(const status of [401,403,404]){
    let registerCount=0;
    const r=runtime({handlers:{register:()=>approved(++registerCount===1?{}:{peer_id:'peer-two',peer_token:'new-private-token'}),result:()=>response({},status)}});
    await r.start();const nonce=r.calls[0].body.instance_nonce;await r.resolvePoll(cmd());
    assert.equal(r.session.get(PEER).peer_id,null);assert.equal(r.session.get(PEER).peer_token,null);
    assert.equal(r.pending()[0].peer_id,'peer-one');await r.advance(5000);
    assert.equal(r.session.get(PEER).peer_id,'peer-two');assert.equal(r.calls.findLast(c=>c.action==='register').body.instance_nonce,nonce);
    assert.equal(r.count('result'),1);assert.equal(r.calls.findLast(c=>c.action==='poll').init.headers['X-CLW-Peer'],'new-private-token');
    assert.equal(r.executions.length,1);await r.stop();
  }
});

test('missing server backs off locally at 5/15/30 seconds without touching a tab',async()=>{
  const r=runtime({handlers:{register:()=>{throw Error('connection_refused');}}});await r.start();
  await r.advance(4999);assert.equal(r.calls.length,1);await r.advance(1);assert.equal(r.calls.length,2);
  await r.advance(15000);assert.equal(r.calls.length,3);await r.advance(30000);assert.equal(r.calls.length,4);
  assert.equal(r.executions.length,0);assert.ok(r.calls.every(c=>c.url===BASE+'/extension/register'));assert.ok(!r.ops.some(o=>o[0]==='getTab'));await r.stop();
});

test('empty fast replies are paced, and stalled poll fetch is aborted after 25 seconds',async()=>{
  const r=runtime();await r.start();await r.resolvePoll(null);
  await r.advance(999);assert.equal(r.count('poll'),1);await r.advance(1);assert.equal(r.count('poll'),2);
  const signal=r.calls.findLast(c=>c.action==='poll').init.signal;await r.advance(24999);assert.equal(signal.aborted,false);
  await r.advance(1);assert.equal(signal.aborted,true);assert.equal(r.count('poll'),2);await r.stop();
});

test('stop cancels polling and all timers; start after stop still owns only one poll',async()=>{
  const r=runtime();await r.start();const signal=r.calls[1].init.signal;
  r.control.stop();r.control.start();await r.drain();assert.equal(signal.aborted,true);assert.equal(r.count('poll'),2);
  await r.stop();assert.equal(r.timers.size,0);const count=r.calls.length;await r.advance(60000);assert.equal(r.calls.length,count);
});

test('stop during execution preserves its result but does not upload or execute another command',async()=>{
  let complete;const r=runtime();r.execute(()=>new Promise(resolve=>{complete=resolve;}));await r.start();await r.resolvePoll(cmd());
  assert.equal(r.executions.length,1);r.control.stop();complete({state:'completed',result:{sent:true}});await r.drain();
  assert.equal(r.count('result'),0);assert.deepEqual(r.pending()[0].result,{sent:true});assert.equal(r.timers.size,0);
  await r.start();assert.equal(r.count('result'),1);assert.equal(r.executions.length,1);await r.stop();
});

test('a corrupt receipt journal fails closed without network or action',async()=>{
  const r=runtime();r.session.set(RECEIPTS,{version:1,pending:'invalid',seen:[]});await r.start();
  assert.equal(r.calls.length,0);assert.equal(r.executions.length,0);assert.equal(r.timers.size,0);await r.stop();
});

test('a failed uncertainty-marker write prevents execution and retains an unknown receipt for retry',async()=>{
  const r=runtime();await r.start();const original=r.context.chrome.storage.session.set;let fail=true;
  r.context.chrome.storage.session.set=async values=>{if(fail&&Object.hasOwn(values,RECEIPTS)){fail=false;throw Error('storage_unavailable');}return original(values);};
  await r.resolvePoll(cmd({type:'send',payload:{text:'must not be sent'}}));assert.equal(r.executions.length,0);
  await r.advance(5000);assert.equal(r.executions.length,0);assert.equal(r.calls.find(c=>c.action==='result').body.state,'unknown');await r.stop();
});

test('orphan receipts stay separate from a new peer, and a full receipt journal pauses polling',async()=>{
  const pending=Array.from({length:16},(_,i)=>({peer_id:'old-peer',command_id:uuid(i+1),state:'unknown',result:{code:'execution_interrupted'}}));
  const r=runtime();r.session.set(RECEIPTS,{version:1,pending,seen:pending.map(p=>p.command_id)});await r.start();
  assert.equal(r.count('register'),1);assert.equal(r.count('poll'),0);assert.equal(r.count('result'),0);
  assert.deepEqual(r.pending(),pending);await r.advance(5000);assert.equal(r.count('poll'),0);await r.stop();
});
