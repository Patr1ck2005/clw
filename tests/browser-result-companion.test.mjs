import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const file=name=>fs.readFileSync(new URL('../apps/web-recovery-companion/'+name,import.meta.url),'utf8');
const CHAT_URL='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
const H=x=>x.repeat(64);
const PAGE={visible:true,generating:false,draft:false,composing:false,focused:false,blocked:false,stopped:false,
  controls_known:true,model_pro_visible:false,effort_disallowed_visible:false,editor_known:true,user_known:true,
  mode_control_known:true,model_label:'GPT-5.6 Sol',effort_label:'Extra High',user_hash:H('a'),failure_hash:H('0'),failure_kind:''};

async function fixture({pendingOnPulse=false,userChangesAfterSend=false,grantPrompt=null,transportActive=true}={}){
 let interval,clicks=0,currentUser=pendingOnPulse?H('b'):H('a'),generating=false,answer=null,now=1000,closed=false;
 const calls=[];class FakeDate extends Date{static now(){now+=2000;return now;}}
 class Textarea{constructor(){this._value='';}get value(){return this._value;}set value(v){this._value=v;}dispatchEvent(){}}
 const ed=new Textarea(),button={disabled:false,getAttribute:()=>null,click(){clicks++;ed.value='';currentUser=H('b');generating=true;}};
 const page={url:CHAT_URL,editor:()=>ed,send:()=>button,value:x=>x.value,
   async inspect(){return {...PAGE,user_hash:currentUser,generating,draft:ed.value.length>0};},
   async latestAssistant(){return answer?{...answer}:{turn_hash:H('c'),text:'Previous answer'};}};
 const expected={...PAGE,model_label:'gpt-5.6 sol',effort_label:'extra high'};
 let pulseCount=0;
 const context=vm.createContext({document:{activeElement:null},location:{href:CHAT_URL},HTMLTextAreaElement:Textarea,InputEvent:class {},
   Date:FakeDate,console,setInterval(fn){interval=fn;return 1;},clearInterval(){closed=true;},
   setTimeout(fn){queueMicrotask(fn);return 1;},
   chrome:{runtime:{onMessage:{addListener(){},removeListener(){}},async sendMessage(m){
     calls.push(m);if(m.type==='control-hello')return {ok:true,value:{...expected,transport_active:transportActive}};if(m.type==='control-transport')return {ok:true,value:{active:transportActive}};
     const d=m.data;
     if(d.action==='pulse'){
       pulseCount++;
       if(pendingOnPulse)return {ok:true,value:{state:'browser_result_pending',attempt_id:'control_'+H('1').slice(0,32),sent_user_hash:H('b'),assistant_before_hash:H('c')}};
       return {ok:true,value:pulseCount===1?{state:'offer',attempt_id:'control_'+H('1').slice(0,32),request_id:'request-original',user_hash:H('a'),failure_hash:H('0')}:{state:'idle_or_old_request_not_adopted'}};
     }
     if(d.action==='dispatch')return {ok:true,value:{dispatch:true,attempt_id:d.attempt_id,prompt:grantPrompt||'CLW 原请求接管通知；这是原请求。\nDo the complete fixture work and return the public result.'}};
     if(d.action==='sent')return {ok:true,value:{state:'browser_result_pending',attempt_id:d.attempt_id,sent_user_hash:d.page.user_hash,assistant_before_hash:d.assistant_before_hash}};
     if(d.action==='result')return {ok:true,value:{state:'completed',receipt:{request_id:'request-original',phase:'completed'},replayed:false}};
     if(d.action==='finish')return {ok:true,value:{state:d.result}};
     throw Error('unexpected '+d.action);
   }}}});
 vm.runInContext(file('control-policy.js'),context);context.CLWControlPage=page;vm.runInContext(file('control-content.js'),context);
 const flush=async()=>{for(let i=0;i<40;i++)await new Promise(r=>setImmediate(r));};
 await flush();
 if(userChangesAfterSend)currentUser=H('e');
 return {calls,page,context,flush,get clicks(){return clicks;},get closed(){return closed;},
   setTransport(value){transportActive=!!value;},
   setAnswer(text='Full public result'){generating=false;answer={turn_hash:H('d'),text};},
   async tick(){await interval();await flush();},close(){context.__clwControlStop();}};
}

