'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {selectManagedConnector}=require('../managed-connector.cjs');
const baseline={url:'https://chatgpt.com/',userId:'',assistantId:''};
const empty={editorCount:1,text:'',selected:[],visibleSelectedCount:0,menuCount:0,exactRows:0,titles:[],
  generating:false,composing:false,approvalRequired:false,accessLimited:false,blocked:false};
function fixture({successAt=1,menuPolls=2,presupdraft='',menu}={}){
  const calls=[],hooks={};let text=presupdraft,queries=0,clears=0,selects=0,chosen=false,valid=true,reads=0,waits=0,lateMenu=false;
  const current=()=>({...empty,text,selected:chosen?['Local-MCP']:[],visibleSelectedCount:chosen?1:0,
    ...(text&&((queries>=successAt&&successAt!==0)||lateMenu)?{menuCount:1,exactRows:1,titles:['Local-MCP']}:{}),
    ...menu?.({queries,reads,text,chosen})});
  const run=options=>selectManagedConnector({wc:{},name:'Local-MCP',menuPolls,selectionPolls:2,
    expectedBaseline:baseline,assertCurrent(){if(!valid)throw Error('original_identity_changed');},sleep:async ms=>{waits+=ms;await hooks.sleep?.();},
    dom:async(_wc,action,arg)=>{
      calls.push([action,arg]);assert.deepEqual(arg.expectedBaseline,baseline);await hooks[action]?.();
      if(action==='connector-state'){reads++;return current();}
      if(action==='connector-query'){
        assert.equal(text,'');if(queries){assert.equal(arg.coldRetry,true);assert.equal(arg.expectedText,'');assert.match(arg.reconciliationId,/^[a-f0-9-]{36}$/);}
        else assert.equal(arg.coldRetry,undefined);
        queries++;text='@Local-MCP';return hooks.queryReply?.(queries)??{inserted:true};
      }
      if(action==='connector-clear-query'){
        clears++;assert.equal(arg.coldRetry,true);assert.equal(arg.expectedText,'@Local-MCP');
        assert.match(arg.reconciliationId,/^[a-f0-9-]{36}$/);
        if(hooks.clearReply)return hooks.clearReply();text='';return {cleared:true};
      }
      assert.equal(action,'connector-select');selects++;assert.equal(current().menuCount,1);assert.equal(current().exactRows,1);
      if(hooks.selectReply)return hooks.selectReply();chosen=true;text='';return {activated:true};
    },...options});
  return {calls,hooks,run,set text(value){text=value;},get text(){return text;},get queries(){return queries;},get clears(){return clears;},
    get selects(){return selects;},get waits(){return waits;},invalidate(){valid=false;},late(){lateMenu=true;}};
}

for(const successAt of [2,3])test('a cold menu succeeds on confirmed trigger '+successAt+' and selects once',async()=>{
  const f=fixture({successAt}),state=await f.run();assert.deepEqual(state.selected,['Local-MCP']);
  assert.equal(f.queries,successAt);assert.equal(f.clears,successAt-1);assert.equal(f.selects,1);
  const ids=f.calls.filter(([action])=>action==='connector-clear-query').map(([,arg])=>arg.reconciliationId);
  assert.equal(new Set(ids).size,1);assert.equal(f.text,'');
});

