'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');

test('real renderer paints pending before cached large replies and cancels delayed paint after context changes',async()=>{
  // A new file-only browser and fake IPC, with the real shipped renderer.
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const errors=[],external=[];
  try{
    for(const width of [1440,430]){
      const page=await browser.newPage({viewport:{width,height:960}});
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>{if(route.request().url().startsWith('file:'))return route.continue();external.push(route.request().url());return route.abort();});
      await page.addInitScript(()=>{
        localStorage.clear();window.commands=[];
        const now=new Date().toISOString(),full='Original exact beginning\n'+('Complete readable paragraph.\n'.repeat(35000))+'\nOriginal exact tail';
        window.fullReply=full;
        const rows=id=>[1,2,3,4].map(seq=>({seq,kind:seq%2?'user_message':'assistant_message',at:now,
          body_loaded:seq!==2,text_length:seq===2?full.length:30,body_revision:id+'-'+seq,
          data:{text:seq===2?full.slice(0,600):id+' exact short record '+seq}}));
        window.makeView=id=>({page_id:id,thread_id:'thread-'+id,events:rows(id),record_history:{total:4,has_before:false,has_after:false}});
        window.fixture={selected:'alpha',connected:true,connectionGeneration:1,taskStateReady:true,closed:[],root:'D:/Fixture',theme:'dark',
          pages:['alpha','beta'].map(id=>({id,title:id,kind:'task',bound:true,root:'D:/Fixture/'+id,account:'A',paused:false,
            model:'GPT-6',effort:'Pro',observation:{at:Date.now(),generating:false,editorReady:true,historyAtLatest:true}})),
          recordHistory:{web:true,codex:true},codexWeb:{recent:[]},localCodex:{available:false},view:window.makeView('alpha')};
        localStorage.setItem('clw-composer-drafts',JSON.stringify([['alpha','Alpha original draft'],['beta','Beta original draft']]));
        window.clw={onIntent(){},onState(callback){window.publishFixture=()=>callback(window.fixture);setTimeout(window.publishFixture,0);},
          command:async(action,p={})=>{
            window.commands.push({action,payload:p});
            if(action==='select'){window.fixture.selected=p.id;window.fixture.view=window.makeView(p.id);window.publishFixture();return {selected:p.id};}
            if(action==='record-body')return {page_id:p.id,thread_id:'thread-'+p.id,
              event:{...window.makeView(p.id).events.find(row=>row.seq===p.seq),data:{text:full}}};
            if(['submit','resume','pause','start-first-turn','codex-start','goal-continue','stop-generation','maintenance'].includes(action))throw Error('fixture execution refused');
            return {};
          }};
        window.armFirstFrame=action=>{
          document.addEventListener('click',function watch(event){
            if(!event.target.closest('#events>[data-seq="2"] .record-body-toggle'))return;
            document.removeEventListener('click',watch,true);
            const control=document.querySelector('#events>[data-seq="2"] .record-body'),toggle=control.querySelector('.record-body-toggle');
            window.originalBody=control;window.firstFrame=null;
            requestAnimationFrame(()=>{
              window.firstFrame={pending:toggle.getAttribute('aria-busy'),expanded:control.dataset.expanded,
                previewChars:control.querySelector('.text').textContent.length,status:control.querySelector('[role="status"]').textContent};
              if(action==='collapse')control.collapse();
              if(action==='dispose')control.dispose();
              if(action==='close-message')control.closest('details').open=false;
              if(action==='workflow')document.getElementById('mode-codex').click();
              if(action==='task')document.querySelector('#pages [data-page-id="beta"] .task-select').click();
              window.captureDone=true;
            });
          },true);
        };
      });
      const ready=async()=>{
        await page.goto('file:///'+path.resolve(__dirname,'../index.html').replaceAll('\\','/'));
        await page.locator('#thread-title').getByText('alpha',{exact:true}).waitFor();
        await page.locator('#events>[data-seq="2"] .record-body-toggle').waitFor();
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      };
      await ready();
      for(let iteration=0;iteration<2;iteration++){
        await page.evaluate(()=>window.armFirstFrame('none'));
        await page.locator('#events>[data-seq="2"] .record-body-toggle').click();
        await page.waitForFunction(()=>document.querySelector('#events>[data-seq="2"] .text')?.textContent===window.fullReply);
        const first=await page.evaluate(()=>window.firstFrame);
        assert.equal(first.pending,'true');assert.equal(first.expanded,'false');assert.ok(first.previewChars<2000);
        assert.match(first.status,/正在展开正文/);
        await page.locator('#events>[data-seq="2"] .record-body-toggle').click();
      }
      assert.equal(await page.evaluate(()=>window.commands.filter(row=>row.action==='record-body').length),1,'second expansion uses the original cached source');
      for(const action of ['collapse','dispose','close-message','workflow','task']){
        await ready();await page.evaluate(action=>window.armFirstFrame(action),action);
        await page.locator('#events>[data-seq="2"] .record-body-toggle').click();
        await page.waitForFunction(()=>window.captureDone);
        // Four real frames cover the source callback, pending yield and shell render.
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))));
        const old=await page.evaluate(()=>({text:window.originalBody.querySelector('.text').textContent,
          full:window.fullReply,expanded:window.originalBody.dataset.expanded,selected:state.selected,
          workflow:workflowMode,input:document.getElementById('objective').value}));
        assert.notEqual(old.text,old.full,action+' must not paint the old full body');assert.equal(old.expanded,'false');
        if(action==='task'){assert.equal(old.selected,'beta');assert.equal(old.input,'Beta original draft');}
        if(action==='workflow')assert.equal(old.workflow,'codex');
      }
      assert.equal(await page.evaluate(()=>window.commands.some(row=>['submit','resume','pause','start-first-turn','codex-start','goal-continue','stop-generation','maintenance'].includes(row.action))),false);
      await page.close();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  }finally{await browser.close();}
});
