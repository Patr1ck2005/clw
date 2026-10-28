'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{createHash}=require('node:crypto');
const {WebDriver}=require('../web-driver.cjs');
const hash=s=>createHash('sha256').update(s).digest('hex');
function fixture({viewing=false,paused=false,settles=true,draft=false,generating=false,phase='bound'}={}){
  const calls=[],actions=[],runtime=new EventEmitter();
  const row={page_id:'original',url:'https://chatgpt.com/c/original',phase,paused,model:'GPT-6',effort:'Pro',latest_request:phase==='bound'?{id:'request',phase:'processing'}:null,
    bootstrap_state:phase==='bound'?null:'sent',marker:phase==='bound'?null:'CLW-MANAGED:original:receipt'};
  const page={id:row.page_id,documentGeneration:1,metrics:'1200:800',view:{webContents:{getURL:()=>row.url}}};let latest=false;
  const state={viewing,settles,draft,generating};
  runtime.call=async(op,p)=>{calls.push({op,p});if(op==='pending-receipt'||(op==='wire'&&p.data.action==='pulse'))return {state:'browser_result_pending',attempt_id:'attempt',sent_user_hash:hash('current'),assistant_before_hash:hash('previous')};if(op==='artifact')return {path:'saved.md'};return {state:'completed'};};
  const driver=new WebDriver({runtime,pool:{pages:new Map([[page.id,page]]),running(){},isUserViewing:()=>state.viewing},onNotice(){},dom:async(_wc,action)=>{
    actions.push(action);
    if(action==='show-latest'){latest=state.settles;return {moved:true};}
    assert.equal(action,'snapshot');
    return {url:row.url,editor:true,controlKnown:true,userId:latest?'current':'historical',assistantId:latest?'answer':'old-answer',historyAtLatest:latest,stopped:!latest,complete:true,html:latest?'<p>current result</p>':'<p>old result</p>',draft:state.draft,generating:state.generating};
  }});
  return {driver,row,page,calls,actions,state};
}

test('background old history materializes the accepted answer and collects once without a model turn',async()=>{
  const f=fixture();
  await f.driver.tick(f.row);
  assert.deepEqual(f.actions,['snapshot','show-latest']);assert.deepEqual(f.calls,[]);
  await f.driver.tick(f.row);f.driver.resultCandidates.get('attempt').at=0;
  await f.driver.tick(f.row);await f.driver.tick(f.row);
  assert.equal(f.calls.filter(c=>c.op==='wire'&&c.p.data.action==='result').length,1);
  assert.ok(f.calls.every(c=>c.op==='artifact'||(c.op==='wire'&&['pulse','result'].includes(c.p.data.action))));
  assert.ok(!f.actions.includes('send'));
});

test('foreground reading, drafting and generation never move the viewport or interpret an old Stop',async()=>{
  for(const options of [{viewing:true},{draft:true},{generating:true}]){
    const f=fixture(options);await f.driver.tick(f.row);
    assert.deepEqual(f.actions,['snapshot']);assert.deepEqual(f.calls,[]);
  }
});

test('pause still collects the original accepted reply without pulse or send',async()=>{
  const f=fixture({paused:true});
  await f.driver.tick(f.row);await f.driver.tick(f.row);
  f.driver.resultCandidates.get('attempt').at=0;
  await f.driver.tick(f.row);await f.driver.tick(f.row);
  assert.equal(f.calls.filter(c=>c.op==='wire'&&c.p.data.action==='result').length,1);
  assert.ok(f.calls.every(c=>c.op==='pending-receipt'||c.op==='artifact'||(c.op==='wire'&&c.p.data.action==='result')));
  assert.ok(!f.actions.includes('send'));
});

test('a history viewport that does not settle has bounded navigation and never retries the task',async()=>{
  const f=fixture({settles:false});
  for(let n=0;n<8;n++)await f.driver.tick(f.row);
  assert.equal(f.actions.filter(a=>a==='show-latest').length,3);
  assert.deepEqual(f.calls,[]);assert.equal(f.page.observation.historyAtLatest,false);
});

