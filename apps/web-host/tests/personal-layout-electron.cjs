'use strict';
// Actual Chromium layout of the owned CLW shell, isolated from user accounts.
const {app,BrowserWindow,ipcMain,session}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const output=path.resolve(process.argv[2]||'.local/personal-redesign-20261011/layout');
app.setPath('userData',path.join(output,'profile'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let win,latestState,errors=[];
let bodyReadCount=0,mcpReadCount=0,finishBodyRead=null,finishMcpRead=null;
const layoutAnchors=[];
const paragraph='这是一段用于验证连续阅读位置的长回复。展开、收起以及状态变化应保留阅读位置。';
const longReply=Array.from({length:100},(_,i)=>'段落 '+i+'。'+paragraph+'\n\n').join('')+'$$\\int_0^1 x^2\\,dx=\\frac13$$';
const events=[
  {seq:1,kind:'user_message',at:new Date().toISOString(),delivery:'sent',data:{text:'完整需求\n'.repeat(500)}},
  {seq:2,kind:'assistant_message',at:new Date().toISOString(),data:{text:longReply}},
  {seq:3,kind:'host_claimed',at:new Date().toISOString(),data:{text:'当前工具执行已受理'}},
  {seq:4,kind:'assistant_message',at:new Date().toISOString(),data:{text:longReply}}
];
const state=()=>({connected:true,taskStateReady:true,theme:'dark',accent:'purple',selected:'layout-test',closed:[],recordHistory:{web:true,codex:true},
  pages:[{id:'layout-test',title:'长需求与长回复',kind:'task',bound:true,root:'D:/fixture/project',account:'A',thread_id:'layout-thread',
    model:'GPT-6 Latest',effort:'High',paused:false,status:'idle',observation:{at:Date.now(),model:'GPT-6 Latest',effort:'High',generating:false,historyAtLatest:true}}],
  codexWeb:{recent:[]},view:{page_id:'layout-test',thread_id:'layout-thread',events,request:null,latest_request:null,
    run:{state:'closed',dispatches:1,max_dispatches:null,deadline:null},send_stats:{confirmed:1,unconfirmed:0}}});
ipcMain.handle('clw-command',async(_event,{action,payload})=>{
  if(action==='state')return latestState;
  if(action==='record-body'&&payload.seq===0){bodyReadCount++;return new Promise(resolve=>{finishBodyRead=resolve;});}
  if(action==='mcp-call-details'){mcpReadCount++;return new Promise(resolve=>{finishMcpRead=resolve;});}
  if(action==='theme'){latestState={...latestState,...payload};win.webContents.send('clw-state',latestState);}
  return {};
});
async function js(code){return win.webContents.executeJavaScript(code);}
async function frame(){await wait(180);}
async function screenshot(name){fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function visibleParagraph(){return js(`(()=>{const s=document.getElementById('conversation'),top=s.getBoundingClientRect().top;for(const p of document.querySelectorAll('#events [data-seq="2"] .text>p')){const r=p.getBoundingClientRect();if(r.height&&r.bottom>top+8&&r.top<top+s.clientHeight)return {text:p.textContent.slice(0,64),offset:r.top-top};}return null;})()`);}
async function pinParagraph(index){await js(`(()=>{const s=document.getElementById('conversation'),p=[...document.querySelectorAll('#events [data-seq="2"] .text>p')].find(n=>n.textContent.startsWith('段落 ${index}。'));if(!p)throw Error('reader paragraph missing');s.dispatchEvent(new WheelEvent('wheel'));s.scrollTop+=p.getBoundingClientRect().top-s.getBoundingClientRect().top-10;s.dispatchEvent(new Event('scroll'));})()`);await frame();return visibleParagraph();}
async function expectParagraph(label,before){const after=await visibleParagraph();assert.ok(before&&after,label+' missing visible paragraph');assert.equal(after.text,before.text,label+' changed visible paragraph');assert.ok(Math.abs(after.offset-before.offset)<4,label+' moved paragraph '+JSON.stringify({before,after}));layoutAnchors.push({label,before,after});}
app.whenReady().then(async()=>{
  fs.mkdirSync(output,{recursive:true});
  await session.defaultSession.clearStorageData();
  win=new BrowserWindow({width:1640,height:960,show:false,webPreferences:{preload:path.resolve(__dirname,'../preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  win.webContents.on('console-message',(_event,...args)=>{const detail=args.find(x=>x&&typeof x==='object');if(detail?.level==='error'||args[0]===3)errors.push(detail?.message||String(args[1]));});
  await win.loadFile(path.resolve(__dirname,'../index.html'));latestState=state();win.webContents.send('clw-state',latestState);await frame();
  // Expand the prior long reply while following latest: the gesture must stop following.
  await js("document.querySelector('[data-seq=\"2\"] .record-body-toggle')?.click()");await frame();
  await js("document.getElementById('conversation').scrollTop=400;document.getElementById('conversation').dispatchEvent(new WheelEvent('wheel'));document.getElementById('conversation').dispatchEvent(new Event('scroll'))");await frame();
  const before=await js("({top:document.getElementById('conversation').scrollTop,height:document.getElementById('conversation').scrollHeight})");
  await js("document.querySelector('[data-seq=\"4\"] .record-body-toggle')?.click()");await frame();
  const after=await js("({top:document.getElementById('conversation').scrollTop,height:document.getElementById('conversation').scrollHeight})");
  assert.ok(Math.abs(after.top-before.top)<4,'collapse below the reader moved their position');
  assert.ok(after.top<after.height-900,'collapse jumped to the bottom');
  assert.equal(await js("document.querySelector('[data-seq=\"1\"]').open"),false,'long user requirement should start as preview');
  const noteInCenter=await js("document.getElementById('events').textContent.includes('当前工具执行已受理')");assert.equal(noteInCenter,false);
  assert.equal(await js("document.getElementById('process-events').textContent.includes('当前工具执行已受理')"),true);
  const reading=await pinParagraph(25);
  await js("document.getElementById('process-close').click()");await frame();await expectParagraph('right_panel_close',reading);
  await js("document.getElementById('process-toggle').click()");await frame();await expectParagraph('right_panel_open',reading);
  const widthBefore=await js("document.querySelector('[data-seq=\"2\"] .text').getBoundingClientRect().width");
  win.setContentSize(1300,960);await frame();await expectParagraph('width_reflow',reading);
  const widthAfter=await js("document.querySelector('[data-seq=\"2\"] .text').getBoundingClientRect().width");
  assert.ok(Math.abs(widthBefore-widthAfter)>16,'resize did not exercise actual text reflow');
  win.setContentSize(1640,960);await frame();await expectParagraph('width_restore',reading);
  const remote={seq:0,kind:'assistant_message',at:new Date().toISOString(),body_loaded:false,text_length:longReply.length,bodyRevision:'remote-body-1',data:{text:'较早的长正文预览'}};
  events.unshift(remote);latestState=state();win.webContents.send('clw-state',latestState);await frame();await expectParagraph('older_preview_inserted',reading);
  await js("document.querySelector('[data-seq=\"0\"] .record-body-toggle').click()");await frame();assert.equal(bodyReadCount,1);assert.equal(typeof finishBodyRead,'function');
  finishBodyRead({page_id:'layout-test',thread_id:'layout-thread',event:{...remote,body_loaded:true,data:{text:longReply}}});await frame();await frame();await expectParagraph('async_full_body_loaded_above',reading);assert.equal(bodyReadCount,1);
  assert.ok(await js("document.querySelector('[data-seq=\"0\"] .katex')!==null"));
  await js("document.querySelector('[data-seq=\"0\"] .katex').style.fontSize='42px'");await frame();await expectParagraph('late_math_reflow_above',reading);
  await js("document.getElementById('record-latest').click()");await frame();
  events.push({seq:5,kind:'assistant_message',at:new Date().toISOString(),data:{text:'最新输出\n\n'+paragraph.repeat(50)}});latestState=state();win.webContents.send('clw-state',latestState);await frame();await frame();
  const latestFollowing=await js("(()=>{const s=document.getElementById('conversation');return {top:s.scrollTop,bottom_gap:s.scrollHeight-s.clientHeight-s.scrollTop,following:recordHistory.active.following};})()");assert.equal(latestFollowing.following,true);assert.ok(Math.abs(latestFollowing.bottom_gap)<4,'new output did not keep latest edge');
  const tool='12345678-1234-1234-1234-123456789abc',details={arguments:{available:true},response:{available:true}};
  latestState.view.session_activity={source:'mcp_union_metadata',scope:'bound_session_argument',events:[{callId:tool,tool:'read_files',event:'mcp_call_started',at:'2026-10-11T12:00:00.000Z',details}]};win.webContents.send('clw-state',latestState);await frame();
  await js("[...document.querySelectorAll('#session-mcp-activity-list button')].find(n=>n.textContent==='参数').click()");await frame();assert.equal(mcpReadCount,1);assert.equal(typeof finishMcpRead,'function');
  latestState.view.session_activity.events.push({callId:tool,tool:'read_files',event:'mcp_call_finished',at:'2026-10-11T12:00:01.000Z',details});win.webContents.send('clw-state',latestState);await frame();
  const originalBytes='ORIGINAL_DETAIL_BYTES';finishMcpRead({available:true,data:originalBytes,offset:0,next_offset:originalBytes.length,total_bytes:originalBytes.length,eof:true});await frame();assert.equal(await js("document.querySelector('#session-mcp-activity-list .mcp-details-data').textContent"),originalBytes);assert.equal(mcpReadCount,1,'metadata refresh repeated original detail read');
  // A refreshed state must not rewrite focused text or its selection.
  await js("{const t=document.getElementById('objective');t.value='完整保留草稿和选择范围';t.dispatchEvent(new Event('input'));t.focus();t.setSelectionRange(2,7)}");
  latestState=state();win.webContents.send('clw-state',latestState);await frame();
  const draft=await js("{const t=document.getElementById('objective');({text:t.value,start:t.selectionStart,end:t.selectionEnd})}");
  assert.equal(draft.text,'完整保留草稿和选择范围');assert.equal(draft.start,2);assert.equal(draft.end,7);
  await js("document.getElementById('composer-expand').click()");await frame();
  assert.equal(await js("document.body.classList.contains('composer-expanded')"),true);
  assert.equal(await js("document.getElementById('objective').selectionStart"),2);
  await screenshot('large-editor');await js("document.getElementById('composer-expand').click()");await frame();
  fs.writeFileSync(path.join(output,'desktop-geometry.json'),JSON.stringify(await js("({classes:document.body.className,expanded:composerExpanded,height:document.getElementById('objective').getBoundingClientRect().height,cssHeight:document.getElementById('objective').style.height})")));
  await screenshot('desktop');
  const responsive=[];
  for(const width of [1280,900,430,360]){
    win.setContentSize(width,900);await frame();
    await js("document.getElementById('process-close').click()");await frame();
    const geometry=await js("['objective','composer-stack','start'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,x:r.x,right:r.right,width:r.width}})");
    for(const r of geometry)assert.ok(r.x>=-1&&r.right<=width+1,'overflow '+width+' '+r.id);
    responsive.push({width,geometry});await screenshot('width-'+width);
    await js("document.getElementById('process-toggle').click()");await frame();
    const panel=await js("{const r=document.getElementById('process-panel').getBoundingClientRect();({left:r.left,right:r.right,hidden:document.getElementById('process-panel').hidden})}");
    assert.equal(panel.hidden,false);assert.ok(panel.left>=0&&panel.right<=width+1,'drawer overflow');
  }
  assert.ok(await js("document.querySelectorAll('.katex').length")>0,'offline math was not rendered');
  assert.equal(errors.length,0,errors.join('\n'));
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({state:'passed',scope:'actual_owned_chromium_layout',before,after,draft,responsive,layoutAnchors,latestFollowing,textWidths:[widthBefore,widthAfter],body_reads:bodyReadCount,mcp_detail_reads:mcpReadCount,model_calls:0,user_accounts_opened:0},null,2));
  app.exit(0);
}).catch(error=>{fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'failure.txt'),error.stack);console.error(error.stack);app.exit(1);});
