'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {WebDriver}=require('../web-driver.cjs');
const {selectManagedConnector,assertSelection}=require('../managed-connector.cjs');
const {connectorForAccount,connectorNames,sameConnectorLabel}=require('../connector-identity.cjs');
const URL='https://chatgpt.com/c/original',marker='[CLW:control_'+'a'.repeat(32)+']',prompt='完整中文要求\r\n  保留缩进\n'+marker;
const empty={editorCount:1,text:'',selected:[],visibleSelectedCount:0,menuCount:0,exactRows:0};
function fixture(options={}){
 const calls=[],p={id:'original',account:'A',documentGeneration:1,view:{webContents:{getURL:()=>URL,isDestroyed:()=>false}}};
 const runtime=new EventEmitter(),pool={pages:new Map([[p.id,p]])},baseline={url:URL,userId:'old',assistantId:'answer'};
 let query=false,chosen=!!options.selected,inserted='',sends=0,reads=0;
 const d=new WebDriver({runtime,pool,onNotice(){},sleep:async()=>{options.afterSleep?.(d,p);},dom:async(wc,action,arg)=>{
  calls.push([action,arg]);assert.equal(wc,p.view.webContents);
  if(action==='snapshot')return sends?{...baseline,userId:'new',draft:false,attemptMarker:marker,attemptMarkerCount:1}:{...baseline,draft:query||!!inserted};
  if(action==='connector-state'){
   options.afterRead?.(d,p,++reads);
   if(options.readError)throw Error(options.readError);
   return {...empty,text:query?'@Local-MCP':'',selected:chosen?['Local-MCP']:[],visibleSelectedCount:chosen?1:0,
    menuCount:query?1:0,exactRows:query?1:0,...options.state?.({query,chosen,reads})};
  }
  if(action==='connector-query'){query=true;return {inserted:true};}
  if(action==='connector-select'){chosen=true;query=false;return {activated:true};}
  if(action==='insert-plain-text'){inserted=arg.text;return {inserted:true};}
  if(action==='editor-text')return {text:options.incomplete?'不完整正文':inserted};
  if(action==='send'){sends++;return {};}
  return {};
 }});
 return {d,p,pool,runtime,baseline,calls,get sends(){return sends;},get inserted(){return inserted;}};
}
test('account mapping accepts only the original A/B names',()=>{
 assert.deepEqual(connectorNames(),['Local-MCP','Local-MCP-B']);assert.equal(connectorForAccount('A'),'Local-MCP');
 assert.throws(()=>connectorForAccount('Local-MCP-A'),/account_unknown/);
});

test('ASCII case folding accepts the same public label without accepting aliases or Unicode folds',()=>{
 for(const actual of ['Local-MCP','local-mcp','LOCAL-MCP','lOcAl-McP'])assert.equal(sameConnectorLabel(actual,'Local-MCP'),true);
 assert.equal(sameConnectorLabel('local-mcp-b',connectorForAccount('B')),true);
 for(const actual of ['local-mcp-a','local-mcp-b','MCP-B',' local-mcp','local-mcp ','Local–MCP','ſocal-MCP',null,undefined,17,''])
  assert.equal(sameConnectorLabel(actual,connectorForAccount('A')),false,String(actual));
 assert.equal(sameConnectorLabel('local-mcp',connectorForAccount('B')),false);
});

