'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const CLWTaskPresentation=require('../task-presentation.js');
const host=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(host,'shell.js'),'utf8');
const goalSource=source.slice(source.indexOf('// Refill is a local, durable operation;'),source.indexOf('let taskSelectionSerial='));
const identitySource=source.slice(source.indexOf('const current='),source.indexOf('function captureNoticeContext('));
const copy=value=>JSON.parse(JSON.stringify(value));

// Actual HTML and the entire goal command/presentation block run in a Node VM.
// Dialog/focus are platform stubs; no browser, page, model or GUI is started.
function fixture(options={}){
  const window=createWindow(fs.readFileSync(path.join(host,'index.html'),'utf8')),document=window.document;
  const nodes=id=>document.getElementById(id),storage=new Map(options.storage||[]),commands=[],receipts=new Map(),retired=new Set();
  if(!('dataset' in window.Element.prototype))Object.defineProperty(window.Element.prototype,'dataset',{get(){const node=this;return new Proxy({},{get:(_,key)=>node.getAttribute('data-'+key),set:(_,key,value)=>{node.setAttribute('data-'+key,String(value));return true;}});}});
  for(const dialog of Array.from(document.querySelectorAll('dialog'))){
    Object.defineProperty(dialog,'showModal',{value(){this.open=true;},configurable:true});
    Object.defineProperty(dialog,'close',{value(){this.open=false;this.onclose?.();},configurable:true});
  }
  for(const node of Array.from(document.querySelectorAll('textarea,button')))Object.defineProperty(node,'focus',{value(){},configurable:true});
  const goal={configured:true,mode:'manual',objective:'完成清晰可靠的产品\n保留真实工作成果',state:'paused',etag:'goal-1',revision:1,
    request_id:'original-request',cycles:0,review:null,can_review:true,can_start_next:false,next:null,...options.goal};
  const budget={etag:'budget-1',run_id:'original-run',scope:'next',used:7,limit:40,available_sends:33,available_seconds:18000,saved:false,can_continue:true,...options.budget};
  const original={id:'original-request',phase:'completed'};
  const page={id:'original-page',title:'原产品任务',bound:true,kind:'task',account:'A',paused:true,
    observation:{generating:false},latest_request:original,budget_status:budget,goal:{...goal}};
  const state={connected:true,connectionGeneration:1,selected:page.id,pages:[page],view:{page_id:page.id,thread_id:'original-thread',goal,latest_request:original,...options.view}};
  let failStorage=null,handler,unknownAction=null,readFails=false,packages=0;
  const localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>{if(failStorage===key)throw Error('disk unavailable');storage.set(key,String(value));}};
  const publish=()=>{page.goal={...state.view.goal};};
  async function command(action,payload){
    commands.push({action,payload:copy(payload)});
    if(handler)return handler(action,payload);
    if(action==='goal-read'){if(readFails)throw Error('runtime_receipt_unknown_reconcile_original');return {goal:copy(state.view.goal),model_sends:0};}
    if(['start','resume','budget-continue'].includes(action))throw Error('unexpected automatic send');
    if(receipts.has(payload.operation_id)){const previous=receipts.get(payload.operation_id);assert.deepEqual(copy(payload),previous.payload);return copy(previous.receipt);}
    const g=state.view.goal;let receipt;
    if(action==='goal-save'){
      Object.assign(g,{objective:payload.objective,mode:payload.mode||g.mode,configured:true,review:null,revision:g.revision+1,can_review:true,can_start_next:false});g.etag='goal-'+g.revision;
      receipt={state:'goal_saved',goal:copy(g),model_sends:0};
    }else if(action==='goal-review'){
      g.review={request_id:g.request_id,decision:payload.decision,note:payload.note,actor:'human'};
      Object.assign(g,{state:payload.decision==='complete'?'complete':'paused',revision:g.revision+1,can_review:payload.decision!=='complete',can_start_next:payload.decision==='continue'&&budget.can_continue});g.etag='goal-'+g.revision;
      receipt={state:'goal_review_saved',goal:copy(g),model_sends:0};
    }else if(action==='goal-continue'){
      packages++;receipt={state:'queued_for_web_host',request_id:payload.operation_id};
    }else if(action==='goal-discard'){
      retired.add(payload.expected_pending_id);Object.assign(g,{next:null,pending_id:null,next_recovery:null,can_review:true,can_start_next:true,revision:g.revision+1});g.etag='goal-'+g.revision;
      receipt={state:'goal_next_discarded',original_operation_id:payload.expected_pending_id,goal:copy(g),model_sends:0};
    }else if(action==='refill-budget'){
      budget.available_sends+=payload.add_dispatches;budget.available_seconds+=payload.add_seconds;budget.saved=true;budget.etag+='-updated';
      budget.can_continue=budget.available_sends>0&&budget.available_seconds>0;g.can_start_next=g.review?.decision==='continue'&&budget.can_continue;
      receipt={state:'budget_refilled',budget:copy(budget),model_sends:0};
    }else throw Error('Unexpected operation '+action);
    publish();receipts.set(payload.operation_id,{payload:copy(payload),receipt});
    if(unknownAction===action){unknownAction=null;throw Error('runtime_receipt_unknown_reconcile_original');}
    return receipt;
  }
  const c=vm.createContext({window,document,state,localStorage,$:nodes,CLWTaskPresentation,crypto:{randomUUID},
    busy:new Set(),newTaskDraft:null,workflowMode:'web',workflowEpoch:0,rendererConnectionEpoch:0,taskSelectionEpoch:0,
    readDrafts:key=>new Map(JSON.parse(storage.get(key)||'[]')),interactiveCommand:command,act:async(...args)=>{try{return await command(...args);}catch{return undefined;}},
    once:async(key,fn)=>{if(c.busy.has(key))return;c.busy.add(key);try{return await fn();}finally{c.busy.delete(key);}},
    render(){},scheduleLayout(){},showNotice(){},nativeView(){},details(){},drafts:new Map(),saveDrafts(){},
    captureNoticeContext:id=>({id}),noticeContextCurrent:owner=>state.selected===owner.id});
  vm.runInContext(identitySource+'\n'+goalSource,c,{filename:'shell-goal-block.js'});
  const evaluate=code=>vm.runInContext(code,c),settle=async()=>{for(let n=0;n<8;n++){await Promise.resolve();if(!evaluate("goalReadPending||busy.has('budget')"))return;}assert.fail('Goal operation did not settle');};
  const open=async()=>{c.openBudget();await settle();},paint=()=>c.renderBudget();
  const fill=(id,text)=>{nodes(id).value=text;nodes(id).oninput?.();};
  const submit=async(id)=>{await nodes(id).onsubmit({preventDefault(){}});await settle();};
  return {c,state,page,goal,budget,commands,receipts,retired,storage,nodes,evaluate,settle,open,paint,fill,submit,
    packages:()=>packages,unknown:action=>{unknownAction=action;},readFails:()=>{readFails=true;},failStorage:(key='clw-goal-drafts')=>{failStorage=key;},handle:next=>{handler=next;}};
}

