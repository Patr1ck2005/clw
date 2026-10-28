// Shipped scripts run in isolated VM contexts; no user browser or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const file=name=>fs.readFileSync(new globalThis.URL('../apps/web-control-companion/'+name,import.meta.url),'utf8');
const URL='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
const PAGE={visible:true,generating:false,draft:false,composing:false,focused:false,blocked:false,stopped:false,controls_known:true,model_label:'GPT-5.6 Sol',effort_label:'Extra High',user_hash:'a'.repeat(64),failure_hash:'0'.repeat(64),failure_kind:''};
const ctx=vm.createContext({});vm.runInContext(file('policy.js'),ctx);const policy=ctx.CLWControlPolicy;

test('only exact saved ChatGPT URLs including explicit WEB id',()=>{
  assert.equal(policy.isChat(URL),true);assert.equal(policy.isChat(URL.replace('/c/','/c/WEB:')),true);
  for(const u of ['https://chatgpt.com/',URL+'?x=1',URL+'#x',URL.replace('https:','http:'),URL.replace('chatgpt.com','evil.test')])assert.equal(policy.isChat(u),false);
});
test('Pro and unknown model families never pass the cost guard',()=>{
  for(const model of ['GPT-6 Pro','GPT-5.6 Pro','Sol Pro','GPT-6','',null])assert.equal(policy.permitted(model,'Extra High'),false);
  assert.equal(policy.permitted('GPT-5.6 Sol','Medium'),true);assert.equal(policy.permitted('GPT-5.6 Sol','中等'),true);
  assert.equal(policy.permitted('GPT-5.6 Sol','Extra High'),true);assert.equal(policy.permitted('GPT-5.6 Sol','极高'),true);
  assert.equal(policy.permitted('GPT-5.6 Sol','High'),false);
});
test('all boolean and exact-label safety guards are mandatory',()=>{
  assert.equal(policy.safe(PAGE,PAGE),true);
  for(const k of ['generating','draft','composing','focused','blocked','stopped'])assert.equal(policy.safe({...PAGE,[k]:true},PAGE),false);
  for(const k of ['visible','controls_known'])assert.equal(policy.safe({...PAGE,[k]:false},PAGE),false);
  assert.equal(policy.safe({...PAGE,model_label:'GPT-6 Sol'},PAGE),false);
  assert.equal(policy.safe({...PAGE,blocked:undefined},PAGE),false);
});
test('wire allowlist rejects arbitrary tools, extra keys and injected origin',()=>{
  assert.equal(policy.actionValid({action:'pulse',page:PAGE}),true);
  for(const x of [{action:'claim'},{action:'dispatch',attempt_id:'x',page:PAGE,origin:'evil'},{action:'pulse',page:PAGE,tool:'run_process'},{action:'constructor'}])assert.equal(policy.actionValid(x),false);
});

async function worker(backing={},customFetch){
  let handler,removed;const network=[];const tab={id:7,url:URL};
  const storage={async setAccessLevel(x){assert.equal(x.accessLevel,'TRUSTED_CONTEXTS');},async get(k){return {[k]:backing[k]};},async set(v){Object.assign(backing,v);},async remove(k){delete backing[k];}};
  const context=vm.createContext({crypto:webcrypto,AbortController,setTimeout,clearTimeout,console,
    fetch:async(url,opt)=>{network.push({url,opt,body:JSON.parse(opt.body)});return customFetch?customFetch(url,opt):{ok:true,async text(){return JSON.stringify({success:true,control_token:'clwc_'+'t'.repeat(43),generation:1,model_label:'gpt-5.6 sol',effort_label:'extra high',state:'idle_or_old_request_not_adopted'});}};},
    chrome:{storage:{session:storage},tabs:{async get(id){assert.equal(id,7);return tab;},onRemoved:{addListener(fn){removed=fn;}}},runtime:{getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:{addListener(fn){handler=fn;}}}}});
  context.importScripts=()=>vm.runInContext(file('policy.js'),context);vm.runInContext(file('worker.js'),context);
  const popup={url:'chrome-extension://'+'a'.repeat(32)+'/popup.html'};
  const sender={tab:{id:7,url:URL},url:URL,frameId:0,documentId:'document-a'};
  const send=(m,s=sender)=>new Promise(resolve=>handler(m,s,resolve));
  async function pair(){return send({type:'pair',tabId:7,chatUrl:URL,code:'A'.repeat(16),confirm:true},popup);}
  return {send,pair,popup,sender,backing,tab,network,removed};
}

