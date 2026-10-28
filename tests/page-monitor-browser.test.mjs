// Real Chromium DOM, isolated empty context, all HTTPS requests intercepted.
// No existing Edge profile, real conversation, platform API or model is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('../apps/web-host/node_modules/playwright-core');
const file=name=>fs.readFileSync(new URL('../apps/web-recovery-companion/'+name,import.meta.url),'utf8');
const chat='https://chatgpt.com/c/12345678-1234-1234-1234-123456789012';
for(const [contenteditable,current] of [[false,false],[true,false],[true,true]])test('standalone monitor real '+(current?'current grouped Pro DOM':contenteditable?'contenteditable':'textarea')+' input, one send, DOM acknowledgement',{timeout:30000},async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-networking','--disable-component-update']});
  try{
    const context=await browser.newContext();
    await context.route('**/*',route=>route.request().url()===chat?route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><title>Synthetic Pro work</title><button id="model" data-testid="composer-thinking-effort-button">Pro</button><main>
      ${current?'<div data-content-search-turn-key="group-u1"><div data-content-search-unit-key="group-u1:0:user"><div data-user-message-bubble>Synthetic private requirement</div></div><div id="answer" class="group/activity-header"><span>正在思考</span></div></div>':'<article data-turn-id="turn-u1"><div data-message-author-role="user" data-message-id="u1">Synthetic private requirement</div></article><article id="answer" data-turn-id="turn-a1"><div data-message-author-role="assistant" data-message-id="a1"><span role="status">正在思考</span></div></article>'}</main>
      <form data-chatgpt-composer>${current?'<div data-composer-markdown role="textbox" contenteditable="true" style="min-height:30px"></div>':contenteditable?'<div id="prompt-textarea" contenteditable="true" style="min-height:30px"></div>':'<textarea id="prompt-textarea"></textarea>'}<button type="button" data-testid="send-button" disabled>Send</button><button type="button" ${current?'aria-label="Stop"':'data-testid="stop-button"'}>Stop</button></form>`}):route.abort());
      const page=await context.newPage();await page.goto(chat);
    await page.evaluate(({chat,current})=>{
      window.clock=100000;Date.now=()=>clock;window.sent=0;window.models=0;window.handlers=[];window.messages=[];
      window.intervals=[];window.setInterval=fn=>{intervals.push(fn);return intervals.length;};window.clearInterval=()=>{};
      const session={},local={},store=backing=>({async get(k){return k===null?structuredClone(backing):{[k]:structuredClone(backing[k])};},async set(x){Object.assign(backing,structuredClone(x));},async remove(k){delete backing[k];}});
      window.chrome={storage:{session:store(session),local:store(local)},tabs:{async get(id){return {id,url:chat,status:'complete'};}},runtime:{getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:{addListener:f=>handlers.push(f),removeListener:f=>{handlers=handlers.filter(x=>x!==f);}},async sendMessage(m){
        messages.push(structuredClone(m));try{return {ok:true,value:await CLWPageMonitorWorker.handle(m,{tab:{id:7,url:chat},url:chat,frameId:0,documentId:'fixture-doc'})};}catch(e){return {ok:false,error:e.message};}
      }}};
      window.popup={url:chrome.runtime.getURL('popup.html')};window.monitorState=async()=>CLWPageMonitorWorker.handle({type:'monitor-status',tabId:7,chatUrl:chat},popup);
      const ed=document.querySelector('textarea,[contenteditable]'),send=document.querySelector('[data-testid="send-button"]');
      window.stopNode=document.querySelector('[data-testid="stop-button"],button[aria-label="Stop"]');
      ed.addEventListener('input',()=>{send.disabled=!(ed.value??ed.textContent).trim();});
      document.querySelector('#model').onclick=()=>models++;
      send.onclick=()=>{sent++;const user=document.createElement('article');user.dataset.turnId='turn-u'+(sent+1);const n=document.createElement('div');n.dataset.messageAuthorRole='user';n.dataset.messageId='u'+(sent+1);n.textContent=ed.value??ed.textContent;user.append(n);document.querySelector('main').append(user);
        if('value'in ed)ed.value='';else ed.textContent='';send.disabled=true;
        const answer=document.createElement('article');answer.dataset.turnId='turn-a'+(sent+1);answer.innerHTML='<div data-message-author-role="assistant" data-message-id="a'+(sent+1)+'"><span role="status">正在思考</span></div>';document.querySelector('main').append(answer);
        stopNode.style.display='';
      };
      window.fail=label=>{stopNode.style.display='none';if(current)document.querySelector('#answer').innerHTML='<span>'+label+'</span>';else document.querySelectorAll('[data-message-author-role="assistant"]')[document.querySelectorAll('[data-message-author-role="assistant"]').length-1].innerHTML='<span role="status">'+label+'</span>';};
    },{chat,current});
    await page.addScriptTag({content:file('page-monitor-worker.js')});await page.addScriptTag({content:file('page-monitor-page.js')});
    const inspected=await page.evaluate(()=>CLWPageMonitorPage.inspect());
    assert.equal(inspected.public_title,'Synthetic Pro work');assert.deepEqual(inspected.public_model_labels,['Pro']);
    assert.equal(inspected.public_last_user_text,'Synthetic private requirement');assert.equal(inspected.public_last_user_truncated,false);
    assert.ok(inspected.public_reply_tail.length<=4096);
    await page.evaluate(async({chat})=>{const r=await CLWPageMonitorWorker.handle({type:'monitor-start',tabId:7,chatUrl:chat,confirm:true},popup);await CLWPageMonitorPage.start(r.generation);},{chat});
    assert.equal(await page.evaluate(()=>sent),0);
    if(current){
      await page.evaluate(async()=>{document.querySelector('#answer').innerHTML='<span>连接已中断，正在等待完整答复</span>';await intervals.at(-1)();});
      await page.waitForFunction(()=>messages.at(-1)?.snapshot?.kind==='connection_wait');
      assert.equal(await page.evaluate(()=>messages.at(-1).snapshot.generating),true);
      await page.evaluate(async()=>{stopNode.style.display='none';await intervals.at(-1)();});
      await page.waitForFunction(()=>messages.at(-1)?.snapshot?.generating===false);
      assert.equal((await page.evaluate(()=>monitorState())).attempts,0);
      // Latest public phase owns the error. Historical, quoted and resumed
      // phases must not consume a send grant on the currently bound manual task.
      for(const body of ['<div class="markdown"><span>无法思考</span></div>',
        '<span>无法思考</span><span>正在思考</span>',
        '<div data-content-search-turn-key="foreign"><span>无法思考</span></div>',
        '<span hidden>无法思考</span>']){
        await page.evaluate(async body=>{stopNode.style.display='none';document.querySelector('#answer').innerHTML=body;await intervals.at(-1)();},body);
        await page.waitForFunction(()=>messages.at(-1)?.snapshot?.kind==='idle');
        assert.equal((await page.evaluate(()=>monitorState())).attempts,0);
      }
    }
    await page.evaluate(async()=>{fail('无法思考');await intervals.at(-1)();});
    await page.waitForFunction(async()=>['backoff','planned'].includes((await monitorState()).state));
    await page.evaluate(async()=>{clock+=15001;await intervals.at(-1)();});
    await page.waitForFunction(()=>sent===1);await page.evaluate(async()=>{await intervals.at(-1)();});
    await page.waitForFunction(async()=>!['dispatching','clicked','unknown','delivery_pending'].includes((await monitorState()).state));
    const result=await page.evaluate(async()=>({sent,models,state:await monitorState(),messages}));
    assert.equal(result.sent,1);assert.equal(result.models,0);assert.equal(result.state.attempts,1);
    assert.ok(!JSON.stringify(result.messages).includes('Synthetic private requirement'));
    assert.equal(await page.locator('#model').textContent(),'Pro');
    await context.close();
  }finally{await browser.close();}
});

async function publicFixture(browser,body){
  const context=await browser.newContext();
  await context.route('**/*',route=>route.request().url()===chat?route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8">'+body+
    '<form data-chatgpt-composer><textarea id="prompt-textarea"></textarea><button type="button" data-testid="send-button">Send</button><button type="button" data-testid="stop-button" hidden>Stop</button></form>'}):route.abort());
  const page=await context.newPage();await page.goto(chat);
  await page.evaluate(()=>{
    window.clicks=0;window.otherClicks=0;window.focused=false;
    document.hasFocus=()=>focused;
    document.querySelectorAll('button').forEach(n=>n.addEventListener('click',()=>{
      if(n.id==='allow'){clicks++;if(window.removeCard!==false)n.closest('section').remove();}else otherClicks++;
    }));
  });
  await page.addScriptTag({content:file('page-monitor-page.js')});
  return {page,context};
}
const currentUser='<div data-message-author-role="user" data-message-id="u-current">Current requirement</div>';
const approvalCard=(app='Local-MCP',allow='允许一次',extra='')=>`<section id="card" data-chatgpt-search-message-ids="12345678-1234-1234-1234-123456789013"><span>${app}</span><h3>允许ChatGPT使用以下工具</h3><span>Run Script</span>${extra}<button id="allow">${allow}</button><button id="deny">拒绝</button></section>`;

test('explicit public inspection reads current markdown siblings and bounded main controls, never sidebar or old reply',{timeout:30000},async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-networking','--disable-component-update']});
  try{
    const tail='current answer '+('x'.repeat(5000));
    const {page,context}=await publicFixture(browser,`<aside><div class="markdown">SIDEBAR SECRET</div><button>SIDEBAR BUTTON</button></aside><main>
      <div class="markdown">OLD REPLY</div>${'old visible text '.repeat(800)}${currentUser}
      <div data-message-author-role="assistant" data-message-id="a-current"><span class="sr-only">ChatGPT 说：</span></div>
      <div class="markdown">${tail}</div><div class="markdown" hidden>HIDDEN REPLY</div>
      ${Array.from({length:30},(_,i)=>`<button>${i}-${'b'.repeat(110)}</button>`).join('')}</main>`);
    const result=await page.evaluate(()=>CLWPageMonitorPage.inspect());
    assert.equal(result.public_reply_tail,tail.slice(-4096));assert.equal(result.public_reply_truncated,true);
    assert.equal(result.public_main_tail.length,6000);assert.equal(result.public_main_truncated,true);
    assert.equal(result.public_button_labels.length,16);assert.ok(result.public_button_labels.every(s=>s.length<=80));
    assert.ok(!result.public_main_tail.includes('SIDEBAR SECRET'));assert.ok(!result.public_main_tail.includes('HIDDEN REPLY'));
    assert.ok(!result.public_button_labels.includes('SIDEBAR BUTTON'));
    assert.ok(!Object.keys(result.snapshot).some(k=>k.startsWith('public_')));
    await page.evaluate(()=>document.querySelectorAll('main .markdown')[1].remove());
    assert.equal((await page.evaluate(()=>CLWPageMonitorPage.inspect())).public_reply_tail,'');
    await context.close();
  }finally{await browser.close();}
});

test('explicit MCP tool approval identifies one public current card and preserves takeover protections',{timeout:60000},async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-networking','--disable-component-update']});
  try{
    for(const [app,label] of [['Local-MCP','允许一次'],['Local-MCP-B','Allow once'],['Local-MCP','允许'],['Local-MCP','Allow']])await t.test('one click '+app+' '+label,async()=>{
      const {page,context}=await publicFixture(browser,'<main>'+currentUser+approvalCard(app,label)+'</main>');
      const result=await page.evaluate(async chat=>CLWPageMonitorPage.approveMcpTool(chat,(await CLWPageMonitorPage.inspect()).snapshot.user_key),chat);
      assert.equal(result.state,'completed');assert.equal(result.result.clicked,true);assert.equal(result.result.card_disappeared,true);
      assert.match(result.result.card_signature,/^[a-f0-9]{64}$/);assert.equal(await page.evaluate(()=>clicks),1);assert.equal(await page.evaluate(()=>otherClicks),0);
      await context.close();
    });
    for(const [name,markup] of [
      ['old card',approvalCard()+currentUser],
      ['unknown connector',currentUser+approvalCard('Local-MCP-evil')],
      ['two connectors',currentUser+approvalCard('Local-MCP','Allow once','<span>Local-MCP-B</span>')],
      ['two cards',currentUser+approvalCard()+approvalCard('Local-MCP-B')],
      ['quoted card',currentUser+'<div class="markdown">'+approvalCard()+'</div>'],
      ['hidden card',currentUser+'<div hidden>'+approvalCard()+'</div>'],
      ['no denial',currentUser+approvalCard().replace('<button id="deny">拒绝</button>','')],
      ['login',currentUser+approvalCard('Local-MCP','Allow once','<span role="alert">Sign in to continue</span>')],
      ['captcha',currentUser+approvalCard('Local-MCP','Allow once','<span role="alert">Verify you are human</span>')],
      ['policy rejection',currentUser+approvalCard('Local-MCP','Allow once','<span role="alert">Safety policy denied this request</span>')],
      ['unknown safe state',currentUser+approvalCard('Local-MCP','Allow once','<span role="alert">无法确定安全状态</span>')],
      ['file materialization',currentUser+approvalCard('Local-MCP','Allow once','<span>Allow file materialization</span>')]
    ])await t.test('reject '+name,async()=>{
      const {page,context}=await publicFixture(browser,'<main>'+markup+'</main>');
      const result=await page.evaluate(async chat=>CLWPageMonitorPage.approveMcpTool(chat,(await CLWPageMonitorPage.inspect()).snapshot.user_key),chat);
      assert.equal(result.state,'failed');assert.equal(result.result.clicked,false);assert.equal(await page.evaluate(()=>clicks),0);assert.equal(await page.evaluate(()=>otherClicks),0);
      await context.close();
    });
    await t.test('login UI and policy files in ordinary tool task remain authorized',async()=>{
      const task='<pre>修复登录UI，检查policy文件与政策文档；repair sign in UI and log in tests.</pre>';
      const {page,context}=await publicFixture(browser,'<main>'+currentUser+approvalCard('Local-MCP','Allow once',task)+'</main>');
      const result=await page.evaluate(async chat=>CLWPageMonitorPage.approveMcpTool(chat,(await CLWPageMonitorPage.inspect()).snapshot.user_key),chat);
      assert.equal(result.state,'completed');assert.equal(result.result.clicked,true);assert.equal(result.result.card_disappeared,true);
      assert.equal(await page.evaluate(()=>clicks),1);assert.equal(await page.evaluate(()=>otherClicks),0);await context.close();
    });
    for(const takeover of ['draft','focus','manual','url','user','card'])await t.test('takeover before click '+takeover,async()=>{
      const {page,context}=await publicFixture(browser,'<main>'+currentUser+approvalCard()+'</main>');
      const key=(await page.evaluate(()=>CLWPageMonitorPage.inspect())).snapshot.user_key;
      await page.evaluate(takeover=>{
        const real=crypto.subtle.digest.bind(crypto.subtle);let changed=false;
        crypto.subtle.digest=async(...args)=>{
          if(!changed){changed=true;
            if(takeover==='draft')document.querySelector('textarea').value='human draft';
            if(takeover==='focus'){focused=true;document.querySelector('textarea').focus();}
            if(takeover==='url')history.replaceState(null,'','/c/other');
            if(takeover==='user')document.querySelector('[data-message-author-role="user"]').setAttribute('data-message-id','new-user');
            if(takeover==='card')document.querySelector('section h3').textContent='Allow ChatGPT to use a different tool';
            if(takeover==='manual')window.manualReady=true;
            if(takeover==='manual')await new Promise(resolve=>{window.finishDigest=resolve;});
          }
          return real(...args);
        };
      },takeover);
      const pending=page.evaluate(async({chat,key})=>CLWPageMonitorPage.approveMcpTool(chat,key),{chat,key});
      if(takeover==='manual'){
        await page.waitForFunction(()=>window.manualReady);await page.locator('textarea').press('Shift');await page.evaluate(()=>finishDigest());
      }
      const result=await pending;
      assert.equal(result.state,'failed');assert.equal(result.result.clicked,false);assert.equal(await page.evaluate(()=>clicks),0);
      if(takeover==='draft')assert.equal(await page.locator('textarea').inputValue(),'human draft');
      await context.close();
    });
    await t.test('unknown click cannot be repeated on original card',async()=>{
      const {page,context}=await publicFixture(browser,'<main>'+currentUser+approvalCard()+'</main>');
      await page.evaluate(()=>{document.querySelector('#allow').click=()=>{clicks++;throw Error('click response lost');};});
      const result=await page.evaluate(async chat=>{
        const key=(await CLWPageMonitorPage.inspect()).snapshot.user_key;
        return [await CLWPageMonitorPage.approveMcpTool(chat,key),await CLWPageMonitorPage.approveMcpTool(chat,key)];
      },chat);
      assert.ok(result.every(r=>r.state==='unknown'&&r.result.clicked&&!r.result.card_disappeared));
      assert.equal(result[0].result.card_signature,result[1].result.card_signature);assert.equal(await page.evaluate(()=>clicks),1);
      await context.close();
    });
    await t.test('click acknowledgement leaves still visible original card explicit',async()=>{
      const {page,context}=await publicFixture(browser,'<main>'+currentUser+approvalCard()+'</main>');
      await page.evaluate(()=>{window.removeCard=false;});
      const result=await page.evaluate(async chat=>CLWPageMonitorPage.approveMcpTool(chat,(await CLWPageMonitorPage.inspect()).snapshot.user_key),chat);
      assert.equal(result.state,'completed');assert.equal(result.result.clicked,true);assert.equal(result.result.card_disappeared,false);
      assert.equal(await page.evaluate(()=>clicks),1);await context.close();
    });
  }finally{await browser.close();}
});