test('saved goal opens as exact readable text and one review stage, without mutation or model send',async()=>{
  const h=fixture({goal:{objective:'\n  原目标  中文\n\n真实验收'}});await h.open();
  assert.equal(h.nodes('goal-objective-view').textContent,h.goal.objective);assert.equal(h.nodes('goal-form').hidden,true);
  assert.equal(h.nodes('goal-edit').hidden,false);assert.equal(h.nodes('goal-review-section').hidden,false);
  assert.equal(h.nodes('budget-continue-section').hidden,true);assert.equal(h.nodes('budget-details').hidden,false);assert.equal(h.nodes('budget-details').open,false);
  assert.match(h.nodes('goal-package-status').textContent,/成果已保存.*等待验收/);
  assert.deepEqual(h.commands.map(x=>x.action),['goal-read']);assert.equal(h.packages(),0);
});

test('automatic goal reads delivered or external-wait status without a human review or extra send',async()=>{
  const h=fixture({goal:{mode:'automatic',state:'complete',display_state:'delivered',can_review:true}});await h.open();
  assert.equal(h.nodes('goal-package-status').textContent,'已交付');
  assert.equal(h.nodes('goal-review-section').hidden,true);assert.equal(h.nodes('budget-continue-section').hidden,true);
  h.state.view.goal={...h.state.view.goal,state:'active',display_state:'waiting',wait_context:{job_ids:['original-job'],result:'仿真结果',resume:'完成后分析'}};h.paint();
  assert.equal(h.nodes('goal-package-status').textContent,'等待结果');assert.equal(h.commands.length,1);assert.equal(h.packages(),0);
});

test('switching an existing goal to automatic persists its choice and never resumes a paused original task',async()=>{
  const h=fixture();await h.open();h.nodes('goal-edit').onclick();
  h.nodes('goal-auto-continue').checked=true;h.nodes('goal-auto-continue').onchange();
  h.nodes('budget-close').onclick();await h.open();
  assert.equal(h.nodes('goal-auto-continue').checked,true);assert.equal(h.nodes('goal-save').disabled,false);
  await h.submit('goal-form');
  assert.equal(h.commands.find(row=>row.action==='goal-save').payload.mode,'automatic');
  assert.equal(h.page.paused,true);assert.equal(h.packages(),0);
  assert.equal(h.nodes('goal-review-section').hidden,true);
});

test('editing is explicit, persists exact dirty draft across close/reopen and saving returns to overview without sending',async()=>{
  const h=fixture();await h.open();h.nodes('goal-edit').onclick();
  h.fill('goal-objective','\n  新目标  𠮷\n\n完整要求');assert.equal(h.nodes('goal-form').hidden,false);assert.equal(h.nodes('goal-review-section').hidden,true);
  h.nodes('budget-close').onclick();await h.open();assert.equal(h.nodes('goal-objective').value,'\n  新目标  𠮷\n\n完整要求');
  assert.equal(h.nodes('goal-form').hidden,false);await h.submit('goal-form');
  assert.equal(h.nodes('goal-form').hidden,true);assert.equal(h.nodes('goal-objective-view').textContent,'\n  新目标  𠮷\n\n完整要求');
  assert.equal(h.evaluate("goalDrafts.has('original-page')"),false);assert.equal(h.page.paused,true);assert.equal(h.packages(),0);
  assert.equal(h.commands.filter(x=>x.action!=='goal-read').length,1);assert.match(h.nodes('goal-feedback').textContent,/没有发送/);
});

test('explicit cancel discards only local goal edits, while a persistence failure preserves the draft',async()=>{
  const h=fixture();await h.open();h.nodes('goal-edit').onclick();h.fill('goal-objective','取消的本机草稿');h.nodes('goal-edit-cancel').onclick();
  assert.equal(h.nodes('goal-objective').value,h.goal.objective);assert.equal(h.nodes('goal-form').hidden,true);assert.equal(h.evaluate("goalDrafts.has('original-page')"),false);
  assert.equal(h.commands.filter(x=>x.action!=='goal-read').length,0);
  h.nodes('goal-edit').onclick();h.fill('goal-objective','磁盘失败仍保留');h.failStorage();h.nodes('goal-edit-cancel').onclick();
  assert.equal(h.nodes('goal-objective').value,'磁盘失败仍保留');assert.equal(h.evaluate("goalDrafts.get('original-page')"),'磁盘失败仍保留');
  assert.equal(h.nodes('goal-form').hidden,false);assert.match(h.nodes('goal-feedback').textContent,/暂未保存/);assert.equal(h.packages(),0);
});

test('current package summary reads original request phase and never authorizes human review during execution',async()=>{
  const h=fixture({goal:{state:'active',can_review:true},view:{request:{id:'original-request',phase:'processing'}}});await h.open();
  assert.match(h.nodes('goal-package-status').textContent,/执行记录未结清/);assert.equal(h.nodes('goal-review-section').hidden,true);
  assert.equal(h.nodes('budget-continue-section').hidden,true);assert.equal(h.nodes('goal-form').hidden,true);
  h.state.view.request.phase='queued';h.paint();assert.match(h.nodes('goal-package-status').textContent,/已排队/);
  h.state.view.request.id='foreign-request';h.paint();assert.match(h.nodes('goal-package-status').textContent,/待核对/);assert.equal(h.nodes('goal-edit').disabled,true);
  assert.equal(h.packages(),0);
});

