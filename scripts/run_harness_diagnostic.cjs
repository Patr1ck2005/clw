'use strict';
// Operator for exactly one predeclared independent case. All execution stays
// in the existing CLW launcher/managed ledger. No retries or recovery sends.
const fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const {chromium}=require('../apps/web-host/node_modules/playwright-core');
const ROOT=path.resolve(__dirname,'..');
const directory=path.resolve(process.argv[2]||''),caseId=process.argv[3];
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const manifest=read(path.join(directory,'manifest.json'));
const spec=manifest.cases.find(c=>c.id===caseId);
if(!spec||spec.model!=='extra-high'||manifest.planned_cases!==24)throw Error('predeclared Extra High case required');
let amendedPrompt;
const amendmentFiles=['workspace-amendment.json',...fs.readdirSync(directory).filter(n=>/^workspace-amendment-\d\d\.json$/.test(n)).sort()];
for(const amendmentName of amendmentFiles){
 const amendmentFile=path.join(directory,amendmentName);
 if(!fs.existsSync(amendmentFile))continue;
 const amendment=read(amendmentFile);
 if(amendment.manifest_sha256!==require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(directory,'manifest.json'))).digest('hex'))throw Error('original_manifest_changed');
 if(amendment.workspaces[caseId]){
   spec.workspace=amendment.workspaces[caseId];
   if(amendment.prompt_files?.[caseId]){
     amendedPrompt=amendment.prompt_files[caseId];
     if(path.basename(amendedPrompt)!==amendedPrompt)throw Error('amended_prompt_outside_experiment');
   }
 }
}
const file=name=>path.join(directory,caseId+'.'+name);
const promptFile=amendedPrompt?path.join(directory,amendedPrompt):fs.existsSync(file('effective-prompt.md'))?file('effective-prompt.md'):file('prompt.md');
const save=(name,value)=>fs.writeFileSync(file(name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const output=(phase,data={})=>console.log(JSON.stringify({at:new Date().toISOString(),case_id:caseId,phase,...data}));
function collect(action){
 const args=['-B',path.join(__dirname,'harness_diagnostics.py'),action,directory,'--case',caseId];
 if(action==='collect-native')args.push('--evidence',file('execution'));
 const r=JSON.parse(execFileSync('python',args,{cwd:ROOT,encoding:'utf8',maxBuffer:4*1024*1024}));
 output('collected',{outcome:r.outcome,arithmetic_matches:r.arithmetic_matches,actual_tool_calls:r.actual_tool_calls});
 return r;
}
async function runNative(){
 const execution=file('execution');
 if(fs.existsSync(path.join(execution,'execution.json'))){
   const r=read(path.join(execution,'execution.json'));
   if(!['turn_completed','needs_attention'].includes(r.state))throw Error('original_native_execution_requires_reconciliation');
   return collect('collect-native');
 }
 if(fs.existsSync(file('native-intent.json')))throw Error('original_native_submission_unknown_no_replay');
 save('native-intent.json',{at:new Date().toISOString(),workspace:spec.workspace});
 if(!fs.existsSync(file('execution-link.json')))save('execution-link.json',{at:new Date().toISOString(),source:'start_codex_web.ps1',result_directory:execution,route:'native'});
 const log=fs.openSync(file('operator.log'),'ax');
 const child=spawn('pwsh',['-NoProfile','-File',path.join(__dirname,'start_codex_web.ps1'),'-Model','extra-high','-WorkingDirectory',spec.workspace,'-PromptFile',promptFile,'-ResultDirectory',execution],{cwd:ROOT,windowsHide:true,stdio:['ignore',log,log]});
 output('native_started',{pid:child.pid});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});fs.closeSync(log);
 if(code!==0&&!fs.existsSync(path.join(execution,'execution.json')))throw Error('native_local_preflight_failed');
 return collect('collect-native');
}
async function runWeb(){
 const port=fs.readFileSync(path.join(ROOT,'.local/web-host/DevToolsActivePort'),'utf8').split(/\r?\n/)[0];
 const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:60000});
 const all=()=>browser.contexts().flatMap(c=>c.pages());
 const shell=all().find(p=>p.url().endsWith('/apps/web-host/index.html'));
 if(!shell)throw Error('owned_shell_missing');
 const command=(action,payload)=>shell.evaluate(({action,payload})=>window.clw.command(action,payload),{action,payload});
 const snapshot=()=>shell.evaluate(()=>({network:state.network,connected:state.connected,pages:state.pages}));
 const before=await snapshot();
 if(!before.connected||!before.network.includes('直连已禁用'))throw Error('vpn_or_runtime_not_ready');
 let link,page;
 if(fs.existsSync(file('execution-link.json')))link=read(file('execution-link.json'));
 else{
   // Electron can place a new WebContentsView in a different CDP context.
   // The owned shell's page id remains authoritative if the advisory event is
   // late; inspect that exact page before any enrollment intent exists.
   const created=Promise.any(browser.contexts().map(context=>context.waitForEvent('page',{timeout:30000}))).catch(()=>null);
   const receipt=await command('new',{root:spec.workspace,title:caseId,account:'B'});
   link={at:new Date().toISOString(),source:'managed_original_page',page_id:receipt.id,route:'web'};
   save('execution-link.json',link);
   page=await created;
 }
 if(!fs.existsSync(file('enroll-intent.json'))){
   await command('select',{id:link.page_id});
   let model;
   try{model=await command('inspect',{});}catch{}
   if(!/^(极高|Extra High)$/i.test(model?.effort||'')){
   if(!page){
     const record=(await snapshot()).pages.find(p=>p.id===link.page_id);
     const matches=all().filter(p=>p.url()===record?.url);
     if(matches.length!==1)throw Error('original_unbound_page_identity_ambiguous');
     page=matches[0];
   }
   page.setDefaultTimeout(30000);
   // Bounded public readiness, before any model intent. Slow loading never
   // causes an enrollment/diagnostic resend or a different page identity.
   await page.waitForSelector('button[data-codex-intelligence-trigger="true"]',{timeout:180000});
   await page.locator('button[data-codex-intelligence-trigger="true"]').click({force:true});
   const slider=page.locator('[data-model-reasoning-effort-slider] [role="slider"],[data-model-picker-power-slider] [role="slider"]');
   await slider.waitFor({timeout:15000});
   const initial=Number(await slider.getAttribute('aria-valuenow')),max=Number(await slider.getAttribute('aria-valuemax'));
   // Pro can be absent during its platform limit; the first four public
   // positions still require the final explicit Extra High label check.
   if(![3,4].includes(max)||!Number.isInteger(initial))throw Error('public_model_choices_changed');
   const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
   await slider.focus();for(let i=0;i<Math.abs(initial-3);i++)await slider.press(initial>3?'ArrowLeft':'ArrowRight');
   await page.keyboard.press('Escape');
   model=await command('inspect',{});
   }
   if(!/^(极高|Extra High)$/i.test(model.effort))throw Error('extra_high_not_verified');
   if(!fs.existsSync(file('model.json')))save('model.json',model);
   save('enroll-intent.json',{at:new Date().toISOString(),page_id:link.page_id});
   const enrolled=await command('enroll',{id:link.page_id,title:caseId,root:spec.workspace,model:model.model,effort:model.effort,access:'write',write_paths:['.'],duration_seconds:3600,max_dispatches:2,collaboration_protocol:'tool_v1',first_turn_instructions:''});
   save('enroll-receipt.json',{at:new Date().toISOString(),receipt:enrolled});output('enrollment_sent');
 }
 // Poll program state only. No elapsed-time rule sends "continue" or interrupts a model.
 const started=Date.now();let submitted=fs.existsSync(file('submit-receipt.json'));
 while(true){
   const s=await snapshot(),p=s.pages.find(p=>p.id===link.page_id);
   if(!p)throw Error('original_page_missing');
   if(!s.connected||!s.network.includes('直连已禁用'))throw Error('connection_changed_reconcile_original');
   if(p.accountAccess?.blocked)throw Error('account_cooldown_stop_experiment');
   if(p.attention||p.observation?.loginRequired||/未点击发送/.test(p.observation?.error||'')){
     if(/未点击发送/.test(p.observation?.error||'')){
       await command('select',{id:p.id});await command('pause',{});
     }
     save('stop.json',{at:new Date().toISOString(),page:p,automatic_retry:false});return collect('collect-web');
   }
   if(!submitted&&p.bound&&!p.observation?.generating){
     if(fs.existsSync(file('submit-intent.json')))throw Error('original_web_submission_unknown_no_replay');
     if(p.latest_request)throw Error('unexpected_existing_request');
     await command('select',{id:p.id});
     const payload={objective:fs.readFileSync(promptFile,'utf8').replace(/\r\n/g,'\n')};
     save('submit-intent.json',{at:new Date().toISOString(),page_id:p.id,payload});
     const receipt=await command('start',payload);
     save('submit-receipt.json',{at:new Date().toISOString(),receipt});submitted=true;
     output('case_queued',{request_id:receipt.request_id});
   }
   if(submitted&&['completed','cancelled','blocked','failed'].includes(p.latest_request?.phase)){
     save('terminal-page.json',{at:new Date().toISOString(),page:p});return collect('collect-web');
   }
   if(Date.now()-started>45*60*1000)throw Error('observation_window_ended_original_execution_preserved');
   await sleep(10000);
 }
}
(async()=>{
 const lock=path.join(directory,'active-diagnostic.lock');let owned=false;
 try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid,case_id:caseId}),{flag:'wx'});owned=true;
   const accountFile=path.join(ROOT,'.local/web-host/account-access-B.json');
   if(fs.existsSync(accountFile)&&read(accountFile).blocked)throw Error('account_cooldown_stop_experiment');
   const result=spec.route==='native'?await runNative():await runWeb();
   if(!fs.existsSync(file('operator-terminal.json')))save('operator-terminal.json',{at:new Date().toISOString(),outcome:result.outcome,automatic_retry:false});
   // End the batch on a failed case so the original evidence is reviewed before
   // another independent case. This never retries or cancels the original work.
   if(!['artifact_checks_passed_review_execution','completed'].includes(result.outcome))process.exitCode=2;
 }finally{if(owned)fs.unlinkSync(lock);}
 process.exit(process.exitCode||0);
})().catch(e=>{output('operator_stopped',{reason:e.message,automatic_retry:false});process.exit(1);});
