'use strict';
(function(scope){
  const record=typeof module!=='undefined'?require('./work-record.js'):scope.CLWWorkRecord;
  const outcome=new Set(['mcp_call_finished','native_result','native_error','mcp_transport_interrupted','mcp_client_disconnected','native_duplicate_rejected','union_error']);
  function calls(activity){
    if(activity?.source!=='mcp_union_metadata'||!Array.isArray(activity.events))return [];
    const byId=new Map();
    for(const event of activity.events){
      if(typeof event.callId!=='string'||typeof event.tool!=='string')continue;
      const row=byId.get(event.callId)||{callId:event.callId,tool:event.tool,route:event.route,at:event.at,phase:'mcp_call_started',delivered:false};
      if(event.at>row.at)row.at=event.at;
      if(outcome.has(event.event)){row.phase=event.event;row.result=event;}
      if(event.event==='mcp_response_sent')row.delivered=true;
      if(event.details)row.details=event.details;
      byId.set(event.callId,row);
    }
    return [...byId.values()].sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,160);
  }
  function label(row){
    if(row.phase==='native_error'||row.phase==='union_error')return '调用失败 · 原执行待核对';
    if(row.phase==='native_duplicate_rejected')return '重复工具请求已拒绝 · 原调用保留';
    if(row.phase==='mcp_transport_interrupted'||row.phase==='mcp_client_disconnected')return '本次工具通信中断 · 执行结果待核对';
    if(row.phase==='native_result'||row.phase==='mcp_call_finished'){
      if(row.result?.rpcError||row.result?.isError||row.result?.applicationSuccess===false)return '工具回包报告失败';
      if(Number.isInteger(row.result?.itemFailureCount)&&row.result.itemFailureCount>0)return '部分条目失败 · 查看原回包';
      if(row.result?.applicationSuccess===true)return '工具回包报告成功';
      return '工具已返回 · 业务结果待核验';
    }
    return row.delivered?'回包已交付 · 执行结果待核对':'工具调用中';
  }
  const detailViews=new WeakMap();
  function render(container,activity,{readDetails=null,isCurrent=()=>true,key=''}={}){
    const rows=calls(activity);
    let views=detailViews.get(container);if(!views||views.key!==key){views={key,calls:new Map()};detailViews.set(container,views);}
    for(const callId of views.calls.keys())if(!rows.some(row=>row.callId===callId))views.calls.delete(callId);
    while(views.calls.size>16)views.calls.delete(views.calls.keys().next().value);
    const renderDetails=readDetails?(item,row)=>{
      const view=views.calls.get(row.callId)||{part:null,pages:{}};
      const controls=document.createElement('div');controls.className='mcp-details-actions';
      const content=document.createElement('div');content.className='mcp-details-content';
      const status=document.createElement('small');status.setAttribute('role','status');
      const raw=document.createElement('pre');raw.className='mcp-details-data';
      const next=document.createElement('button');next.type='button';next.className='quiet';next.textContent='下一段';
      const current=()=>isCurrent()&&detailViews.get(container)===views&&item.isConnected!==false;
      const readCurrent=()=>isCurrent()&&detailViews.get(container)===views&&views.calls.get(row.callId)===view;
      const paint=()=>{const page=view.pages[view.part];content.hidden=!view.part;raw.textContent=page?.data||'';
        status.textContent=page?.loading?'正在读取原记录…':page?.error||page?.unavailable||(page?(page.complete===false?'原响应未完整 · ':'')+'字节 '+(page.offset||0)+'–'+page.next_offset+' / '+page.total_bytes:'');
        next.hidden=!page||page.eof!==false||!Number.isInteger(page.next_offset);next.disabled=!!page?.loading;};
      const load=async(part,offset=0)=>{
        views.calls.delete(row.callId);views.calls.set(row.callId,view);
        while(views.calls.size>16)views.calls.delete(views.calls.keys().next().value);
        view.part=part;const old=view.pages[part];view.pages[part]={...old,loading:true,error:null};paint();
        try{const value=await readDetails({callId:row.callId,part,offset,max_bytes:65536,format:'text'});
          if(!readCurrent())return;
          view.pages[part]=value?.available===true?{...value,loading:false}:{loading:false,unavailable:value?.reason==='original_call_details_expired'?'这份原记录已清理。':'本次调用未保存可读取的原字节。'};
        }catch{if(readCurrent())view.pages[part]={...old,loading:false,error:'读取未完成，可重试原记录。'};}
        if(readCurrent())view.repaint?.();
      };
      for(const [part,label]of [['arguments','参数'],['response','回包']]){
        const button=document.createElement('button');button.type='button';button.className='quiet';button.textContent=label;
        button.disabled=row.details?.[part]?.available!==true;
        button.title=button.disabled?(row.details?.[part]?.reason==='original_call_details_expired'?'原记录已清理':'这次调用没有保存原字节'):'读取原记录，不重复执行工具';
        button.onclick=()=>{if(!current())return;if(view.part===part){view.part=null;paint();}else if(view.pages[part]&&!view.pages[part].error){view.part=part;paint();}else void load(part);};controls.append(button);
      }
      next.onclick=()=>{const page=view.pages[view.part];if(current()&&page&&!page.loading&&Number.isInteger(page.next_offset))void load(view.part,page.next_offset);};
      view.repaint=paint;content.append(status,raw,next);item.append(controls,content);paint();
    }:null;
    record.tools(container,rows.map(row=>{
      const seconds=Number.isFinite(row.result?.durationMs)?` · ${(row.result.durationMs/1000).toFixed(1)} 秒`:'';
      return {callId:row.callId,details:row.details,tool:row.tool,status:label(row),phase:row.phase,detail:(row.route==='native'?'Codex 原生工具':'Local-MCP')+' · '+(row.at?new Date(row.at).toLocaleTimeString():'时间未知')+seconds};
    }),{empty:activity?.scope==='not_available'?'尚未绑定本对话的工具身份。接入期间请查看原网页；这里不会混入其他对话的调用。':undefined,
      note:activity?.windowTruncated?'日志只保留有限窗口，较早活动可能未显示。':'',renderDetails});
  }
  const api={calls,label,render};if(typeof module!=='undefined')module.exports=api;else scope.CLWMcpActivity=api;
})(globalThis);
