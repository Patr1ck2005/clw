'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('../node_modules/playwright-core');

test('manual goals use the canonical task identity and separate human review from actual next-package sending',async t=>{
  const output=path.resolve('.local/product-control-20261006/goal-regression');fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1380,height:960}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith('file:')?route.continue():route.abort());
    await page.addInitScript(()=>{
      localStorage.clear();window.commands=[];window.operationReceipts=new Map();window.retiredOperations=new Set();window.sentPackages=0;
      const now=new Date().toISOString();
      const original={id:'round-original',phase:'completed',created_at:now};
      const goal={configured:false,objective:'',state:'not_set',mode:'manual',etag:'goal-0',request_id:original.id,revision:0,review:null,can_review:false,can_start_next:false,next:null};
      const task={id:'controller',kind:'task',title:'产品化 · 示例',root:'D:/Example',account:'A',bound:true,paused:true,
        model:'GPT-6 · 最新',effort:'Pro',access:'write',write_paths:['.'],latest_request:original,goal:{...goal,objective:undefined},
        budget_status:{etag:'budget-0',run_id:'run-original',scope:'next',used:7,limit:40,available_sends:33,available_seconds:18000,saved:false,can_continue:true},
        observation:{generating:false,observed:Date.now()/1000,modelLabel:'GPT-6 · 最新',effortLabel:'Pro',editorReady:true}};
      window.fixture={connected:true,taskStateReady:true,connectionGeneration:1,selected:task.id,pages:[task,{...task,id:'other',title:'独立任务 · 示例'}],closed:[],theme:'dark',
        localCodex:{available:true},codexWeb:{state:'ready',recent:[]},recordHistory:{web:true,codex:true},
        view:{page_id:task.id,thread_id:'thread-original',latest_request:original,goal,run:{id:'run-original',state:'closed',dispatches:7,max_dispatches:40},events:[{seq:1,kind:'assistant_message',at:now,data:{text:'本工作包的实现和测试已保存。请核对真实成果，再决定是否继续产品化。'}}]}};
      const publish=()=>{
        const full=window.fixture.view.goal;
        window.fixture.pages.find(p=>p.id===window.fixture.selected).goal={...full,objective:undefined,review:undefined,next:undefined};
        window.updateFixture(window.fixture);
      };
      window.clw={onState:callback=>{window.updateFixture=value=>{callback(value);renderStateImmediately();};setTimeout(()=>window.updateFixture(window.fixture),0);},onIntent(){},
        command:async(action,payload)=>{
          window.commands.push({action,payload:structuredClone(payload)});
          if(action==='goal-read'){
            if(window.readUnavailable)throw Error('runtime_receipt_unknown_reconcile_original');
            return {goal:structuredClone(window.fixture.view.goal),model_sends:0};
          }
          if(['goal-save','goal-review','goal-continue','goal-discard'].includes(action)){
            if(window.deferAction===action)return new Promise(resolve=>{window.finishDeferred=resolve;});
            if(window.retiredOperations.has(payload.operation_id))throw Error('managed_goal_operation_retired');
            const previous=window.operationReceipts.get(payload.operation_id);
            if(previous){if(JSON.stringify(previous.payload)!==JSON.stringify(payload))throw Error('managed_goal_operation_conflict');return {...structuredClone(previous.receipt),replayed:true};}
            if(payload.id!=='controller'||payload.expected_goal_request_id!=='round-original')throw Error('managed_goal_request_changed');
            const g=window.fixture.view.goal;if(payload.expected_etag!==g.etag)throw Error('managed_goal_changed');
            let receipt;
            if(action==='goal-save'){
              Object.assign(g,{configured:true,objective:payload.objective,state:'paused',review:null,revision:g.revision+1,can_review:true,can_start_next:false});g.etag='goal-'+g.revision;
              receipt={state:'goal_saved',goal:structuredClone(g),model_sends:0,budget_unchanged:true};publish();
            }else if(action==='goal-review'){
              g.review={request_id:g.request_id,decision:payload.decision,note:payload.note,at:new Date().toISOString(),actor:'human'};
              Object.assign(g,{state:payload.decision==='complete'?'complete':'paused',revision:g.revision+1,can_review:payload.decision!=='complete',can_start_next:payload.decision==='continue'&&window.fixture.pages[0].budget_status.can_continue});g.etag='goal-'+g.revision;
              receipt={state:'goal_review_saved',goal:structuredClone(g),model_sends:0,budget_unchanged:true};publish();
            }else if(action==='goal-discard'){
              if(g.next?.operation_id!==payload.expected_pending_id&&window.rejectedIntent!==payload.expected_pending_id)throw Error('managed_goal_pending_changed');
              if(g.next&&g.next_recovery?.can_discard!==true)throw Error('managed_goal_original_send_unresolved');
              window.retiredOperations.add(payload.expected_pending_id);Object.assign(g,{next:null,pending_id:null,next_recovery:null,can_review:true,can_start_next:true,revision:g.revision+1});g.etag='goal-'+g.revision;
              receipt={state:'goal_next_discarded',original_operation_id:payload.expected_pending_id,goal:structuredClone(g),model_sends:0,budget_unchanged:true,original_error_preserved:true};publish();
            }else{
              if((!g.can_start_next&&!g.next)||g.review?.decision!=='continue')throw Error('managed_goal_human_review_required');
              if(payload.expected_run_id!=='run-original')throw Error('managed_goal_result_not_settled');
              if(g.next&&payload.operation_id!==g.next.operation_id)throw Error('managed_goal_pending_changed');
              if(window.rejectBeforePreparation){window.rejectBeforePreparation=false;window.rejectedIntent=payload.operation_id;throw Error('managed_goal_next_text_too_long');}
              window.sentPackages++;
              receipt={state:'queued_for_web_host',request_id:payload.operation_id};
            }
            window.operationReceipts.set(payload.operation_id,{payload:structuredClone(payload),receipt});
            if(window.unknownOnce===action){window.unknownOnce=null;throw Error('runtime_receipt_unknown_reconcile_original');}
            if(window.foreignReceiptOnce===action){window.foreignReceiptOnce=null;return action==='goal-continue'?{...receipt,request_id:'foreign-request'}:{...receipt,goal:{...receipt.goal,request_id:'foreign-request'}};}
            return receipt;
          }
          if(action==='refill-budget'){
            const old=window.operationReceipts.get(payload.operation_id);if(old)return {...structuredClone(old.receipt),replayed:true};
            const budget=window.fixture.pages[0].budget_status;if(payload.id!=='controller'||payload.expected_etag!==budget.etag)throw Error('managed_budget_changed');
            budget.available_sends+=payload.add_dispatches;budget.available_seconds+=payload.add_seconds;budget.saved=true;budget.can_continue=budget.available_sends>0&&budget.available_seconds>0;budget.etag+='-updated';
            const g=window.fixture.view.goal;g.can_start_next=g.review?.decision==='continue'&&budget.can_continue;
            const receipt={state:'budget_refilled',budget:structuredClone(budget),model_sends:0};window.operationReceipts.set(payload.operation_id,{payload:structuredClone(payload),receipt});publish();
            if(window.unknownOnce===action){window.unknownOnce=null;throw Error('runtime_receipt_unknown_reconcile_original');}return receipt;
          }
          if(action==='start'||action==='resume'||action==='budget-continue')throw Error('unexpected_model_submission');
          if(action==='record-index')return {mode:'web',page_id:payload.page_id,items:[],total:0};
          return {};
        }};
    });
    const load=async()=>{await page.goto('file:///'+path.resolve('apps/web-host/index.html').replaceAll('\\','/'));await page.locator('#thread-title').getByText('产品化 · 示例',{exact:true}).waitFor();};
    const open=async()=>{
      if(await page.locator('#settings-refill').isVisible())await page.locator('#settings-refill').click();
      else{await page.locator('#composer-add').click();await page.locator('#composer-add-goal').click();}
      await page.waitForFunction(()=>document.querySelector('#budget-dialog').open&&!goalReadPending);
    };
    const save=async objective=>{if(!await page.locator('#goal-form').isVisible())await page.locator('#goal-edit').click();await page.locator('#goal-objective').fill(objective);await page.locator('#goal-save').click();await page.waitForFunction(()=>!busy.has('budget'));};
    const submitCount=()=>page.evaluate(()=>window.commands.filter(c=>['start','resume','budget-continue','refill-budget'].includes(c.action)).length);
    await load();
    await t.test('editing a durable goal and accepting a saved round send no model and append no budget',async()=>{
      await open();assert.equal(await page.locator('#quick-refill').count(),0);
      assert.equal(await page.locator('#budget-details').getAttribute('open'),null);
      await save('完成可靠、清晰且可发布的产品；每包提交真实测试和待验收项。');
      assert.equal(await page.locator('#goal-form').isVisible(),false);assert.equal(await page.locator('#goal-edit').isVisible(),true);
      assert.match(await page.locator('#goal-objective-view').innerText(),/可发布的产品/);
      assert.match(await page.locator('#goal-feedback').innerText(),/目标已保存.*没有发送/);
      assert.equal(await submitCount(),0);assert.equal(await page.evaluate(()=>window.sentPackages),0);
      assert.match(await page.locator('#start').innerText(),/验收本轮/);
      assert.equal(await page.locator('#goal-review-section').isVisible(),true);
      await page.locator('#goal-review-notes').fill('成果已检查；下一包优化失败恢复和首次使用。');
      await page.locator('#goal-review-decision').selectOption('continue');await page.locator('#goal-review-save').click();
      await page.waitForFunction(()=>!busy.has('budget'));
      assert.equal(await page.locator('#goal-review-section').isVisible(),false);
      assert.equal(await page.locator('#budget-dialog .primary:visible').count(),1);
      assert.equal(await page.locator('#budget-continue').isEnabled(),true);
      assert.match(await page.locator('#start').innerText(),/开始下一包/);
      assert.equal(await submitCount(),0);assert.equal(await page.evaluate(()=>window.sentPackages),0);
      await page.screenshot({path:path.join(output,'goal-next-package.png')});
      await page.locator('#budget-close').click();await page.locator('#start').click();
      await page.waitForFunction(()=>document.querySelector('#budget-dialog').open&&!goalReadPending);
      assert.match(await page.locator('#goal-objective').inputValue(),/可发布的产品/);
      await page.locator('#budget-instructions').fill('验证断线回执恢复，保留原操作身份。');await page.locator('#budget-continue').click();
      await page.waitForFunction(()=>!document.querySelector('#budget-dialog').open);
      const calls=await page.evaluate(()=>window.commands.filter(c=>c.action==='goal-continue'));
      assert.equal(calls.length,1);assert.equal(calls[0].payload.id,'controller');assert.equal(calls[0].payload.expected_goal_request_id,'round-original');
      assert.equal(calls[0].payload.expected_run_id,'run-original');assert.equal(calls[0].payload.instructions,'验证断线回执恢复，保留原操作身份。');
      assert.ok(calls[0].payload.operation_id);assert.equal(await page.evaluate(()=>window.sentPackages),1);assert.equal(await submitCount(),0);
    });
    await t.test('an unknown goal-save receipt preserves the exact original key and all text across close and reopen',async()=>{
      await load();await open();await page.evaluate(()=>{window.unknownOnce='goal-save';});
      await save('完整保留的目标原稿；未知回执先核对，不换操作键。');
      assert.match(await page.locator('#goal-save').innerText(),/核对原目标保存/);assert.equal(await page.locator('#goal-objective').isDisabled(),true);
      assert.equal(await submitCount(),0);await page.locator('#budget-close').click();await open();
      assert.equal(await page.locator('#goal-objective').inputValue(),'完整保留的目标原稿；未知回执先核对，不换操作键。');
      await page.locator('#goal-save').click();await page.waitForFunction(()=>!busy.has('budget'));
      const calls=await page.evaluate(()=>window.commands.filter(c=>c.action==='goal-save'));
      assert.equal(calls.length,2);assert.deepEqual(calls[1].payload,calls[0].payload);
      assert.equal(await page.evaluate(()=>window.operationReceipts.size),1);assert.equal(await page.evaluate(()=>window.sentPackages),0);
      assert.match(await page.locator('#goal-feedback').innerText(),/目标已保存/);
    });
    await t.test('foreign metadata and malformed accepted receipts never retire the original operation or claim current success',async()=>{
      await load();await open();await page.evaluate(()=>{window.foreignReceiptOnce='goal-save';});await save('必须有原任务回执');
      assert.match(await page.locator('#goal-feedback').innerText(),/完整回执/);assert.match(await page.locator('#goal-save').innerText(),/核对原目标保存/);
      assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('clw-goal-operation-intents')).length),1);
      await page.locator('#goal-save').click();await page.waitForFunction(()=>!busy.has('budget'));await page.locator('#goal-review-save').click();await page.waitForFunction(()=>!busy.has('budget'));
      await page.evaluate(()=>{window.foreignReceiptOnce='goal-continue';});await page.locator('#budget-continue').click();await page.waitForFunction(()=>!busy.has('budget'));
      assert.equal(await page.locator('#budget-dialog').isVisible(),true);assert.match(await page.locator('#goal-feedback').innerText(),/完整回执/);
      assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('clw-goal-operation-intents')).length),1);assert.equal(await page.evaluate(()=>window.sentPackages),1);
      await page.locator('#budget-continue').click();await page.waitForFunction(()=>!document.querySelector('#budget-dialog').open);
      assert.equal(await page.evaluate(()=>window.sentPackages),1);
    });
    await t.test('unknown next-package submission reconciles the same grant rather than creating another package',async()=>{
      await load();await open();await save('未知接续仍保留原工作包身份');
      await page.locator('#goal-review-notes').fill('认可本轮结果，继续实际可靠性测试。');await page.locator('#goal-review-save').click();
      await page.waitForFunction(()=>!busy.has('budget'));await page.evaluate(()=>{window.unknownOnce='goal-continue';});
      await page.locator('#budget-instructions').fill('只核对原工作包，保留原已受理操作。');await page.locator('#budget-continue').click();
      await page.waitForFunction(()=>!busy.has('budget'));assert.match(await page.locator('#budget-continue').innerText(),/核对原下一包提交/);
      assert.equal(await page.evaluate(()=>window.sentPackages),1);assert.equal(await page.locator('#budget-instructions').isDisabled(),true);
      await page.locator('#budget-close').click();await open();await page.locator('#budget-continue').click();
      await page.waitForFunction(()=>!document.querySelector('#budget-dialog').open);
      const calls=await page.evaluate(()=>window.commands.filter(c=>c.action==='goal-continue'));
      assert.equal(calls.length,2);assert.deepEqual(calls[1].payload,calls[0].payload);assert.equal(await page.evaluate(()=>window.sentPackages),1);
    });
    await t.test('unsaved goal changes cannot approve or start against another goal; complete remains a human decision',async()=>{
      await load();await open();await save('验收用目标');await page.locator('#goal-edit').click();await page.locator('#goal-objective').fill('未保存的修改');
      assert.equal(await page.locator('#goal-review-save').isDisabled(),true);
      await page.locator('#goal-edit-cancel').click();await page.locator('#goal-review-decision').selectOption('complete');
      await page.locator('#goal-review-notes').fill('已按可执行产物和使用流程验收，目标达成。');await page.locator('#goal-review-save').click();
      await page.waitForFunction(()=>!busy.has('budget'));assert.match(await page.locator('#goal-status').innerText(),/目标已确认完成/);
      assert.equal(await page.locator('#budget-continue-section').isVisible(),false);assert.equal(await page.evaluate(()=>window.sentPackages),0);
      await page.screenshot({path:path.join(output,'goal-human-complete.png')});
    });
    await t.test('canonical read failures never authorize writes from the cached selected detail',async()=>{
      await load();await page.evaluate(()=>{window.readUnavailable=true;window.fixture.view.goal={...window.fixture.view.goal,configured:true,state:'paused',objective:'旧缓存',can_review:true};window.updateFixture(window.fixture);});
      await open();assert.equal(await page.locator('#goal-objective').inputValue(),'旧缓存');
      assert.equal(await page.locator('#goal-objective').isDisabled(),true);assert.equal(await page.locator('#goal-save').isDisabled(),true);
      assert.equal(await page.locator('#goal-review-save').isDisabled(),true);assert.match(await page.locator('#goal-feedback').innerText(),/暂未读到/);
      assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.action==='goal-save'||c.action==='goal-review'||c.action==='goal-continue').length),0);
    });
    await t.test('a server-prepared package with no local intent reuses its actual operation key and immutable original',async()=>{
      await load();await open();await save('可接续的产品目标');await page.locator('#goal-review-save').click();await page.waitForFunction(()=>!busy.has('budget'));
      await page.locator('#budget-close').click();
      await page.evaluate(()=>{
        const g=window.fixture.view.goal;g.next={state:'goal_next_prepared',operation_id:'prepared-original-key',objective:'不可改写的原完整接续',source_request_id:'round-original',expected_run_id:'run-original',model_sends:0};
        g.pending_id=g.next.operation_id;g.can_review=false;g.can_start_next=false;g.next_recovery={can_discard:true,send_state:'not_sent',reason:'prepared_only'};window.updateFixture(window.fixture);
      });
      await open();assert.match(await page.locator('#budget-continue').innerText(),/核对原下一包提交/);
      assert.equal(await page.locator('#budget-instructions').isDisabled(),true);assert.equal(await page.locator('#goal-discard').isVisible(),true);
      assert.equal(await page.evaluate(()=>window.sentPackages),0);
      await page.locator('#budget-continue').click();await page.waitForFunction(()=>!document.querySelector('#budget-dialog').open);
      const calls=await page.evaluate(()=>window.commands.filter(c=>c.action==='goal-continue'));
      assert.equal(calls.length,1);assert.equal(calls[0].payload.operation_id,'prepared-original-key');assert.equal(calls[0].payload.instructions,'');assert.equal(await page.evaluate(()=>window.sentPackages),1);
    });
    await t.test('only an explicit safe discard retires the pending key, with unknown discard receipts reconciled unchanged',async()=>{
      await load();await open();await save('保留目标和验收');await page.locator('#goal-review-save').click();await page.waitForFunction(()=>!busy.has('budget'));await page.locator('#budget-close').click();
      await page.evaluate(()=>{
        const g=window.fixture.view.goal;g.next={state:'goal_next_prepared',operation_id:'unsent-original',objective:'原待发包',source_request_id:'round-original',expected_run_id:'run-original',model_sends:0};
        g.pending_id='unsent-original';g.can_start_next=false;g.can_review=false;g.next_recovery={can_discard:true,send_state:'not_sent',reason:'prepared_only'};window.updateFixture(window.fixture);window.unknownOnce='goal-discard';
      });
      await open();await page.locator('#goal-discard').click();await page.waitForFunction(()=>!busy.has('budget'));
      assert.match(await page.locator('#goal-discard').innerText(),/核对原撤销操作/);assert.equal(await page.locator('#budget-continue').isDisabled(),true);
      await page.locator('#budget-close').click();await open();await page.locator('#goal-discard').click();await page.waitForFunction(()=>!busy.has('budget'));
      const calls=await page.evaluate(()=>window.commands.filter(c=>c.action==='goal-discard'));
      assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);assert.equal(calls[0].payload.expected_pending_id,'unsent-original');
      assert.match(await page.locator('#goal-feedback').innerText(),/已撤销.*没有发送/);assert.equal(await page.locator('#goal-objective').inputValue(),'保留目标和验收');
      assert.equal(await page.evaluate(()=>window.fixture.pages[0].budget_status.available_sends),33);assert.equal(await page.evaluate(()=>window.sentPackages),0);
      assert.equal(await page.locator('#goal-discard').isVisible(),false);assert.equal(await page.locator('#budget-continue').isEnabled(),true);
    });
    await t.test('unknown execution offers original receipt reconciliation and cannot be discarded as a safe preparation',async()=>{
      await load();await open();await save('未知执行仍保留原身份');await page.locator('#goal-review-save').click();await page.waitForFunction(()=>!busy.has('budget'));await page.locator('#budget-close').click();
      await page.evaluate(()=>{
        const g=window.fixture.view.goal;g.next={state:'goal_next_prepared',operation_id:'unknown-original',objective:'未知原包',source_request_id:'round-original',expected_run_id:'run-original',model_sends:0};
        g.pending_id='unknown-original';g.can_review=false;g.can_start_next=false;g.next_recovery={can_discard:false,send_state:'unknown',reason:'reconcile_original_operation'};window.updateFixture(window.fixture);
      });
      await open();assert.equal(await page.locator('#goal-discard').isVisible(),false);assert.match(await page.locator('#budget-continue').innerText(),/核对原下一包提交/);
      assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.action==='goal-discard').length),0);assert.equal(await page.evaluate(()=>window.sentPackages),0);
    });
    await t.test('a preparation rejection retains its old key until the server explicitly accepts discard',async()=>{
      await load();await open();await save('长目标仍保留原稿');await page.locator('#goal-review-save').click();await page.waitForFunction(()=>!busy.has('budget'));
      await page.evaluate(()=>{window.rejectBeforePreparation=true;});await page.locator('#budget-continue').click();await page.waitForFunction(()=>!busy.has('budget')&&!goalReadPending);
      assert.match(await page.locator('#goal-feedback').innerText(),/超过 24000/);assert.equal(await page.locator('#goal-discard').isVisible(),true);
      const old=await page.evaluate(()=>window.commands.find(c=>c.action==='goal-continue').payload.operation_id);
      await page.locator('#goal-discard').click();await page.waitForFunction(()=>!busy.has('budget'));
      const discard=await page.evaluate(()=>window.commands.find(c=>c.action==='goal-discard'));
      assert.equal(discard.payload.expected_pending_id,old);assert.equal(await page.evaluate(()=>window.retiredOperations.size),1);
      assert.equal(await page.evaluate(()=>window.sentPackages),0);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('clw-goal-operation-intents')).length),0);
    });
    await t.test('a reviewed package requires explicit sufficient budget, and an unknown budget reply appends only once',async()=>{
      await load();await page.evaluate(()=>{window.fixture.pages[0].budget_status.available_sends=0;window.fixture.pages[0].budget_status.available_seconds=0;window.fixture.pages[0].budget_status.can_continue=false;window.updateFixture(window.fixture);});
      await open();await save('发放下一包仍需独立预算');await page.locator('#goal-review-save').click();await page.waitForFunction(()=>!busy.has('budget'));
      assert.equal(await page.locator('#budget-continue').isDisabled(),true);assert.equal(await page.evaluate(()=>window.sentPackages),0);
      await page.locator('#budget-details>summary').click();assert.match(await page.locator('#budget-details').innerText(),/不是账号官方额度/);
      await page.locator('#refill-sends').fill('12');await page.locator('#refill-hours').fill('2');await page.evaluate(()=>{window.unknownOnce='refill-budget';});
      await page.locator('#budget-save').click();await page.waitForFunction(()=>!busy.has('budget'));
      assert.match(await page.locator('#budget-save').innerText(),/核对原预算追加/);assert.equal(await page.locator('#budget-continue').isDisabled(),true);
      await page.locator('#budget-save').click();await page.waitForFunction(()=>!busy.has('budget')&&!goalReadPending);
      const calls=await page.evaluate(()=>window.commands.filter(c=>c.action==='refill-budget'));
      assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);
      assert.equal(await page.evaluate(()=>window.fixture.pages[0].budget_status.available_sends),12);
      assert.equal(await page.evaluate(()=>window.fixture.pages[0].budget_status.available_seconds),7200);
      assert.equal(await page.evaluate(()=>window.sentPackages),0);assert.equal(await page.locator('#budget-continue').isEnabled(),true);
    });
    await t.test('typed requirements remain a draft while paused, explicit review keeps its size limit, and compact goals stay reachable',async()=>{
      await load();await open();await save('小窗口完整流程');await page.locator('#budget-close').click();
      await page.locator('#objective').fill('整'.repeat(6100));await page.locator('#start').click();await page.waitForFunction(()=>!goalReadPending);
      assert.equal(await page.locator('#budget-dialog').isVisible(),false,'New requirements do not turn into a legacy review');
      assert.equal((await page.locator('#objective').inputValue()).length,6100);assert.equal(await page.evaluate(()=>window.sentPackages),0);
      assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.action==='start'||c.action==='goal-review').length),0);
      await open();
      await page.locator('#goal-review-notes').evaluate(input=>{input.value='整'.repeat(6100);input.dispatchEvent(new Event('input',{bubbles:true}));});
      assert.equal((await page.locator('#goal-review-notes').inputValue()).length,6100,'A restored old draft is retained without silent truncation');
      assert.equal(await page.locator('#goal-review-save').isDisabled(),true);
      await page.locator('#goal-review-notes').fill('用户验收反馈');await page.setViewportSize({width:1000,height:700});
      assert.doesNotMatch(await page.locator('#goal-feedback').innerText(),/超过 6000/);assert.equal(await page.locator('#goal-review-save').isEnabled(),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
      await page.locator('#goal-dialog-body').evaluate(node=>{node.scrollTop=0;});
      const header=await page.locator('#budget-dialog>.dialog-head').boundingBox();
      await page.screenshot({path:path.join(output,'goal-settings-compact.png')});
      await page.locator('#goal-review-section').evaluate(node=>node.scrollIntoView({block:'start'}));
      assert.equal((await page.locator('#budget-dialog>.dialog-head').boundingBox()).y,header.y);
      const section=await page.locator('#goal-review-section').boundingBox(),body=await page.locator('#goal-dialog-body').boundingBox();assert.ok(section.y>=body.y);
      const button=await page.locator('#goal-review-save').boundingBox();assert.ok(button.y>=0&&button.y+button.height<=700);
      await page.screenshot({path:path.join(output,'goal-review-compact.png')});await page.setViewportSize({width:1380,height:960});
    });
    await t.test('the two native work modes never borrow the selected Web task goal or expose its controls',async()=>{
      await load();await open();await save('只属于纯 Web 主控的目标');await page.locator('#budget-close').click();
      const before=await page.evaluate(()=>window.commands.filter(c=>c.action.startsWith('goal-')).length);
      await page.locator('#workflow-selector>summary').click();await page.locator('#mode-codex').click();await page.locator('#settings').click();
      assert.equal(await page.locator('#settings-refill').isVisible(),false);assert.equal(await page.locator('#compose-footer').isVisible(),false);
      await page.locator('#close-details').click();await page.locator('#workflow-selector>summary').click();await page.locator('#mode-local').click();
      assert.equal(await page.locator('#local-workspace').isVisible(),true);assert.equal(await page.locator('#settings-refill').isVisible(),false);
      assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.action.startsWith('goal-')).length),before);
    });
    await t.test('late mutation receipts remain owned by the frozen task and workflow',async()=>{
      await load();await open();await page.locator('#goal-objective').fill('属于原任务的目标');await page.evaluate(()=>{window.deferAction='goal-save';});
      await page.locator('#goal-save').click();await page.waitForFunction(()=>typeof window.finishDeferred==='function');
      await page.evaluate(()=>{
        window.fixture.selected='other';window.fixture.view={page_id:'other',thread_id:'thread-other',goal:{configured:false,objective:'',state:'not_set',mode:'manual',etag:'other-0',revision:0,request_id:'other-original'}};window.updateFixture(window.fixture);
        window.finishDeferred({state:'goal_saved',goal:{configured:true,objective:'属于原任务的目标',state:'paused',etag:'goal-1',revision:1,request_id:'round-original'},model_sends:0});
      });
      await page.waitForFunction(()=>!busy.has('budget'));
      assert.match(await page.locator('#goal-status').innerText(),/原任务状态待核对/);
      assert.doesNotMatch(await page.locator('#goal-feedback').innerText(),/目标已保存/);
      assert.equal(await page.locator('#notice').isVisible(),false);
      assert.equal(await page.locator('#goal-save').isDisabled(),true);assert.equal(await page.evaluate(()=>window.sentPackages),0);
    });
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
