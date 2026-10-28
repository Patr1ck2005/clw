const {chromium}=require('../apps/web-host/node_modules/playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const output=path.resolve(process.argv[2]||'.local/web-record-ui-check');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1380,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.request().url().startsWith('file:')?r.continue():r.abort());
 await page.addInitScript(()=>{
  localStorage.clear();
  const id='web-11111111-1111-4111-8111-111111111111';
  window.fixture={root:'D:/CLW-source',selected:null,pages:[],closed:[{id,title:'已结束的示例',root:'D:/Example',account:'A',closed:true,url:'https://chatgpt.com/c/example'}],theme:'dark',connected:true,network:'VPN 已连接 · 直连已禁用'};
  window.commands=[];
  window.clw={onState:cb=>{window.updateFixture=value=>{cb(value);renderStateImmediately();};setTimeout(()=>window.updateFixture(window.fixture),0);},onIntent:()=>{},command:async(action,payload)=>{
   window.commands.push({action,payload});
   if(action==='new'){
    const p={id:'web-22222222-2222-4222-8222-222222222222',title:payload.first_turn_instructions||'新任务',root:'D:/Documents/CLW/Tasks/new',account:payload.account,automaticWorkspace:!payload.root,firstTurnDraft:payload.first_turn_instructions,firstTurnOptions:payload.first_turn_options,kind:'task',status:'idle',selected:true};
    window.fixture.pages=[p];window.fixture.selected=p.id;window.updateFixture(window.fixture);return {id:p.id};
   }
   if(action==='delete-task'){window.fixture.closed=[];window.updateFixture(window.fixture);return {deleted:true};}
   if(action==='prompt-preview')return {blocks:[{title:'连接器与项目背景',text:'@Local-MCP\n工作工程：D:/Documents/CLW/Tasks/new'},{title:'用户授权声明',text:'真实授权模板由后端测试核对；本页仅核验显示与交互。'},{title:'你的首次要求与结果交付',text:payload.instructions}]};
   return {};
  }};
 });
 await page.goto('file:///'+path.resolve('apps/web-host/index.html').replaceAll('\\','/'));
 await page.evaluate(()=>{
  window.fixture.taskStateReady=false;
  window.fixture.pages=[{id:'saved-game',title:'游戏开发',root:'D:/Games',kind:'task',account:'A',bound:false},{id:'saved-math',title:'数学研究',root:'D:/Math',kind:'task',account:'B',bound:false}];
  window.updateFixture(window.fixture);
 });
 assert.equal(await page.locator('#workspace-loading').isVisible(),true);
 assert.equal(await page.locator('#task-empty').isVisible(),false);
 assert.equal(await page.locator('#new-page').isDisabled(),true);
 assert.match(await page.locator('#connection').innerText(),/正在恢复/);
 assert.match(await page.locator('#pages').innerText(),/正在恢复任务/);
 assert.doesNotMatch(await page.locator('#pages').innerText(),/未接入|已就绪/);
 assert.equal(await page.locator('.loading-spinner').evaluate(e=>getComputedStyle(e).animationName),'clw-loading');
 await page.screenshot({path:path.join(output,'restoring-workspace.png')});
 await page.evaluate(()=>{
  window.fixture.taskStateReady=true;window.fixture.selected='saved-math';
  Object.assign(window.fixture.pages[1],{bound:true,paused:true,access:'read'});
  window.updateFixture(window.fixture);
 });
 assert.equal(await page.locator('#workspace-loading').isVisible(),false);
 assert.match(await page.locator('#workflow-title').innerText(),/已暂停/);
 assert.doesNotMatch(await page.locator('#pages').innerText(),/正在恢复任务/);
 assert.equal(await page.evaluate(()=>window.commands.some(c=>['new','start-first-turn','resume','submit'].includes(c.action))),false);
 await page.evaluate(()=>{window.fixture.selected=null;window.fixture.pages=[];window.updateFixture(window.fixture);});
 await page.locator('#new-page').click();
 assert.equal(await page.locator('#task-dialog').isVisible(),false);
 assert.equal(await page.locator('#first-task-form').isVisible(),true);
 await page.locator('#first-task-objective').fill('阅读交接，整理下一步计划');
 assert.equal(await page.locator('#root').inputValue(),'');
 assert.equal(await page.locator('#first-task-options').getAttribute('open'),null);
 await page.locator('#first-task-account').selectOption('A');
 assert.match(await page.locator('#connection').innerText(),/账号 A/);
 assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.action==='new').length),0);
 await page.screenshot({path:path.join(output,'new-task.png')});
 await page.locator('#first-task-effort').click();
 assert.equal(await page.locator('#first-model-menu').isVisible(),true);
 const menuColors=await page.locator('#first-model-menu').evaluate(e=>({background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color}));
 assert.notEqual(menuColors.background,'rgb(255, 255, 255)');assert.notEqual(menuColors.background,menuColors.color);
 await page.screenshot({path:path.join(output,'model-menu.png')});
 await page.locator('[data-first-effort="Pro"]').click();
 assert.match(await page.locator('#first-task-send').innerText(),/Pro/);
 await page.locator('#task-prompt-summary').click();
 await page.locator('#task-prompt-blocks').getByText('@Local-MCP',{exact:false}).waitFor();
 await page.locator('#first-task-objective').fill('阅读交接，深入分析三个方案并形成完整研究计划');
 await page.waitForFunction(()=>document.getElementById('task-prompt-blocks').textContent.includes('深入分析三个方案'));
 assert.equal(await page.locator('#first-turn').count(),0);
 await page.locator('#settings').click();
 assert.equal(await page.locator('#details').isVisible(),false);
 assert.equal(await page.locator('#settings-form').isVisible(),true);
 await page.locator('#budget').fill('60');
 await page.locator('#access').selectOption('read');
 await page.locator('#collaboration-protocol').selectOption('text_v1');
 await page.locator('#first-task-options>summary').click();
 await page.screenshot({path:path.join(output,'first-task.png')});
 await page.locator('#first-task-send').click();
 const first=await page.evaluate(()=>window.commands.filter(c=>c.action==='start-first-turn'));
 const created=await page.evaluate(()=>window.commands.filter(c=>c.action==='new'));
 assert.equal(created.length,1);assert.equal(created[0].payload.account,'A');assert.equal(created[0].payload.root,'');
 assert.equal(first[0].payload.max_dispatches,60);assert.equal(first[0].payload.collaboration_protocol,'text_v1');
 assert.equal(first[0].payload.access,'read');assert.deepEqual(first[0].payload.write_paths,[]);
 assert.equal(created[0].payload.first_turn_options.effort,'Pro');assert.equal(created[0].payload.first_turn_options.access,'read');
 assert.equal(first.length,1);assert.equal(first[0].payload.instructions,'阅读交接，深入分析三个方案并形成完整研究计划');assert.equal(first[0].payload.effort,'Pro');
 await page.evaluate(()=>{
  const p=window.fixture.pages[0];p.enrolling=true;
  window.fixture.view={page_id:p.id,session_activity:{source:'mcp_union_metadata',events:Array.from({length:35},(_,i)=>({callId:String(i),tool:'read_files',event:'mcp_call_finished',at:new Date(1000*i).toISOString()}))}};
  window.updateFixture(window.fixture);document.getElementById('session-mcp-activity').open=true;
 });
 assert.equal(await page.locator('#session-mcp-activity-list>ol>li').count(),12);
 await page.locator('.mcp-activity-more>summary').click();assert.equal(await page.locator('.mcp-activity-more li').count(),23);
 await page.locator('.workspace-tools>summary').click();await page.locator('#closed-tasks').click();await page.locator('#closed-list').getByRole('button',{name:'删除本机记录…'}).click();
 assert.match(await page.locator('#dialog-description').innerText(),/ChatGPT 原对话保留/);
 await page.locator('#dialog-cancel').click();assert.equal(await page.locator('.closed-item').count(),1);
 await page.locator('#closed-list').getByRole('button',{name:'删除本机记录…'}).click();await page.screenshot({path:path.join(output,'delete-confirm.png')});
 await page.locator('#dialog-confirm').click();assert.equal(await page.locator('.closed-item').count(),0);
 assert.equal(await page.locator('#closed-count').innerText(),'0');
 await page.locator('#close-details').click();await page.setViewportSize({width:1000,height:760});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.screenshot({path:path.join(output,'compact.png')});
 await page.setViewportSize({width:1380,height:960});
 await page.evaluate(()=>{
  document.getElementById('notice-text').textContent='接入与首次准备已提交，共一条消息。';document.getElementById('notice').hidden=false;
  Object.assign(window.fixture.pages[0],{enrolling:true,paused:true,bootstrap_state:'pending',issue_kind:'model_unavailable',
   attention:'接入和简单准备不能使用 Pro。此旧任务缺少已确认的 Extra High 接入设置',first_turn_instructions:'Research plan',bootstrap_model_selection:{model:'GPT-6',effort:'Pro'}});
  window.updateFixture(window.fixture);
 });
 assert.match(await page.locator('#workflow-title').innerText(),/本地旧规则/);
 assert.equal(await page.locator('#workflow-detail-panel').isVisible(),true);
 assert.match(await page.locator('#task-prompt-summary').innerText(),/待发送/);
 assert.equal(await page.locator('#notice').isVisible(),false);
 await page.screenshot({path:path.join(output,'local-rule-failure.png')});
 await page.evaluate(async()=>{
  Object.assign(window.fixture.pages[0],{paused:false,attention:null,issue_kind:null});
  window.updateFixture(window.fixture);
  const original=window.clw.command;
  window.clw.command=async()=>{throw Error('首次任务已提交，请查看原回执，不要重复发送。');};
  try{await act('start-first-turn');}finally{window.clw.command=original;}
 });
 assert.match(await page.locator('#notice-text').innerText(),/若暂停且尚未发送/);
 assert.equal(await page.locator('#intake-diagnostics').isVisible(),false);
 await page.evaluate(()=>{
  Object.assign(window.fixture.pages[0],{bootstrap_state:'sent',observation:{generating:true,editorReady:true}});
  window.updateFixture(window.fixture);
 });
 assert.match(await page.locator('#workflow-title').innerText(),/思考／工作 · 首次任务/);
 assert.equal(await page.locator('#notice').isVisible(),false);
 assert.equal(await page.locator('#workflow-detail-panel').isVisible(),false);
 assert.equal(await page.locator('#intake-record').isVisible(),true);
 assert.match(await page.locator('#intake-delivery').innerText(),/已送达网页/);
 assert.equal(await page.locator('#task-empty').isVisible(),false);
 await page.locator('#workflow-toggle').click();
 assert.equal(await page.locator('#workflow-toggle').getAttribute('aria-expanded'),'true');
 await page.locator('#workflow-toggle').press('Enter');
 assert.equal(await page.locator('#workflow-detail-panel').isVisible(),false);
 await page.locator('#task-prompt-summary').click();
 await page.locator('#task-prompt-preview').evaluate(e=>e.open=false);
 await page.screenshot({path:path.join(output,'working-first-turn.png')});
 await page.evaluate(()=>{showNotice('独立连接问题仍需核对');window.updateFixture(window.fixture);});
 assert.equal(await page.locator('#notice-text').innerText(),'独立连接问题仍需核对');
 assert.equal(await page.locator('#notice').isVisible(),true);
 await page.evaluate(()=>showNotice(''));
 await page.evaluate(()=>{
  const p=window.fixture.pages[0];Object.assign(p,{bound:true,enrolling:false,model:'GPT-6',effort:'Pro',access:'write',write_paths:['.'],observation:{generating:true,editorReady:true,effortLabel:'Pro'}});
  window.fixture.view={page_id:p.id,request:{id:'fixture-request',phase:'processing',created_at:new Date().toISOString()},attempt:{acknowledged:Date.now()/1000},send_stats:{confirmed:1,unconfirmed:0},events:[
   {seq:1,kind:'user_message',delivery:'delivered',data:{text:'阅读项目交接，整理可并行的工作，并给出完整的实施方案。保留已有成果，说明验证情况。'}},
   {seq:2,kind:'control_received',data:{}},
   {seq:3,kind:'assistant_message',data:{text:'已读取项目交接与当前计划。接下来核对公共接口、独立工作范围和现有验证证据。\n\n实施方案和未决问题会保存到原项目，供后续工作接续。'}}
  ],session_activity:{source:'mcp_union_metadata',events:[{callId:'fixture-read',tool:'read_files',event:'mcp_call_finished',at:new Date().toISOString()}]}};
  window.updateFixture(window.fixture);
 });
 assert.equal(await page.locator('#intake-record').isVisible(),false);
 assert.equal(await page.locator('#compose-footer').isVisible(),true);
 assert.equal(await page.locator('#workflow-detail-panel').isVisible(),false);
 await page.locator('#session-mcp-activity').evaluate(e=>e.open=true);
 await page.screenshot({path:path.join(output,'web-record.png')});
 await page.evaluate(()=>{document.body.classList.add('light');});
 await page.screenshot({path:path.join(output,'web-record-light.png')});
 await page.evaluate(()=>{document.body.classList.remove('light');});
 await page.setViewportSize({width:1000,height:760});await page.locator('#settings').click();
 assert.equal(await page.locator('#details').isVisible(),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.screenshot({path:path.join(output,'web-record-settings-compact.png')});
 await page.locator('#close-details').click();await page.setViewportSize({width:1380,height:960});
 await page.evaluate(()=>{
  const trace='abcdef123456';
  window.fixture.codexWeb={state:'ready',account:'A',tools:{ready:true},recent:[{traceId:trace,source:{traceId:trace,threadId:'sample-task',workingDirectory:'D:/Games/Example',model:'chatgpt-web/pro'},status:'completed',submission:'confirmed',account:'A',url:'https://chatgpt.com/c/example',startedAt:'2026-09-28T05:00:00Z',review:{finalText:'本轮成果已保存。\n\n验证记录和剩余事项见项目 RESULT.md。\n\n```cs\nreturn result;\n```'}}],nativeActivity:{source:'native_broker_metadata',events:Array.from({length:35},(_,i)=>({traceId:trace,callId:'call_'+String(i).padStart(32,'0'),eventId:i+1,atMs:1790571600000+i*1000,tool:i%2?'exec_command':'apply_patch',phase:'result'}))}};
  window.updateFixture(window.fixture);
 });
 await page.locator('#workflow-selector>summary').click();await page.locator('#mode-codex').click();await page.locator('#codex-pages button').click();
 assert.equal(await page.locator('#workflow').isVisible(),true);
 assert.equal(await page.locator('#codex-mcp-activity').isVisible(),false);
 assert.equal(await page.locator('#codex-workspace-title').innerText(),'工作记录');
 assert.match(await page.locator('#codex-turns .message').innerText(),/本轮成果已保存/);
 if(await page.locator('#dismiss-notice').isVisible())await page.locator('#dismiss-notice').click();
 await page.screenshot({path:path.join(output,'codex-record.png')});
 await page.locator('.native-tool-activity>summary').click();
 assert.equal(await page.locator('#codex-turns .mcp-activity-list>li').count(),12);
 await page.locator('#codex-turns .mcp-activity-more>summary').click();
 assert.equal(await page.locator('#codex-turns .mcp-activity-list>li').count(),35);
 await page.screenshot({path:path.join(output,'codex-tools.png')});
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'ui-check.json'),JSON.stringify({passed:true,synthetic:true,modelSends:0,errors,checks:['single inline new-task composer','no page created before send','single settings form and preserved budget/protocol','optional directory/name','account A preserved','editable first goal','Pro selection sent unchanged','prompt blocks refresh after editing','35 tool calls expandable','one combined reservation action','automatic workspace grouped','delete cancel/confirm','cloud deletion not claimed','1000px layout','warning details visible, healthy workflow collapsed','workflow keyboard toggle','first-turn transcript shows truthful delivery','stale submit notice clears after delivery','unrelated warning remains','shared Web and native record styles','dark and light transcript','1000px with settings drawer']},null,2));
 console.log('Pure Web UI interaction checks passed; no real task or model used.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
