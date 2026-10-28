import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker, inspectOwnedLauncherEffort, waitForOperationalChatGptViewport, operateOwnedLauncherToolConfirmation, resolveChatGptToolConfirmation, recoverChatGptInvalidConversationBody } from "../src/adapters/chatgpt-web/browser-worker";
import { activateChatGptEffortMenu, detectChatGptAccountCapabilities, CHATGPT_COMPOSER_SELECTOR, CHATGPT_EFFORT_CONTROL_SELECTOR } from "../src/chatgpt-session";
import { selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('body failure with adjacent retry text and hidden duplicate recovers without a send',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true,args:['--disable-gpu']});
  try{
    const page=await browser.newPage();let loads=0;
    await page.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:++loads===1?
      '<aside role="alert">Invalid conversation body<button>重试</button></aside><aside role="alert" hidden>Invalid conversation body<button>Retry</button></aside>':'<p>Recovered</p>'}));
    await page.goto('https://chatgpt.com/c/owned-fixture');
    const text=await page.locator('[role="alert"]').first().textContent();
    expect(text).toBe('Invalid conversation body重试');
    expect(/^Invalid conversation body(?:\s|$)/i.test(text!)).toBe(false);
    const recovery={reloaded:false};
    expect(await recoverChatGptInvalidConversationBody(page,recovery)).toBe(true);
    expect(await recoverChatGptInvalidConversationBody(page,recovery)).toBe(false);
    expect(loads).toBe(2);
  }finally{await browser.close();}
},30_000);

test('owned invalid conversation body reloads only the original URL once and never sends',async()=>{
  let visible=true,reloads=0;
  const locator:any={filter:()=>locator,last:()=>locator,isVisible:async()=>visible};
  const page:any={locator:()=>locator,url:()=> 'https://chatgpt.com/c/owned-original',
    reload:async()=>{reloads++;visible=false;}};
  const state={reloaded:false};
  expect(await recoverChatGptInvalidConversationBody(page,state)).toBe(true);
  expect(await recoverChatGptInvalidConversationBody(page,state)).toBe(false);
  visible=true;
  await expect(recoverChatGptInvalidConversationBody(page,state)).rejects.toThrow('original message was not resent');
  expect(reloads).toBe(1);
});

test('uncertain reload cannot be replayed and unrelated URLs are not reloaded',async()=>{
  const locator:any={filter:()=>locator,last:()=>locator,isVisible:async()=>true};
  let reloads=0;const page:any={locator:()=>locator,url:()=> 'https://chatgpt.com/c/owned-original',
    reload:async()=>{reloads++;throw Error('lost reload receipt');}};
  const state={reloaded:false};
  await expect(recoverChatGptInvalidConversationBody(page,state)).rejects.toThrow('lost reload receipt');
  await expect(recoverChatGptInvalidConversationBody(page,state)).rejects.toThrow('original message was not resent');
  page.url=()=> 'https://chatgpt.com/';
  await expect(recoverChatGptInvalidConversationBody(page,{reloaded:false})).rejects.toThrow('Original conversation URL unavailable');
  expect(reloads).toBe(1);
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("owned acquisition reads the real viewport without an SDK waiter and still waits for a minimum size", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 120, height: 100 } });
    page.waitForFunction = async () => { throw new Error("Retained SDK utility-world waiter is unavailable"); };
    let settled = false;
    const ready = waitForOperationalChatGptViewport(page).then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 100));expect(settled).toBe(false);
    await page.setViewportSize({ width: 800, height: 600 });await ready;expect(settled).toBe(true);
    await page.setViewportSize({ width: 120, height: 100 });
    const abort = new AbortController();const blocked = waitForOperationalChatGptViewport(page, abort.signal);
    abort.abort();await expect(blocked).rejects.toThrow("acquisition aborted");
    expect(await page.evaluate(() => document.querySelectorAll('[data-user-message-bubble]').length)).toBe(0);
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher attaches the whole transport after a connector when coordinate input is unavailable", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<form><div id="prompt-textarea" contenteditable="true" role="textbox"><span app-mention-path="app://fixture" app-mention-display-name="Local-MCP-A" contenteditable="false">Local-MCP-A</span></div></form><input id="foreign">');
    const composer = page.locator('#prompt-textarea');
    composer.focus = async () => { throw new Error("Coordinate focus unavailable"); };
    composer.press = async () => { throw new Error("Background keyboard unavailable"); };
    composer.evaluate = async () => { throw new Error("Background element-handle evaluation unavailable"); };
    await page.locator('#foreign').focus();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.config = { browserHost: 'launcher', appName: 'Local-MCP-A' };
    worker.activeComposer = async () => composer;
    worker.selectConnector = async () => composer;
    const prompt = '完整原生任务\n\n' + JSON.stringify({ text: '中文  spacing\n`literal` <tag> $()', values: [1, 2, 3] }).repeat(1200);
    await worker.attachPrompt(page, prompt, true);
    const observed = await worker.attachedPromptText(page);
    expect(worker.promptTextEquivalent(prompt, observed)).toBe(true);
    expect(await composer.locator('[app-mention-display-name="Local-MCP-A"]').count()).toBe(1);
    expect(await page.locator('#foreign').inputValue()).toBe('');
    expect(await page.locator('[data-message-author-role=user]').count()).toBe(0);
    await page.close();
  } finally { await browser.close(); }
}, 60_000);