test('pair only from real extension popup and explicit confirmation',async()=>{
  const w=await worker();const bad=await w.send({type:'pair',tabId:7,chatUrl:URL,code:'A'.repeat(16),confirm:true});assert.equal(bad.ok,false);assert.equal(w.network.length,0);
  const no=await w.send({type:'pair',tabId:7,chatUrl:URL,code:'A'.repeat(16),confirm:false},w.popup);assert.equal(no.ok,false);
  const good=await w.pair();assert.equal(good.ok,true);assert.equal(JSON.stringify(good).includes('clwc_'),false);
  assert.equal(w.network[0].opt.credentials,'omit');assert.equal(w.network[0].opt.redirect,'error');
});
test('worker token is never delivered to content scripts',async()=>{
  const w=await worker();await w.pair();const hello=await w.send({type:'hello'});assert.equal(hello.ok,true);assert.equal(JSON.stringify(hello).includes('clwc_'),false);
  const pulse=await w.send({type:'wire',data:{action:'pulse',page:PAGE}});assert.equal(pulse.ok,true);
  assert.equal(w.network[1].opt.headers['X-CLW-Control'],'clwc_'+'t'.repeat(43));
});
test('foreign frames/documents/tab navigation fail closed',async()=>{
  const w=await worker();await w.pair();await w.send({type:'hello'});
  for(const sender of [{...w.sender,frameId:1},{...w.sender,documentId:'other'},{...w.sender,url:URL+'other'}]){
    const r=await w.send({type:'wire',data:{action:'pulse',page:PAGE}},sender);assert.equal(r.ok,false);
  }
  w.tab.url=URL+'other';assert.equal((await w.send({type:'hello'})).ok,false);assert.equal(w.network.length,1);
});
test('worker restart restores exact binding without granting another document',async()=>{
  const backing={},a=await worker(backing);await a.pair();await a.send({type:'hello'});
  const b=await worker(backing);assert.equal((await b.send({type:'hello'})).ok,true);
  assert.equal((await b.send({type:'hello'},{...b.sender,documentId:'newdoc'})).ok,false);
  await b.send({type:'resume',tabId:7,chatUrl:URL},b.popup);
  assert.equal((await b.send({type:'hello'},{...b.sender,documentId:'newdoc'})).ok,true);
});
test('disable removes token locally even when server unavailable',async()=>{
  const backing={},a=await worker(backing);await a.pair();const b=await worker(backing,async()=>{throw Error('offline');});
  const r=await b.send({type:'disable',tabId:7,chatUrl:URL},b.popup);assert.equal(r.ok,true);assert.equal(Object.keys(backing).length,0);
});
test('recovery token, arbitrary action and extra nonce cannot be forwarded',async()=>{
  const w=await worker();await w.pair();await w.send({type:'hello'});
  for(const data of [{action:'claim'},{action:'pulse',page:PAGE,tab_nonce:'injected'},{action:'finish',attempt_id:'x',result:'sent',control_token:'evil'}])assert.equal((await w.send({type:'wire',data})).ok,false);
  assert.equal(w.network.length,1);
});

