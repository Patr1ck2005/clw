import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../apps/web-recovery-companion/background-bridge.js',import.meta.url),'utf8');
const CHAT='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
const ticket='clwi_'+'c'.repeat(43),marker='CLW-ENROLL:'+'a'.repeat(32)+':'+'b'.repeat(32);
const PAGE={visible:true,controls_known:true,model_label:'GPT-5.6 Sol',effort_label:'Extra High',user_hash:'a'.repeat(64),failure_hash:'0'.repeat(64)};
function fixture({proof=null,stale=false,noPage=false}={}){
 let listener=null;const sent=[];let disconnected=false;
 class MO{constructor(fn){this.fn=fn;}observe(){}disconnect(){disconnected=true;}}
 const page={url:stale?'https://chatgpt.com/c/other-other-other1':CHAT,inspect:async()=>PAGE};
 const ctx=vm.createContext({
  location:{href:CHAT},document:{documentElement:{},querySelectorAll(){return [];}},
  MutationObserver:MO,setTimeout(fn){return 1;},clearTimeout(){},
  ...(noPage?{}:{CLWControlPage:page}),CLWEnrollmentReceipt:()=>proof,
  chrome:{runtime:{id:'ext',async sendMessage(m){sent.push(m);return {ok:true};},onMessage:{addListener(h){listener=h;},removeListener(){}}}}
 });
 vm.runInContext(source,ctx);
 const message=m=>new Promise(resolve=>{const result=listener(m,{id:'ext'},resolve);if(result!==true)resolve(undefined);});
 return {ctx,sent,message,get disconnected(){return disconnected;}};
}
test('unregistered page remains silent and exports no transcript text',async()=>{
 const f=fixture();await new Promise(r=>setImmediate(r));assert.equal(f.sent.length,0);
 const p=await f.message({type:'clw-background-probe'});
 assert.equal(p.url,CHAT);assert.equal(p.proof,null);assert.deepEqual(JSON.parse(JSON.stringify(p.page)),PAGE);
 assert.equal(JSON.stringify(p).includes('conversation'),false);
});
test('static passive bridge can announce exact enrollment proof before loading control-page logic',async()=>{
 const f=fixture({proof:{ticket},noPage:true});await new Promise(r=>setImmediate(r));
 assert.deepEqual(JSON.parse(JSON.stringify(f.sent[0])),{type:'clw-background-proof-found',proof:{enrollment_ticket:ticket},url:CHAT});
 const p=await f.message({type:'clw-background-probe'});assert.equal(p.needs_page,true);assert.equal(p.page,null);
});
test('exact ticket proof announces only the capability and URL',async()=>{
 const f=fixture({proof:{ticket}});await new Promise(r=>setImmediate(r));
 assert.equal(f.sent.length,1);assert.deepEqual(JSON.parse(JSON.stringify(f.sent[0])),{type:'clw-background-proof-found',proof:{enrollment_ticket:ticket},url:CHAT});
});
test('assistant enrollment marker is normalized without arbitrary assistant text',async()=>{
 const f=fixture({proof:marker});await new Promise(r=>setImmediate(r));
 assert.deepEqual(JSON.parse(JSON.stringify(f.sent[0].proof)),{enrollment:marker});
});
test('SPA-stale page may announce exact enrollment proof but withholds safety state until reinjection',async()=>{
 const f=fixture({proof:{ticket},stale:true});await new Promise(r=>setImmediate(r));
 assert.equal(f.sent.length,1);assert.deepEqual(JSON.parse(JSON.stringify(f.sent[0].proof)),{enrollment_ticket:ticket});
 const p=await f.message({type:'clw-background-probe'});
 assert.equal(p.stale,true);assert.equal(p.page,null);assert.deepEqual(JSON.parse(JSON.stringify(p.proof)),{enrollment_ticket:ticket});
});