test('default waits have at most 200 polls per trigger and three confirmed triggers',async()=>{
  const f=fixture({successAt:0});await assert.rejects(f.run({menuPolls:200}),error=>
    error.code==='connector_not_available'&&error.connectorFailure==='menu_not_opened'&&error.triggerAttempts===3);
  assert.equal(f.queries,3);assert.equal(f.clears,2);assert.equal(f.selects,0);assert.equal(f.waits,3*199*100);assert.equal(f.text,'@Local-MCP');
});
test('a menu that showed the wrong app and disappeared cannot be classified as cold loading',async()=>{
  let observed=false;const f=fixture({successAt:0,menu:({queries})=>{
    if(queries&&!observed){observed=true;return {menuCount:1,exactRows:0,titles:['Other App']};}
  }});
  await assert.rejects(f.run(),error=>error.code==='connector_not_available'&&error.connectorFailure==='connector_name_not_available');
  assert.equal(f.queries,1);assert.equal(f.clears,0);assert.equal(f.selects,0);assert.equal(f.text,'@Local-MCP');
});
test('a unique menu arriving in atomic clear returns menuReady and is selected without deletion or another trigger',async()=>{
  const f=fixture({successAt:0});f.hooks.clearReply=()=>{f.late();return {menuReady:true};};
  await f.run();assert.equal(f.queries,1);assert.equal(f.clears,1);assert.equal(f.selects,1);
});
test('a correct late menu in the final pre-clear read is selected without any clear call',async()=>{
  let polls=0;const f=fixture({successAt:0,menu:({queries})=>queries&&++polls===3?{menuCount:1,exactRows:1,titles:['Local-MCP']}:undefined});
  // Retain that late menu for the one connector-select transaction.
  f.hooks['connector-select']=()=>{f.late();};await f.run();assert.equal(f.queries,1);assert.equal(f.clears,0);assert.equal(f.selects,1);
});
for(const phase of ['query','clear','select'])test('an unknown '+phase+' reply never causes another mutation',async()=>{
  const f=fixture({successAt:phase==='select'?1:0});
  if(phase==='query')f.hooks.queryReply=()=>({});
  if(phase==='clear')f.hooks.clearReply=()=>({});
  if(phase==='select')f.hooks.selectReply=()=>({});
  await assert.rejects(f.run(),error=>error.code===(phase==='query'?'connector_query_unconfirmed':phase==='clear'?'connector_retry_clear_unconfirmed':'connector_selection_unconfirmed'));
  assert.equal(f.queries,1);assert.equal(f.clears,phase==='clear'?1:0);assert.equal(f.selects,phase==='select'?1:0);
});
test('a lost clear reply keeps its exact original error and never inserts another query',async()=>{
  const f=fixture({successAt:0});f.hooks['connector-clear-query']=()=>{throw Error('renderer_reply_unknown');};
  await assert.rejects(f.run(),/renderer_reply_unknown/);assert.equal(f.queries,1);assert.equal(f.selects,0);
});
test('a newly unconfirmed second trigger is preserved without entering a third trigger',async()=>{
  const f=fixture({successAt:0});f.hooks.queryReply=n=>n===2?{}:{inserted:true};
  await assert.rejects(f.run(),error=>error.code==='connector_query_unconfirmed');assert.equal(f.queries,2);assert.equal(f.clears,1);
});
test('clear acknowledgement must be followed by a genuinely empty composer before retriggering',async()=>{
  const f=fixture({successAt:0});f.hooks.clearReply=()=>{f.text='用户的新草稿';return {cleared:true};};
  await assert.rejects(f.run(),error=>error.code==='connector_retry_cleanup_changed');assert.equal(f.queries,1);assert.equal(f.clears,1);assert.equal(f.text,'用户的新草稿');
});
for(const text of ['@Local-MCP','我的原始草稿'])test('pre-existing '+text+' is never adopted as this call\'s query',async()=>{
  const f=fixture({presupdraft:text});await assert.rejects(f.run(),error=>error.code==='editor_missing_or_user_draft');
  assert.equal(f.queries,0);assert.equal(f.clears,0);assert.equal(f.selects,0);assert.equal(f.text,text);
});
test('an identity change during waiting prevents any cold clear or app selection',async()=>{
  const f=fixture({successAt:0});f.hooks.sleep=()=>f.invalidate();
  await assert.rejects(f.run(),/original_identity_changed/);assert.equal(f.queries,1);assert.equal(f.clears,0);assert.equal(f.selects,0);
});
test('an identity change after clear acknowledgement prevents a new query',async()=>{
  const f=fixture({successAt:0});f.hooks.clearReply=()=>{f.text='';f.invalidate();return {cleared:true};};
  await assert.rejects(f.run(),/original_identity_changed/);assert.equal(f.queries,1);assert.equal(f.clears,1);assert.equal(f.selects,0);
});
test('a subsequent call cannot retry the exact query left by a exhausted call',async()=>{
  const f=fixture({successAt:0});await assert.rejects(f.run(),error=>error.code==='connector_not_available');
  const counts=[f.queries,f.clears,f.selects];await assert.rejects(f.run(),error=>error.code==='editor_missing_or_user_draft');
  assert.deepEqual([f.queries,f.clears,f.selects],counts);
});
test('duplicate owned menus fail immediately without selecting or cold clearing',async()=>{
  const f=fixture({menu:({queries})=>queries?{menuCount:2,exactRows:2,titles:['Local-MCP','Local-MCP']}:undefined});
  await assert.rejects(f.run(),error=>error.code==='connector_menu_not_unique');assert.equal(f.queries,1);assert.equal(f.clears,0);assert.equal(f.selects,0);
});
test('the original baseline is copied before awaits and cannot be silently rebased by the caller',async()=>{
  const expected={...baseline},f=fixture({successAt:0});f.hooks.sleep=()=>{expected.userId='foreign';f.invalidate();};
  await assert.rejects(f.run({expectedBaseline:expected}),/original_identity_changed/);
  assert.equal(f.calls.every(([,arg])=>arg.expectedBaseline.userId===''),true);assert.equal(f.clears,0);
});