const nativeSendFixture = `<form id="owned"><div id="prompt-textarea" contenteditable="true" role="textbox"><span app-mention-path="app://fixture" app-mention-display-name="Local-MCP-A" contenteditable="false">Local-MCP-A</span></div>
  <button id="effort" type="button" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" aria-haspopup="menu" aria-expanded="false" aria-controls="picker">Pro</button>
  <button type="submit" id="send">Send</button></form><form id="foreign"><button type="submit">Foreign Send</button></form>
  <div role="menu" id="picker" aria-labelledby="effort" hidden><button type="button" role="menuitemradio" aria-checked="true">Latest</button>
  <div role="menuitem" aria-describedby="family"><div data-model-picker-power-slider style="width:250px;height:30px"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="4"></span></div></div></div>
  <div id="family">6 Pro，第 5 项，共 5 项。</div><script>
  window.ownSends=0;window.foreignSends=0;window.sentHtml='';
  document.querySelector('#owned').onsubmit=event=>{event.preventDefault();window.ownSends++;window.sentHtml=document.querySelector('#prompt-textarea').innerHTML};
  document.querySelector('#foreign').onsubmit=event=>{event.preventDefault();window.foreignSends++};
  document.querySelector('#effort').onpointerdown=()=>{document.querySelector('#picker').hidden=false;document.querySelector('#effort').setAttribute('aria-expanded','true')};
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){document.querySelector('#picker').hidden=true;document.querySelector('#effort').setAttribute('aria-expanded','false')}});
  </script>`;