test('goal state alone cannot claim an active package or human completion',async()=>{
  const h=fixture({goal:{state:'active',can_review:false},view:{latest_request:null}});await h.open();
  assert.match(h.nodes('goal-package-status').textContent,/记录待核对/);
  h.state.view.goal={...h.state.view.goal,state:'complete'};h.paint();assert.doesNotMatch(h.nodes('goal-package-status').textContent,/由你验收完成/);
  h.state.view.goal={...h.state.view.goal,mode:'automatic',review:{request_id:h.goal.request_id,decision:'complete',note:'自动结果'}};h.paint();
  assert.equal(h.nodes('goal-package-status').textContent,'已交付');assert.equal(h.nodes('budget-continue-section').hidden,true);
  h.state.view.goal={...h.state.view.goal,mode:'manual',review:{...h.state.view.goal.review,actor:'human'}};h.paint();assert.equal(h.nodes('goal-package-status').textContent,'目标已由你验收完成');
});

test('human decisions have a concise summary and editing a decision hides next-package submission',async()=>{
  const h=fixture();await h.open();h.fill('goal-review-notes','确认成果；下包提高稳定性。');await h.submit('goal-review-form');
  assert.equal(h.nodes('goal-review-section').hidden,true);assert.equal(h.nodes('goal-review-edit').hidden,false);
  assert.match(h.nodes('goal-review-summary').textContent,/验收已保存.*继续推进\n确认成果/);assert.equal(h.nodes('budget-continue-section').hidden,false);
  assert.equal(h.nodes('budget-continue').disabled,false);assert.equal(h.packages(),0);
  h.nodes('goal-review-edit').onclick();assert.equal(h.nodes('goal-review-section').hidden,false);assert.equal(h.nodes('budget-continue-section').hidden,true);
  h.nodes('goal-review-decision').value='revise';await h.submit('goal-review-form');
  assert.equal(h.nodes('goal-review-section').hidden,true);assert.match(h.nodes('goal-package-status').textContent,/需要修正/);
  assert.equal(h.nodes('goal-review-edit').hidden,false);assert.equal(h.nodes('budget-continue-section').hidden,true);assert.equal(h.packages(),0);
});

test('unknown saved goal remains visible and reuses its exact original operation after close and reopen',async()=>{
  const h=fixture();await h.open();h.nodes('goal-edit').onclick();h.fill('goal-objective','未知保存保留原目标');h.unknown('goal-save');await h.submit('goal-form');
  assert.equal(h.nodes('goal-form').hidden,false);assert.equal(h.nodes('goal-edit-cancel').hidden,true);assert.match(h.nodes('goal-save').textContent,/核对原/);
  assert.equal(h.nodes('goal-objective').disabled,true);h.nodes('budget-close').onclick();await h.open();await h.submit('goal-form');
  const calls=h.commands.filter(x=>x.action==='goal-save');assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);
  assert.equal(h.receipts.size,1);assert.equal(h.packages(),0);assert.equal(h.nodes('goal-form').hidden,true);
});

test('an unknown review is visible even when canonical eligibility changes and reconciles only the old intent',async()=>{
  const h=fixture();await h.open();h.unknown('goal-review');await h.submit('goal-review-form');h.goal.can_review=false;h.goal.mode='automatic';h.paint();
  assert.equal(h.nodes('goal-review-section').hidden,false);assert.match(h.nodes('goal-review-save').textContent,/核对原验收/);
  assert.equal(h.nodes('goal-review-save').disabled,false);h.nodes('budget-close').onclick();await h.open();await h.submit('goal-review-form');
  const calls=h.commands.filter(x=>x.action==='goal-review');assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);
  assert.equal(h.receipts.size,1);assert.equal(h.packages(),0);
});

test('unknown next-package receipt remains accessible and reconciling does not create a second package',async()=>{
  const h=fixture();await h.open();await h.submit('goal-review-form');h.fill('budget-instructions','只提交完整原包');h.unknown('goal-continue');
  await h.nodes('budget-continue').onclick();await h.settle();h.goal.can_start_next=false;h.goal.mode='automatic';h.paint();
  assert.equal(h.nodes('budget-continue-section').hidden,false);assert.match(h.nodes('budget-continue').textContent,/核对原下一包/);assert.equal(h.nodes('budget-instructions').disabled,true);
  h.nodes('budget-close').onclick();await h.open();await h.nodes('budget-continue').onclick();await h.settle();
  const calls=h.commands.filter(x=>x.action==='goal-continue');assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);
  assert.equal(h.packages(),1);assert.equal(h.nodes('budget-dialog').open,false);
});

test('budget receipt reconciliation stays reachable in an independent open fold and preserves its original key',async()=>{
  const h=fixture();await h.open();h.fill('refill-sends','12');h.fill('refill-hours','2');h.unknown('refill-budget');await h.submit('budget-form');
  assert.equal(h.nodes('budget-details').hidden,false);assert.equal(h.nodes('budget-details').open,true);assert.equal(h.nodes('budget-continue-section').hidden,true);
  h.nodes('budget-close').onclick();await h.open();await h.submit('budget-form');
  const calls=h.commands.filter(x=>x.action==='refill-budget');assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);
  assert.equal(h.budget.available_sends,45);assert.equal(h.budget.available_seconds,25200);assert.equal(h.page.paused,true);assert.equal(h.packages(),0);
});

test('a prepared original package and safe discard stay visible beside a preserved dirty draft, without new sends',async()=>{
  const h=fixture({goal:{next:{state:'goal_next_prepared',operation_id:'prepared-original',expected_run_id:'original-run'},pending_id:'prepared-original',can_review:false,
    next_recovery:{can_discard:true,send_state:'not_sent'}}});
  h.evaluate("goalDrafts.set('original-page','待保存草稿')");await h.open();
  assert.equal(h.nodes('goal-form').hidden,false);assert.equal(h.nodes('budget-continue-section').hidden,false);assert.equal(h.nodes('budget-continue').disabled,true);
  assert.equal(h.nodes('goal-discard').hidden,false);assert.match(h.nodes('goal-package-status').textContent,/原下一包待核对/);
  assert.equal(h.nodes('goal-objective').value,'待保存草稿');assert.equal(h.commands.filter(x=>x.action!=='goal-read').length,0);assert.equal(h.packages(),0);
});

