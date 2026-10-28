import {expect,test} from 'bun:test';
import {chromium,type Page} from 'playwright-core';
import {ChatGptBrowserWorker,operateOwnedLauncherComposer} from '../src/adapters/chatgpt-web/browser-worker';
import {CHATGPT_COMPOSER_SELECTOR,CHATGPT_SEND_BUTTON_SELECTOR} from '../src/chatgpt-session';
import {CHATGPT_WEB_MODEL_ID} from '../src/adapters/chatgpt-web/model';

// Mirrors the observed body portal and replaced composer subtree, rather than
// substituting selectConnector, activeComposer, or the attachment implementation.
const fixture=`<form data-chatgpt-composer id="owned"><div id="editor" data-composer-markdown contenteditable="true" role="textbox" style="width:400px;min-height:30px"></div>
 <button id="effort" type="button" data-tone="neutral" aria-haspopup="menu" aria-expanded="false" aria-controls="picker">Pro</button>
 <button type="submit" data-testid="send-button">Send</button></form>
 <form id="foreign"><input id="foreign-input" value="Other task draft"><button type="submit">Foreign Send</button>
 <div data-composer-overlay-floating-ui><div data-mention-list-scroll-area><button type="button" data-list-navigation-item="true" id="foreign-row"><span>Local-MCP</span></button></div></div></form>
 <div data-composer-overlay-floating-ui id="portal" hidden><div data-mention-list-scroll-area id="list"><button type="button" data-list-navigation-item="true" id="choice"><span>Local-MCP</span><span>Local-MCP</span></button></div></div>
 <div role="menu" id="picker" hidden><button type="button" role="menuitemradio" aria-checked="true">最新</button>
  <div role="menuitem" aria-describedby="announcement"><div data-model-picker-power-slider style="width:250px;height:30px"><span data-orientation="horizontal" aria-disabled="false">
  <span data-selected="true"></span><span data-selected="true"></span><span data-selected="true"></span><span data-selected="true"></span><span data-selected="true"></span>
  <span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="4" style="width:0;height:0"></span></span></div></div></div>
 <div id="announcement">6 Pro，第 5 项，共 5 项。</div><script>(()=>{
  window.rowClicks=0;window.foreignClicks=0;window.sends=0;window.foreignSends=0;window.scenario='normal';
  document.querySelector('#owned').onsubmit=e=>{e.preventDefault();window.sends++};document.querySelector('#foreign').onsubmit=e=>{e.preventDefault();window.foreignSends++};
  document.querySelector('#foreign-row').onclick=()=>window.foreignClicks++;
  document.addEventListener('input',e=>{if(e.target.id!=='editor')return;const show=e.target.textContent==='@Local-MCP';document.querySelector('#portal').hidden=!show;
   if(show&&window.scenario==='duplicate-menu'){const copy=document.querySelector('#portal').cloneNode(true);copy.id='duplicate';document.body.append(copy);}
  });
  document.querySelector('#choice').onclick=()=>{window.rowClicks++;const old=document.querySelector('#editor'),next=old.cloneNode(false);
   const name=window.scenario==='wrong-selection'?'Another connector':'Local-MCP';next.innerHTML='<span app-mention-path="app://fixture" app-mention-display-name="'+name+'" contenteditable="false">'+name+'</span>';
   old.replaceWith(next);next.focus();document.querySelector('#portal').hidden=true;};
  document.querySelector('#effort').onclick=()=>{document.querySelector('#picker').hidden=false;document.querySelector('#effort').setAttribute('aria-expanded','true')};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelector('#portal').hidden=true;document.querySelector('#duplicate')?.remove();document.querySelector('#picker').hidden=true;document.querySelector('#effort').setAttribute('aria-expanded','false')}});
 })();</script>`;