test('a delayed result after the first navigation batch is collected once after cooldown, without Send',async()=>{
  const f=fixture({settles:false});
  for(let n=0;n<8;n++)await f.driver.tick(f.row);
  assert.equal(f.actions.filter(a=>a==='show-latest').length,3);
  f.state.settles=true;f.page.historyFollow.retryAt=0;
  await f.driver.tick(f.row);await f.driver.tick(f.row);
  f.driver.resultCandidates.get('attempt').at=0;
  await f.driver.tick(f.row);await f.driver.tick(f.row);
  assert.equal(f.actions.filter(a=>a==='show-latest').length,4);
  assert.equal(f.calls.filter(c=>c.op==='wire'&&c.p.data.action==='result').length,1);
  assert.equal(f.page.historyFollow,null);
  assert.ok(!f.actions.includes('send'));
});

test('new document or viewport restores only the read-only navigation budget',async()=>{
  for(const change of [p=>p.documentGeneration++,p=>p.metrics='800:600']){
    const f=fixture({settles:false});for(let n=0;n<4;n++)await f.driver.tick(f.row);
    change(f.page);f.state.settles=true;await f.driver.tick(f.row);
    assert.equal(f.actions.filter(a=>a==='show-latest').length,4);
    assert.deepEqual(f.calls,[]);assert.ok(!f.actions.includes('send'));
  }
});

test('cooldown does not move a page newly being read, drafted or generated',async()=>{
  for(const flag of ['viewing','draft','generating']){
    const f=fixture({settles:false});for(let n=0;n<4;n++)await f.driver.tick(f.row);
    f.page.historyFollow.retryAt=0;f.state[flag]=true;await f.driver.tick(f.row);
    assert.equal(f.actions.filter(a=>a==='show-latest').length,3);assert.deepEqual(f.calls,[]);
  }
});

test('pending or changed viewport setup cannot consume navigation or attribute an old result',async()=>{
  const f=fixture({settles:false});let settle;
  f.page.viewportReady=new Promise(resolve=>{settle=resolve;});
  const observing=f.driver.tick(f.row);
  setImmediate(()=>{f.page.metrics='900:700';settle();});
  await observing;assert.deepEqual(f.actions,['snapshot']);assert.deepEqual(f.calls,[]);
  await f.driver.tick(f.row);assert.deepEqual(f.actions,['snapshot','snapshot','show-latest']);
});

test('stopped runtime or replaced original renderer during viewport wait prevents further navigation',async()=>{
  for(const change of [f=>f.driver.stop(),f=>{f.driver.runtime.closed=true;},
      f=>{f.driver.pool.pages.delete(f.page.id);},f=>{f.page.view={webContents:{getURL:()=>f.row.url}};},
      f=>{f.page.closed=true;}]){
    const f=fixture({settles:false});let settle;
    f.page.viewportReady=new Promise(resolve=>{settle=resolve;});
    const observing=f.driver.tick(f.row);setImmediate(()=>{change(f);settle();});
    await observing;assert.deepEqual(f.actions,['snapshot']);assert.deepEqual(f.calls,[]);
    assert.equal(f.page.historyFollow.moves,0);
  }
});

test('background accepted enrollment follows its original reply even while locally paused',async()=>{
  const f=fixture({phase:'receiver_enrolled',paused:true});
  await f.driver.tick(f.row);
  assert.deepEqual(f.actions,['snapshot','show-latest']);
  assert.deepEqual(f.calls,[]);
  assert.equal(f.page.historyFollow.requestId,'bootstrap:original');
  assert.ok(!f.actions.includes('send'));
});

test('foreground or unfinished enrollment does not move its page',async()=>{
  for(const options of [{viewing:true},{draft:true},{generating:true}]){
    const f=fixture({...options,phase:'receiver_enrolled'});await f.driver.tick(f.row);
    assert.deepEqual(f.actions,['snapshot']);assert.deepEqual(f.calls,[]);
  }
});