test('unknown discard remains independently accessible even after canonical preparation disappears',async()=>{
  const h=fixture({goal:{next:{state:'goal_next_prepared',operation_id:'prepared-original',expected_run_id:'original-run'},pending_id:'prepared-original',can_review:false,
    next_recovery:{can_discard:true,send_state:'not_sent'}}});await h.open();h.unknown('goal-discard');
  await h.nodes('goal-discard').onclick();await h.settle();assert.equal(h.nodes('goal-discard').hidden,false);assert.match(h.nodes('goal-discard').textContent,/核对原撤销/);
  h.nodes('budget-close').onclick();await h.open();await h.nodes('goal-discard').onclick();await h.settle();
  const calls=h.commands.filter(x=>x.action==='goal-discard');assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);
  assert.deepEqual([...h.retired],['prepared-original']);assert.equal(h.packages(),0);
});

test('cached goal eligibility never opens review or next package after a failed canonical read',async()=>{
  const h=fixture({goal:{review:{request_id:'original-request',decision:'continue',actor:'human'},can_start_next:true}});h.readFails();await h.open();
  assert.equal(h.nodes('goal-form').hidden,true);assert.equal(h.nodes('goal-objective-view').textContent,h.goal.objective);
  assert.equal(h.nodes('goal-review-section').hidden,true);assert.equal(h.nodes('budget-continue-section').hidden,true);assert.equal(h.nodes('goal-edit').disabled,true);
  assert.match(h.nodes('goal-package-detail').textContent,/尚未核验/);assert.deepEqual(h.commands.map(x=>x.action),['goal-read']);
});

test('late accepted save cannot claim success or discard a draft after connection or selected identity changes',async t=>{
  for(const change of [h=>h.state.connectionGeneration++,h=>{h.state.selected='other';},h=>{h.c.workflowMode='local';h.c.workflowEpoch++;}])await t.test(String(change),async()=>{
    const h=fixture();await h.open();h.nodes('goal-edit').onclick();h.fill('goal-objective','原任务草稿');let finish;
    h.handle(action=>action==='goal-save'?new Promise(resolve=>{finish=resolve;}):{goal:copy(h.goal),model_sends:0});
    const saving=h.nodes('goal-form').onsubmit({preventDefault(){}});assert.equal(typeof finish,'function');change(h);
    finish({state:'goal_saved',goal:{...copy(h.goal),objective:'原任务草稿',revision:2,etag:'goal-2'},model_sends:0});await saving;
    assert.doesNotMatch(h.nodes('goal-feedback').textContent,/目标已保存/);assert.equal(h.evaluate("goalDrafts.get('original-page')"),'原任务草稿');
    assert.equal(h.nodes('goal-save').disabled,true);assert.equal(h.packages(),0);
  });
});

test('dirty goal and invalid review input cannot approve or start a new package, and completion requires explicit review',async()=>{
  const h=fixture();await h.open();h.nodes('goal-edit').onclick();h.fill('goal-objective','未保存目标');
  assert.equal(h.nodes('goal-review-save').disabled,true);assert.equal(h.nodes('budget-continue').disabled,true);await h.submit('goal-review-form');
  assert.equal(h.commands.filter(x=>x.action==='goal-review').length,0);h.nodes('goal-edit-cancel').onclick();h.fill('goal-review-notes','整'.repeat(6001));
  await h.submit('goal-review-form');assert.equal(h.commands.filter(x=>x.action==='goal-review').length,0);assert.match(h.nodes('goal-feedback').textContent,/超过 6000/);
  h.fill('goal-review-notes','真实成果已逐项验收');h.nodes('goal-review-decision').value='complete';await h.submit('goal-review-form');
  assert.equal(h.nodes('budget-continue-section').hidden,true);assert.equal(h.nodes('goal-review-section').hidden,true);
  assert.match(h.nodes('goal-package-status').textContent,/由你验收完成/);assert.equal(h.packages(),0);
});

test('an untouched overview follows a new canonical goal without manufacturing an old-text draft or rollback',async()=>{
  const h=fixture();await h.open();const oldText=h.nodes('goal-objective').value;
  Object.assign(h.state.view.goal,{objective:'\n  另一入口的新目标  中文\n完整验收',revision:2,etag:'goal-2'});h.paint();
  assert.equal(h.nodes('goal-form').hidden,true);assert.equal(h.nodes('goal-objective-view').textContent,h.state.view.goal.objective);
  assert.equal(h.nodes('goal-objective').value,h.state.view.goal.objective);assert.notEqual(h.nodes('goal-objective').value,oldText);
  assert.equal(h.nodes('goal-save').hidden,true);assert.equal(h.evaluate("goalDrafts.has('original-page')"),false);
  await h.submit('goal-form');assert.equal(h.commands.filter(x=>x.action==='goal-save').length,0);assert.equal(h.packages(),0);
});

test('dirty goal keeps its persisted original CAS until an explicit local confirmation, including close and reopen',async()=>{
  const h=fixture();await h.open();h.nodes('goal-edit').onclick();h.fill('goal-objective','\n  原明确编辑稿  𠮷');
  const basis=copy(h.evaluate('goalEditBasis'));
  Object.assign(h.state.view.goal,{objective:'另一正常入口的新目标',revision:2,etag:'goal-2'});h.paint();
  assert.deepEqual(copy(h.evaluate('goalEditBasis')),basis);assert.equal(h.nodes('goal-objective').value,'\n  原明确编辑稿  𠮷');
  assert.equal(h.nodes('goal-objective-view').hidden,false);assert.equal(h.nodes('goal-objective-view').textContent,'另一正常入口的新目标');
  for(const id of ['goal-save','goal-review-save','budget-continue'])assert.equal(h.nodes(id).disabled,true,id);
  assert.match(h.nodes('goal-feedback').textContent,/另一入口更新/);await h.submit('goal-form');assert.equal(h.commands.filter(x=>x.action==='goal-save').length,0);
  h.nodes('budget-close').onclick();await h.open();assert.deepEqual(copy(h.evaluate('goalEditBasis')),basis);assert.equal(h.nodes('goal-save').disabled,true);
  assert.equal(JSON.parse(h.storage.get('clw-goal-draft-bases'))[0][1].etag,'goal-1');
  const before=h.commands.length;h.nodes('goal-edit').onclick();assert.equal(h.commands.length,before);assert.equal(h.packages(),0);
  assert.equal(h.evaluate('goalEditBasis.etag'),'goal-2');assert.equal(h.nodes('goal-objective').value,'\n  原明确编辑稿  𠮷');assert.equal(h.nodes('goal-save').disabled,false);
  await h.submit('goal-form');const saved=h.commands.find(x=>x.action==='goal-save');
  assert.equal(saved.payload.expected_etag,'goal-2');assert.equal(saved.payload.objective,'\n  原明确编辑稿  𠮷');assert.equal(h.packages(),0);
});

