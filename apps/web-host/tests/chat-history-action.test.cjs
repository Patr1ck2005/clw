"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const forbidden=label=>()=>assert.fail('cache-only history must not '+label);
function fixture(){
  const start=source.indexOf('  const dispatchCommand=async'),end=source.indexOf('  shellControl=new ShellControl',start);
  assert.ok(start>=0&&end>start);let handle;
  const cached={A:{account:'A',models:[{id:'latest-pro',status:'available',source:'public_model_menu'}],usage:{lastGood:{completedProResponses:50,coverage:{state:'complete'}},
    lastAttempt:{coverage:{state:'partial',conversationsRead:11,conversationsListed:41,reason:'rate_limited'}},stale:true}},
    B:{account:'B',models:[{id:'latest-pro',status:'unknown',source:'unknown'}],usage:{lastGood:null,lastAttempt:{coverage:{state:'failed',reason:'http_403',diagnostic:{browserVerification:true,stage:'auth'}}},stale:true}}};
  const reports=[],reads=[];
  const quotas=new Map(['A','B'].map(account=>[account,{account,snapshot:()=>{reads.push(account);return cached[account];},
    recordUsage:forbidden('write cached statistics'),save:forbidden('save account data'),
    report:(model,metadata)=>{reports.push({account,model,metadata});return {account,state:'reported'};}}]));
  const pages=new Map(['A','B'].map(account=>[account,{account,url:'https://chatgpt.com/c/original-'+account,draft:'original draft',generation:4}]));
  const records=new Map(['A','B'].map(account=>[account,{account,request:'original-request-'+account,goal:{state:'paused'},paused:true}]));
  const legacyProgress=new Map([['A',{state:'reading',conversationsRead:11}]]);
  const sandbox={ipcMain:{handle:(_name,fn)=>{handle=fn;}},ownShell(){},recordCommands:{actions:new Set()},maintenanceChecking:false,
    isolatedCheck:false,checkActions:[],quitting:false,driver:{records,pageAdapterReloading:false,inspect:forbidden('inspect or open a model menu')},quotas,Date,URL,
    guard:new Proxy({}, {get:forbidden('consult or change the network guard')}),
    session:{fromPartition:forbidden('access a browser session'),fetch:forbidden('issue a request')},
    fetchSession:forbidden('issue a request'),runDom:forbidden('read a page or model menu'),collectChatHistoryUsage:forbidden('start a history scan'),
    createPageHistoryFetch:forbidden('create a history transport'),createHistoryVerification:forbidden('create a verification helper'),
    historyVerification:{open:forbidden('open a verification window')},BrowserWindow:class{constructor(){assert.fail('cache-only must not create a window');}},
    pool:{pages,selected:'A',ensure:forbidden('hydrate a page'),create:forbidden('create a page'),select:forbidden('select a page'),
      pin:forbidden('pin a page'),unpin:forbidden('unpin a page')},
    partitionForAccount:forbidden('resolve a network partition'),setTimeout:forbidden('schedule waiting/retries'),
    clearTimeout:forbidden('change a timer'),quotaHistoryProgress:legacyProgress,publish:forbidden('start a state refresh for a disabled action')};
  vm.runInNewContext(source.slice(start,end),sandbox,{filename:'main-cache-only-history.cjs'});
  return {cached,quotas,reads,reports,sandbox,pages,records,legacyProgress,
    dispatch:(action,payload={})=>handle({}, {action,payload})};
}
function originalState(f){return JSON.stringify({cached:f.cached,pages:[...f.pages],records:[...f.records],progress:[...f.legacyProgress]});}
function disabled(result,account){assert.deepEqual(plain(result),{account,state:'history_read_disabled',policy:'cache_only',model_sends:0,remote_requests:0});}

test('both compatible account-history actions return cache-only receipts with zero requests and unchanged cached/task state',async()=>{
  const f=fixture(),before=originalState(f);
  for(const action of ['quota-history','quota-verify'])for(const account of ['A','B'])disabled(await f.dispatch(action,{account}),account);
  assert.equal(originalState(f),before);assert.deepEqual(f.reads,[]);assert.deepEqual(f.reports,[]);
});

test('legacy auxiliary model-status check is also cache-only and never ensures, inspects or changes the original page',async()=>{
  const f=fixture(),before=originalState(f);f.sandbox.driver.pageAdapterReloading=true;
  for(const account of ['A','B'])assert.deepEqual(plain(await f.dispatch('quota-check',{account})),
    {account,state:'model_status_read_disabled',policy:'cache_only',model_sends:0,remote_requests:0});
  await assert.rejects(f.dispatch('quota-check',{account:'C'}),/quota_account_invalid/);
  assert.equal(originalState(f),before);assert.deepEqual(f.reads,[]);assert.deepEqual(f.reports,[]);
});

