'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createExitLifecycle,reason}=require('../exit-lifecycle.cjs');
const {spawn}=require('node:child_process'),{RuntimeBridge}=require('../runtime-bridge.cjs');
function quitDialog(exit){
 const src=fs.readFileSync(path.join(__dirname,'../shell.js'),'utf8'),start=src.indexOf('function renderExitFeedback('),end=src.indexOf('\nfunction newTask(',start),nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{attributes:{},setAttribute(k,v){this.attributes[k]=v;}});return nodes.get(id);};
 const context={$:node,busy:new Set(),dialogAction:{kind:'quit'},state:{pages:[{id:'camp',title:'Camp Dungeon'}],exit}};vm.runInNewContext(src.slice(start,end),context);return {context,node};
}
test('the exit intent keeps its original identity and only marks each owner dispatch once',()=>{
 const life=createExitLifecycle({newId:()=> '11111111-2222-4333-8444-555555555555'}),first=life.begin({operation_id:'api-original'});life.dispatched('native');assert.equal(life.dispatched('native'),false);assert.equal(life.begin({maintenance:true}).exit_id,first.exit_id);assert.equal(life.snapshot().mode,'ordinary');
 life.exited('native');life.dispatched('host');life.exited('host');life.update('save-failed',{blocked_reasons:reason(Error('exit_record_storage_failed'))});assert.equal(life.snapshot().owners.host,true);assert.equal(life.snapshot().shutdown.native,true);assert.throws(()=>life.assert('foreign'),/context_changed/);assert.equal(life.snapshot().operation_id,'api-original');
});
test('concurrent lifecycle consumers await one proof work package',async()=>{
 const life=createExitLifecycle();life.begin();let release,runs=0;const first=life.run(()=>{runs++;return new Promise(resolve=>release=resolve);}),second=life.run(()=>{runs++;});await Promise.resolve();assert.equal(runs,1);release('one-result');assert.equal(await first,'one-result');assert.equal(await second,'one-result');assert.equal(life.pending,null);
});
test('the actual quit dialog shows loading, specific blockers and the original operation to reconcile',()=>{
 const {context,node}=quitDialog({state:'checking',operation_id:'quit-original',blocked_reasons:[]});context.renderExitFeedback();assert.equal(node('dialog-confirm').disabled,true);assert.match(node('dialog-confirm').textContent,/正在退出/);assert.equal(node('task-dialog').attributes['aria-busy'],'true');
 context.state.exit={state:'awaiting-original-exit',operation_id:'quit-original',blocked_reasons:[{code:'browser_generating',page_id:'camp',request_id:'request-original'}]};context.renderExitFeedback();assert.equal(node('dialog-confirm').disabled,false);assert.equal(node('dialog-confirm').textContent,'接续原退出');assert.match(node('dialog-description').textContent,/Camp Dungeon.*网页正在生成/);assert.match(node('dialog-description').textContent,/request-original/);assert.match(node('dialog-description').textContent,/quit-original/);
});
test('exit reasons expose bounded Job identities and scope without copying command or log bodies',()=>{
 const row={kind:'owned_jobs',project:'agent:diagnostic:owned',session_id:'wc_sess_original',status:'recovering',command_execution_state:'outcome_unknown',job_ids:Array.from({length:24},(_,i)=>'job-'+i+'x'.repeat(220)),body:'private log',command:'private command',other_scope:'not allowed'};
 const [value]=reason({blockedReasons:[row]});assert.equal(value.project,row.project);assert.equal(value.session_id,row.session_id);assert.equal(value.status,'recovering');assert.equal(value.command_execution_state,'outcome_unknown');assert.equal(value.job_ids.length,16);assert.equal(value.job_ids[0].length,200);assert.equal(Object.hasOwn(value,'body'),false);assert.equal(Object.hasOwn(value,'command'),false);assert.equal(Object.hasOwn(value,'other_scope'),false);
 const {context,node}=quitDialog({state:'blocked',operation_id:'quit-original',blocked_reasons:[value]});context.renderExitFeedback();assert.match(node('dialog-description').textContent,/状态 正在恢复/);assert.match(node('dialog-description').textContent,/执行结果未知/);assert.equal(node('dialog-description').textContent.includes('job-16'),false);assert.equal(node('dialog-confirm').textContent,'退出');
});
test('actual Host Job proof blockers cross a real Python pipe, lifecycle reason and quit dialog',async t=>{
 const script=`import sys,json,time
sys.path.insert(0,sys.argv[1])
from maintenance_exit_readiness import job_read
from harness_state import HarnessError
from harness_job_inventory import ACTIVE
project,session='agent:diagnostic:owned','wc_sess_original'
class Transport:
 client_id='diagnostic'
 def __init__(self,row):self.row=row
 def post(self,op,p,deadline):
  if op=='status':
   s=self.row['status'];return {'service':'webcodex','version':'0.4.1','focus':{'client_id':self.client_id,'connected':True},'jobs':{'active_count':int(s in ACTIVE),'running_count':int(s in ('running','started')),'queued_count':int(s in ('queued','agent_queued'))}}
  if op=='detail':return {'session_id':session,'running_call':False,'running_jobs':0}
  jobs=[self.row] if self.row['status']==p['status'] else []
  return {'jobs':jobs,'count':len(jobs),'matched_count':len(jobs),'truncated':False}
print('CLW_MANAGED_READY '+json.dumps({'protocol':'clw.managed-browser.v1','store_id':'diagnostic-store','instance_id':'a'*32}),flush=True)
for line in sys.stdin:
 frame=json.loads(line)
 if frame['op']=='shutdown':break
 p=frame['payload'];row={'job_id':'job-original-'+p['status'],'client_id':'diagnostic','project':project,'session_id':session,'status':p['status'],'command_execution_state':p.get('command_execution_state')}
 try:
  result=job_read(Transport(row),{(project,session)},time.monotonic()+12,{(project,session)},exit_mode='ordinary')
  response={'id':frame['id'],'ok':True,'result':result}
 except HarnessError as error:response={'id':frame['id'],'ok':False,'code':str(error),'blockers':error.blockers}
 print('CLW_MANAGED '+json.dumps(response),flush=True)
`;
 let child;const runtime=new RuntimeBridge('diagnostic-only',{restartDelays:[],startupTimeoutMs:5000,receiptTimeoutMs:5000,closeTimeoutMs:1000,spawnProcess:()=>child=spawn(process.env.CLW_PYTHON||'python',['-X','utf8','-B','-c',script,path.resolve(__dirname,'../../../scripts')],{windowsHide:true,stdio:['pipe','pipe','pipe']})});
 t.after(async()=>{await runtime.close();if(child?.exitCode===null)child.kill();});await runtime.start();
 for(const [status,label] of [['queued','排队中'],['agent_queued','代理队列中'],['started','已开始'],['running','正在执行'],['stop_requested','已请求停止，仍待结束'],['recovering','正在恢复'],['failed','执行失败'],['lost','执行记录丢失']]){
  const unknown=['failed','lost'].includes(status);let error;try{await runtime.call('maintenance-readiness',{status,command_execution_state:unknown?'outcome_unknown':null});assert.fail('original owned Job must block');}catch(value){error=value;}
  assert.equal(error.protocolRefused,true);assert.equal(error.code,unknown?'maintenance_jobs_unverified':'maintenance_jobs_active');
  const life=createExitLifecycle();life.begin({operation_id:'quit-original'});life.block(error);const exit=life.snapshot(),row=exit.blocked_reasons[0];assert.equal(row.project,'agent:diagnostic:owned');assert.equal(row.session_id,'wc_sess_original');assert.equal(row.status,status);assert.equal(unknown?row.job_id:row.job_ids[0],'job-original-'+status);if(unknown)assert.equal(row.command_execution_state,'outcome_unknown');
  const {context,node}=quitDialog(exit);context.renderExitFeedback();const text=node('dialog-description').textContent;for(const expected of ['Session wc_sess_original','范围 agent:diagnostic:owned','Job job-original-'+status,'状态 '+label,'退出操作：quit-original'])assert.ok(text.includes(expected),expected);assert.ok(text.includes(unknown?'执行结果未知':'原 Job 尚未结束'));assert.equal(node('dialog-confirm').disabled,false);assert.equal(runtime.ready,true);
 }
 await runtime.close();assert.equal(child.exitCode,0);
});
