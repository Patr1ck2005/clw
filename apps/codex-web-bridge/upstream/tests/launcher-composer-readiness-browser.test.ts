import {afterAll,beforeAll,expect,test} from 'bun:test';
import {chromium,type Browser,type Page} from 'playwright-core';
import {ChatGptBrowserWorker,inspectOwnedLauncherEffort,operateOwnedLauncherComposer} from '../src/adapters/chatgpt-web/browser-worker';
import {CHATGPT_COMPOSER_SELECTOR,CHATGPT_EFFORT_CONTROL_SELECTOR,CHATGPT_SEND_BUTTON_SELECTOR} from '../src/chatgpt-session';

// Local static documents in either an isolated Electron CDP owner or headless
// Chromium. No authenticated profile, remote page or model request is used.
const enabled=!!(process.env.CHATGPT_DOM_TEST_CDP||process.env.CHATGPT_DOM_TEST_BROWSER);
let browser:Browser,page:Page;
beforeAll(async()=>{
 if(!enabled)return;
 if(process.env.CHATGPT_DOM_TEST_CDP){
  browser=await chromium.connectOverCDP(process.env.CHATGPT_DOM_TEST_CDP);
  page=browser.contexts()[0]!.pages()[0]!;
 }else{
  browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
  page=await browser.newPage();
 }
});
afterAll(async()=>{await browser?.close()});

const editor=(modern:boolean,id='editor')=>`<div id="${modern?id:'prompt-textarea'}" ${modern?'data-composer-markdown':'data-lexical-editor="true"'} contenteditable="true" role="textbox" style="width:400px;min-height:30px">Restored draft</div>`;
const form=(modern:boolean)=>`<form data-chatgpt-composer id="owned">${editor(modern)}<button data-testid="send-button" type="submit">Send</button><button id="effort" type="button" data-tone="neutral" aria-haspopup="menu">高</button></form>`;
const shell=`<form id="foreign"><input id="foreign-input" value="Other task draft"><button type="submit">Foreign Send</button></form><div id="mount"></div><script>window.inputs=0;window.clicks=0;window.sends=0;document.addEventListener('input',()=>window.inputs++);document.addEventListener('click',()=>window.clicks++);document.addEventListener('submit',e=>{e.preventDefault();window.sends++});</script>`;
const notices={session_expired:['alert','Your session has expired'],subscription_unavailable:['alert','Failed to load subscription'],rate_limited:['dialog','Too many requests. You are making requests too quickly.']} as const;
async function documentWith(count:number,notice?:keyof typeof notices){
 await page.setContent(shell+Array.from({length:count},()=>form(true)).join('')+(notice?`<p role="${notices[notice][0]}">${notices[notice][1]}</p>`:''));
 await page.evaluate(()=>document.querySelector<HTMLElement>('#foreign-input')!.focus());
}
const operate=(operation:any)=>page.evaluate(operateOwnedLauncherComposer,{selector:CHATGPT_COMPOSER_SELECTOR,operation});
const snapshot=()=>page.evaluate(()=>({html:document.body.innerHTML,focus:(document.activeElement as HTMLElement)?.id,foreign:(document.querySelector('#foreign-input') as HTMLInputElement).value,inputs:(window as any).inputs,clicks:(window as any).clicks,sends:(window as any).sends}));
function workerWithPublicOperations(){
 const worker=Object.create(ChatGptBrowserWorker.prototype) as any;worker.config={browserHost:'launcher',appName:'Local-MCP'};
 const operations:string[]=[],evaluate=page.evaluate.bind(page),locator=page.locator.bind(page);
 page.evaluate=((fn:any,arg:any)=>{if(arg?.operation)operations.push(arg.operation.kind);return evaluate(fn,arg)}) as any;
 const guard=(value:any):any=>new Proxy(value,{get(target,key){
  if(['fill','focus','press','pressSequentially','evaluate','evaluateAll','count','waitFor','allInnerTexts'].includes(String(key)))return async()=>{throw Error('Background Locator operation unavailable: '+String(key))};
  if(['filter','first','locator'].includes(String(key)))return (...args:any[])=>guard(target[key](...args));
  const result=target[key];return typeof result==='function'?result.bind(target):result;
 }});
 page.locator=((...args:any[])=>guard((locator as any)(...args))) as any;
 return {worker,operations,restore(){page.evaluate=evaluate as any;page.locator=locator as any}};
}

test.skipIf(!enabled)('global alerts remain readable with zero or duplicate composers without touching drafts',async()=>{
 for(const count of [0,2])for(const notice of [undefined,...Object.keys(notices)] as (keyof typeof notices|undefined)[]){
  await documentWith(count,notice);const before=await snapshot();
  expect((await operate({kind:'ui-state'}) as any).failure).toBe(notice);
  expect(await operate({kind:'count'})).toBe(count);expect(await snapshot()).toEqual(before);
 }
});

