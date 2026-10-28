'use strict';
// Isolated visual preview. It never imports the Electron main process, reads
// runtime state, opens a real CLI, or sends a model/tool command.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const host=path.resolve(__dirname,'..'),output=path.resolve(host,'../../.local/product-workspace-redesign-20261004');
const assets=new Set(['shell.css','failure-state.js','quota-view.js','workflow-state.js','task-presentation.js','state-patch.js',
  'work-record.js','record-history.js','codex-turns.js','mcp-activity.js','interaction-feedback.js','runtime-availability.js','shell.js']);
function fixture(){
  localStorage.clear();
  const now=new Date().toISOString(),at=Date.now();
  const make=(id,title,root,extra={})=>({id,title,root,kind:'task',account:'A',bound:true,access:'write',write_paths:['.'],model:'GPT-6 · 最新',effort:'Pro',
    selected:id==='camp',paused:false,latest_request:{id:'preview-request-'+id,phase:'processing'},
    observation:{at,generating:true,editorReady:true,historyAtLatest:true,model:{model:'GPT-6 · 最新',effort:'Pro'},effortLabel:'Pro'},...extra});
  const pages=[make('camp','Camp Dungeon · 示例','D:/Games/Camp'),make('camp-world','世界与场景 · 示例','D:/Games/Camp',{parent:'camp'}),
    make('spire','Spirefall · 示例','D:/Games/Spirefall'),make('math','数学研究 · 示例','D:/Research/Math',{account:'B',paused:true,observation:{at,generating:false},latest_request:null})];
  const text={camp:['把角色、动画、营地升级和双人协作放在一个完整工作包里推进。保持当前 Unity 工程，完成场景接线后运行双 Player 验证。',
    '示例进展：正在整合营地系统与双人协作。场景、模型、角色和交互统一检查。\n\n已保存的回执与待验证项会一起交回主控。'],
    spire:['推进实际浏览器中的游戏体验，统一接线角色动作、升降平台与机关；完成后检查双玩家状态与保存接续。',
      '示例进展：正在整理角色与机关的交互，协作者继续推进独立模块。此处展示的是隔离界面样本。']};
  const views=new Map(pages.map(p=>[p.id,{page_id:p.id,thread_id:'preview-thread-'+p.id,request:p.latest_request,run:{state:'running',dispatches:4,max_dispatches:40},
    events:(text[p.id]||['示例工作要求','示例进展：原任务与回执保留。']).map((value,index)=>({seq:index+1,kind:index?'assistant_message':'user_message',delivery:index?undefined:'delivered',at:now,data:{text:value}})),
    session_activity:{source:'mcp_union_metadata',events:[{callId:'preview-read-'+p.id,tool:'read_files',event:'mcp_call_finished',at:now}]},record_history:{total:2,has_before:false,has_after:false}}]));
  const state={root:'D:/Games',pages,selected:'camp',view:views.get('camp'),closed:[],connected:true,taskStateReady:true,theme:'dark',network:'隔离预览 · 不连接运行实例',
    recordHistory:{web:true,codex:true},localCodex:{available:true,state:'installed',protocol:'installed-codex-cli',capabilities:['launch','resume']},
    codexWeb:{state:'ready',account:'A',tools:{ready:true},recent:[{traceId:'preview-native-turn',status:'completed',submission:'confirmed',account:'A',startedAt:now,
      source:{traceId:'preview-native-turn',threadId:'preview-native',workingDirectory:'D:/Games/Camp',model:'chatgpt-web/pro'},
      review:{finalText:'隔离预览：这张卡片展示已保存的 Codex＋Web 回合。实际目标和补充从原终端发送。'},url:'https://chatgpt.com/c/preview'}]}};
  let listener;const emit=()=>listener?.({...state,pages:state.pages.map(p=>({...p,selected:p.id===state.selected}))});
  window.clw={onState:callback=>{listener=callback;setTimeout(()=>{emit();document.querySelector('.brand-note').textContent='隔离预览';},0);},onIntent(){},
    command:async(action,payload={})=>{
      const p=state.pages.find(p=>p.id===(payload.id||state.selected));
      if(action==='status'){emit();return {};}
      if(action==='select'){state.selected=payload.id;state.view=views.get(payload.id);emit();return {id:payload.id};}
      if(action==='theme'){state.theme=payload.theme;emit();return {};}
      if(action==='layout'||action==='dismiss-notice'||action==='copy-record-text')return {};
      if(action==='pause'){p.paused=true;emit();return {};}
      if(action==='resume'){p.paused=false;emit();return {};}
      if(action==='team-maintenance'){state.view.maintenance=state.view.maintenance?null:{state:'settled'};emit();return {};}
      if(action==='inspect')return {model:p.model,effort:p.effort};
      if(action==='set-model'){p.effort=payload.effort;p.observation.effortLabel=payload.effort;p.observation.model.effort=payload.effort;emit();return {model:p.model,effort:p.effort};}
      if(action==='prompt-preview')return {blocks:[{title:'示例要求',text:payload.instructions||text[p?.id]?.[0]||'隔离预览要求'},{title:'接入约定',text:'实际产品从正式后端读取，此预览不接入任何工具或账号。'}]};
      if(action==='record-index')return {page_id:payload.id,thread_id:'preview-thread-'+payload.id,items:[],total:0};
      if(action==='pick-root')return {root:'D:/Games/Camp'};
      if(action==='native-codex-start'||action==='codex-start')throw Error('隔离预览不会启动真实终端。实际入口已由独立检查核对。');
      if(action==='start'){
        if(payload.objective?.trim()){const view=views.get(payload.id);view.events=[...view.events,{seq:view.events.length+1,kind:'host_user_note',delivery:'queued_note',at:new Date().toISOString(),data:{text:payload.objective}}];}
        if(payload.resume)p.paused=false;state.view=views.get(state.selected);emit();return {state:'note_saved_not_native_interrupt',resumed:!!payload.resume};
      }
      throw Error('隔离预览仅展示界面，不执行此操作。');
    }};
}
const previewScript='('+fixture.toString()+')();';
const server=http.createServer((request,response)=>{
  const name=new URL(request.url,'http://127.0.0.1').pathname.slice(1);
  if(name==='preview-fixture.js'){response.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});response.end(previewScript);return;}
  if(name===''||name==='index.html'){
    const html=fs.readFileSync(path.join(host,'index.html'),'utf8').replace('<script src="failure-state.js">','<script src="preview-fixture.js"></script><script src="failure-state.js">');
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);return;
  }
  if(!assets.has(name)){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'Content-Type':name.endsWith('.css')?'text/css; charset=utf-8':'application/javascript; charset=utf-8'});response.end(fs.readFileSync(path.join(host,name)));
});
server.listen(0,'127.0.0.1',()=>{
  fs.mkdirSync(output,{recursive:true});const receipt={pid:process.pid,url:'http://127.0.0.1:'+server.address().port+'/',isolated:true,modelSends:0,realCommands:0,script:__filename};
  fs.writeFileSync(path.join(output,'preview-receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(receipt.url);
});
