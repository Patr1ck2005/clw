import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../apps/web-recovery-companion/popup.js',import.meta.url),'utf8');
const url='https://chatgpt.com/c/6add093b-6cf0-83e9-bf31-7d62796ea60c';
function fixture({backendFails=false,scriptFails=false}={}){
  const elements=new Map(),order=[],timers=[];
  const get=id=>{if(!elements.has(id))elements.set(id,{textContent:'',replaceChildren(){}});return elements.get(id);};
  let nextState={state:'stopped',attempts:1};
  const ctx=vm.createContext({document:{getElementById:get},chrome:{tabs:{async query(){return [{id:7,url}];}},scripting:{async executeScript(){order.push('page-stop');if(scriptFails)throw Error('page unreachable');}},runtime:{async sendMessage(m){if(m.type!=='monitor-status'&&m.type!=='local-control-status')order.push(m.type);return backendFails?{ok:false,error:'storage failed'}:{ok:true,value:m.type==='local-control-status'?{connected:true}:nextState};}}},CLWControlPolicy:{isChat:()=>true},Date,setInterval:fn=>{timers.push(fn);return timers.length;}});
  vm.runInContext(source,ctx);return {get,order,setState:s=>{nextState=s;},async refresh(){await ctx.refreshMonitor();},summary:s=>ctx.monitorSummary(s)};
}
test('human stop shuts down page observation before awaiting backend storage',async()=>{
  const f=fixture({backendFails:true});await f.get('monitorStop').onclick();assert.deepEqual(f.order,['page-stop','monitor-stop']);assert.match(f.get('status').textContent,/storage failed/);
});
test('page injection failure still attempts durable stop and reports unresolved page side',async()=>{
  const f=fixture({scriptFails:true});await f.get('monitorStop').onclick();assert.deepEqual(f.order,['page-stop','monitor-stop']);assert.match(f.get('status').textContent,/后台已停止/);
});
test('ordinary stop explains that current page generation and Jobs continue',async()=>{
  const f=fixture();await f.get('monitorStop').onclick();assert.match(f.get('status').textContent,/网页当前回合和本地 Job 继续运行/);
});
test('open popup refreshes read-only local status and shows a connection wait',async()=>{
 const f=fixture();await new Promise(r=>setImmediate(r));f.setState({state:'waiting',kind:'connection_wait',reason:'connection_wait',attempts:0,connection_wait_ms:95000,updated_at:Date.now(),bound:true,observer_recent:true});await f.refresh();
 assert.match(f.get('status').textContent,/连接中断，网页仍在等待答复/);assert.match(f.get('status').textContent,/95 秒/);assert.deepEqual(f.order,[]);
});
test('freshness is recomputed on display instead of trusting an old healthy projection',()=>{
 const f=fixture();assert.match(f.summary({state:'watching',bound:true,observer_recent:true,updated_at:Date.now()-46000}),/页面观察已过期/);
});