const ownedPickerSelectionFixture = `<form id="owned"><div id="prompt-textarea" contenteditable="true">Saved whole task</div>
  <button id="effort" type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Instant</button>
  <button type="submit">Send</button></form>
  <div role="menu" id="foreign-picker"><div data-model-picker-power-slider style="width:200px;height:30px"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="4"></span></div></div>
  <div role="menu" id="picker" aria-labelledby="effort" hidden style="opacity:0">
    <div id="view" data-model-picker-view="simple"><button type="button" data-model-picker-view-toggle="true" aria-hidden="false">Models</button>
      <div id="rows" hidden><button type="button" role="menuitemradio" aria-checked="false">最新</button><button type="button" role="menuitemradio" aria-checked="true">GPT-5.6 Sol</button></div>
      <div role="menuitem" tabindex="-1" aria-describedby="announcement"><div id="range" data-model-picker-power-slider style="width:250px;height:30px"></div></div></div></div>
  <div id="announcement"></div><script>(()=>{
    window.pickerScenario='normal';window.value=0;window.max=4;window.family='5.6';window.opens=0;window.sends=0;window.keys=[];
    const control=document.querySelector('#effort'),menu=document.querySelector('#picker'),range=document.querySelector('#range');
    function render(ticks=window.max+1){
      range.innerHTML='<span data-orientation="horizontal" aria-disabled="false">'
        +Array.from({length:ticks},(_,i)=>'<span data-selected="'+(i<=window.value)+'"'+(window.pickerScenario==='locked'&&window.opens>1&&i===4?' data-locked="true"':'')+'></span>').join('')
        +'<span role="slider" aria-hidden="true" style="width:0;height:0" aria-valuemin="0" aria-valuemax="'+window.max+'" aria-valuenow="'+window.value+'"></span></span>';
      document.querySelector('#announcement').textContent=(window.family==='6'&&window.value===4?'6 Pro':window.family==='5.6'&&window.value===4?'5.6 Sol Pro':'5.6 Sol Extra High')+', item '+(window.value+1);
    }
    control.onclick=()=>{
      window.opens++;menu.hidden=false;control.setAttribute('aria-expanded','true');
      if(window.pickerScenario==='shrink'&&window.opens>1){window.max=3;window.value=Math.min(window.value,3);}
      render(window.pickerScenario==='hydrate'&&window.opens===1?4:window.max+1);
      if(window.pickerScenario==='hydrate'&&window.opens===1)setTimeout(render,100);
      if(window.pickerScenario.startsWith('container-')){
        range.removeAttribute('data-model-picker-power-slider');
        if(window.pickerScenario!=='container-absent')setTimeout(()=>{
          if(window.pickerScenario==='container-owner-changes')document.querySelector('#owned').append(document.querySelector('#effort').cloneNode(true));
          if(window.pickerScenario==='container-menu-changes')control.setAttribute('aria-controls','foreign-picker');
          if(window.pickerScenario==='container-session-expired'){const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent='Your session has expired';document.body.append(alert);}
          range.setAttribute('data-model-picker-power-slider','');
          if(window.pickerScenario==='container-duplicates')menu.append(range.cloneNode(true));
        },150);
      }
      if(window.pickerScenario==='slider-hydrate'){
        range.querySelector('[role=slider]').remove();setTimeout(render,150);
      }
    };
    document.querySelector('[data-model-picker-view-toggle]').onclick=()=>{document.querySelector('#view').setAttribute('data-model-picker-view','advanced');document.querySelector('#rows').hidden=false};
    for(const row of document.querySelectorAll('#rows [role=menuitemradio]'))row.onclick=()=>{
      for(const item of document.querySelectorAll('#rows [role=menuitemradio]'))item.setAttribute('aria-checked',String(item===row));
      window.family=row.textContent==='最新'?'6':'5.6';menu.hidden=true;control.setAttribute('aria-expanded','false');render();
    };
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'){
        menu.hidden=true;control.setAttribute('aria-expanded','false');control.textContent=['Instant','Medium','High','Extra High','Pro'][window.value];
        if(window.pickerScenario==='family-changes')window.family='5.6';
      }else if(event.key==='ArrowRight'||event.key==='ArrowLeft'){
        window.keys.push(event.key);window.value+=event.key==='ArrowRight'?1:-1;render();event.preventDefault();
      }
    });
    document.querySelector('#owned').onsubmit=event=>{event.preventDefault();window.sends++};render();
  })();</script>`;

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher waits for the post-navigation viewport before opening the owned Pro picker", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 120, height: 100 } });
    await page.setContent(ownedPickerSelectionFixture);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;worker.config = { browserHost: 'launcher' };
    let settled = false;
    const selection = worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, 'max',
      { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true }, undefined, true, '6')
      .finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    expect(await page.evaluate(() => (window as any).opens)).toBe(0);
    await page.setViewportSize({ width: 800, height: 600 });
    const mode = await selection;
    expect(mode.selection.label).toBe('Pro');expect(mode.uiEffortIndex).toBe(4);
    expect(await page.evaluate(() => (window as any).sends)).toBe(0);
    expect(await page.evaluate(() => document.querySelector('#prompt-textarea')!.textContent)).toBe('Saved whole task');
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher selects and retains the owned Latest Pro picker without Locator handles or background keyboard", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();await page.setContent(ownedPickerSelectionFixture);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;worker.config = { browserHost: 'launcher' };
    page.locator = () => { throw new Error("Picker Locator handle resolution is unavailable"); };
    page.keyboard.press = async () => { throw new Error("Background keyboard unavailable"); };
    worker.activeComposer = async () => { throw new Error("Background composer handle unavailable"); };
    const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
    const mode = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, 'max', capabilities, undefined, true, '6');
    expect(mode.selection.label).toBe('Pro');expect(mode.modelFamily).toBe('6');expect(mode.usageModel).toBe('gpt-6-pro');
    const keys = await page.evaluate(() => (window as any).keys.length);
    expect(keys).toBe(4);
    await worker.assertSelectedEffort(page, mode);
    // The retained summary enters the same selection method with the same model.
    await page.evaluate(() => (document.querySelector('#effort') as HTMLButtonElement).click());
    const retained = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, 'max', capabilities, undefined, true, '6');
    expect(retained.selection).toEqual(mode.selection);
    expect(await page.evaluate(() => (window as any).keys.length)).toBe(keys);
    expect(await page.evaluate(() => document.querySelector('#effort')!.getAttribute('aria-expanded'))).toBe('false');
    expect(await page.evaluate(() => document.querySelector('#foreign-picker [role=slider]')!.getAttribute('aria-valuenow'))).toBe('4');
    expect(await page.evaluate(() => document.querySelector('#prompt-textarea')!.textContent)).toBe('Saved whole task');
    expect(await page.evaluate(() => (window as any).sends)).toBe(0);
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher waits for its menu container and slider to hydrate without sending or changing ownership", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    for (const scenario of ['container-hydrate', 'slider-hydrate']) {
      await page.setContent(ownedPickerSelectionFixture);
      await page.evaluate(scenario => { (window as any).pickerScenario=scenario; }, scenario);
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;worker.config = { browserHost:'launcher' };
      page.locator=()=>{throw new Error('No background picker handles');};
      page.keyboard.press=async()=>{throw new Error('No background keyboard');};
      const mode=await worker.selectModelAndEffort(page,CHATGPT_WEB_MODEL_ID,'max',
        {localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true},undefined,true,'6');
      await worker.assertSelectedEffort(page,mode);
      expect(mode.uiEffortIndex).toBe(4);expect(mode.usageModel).toBe('gpt-6-pro');
      expect(await page.evaluate(()=>(window as any).sends)).toBe(0);
      expect(await page.evaluate(()=>document.querySelector('#prompt-textarea')!.textContent)).toBe('Saved whole task');
      expect(await page.evaluate(()=>document.querySelector('#foreign-picker [role=slider]')!.getAttribute('aria-valuenow'))).toBe('4');
      expect(await page.evaluate(()=>document.querySelector('#effort')!.getAttribute('aria-expanded'))).toBe('false');
    }
  } finally { await browser.close(); }
},60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher container wait retains its deadline, unique owner, menu and account guards",async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
  try {
    const page=await browser.newPage();
    for(const scenario of ['container-absent','container-duplicates','container-owner-changes','container-menu-changes','container-session-expired']){
      await page.setContent(ownedPickerSelectionFixture);
      await page.evaluate(scenario=>{(window as any).pickerScenario=scenario;},scenario);
      const worker=Object.create(ChatGptBrowserWorker.prototype) as any;worker.config={browserHost:'launcher'};
      const started=Date.now();let failure;
      try{await worker.selectModelAndEffort(page,CHATGPT_WEB_MODEL_ID,'max',
        {localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true},undefined,false,'6');}
      catch(error){failure=error;}
      expect(failure).toBeDefined();
      if(scenario==='container-absent')expect(Date.now()-started).toBeLessThan(2_500);
      if(scenario==='container-session-expired')expect(failure).toMatchObject({code:'chatgpt_session_expired',status:401});
      else expect(failure).toMatchObject({retryable:false});
      expect(await page.evaluate(()=>(window as any).sends)).toBe(0);
      expect(await page.evaluate(()=>(window as any).keys.length)).toBe(0);
      expect(await page.evaluate(()=>document.querySelector('#prompt-textarea')!.textContent)).toBe('Saved whole task');
    }
  }finally{await browser.close();}
},60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher picker preserves hydration, unavailable Pro, locks, ownership and changed-family failures", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
    for (const scenario of ['hydrate', 'shrink', 'locked', 'duplicate-container', 'duplicate-owner', 'family-changes', 'session-expired', 'subscription-failed', 'rate-limited']) {
      await page.setContent(ownedPickerSelectionFixture);
      await page.evaluate(scenario => {
        const scope = window as any;scope.pickerScenario=scenario;
        if (scenario !== 'family-changes') {
          scope.family='6';document.querySelector('#rows [role=menuitemradio]')!.setAttribute('aria-checked','true');
          document.querySelectorAll('#rows [role=menuitemradio]')[1]!.setAttribute('aria-checked','false');
        }
        if (scenario === 'duplicate-container') document.querySelector('#picker')!.append(document.querySelector('#range')!.cloneNode(true));
        if (scenario === 'duplicate-owner') document.body.append(document.querySelector('#owned')!.cloneNode(true));
        if (['session-expired','subscription-failed','rate-limited'].includes(scenario)) {
          const notice=document.createElement('div');notice.setAttribute('role',scenario==='rate-limited'?'dialog':'alert');
          notice.textContent=scenario==='session-expired'?'Your session has expired':scenario==='subscription-failed'?'Failed to load subscription':'Too many requests. You are making requests too quickly.';document.body.append(notice);
        }
      }, scenario);
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;worker.config = { browserHost: 'launcher' };
      let result, failure;
      try { result = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, 'max', capabilities, undefined, false, '6'); }
      catch (error) { failure = error; }
      if (scenario === 'hydrate') { expect(failure).toBeUndefined();expect(result.selection.label).toBe('Pro'); }
      else {
        expect(failure).toBeDefined();
        if (scenario === 'locked') expect(failure).toMatchObject({ code: 'chatgpt_effort_locked', retryable: false });
        else if (scenario === 'session-expired') expect(failure).toMatchObject({ code: 'chatgpt_session_expired', status: 401 });
        else if (scenario === 'subscription-failed') expect(failure).toMatchObject({ code: 'chatgpt_subscription_unavailable', status: 503 });
        else if (scenario === 'rate-limited') expect(failure).toMatchObject({ code: 'rate_limit_exceeded', status: 429 });
        else expect(failure).toMatchObject({ retryable: false });
      }
      expect(await page.evaluate(() => (window as any).sends)).toBe(0);
      expect(await page.evaluate(() => document.querySelector('#prompt-textarea')!.textContent)).toBe('Saved whole task');
    }
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher waits for the original empty control to hydrate before selecting and retains the full task", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();await page.setContent(ownedPickerSelectionFixture);
    await page.evaluate(() => {
      const control = document.querySelector('#effort')!;control.remove();
      setTimeout(() => document.querySelector('#owned')!.append(control), 150);
    });
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;worker.config = { browserHost: 'launcher' };
    page.locator = () => { throw new Error("Background picker handles must not be resolved"); };
    page.keyboard.press = async () => { throw new Error("Background keyboard must not be used"); };
    const mode = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, 'max',
      { localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true }, undefined, true, '6');
    expect(mode.modelFamily).toBe('6');expect(mode.uiEffortIndex).toBe(4);expect(mode.usageModel).toBe('gpt-6-pro');
    await worker.assertSelectedEffort(page,mode);
    expect(await page.evaluate(() => document.querySelector('#prompt-textarea')!.textContent)).toBe('Saved whole task');
    expect(await page.evaluate(() => (window as any).sends)).toBe(0);
    expect(await page.evaluate(() => document.querySelector('#foreign-picker [role=slider]')!.getAttribute('aria-valuenow'))).toBe('4');
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher readiness distinguishes absence from duplicates, changed owner and public account failures", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    for (const scenario of ['absent','duplicate','owner-changes','session-expired','subscription-failed','rate-limited']) {
      await page.setContent(ownedPickerSelectionFixture);
      await page.evaluate(scenario => {
        const control=document.querySelector('#effort')!;control.remove();
        setTimeout(() => {
          if(scenario==='duplicate')document.querySelector('#owned')!.append(control,control.cloneNode(true));
          else if(scenario==='owner-changes')document.querySelector('#prompt-textarea')!.replaceWith(document.querySelector('#prompt-textarea')!.cloneNode(true));
          else if(scenario!=='absent') {
            const notice=document.createElement('div');notice.setAttribute('role',scenario==='rate-limited'?'dialog':'alert');
            notice.textContent=scenario==='session-expired'?'Your session has expired':scenario==='subscription-failed'?'Failed to load subscription':'Too many requests. You are making requests too quickly.';
            document.body.append(notice);
          }
        },100);
      },scenario);
      await expect(page.evaluate(inspectOwnedLauncherEffort,{composerSelector:CHATGPT_COMPOSER_SELECTOR,
        controlSelector:CHATGPT_EFFORT_CONTROL_SELECTOR,verifyFamily:true,select:{effortIndex:4,modelFamily:'6'},readinessTimeoutMs:350}))
        .rejects.toThrow(scenario==='absent'?'did not become ready':scenario==='duplicate'?'not unique':scenario==='owner-changes'?'composer changed':
          scenario==='session-expired'?'session_expired':scenario==='subscription-failed'?'subscription_unavailable':'rate_limited');
      expect(await page.evaluate(() => (window as any).sends)).toBe(0);
      expect(await page.evaluate(() => (window as any).opens)).toBe(0);
      expect(await page.evaluate(() => document.querySelector('#prompt-textarea')!.textContent)).toBe('Saved whole task');
    }
  } finally { await browser.close(); }
},60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher confirms Send and binds its assistant without hidden availability locators", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();await page.setContent(nativeSendFixture);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.config = { browserHost: 'launcher', appName: 'Local-MCP-A' };
    const prompt = '完整任务\n逐字保留\n' + '中文 `literal` <tag> $()  spacing\n'.repeat(2000);
    await page.evaluate(text => {
      const editor = document.querySelector('#prompt-textarea')!;
      editor.append(document.createTextNode(' '+text));
      document.querySelector('#owned')!.addEventListener('submit', () => setTimeout(() => {
        const group = document.createElement('div');group.setAttribute('data-turn-key','accepted');
        const user = document.createElement('div');user.setAttribute('data-user-message-bubble','');user.textContent=text;
        const assistant = document.createElement('div');assistant.setAttribute('data-conversation-role','assistant');
        group.append(user,assistant);document.body.append(group);
      }, 2_000));
    }, prompt);
    const baseline = await worker.captureSubmissionBaseline(page, prompt);
    const locator = page.locator.bind(page);
    page.locator = (...args: Parameters<typeof page.locator>) => {
      if (args[0].includes('role="alert"') || args[0].includes('role="dialog"')) throw new Error('Hidden availability Locator must not delay acknowledgement');
      return locator(...args);
    };
    const order: string[] = [];
    const started = Date.now();
    const evidence = await worker.sendAttachedPrompt(page,baseline,undefined,undefined,undefined,{
      onSendActivated: async () => { order.push('activated'); },onSubmitted: async () => { order.push('submitted'); },
    },undefined,undefined,{ traceId: 'whole-native-send', activationTimeoutMs: 1_000, confirmationTimeoutMs: 5_000 });
    expect(Date.now() - started).toBeGreaterThan(1_000);
    expect(evidence).toBe('user_turn');expect(order).toEqual(['activated','submitted']);
    expect(baseline.acceptedUserIdentity).toBe('group:user:accepted');
    const assistant = await worker.waitForNewAssistantTurn(page,baseline,Date.now()+20000);
    expect(assistant.identity).toBe('group:assistant:accepted');
    expect(await page.evaluate(() => (window as any).ownSends)).toBe(1);
    expect(await page.evaluate(() => (window as any).foreignSends)).toBe(0);
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher checks live session and rate failures before reusing a cached turn snapshot", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    for (const [role,text,status,code,retryable] of [
      ['alert','Your session has expired',401,'chatgpt_session_expired',false],
      ['alert','Failed to load subscription',503,'chatgpt_subscription_unavailable',true],
      ['dialog','Too many requests. You are making requests too quickly.',429,'rate_limit_exceeded',false],
    ] as const) {
      await page.setContent(`<style id="visibility">#notice{display:none}</style><div id="notice" role="${role}">${text}</div><div data-turn-key="accepted"><div data-user-message-bubble>Task</div></div>`);
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;worker.config = { browserHost: 'launcher' };
      const cache: any = {};
      expect((await worker.submissionDomState(page,cache)).userIdentities).toEqual(['group:user:accepted']);
      const revision = cache.key;
      // CSSOM changes visibility without changing DOM attributes or text.
      await page.evaluate(() => { (document.querySelector('#visibility') as HTMLStyleElement).sheet!.insertRule('#notice{display:block}',1); });
      await expect(worker.submissionDomState(page,cache)).rejects.toMatchObject({ status,code,retryable });
      expect(cache.key).toBe(revision);expect(cache.fullScans).toBe(1);
    }
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher verifies Latest Pro and sends one whole transport without hidden keyboard or element handles", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();await page.setContent(nativeSendFixture);
    page.keyboard.press = async () => { throw new Error("Background keyboard unavailable"); };
    const composer = page.locator('#prompt-textarea');
    composer.focus = composer.press = composer.evaluate = async () => { throw new Error("Background element handle unavailable"); };
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.config = { browserHost: 'launcher', appName: 'Local-MCP-A' };
    worker.activeComposer = async () => composer;worker.selectConnector = async () => composer;
    const prompt = '原生完整业务包\n' + JSON.stringify({ text: '中文  spacing\n`literal` <tag> $()', values: [1, 2, 3] }).repeat(1200);
    await worker.attachPrompt(page, prompt, true);
    expect(worker.promptTextEquivalent(prompt, await worker.attachedPromptText(page))).toBe(true);
    const attachedHtml = await page.evaluate(() => document.querySelector('#prompt-textarea')!.innerHTML);
    const mode = { selection: { url: page.url(), label: 'Pro' }, modelFamily: '6', uiEffortIndex: 4, effort: 'max' };
    const order: string[] = [];
    worker.waitForSubmissionAcceptedWithRecovery = async () => {
      const observed = await page.evaluate(() => (window as any).ownSends);
      expect(observed).toBe(1);order.push('observed');return 'user_turn';
    };
    const baseline = { submittedText: prompt };
    expect(await worker.sendAttachedPrompt(page, baseline, undefined, undefined, undefined, {
      onSendActivated: async () => { await worker.assertSelectedEffort(page, mode);order.push('activated'); },
      onSubmitted: async () => { order.push('submitted'); },
    })).toBe('user_turn');
    expect(order).toEqual(['activated', 'observed', 'submitted']);
    expect(await page.evaluate(() => (window as any).foreignSends)).toBe(0);
    expect(await page.evaluate(() => (window as any).sentHtml)).toBe(attachedHtml);
    expect(await page.locator('#effort').getAttribute('aria-expanded')).toBe('false');
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("launcher retains disabled, duplicate, changed prompt, changed family and uncertain submission guards", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    for (const scenario of ['disabled', 'duplicate', 'prompt-change', 'family-change', 'effort-change', 'session-expired', 'subscription-failed', 'rate-limited', 'unknown']) {
      await page.setContent(nativeSendFixture);
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      worker.config = { browserHost: 'launcher', appName: 'Local-MCP-A' };
      const prompt = '原始完整任务';
      await page.evaluate(text => { document.querySelector('#prompt-textarea')!.append(document.createTextNode(' '+text)); }, prompt);
      await page.evaluate(scenario => {
        if (scenario === 'disabled') (document.querySelector('#send') as HTMLButtonElement).disabled = true;
        if (scenario === 'duplicate') document.querySelector('#owned')!.append(document.querySelector('#send')!.cloneNode(true));
        if (scenario === 'family-change') document.querySelector('#family')!.textContent = '5.6 Sol Pro，第 5 项，共 5 项。';
        if (scenario === 'effort-change') document.querySelector('[role=slider]')!.setAttribute('aria-valuenow', '3');
        if (scenario === 'session-expired' || scenario === 'subscription-failed' || scenario === 'rate-limited') {
          const notice = document.createElement('div');notice.setAttribute('role', scenario === 'rate-limited' ? 'dialog' : 'alert');
          notice.textContent = scenario === 'session-expired' ? 'Your session has expired' : scenario === 'subscription-failed' ? 'Failed to load subscription' : 'Too many requests. You are making requests too quickly.';
          document.body.append(notice);
        }
      }, scenario);
      const mode = { selection: { url: page.url(), label: 'Pro' }, modelFamily: '6', uiEffortIndex: 4, effort: 'max' };
      let submitted = false;
      worker.waitForSubmissionAcceptedWithRecovery = async () => { throw new Error('Original submission observation is uncertain'); };
      let failure: unknown;
      try {
        await worker.sendAttachedPrompt(page, { submittedText: prompt }, undefined, undefined, undefined, {
          onSendActivated: async () => {
            await worker.assertSelectedEffort(page, mode);
            if (scenario === 'prompt-change') await page.evaluate(() => { document.querySelector('#prompt-textarea')!.append(document.createTextNode(' changed')); });
          }, onSubmitted: async () => { submitted = true; },
        });
      } catch (error) { failure = error; }
      expect(failure).toBeDefined();expect(submitted).toBe(false);
      if (scenario === 'session-expired') expect(failure).toMatchObject({ status: 401, code: 'chatgpt_session_expired' });
      if (scenario === 'subscription-failed') expect(failure).toMatchObject({ status: 503, code: 'chatgpt_subscription_unavailable' });
      if (scenario === 'rate-limited') expect(failure).toMatchObject({ status: 429, code: 'rate_limit_exceeded' });
      expect(await page.evaluate(() => (window as any).ownSends)).toBe(scenario === 'unknown' ? 1 : 0);
      expect(await page.evaluate(() => (window as any).foreignSends)).toBe(0);
      if (scenario === 'family-change' || scenario === 'effort-change') expect(await page.locator('#effort').getAttribute('aria-expanded')).toBe('false');
    }
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("public DOM input opens the owned picker and verifies family after a collapsed choice", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox"></div>
      <button id="effort" type="button" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" aria-haspopup="menu" aria-expanded="false">Pro</button></form>
      <div role="menu" id="other-menu" aria-labelledby="other-control">Unrelated menu</div>
      <div role="menu" id="picker" aria-labelledby="effort" hidden>
        <div data-model-picker-view="simple"><button type="button" data-model-picker-view-toggle="true" aria-hidden="false">Show models</button>
          <div id="models" hidden><button type="button" role="menuitemradio" aria-checked="false">Latest</button><button type="button" role="menuitemradio" aria-checked="true">GPT-5.6 Sol</button></div>
          <div data-model-picker-power-slider style="width:200px;height:30px"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="4"></span></div></div></div>
      <script>
        const control=document.querySelector('#effort'),menu=document.querySelector('#picker'),view=document.querySelector('[data-model-picker-view]');
        control.addEventListener('pointerdown',()=>{menu.hidden=false;control.setAttribute('aria-expanded','true')});
        document.querySelector('[data-model-picker-view-toggle]').onclick=()=>{view.setAttribute('data-model-picker-view','advanced');document.querySelector('#models').hidden=false};
        for(const row of document.querySelectorAll('[role=menuitemradio]'))row.onclick=()=>{for(const r of document.querySelectorAll('[role=menuitemradio]'))r.setAttribute('aria-checked',String(r===row));menu.hidden=true;control.setAttribute('aria-expanded','false')};
        document.addEventListener('keydown',event=>{if(event.key==='Escape'){menu.hidden=true;control.setAttribute('aria-expanded','false')}});
      </script>`);
    const control = page.locator('form[data-chatgpt-composer] #effort');
    control.click = async () => { throw new Error("Coordinate input is unavailable in this renderer"); };
    const reopen = () => activateChatGptEffortMenu(page, control);
    const opened = await reopen();
    expect(await opened.menu.getAttribute('id')).toBe('picker');
    const selected = await selectChatGptModelFamily(page, opened, '6', reopen);
    expect(await selected.menu.getByRole('menuitemradio', { name: 'Latest', exact: true }).getAttribute('aria-checked')).toBe('true');
    expect(await selected.menu.getByRole('menuitemradio', { name: 'GPT-5.6 Sol', exact: true }).getAttribute('aria-checked')).toBe('false');
    expect(await page.locator('[data-composer-markdown]').innerText()).toBe('');
    await page.close();
  } finally { await browser.close(); }
}, 60_000);

for (const scenario of ["hydrate", "shrink", "locked", "pro-disappears"])
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`real slider ${scenario} keeps the requested available effort`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Draft</div>
      <button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Instant</button></form>
      <div id="picker" role="menu" hidden><div role="menuitem" tabindex="0"><div data-model-picker-power-slider style="height:30px;width:250px"></div></div></div>
      <script>
        let value=0, max=4, opens=0;
        const scenario=${JSON.stringify(scenario)}, control=document.querySelector('button'), menu=document.querySelector('#picker');
        function render(ticks=max+1) {
          document.querySelector('[data-model-picker-power-slider]').innerHTML='<span data-orientation="horizontal" aria-disabled="false">'
            +Array.from({length:ticks},(_,i)=>'<span data-selected="'+(i<=value)+'"'+(scenario==='locked'&&opens>1&&i===2?' data-locked="true"':'')+'></span>').join('')
            +'<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="'+max+'" aria-valuenow="'+value+'"></span></span>';
        }
        control.onclick=()=>{
          opens++; menu.hidden=false; control.setAttribute('aria-expanded','true');
          if(opens>1&&(scenario==='shrink'||scenario==='pro-disappears'))max=3;
          value=Math.min(value,max); render(scenario==='hydrate'&&opens===1?4:max+1);
          if(scenario==='hydrate'&&opens===1)setTimeout(()=>{max=3;render()},100);
        };
        document.addEventListener('keydown',e=>{
          if(e.key==='Escape'){menu.hidden=true;control.setAttribute('aria-expanded','false');control.textContent=['Instant','Medium','High','Extra High','Pro'][value];}
          else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){value+=e.key==='ArrowRight'?1:-1;render();e.preventDefault();}
        });
        render();
      </script>`);
    if (scenario === "hydrate") {
      expect(await detectChatGptAccountCapabilities(page)).toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: false });
    } else {
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const effort = scenario === "pro-disappears" ? "max" : scenario === "locked" ? "high" : "xhigh";
      const result = worker.selectModelAndEffort(page, "gpt-5.6-sol", effort, {
        localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
      });
      if (scenario === "shrink") expect((await result).selection.label).toBe("Extra High");
      else { let failure; try { await result; } catch (error) { failure=error; } expect(failure).toMatchObject({ retryable: false }); }
    }
    expect(await page.locator('#prompt-textarea').innerText()).toBe("Draft");
    await page.close();
  } finally { await browser.close(); }
}, 120_000);

