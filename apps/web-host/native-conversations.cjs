'use strict';
const {createHash}=require('node:crypto');
const {chatUrl}=require('../codex-web-bridge/turn-journal.cjs');
const {runDom}=require('./page-dom.cjs');
const {knownIdleSnapshot}=require('./web-driver.cjs');
const {nativeMaintenanceTurns}=require('./native-turn-reads.cjs');

// Presentation only. Execution remains with the original BrowserHost/turn.
function createNativeConversations({getBridge,pool,dom=runDom}){
  let selected=null,visible=false,bounds=null;
  const accountOf=row=>['A','B'].includes(row.account)?row.account:
    ['A','B'].includes(row.source?.account)?row.source.account:row.source?.threadId?'B':null;
  function liveTab(){
    if(selected?.kind!=='live')return null;
    const bridge=getBridge();
    if(bridge?.snapshot().account!==selected.account)return null;
    const tab=bridge?.host?.turnTabs?.get(selected.tabId);
    if(!tab||tab.view.webContents.isDestroyed())return null;
    return tab.traceId===selected.traceId||(selected.url&&chatUrl(tab.view.webContents.getURL())===selected.url)?tab:null;
  }
  function snapshot(){
    if(!selected)return null;
    const tab=liveTab();
    return {...selected,visible,available:selected.kind!=='live'||!!tab,
      running:!!tab&&tab.status==='running',modelSends:0};
  }
  function layout(next={}){
    if('visible' in next)visible=next.visible===true;
    if(next.bounds)bounds=next.bounds;
    const bridge=getBridge(),tab=liveTab();
    pool.native=visible&&selected?.kind==='history';
    if(bounds)pool.viewport=bounds;
    pool.layout();
    if(!bridge?.host)return;
    if(visible&&tab&&bounds){
      bridge.host.setBounds(bounds);
      if(bridge.host.selectedTabId!==tab.id)bridge.host.selectTab(tab.id);
      if(!bridge.host.visible)bridge.host.show();
    }else if(bridge.host.visible)bridge.host.hide();
  }
  async function open(traceId){
    const bridge=getBridge();
    const row=bridge?.turn(traceId);
    if(!row)throw Error('原网页记录不存在，无法按时间猜测对应对话。');
    const account=accountOf(row),url=chatUrl(row.url);
    if(!account)throw Error('旧记录缺少网页账号，请先核对原账号归属。');
    const tab=bridge.snapshot().account===account?[...(bridge.host?.turnTabs?.values()||[])].find(t=>
      !t.view.webContents.isDestroyed()&&(t.traceId===traceId||(url&&chatUrl(t.view.webContents.getURL())===url))):null;
    let target;
    if(tab){target={traceId,account,url:chatUrl(tab.view.webContents.getURL())||url,kind:'live',tabId:tab.id};}
    else{
      if(!url)throw Error('本回合尚未保存对话链接，原页面也已关闭；没有新建或重发任务。');
      const id='native-preview-'+account+'-'+createHash('sha256').update(url).digest('hex').slice(0,16);
      const previous=pool.pages?.get(id);
      await pool.create(id,url,{account,kind:'native-preview',title:'Codex 原对话'});
      if(previous?.view&&previous.status!=='loading'&&chatUrl(previous.view.webContents.getURL())!==url){
        const original={traceId,account,url},view=previous.view,baseline=canonicalIdle(original,bridge);
        const snapshot=await dom(view.webContents,'snapshot');
        if(!knownIdleSnapshot(snapshot))throw Error('原预览网页仍在工作或状态待核对，没有重新加载或停止执行。');
        const assertCurrent=()=>{if(pool.pages.get(id)!==previous||previous.view!==view||canonicalIdle(original,bridge)!==baseline)throw Error('原预览任务状态已变化，没有重新加载。');};
        assertCurrent();await pool.reload(id,url,{assertCurrent});
      }
      pool.select(id);
      target={traceId,account,url,kind:'history',pageId:id};
    }
    selected=target;layout();return snapshot();
  }
  function canonicalIdle(original,bridge){
      if(getBridge()!==bridge||!bridge||typeof bridge.turns!=='function')throw Error('原回合状态尚未核对，未刷新网页。');
      let rows;try{rows=bridge.turns();}catch{throw Error('原回合状态尚未核对，未刷新网页。');}
      if(!Array.isArray(rows))throw Error('原回合状态尚未核对，未刷新网页。');
      const row=rows.find(r=>r.traceId===original.traceId);
      if(!row||accountOf(row)!==original.account||chatUrl(row.url)!==original.url)throw Error('原对话身份已变化，未刷新网页。');
      const group=rows.filter(r=>r.traceId===original.traceId||row.source?.threadId&&r.source?.threadId===row.source.threadId||original.url&&chatUrl(r.url)===original.url&&accountOf(r)===original.account);
      try{nativeMaintenanceTurns({turns:()=>group});}catch{throw Error('原回合正在执行或回执待核对，未刷新网页，也未停止执行。');}
      return JSON.stringify(group.map(r=>[r.traceId,r.status,r.browserStatus,r.source,r.nativeState]));
  }
  async function refresh(){
    if(!selected)throw Error('请先打开对应网页。');
    const original=selected,bridge=getBridge();
    const canonical=()=>{if(selected!==original)throw Error('原对话选择已变化，未刷新网页。');return canonicalIdle(original,bridge);};
    if(original.kind==='live'){
      const tab=liveTab();
      if(!tab)throw Error('原页面已关闭，请重新打开已保存对话。');
      if(tab.status==='running')throw Error('本轮正在执行；刷新可能中断工作，请等本轮结束。');
      const baseline=canonical(),view=tab.view;
      const snapshot=await dom(view.webContents,'snapshot');
      if(!knownIdleSnapshot(snapshot)||snapshot.url!==original.url)throw Error('原网页仍在工作或状态待核对，未刷新。');
      if(liveTab()!==tab||tab.view!==view||tab.status==='running'||canonical()!==baseline)throw Error('原任务状态已变化，未刷新网页。');
      tab.view.webContents.reload();
    }else{
      const baseline=canonical(),page=pool.pages?.get(original.pageId),view=page?.view;
      if(!view||view.webContents.isDestroyed?.())throw Error('原预览页面尚未加载，未刷新。');
      const snapshot=await dom(view.webContents,'snapshot');
      if(!knownIdleSnapshot(snapshot))throw Error('原网页仍在工作或状态待核对，未刷新。');
      const assertCurrent=()=>{if(pool.pages.get(original.pageId)!==page||page.view!==view||canonical()!==baseline)throw Error('原任务状态已变化，未刷新网页。');};
      assertCurrent();await pool.reload(original.pageId,original.url,{assertCurrent});
    }
    return {message:'已刷新对应网页，没有发送模型消息。',modelSends:0};
  }
  return {open,layout,snapshot,refresh};
}
module.exports={createNativeConversations};