test('foreground transport does not request an offer or click Send until Edge becomes background',async()=>{
 const f=await fixture({transportActive:false});try{
   assert.equal(f.clicks,0);
   assert.equal(f.calls.filter(x=>x.data?.action==='pulse').length,0);
   f.setTransport(true);await f.tick();
   assert.equal(f.calls.filter(x=>x.data?.action==='pulse').length,1);
   assert.equal(f.calls.filter(x=>x.data?.action==='dispatch').length,1);
   assert.equal(f.clicks,1);
 }finally{f.close();}
});
test('ordinary browser receiver sends once, claims via sent receipt, then returns one stable public reply',async()=>{
 const f=await fixture();try{
   assert.equal(f.clicks,1);
   assert.deepEqual(f.calls.filter(x=>x.type==='control-wire').map(x=>x.data.action).slice(0,3),['pulse','dispatch','sent']);
   f.setAnswer('Full public result from the actual assistant turn');
   await f.tick();assert.equal(f.calls.some(x=>x.data?.action==='result'),false);
   await f.tick();
   const results=f.calls.filter(x=>x.data?.action==='result');assert.equal(results.length,1);
   assert.equal(results[0].data.text,'Full public result from the actual assistant turn');
   await f.tick();assert.equal(f.calls.filter(x=>x.data?.action==='result').length,1);
 }finally{f.close();}
});

test('one long complete work block up to 96 KiB is sent once instead of being split into continue turns',async()=>{const prompt='CLW 原请求接管通知；这是原请求。\n'+'研究与实现要求。'.repeat(6000);assert.ok(prompt.length>40000&&prompt.length<96000);const f=await fixture({grantPrompt:prompt});try{assert.equal(f.clicks,1);assert.equal(f.calls.filter(x=>x.data?.action==='dispatch').length,1);assert.equal(f.calls.filter(x=>x.data?.action==='sent').length,1);}finally{f.close();}});

test('extension restart resumes result capture from server receipt without another Send',async()=>{
 const f=await fixture({pendingOnPulse:true});try{
   assert.equal(f.clicks,0);f.setAnswer('Recovered public result after extension restart');
   await f.tick();await f.tick();
   assert.equal(f.calls.filter(x=>x.data?.action==='dispatch').length,0);
   assert.equal(f.calls.filter(x=>x.data?.action==='result').length,1);
 }finally{f.close();}
});

test('new user input after CLW Send closes capture instead of attaching the wrong assistant answer',async()=>{
 const f=await fixture({userChangesAfterSend:true});try{
   f.setAnswer('Answer to a later human message');await f.tick();const after=f.calls.length;await f.tick();
   assert.equal(f.calls.filter(x=>x.data?.action==='result').length,0);assert.equal(f.calls.length,after);
 }finally{f.close();}
});

test('new explicit generation failure exits result capture and lets server bounded recovery take over',async()=>{const f=await fixture();try{f.page.inspect=async()=>({...PAGE,user_hash:H('b'),generating:false,failure_kind:'generation_failed',failure_hash:H('e')});let failurePulse=0;const oldSend=f.context.chrome.runtime.sendMessage;f.context.chrome.runtime.sendMessage=async m=>{if(m.type==='control-wire'&&m.data.action==='pulse'&&m.data.page?.failure_kind&&failurePulse===0){failurePulse=1;return {ok:true,value:{state:'browser_result_failed_recovery_pending',attempt_id:'control_'+H('1').slice(0,32),failure_kind:'generation_failed'}};}return oldSend(m);};await f.tick();const dispatches=f.calls.filter(x=>x.data?.action==='dispatch').length,sends=f.clicks;await f.tick();assert.equal(failurePulse,1);assert.equal(f.calls.filter(x=>x.data?.action==='result').length,0);assert.equal(f.calls.filter(x=>x.data?.action==='dispatch').length,dispatches);assert.equal(f.clicks,sends);}finally{f.close();}});

test('same assistant turn as before dispatch is never submitted as the child result',async()=>{
 const f=await fixture();try{
   f.setAnswer('Previous answer');f.page.latestAssistant=async()=>({turn_hash:H('c'),text:'Previous answer'});
   await f.tick();await f.tick();assert.equal(f.calls.filter(x=>x.data?.action==='result').length,0);
 }finally{f.close();}
});

test('oversized public reply fails closed instead of truncating a claimed child',async()=>{
 const f=await fixture();try{
   f.setAnswer('x'.repeat(48001));await f.tick();const before=f.calls.length;await f.tick();const after=f.calls.length;await f.tick();
   assert.equal(f.calls.filter(x=>x.data?.action==='result').length,0);assert.equal(f.calls.length,after);assert.ok(after>=before);
 }finally{f.close();}
});
