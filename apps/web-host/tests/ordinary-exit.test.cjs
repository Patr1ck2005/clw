'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createOrdinaryExit}=require('../ordinary-exit.cjs');
const {createExitLifecycle}=require('../exit-lifecycle.cjs');
function fixture(){let generating=true,closed=0,paused=0,scheduled,events=[];
 const exit=createOrdinaryExit({pauseFuture:async()=>{paused++;},readActivity:async()=>({active:generating?[{page_id:'camp',title:'Camp',reason:'browser_generating'}]:[]}),close:async()=>{closed++;},onChange:value=>events.push(value),schedule:fn=>(scheduled=fn,1),unschedule:()=>{scheduled=null;}});
 return {exit,events,get closed(){return closed;},get paused(){return paused;},idle(){generating=false;},async tick(){const next=scheduled;scheduled=null;await next();await new Promise(resolve=>setImmediate(resolve));}};
}
test('explicit quit pauses future sends once and automatically closes after the actual turn ends',async()=>{
 const f=fixture();await f.exit.begin();assert.equal(f.exit.snapshot().state,'waiting-current-turn');assert.equal(f.paused,1);assert.equal(f.closed,0);
 await f.tick();assert.equal(f.closed,0);assert.equal(f.paused,1);f.idle();await f.tick();assert.equal(f.closed,1);assert.equal(f.exit.snapshot().state,'closing');
});
test('cancelling a current-turn wait stops its listener and keeps future sends paused',async()=>{
 const f=fixture();await f.exit.begin();assert.deepEqual(f.exit.cancel(),{cancelled:true,future_sends_paused:true});f.idle();assert.equal(f.exit.snapshot(),null);assert.equal(f.closed,0);
 await f.exit.begin();assert.equal(f.closed,1);assert.equal(f.paused,2);
});
test('an unavailable current browser observation is explicit attention without an infinite wait',async()=>{
 let reads=0,sends=0,schedules=0;
 const exit=createOrdinaryExit({pauseFuture:async()=>{},readActivity:async()=>{reads++;return {blocked:[{code:'exit_browser_observation_unavailable',page_id:'one',operation_id:'original'}]};},close:async()=>{sends++;},schedule:()=>{schedules++;}});
 await exit.begin();assert.equal(exit.snapshot().state,'blocked');assert.equal(exit.snapshot().blocked_reasons[0].operation_id,'original');assert.equal(schedules,0);assert.equal(sends,0);assert.equal(reads,1);
});
test('the actual native owner busy result waits in the program and releases no business work',async()=>{
 let active=true,closed=0,tick;
 const exit=createOrdinaryExit({pauseFuture:async()=>{},readActivity:async()=>({active:[]}),close:async()=>{if(active)throw Error('native_maintenance_execution_active');closed++;},schedule:fn=>(tick=fn,1)});
 await exit.begin();assert.equal(exit.snapshot().state,'waiting-current-turn');assert.equal(exit.snapshot().active_conversations[0].reason,'native_current_turn');active=false;await tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);
});
test('cancel during an observation cannot dispatch a late close',async()=>{
 let resolveRead,closed=0;
 const exit=createOrdinaryExit({pauseFuture:async()=>{},readActivity:()=>new Promise(resolve=>resolveRead=resolve),close:async()=>{closed++;}});
 const running=exit.begin();await Promise.resolve();await Promise.resolve();exit.cancel();resolveRead({active:[]});await running;assert.equal(closed,0);
});
test('lifecycle preserves one waiting intent and a cancelled intent permits a new explicit quit',()=>{
 let count=0;const life=createExitLifecycle({newId:()=>String(++count)});life.begin();life.update('waiting-current-turn',{future_sends_paused:true});assert.equal(life.begin().exit_id,'1');life.update('cancelled');assert.equal(life.begin().exit_id,'2');
});

