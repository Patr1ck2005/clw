'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {WebDriver}=require('../web-driver.cjs');
function fixture(locked=[],proVersion='5.6',familyName='最新',initialPosition=3){
 const names=['低','中','高','极高','Pro'];let position=initialPosition;const pressed=[];
 const selected=()=>({model:`GPT-${position===4?proVersion:'5.6'} · ${familyName}`,effort:names[position],selection:[familyName],options:[{name:familyName,checked:true}],slider:{value:position,min:0,max:4},efforts:names.map((name,value)=>({label:'',value,available:!locked.includes(value)}))});
 const page={id:'new-worker',view:{webContents:{}}};const driver=new WebDriver({runtime:new EventEmitter(),pool:{pages:new Map()},onNotice(){},sleep:async()=>{},dom:async(_wc,op)=>op==='model'?selected():{},input:{key:async(_wc,key)=>{if(key==='Escape')return;position+=key==='ArrowRight'?1:-1;pressed.push(position);assert.ok(!locked.includes(position));}}});
 return {driver,page,pressed,selected};
}
test('workers independently choose requested reasoning from public slider labels',async()=>{
 for(const effort of ['低','Medium','高','极高','Pro']){
  const f=fixture();const result=await f.driver.selectModel(f.page,{model:'gpt-5.6 · 最新',effort,model_selection:{selection:['最新']}});
  assert.equal(result.effort,effort==='Medium'?'中':effort);
 }
});
test('unavailable effort is reported and never silently substituted or sent',async()=>{
 const f=fixture([4]);await assert.rejects(()=>f.driver.selectModel(f.page,{model:'gpt-5.6 · 最新',effort:'Pro'}),e=>e.code==='worker_model_unavailable');
 assert.ok(!f.pressed.includes(4));
});
test('cached numeric positions cannot override the requested effort label',async()=>{
 const f=fixture();const result=await f.driver.selectModel(f.page,{model:'GPT-5.6 · 最新',effort:'中',model_selection:{slider:{min:0,max:4,value:2}}});
 assert.equal(result.effort,'中');
});
test('unresponsive keyboard is a control failure, not a false account capability verdict',async()=>{
 const f=fixture();f.driver.input.key=async()=>{};
 await assert.rejects(()=>f.driver.selectModel(f.page,{model:'GPT-5.6 · 最新',effort:'中'}),e=>e.code!=='worker_model_unavailable'&&e.message.includes('控件未响应'));
});

test('explicit Pro choice follows the native latest selection across version labels without probing lower efforts',async()=>{
 const f=fixture([],'6');
 const result=await f.driver.selectModel(f.page,{model:'GPT-5.6 · 最新',effort:'Pro',model_selection:{selection:['最新']}},{followPageSelection:true});
 assert.equal(result.model,'GPT-6 · 最新');assert.equal(result.effort,'Pro');assert.deepEqual(f.pressed,[4]);
});

test('Pro worker checks its final version after moving out of its enrollment effort',async()=>{
 const f=fixture([],'6');
 const result=await f.driver.selectModel(f.page,{model:'GPT-6 · 最新',effort:'Pro',model_selection:{selection:['最新']}});
 assert.equal(result.model,'GPT-6 · 最新');assert.deepEqual(f.pressed,[4]);
 const wrong=fixture([],'6');
 await assert.rejects(()=>wrong.driver.selectModel(wrong.page,{model:'GPT-5.6 · 最新',effort:'Pro',model_selection:{selection:['最新']}}),e=>e.code==='worker_model_unavailable');
});

test('Latest localization does not change a model version or turn another family into Latest',()=>{
 const {sameModel}=require('../model-settings.cjs');
 assert.equal(sameModel('gpt-6 · 最新','GPT-6 · Latest'),true);
 assert.equal(sameModel('Latest','最新'),true);
 for(const other of ['GPT-5.6 · Latest','GPT-6.1 · Latest','GPT-6 · Newest','GPT-6 Sol','GPT-6 Astra'])
  assert.equal(sameModel('GPT-6 · 最新',other),false);
});

test('a worker verifies the same Pro across English and Chinese menus before any send',async()=>{
 for(const [requested,observed] of [['最新','Latest'],['Latest','最新']]){
  for(const initial of [3,4]){
   const f=fixture([],'6',observed,initial);
   const result=await f.driver.selectModel(f.page,{model:`GPT-6 · ${requested}`,effort:'Pro',model_selection:{selection:[requested]}});
   assert.equal(result.model,`GPT-6 · ${observed}`);assert.equal(result.effort,'Pro');
   assert.deepEqual(f.pressed,initial===3?[4]:[]);
  }
  const wrong=fixture([],'5.6',observed);
  await assert.rejects(()=>wrong.driver.selectModel(wrong.page,{model:`GPT-6 · ${requested}`,effort:'Pro',model_selection:{selection:[requested]}}),e=>e.code==='worker_model_unavailable');
  const locked=fixture([4],'6',observed);
  await assert.rejects(()=>locked.driver.selectModel(locked.page,{model:`GPT-6 · ${requested}`,effort:'Pro',model_selection:{selection:[requested]}}),e=>e.code==='worker_model_unavailable');
  assert.ok(!locked.pressed.includes(4));
 }
});
