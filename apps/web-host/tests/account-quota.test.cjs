'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AccountQuota}=require('../account-quota.cjs');
const {summary}=require('../quota-view.js');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-quota-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let now=1000;return {root,q:new AccountQuota(root,'B',{now:()=>now}),time:x=>now=x};}
const menu=available=>({selection:['最新'],options:[{name:'Pro',available}]});
test('disabled public option is not proof of exhaustion or exact remaining quota',t=>{
 const {q}=fixture(t);q.observe(menu(false));const s=q.snapshot();assert.equal(s.models[0].status,'unavailable');assert.equal(s.officialRemaining,null);assert.match(summary(s),/原因未确认/);assert.equal(s.models[1].status,'unknown');
});
test('reported exhausted quota survives restart, remains separate by model/account, and clears only on a newer positive observation',t=>{
 const f=fixture(t);f.q.report('latest-pro',{exhausted:true,resetText:'Wednesday 17:09'});f.time(2000);f.q.observe(menu(false));
 assert.equal(f.q.snapshot().models[0].source,'user_report');assert.equal(new AccountQuota(f.root,'B').snapshot().models[0].status,'exhausted');assert.equal(new AccountQuota(f.root,'A').snapshot().models[0].status,'unknown');
 f.q.observe({selection:['GPT-5.6 Sol'],options:[{name:'Pro',available:true}]});assert.equal(f.q.snapshot().models[0].status,'exhausted');assert.equal(f.q.snapshot().models[1].status,'available');
 f.time(3000);f.q.observe(menu(true));assert.equal(f.q.snapshot().models[0].status,'available');assert.equal(f.q.snapshot().models[0].resetText,null);
});
test('stale availability and clearing a report never invent an available balance',t=>{
 const f=fixture(t);f.q.observe(menu(true));f.time(1000000);assert.equal(f.q.snapshot().models[0].status,'unknown');
 f.q.report('latest-pro',{exhausted:true});f.q.report('latest-pro',{exhausted:false});assert.equal(f.q.snapshot().models[0].status,'unknown');assert.equal(f.q.snapshot().officialRemaining,null);
});
test('corrupt optional metadata fails soft and rejects overwrite; whitelist excludes credentials and prompt text',t=>{
 const {q}=fixture(t);q.report('latest-pro',{exhausted:true,token:'must-not-store',prompt:'private text'});assert.doesNotMatch(fs.readFileSync(q.file,'utf8'),/must-not-store|private text/);
 fs.writeFileSync(q.file,'{');assert.equal(q.snapshot().readFailed,true);q.observe(menu(true));assert.throws(()=>q.report('latest-pro',{exhausted:false}),/unreadable/);assert.equal(fs.readFileSync(q.file,'utf8'),'{');
});
