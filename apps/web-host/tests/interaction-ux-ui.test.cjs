'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');

test('real browser gives immediate waiting feedback, automatically displays new records and preserves deliberate reading',async()=>{
  const output=path.resolve('.local/personal-redesign-20261011/goal-controls/git-archive/interaction-regression-'+Date.now());fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1380,height:960}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
    await page.addInitScript(()=>{
      localStorage.clear();window.commands=[];const now=new Date().toISOString();
      const event=(seq,text)=>({seq,kind:seq%2?'user_message':'assistant_message',at:now,body_loaded:true,body_revision:'original-'+seq,data:{text}});
      window.makeEvent=event;
      window.fixture={selected:'alpha',connected:true,taskStateReady:true,closed:[],root:'D:/Fixture',theme:'dark',network:'隔离测试',
        pages:['alpha','beta'].map(id=>({id,title:id,kind:'task',root:'D:/Fixture/'+id,account:'A',bound:true,paused:false,model:'GPT-6',effort:'Pro',
          observation:{at:Date.now(),generating:false,editorReady:true,historyAtLatest:true},latest_request:null})),
        recordHistory:{web:true,codex:true},codexWeb:{recent:[]},localCodex:{available:false},
        view:{page_id:'alpha',thread_id:'original-alpha',events:Array.from({length:40},(_,i)=>event(i+1,'Original saved text '+(i+1)+'\n\n'+('Complete readable paragraph. '.repeat(24)))),
          record_history:{total:40,has_before:false,has_after:false}}};
      window.clw={onState:callback=>{window.updateFixture=()=>{callback(window.fixture);renderStateImmediately();};setTimeout(window.updateFixture,0);},onIntent(){},
        command:async(action,payload={})=>{window.commands.push({action,payload});
          if(action==='refresh')return new Promise((resolve,reject)=>{window.finishRefresh=resolve;window.refuseRefresh=reject;});
          if(action==='record-body')return {page_id:'alpha',thread_id:'original-alpha',event:window.fixture.view.events.find(row=>row.seq===payload.seq)};
          return {};}};
    });
    await page.goto('file:///'+path.resolve('apps/web-host/index.html').replaceAll('\\','/'));
    await page.locator('#thread-title').getByText('alpha',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('#events [data-seq]').length===40);
    await page.waitForFunction(()=>{const s=document.getElementById('conversation');return s.scrollHeight-s.clientHeight-s.scrollTop<5;});
    assert.equal(await page.locator('#record-latest').isVisible(),false);
    assert.equal(await page.locator('#refresh-page').isVisible(),false,'Record reading does not expose webpage refresh');
    await page.locator('#native').click();
    assert.equal(await page.locator('#refresh-page').isVisible(),true);
    assert.equal(await page.locator('#refresh-page').getAttribute('aria-label'),'刷新当前网页');
    for(const width of [360,430]){
      await page.setViewportSize({width,height:960});
      const buttons=await page.locator('.topbar button:visible').evaluateAll(nodes=>nodes.map(node=>{
        const r=node.getBoundingClientRect();return {id:node.id,x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};}));
      for(const r of buttons)assert.ok(r.x>=0&&r.y>=0&&r.right<=width&&r.width>0&&r.height>0,r.id+' fits at '+width);
      for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++){
        const a=buttons[i],b=buttons[j];assert.ok(a.right<=b.x||b.right<=a.x||a.bottom<=b.y||b.bottom<=a.y,a.id+' does not overlap '+b.id+' at '+width);
      }
      assert.equal(await page.locator('#refresh-page').isVisible(),true);
      await page.screenshot({path:path.join(output,'refresh-header-'+width+'.png')});
    }
    await page.setViewportSize({width:1380,height:960});
    const clickStarted=performance.now();await page.locator('#refresh-page').click();
    await page.waitForFunction(()=>typeof window.finishRefresh==='function');
    assert.equal(await page.locator('#refresh-page').getAttribute('aria-busy'),'true');
    assert.equal(await page.locator('#interaction-status').isVisible(),true);
    assert.match(await page.locator('#interaction-status-text').innerText(),/正在刷新/);
    const immediateFeedbackMs=performance.now()-clickStarted;
    await page.screenshot({path:path.join(output,'waiting-original-refresh.png')});
    await page.evaluate(()=>window.refuseRefresh(Error('原刷新未完成')));
    await page.waitForFunction(()=>document.getElementById('interaction-status').hidden);
    assert.equal(await page.locator('#refresh-page').getAttribute('aria-busy'),null);
    assert.match(await page.locator('#notice-text').innerText(),/原刷新未完成/);
    assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.action==='refresh').length),1);
    await page.locator('#records').click();assert.equal(await page.locator('#refresh-page').isVisible(),false);
    await page.evaluate(()=>{window.fixture.view.events.push(window.makeEvent(41,'New automatic reply'));window.fixture.view.record_history.total=41;window.updateFixture();});
    await page.locator('#events [data-seq="41"] .text').getByText('New automatic reply',{exact:true}).waitFor();
    assert.equal(await page.locator('#events [data-seq="41"] .text').getAttribute('data-render-format'),'markdown');
    await page.waitForFunction(()=>{const s=document.getElementById('conversation');return s.scrollHeight-s.clientHeight-s.scrollTop<5;});
    const geometry=await page.locator('#conversation').boundingBox();await page.mouse.move(geometry.x+geometry.width/2,geometry.y+geometry.height/2);
    await page.mouse.wheel(0,-650);
    await page.waitForFunction(()=>recordHistory.active.following===false);
    // Capture after the browser's physical wheel has settled; saved record
    // changes must preserve this actual scroll anchor rather than a fake value.
    await page.waitForFunction(()=>Date.now()-(recordScrollInput.get(document.getElementById('conversation'))||0)>800);
    const before=await page.evaluate(()=>({top:document.getElementById('conversation').scrollTop,anchor:recordAnchor(document.getElementById('conversation'))}));
    await page.evaluate(()=>{window.fixture.view.events.push(window.makeEvent(42,'New reply while reading history'));window.fixture.view.record_history.total=42;window.updateFixture();});
    await page.locator('#record-latest').getByText('查看新记录 ↓',{exact:true}).waitFor();
    const after=await page.evaluate(()=>({top:document.getElementById('conversation').scrollTop,anchor:recordAnchor(document.getElementById('conversation')),live:recordHistory.active.live}));
    assert.equal(after.live,true);assert.equal(after.anchor.key,before.anchor.key);assert.ok(Math.abs(after.top-before.top)<2);
    await page.screenshot({path:path.join(output,'reading-with-new-record.png')});
    const historyReads=await page.evaluate(()=>window.commands.filter(c=>c.action==='record-history').length);
    await page.locator('#record-latest').click();
    await page.waitForFunction(()=>{const s=document.getElementById('conversation');return s.scrollHeight-s.clientHeight-s.scrollTop<5&&recordHistory.active.following;});
    assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.action==='record-history').length),historyReads);
    assert.equal(await page.locator('#record-latest').isVisible(),false);
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('#native').click();await page.locator('#refresh-page').click();
    assert.equal(await page.locator('#interaction-status .interaction-spinner').evaluate(node=>getComputedStyle(node).animationName),'none');
    assert.equal(await page.locator('#refresh-page .ui-icon').evaluate(node=>getComputedStyle(node).animationName),'none');
    await page.evaluate(()=>window.finishRefresh({message:'原刷新已核对'}));
    await page.waitForFunction(()=>document.getElementById('interaction-status').hidden);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'validation.json'),JSON.stringify({isolated:true,modelSends:0,liveInstancesTouched:false,immediateFeedbackMs,
      originalRefreshCalls:2,refreshVisibleOnlyOnWebpage:true,refreshHeaderWidths:[360,430],refreshHeaderNoOverlap:true,
      followLatestAutomatic:true,readingAnchorPreserved:true,latestWithoutExtraHistoryRead:true,reducedMotion:true,browserErrors:errors},null,2)+'\n');
  }finally{await browser.close();}
});