test('an editor with no typed changes still retains its original basis when canonical goal changes',async()=>{
  const h=fixture();await h.open();h.nodes('goal-edit').onclick();const oldText=h.nodes('goal-objective').value;
  Object.assign(h.state.view.goal,{objective:'当前已保存的新目标',revision:2,etag:'goal-2'});h.paint();
  assert.equal(h.nodes('goal-objective').value,oldText);assert.equal(h.evaluate('goalEditBasis.etag'),'goal-1');assert.equal(h.nodes('goal-save').disabled,true);
  assert.match(h.nodes('goal-edit').textContent,/确认当前目标/);await h.submit('goal-form');assert.equal(h.commands.filter(x=>x.action==='goal-save').length,0);
  h.nodes('goal-edit-cancel').onclick();assert.equal(h.nodes('goal-objective').value,'当前已保存的新目标');assert.equal(h.nodes('goal-form').hidden,true);
});

test('a legacy local draft without its original basis requires explicit confirmation rather than silently adopting a new CAS',async()=>{
  const h=fixture();h.evaluate("goalDrafts.set('original-page','原旧本机草稿')");await h.open();
  assert.equal(h.nodes('goal-objective').value,'原旧本机草稿');assert.equal(h.nodes('goal-save').disabled,true);
  assert.equal(h.nodes('goal-objective-view').hidden,false);assert.match(h.nodes('goal-feedback').textContent,/缺少编辑基准/);
  await h.submit('goal-form');assert.equal(h.commands.filter(x=>x.action==='goal-save').length,0);
  h.nodes('goal-edit').onclick();assert.equal(h.nodes('goal-objective').value,'原旧本机草稿');assert.equal(h.nodes('goal-save').disabled,false);assert.equal(h.packages(),0);
});

test('unknown save payload is never rebased when a newer canonical goal arrives before original reconciliation',async()=>{
  const h=fixture();await h.open();h.nodes('goal-edit').onclick();h.fill('goal-objective','原已受理但回执未知的目标');h.unknown('goal-save');await h.submit('goal-form');
  Object.assign(h.state.view.goal,{objective:'后续正常入口保存的新目标',revision:3,etag:'goal-3'});h.paint();
  assert.equal(h.nodes('goal-objective').value,'原已受理但回执未知的目标');assert.equal(h.nodes('goal-save').disabled,false);assert.match(h.nodes('goal-save').textContent,/核对原目标/);
  h.nodes('budget-close').onclick();await h.open();await h.submit('goal-form');
  const calls=h.commands.filter(x=>x.action==='goal-save');assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);
  assert.equal(calls[1].payload.expected_etag,'goal-1');assert.equal(h.state.view.goal.objective,'后续正常入口保存的新目标');
  assert.equal(h.nodes('goal-form').hidden,true);assert.equal(h.nodes('goal-objective-view').textContent,'后续正常入口保存的新目标');assert.equal(h.packages(),0);
});

test('a delayed canonical read preserves dirty text and original basis while a newer canonical revision wins',async()=>{
  const h=fixture();await h.open();h.nodes('goal-edit').onclick();h.fill('goal-objective','保留本机实际编辑稿');let finish;
  h.handle(action=>action==='goal-read'?new Promise(resolve=>{finish=resolve;}):undefined);
  const read=h.c.readDialogGoal();Object.assign(h.state.view.goal,{objective:'另一入口的新目标',revision:2,etag:'goal-2'});
  finish({goal:{...copy(h.state.view.goal),objective:'旧读取快照',revision:1,etag:'goal-1'},model_sends:0});await read;
  assert.equal(h.nodes('goal-objective').value,'保留本机实际编辑稿');assert.equal(h.evaluate('goalEditBasis.etag'),'goal-1');
  assert.equal(h.nodes('goal-objective-view').textContent,'另一入口的新目标');assert.equal(h.nodes('goal-save').disabled,true);assert.equal(h.packages(),0);
});

test('failed persistence of a confirmed new basis cannot enable saving against that basis',async()=>{
  const h=fixture();await h.open();h.nodes('goal-edit').onclick();h.fill('goal-objective','原编辑稿');
  Object.assign(h.state.view.goal,{objective:'新目标',revision:2,etag:'goal-2'});h.paint();h.failStorage('clw-goal-draft-bases');h.nodes('goal-edit').onclick();h.paint();
  assert.equal(h.evaluate('goalEditBasis.etag'),'goal-1');assert.equal(h.nodes('goal-save').disabled,true);assert.equal(h.nodes('goal-objective').value,'原编辑稿');
  await h.submit('goal-form');assert.equal(h.commands.filter(x=>x.action==='goal-save').length,0);assert.equal(h.packages(),0);
});

const reviewedGoal={review:{request_id:'original-request',decision:'continue',note:'第一版验收',actor:'human'},can_start_next:true};
function externalReview(h,decision='revise',note='另一入口更新的验收'){
  Object.assign(h.state.view.goal,{revision:2,etag:'goal-2',review:{request_id:'original-request',decision,note,actor:'human'},can_start_next:decision==='continue'});
  h.paint();
}

test('untouched review fields follow canonical changes without manufacturing an edit or resaving old acceptance',async()=>{
  const h=fixture({goal:reviewedGoal});await h.open();externalReview(h);
  assert.equal(h.nodes('goal-review-decision').value,'revise');assert.equal(h.nodes('goal-review-notes').value,'另一入口更新的验收');
  assert.equal(h.nodes('goal-review-section').hidden,true);assert.match(h.nodes('goal-review-summary').textContent,/需要修正\n另一入口/);
  await h.submit('goal-review-form');assert.equal(h.commands.filter(x=>x.action==='goal-review').length,0);assert.equal(h.packages(),0);
});

