'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('../node_modules/playwright-core');

test('isolated redesigned workspace keeps continuous records, reachable goals and responsive display without sending work',async()=>{
  const output=path.resolve('.local/product-control-20261006/ui-final');fs.mkdirSync(output,{recursive:true});
  const sourceHashes=()=>Object.fromEntries(['index.html','shell.css','shell.js','task-presentation.js','codex-turns.js','work-record.js','rich-text.js','rich-text.css','assets/vendor/markdown-it/UPSTREAM.json','assets/vendor/katex/UPSTREAM.json','assets/vendor/markdown-it-texmath/UPSTREAM.json'].map(name=>
    [name,crypto.createHash('sha256').update(fs.readFileSync(path.resolve('apps/web-host',name))).digest('hex')]));
  const frozenSources=sourceHashes();
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
    await page.addInitScript(()=>{
      localStorage.clear();window.commands=[];
      const goal={configured:true,objective:'完成个人版产品化\n统一任务、对话和目标管理；保留原任务与暂停意图。',
        state:'paused',mode:'manual',etag:'goal-1',request_id:'original-package',revision:1,
        review:null,can_review:false,can_start_next:false,next:null,cycles:0};
      const request={id:'original-package',phase:'processing',cancel_requested:0};
      const event=seq=>({seq,kind:seq%2?'host_user_note':'assistant_message',at:'2026-10-05T22:30:00Z',
        ...(seq===9?{delivery:'queued_note',withdraw:{request_id:'original-package',note_id:'original-unread-note'}}:{}),
        data:{text:seq%2?'把目标、验收与下一包操作整理清楚，保持当前工作。':'已整理本包的界面与状态逻辑。\n\n目标独立保存；当前网页继续执行，下一工作包由你明确发放。'}});
      const richSource='## 回复也可以直接显示公式\n\n行内 $E=mc^2$ 和 \\(a^2+b^2=c^2\\)。\n\n$$\n\\begin{aligned} F(x)&=\\int_0^x t^2\\,dt\\\\&=\\frac{x^3}{3}\\end{aligned}\n$$\n\n| 项目 | 当前状态 |\n| --- | --- |\n| 离线字体 | 已打包 |\n| 原稿复制 | 保留 |\n\n```js\nconst price = "$20"; // 代码保持原文\n```';
      const task={id:'product',kind:'task',title:'个人版产品化',root:'D:/Example/Product',account:'A',bound:true,paused:true,
        access:'write',write_paths:['.'],
        model:'GPT-6 · 最新',effort:'Pro',latest_request:request,goal:{...goal,objective:undefined},
        budget_status:{etag:'budget-1',run_id:'run-original',scope:'active',used:7,limit:40,available_sends:33,available_seconds:18000,can_continue:false},
        observation:{generating:true,editorReady:true,observed:Date.now()/1000,modelLabel:'GPT-6 · 最新',effortLabel:'Pro'}};
      window.fixture={connected:true,taskStateReady:true,connectionGeneration:1,selected:task.id,pages:[task],closed:[],theme:'dark',network:'隔离预览 · 不连接现场',
        localCodex:{available:true},codexWeb:{state:'ready',recent:['aaaaaaaaaaaa','bbbbbbbbbbbb'].map((traceId,index)=>({
          traceId,account:'A',status:'completed',submission:'confirmed',startedAt:index?'2026-10-05T22:00:00Z':'2026-10-05T22:30:00Z',
          bodyRevision:'saved-'+traceId,source:{traceId,threadId:'native-fixture-task',turnId:'turn-'+traceId,
            workingDirectory:'D:/Example/NativeProduct',model:'chatgpt-web/pro',account:'A'},
          nativeState:{state:'completed'},review:{finalText:'已保存的原生任务回复。\n\n保持原工具执行与网页模型的分工；新记录应连续展示。'}
        }))},recordHistory:{web:true,codex:true},
        view:{page_id:task.id,thread_id:'original-thread',request,latest_request:request,goal,
          run:{id:'run-original',state:'running',dispatches:7,max_dispatches:40},
          events:Array.from({length:10},(_,i)=>i===9?{...event(i+1),data:{text:richSource}}:event(i+1)),record_history:{total:10,has_before:false,has_after:false}}};
      window.clw={onState(callback){window.updateFixture=()=>{callback(window.fixture);renderStateImmediately();};setTimeout(window.updateFixture,0);},onIntent(){},
        async command(action,payload){window.commands.push({action,payload:structuredClone(payload)});
          if(action==='goal-read')return {goal:structuredClone(window.fixture.view.goal),model_sends:0};
          if(action==='record-body')return {page_id:task.id,thread_id:'original-thread',event:window.fixture.view.events.find(row=>row.seq===payload.seq)};
          return {};}};
    });
    await page.goto('file:///'+path.resolve('apps/web-host/index.html').replaceAll('\\','/'));
    await page.locator('#thread-title').getByText('个人版产品化',{exact:true}).waitFor();
    assert.equal(await page.locator('#events .record-message[open]').count(),10);
    assert.equal(await page.locator('#settings-refill').count(),1);
    assert.equal(await page.locator('#settings-refill').isVisible(),true);
    assert.equal(await page.locator('#composer-pending .composer-pending-row').count(),1);
    assert.equal(await page.locator('#composer-pending .composer-pending-status').innerText(),'待下一轮处理');
    assert.equal(await page.locator('#events [data-seq="10"] .katex').count(),3);
    await page.evaluate(()=>document.fonts.ready);
    assert.equal(await page.evaluate(()=>document.fonts.check('16px KaTeX_Main')),true);
    await page.screenshot({path:path.join(output,'desktop-conversation.png')});
    await page.locator('#composer-stack').screenshot({path:path.join(output,'composer-stack.png')});
    await page.locator('#composer-add').click();
    assert.equal(await page.locator('#composer-add-menu').isVisible(),true);
    assert.equal(await page.locator('#composer-add-files').isEnabled(),true);
    assert.equal(await page.locator('#composer-add-folder').isEnabled(),true);
    await page.screenshot({path:path.join(output,'composer-add-menu.png')});
    await page.locator('#composer-add').click();
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('.sidebar').isVisible(),false);
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
    await page.screenshot({path:path.join(output,'navigation-collapsed.png')});
    await page.locator('#sidebar-toggle').click();assert.equal(await page.locator('.sidebar').isVisible(),true);
    await page.locator('#settings-refill').click();
    await page.waitForFunction(()=>document.querySelector('#budget-dialog').open&&!goalReadPending);
    assert.equal(await page.locator('#goal-objective-view').isVisible(),true);
    assert.equal(await page.locator('#goal-form').isVisible(),false);
    assert.equal(await page.locator('#goal-review-section').isVisible(),false);
    assert.equal(await page.locator('#budget-continue-section').isVisible(),false);
    assert.equal(await page.locator('#budget-details').isVisible(),true);
    await page.screenshot({path:path.join(output,'goal-current-package.png')});
    await page.locator('#goal-edit').click();assert.equal(await page.locator('#goal-form').isVisible(),true);
    await page.locator('#goal-objective').fill('保留未保存的编辑文字');
    await page.locator('#budget-close').click();await page.locator('#settings-refill').click();
    await page.waitForFunction(()=>document.querySelector('#budget-dialog').open&&!goalReadPending);
    assert.equal(await page.locator('#goal-objective').inputValue(),'保留未保存的编辑文字');
    await page.locator('#budget-close').click();
    for(const width of [1440,980,700,430,360]){
      await page.setViewportSize({width,height:850});
      if(width<=760 && await page.locator('.sidebar').isVisible())await page.locator('#sidebar-close').click();
      if(width<=760)assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
      const bounds=await page.locator('#compose-footer').boundingBox();
      assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width+1);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      assert.equal(await page.locator('#sidebar-toggle').isVisible(),true);

      const geometry=await page.evaluate(()=>{
        const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
        const primaryAction=document.getElementById('start').hidden?'composer-stop':'start';
        const visiblePrimaryCount=['start','composer-stop'].filter(id=>{const r=rect(id);return r.width>0&&r.height>0;}).length;
        return {viewport:innerWidth,stack:rect('composer-stack'),context:rect('composer-context'),form:rect('composer'),model:rect('model-button'),primaryAction,visiblePrimaryCount,start:rect(primaryAction),add:rect('composer-add'),access:rect('composer-access')};
      });
      assert.equal(geometry.visiblePrimaryCount,1,'The generating or input state has exactly one primary action');
      assert.ok(Math.abs(geometry.context.x-geometry.form.x)<1,'Context and input share their left edge');
      assert.ok(Math.abs(geometry.context.width-geometry.form.width)<1,'Context and input share their width');
      assert.ok(Math.abs(geometry.context.bottom-geometry.form.y)<1,'Context and input meet without overlap');
      assert.ok(Math.abs(geometry.model.y+geometry.model.height/2-geometry.start.y-geometry.start.height/2)<1,'Model and primary action share their vertical center');
      assert.ok(Math.abs(geometry.add.y+geometry.add.height/2-geometry.start.y-geometry.start.height/2)<1,'Add and primary action share their vertical center');
      assert.ok(geometry.access.right<=geometry.model.x+1,'Permission does not overlap the model');
      assert.ok(geometry.model.right<=geometry.start.x+1,'Model does not overlap the primary action');
      fs.writeFileSync(path.join(output,'geometry-'+width+'.json'),JSON.stringify(geometry,null,2));
      await page.screenshot({path:path.join(output,'conversation-'+width+'.png')});

      await page.locator('#settings-refill').click();
      await page.waitForFunction(()=>document.querySelector('#budget-dialog').open&&!goalReadPending);
      const dialog=await page.locator('#budget-dialog').boundingBox();
      assert.ok(dialog.x>=0&&dialog.x+dialog.width<=width+1);
      await page.screenshot({path:path.join(output,'goal-'+width+'.png')});
      await page.locator('#budget-close').click();
    }
    await page.evaluate(()=>{window.fixture.theme='light';window.updateFixture();});
    await page.setViewportSize({width:1440,height:960});
    await page.screenshot({path:path.join(output,'light-conversation.png')});
    await page.locator('#settings-refill').click();
    await page.waitForFunction(()=>document.querySelector('#budget-dialog').open&&!goalReadPending);
    await page.locator('#goal-edit-cancel').click();
    assert.equal(await page.locator('#goal-form').isVisible(),false);
    await page.locator('#budget-close').click();
    await page.evaluate(()=>{
      const f=window.fixture,p=f.pages[0];f.theme='dark';p.latest_request.phase='completed';f.view.request=null;p.observation.generating=false;
      f.view.run.state='closed';Object.assign(p.budget_status,{scope:'next',can_continue:true});
      Object.assign(f.view.goal,{can_review:true,etag:'goal-2',revision:2});
      p.goal={...f.view.goal,objective:undefined};window.updateFixture();
    });
    await page.locator('#settings-refill').click();
    await page.waitForFunction(()=>document.querySelector('#budget-dialog').open&&!goalReadPending);
    assert.equal(await page.locator('#goal-review-section').isVisible(),true);
    assert.equal(await page.locator('#budget-continue-section').isVisible(),false);
    await page.screenshot({path:path.join(output,'goal-review-package.png')});
    await page.locator('#budget-close').click();
    await page.evaluate(()=>{
      const f=window.fixture;Object.assign(f.view.goal,{etag:'goal-3',revision:3,can_start_next:true,
        review:{request_id:'original-package',decision:'continue',note:'本轮已验收，下一包由我明确决定。',actor:'human'}});
      f.pages[0].goal={...f.view.goal,objective:undefined};window.updateFixture();
    });
    await page.locator('#settings-refill').click();
    await page.waitForFunction(()=>document.querySelector('#budget-dialog').open&&!goalReadPending);
    assert.equal(await page.locator('#goal-review-section').isVisible(),false);
    assert.equal(await page.locator('#goal-review-summary').isVisible(),true);
    assert.equal(await page.locator('#budget-continue-section').isVisible(),true);
    await page.screenshot({path:path.join(output,'goal-next-package.png')});
    await page.locator('#budget-close').click();
    if(!await page.locator('.sidebar').isVisible())await page.locator('#sidebar-toggle').click();
    await page.locator('#workflow-selector>summary').click();await page.locator('#mode-codex').click();
    assert.equal(await page.locator('#codex-workspace').isVisible(),true);
    assert.equal(await page.locator('#settings-refill').isVisible(),false);
    await page.screenshot({path:path.join(output,'codex-web-overview.png')});
    await page.locator('.codex-task-nav').click();
    await page.locator('[data-trace="aaaaaaaaaaaa"] .message').waitFor();
    await page.evaluate(()=>{
      const original=window.fixture.codexWeb.recent[0],traceId='cccccccccccc';
      window.fixture.codexWeb.recent.unshift({...original,traceId,startedAt:'2026-10-05T23:00:00Z',bodyRevision:'saved-'+traceId,
        source:{...original.source,traceId,turnId:'turn-'+traceId},review:{finalText:'新的回复自动显示，前面的已读正文继续保留。'}});
      window.updateFixture();
    });
    await page.locator('[data-trace="cccccccccccc"] .message').waitFor();
    assert.equal(await page.locator('[data-trace="aaaaaaaaaaaa"] .message').isVisible(),true);
    assert.equal(await page.locator('[data-trace="bbbbbbbbbbbb"] .message').count(),0);
    assert.equal(await page.locator('[data-trace="aaaaaaaaaaaa"]').evaluate(node=>!!node.closest('.task-turn-history')),false);
    assert.equal(await page.locator('#codex-turns .work-record-turn > button:visible').count(),1,'Only the latest legal resume stays in the transcript');
    const previousSource=page.locator('[data-trace="aaaaaaaaaaaa"] > details').filter({has:page.getByText('来源与回合',{exact:true})});
    await previousSource.locator('summary').click();
    assert.equal(await previousSource.locator('button:visible').count(),2,'Older view and resume remain reachable inside source details');
    await previousSource.locator('summary').click();
    await page.screenshot({path:path.join(output,'codex-web-conversation.png')});
    if(!await page.locator('.sidebar').isVisible())await page.locator('#sidebar-toggle').click();
    await page.locator('#workflow-selector>summary').click();await page.locator('#mode-local').click();
    assert.equal(await page.locator('#local-workspace').isVisible(),true);
    assert.equal(await page.locator('#conversation').isVisible(),false);
    await page.screenshot({path:path.join(output,'local-codex-entry.png')});

    const precedingBusiness=await page.evaluate(()=>window.commands.filter(row=>['start','send','resume','enroll','goal-save','goal-review','goal-continue','refill-budget','stop-generation','refresh'].includes(row.action)));
    await page.setViewportSize({width:430,height:850});
    await page.reload();
    await page.locator('#thread-title').getByText('个人版产品化',{exact:true}).waitFor();
    assert.equal(await page.locator('.sidebar').isVisible(),false,'Compact first load starts with a full transcript');
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
    const mainClosed=await page.locator('main').boundingBox();
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('.sidebar').isVisible(),true);
    assert.equal(await page.locator('#sidebar-close').isVisible(),true);
    assert.equal(await page.locator('#sidebar-scrim').isVisible(),true);
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'true');
    const mainOpen=await page.locator('main').boundingBox();
    assert.deepEqual(mainOpen,mainClosed,'Drawer does not squeeze or move the transcript');
    await page.screenshot({path:path.join(output,'navigation-mobile.png')});
    await page.locator('#sidebar-close').click();
    assert.equal(await page.locator('.sidebar').isVisible(),false);
    assert.equal(await page.locator('#sidebar-scrim').isVisible(),false);
    await page.locator('#sidebar-toggle').click();
    await page.locator('#sidebar-scrim').click({position:{x:400,y:120}});
    assert.equal(await page.locator('.sidebar').isVisible(),false);
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
    const business=await page.evaluate
(()=>window.commands.filter(row=>['start','send','resume','enroll','goal-save','goal-review','goal-continue','refill-budget','stop-generation','refresh'].includes(row.action)));
    assert.deepEqual(business,[]);assert.deepEqual(errors,[]);
    for(const name of ['index.html','shell.css'])assert.equal(sourceHashes()[name],frozenSources[name],'Visual source stayed stable during the preview');
    fs.writeFileSync(path.join(output,'fixture-validation.json'),JSON.stringify({scope:'isolated file fixture with fake IPC and network denied',
      viewport_widths:[1440,980,700,430,360],themes:['dark','light'],modes:['web','codex','local'],
      goal_states:['current_package','unsaved_draft','review','explicit_next_package'],
      continuous_messages:10,page_errors:errors,business_operations:business,source_sha256:frozenSources,
      computer_use:false,original_browser_accessed:false,actual_model_sends:0},null,2));
  }finally{await browser.close();}
});