test.skipIf(!enabled)('zero and duplicate composers still reject every edit, connector and Send transaction',async()=>{
 const operations=[{kind:'focus'},{kind:'clear'},{kind:'end'},{kind:'insert',text:'Never inserted'},{kind:'text'},{kind:'connectors'},
  {kind:'connector-state',appName:'Local-MCP'},{kind:'connector-select',appName:'Local-MCP'},
  {kind:'send-state',sendSelector:CHATGPT_SEND_BUTTON_SELECTOR},{kind:'send',sendSelector:CHATGPT_SEND_BUTTON_SELECTOR,expectedRaw:'',mentionCount:0}];
 for(const count of [0,2]){
  await documentWith(count);const before=await snapshot();
  for(const operation of operations)await expect(operate(operation)).rejects.toThrow(`not unique (visibleCount=${count})`);
  expect(await snapshot()).toEqual(before);
 }
},15000);

test.skipIf(!enabled)('model and effort selection retain the exact-one-composer guard',async()=>{
 for(const count of [0,2]){
  await documentWith(count);const before=await snapshot();
  for(const select of [undefined,{effortIndex:2,modelFamily:'6' as const}])await expect(page.evaluate(inspectOwnedLauncherEffort,{composerSelector:CHATGPT_COMPOSER_SELECTOR,controlSelector:CHATGPT_EFFORT_CONTROL_SELECTOR,verifyFamily:true,select})).rejects.toThrow('owned composer is not unique');
  expect(await snapshot()).toEqual(before);
 }
});

for(const modern of [false,true])test.skipIf(!enabled)(`attachment reacquires a hydrated ${modern?'current':'Lexical'} composer before editing`,async()=>{
 await documentWith(0);const h=workerWithPublicOperations(),prompt='完整正文\n  literal `code` <tag> $()\n第二段';
 try{
  expect(await operate({kind:'count'})).toBe(0);
  await page.evaluate(markup=>{setTimeout(()=>{document.querySelector('#mount')!.innerHTML=markup},150)},form(modern));
  await h.worker.attachPrompt(page,prompt,false);
  expect(h.worker.promptTextEquivalent(prompt,await h.worker.attachedPromptText(page))).toBeTrue();
  const firstClear=h.operations.indexOf('clear');expect(h.operations[1]).toBe('ui-state');
  expect(h.operations.slice(2,firstClear).filter(kind=>kind==='count').length).toBeGreaterThan(1);
  expect(h.operations.slice(firstClear)).toContain('insert');
  const state=await snapshot();expect(state.foreign).toBe('Other task draft');expect(state.inputs).toBeGreaterThan(0);expect(state.clicks+state.sends).toBe(0);
 }finally{h.restore()}
});

test.skipIf(!enabled)('readiness abort and duplicate timeout do not begin editing or rollback',async()=>{
 for(const count of [0,2]){
  await documentWith(count);const before=await snapshot(),h=workerWithPublicOperations(),controller=new AbortController();
  const active=h.worker.activeComposer.bind(h.worker);h.worker.activeComposer=(p:Page,_timeout:number,signal?:AbortSignal)=>active(p,200,signal);
  const timer=count===0?setTimeout(()=>controller.abort(),80):undefined;
  try{
   let failure:Error|undefined;
   try{await h.worker.attachPrompt(page,'Unsent task',false,undefined,controller.signal)}catch(error){failure=error as Error}
   expect(failure).toBeInstanceOf(Error);
   if(count===0)expect(failure!.name).toBe('AbortError');
   expect(failure!.message).not.toContain('composer state could not be cleared');
   expect(h.operations).not.toContain('clear');expect(h.operations).not.toContain('insert');expect(await snapshot()).toEqual(before);
  }finally{if(timer)clearTimeout(timer);h.restore()}
 }
});

test.skipIf(!enabled)('attachment preserves genuine page failure before waiting for a missing editor',async()=>{
 for(const notice of Object.keys(notices) as (keyof typeof notices)[]){
  await documentWith(0,notice);const before=await snapshot(),h=workerWithPublicOperations();
  try{
   await expect(h.worker.attachPrompt(page,'Unsent task',false)).rejects.toMatchObject({code:notice==='session_expired'?'chatgpt_session_expired':notice==='subscription_unavailable'?'chatgpt_subscription_unavailable':'rate_limit_exceeded'});
   expect(h.operations).toEqual(['ui-state']);expect(await snapshot()).toEqual(before);
  }finally{h.restore()}
 }
});
