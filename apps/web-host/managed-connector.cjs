'use strict';
const {sameConnectorLabel}=require('./connector-identity.cjs');
const {randomUUID}=require('node:crypto');

const error=(code,message,state)=>Object.assign(Error(message),{code,connectorState:state});
function assertSelection(state,name,{allowEmpty=false}={}){
  if(!state||!Array.isArray(state.selected)||state.editorCount!==1)throw error('connector_composer_unavailable','无法核对唯一原网页输入框；未发送。',state);
  if(state.generating||state.approvalRequired||state.accessLimited||state.blocked)throw error('send_baseline_changed','原网页已有生成或工具确认；未改动该过程，未发送。',state);
  if(state.composing)throw error('editor_missing_or_user_draft','网页正在输入；原草稿保留，未发送。',state);
  if(state.selected.length===0&&allowEmpty)return false;
  if(state.selected.length!==1||!sameConnectorLabel(state.selected[0],name)||state.visibleSelectedCount!==1)
    throw error('connector_selection_mismatch',`输入框必须只选择 ${name}；现有连接器未改动，未发送。`,state);
  return true;
}
// A cold mention may be retriggered only within this call's confirmed input.
// Public menus, user edits and unknown mutations never become retry authority.
async function selectManagedConnector({dom,wc,name,assertCurrent,sleep,expectedBaseline,menuPolls=200,selectionPolls=50}){
  if(!Number.isSafeInteger(menuPolls)||menuPolls<1||menuPolls>200||!Number.isSafeInteger(selectionPolls)||selectionPolls<1||selectionPolls>50)
    throw error('connector_poll_budget_invalid','连接器等待额度无效；未改动输入框。');
  const baseline=expectedBaseline?{url:expectedBaseline.url,userId:expectedBaseline.userId,assistantId:expectedBaseline.assistantId}:undefined;
  const baselineKnown=baseline&&typeof baseline.url==='string'&&typeof baseline.userId==='string'&&typeof baseline.assistantId==='string';
  const call=async(action,arg={})=>{assertCurrent();const result=await dom(wc,action,{...arg,expectedConnector:name,expectedBaseline:baseline});assertCurrent();return result;};
  let state=await call('connector-state');
  const selected=assertSelection(state,name,{allowEmpty:true});
  if(state.text!=='')throw error('editor_missing_or_user_draft','网页已有草稿；原草稿保留，未发送。',state);
  if(selected)return state;
  const query='@'+name,reconciliationId=randomUUID();
  const menuKnown=current=>Number.isSafeInteger(current.menuCount)&&current.menuCount>=0&&Number.isSafeInteger(current.exactRows)&&current.exactRows>=0;
  const observedMenu=current=>current.menuCount>0||current.exactRows>0||Array.isArray(current.titles)&&current.titles.length>0;
  let sawMenu=observedMenu(state),triggers=0;
  const unavailable=()=>Object.assign(error('connector_not_available',sawMenu?
    `网页连接器菜单未提供唯一 ${name} 名称；保留原查询，未发送。`:
    `网页连接器菜单在 ${triggers} 次已确认查询后仍未打开；保留原查询，未发送。`,state),
    {connectorFailure:sawMenu?'connector_name_not_available':'menu_not_opened',triggerAttempts:triggers});
  const checkQuery=()=>{
    assertSelection(state,name,{allowEmpty:true});
    if(state.selected.length||state.text!==query)throw error('connector_query_changed','连接器查询或输入框已变化；原内容保留，未发送。',state);
    if(!menuKnown(state))throw error('connector_menu_observation_unknown','连接器菜单读回不完整；未重触发查询，未发送。',state);
    sawMenu=sawMenu||observedMenu(state);
    if(state.menuCount>1||state.exactRows>1)throw error('connector_menu_not_unique','网页连接器菜单或同名条目不唯一；未发送。',state);
  };
  for(;;){
    const inserted=await call('connector-query',triggers?{coldRetry:true,reconciliationId,expectedText:''}:{});
    if(inserted?.inserted!==true)throw error('connector_query_unconfirmed','原连接器查询输入未确认；保留原结果，未重试。',inserted);
    triggers++;
    let ready=false;
    for(let n=0;n<menuPolls;n++){
      state=await call('connector-state');checkQuery();
      if(state.exactRows===1&&state.menuCount===1){ready=true;break;}
      if(n<menuPolls-1){await sleep(100);assertCurrent();}
    }
    if(ready)break;
    if(triggers>=3||sawMenu||!baselineKnown)throw unavailable();
    // Re-read our own exact query before entering the synchronous clear. A
    // correctly named late menu is handled atomically there without deletion.
    state=await call('connector-state');checkQuery();
    if(state.exactRows===1&&state.menuCount===1)break;
    if(sawMenu)throw unavailable();
    const cleared=await call('connector-clear-query',{expectedText:query,reconciliationId,coldRetry:true});
    if(cleared?.menuReady===true&&cleared.cleared!==true){sawMenu=true;break;}
    if(cleared?.cleared!==true||cleared.menuReady===true)
      throw error('connector_retry_clear_unconfirmed','原冷加载查询清除未确认；保留原结果，未重试。',cleared);
    state=await call('connector-state');assertSelection(state,name,{allowEmpty:true});
    if(state.selected.length||state.text!==''||!menuKnown(state)||observedMenu(state))
      throw error('connector_retry_cleanup_changed','冷加载查询清除后的输入框或菜单已变化；未重触发，未发送。',state);
  }
  const activated=await call('connector-select');
  if(!activated?.activated)throw error('connector_selection_unconfirmed','原连接器选择未确认；未重试点击，未发送。',activated);
  for(let n=0;n<selectionPolls;n++){
    state=await call('connector-state');
    if(assertSelection(state,name,{allowEmpty:true})){
      if(state.text!=='')throw error('editor_missing_or_user_draft','连接器选择后出现其他草稿；原内容保留，未发送。',state);
      return state;
    }
    if(state.text!==query&&state.text!=='')throw error('connector_query_changed','连接器选择后输入框已变化；未发送。',state);
    if(n===selectionPolls-1)throw error('connector_selection_unconfirmed',`原输入框尚未核实 ${name} 标签；未重试点击，未发送。`,state);
    await sleep(100);assertCurrent();
  }
}
module.exports={selectManagedConnector,assertSelection};