test('a dirty review preserves its own CAS across close and reload, and cannot overwrite a newer revise decision',async()=>{
  const h=fixture({goal:reviewedGoal});await h.open();h.nodes('goal-review-edit').onclick();h.fill('goal-review-notes','本机修改的验收稿');
  externalReview(h);assert.equal(h.nodes('goal-review-decision').value,'continue');assert.equal(h.nodes('goal-review-notes').value,'本机修改的验收稿');
  assert.equal(h.evaluate('goalReviewBasis.etag'),'goal-1');assert.equal(h.nodes('goal-review-save').disabled,true);assert.equal(h.nodes('budget-continue').disabled,true);
  assert.match(h.nodes('goal-review-summary').textContent,/另一入口更新/);await h.submit('goal-review-form');assert.equal(h.commands.filter(x=>x.action==='goal-review').length,0);
  h.nodes('budget-close').onclick();await h.open();assert.equal(h.nodes('goal-review-notes').value,'本机修改的验收稿');assert.equal(h.nodes('goal-review-save').disabled,true);
  const restarted=fixture({storage:[...h.storage],goal:copy(h.state.view.goal)});await restarted.open();
  assert.equal(restarted.evaluate('goalReviewBasis.etag'),'goal-1');assert.equal(restarted.nodes('goal-review-save').disabled,true);
  const before=restarted.commands.length;restarted.nodes('goal-edit').onclick();assert.equal(restarted.commands.length,before);assert.equal(restarted.packages(),0);
  assert.equal(restarted.evaluate('goalReviewBasis.etag'),'goal-2');assert.equal(restarted.nodes('goal-review-save').disabled,false);
  await restarted.submit('goal-review-form');const saved=restarted.commands.find(x=>x.action==='goal-review');
  assert.equal(saved.payload.expected_etag,'goal-2');assert.equal(saved.payload.decision,'continue');assert.equal(saved.payload.note,'本机修改的验收稿');assert.equal(restarted.packages(),0);
});

test('changing only the review decision counts as an edit and never silently receives a newer review CAS',async()=>{
  const h=fixture();await h.open();h.nodes('goal-review-decision').value='complete';h.nodes('goal-review-decision').onchange();externalReview(h);
  assert.equal(h.nodes('goal-review-decision').value,'complete');assert.equal(h.evaluate('goalReviewBasis.etag'),'goal-1');assert.equal(h.nodes('goal-review-save').disabled,true);
  await h.submit('goal-review-form');assert.equal(h.commands.filter(x=>x.action==='goal-review').length,0);assert.equal(h.packages(),0);
});

test('next-package guidance keeps its original goal and run basis after a newer canonical review arrives',async()=>{
  const h=fixture({goal:reviewedGoal});await h.open();h.fill('budget-instructions','\n  原下一包完整重点  𠮷');externalReview(h,'continue','另一入口确认的新重点');
  assert.equal(h.nodes('budget-instructions').value,'\n  原下一包完整重点  𠮷');assert.equal(h.evaluate('goalNextBasis.etag'),'goal-1');
  assert.equal(h.nodes('budget-continue-section').hidden,false);assert.equal(h.nodes('budget-continue').disabled,true);assert.match(h.nodes('goal-review-summary').textContent,/另一入口确认/);
  await h.nodes('budget-continue').onclick();assert.equal(h.packages(),0);assert.equal(h.commands.filter(x=>x.action==='goal-continue').length,0);
  h.nodes('budget-close').onclick();await h.open();assert.equal(h.evaluate('goalNextBasis.etag'),'goal-1');assert.equal(h.nodes('budget-continue').disabled,true);
  const before=h.commands.length;h.nodes('goal-edit').onclick();assert.equal(h.commands.length,before);assert.equal(h.nodes('budget-continue').disabled,false);
  await h.nodes('budget-continue').onclick();const sent=h.commands.find(x=>x.action==='goal-continue');
  assert.equal(sent.payload.expected_etag,'goal-2');assert.equal(sent.payload.expected_run_id,'original-run');assert.equal(sent.payload.instructions,'\n  原下一包完整重点  𠮷');assert.equal(h.packages(),1);
});

test('confirming stale next-package guidance does not override a current revise review or start without current eligibility',async()=>{
  const h=fixture({goal:reviewedGoal});await h.open();h.fill('budget-instructions','旧下一包稿');externalReview(h);
  h.nodes('goal-edit').onclick();assert.equal(h.nodes('budget-instructions').value,'旧下一包稿');assert.equal(h.nodes('budget-continue').disabled,true);
  await h.nodes('budget-continue').onclick();assert.equal(h.packages(),0);
  h.nodes('goal-review-edit').onclick();h.nodes('goal-review-decision').value='continue';h.nodes('goal-review-decision').onchange();await h.submit('goal-review-form');
  assert.equal(h.nodes('budget-continue').disabled,true);h.nodes('goal-edit').onclick();assert.equal(h.nodes('budget-continue').disabled,false);
  assert.equal(h.packages(),0);await h.nodes('budget-continue').onclick();assert.equal(h.packages(),1);
});

test('a changed run is not silently substituted beneath an existing next-package draft',async()=>{
  const h=fixture({goal:reviewedGoal});await h.open();h.fill('budget-instructions','原run指导');h.budget.run_id='new-run';h.paint();
  assert.equal(h.evaluate('goalNextBasis.run_id'),'original-run');assert.equal(h.nodes('budget-continue').disabled,true);
  await h.nodes('budget-continue').onclick();assert.equal(h.commands.filter(x=>x.action==='goal-continue').length,0);assert.equal(h.packages(),0);
  h.nodes('goal-edit').onclick();assert.equal(h.evaluate('goalNextBasis.run_id'),'new-run');assert.equal(h.packages(),0);
});

test('unknown review reconciliation preserves original decision, text, key and CAS despite a newer canonical review',async()=>{
  const h=fixture();await h.open();h.fill('goal-review-notes','原未知验收稿');h.unknown('goal-review');await h.submit('goal-review-form');
  Object.assign(h.state.view.goal,{revision:3,etag:'goal-3',review:{request_id:'original-request',decision:'revise',note:'后续已保存的新验收',actor:'human'},can_start_next:false});h.paint();
  assert.equal(h.nodes('goal-review-save').disabled,false);h.nodes('budget-close').onclick();await h.open();await h.submit('goal-review-form');
  const calls=h.commands.filter(x=>x.action==='goal-review');assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);
  assert.equal(calls[1].payload.expected_etag,'goal-1');assert.equal(calls[1].payload.note,'原未知验收稿');
  assert.equal(h.state.view.goal.review.decision,'revise');assert.equal(h.nodes('goal-review-notes').value,'后续已保存的新验收');assert.equal(h.packages(),0);
});