async function content({model='GPT-5.6 Sol',changeAfterGrant=false,lostGrant=false,accept=true,stopAfterGrant=false,confirmedReceive=false}={}){
  let timer,clicks=0,grants=0,finished=null,stopped=false,currentHash='a'.repeat(64),busySeen=false;const calls=[];
  class Textarea{constructor(){this._value='';}get value(){return this._value;}set value(v){this._value=v;}dispatchEvent(){}}
  const ed=new Textarea(),button={disabled:false,getAttribute:()=>null,click(){clicks++;if(accept){ed.value='';currentHash='b'.repeat(64);}}};
  const document={activeElement:null};
  const page={url:URL,editor:()=>ed,send:()=>button,value:x=>x.value,async inspect(){return {...PAGE,model_label:model,stopped,user_hash:currentHash,draft:ed.value.length>0};}};
  const context=vm.createContext({document,location:{href:URL},HTMLTextAreaElement:Textarea,InputEvent:class {},setInterval(fn){timer=fn;return 1;},clearInterval(){},setTimeout:fn=>{queueMicrotask(fn);return 1;},console,
    chrome:{runtime:{async sendMessage(m){calls.push(m);if(m.type==='hello')return {ok:true,value:PAGE};
      const d=m.data;if(d.action==='pulse')return {ok:true,value:grants?{state:'original_attempt_requires_reconciliation'}:{state:'offer',attempt_id:'control_'+'1'.repeat(32),user_hash:'a'.repeat(64),failure_hash:PAGE.failure_hash}};
      if(d.action==='dispatch'){grants++;if(changeAfterGrant)model='GPT-6 Pro';if(stopAfterGrant)stopped=true;if(lostGrant)throw Error('control_transport_unknown_no_retry');return {ok:true,value:{dispatch:true,attempt_id:d.attempt_id,prompt:'CLW 原请求接管通知; fixed isolated fixture'}};}
      if(d.action==='finish'){finished=d.result;return {ok:true,value:{state:confirmedReceive?'acknowledged':finished}};}throw Error('unexpected_action');
    }}}});
  vm.runInContext(file('policy.js'),context);context.CLWControlPage=page;vm.runInContext(file('content.js'),context);
  async function flush(){for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));}
  await flush();return {calls,ed,context,get clicks(){return clicks;},get grants(){return grants;},get finished(){return finished;},async tick(){await timer();await flush();},close(){context.__clwControlStop();}};
}

test('content makes exactly one grant and one ordinary Send for an accepted event',async()=>{
  const c=await content();try{assert.equal(c.grants,1);assert.equal(c.clicks,1);assert.equal(c.finished,'sent');await c.tick();await c.tick();assert.equal(c.clicks,1);}finally{c.close();}
});
test('Pro page never even requests a dispatch grant',async()=>{
  const c=await content({model:'GPT-6 Pro'});try{assert.equal(c.grants,0);assert.equal(c.clicks,0);}finally{c.close();}
});
test('model change after grant prevents Send, not silently changing back',async()=>{
  const c=await content({changeAfterGrant:true});try{assert.equal(c.grants,1);assert.equal(c.clicks,0);assert.equal(c.finished,'not_sent');await c.tick();assert.equal(c.grants,1);}finally{c.close();}
});
test('unknown grant response never causes a retry or local Send',async()=>{
  const c=await content({lostGrant:true});try{assert.equal(c.grants,1);assert.equal(c.clicks,0);await c.tick();assert.equal(c.grants,1);}finally{c.close();}
});
test('unconfirmed click acceptance is unknown and never clicked again',async()=>{
  const c=await content({accept:false});try{assert.equal(c.clicks,1);assert.equal(c.finished,'unknown');await c.tick();assert.equal(c.clicks,1);assert.ok(c.ed.value.length>0);}finally{c.close();}
});
test('user stop between grant and insertion prevents the effect',async()=>{
  const c=await content({stopAfterGrant:true});try{assert.equal(c.clicks,0);assert.equal(c.finished,'not_sent');}finally{c.close();}
});
test('actual receiver acknowledgement resolves a locally unknown acceptance without Send replay',async()=>{
  const c=await content({accept:false,confirmedReceive:true});try{
    assert.equal(c.clicks,1);assert.equal(c.finished,'unknown');
    const before=c.calls.length;await c.tick();assert.ok(c.calls.length>before);assert.equal(c.clicks,1);
  }finally{c.close();}
});