function workerWithoutHandles(page:Page,readinessTimeoutMs=30_000) {
 const worker=Object.create(ChatGptBrowserWorker.prototype) as any;worker.config={browserHost:'launcher',appName:'Local-MCP'};
 const active=worker.activeComposer.bind(worker);
 worker.activeComposer=(p:Page,timeout:number,signal?:AbortSignal)=>active(p,Math.min(timeout,readinessTimeoutMs),signal);
 const locator=page.locator.bind(page),guard=(value:any):any=>new Proxy(value,{get(target,key){
  if(['fill','focus','press','pressSequentially','evaluate','evaluateAll','count','waitFor','allInnerTexts'].includes(String(key)))return async()=>{throw Error('Background Locator operation unavailable: '+String(key))};
  if(['filter','first','locator'].includes(String(key)))return (...args:any[])=>guard(target[key](...args));
  const result=target[key];return typeof result==='function'?result.bind(target):result;
 }});
 page.locator=((...args:any[])=>guard((locator as any)(...args))) as any;
 page.keyboard.press=async()=>{throw Error('Background keyboard unavailable')};
 return worker;
}
async function snapshot(page:Page) {
 return page.evaluate(()=>({text:document.querySelector('#editor')?.textContent,editorCount:document.querySelectorAll('#editor').length,
  selected:[...document.querySelectorAll('#editor [app-mention-display-name]')].map(e=>e.getAttribute('app-mention-display-name')),
  foreign:(document.querySelector('#foreign-input') as HTMLInputElement).value,
  rowClicks:(window as any).rowClicks,foreignClicks:(window as any).foreignClicks,sends:(window as any).sends,foreignSends:(window as any).foreignSends}));
}

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('launcher completes connector selection, full attachment, model guard and cleanup without background handles',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try {
  const page=await browser.newPage();await page.setContent(fixture);
  await page.evaluate(()=>document.querySelector<HTMLElement>('#foreign-input')!.focus());
  const worker=workerWithoutHandles(page),checkpoints:string[]=[];
  const capabilities={localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true};
  const mode=await worker.selectModelAndEffort(page,CHATGPT_WEB_MODEL_ID,'max',capabilities,undefined,true,'6');
  const prompt='完整任务\n\n'+JSON.stringify({text:'中文  spacing\n`literal` <tag> $()',values:[1,2,3]}).repeat(1200);
  await worker.attachPrompt(page,prompt,true,async(checkpoint:string)=>{checkpoints.push(checkpoint)});
  expect(worker.promptTextEquivalent(prompt,await worker.attachedPromptText(page))).toBeTrue();
  await worker.assertSelectedEffort(page,mode);
  const ready=await page.evaluate(operateOwnedLauncherComposer,{selector:CHATGPT_COMPOSER_SELECTOR,operation:{kind:'send-state',sendSelector:CHATGPT_SEND_BUTTON_SELECTOR}}) as any;
  expect(ready.enabled).toBeTrue();expect(ready.mentionCount).toBe(1);expect(worker.promptTextEquivalent(prompt,ready.raw.trimStart())).toBeTrue();
  expect(checkpoints).toEqual(['connector-mention-triggered','connector-menu-visible','connector-choice-activated','connector-selected']);
  const attached=await snapshot(page);expect(attached.selected).toEqual(['Local-MCP']);expect(attached.rowClicks).toBe(1);
  expect(attached.foreign).toBe('Other task draft');expect(attached.foreignClicks).toBe(0);expect(attached.sends+attached.foreignSends).toBe(0);
  await worker.clearChatGptComposerState(page);const cleared=await snapshot(page);expect(cleared.text).toBe('');expect(cleared.selected).toEqual([]);expect(cleared.foreign).toBe(attached.foreign);expect(cleared.sends).toBe(0);
 }finally{await browser.close()}
},60000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('launcher replaces an owned restored draft and attaches retained or tool-free text exactly',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try {
  const page=await browser.newPage();await page.setContent(fixture);const worker=workerWithoutHandles(page),checkpoints:string[]=[];
  await page.evaluate(()=>{document.querySelector('#editor')!.innerHTML='<span app-mention-path="app://fixture" app-mention-display-name="Local-MCP" contenteditable="false">Local-MCP</span>Restored other task text';});
  await worker.attachPrompt(page,'New whole task\nwith literal `code`',true,async(c:string)=>{checkpoints.push(c)});
  expect(checkpoints[0]).toBe('restored-draft-before-attachment');expect(await worker.attachedPromptText(page)).toBe('New whole task\nwith literal `code`');
  const clicks=(await snapshot(page)).rowClicks;
  await worker.attachPrompt(page,'Retained read-only summary\nSecond paragraph',true,undefined,undefined,false,undefined,true);
  expect(await worker.attachedPromptText(page)).toBe('Retained read-only summary\nSecond paragraph');expect((await snapshot(page)).selected).toEqual([]);
  await worker.attachPrompt(page,'Tool-free multipart with `literal`\n尾部',false);
  expect(await worker.attachedPromptText(page)).toBe('Tool-free multipart with `literal`\n尾部');
  const after=await snapshot(page);expect(after.rowClicks).toBe(clicks);expect(after.foreign).toBe('Other task draft');expect(after.sends+after.foreignSends).toBe(0);
 }finally{await browser.close()}
},60000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('launcher refuses duplicate menus, disabled rows, changed queries and wrong selections before Send',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try {
  // Exercise the actual count loop with a short fixture budget for permanent
  // duplicate editors; the other four rejection scenarios share this test.
  const page=await browser.newPage();const worker=workerWithoutHandles(page,500);
  for(const scenario of ['duplicate-editor','duplicate-menu','disabled','changed-query','wrong-selection']){
   await page.setContent(fixture);await page.evaluate(s=>{(window as any).scenario=s;if(s==='disabled')(document.querySelector('#choice') as HTMLButtonElement).disabled=true;if(s==='duplicate-editor')document.body.append(document.querySelector('#owned')!.cloneNode(true))},scenario);
   await expect(worker.attachPrompt(page,'Never sent task',true,async(c:string)=>{
    if(scenario==='changed-query'&&c==='connector-menu-visible')await page.evaluate(()=>{document.querySelector('#editor')!.textContent='Another query'});
   })).rejects.toThrow();
   const after=await snapshot(page);expect(after.selected).toEqual([]);expect(after.text).toBe('');expect(after.foreign).toBe('Other task draft');expect(after.foreignClicks+after.sends+after.foreignSends).toBe(0);
  }
 }finally{await browser.close()}
},60000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('launcher preserves genuine UI failures and aborts with verified independent cleanup',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try {
  const page=await browser.newPage();const worker=workerWithoutHandles(page);
  for(const failure of ['session_expired','subscription_unavailable','rate_limited']){
   await page.setContent(fixture);await page.evaluate(f=>{const e=document.createElement('div');e.setAttribute('role',f==='rate_limited'?'dialog':'alert');e.textContent=f==='session_expired'?'Your session has expired':f==='subscription_unavailable'?'Failed to load subscription':'Too many requests. You are making requests too quickly.';document.body.append(e)},failure);
   await expect(worker.attachPrompt(page,'Unsent task',true)).rejects.toMatchObject({code:failure==='session_expired'?'chatgpt_session_expired':failure==='subscription_unavailable'?'chatgpt_subscription_unavailable':'rate_limit_exceeded'});
   expect((await snapshot(page)).rowClicks).toBe(0);expect((await snapshot(page)).sends).toBe(0);
  }
  await page.setContent(fixture);const controller=new AbortController();
  await expect(worker.attachPrompt(page,'Aborted full task',true,async(c:string)=>{if(c==='connector-choice-activated')controller.abort()},controller.signal)).rejects.toMatchObject({name:'AbortError'});
  const after=await snapshot(page);expect(after.text).toBe('');expect(after.selected).toEqual([]);expect(after.rowClicks).toBe(1);expect(after.foreign).toBe('Other task draft');expect(after.sends+after.foreignSends).toBe(0);
 }finally{await browser.close()}
},60000);