test('actual lowercased selected state is retained and skips app selection without losing composer checks',async()=>{
 const state={...empty,selected:['local-mcp'],visibleSelectedCount:1};
 assert.equal(assertSelection(state,'Local-MCP'),true);assert.deepEqual(state.selected,['local-mcp']);
 const f=fixture({state:()=>({selected:['local-mcp'],visibleSelectedCount:1})});
 await f.d.send(f.p,prompt,f.baseline,marker);assert.equal(f.sends,1);
 assert.equal(f.calls.some(([op])=>op==='connector-query'||op==='connector-select'),false);
 for(const change of [{selected:['local-mcp','Local-MCP'],visibleSelectedCount:2},{visibleSelectedCount:0},{editorCount:2},
  {generating:true},{approvalRequired:true},{composing:true},{accessLimited:true},{blocked:true}])
  assert.throws(()=>assertSelection({...state,...change},'Local-MCP'));
});
test('selects once, verifies complete LF body and supplies connector plus original baseline to sole Send',async()=>{
 const f=fixture();await f.d.send(f.p,prompt,f.baseline,marker);
 assert.equal(f.sends,1);assert.equal(f.inserted,prompt.replace(/\r\n/g,'\n'));
 assert.deepEqual(f.calls.filter(([op])=>op==='connector-query'||op==='connector-select').map(([op])=>op),['connector-query','connector-select']);
 const send=f.calls.find(([op])=>op==='send')[1];assert.equal(send.expectedText,prompt);assert.equal(send.expectedConnector,'Local-MCP');assert.deepEqual(send.expectedBaseline,f.baseline);
});
test('bootstrap beforeSend admission hook follows complete original app/body verification and cannot run on a partial draft',async()=>{
 for(const incomplete of [false,true]){
  const f=fixture({incomplete});let admissions=0;
  const sent=f.d.send(f.p,prompt,f.baseline,marker,undefined,async()=>{
    admissions++;assert.equal(f.sends,0);assert.equal(f.inserted,prompt.replace(/\r\n/g,'\n'));
    assert.equal(f.calls.filter(([op])=>op==='connector-select').length,1);
  });
  if(incomplete){await assert.rejects(sent,e=>e.code==='editor_prompt_mismatch'&&e.notSent===true);assert.equal(admissions,0);assert.equal(f.sends,0);}
  else{await sent;assert.equal(admissions,1);assert.equal(f.sends,1);}
 }
});
for(const selected of [['CLW T003 Stable No-OIDC'],['Local-MCP-A'],['Local-MCP-B'],['Local-MCP','Local-MCP'],['Local-MCP','Other']]){
 test('retains wrong or duplicate selection with zero Send: '+selected.join(', '),async()=>{
  const f=fixture({state:()=>({selected,visibleSelectedCount:selected.length})});
  await assert.rejects(f.d.send(f.p,prompt,f.baseline,marker),e=>e.code==='connector_selection_mismatch'&&e.notSent===true);
  assert.equal(f.sends,0);assert.equal(f.calls.some(([op])=>op==='connector-query'||op==='insert-plain-text'),false);
 });
}
test('pre-existing user draft is not replaced or cleared and proves known absence',async()=>{
 const f=fixture({state:()=>({text:'用户原始草稿'})});
 await assert.rejects(f.d.send(f.p,prompt,f.baseline,marker),e=>e.code==='editor_missing_or_user_draft'&&e.notSent===true);
 assert.equal(f.sends,0);assert.equal(f.inserted,'');assert.equal(f.calls.some(([op])=>op.includes('clear')),false);
});
test('duplicate exact menu rows never activate an app or Send',async()=>{
 const f=fixture({state:({query})=>query?{exactRows:2}: {}});
 await assert.rejects(f.d.send(f.p,prompt,f.baseline,marker),e=>e.code==='connector_menu_not_unique'&&e.notSent===true);
 assert.equal(f.sends,0);assert.equal(f.calls.some(([op])=>op==='connector-select'),false);
});
for(const [name,change] of [
 ['workspace stop',d=>d.stop()],['runtime close',(d)=>{d.runtime.closed=true;}],
 ['document generation',(_d,p)=>{p.documentGeneration++;}],['renderer',(_d,p)=>{p.view={webContents:{getURL:()=>URL}};}],
 ['account',(_d,p)=>{p.account='B';}],['original pool page',(d,p)=>d.pool.pages.delete(p.id)],
 ['connection generation',d=>{d.connectionGeneration++;}],
])test('asynchronous '+name+' fences app activation and Send without absent-receipt fabrication',async()=>{
 const f=fixture({afterRead:(d,p,n)=>{if(n===2)change(d,p);}});
 await assert.rejects(f.d.send(f.p,prompt,f.baseline,marker),e=>['workspace_stopping','send_page_identity_changed'].includes(e.code)&&e.notSent!==true);
 assert.equal(f.sends,0);assert.equal(f.calls.some(([op])=>op==='connector-select'||op==='insert-plain-text'),false);
});
test('an unknown DOM reply retains original unknown and never clears or retries',async()=>{
 const f=fixture({readError:'page_dom_timeout'});
 await assert.rejects(f.d.send(f.p,prompt,f.baseline,marker),e=>e.message==='page_dom_timeout'&&e.notSent===undefined);
 assert.equal(f.sends,0);assert.equal(f.calls.filter(([op])=>op==='connector-state').length,1);
});
test('bounded delayed menu selects the original row once; busy context stops before activation',async()=>{
 for(const busy of [false,true]){
  let polls=0,query=false,activated=0,sleeps=0;
  const result=selectManagedConnector({wc:{},name:'Local-MCP',assertCurrent(){},sleep:async()=>{sleeps++;},menuPolls:5,
   dom:async(_wc,op)=>{
    if(op==='connector-query'){query=true;return {inserted:true};}
    if(op==='connector-select'){activated++;query=false;return {activated:true};}
    return {...empty,text:query?'@Local-MCP':'',selected:activated?['Local-MCP']:[],visibleSelectedCount:activated?1:0,
      exactRows:query&&++polls>=3?1:0,menuCount:query?1:0,generating:busy&&polls>=2};
   }});
  if(busy){await assert.rejects(result,e=>e.code==='send_baseline_changed');assert.equal(activated,0);}
  else{await result;assert.equal(activated,1);assert.equal(sleeps,2);}
 }
});
