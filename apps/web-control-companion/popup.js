'use strict';
const status=document.getElementById('status');
async function active(){const [t]=await chrome.tabs.query({active:true,currentWindow:true});if(!t||!CLWControlPolicy.isChat(t.url))throw Error('请打开确切的已有ChatGPT对话。');return t;}
async function prepare(t,reset=false){if(reset)await chrome.scripting.executeScript({target:{tabId:t.id},func:()=>{globalThis.__clwControlStop?.();globalThis.__clwControlPageCleanup?.();delete globalThis.CLWControlPage;}});await chrome.scripting.executeScript({target:{tabId:t.id},files:['policy.js','page.js']});}
async function start(t){await chrome.scripting.executeScript({target:{tabId:t.id},files:['content.js']});}
async function show(fn){try{status.textContent=await fn();}catch(e){status.textContent=String(e.message);}}
async function send(type,t,data={}){const r=await chrome.runtime.sendMessage({type,tabId:t.id,chatUrl:t.url,...data});if(!r?.ok)throw Error(r?.error||'操作未确认；不要重复未知发送');return r.value;}
document.getElementById('inspect').onclick=()=>show(async()=>{const t=await active();await prepare(t);const r=await chrome.scripting.executeScript({target:{tabId:t.id},func:()=>globalThis.CLWControlPage.inspect()});const p=r[0]?.result;return p?JSON.stringify({model:p.model_label,effort:p.effort_label,controls_known:p.controls_known,visible:p.visible,generating:p.generating,draft:p.draft},null,2):'页面未识别';});
document.getElementById('pair').onclick=()=>show(async()=>{if(!document.getElementById('confirm').checked)throw Error('请先确认模型与接管授权。');const t=await active();const v=await send('pair',t,{code:document.getElementById('code').value,confirm:true});document.getElementById('code').value='';await prepare(t,true);await start(t);return '已绑定此页 generation '+v.generation+'。标签不匹配不会发送；旧请求需在CLW面板明确接续。';});
document.getElementById('resume').onclick=()=>show(async()=>{const t=await active();await send('resume',t);await prepare(t,true);await start(t);return '只恢复观察。旧dispatch/unknown不会重新Send。';});
document.getElementById('stop').onclick=()=>show(async()=>{const t=await active();await chrome.scripting.executeScript({target:{tabId:t.id},func:()=>globalThis.__clwControlStop?.()});await send('disable',t);return '本页控制已停用；没有声称终止已有模型执行。';});
