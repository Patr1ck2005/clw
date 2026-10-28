'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {AccountAccess,publicAccessLimit}=require('../account-access.cjs');
const {WebDriver}=require('../web-driver.cjs');
const {createHash}=require('node:crypto');
const hash=s=>createHash('sha256').update(s).digest('hex');

test('one account hold survives restarts; time or negative observations never authorize sends',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-access-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let now=1000;const a=new AccountAccess(root,'B',{now:()=>now}),b=new AccountAccess(root,'B',{now:()=>now});
 const first=a.hold('user_report');now+=10000;assert.equal(b.hold().retryAfter,first.retryAfter);
 assert.throws(()=>b.beginCheck(),{code:'account_access_cooldown'});assert.throws(()=>b.assertCanStart(),{code:'account_access_cooldown'});
 now=first.retryAfter+1;const ticket=b.beginCheck();assert.throws(()=>a.assertCanStart(),{code:'account_access_cooldown'});
 await assert.rejects(a.admitNavigation(),{code:'account_access_cooldown'});
 await b.admitNavigation({checkTicket:ticket}); // Only the explicit zero-send check can enter.
 b.verified(ticket);a.assertCanStart();new AccountAccess(root,'A').assertCanStart();
 assert.equal(a.hold().episodes,2);assert.throws(()=>b.verified(ticket),{code:'account_access_cooldown'});
});
test('navigation starts are fairly spaced without limiting running workers; queued starts honor a new hold',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-access-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let now=10;const a=new AccountAccess(root,'B',{now:()=>now,sleep:async ms=>{now+=ms;},navigationGapMs:3000});
 const starts=[];await Promise.all([1,2,3].map(n=>a.admitNavigation().then(()=>starts.push({n,now}))));
 assert.deepEqual(starts,[{n:1,now:10},{n:2,now:3010},{n:3,now:6010}]);
 a.sleep=async()=>{a.hold();};await assert.rejects(a.admitNavigation(),{code:'account_access_cooldown'});
});
test('failed checks extend only the shared cooldown and unreadable state fails closed',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-access-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let now=1000;const a=new AccountAccess(root,'B',{now:()=>now});const s=a.hold();now=s.retryAfter;a.checkFailed();
 assert.equal(a.read().retryAfter,now+300000);assert.throws(()=>a.beginCheck());
 fs.writeFileSync(a.file,'{');assert.throws(()=>a.assertCanStart(),{code:'account_access_cooldown'});assert.throws(()=>a.verified({observedAt:0}));
});
test('platform dialog detection distinguishes account access from model quota and hidden notices',()=>{
 function detect(text,visible=true){return vm.runInNewContext('('+publicAccessLimit.toString()+')()',{
  document:{querySelectorAll:selector=>{assert.match(selector,/role="dialog"/);return [{innerText:text,getBoundingClientRect:()=>({width:visible?100:0,height:50})}];}},getComputedStyle:()=>({visibility:'visible',display:'block'})});}
 assert.equal(detect("Too many requests\nYou're making requests too quickly. We've temporarily limited access to your conversations to protect your data."),true);
 assert.equal(detect('请求过于频繁，请稍后几分钟再试'),true);
 assert.equal(detect('You reached your Pro usage limit'),false);
 assert.equal(detect('Too many requests — temporarily limited access',false),false);
});
test('held account blocks offers but still collects the exact already accepted result',async()=>{
 const runtime=new EventEmitter(),calls=[];let pulse='offer';
 runtime.call=async(op,p)=>{calls.push({op,p});if(op==='wire'&&p.data.action==='pulse')return {state:pulse,attempt_id:'original',assistant_before_hash:hash('before'),sent_user_hash:hash('user')};if(op==='artifact')return {path:'result.md'};return {state:'completed'};};
 const row={page_id:'page',phase:'bound',url:'https://chatgpt.com/c/own',model:'Latest',effort:'Pro'};
 const page={id:'page',view:{webContents:{}}},gate={read:()=>({blocked:true}),hold(){},assertCanStart:()=>assert.fail('tried to send')};
 const driver=new WebDriver({runtime,pool:{pages:new Map([['page',page]]),running(){},accountAccessFor:()=>gate},onNotice(){},dom:async(_wc,action)=>{assert.equal(action,'snapshot');return {url:row.url,editor:true,controlKnown:true,userId:'user',assistantId:'answer',complete:true,html:'<p>Original result</p>'};}});
 await driver.tick(row);assert.deepEqual(calls.map(c=>c.op),['wire']);
 pulse='browser_result_pending';await driver.tick(row);driver.resultCandidates.get('original').at=0;await driver.tick(row);
 assert.equal(calls.filter(c=>c.op==='artifact').length,1);assert.ok(calls.some(c=>c.op==='wire'&&c.p.data.action==='result'));assert.ok(!calls.some(c=>c.p?.data?.action==='dispatch'));
});