test('repeated update/verification actions stay synchronous-cache-only and cannot queue, retry, hydrate or collect',async()=>{
  const f=fixture(),before=originalState(f);
  const receipts=await Promise.all(Array.from({length:20},(_,i)=>f.dispatch(i%2?'quota-history':'quota-verify',{account:i%3?'A':'B'})));
  for(const r of receipts){assert.equal(r.state,'history_read_disabled');assert.equal(r.remote_requests,0);}
  assert.equal(originalState(f),before);assert.deepEqual(f.reads,[]);
});

test('disabled actions work without ready VPN, account login, original page or persisted verification evidence',async()=>{
  const f=fixture(),before=JSON.stringify(f.cached);f.pages.clear();f.records.clear();f.sandbox.quitting=true;
  for(const action of ['quota-history','quota-verify'])for(const account of ['A','B'])disabled(await f.dispatch(action,{account}),account);
  assert.equal(JSON.stringify(f.cached),before);assert.deepEqual(f.reads,[]);
});

test('a prior valid custom start is accepted for compatibility but cannot change the saved window or launch a scan',async()=>{
  const f=fixture(),before=originalState(f);disabled(await f.dispatch('quota-history',{account:'A',since:Date.now()-86400000}),'A');
  assert.equal(originalState(f),before);assert.deepEqual(f.reads,[]);
});

test('invalid accounts and unexpected targets remain invalid without touching any browser/network or cache',async()=>{
  const f=fixture(),before=originalState(f);
  for(const action of ['quota-history','quota-verify']){
    for(const account of ['C',null,undefined])await assert.rejects(f.dispatch(action,{account}),/quota_account_invalid/);
    for(const extra of [{url:'https://chatgpt.com/api/auth/session'},{stage:'auth'},{id:'original-task'},{browserVerification:true}])
      await assert.rejects(f.dispatch(action,{account:'A',...extra}),/quota_history_payload_invalid/);
  }
  await assert.rejects(f.dispatch('quota-history',{account:'A',since:NaN}),/quota_history_payload_invalid/);
  await assert.rejects(f.dispatch('quota-verify',{account:'A',since:Date.now()-1000}),/quota_history_payload_invalid/);
  assert.equal(originalState(f),before);assert.deepEqual(f.reads,[]);
});

test('saved complete/partial/failed statistics are projected under cache-only policy without overwriting their historical evidence',()=>{
  const f=fixture(),before=JSON.stringify(f.cached);
  const declaration=source.split('\n').find(line=>line.startsWith('const quotaSnapshots='));assert.ok(declaration);
  const snapshots=plain(vm.runInNewContext(declaration+'\nquotaSnapshots();',{quotas:f.quotas}));
  assert.deepEqual(snapshots,['A','B'].map(account=>({...f.cached[account],historyPolicy:'cache_only',historyProgress:null})));
  assert.equal(snapshots[0].usage.lastGood.completedProResponses,50);assert.equal(snapshots[0].usage.lastAttempt.coverage.state,'partial');
  assert.equal(snapshots[1].usage.lastAttempt.coverage.diagnostic.browserVerification,true);
  assert.deepEqual(snapshots[0].models,f.cached.A.models);assert.deepEqual(snapshots[1].models,f.cached.B.models);
  assert.equal(JSON.stringify(f.cached),before);assert.deepEqual(f.reads,['A','B']);
  assert.equal((source.match(/quotas:quotaSnapshots\(\)/g)||[]).length,2,'UI state and formal control state must share cache-only projection');
});

test('production main no longer constructs or calls history readers or verification windows',()=>{
  assert.doesNotMatch(source,/require\(['"]\.\/chat-history-(?:page|usage|verification)\.cjs['"]\)/);
  assert.doesNotMatch(source,/collectChatHistoryUsage|createPageHistoryFetch|createHistoryVerification|historyVerification|quotaHistoryProgress/);
});

test('the existing explicit local quota report remains separate and does not enable history reads',async()=>{
  const f=fixture();let localRefreshes=0;f.sandbox.publish=()=>{localRefreshes++;};
  assert.equal((await f.dispatch('quota-report',{account:'A',model:'latest-pro',exhausted:true})).state,'reported');
  assert.equal(localRefreshes,1);f.sandbox.publish=forbidden('refresh state for a disabled history action');
  assert.deepEqual(plain(f.reports),[{account:'A',model:'latest-pro',metadata:{exhausted:true,resetText:''}}]);
  disabled(await f.dispatch('quota-history',{account:'A'}),'A');assert.deepEqual(f.reads,[]);
});
