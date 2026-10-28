// Isolated public-DOM fixtures; no browser account, platform request or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
const source=fs.readFileSync(new URL('../apps/web-recovery-companion/page-monitor-page.js',import.meta.url),'utf8');
const url='https://chatgpt.com/c/6add093b-6cf0-83e9-bf31-7d62796ea60c';
async function fixture(options={}){
  let tick,clicks=0,stopped=false,error='',userId='u1',assistantId='a1',userText='private work',generating=options.generating??true,quoted=false;
  let offer=false,grant=true,manualAtGrant=false,clickThrows=false;
  const calls=[],listeners=new Map(),rect=()=>[{}];
  class Area{constructor(){this._value='';}get value(){return this._value;}set value(v){this._value=v;}}
  const editor=new Area();editor.getClientRects=rect;editor.closest=()=>null;editor.contains=()=>false;editor.dispatchEvent=()=>{};
  const marker={getClientRects:rect,get textContent(){return error;},closest:()=>quoted?{}:null};
  const turn={getAttribute:n=>n==='data-turn-id'?assistantId:null,querySelectorAll:()=>error?[marker]:[],compareDocumentPosition:()=>0};
  const assistant={getAttribute:()=>assistantId,closest:()=>turn};
  const user={getAttribute:()=>userId,closest:()=>null,querySelectorAll:()=>[],get textContent(){return userText;}};
  const button={getClientRects:rect,closest:()=>null,disabled:false,getAttribute:()=>null,click(){clicks++;if(clickThrows)throw Error('clicked but response lost');userId='u2';userText=context.CLWPageMonitorPage.PROMPT;assistantId='a2';error='';generating=true;}};
  const doc={activeElement:null,addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:()=>{},querySelectorAll(selector){
    if(selector.includes('[data-testid="prompt-textarea"]'))return options.noEditor?[]:[editor];
    if(selector.includes('[data-testid="composer-send-button"]'))return [button];
    if(selector.includes('[data-testid="composer-stop-button"]'))return generating?[{getClientRects:rect,closest:()=>null}]:[];
    if(selector.startsWith('[data-message-author-role="user"]'))return [user];
    if(selector.startsWith('[data-message-author-role="assistant"]'))return [assistant];
    return [];
  }};
  if('hasFocus'in options)doc.hasFocus=()=>options.hasFocus;
  const runtime={onMessage:{addListener(){},removeListener(){}},async sendMessage(m){
    calls.push(m);
    if(m.type==='monitor-gesture'){stopped=true;return {ok:true,value:{state:'paused'}};}
    if(m.type==='monitor-observe')return {ok:true,value:{state:'watching',...(offer?{offer:{attempt_id:'one',prompt:context.CLWPageMonitorPage.PROMPT}}:{})}};
    if(m.type==='monitor-dispatch'){
      if(manualAtGrant)listeners.get('input')({type:'input',isTrusted:true,target:{closest:()=>editor}});
      return {ok:true,value:{dispatch:grant,attempt_id:'one',prompt:context.CLWPageMonitorPage.PROMPT}};
    }
    return {ok:true,value:{state:'delivery_pending'}};
  }};
  // Keep SHA completion in this fixture's microtask queue. A real WebCrypto
  // thread-pool callback can outlive the synthetic interval flush under load.
  const fixtureCrypto={subtle:{async digest(_algorithm,bytes){return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;}}};
  const context=vm.createContext({document:doc,location:{href:url},navigator:{onLine:true},crypto:fixtureCrypto,TextEncoder,HTMLTextAreaElement:Area,
    InputEvent:class{},setTimeout,clearInterval(){},setInterval:fn=>{tick=fn;return 1;},chrome:{runtime}});
  vm.runInContext(source,context);await context.CLWPageMonitorPage.start('gen-one');
  return {context,calls,editor,doc,get clicks(){return clicks;},get stopped(){return stopped;},
    failure(label='无法思考'){error=label;assistantId='a-failed';generating=false;},setGenerating(v){generating=v;},setQuoted(v){quoted=v;},setOffer(){offer=true;},
    setManualAtGrant(){manualAtGrant=true;},setClickThrows(){clickThrows=true;},async tick(){await tick();for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));},
    gesture(type='click'){listeners.get(type)({type,isTrusted:true,target:{closest:()=>editor}});},stop(){context.__clwPageMonitorStop();}};
}
test('already running manual Pro can be observed without model discovery or platform traffic',async()=>{
  const h=await fixture();try{const s=h.calls[0].snapshot;assert.equal(s.kind,'generating');assert.equal(s.controls_known,true);assert.equal(h.clicks,0);
    assert.ok(!JSON.stringify(h.calls).includes('private work'));assert.ok(!JSON.stringify(h.calls).includes('u1'));assert.ok(!JSON.stringify(h.calls).includes('model'));}finally{h.stop();}
});
test('one terminal failure grant uses one normal send and delivery is verified on next observation',async()=>{
  const h=await fixture();try{h.failure();h.setOffer();await h.tick();assert.equal(h.clicks,1);assert.equal(h.calls.find(x=>x.type==='monitor-finish').result,'clicked');
    await h.tick();assert.ok(h.calls.filter(x=>x.type==='monitor-observe').at(-1).snapshot.continuation_seen);assert.equal(h.clicks,1);}finally{h.stop();}
});
test('connection banner while Stop remains visible is still generating',async()=>{
  const h=await fixture();try{h.failure('Connection interrupted');h.setGenerating(true);await h.tick();assert.equal(h.calls.at(-1).snapshot.kind,'generating');assert.equal(h.clicks,0);
    h.setGenerating(false);await h.tick();assert.equal(h.calls.at(-1).snapshot.kind,'connection_lost');}finally{h.stop();}
});
test('quoted error prose cannot be a terminal failure',async()=>{
  const h=await fixture();try{h.failure();h.setQuoted(true);await h.tick();assert.equal(h.calls.at(-1).snapshot.kind,'idle');assert.equal(h.clicks,0);}finally{h.stop();}
});
test('manual input between durable grant and composer mutation wins without sending',async()=>{
  const h=await fixture();try{h.failure();h.setOffer();h.setManualAtGrant();await h.tick();assert.equal(h.clicks,0);assert.equal(h.editor.value,'');assert.equal(h.stopped,true);
    assert.equal(h.calls.find(x=>x.type==='monitor-finish').result,'not_sent');}finally{h.stop();}
});
test('draft and editor focus are preserved',async()=>{
  const h=await fixture();try{h.failure();h.setOffer();h.editor.value='my new requirement';await h.tick();assert.equal(h.clicks,0);assert.equal(h.editor.value,'my new requirement');
    h.editor.value='';h.doc.activeElement=h.editor;await h.tick();assert.equal(h.clicks,0);}finally{h.stop();}
});
test('background editor activeElement does not block recovery when document has no focus',async()=>{
  const h=await fixture({hasFocus:false});try{h.failure();h.setOffer();h.doc.activeElement=h.editor;await h.tick();
    assert.equal(h.calls.find(x=>x.type==='monitor-dispatch').snapshot.focused,false);assert.equal(h.clicks,1);
  }finally{h.stop();}
});
test('foreground editor focus blocks recovery and explicit sending',async()=>{
  const h=await fixture({hasFocus:true,generating:false});try{h.doc.activeElement=h.editor;h.failure();h.setOffer();await h.tick();assert.equal(h.clicks,0);
    const result=await h.context.CLWPageMonitorPage.sendText('operator continuation',url,h.calls[0].snapshot.user_key);
    assert.equal(result.state,'failed');assert.equal(h.clicks,0);assert.equal(h.editor.value,'');
  }finally{h.stop();}
});
test('explicit sending accepts an idle background editor while still protecting drafts',async()=>{
  const h=await fixture({hasFocus:false,generating:false});try{h.doc.activeElement=h.editor;const key=h.calls[0].snapshot.user_key;
    h.editor.value='human draft';assert.equal((await h.context.CLWPageMonitorPage.sendText('operator continuation',url,key)).state,'failed');
    assert.equal(h.editor.value,'human draft');assert.equal(h.clicks,0);h.editor.value='';
    const result=await h.context.CLWPageMonitorPage.sendText(h.context.CLWPageMonitorPage.PROMPT,url,key);
    assert.equal(result.state,'completed');assert.equal(result.result.clicked,true);assert.equal(h.clicks,1);
  }finally{h.stop();}
});
test('offline is observed but cannot send',async()=>{
  const h=await fixture();try{h.failure('Connection interrupted');h.setOffer();h.context.navigator.onLine=false;await h.tick();assert.equal(h.calls.at(-1).snapshot.kind,'offline');assert.equal(h.clicks,0);}finally{h.stop();}
});
test('unknown click is recorded rather than claimed delivered',async()=>{
  const h=await fixture();try{h.failure();h.setOffer();h.setClickThrows();await h.tick();assert.equal(h.clicks,1);assert.equal(h.calls.find(x=>x.type==='monitor-finish').result,'unknown');}finally{h.stop();}
});
test('navigation stops this observer without navigating back or sending',async()=>{
  const h=await fixture();try{h.context.location.href=url+'-other';await h.tick();assert.equal(h.stopped,true);assert.equal(h.clicks,0);assert.equal(h.context.location.href,url+'-other');}finally{h.stop();}
});
test('unrecognized editor never creates input',async()=>{
  const h=await fixture({noEditor:true,generating:false});try{assert.equal(h.calls[0].snapshot.kind,'unsupported');assert.equal(h.clicks,0);}finally{h.stop();}
});
test('operator continuation preserves a human draft entered during the initial async snapshot',async()=>{
  const h=await fixture({generating:false});try{
    const key=h.calls[0].snapshot.user_key,real=webcrypto.subtle.digest.bind(webcrypto.subtle);
    h.context.crypto={subtle:{async digest(...args){h.editor.value='human draft typed during snapshot';return real(...args);}}};
    const result=await h.context.CLWPageMonitorPage.sendText('operator continuation',url,key);
    assert.equal(result.state,'failed');assert.equal(h.clicks,0);assert.equal(h.editor.value,'human draft typed during snapshot');
  }finally{h.stop();}
});
