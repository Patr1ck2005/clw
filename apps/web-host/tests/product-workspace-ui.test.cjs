'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');

test('task workspace candidate preserves ownership, quiet controls and lazy rendering in a real browser',async t=>{
  const output=path.resolve('.local/product-control-20261006/workspace-regression');fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1380,height:960}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
    await page.addInitScript(()=>{
      localStorage.clear();window.commands=[];
      const now=new Date().toISOString(),observed=Date.now()/1000;
      const tasks=['Camp Dungeon · 示例','Spirefall · 示例'].map((title,index)=>({
        id:index?'spire':'camp',kind:'task',title,root:index?'D:/Games/Spirefall':'D:/Games/Camp',account:'A',
        bound:true,paused:false,model:'GPT-6 · 最新',effort:'Pro',access:'write',write_paths:['.'],
        latest_request:{id:index?'accepted-spire':'accepted-camp',phase:'processing',attempt_id:index?'control_spire':'control_camp',sent_user_hash:'confirmed-original'},
        observation:{generating:true,observed,modelLabel:'GPT-6 · 最新',effortLabel:'Pro',editorReady:true},
      }));
      window.fixture={connected:true,taskStateReady:true,root:'D:/CLW',selected:'camp',pages:tasks,closed:[],theme:'dark',
        network:'VPN 已连接',localCodex:{available:true,protocol:'installed-codex-cli',capabilities:['launch','resume']},
        recordHistory:{web:true,codex:true},codexWeb:{state:'ready',account:'A',recent:[]},
        view:{page_id:'camp',thread_id:'original-camp',request:{...tasks[0].latest_request,created_at:now},latest_request:tasks[0].latest_request,
          attempt:{id:'control_camp',state:'acknowledged',acknowledged:observed},run:{state:'running',dispatches:4,max_dispatches:40},
          events:[{seq:1,kind:'user_message',delivery:'delivered',at:now,data:{text:'把双人协作、营地升级和保存接续放在一个完整工作包里推进。保持当前 Unity 工程与模型，完成场景接线后运行双 Player 验证。'}},
            {seq:2,kind:'control_received',at:now,data:{}},
            {seq:3,kind:'assistant_message',at:now,data:{text:'示例进展：正在整合营地系统与双人协作。场景、模型、角色和交互统一检查，当前等待协作者交回独立模块。\n\n已保存的回执与待验证项会一起交回主控。'}}],
          session_activity:{source:'mcp_union_metadata',events:Array.from({length:80},(_,i)=>({callId:String(i),tool:'read_files',event:'mcp_call_finished',at:now}))},
          record_history:{total:3,has_before:false,has_after:false}},
      };
      window.clw={onState:callback=>{window.updateFixture=value=>{callback(value);renderStateImmediately();};setTimeout(()=>window.updateFixture(window.fixture),0);},onIntent(){},
        command:async(action,payload)=>{window.commands.push({action,payload});
          if(action==='record-index')return {mode:'web',page_id:payload.page_id||payload.id,thread_id:'original-camp',items:[],total:0};
          if(action==='start'){
            if(window.deferStartReply)return new Promise(resolve=>{window.finishStartReply=resolve;});
            if(payload.resume){window.fixture.pages.find(task=>task.id===payload.id).paused=false;window.updateFixture(window.fixture);}
            return {state:'note_saved_not_native_interrupt',resumed:payload.resume};
          }
          if(action==='resume'){window.fixture.pages.find(task=>task.id===payload.id).paused=false;window.updateFixture(window.fixture);return {model_sends:0};}
          if(action==='native-codex-start')return {launched:true,protocol:'installed-codex-cli'};
          if(action==='pick-root')return {root:'D:/Games/Camp'};
          return {};}};
    });
    await page.goto('file:///'+path.resolve('apps/web-host/index.html').replaceAll('\\','/'));
    await page.locator('#workflow-title').getByText('思考／工作',{exact:true}).waitFor();
    await t.test('working task shows one submit action and the low-frequency controls have explicit entries',async()=>{
      assert.equal(await page.locator('#workflow-action').isVisible(),false);
      assert.equal(await page.locator('#resume').isVisible(),false);
      assert.equal(await page.locator('#team-maintenance').isVisible(),false);
      assert.equal(await page.locator('#stop-generation').isVisible(),false);
      assert.equal(await page.locator('#start').isDisabled(),true);
      assert.match(await page.locator('#start').innerText(),/保存补充/);
      assert.equal(await page.locator('#record-toolbar button:visible').count(),1);
      assert.equal(await page.locator('#record-latest').isVisible(),false,'Following current records does not need a second latest button');
      assert.equal(await page.locator('#task-prompt-preview').isVisible(),false);
      await page.locator('#task-menu-toggle').click();
      assert.match(await page.locator('#team-maintenance').innerText(),/暂停自动推进/);
      assert.match(await page.locator('#stop-generation').innerText(),/停止网页生成/);
      assert.equal(await page.locator('#refresh-page').isDisabled(),true);
      await page.locator('#task-menu-toggle').click();
      await page.screenshot({path:path.join(output,'working-task.png')});
    });
    await t.test('an unchanged heartbeat preserves navigation, transcript and closed tool details',async()=>{
      assert.equal(await page.locator('#session-mcp-activity-list>ol>li').count(),12);
      await page.locator('#session-mcp-activity>summary').click();
      assert.equal(await page.locator('#session-mcp-activity').getAttribute('open'),null);
      assert.equal(await page.locator('#session-mcp-activity-list').isVisible(),false);
      const result=await page.evaluate(()=>{
        const first=document.querySelector('#pages .task-row'),reply=document.querySelector('#events [data-seq="3"]'),tool=document.querySelector('#session-mcp-activity-list li');
        let mutations=0;const targets=[];const observer=new MutationObserver(rows=>{mutations+=rows.length;for(const row of rows)targets.push(row.target.outerHTML?.slice(0,300)||row.target.nodeName);});
        observer.observe(document.getElementById('events'),{subtree:true,childList:true,characterData:true});
        observer.observe(document.getElementById('process-panel'),{subtree:true,childList:true,characterData:true});
        const started=performance.now();for(let i=0;i<60;i++)window.updateFixture({...window.fixture});
        observer.takeRecords().forEach(row=>{mutations++;targets.push(row.target.outerHTML?.slice(0,300)||row.target.nodeName);});observer.disconnect();
        return {sameNav:first===document.querySelector('#pages .task-row'),sameReply:reply===document.querySelector('#events [data-seq="3"]'),mutations,
          sameTool:tool===document.querySelector('#session-mcp-activity-list li'),tools:document.querySelectorAll('#session-mcp-activity-list li').length,milliseconds:performance.now()-started,targets};
      });
      assert.equal(result.sameNav,true);assert.equal(result.sameReply,true);assert.equal(result.sameTool,true);assert.equal(result.mutations,0,JSON.stringify(result.targets));assert.equal(result.tools,12);
      fs.writeFileSync(path.join(output,'unchanged-render.json'),JSON.stringify(result,null,2)+'\n');
      await page.locator('#session-mcp-activity>summary').click();
      assert.equal(await page.locator('#session-mcp-activity-list>ol>li').count(),12);
      await page.locator('#session-mcp-activity>summary').click();
    });
    await t.test('a missed incremental state update requests one full snapshot and keeps the last accepted request',async()=>{
      const result=await page.evaluate(()=>{
        window.fixture.stateRevision=10;window.updateFixture(window.fixture);
        const transcript=document.querySelector('#events [data-seq="3"]');
        window.updateFixture({statePatch:true,baseRevision:10,stateRevision:11,network:'VPN 已连接 · 新观察'});
        const before=window.commands.filter(c=>c.action==='status').length;
        window.updateFixture({statePatch:true,baseRevision:12,stateRevision:13,selected:'spire',view:null});
        window.updateFixture({statePatch:true,baseRevision:13,stateRevision:14,selected:'spire',view:null});
        const result={requests:window.commands.filter(c=>c.action==='status').length-before,
          sameTranscript:transcript===document.querySelector('#events [data-seq="3"]'),title:document.getElementById('thread-title').textContent};
        window.fixture.stateRevision=14;window.updateFixture(window.fixture);return result;
      });
      assert.equal(result.requests,1);assert.equal(result.sameTranscript,true);assert.match(result.title,/Camp/);
    });
    await t.test('paused work saves text without resuming and explicit resume retains the original request',async()=>{
      await page.evaluate(()=>{window.fixture.pages[0].paused=true;window.fixture.pages[0].observation.generating=true;window.updateFixture(window.fixture);});
      assert.equal(await page.locator('#workflow-action').isVisible(),false);
      assert.equal(await page.locator('#resume').isVisible(),false);
      assert.match(await page.locator('#start').innerText(),/保存补充/);assert.equal(await page.locator('#start').isDisabled(),true);
      assert.match(await page.locator('#workflow-title').innerText(),/已暂停/);
      await page.screenshot({path:path.join(output,'paused-task.png')});
      assert.equal(await page.locator('#start').isDisabled(),true);
      await page.locator('#objective').fill('保留当前回合，下一包再细化动画。');
      await page.locator('#start').click();
      const submitted=await page.evaluate(()=>window.commands.filter(c=>c.action==='start'));
      assert.equal(submitted.length,1);assert.equal(submitted[0].payload.id,'camp');
      assert.equal(submitted[0].payload.expected_request_id,'accepted-camp');assert.equal(submitted[0].payload.objective,'保留当前回合，下一包再细化动画。');assert.equal(submitted[0].payload.resume,false);
      assert.match(await page.locator('#workflow-title').innerText(),/思考／工作.*已暂停/);
      await page.locator('#task-menu-toggle').click();
      assert.equal(await page.locator('#resume').isVisible(),true);
      await page.locator('#resume').click();
      const restored=await page.evaluate(()=>window.commands.filter(c=>c.action==='resume'));
      assert.equal(restored.length,1);assert.equal(restored[0].payload.id,'camp');assert.equal(restored[0].payload.expected_request_id,'accepted-camp');
      assert.doesNotMatch(await page.locator('#workflow-title').innerText(),/已暂停/);
      await page.screenshot({path:path.join(output,'resumed-task.png')});
    });
    await t.test('late saved text cannot erase a newly edited draft after returning to the same original task',async()=>{
      await page.evaluate(()=>{window.fixture.pages[0].paused=true;window.deferStartReply=true;window.updateFixture(window.fixture);});
      await page.locator('#objective').fill('同一段文字的新草稿');await page.locator('#start').click();
      await page.waitForFunction(()=>typeof window.finishStartReply==='function');
      const resumeBefore=await page.evaluate(()=>window.commands.filter(c=>c.action==='resume').length);
      await page.evaluate(()=>{window.fixture.selected='spire';window.fixture.view={page_id:'spire',thread_id:'original-spire',request:{id:'accepted-spire',phase:'processing'},events:[]};window.updateFixture(window.fixture);});
      await page.locator('#objective').fill('B 的独立草稿');
      await page.evaluate(()=>{window.fixture.selected='camp';window.fixture.view={page_id:'camp',thread_id:'original-camp',request:{id:'accepted-camp',phase:'processing'},events:[]};window.updateFixture(window.fixture);});
      await page.locator('#objective').fill('中间编辑');await page.locator('#objective').fill('同一段文字的新草稿');
      await page.evaluate(()=>{window.deferStartReply=false;window.finishStartReply({state:'note_saved_not_native_interrupt'});});
      await page.waitForFunction(()=>!busy.has('start'));
      assert.equal(await page.locator('#objective').inputValue(),'同一段文字的新草稿');
      assert.equal(await page.evaluate(()=>drafts.get('camp')),'同一段文字的新草稿');
      assert.equal(await page.evaluate(()=>drafts.get('spire')),'B 的独立草稿');
      assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.action==='resume').length),resumeBefore);
      assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.action==='start').at(-1).payload.resume),false);
    });
    await t.test('a replacement request cannot consume consent to stop an earlier webpage',async()=>{
      await page.locator('#task-menu-toggle').click();await page.locator('#stop-generation').click();
      await page.evaluate(()=>{window.fixture.pages[0].latest_request={id:'replacement-camp',phase:'processing'};window.fixture.view.request=window.fixture.pages[0].latest_request;window.updateFixture(window.fixture);});
      await page.locator('#dialog-confirm').click();
      assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.action==='stop-generation').length),0);
      assert.match(await page.locator('#notice-text').innerText(),/原回合已经变化/);
    });
    await t.test('selection while Stop is awaiting confirmation cannot stop a different task',async()=>{
      await page.locator('#task-menu-toggle').click();await page.locator('#stop-generation').click();
      await page.evaluate(()=>{window.fixture.selected='spire';window.fixture.view={page_id:'spire',thread_id:'original-spire',events:[]};window.updateFixture(window.fixture);});
      await page.locator('#dialog-confirm').click();
      assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.action==='stop-generation').length),0);
      assert.match(await page.locator('#notice-text').innerText(),/任务已切换/);
    });
    await t.test('local Codex has an independent real launch route with no Web model fields',async()=>{
      await page.locator('#workflow-selector>summary').click();
      assert.equal(await page.locator('.workflow-choices>button:visible').count(),3);
      await page.locator('#mode-local').click();
      assert.equal(await page.locator('#local-workspace').isVisible(),true);
      assert.equal(await page.locator('#conversation').isVisible(),false);assert.equal(await page.locator('#compose-footer').isVisible(),false);
      await page.locator('#local-codex-root').fill('D:/Games/Camp');await page.locator('#local-codex-open').click();await page.locator('#local-codex-resume').click();
      const native=await page.evaluate(()=>window.commands.filter(c=>c.action==='native-codex-start'));
      assert.deepEqual(native.map(c=>c.payload),[{workingDirectory:'D:/Games/Camp',resume:false},{workingDirectory:'D:/Games/Camp',resume:true}]);
      assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.action==='codex-start').length),0);
      assert.match(await page.locator('#notice-text').innerText(),/已打开本地 Codex/);
      await page.screenshot({path:path.join(output,'local-codex.png')});
    });
    await t.test('operation notices stay with their task and workflow while shared connection faults remain',async()=>{
      await page.locator('#workflow-selector>summary').click();await page.locator('#mode-web').click();
      assert.equal(await page.locator('#notice').isVisible(),false,'A native launch receipt must not label a Web task');
      await page.evaluate(()=>showNotice('Spirefall 任务的操作回执'));
      await page.evaluate(()=>{window.fixture.selected='camp';window.fixture.view={page_id:'camp',thread_id:'original-camp',request:{id:'accepted-camp',phase:'processing'},events:[]};window.updateFixture(window.fixture);});
      assert.equal(await page.locator('#notice').isVisible(),false,'A task receipt must not label another selected task');
      await page.locator('#workflow-selector>summary').click();await page.locator('#mode-local').click();
      await page.evaluate(()=>{
        const command=window.clw.command;window.nativeCommand=command;
        window.clw.command=(action,payload)=>action==='native-codex-start'?new Promise(resolve=>{window.finishNativeLaunch=resolve;}):command(action,payload);
      });
      await page.locator('#local-codex-open').click();
      await page.waitForFunction(()=>typeof window.finishNativeLaunch==='function');
      await page.locator('#workflow-selector>summary').click();await page.locator('#mode-web').click();
      await page.evaluate(()=>{window.finishNativeLaunch({launched:true});window.clw.command=window.nativeCommand;});
      assert.equal(await page.locator('#notice').isVisible(),false,'A late native receipt must not acquire a new workflow owner');
      await page.evaluate(()=>{window.fixture.connected=false;window.fixture.taskStateReady=false;window.fixture.notice='本机通信中断；原请求保留，请核对原执行。';window.updateFixture(window.fixture);});
      assert.match(await page.locator('#notice-text').innerText(),/本机通信中断/);
      await page.locator('#workflow-selector>summary').click();await page.locator('#mode-local').click();
      assert.match(await page.locator('#notice-text').innerText(),/本机通信中断/,'A shared connection fault must survive workflow changes');
      await page.locator('#workflow-selector>summary').click();await page.locator('#mode-web').click();
      await page.evaluate(()=>{window.fixture.selected='spire';window.fixture.view={page_id:'spire',thread_id:'original-spire',events:[]};window.updateFixture(window.fixture);});
      assert.match(await page.locator('#notice-text').innerText(),/本机通信中断/,'A shared connection fault must survive task changes');
      await page.evaluate(()=>{window.fixture.connected=true;window.fixture.taskStateReady=true;window.updateFixture(window.fixture);});
      assert.equal(await page.locator('#notice').isVisible(),false,'A confirmed reconnect retires only the connection warning');
    });
    await t.test('record index refresh problems remain separate from bridge readiness and preserve the list',async()=>{
      await page.locator('#workflow-selector>summary').click();await page.locator('#mode-codex').click();
      await page.evaluate(()=>{window.fixture.codexWeb.displayIndex={loading:true,stale:true,errorCode:'PRIVATE_DETAIL'};window.updateFixture(window.fixture);});
      assert.match(await page.locator('#codex-record-status').innerText(),/记录待更新/);
      assert.match(await page.locator('#codex-status').innerText(),/已就绪/);
      await page.evaluate(()=>{window.fixture.codexWeb.displayIndex={stale:true,unavailable:true,errorCode:'PRIVATE_DETAIL'};window.updateFixture(window.fixture);});
      assert.match(await page.locator('#codex-record-status').innerText(),/记录暂不可用/);
      assert.doesNotMatch(await page.locator('#codex-record-status').innerText(),/PRIVATE_DETAIL/);
      await page.evaluate(()=>{window.fixture.codexWeb.displayIndex={};window.updateFixture(window.fixture);});
      assert.equal(await page.locator('#codex-record-status').isVisible(),false);
    });
    await t.test('details and compact layout keep the workspace reachable without horizontal overflow',async()=>{
      await page.locator('#workflow-selector>summary').click();await page.locator('#mode-web').click();
      await page.locator('#settings').click();assert.equal(await page.locator('#details').isVisible(),true);
      assert.equal(await page.locator('#process-panel').isVisible(),false,'Settings own the side surface without overlap');
      assert.equal(await page.locator('#notice').isVisible(),false);
      await page.setViewportSize({width:1000,height:760});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
      await page.screenshot({path:path.join(output,'compact-details.png')});
      await page.locator('#close-details').click();
      assert.equal(await page.locator('#process-panel').isVisible(),false,'Compact process is an explicit drawer');
      await page.locator('#process-toggle').click();assert.equal(await page.locator('#process-panel').isVisible(),true);
      await page.locator('#settings').click();assert.equal(await page.locator('#details').isVisible(),true);
      assert.equal(await page.locator('#process-panel').isVisible(),false);
      await page.locator('#close-details').click();await page.locator('#process-close').click();
      await page.setViewportSize({width:1380,height:960});
      await page.waitForFunction(()=>window.innerWidth===1380&&document.getElementById('process-panel').hidden===false);
      assert.equal(await page.locator('#process-panel').isVisible(),true,'Wide process preference survives compact drawer use');
    });
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'browser-errors.json'),JSON.stringify(errors)+'\n');
  }finally{await browser.close();}
});