test('unknown next-package reconciliation keeps the old guidance and submission while canonical review changes',async()=>{
  const h=fixture({goal:reviewedGoal});await h.open();h.fill('budget-instructions','原未知提交重点');h.unknown('goal-continue');await h.nodes('budget-continue').onclick();await h.settle();
  externalReview(h);assert.equal(h.nodes('budget-continue').disabled,false);h.nodes('budget-close').onclick();await h.open();await h.nodes('budget-continue').onclick();
  const calls=h.commands.filter(x=>x.action==='goal-continue');assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);
  assert.equal(calls[1].payload.expected_etag,'goal-1');assert.equal(calls[1].payload.instructions,'原未知提交重点');assert.equal(h.packages(),1);
});

test('delayed goal reads cannot replace a typed review decision or note with canonical fields',async()=>{
  const h=fixture({goal:reviewedGoal});await h.open();h.nodes('goal-review-edit').onclick();h.fill('goal-review-notes','异步期间保留的验收');
  h.nodes('goal-review-decision').value='complete';h.nodes('goal-review-decision').onchange();let finish;
  h.handle(action=>action==='goal-read'?new Promise(resolve=>{finish=resolve;}):undefined);const read=h.c.readDialogGoal();externalReview(h);
  finish({goal:{...copy(h.state.view.goal),revision:1,etag:'goal-1'},model_sends:0});await read;
  assert.equal(h.nodes('goal-review-notes').value,'异步期间保留的验收');assert.equal(h.nodes('goal-review-decision').value,'complete');
  assert.equal(h.evaluate('goalReviewBasis.etag'),'goal-1');assert.equal(h.nodes('goal-review-save').disabled,true);assert.equal(h.packages(),0);
});

test('failed persistence of a stage confirmation cannot enable the new CAS or discard the original local decision',async()=>{
  const h=fixture({goal:reviewedGoal});await h.open();h.nodes('goal-review-edit').onclick();h.fill('goal-review-notes','持久化失败仍保留');externalReview(h);
  h.failStorage('clw-goal-stage-drafts');h.nodes('goal-edit').onclick();h.paint();
  assert.equal(h.evaluate('goalReviewBasis.etag'),'goal-1');assert.equal(h.nodes('goal-review-save').disabled,true);assert.equal(h.nodes('goal-review-notes').value,'持久化失败仍保留');
  await h.submit('goal-review-form');assert.equal(h.commands.filter(x=>x.action==='goal-review').length,0);assert.equal(h.packages(),0);
});

test('explicitly canceling stage edits restores canonical review and removes only unsent local stage drafts',async()=>{
  const h=fixture({goal:reviewedGoal});await h.open();h.fill('budget-instructions','本机下一包稿');h.nodes('goal-review-edit').onclick();h.fill('goal-review-notes','本机验收稿');externalReview(h);
  assert.match(h.nodes('goal-review-edit').textContent,/取消本机阶段草稿/);h.nodes('goal-review-edit').onclick();
  assert.equal(h.nodes('goal-review-decision').value,'revise');assert.equal(h.nodes('goal-review-notes').value,'另一入口更新的验收');
  assert.equal(h.nodes('budget-instructions').value,'');assert.equal(h.evaluate("goalStageDrafts.has('original-page')"),false);
  assert.equal(h.commands.filter(x=>x.action!=='goal-read').length,0);assert.equal(h.packages(),0);
});

test('composer text enters only the current review or next-package stage and never submits by opening the dialog',async()=>{
  const review=fixture();review.nodes('objective').value='来自主输入的验收反馈';review.c.openBudget({fromComposer:true});await review.settle();
  assert.equal(review.nodes('goal-review-notes').value,'来自主输入的验收反馈');assert.equal(review.nodes('budget-instructions').value,'');assert.equal(review.packages(),0);
  const next=fixture({goal:reviewedGoal});next.nodes('objective').value='来自主输入的下一包重点';next.c.openBudget({fromComposer:true});await next.settle();
  assert.equal(next.nodes('budget-instructions').value,'来自主输入的下一包重点');assert.equal(next.nodes('goal-review-notes').value,'第一版验收');assert.equal(next.packages(),0);
  assert.deepEqual(next.commands.map(x=>x.action),['goal-read']);
});

test('editing a review keeps an existing next draft but exposes no fresh next-package action until review editing ends',async()=>{
  const h=fixture({goal:reviewedGoal});await h.open();h.fill('budget-instructions','仍需保留的下一包稿');h.nodes('goal-review-edit').onclick();
  assert.equal(h.nodes('goal-review-section').hidden,false);assert.equal(h.nodes('budget-continue-section').hidden,true);assert.equal(h.nodes('budget-continue').disabled,true);
  await h.nodes('budget-continue').onclick();assert.equal(h.packages(),0);
  h.nodes('goal-review-edit').onclick();assert.equal(h.nodes('goal-review-section').hidden,true);assert.equal(h.nodes('budget-continue-section').hidden,false);
  assert.equal(h.nodes('budget-instructions').value,'仍需保留的下一包稿');assert.equal(h.nodes('budget-continue').disabled,false);assert.equal(h.packages(),0);
});

test('switching through goal editing cannot forget an unsaved review draft or reveal fresh next-package submission',async()=>{
  const h=fixture({goal:reviewedGoal});await h.open();h.fill('budget-instructions','原下一包稿');h.nodes('goal-review-edit').onclick();h.fill('goal-review-notes','未保存的验收修改');
  h.nodes('goal-edit').onclick();h.nodes('goal-edit-cancel').onclick();
  assert.equal(h.nodes('goal-review-notes').value,'未保存的验收修改');assert.equal(h.nodes('goal-review-section').hidden,false);
  assert.equal(h.nodes('budget-continue-section').hidden,true);assert.equal(h.nodes('budget-continue').disabled,true);
  await h.nodes('budget-continue').onclick();assert.equal(h.packages(),0);assert.equal(h.commands.filter(x=>x.action==='goal-continue').length,0);
});