function actualQuitFixture(){
 const main=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
 const initialization=main.slice(main.indexOf('const ordinaryExit=createOrdinaryExit('),main.indexOf('const loadedMainSha='));
 const functions=main.slice(main.indexOf('async function pauseOrdinaryQuitFuture('),main.indexOf('async function cancelExit('));
 const calls=[],page={id:'original',title:'Original',documentGeneration:1},contents={isDestroyed:()=>false};page.view={webContents:contents};
 const record={paused:true,latest_request:{id:'original-request',attempt_id:'original-attempt',phase:'queued'}};
 const snapshot={url:'https://chatgpt.com/c/original',known:true,editor:true,controlKnown:true,generating:false,rawStopPresent:false,composing:false,approvalRequired:false,draft:false};
 const context={createOrdinaryExit:options=>createOrdinaryExit({...options,schedule:fn=>(context.tick=fn,{unref(){}}),unschedule:()=>{context.tick=null;}}),runtime:{ready:true},driver:{
  busy:new Set(),approvals:{busy:new Set()},pending:new Map([['original',{attempt:'original-attempt',state:'unknown'}]]),
  records:new Map([['original',record]]),bootstrapPrepared:new Map([['original',{text:'Saved original input'}]]),
  quiesceObservation:async()=>calls.push('quiesce'),pauseAll:async()=>calls.push('pause-all'),readRecords:async()=>calls.push('list'),resumeObservation:()=>calls.push('resume-observer'),
  reconcileAll:()=>{throw Error('quit must not schedule ACK or Send observers');}},
  pool:{pages:new Map([['original',page]])},submissions:{busy:new Set()},
  workspace:{pendingStarts:{original:{state:'unknown',operation_id:'original-send-key'}},update:()=>{throw Error('no new draft');},save:()=>{throw Error('no new draft');}},
  ownedQuitPages:()=>[{page,contents,view:page.view,documentGeneration:1,owner:context.pool}],runDom:async()=>snapshot,
  prepareQuit:async payload=>{assert.equal(payload.future_paused,true);calls.push('close-owned');return {exiting:true};},
  exitLifecycle:createExitLifecycle(),publish:()=>{},setTimeout:fn=>(context.tick=fn,{unref(){}}),clearTimeout:()=>{context.tick=null;}};
 const exit=vm.runInNewContext('(function(){'+initialization+functions+';return ordinaryExit;})()',context);
 return {exit,context,calls,snapshot,record,retained:()=>JSON.stringify([record,[...context.driver.pending],context.workspace.pendingStarts,[...context.driver.bootstrapPrepared]])};
}

test('actual ordinary quit pauses observation and retains an unknown send without ACK, Send, Stop or cancel',async()=>{
 const f=actualQuitFixture(),before=f.retained();await f.exit.begin();
 assert.equal(f.exit.snapshot().state,'closing');assert.deepEqual(f.calls,['quiesce','pause-all','list','close-owned']);assert.equal(f.retained(),before);
});

test('actual ordinary quit waits for a current web turn and cancellation resumes only observation',async()=>{
 const f=actualQuitFixture(),before=f.retained();f.snapshot.generating=true;
 await f.exit.begin();assert.equal(f.exit.snapshot().state,'waiting-current-turn');assert.equal(f.exit.snapshot().active_conversations[0].reason,'browser_generating');
 assert.ok(!f.calls.includes('close-owned'));f.exit.cancel();assert.ok(f.calls.includes('resume-observer'));assert.equal(f.retained(),before);
 assert.equal(f.exit.snapshot(),null);assert.equal(f.context.tick,null);
});

test('actual ordinary quit keeps one original pause while the live Stop control disappears naturally',async()=>{
 const f=actualQuitFixture(),before=f.retained();f.snapshot.rawStopPresent=true;
 await f.exit.begin();assert.equal(f.exit.snapshot().state,'waiting-current-turn');
 f.snapshot.rawStopPresent=false;await f.context.tick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.exit.snapshot().state,'closing');assert.equal(f.calls.filter(c=>c==='pause-all').length,1);assert.equal(f.retained(),before);
});

test('an actual private pause failure restores observation and dispatches no close',async()=>{
 const f=actualQuitFixture();f.context.driver.pauseAll=async()=>{throw Error('original_pause_unknown');};
 await f.exit.begin();assert.equal(f.exit.snapshot().state,'blocked');assert.deepEqual(f.calls,['quiesce','resume-observer']);
 assert.ok(!f.calls.includes('close-owned'));assert.equal(f.context.driver.pending.get('original').state,'unknown');
});
