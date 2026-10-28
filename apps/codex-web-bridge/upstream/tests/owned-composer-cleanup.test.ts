import { expect,test } from 'bun:test';
import {chromium} from 'playwright-core';
import { ChatGptBrowserWorker } from '../src/adapters/chatgpt-web/browser-worker';

for(const openMenu of [false,true])test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`launcher clears only the owned editor with menu open=${openMenu}`,async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try{
  const page=await browser.newPage();await page.setContent(`<form><div id="prompt-textarea" contenteditable="true"><span app-mention-path="app://fixture" app-mention-display-name="Local-MCP" contenteditable="false">Local-MCP</span>Old transport</div></form><input id="foreign" value="Keep the other task draft"><div role="menu" id="menu"${openMenu?'':' hidden'}>Owned menu</div><script>window.escapes=0;document.addEventListener('keydown',e=>{if(e.key==='Escape'){window.escapes++;document.querySelector('#menu').hidden=true}})</script>`);
  const worker=Object.create(ChatGptBrowserWorker.prototype) as any;worker.config={browserHost:'launcher',appName:'Local-MCP'};
  page.locator=()=>{throw Error('Background handles are unavailable')};
  await worker.clearChatGptComposerState(page);
  const state=await page.evaluate(()=>({text:document.querySelector('#prompt-textarea')!.textContent,mentions:document.querySelectorAll('[app-mention-path]').length,foreign:(document.querySelector('#foreign') as HTMLInputElement).value,closed:(document.querySelector('#menu') as HTMLElement).hidden,escapes:(window as any).escapes}));
  expect(state.text).toBe('');expect(state.mentions).toBe(0);expect(state.foreign).toBe('Keep the other task draft');expect(state.closed).toBeTrue();expect(state.escapes).toBe(1);
 }finally{await browser.close()}
},60000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)('launcher focus must be confirmed on the same owned editor before clearing',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<form><div id="prompt-textarea" contenteditable="true">Keep this draft</div></form><input id="foreign">');
  const worker=Object.create(ChatGptBrowserWorker.prototype) as any;worker.config={browserHost:'launcher'};
  await page.evaluate(()=>{document.querySelector<HTMLElement>('#foreign')!.focus();document.querySelector<HTMLElement>('#prompt-textarea')!.focus=()=>{}});
  await expect(worker.focusComposer({page:()=>page},{timeout:1000})).rejects.toThrow('owned editor focus was not confirmed');
  const signal=new AbortController();signal.abort();let calls=0;const evaluate=page.evaluate.bind(page);page.evaluate=(...args:any[])=>{calls++;return (evaluate as any)(...args)};
  await expect(worker.focusComposer({page:()=>page},{timeout:1000,signal:signal.signal})).rejects.toThrow();expect(calls).toBe(0);
  expect(await evaluate(()=>document.querySelector('#prompt-textarea')!.textContent)).toBe('Keep this draft');
 }finally{await browser.close()}
},60000);