function deferredGoalRead(h){
  const reads=[];
  h.handle(action=>{assert.equal(action,'goal-read');return new Promise((resolve,reject)=>reads.push({resolve,reject}));});
  return reads;
}
const goalReadReceipt=(h,objective='原读取的目标')=>({goal:{...copy(h.goal),objective},model_sends:0});
async function flushGoalRead(){for(let i=0;i<12;i++)await Promise.resolve();}
function cancelGoalDialog(h){
  const event=new h.c.window.Event('cancel',{cancelable:true});h.nodes('budget-dialog').dispatchEvent(event);return event;
}

test('readonly goal loading permits close and Escape while all snapshot-dependent writes remain disabled',async()=>{
  for(const method of ['close','Escape']){
    const h=fixture(),reads=deferredGoalRead(h);h.c.openBudget();
    assert.equal(h.evaluate('goalReadPending'),true);assert.equal(h.nodes('budget-close').disabled,false);
    for(const id of ['goal-save','goal-review-save','budget-save','budget-continue'])assert.equal(h.nodes(id).disabled,true);
    if(method==='close')h.nodes('budget-close').onclick();
    else{assert.equal(cancelGoalDialog(h).defaultPrevented,false);h.nodes('budget-dialog').close();}
    assert.equal(h.nodes('budget-dialog').open,false);assert.equal(h.evaluate('goalReadPending'),false);
    reads[0].resolve(goalReadReceipt(h));await flushGoalRead();
    assert.equal(h.evaluate('goalSnapshot'),null);assert.deepEqual(h.commands.map(row=>row.action),['goal-read']);assert.equal(h.packages(),0);
  }
});

test('late read success after close and same-task reopen neither overwrites the new dialog nor clears its pending read',async()=>{
  const h=fixture(),reads=deferredGoalRead(h);h.c.openBudget();h.nodes('budget-close').onclick();h.c.openBudget();
  assert.equal(reads.length,2);reads[0].resolve(goalReadReceipt(h,'旧面板的目标'));await flushGoalRead();
  assert.equal(h.evaluate('goalReadPending'),true);assert.equal(h.evaluate('goalReadVerified'),false);assert.equal(h.evaluate('goalSnapshot'),null);
  assert.equal(h.nodes('goal-objective').value,h.goal.objective);assert.equal(h.nodes('goal-review-save').disabled,true);
  reads[1].resolve(goalReadReceipt(h,'重开面板的新目标'));await h.settle();
  assert.equal(h.evaluate('goalSnapshot.objective'),'重开面板的新目标');assert.equal(h.nodes('goal-objective').value,'重开面板的新目标');
  assert.equal(h.evaluate('goalReadPending'),false);assert.equal(h.evaluate('goalReadVerified'),true);assert.equal(h.packages(),0);
});

test('late read rejection after close cannot show an error or finish a newer dialog read',async()=>{
  const h=fixture(),reads=deferredGoalRead(h);h.c.openBudget();h.nodes('budget-close').onclick();h.c.openBudget();
  reads[0].reject(Error('runtime_receipt_unknown_reconcile_original'));await flushGoalRead();
  assert.equal(h.evaluate('goalReadPending'),true);assert.equal(h.evaluate('goalReadVerified'),false);assert.equal(h.nodes('goal-feedback').textContent,'');
  reads[1].resolve(goalReadReceipt(h));await h.settle();assert.equal(h.evaluate('goalReadVerified'),true);assert.equal(h.packages(),0);
});

test('two reads in one open dialog accept only the newest result and its loading completion',async()=>{
  const h=fixture(),reads=deferredGoalRead(h);h.c.openBudget();const newest=h.c.readDialogGoal();
  reads[0].resolve(goalReadReceipt(h,'较早读取'));await flushGoalRead();
  assert.equal(h.evaluate('goalReadPending'),true);assert.equal(h.evaluate('goalSnapshot'),null);
  reads[1].resolve(goalReadReceipt(h,'最新读取'));await newest;assert.equal(h.evaluate('goalSnapshot.objective'),'最新读取');
  assert.equal(h.evaluate('goalReadPending'),false);assert.equal(h.packages(),0);
});

test('an old read settling last cannot replace an already verified reopened goal snapshot',async()=>{
  const h=fixture(),reads=deferredGoalRead(h);h.c.openBudget();h.nodes('budget-close').onclick();h.c.openBudget();
  reads[1].resolve(goalReadReceipt(h,'新面板已核验的目标'));await h.settle();
  reads[0].resolve(goalReadReceipt(h,'迟到的旧目标'));await flushGoalRead();
  assert.equal(h.evaluate('goalSnapshot.objective'),'新面板已核验的目标');assert.equal(h.evaluate('goalReadVerified'),true);
  assert.equal(h.nodes('goal-objective').value,'新面板已核验的目标');assert.equal(h.packages(),0);
});

test('close and Escape remain blocked during a goal mutation and preserve its unknown original operation after settlement',async()=>{
  const h=fixture();await h.open();h.nodes('goal-edit').onclick();h.fill('goal-objective','原未知保存稿');let reject;
  h.handle(action=>{assert.equal(action,'goal-save');return new Promise((_resolve,failed)=>{reject=failed;});});
  const save=h.nodes('goal-form').onsubmit({preventDefault(){}});
  assert.equal(h.evaluate("busy.has('budget')"),true);assert.equal(h.nodes('budget-close').disabled,true);
  h.nodes('budget-close').onclick();assert.equal(h.nodes('budget-dialog').open,true);assert.equal(cancelGoalDialog(h).defaultPrevented,true);
  const original=h.storage.get('clw-goal-operation-intents');reject(Error('runtime_receipt_unknown_reconcile_original'));await save;
  assert.equal(h.evaluate("busy.has('budget')"),false);assert.equal(h.nodes('budget-close').disabled,false);
  h.nodes('budget-close').onclick();const reads=deferredGoalRead(h);h.c.openBudget();h.nodes('budget-close').onclick();
  reads[0].resolve(goalReadReceipt(h));await flushGoalRead();
  assert.equal(h.storage.get('clw-goal-operation-intents'),original);assert.equal(h.commands.filter(row=>row.action==='goal-save').length,1);
  assert.equal(h.evaluate("goalDrafts.get('original-page')"),'原未知保存稿');assert.equal(h.packages(),0);
});