// Current native MCP confirmation: its form is a sibling of the localized alert.
const nativeConfirmationFixture=(app='Local-MCP',english=false,always=true)=>`<div id="permission"><div role="alert">${app} ${english?`Allow ChatGPT to use ${app}?`:`允许 ChatGPT 使用 ${app} 吗？`} Run a native Codex command <button>查看详情</button></div><form>${always?`<button type="button" data-action="always">${english?'Always allow':'始终允许'}</button>`:''}<button type="button" data-action="deny">${english?'Deny':'拒绝'}<kbd>Esc</kbd></button><button type="button" data-action="once">${english?'Allow once':'允许一次'}<kbd>⏎</kbd></button></form></div><script>window.approvals=[];for(const b of document.querySelectorAll('[data-action]'))b.onclick=()=>{window.approvals.push(b.dataset.action);document.querySelector('#permission').remove();};</script>`;

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('owned MCP approval recognizes the localized alert and sibling form, including persistent Full access',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try{const page=await browser.newPage();
  for(const [english,always] of [[false,true],[true,true],[false,false]]){
   await page.setContent(nativeConfirmationFixture('Local-MCP',english,always));
   const observed=await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP'});
   expect(observed.visible).toBe(true);expect(observed.activated).toBe(false);
   const result=await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP',approve:true,expectedSignature:observed.signature});
   expect(result.activated).toBe(true);expect(await page.evaluate(()=>(window as any).approvals)).toEqual([always?'always':'once']);
   expect((await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP'})).visible).toBe(false);
  }
 }finally{await browser.close();}
},60000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('owned MCP approval handles multiple cards and changed state without interrupting the turn',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try{const page=await browser.newPage();
  await page.setContent(nativeConfirmationFixture('Unrelated-App'));
  expect((await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP',approve:true})).visible).toBe(false);
  expect(await page.evaluate(()=>(window as any).approvals)).toEqual([]);
  await page.setContent(nativeConfirmationFixture()+nativeConfirmationFixture());
  expect((await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP'})).remaining).toBe(2);
  for(let index=0;index<2;index++){const card=await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP'});expect((await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP',approve:true,expectedSignature:card.signature})).activated).toBe(true);}
  expect((await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP'})).visible).toBe(false);
  await page.setContent(nativeConfirmationFixture());
  const before=await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP'});
  await page.evaluate(()=>document.querySelector('[role=alert]')!.append(document.createTextNode(' changed request')));
  expect((await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP',approve:true,expectedSignature:before.signature})).changed).toBe(true);
  expect(await page.evaluate(()=>(window as any).approvals)).toEqual([]);
  await page.setContent(nativeConfirmationFixture());
  await page.evaluate(()=>{(document.querySelector('[data-action=always]') as HTMLButtonElement).disabled=true;});
  const disabled=await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP'});
  expect((await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP',approve:true,expectedSignature:disabled.signature})).activated).toBe(true);
  expect(await page.evaluate(()=>(window as any).approvals)).toEqual(['once']);
  await page.setContent('<div role="alert">允许 ChatGPT 使用 Local-MCP 吗？</div><form><button onclick="window.foreign=true">始终允许</button></form>');
  expect((await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP',approve:true})).visible).toBe(false);
 }finally{await browser.close();}
},60000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('native automatic confirmation uses public DOM while manual timeout and abort never deny the pending card',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try{const page=await browser.newPage();page.locator=()=>{throw Error('Background Locator is unavailable');};
  await page.setContent(nativeConfirmationFixture());
  expect(await resolveChatGptToolConfirmation(page,'Local-MCP',true,undefined,100,undefined,true)).toBe(true);
  expect(await page.evaluate(()=>(window as any).approvals)).toEqual(['always']);
  await page.setContent(nativeConfirmationFixture());
  expect(await resolveChatGptToolConfirmation(page,'Local-MCP',false,undefined,10,undefined,true)).toBe(true);
  expect(await page.evaluate(()=>(window as any).approvals)).toEqual([]);
  const controller=new AbortController();
  await expect(resolveChatGptToolConfirmation(page,'Local-MCP',true,controller.signal,100,async()=>controller.abort(),true)).rejects.toThrow('aborted');
  expect(await page.evaluate(()=>(window as any).approvals)).toEqual([]);
 }finally{await browser.close();}
},60000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('first native MCP confirmation is approved before submission acknowledgement or assistant mounting can wait on it',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try{const page=await browser.newPage();
  const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
  worker.config={browserHost:'launcher',appName:'Local-MCP',autoApproveToolCalls:true};
  worker.waitForTurnDomOrExternalProgress=async()=>{throw Error('An unresolved first approval must not reach the observation wait');};
  await page.setContent(nativeConfirmationFixture());
  worker.currentSubmissionEvidence=async()=>await page.evaluate(()=>(window as any).approvals.length)?'user_turn':undefined;
  expect(await worker.waitForSubmissionAccepted(page,{})).toBe('user_turn');
  expect(await page.evaluate(()=>(window as any).approvals)).toEqual(['always']);
  await page.setContent(nativeConfirmationFixture());
  worker.rememberSubmittedUserIdentity=async()=>true;
  worker.submissionDomState=async()=>({responseIdentities:await page.evaluate(()=>(window as any).approvals.length)?['group:assistant:approved']:[],turnIdentities:['group:assistant:approved']});
  const result=await worker.waitForNewAssistantTurn(page,{initialTurnIdentities:[]},Date.now()+5000);
  expect(result.identity).toBe('group:assistant:approved');
  expect(await page.evaluate(()=>(window as any).approvals)).toEqual(['always']);
 }finally{await browser.close();}
},60000);


test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('loose native approval tolerates app punctuation, nested forms and positive button wording',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try{const page=await browser.newPage();
  for(const [question,button] of [['允許ChatGPT使用 LOCAL_MCP嗎?','一律允許（推薦）'],['Local MCP requests permission to run a tool','Approve all future requests'],['允许ChatGPT使用Local-MCP-B吗？','同意并不再询问']]){
   await page.setContent(`<section><div><aside role="alert">${question}</aside></div><div><form><button type="button" id="yes">${button}<kbd>Enter</kbd></button><button type="button" id="no">不允许</button></form></div></section><script>document.querySelector('#yes').onclick=()=>document.querySelector('section').remove();document.querySelector('#no').onclick=()=>window.denied=true;</script>`);
   const seen=await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP'});expect(seen.visible).toBe(true);
   expect((await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP',approve:true,expectedSignature:seen.signature})).activated).toBe(true);expect(await page.evaluate(()=>(window as any).denied)).toBeUndefined();
  }
 }finally{await browser.close();}
},60000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('loose native approval waits for an acknowledged click and ignores normal Send and Stop',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try{const page=await browser.newPage();
  await page.setContent(`<div><div role="alert">Allow ChatGPT to use Local MCP?</div><form><button type="button" id="yes">Allow all</button><button data-testid="stop-button" type="button">Stop</button><button data-testid="send-button" type="button">Confirm Send</button></form></div><script>window.count=0;document.querySelector('#yes').onclick=()=>window.count++;</script>`);
  const seen=await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP'});
  expect((await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP',approve:true,expectedSignature:seen.signature})).activated).toBe(true);
  expect((await page.evaluate(operateOwnedLauncherToolConfirmation,{appName:'Local-MCP',approve:true,expectedSignature:seen.signature})).pending).toBe(true);
  expect(await page.evaluate(()=>(window as any).count)).toBe(1);
 }finally{await browser.close();}
},60000);
