// Execute the shipped content script against a minimal isolated DOM. No user page.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
const file=name=>fs.readFileSync(new URL('../apps/web-recovery-companion/'+name,import.meta.url),'utf8');
const url='https://chatgpt.com/c/12345678-1234-1234-1234-123456789012';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function harness({initialRequest=null,initialError=''}={}){
 let tick,request=initialRequest,assistantId='a1',error=initialError;
 const listeners=new Map(),calls=[];
 const rect=()=>[{}],none=()=>null;
 const marker={getClientRects:rect,closest:none,get textContent(){return error;}};
 const turn={getAttribute:()=> 'conversation-turn-a',querySelectorAll:()=>error?[marker]:[]};
 const assistant={getAttribute:()=>assistantId,closest:()=>turn};
 const user={getAttribute:()=> 'u1',closest:none};
 const editor={value:'',getClientRects:rect};
 const document={visibilityState:'visible',activeElement:null,addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:()=>{},querySelectorAll(selector){
  if(selector==='#prompt-textarea')return [editor];
  if(selector==='[data-message-author-role="assistant"]')return [assistant];
  if(selector==='[data-message-author-role="user"]')return [user];
  return [];
 }};
 const context=vm.createContext({document,location:{href:url},crypto:webcrypto,TextEncoder,console,setTimeout,clearInterval:()=>{},setInterval:fn=>{tick=fn;return 1;},chrome:{runtime:{async sendMessage(m){calls.push(m.data);return {ok:true,value:m.data.action==='status'?{request_id:request,page_diagnostics_supported:true}:{decision:'wait',reason:'fixture'}};}}}});
 vm.runInContext(file('policy.js'),context);vm.runInContext(file('content.js'),context);await delay(25);
 return {calls,editor,context,setRequest:r=>{request=r;},setFailure:()=>{assistantId='a2';error='无法思考';},async tick(){await tick();await delay(5);},async gesture(kind){
  const selector=kind==='stop'?'stop-button':'send-button';
  listeners.get('click')({type:'click',isTrusted:true,target:{closest:s=>s.includes('"'+selector+'"')?{}:null}});await delay(5);
 },close(){context.__clwRecoveryStop();}};
}
test('idle pairing confirmation does not disable the NEXT request',async()=>{
 const h=await harness();try{
  await h.gesture('send');await h.tick();h.setRequest('next-original-request');await h.tick();await h.tick();
  assert.ok(h.calls.some(x=>x.action==='observe'),'new request observed');
  assert.ok(!h.calls.some(x=>x.kind==='new_user_input'),'idle confirmation is not a task interruption');
 }finally{h.close();}
});
test('user input during the current request still blocks recovery',async()=>{
 const h=await harness({initialRequest:'original-request'});try{await h.gesture('send');await h.tick();assert.ok(h.calls.some(x=>x.kind==='new_user_input'));}finally{h.close();}
});
test('user stop while idle is never forgotten',async()=>{
 const h=await harness();try{await h.gesture('stop');await h.tick();h.setRequest('next-original-request');await h.tick();await h.tick();assert.ok(h.calls.some(x=>x.kind==='user_stopped'));}finally{h.close();}
});
test('fast new failure between two polls is not mistaken for an installation-era error',async()=>{
 const h=await harness();try{h.setRequest('new-original-request');h.setFailure();await h.tick();await h.tick();assert.ok(h.calls.some(x=>x.kind==='cannot_think'));}finally{h.close();}
});
test('existing error when monitoring begins does not create a recovery attempt',async()=>{
 const h=await harness({initialRequest:'original-request',initialError:'无法思考'});try{await h.tick();assert.ok(!h.calls.some(x=>x.action==='observe'&&x.kind==='cannot_think'));}finally{h.close();}
});
test('idle diagnostics contain only boolean capabilities and bounded enums, not transcript or URLs',async()=>{
 const h=await harness();try{await h.tick();const page=h.calls.find(x=>x.action==='status'&&x.page)?.page;
  assert.ok(page);assert.equal(page.adapter_version,'0.2.0');assert.equal(page.controls_known,true);
  assert.ok(!JSON.stringify(page).includes('chatgpt.com'));assert.ok(!JSON.stringify(page).includes('a1'));
  for(const [k,v] of Object.entries(page))assert.ok(['kind','adapter_version'].includes(k)||typeof v==='boolean');
  assert.ok(!h.calls.some(x=>x.action==='dispatch'||x.action==='observe'));
 }finally{h.close();}
});

