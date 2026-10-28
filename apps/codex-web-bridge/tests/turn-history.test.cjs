'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {installTurnJournal}=require('../turn-journal.cjs'),{saveSource}=require('../turn-source.cjs'),{saveReview,readReview,finalDisplayCacheStats}=require('../turn-review.cjs');
const thread='11111111-1111-4111-8111-111111111111',otherThread='22222222-2222-4222-8222-222222222222';
const trace=n=>n.toString(16).padStart(12,'0');
function fixture(t,count=85,padding=''){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-turn-pages-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'turns'));fs.mkdirSync(path.join(home,'runtime','native-final-replay'),{recursive:true});
 const finals=new Map();
 for(let i=1;i<=count;i++){
  const traceId=trace(i),source={traceId,threadId:thread,turnId:`33333333-3333-4333-8333-${i.toString().padStart(12,'0')}`,model:'chatgpt-web/pro'};
  fs.writeFileSync(path.join(home,'turns',traceId+'.json'),JSON.stringify({traceId,status:'completed',submission:'confirmed',startedAt:new Date(Date.UTC(2026,8,1,0,i)).toISOString()}));
  saveSource(home,source);const text=`Saved answer ${i}\n${padding}${i===3?'historical_body_needle':'reply'}`;saveReview(home,traceId,text);finals.set(traceId,text);
  fs.writeFileSync(path.join(home,'runtime','native-final-replay',traceId+'.json'),JSON.stringify({...source,events:[{type:'text_delta',phase:'final_answer',text},{type:'done',endTurn:true,stopReason:'stop'}]}));
 }
 const host={turnTabs:new Map(),async beginTurn(){},async endTurn(){}};
 return {home,finals,journal:installTurnJournal(host,home)};
}
test('metadata directory, pages and index never read final replay; detail and explicit search keep exact saved text',async t=>{
 const {home,journal,finals}=fixture(t),original=fs.readFileSync;let finalReads=0;
 fs.readFileSync=function(file,...args){if(String(file).includes('native-final-replay'))finalReads++;return original.call(this,file,...args);};
 try{
  const all=journal.list();assert.equal(all.length,85);assert.equal(all.some(row=>Object.hasOwn(row.review,'finalText')),false);assert.ok(all.every(row=>row.bodyAvailable));
  assert.equal(journal.recent().length,20);
  const latest=journal.history({task_key:thread});assert.equal(latest.total,85);assert.equal(latest.first_trace,trace(46));assert.equal(latest.last_trace,trace(85));assert.equal(latest.oldest_trace,trace(1));assert.equal(latest.newest_trace,trace(85));assert.equal(latest.has_before,true);assert.equal(latest.has_after,false);
  const first=journal.history({task_key:thread,position:'first'});assert.equal(first.rows[0].traceId,trace(1));assert.equal(first.rows.at(-1).traceId,trace(40));assert.equal(first.has_before,false);assert.equal(first.has_after,true);
  const next=journal.history({task_key:thread,after_trace:first.last_trace});assert.equal(next.first_trace,trace(41));assert.equal(next.last_trace,trace(80));
  const previous=journal.history({task_key:thread,before_trace:latest.first_trace});assert.equal(previous.first_trace,trace(6));assert.equal(previous.last_trace,trace(45));
  const around=journal.history({task_key:thread,around_trace:trace(3),limit:5});assert.ok(around.rows.some(row=>row.traceId===trace(3)));
  const index=journal.recordIndex({task_key:thread,position:'first',limit:4});assert.deepEqual(index.items.map(row=>row.traceId),[1,2,3,4].map(trace));assert.equal(index.rows,undefined);assert.equal(finalReads,0);
  assert.equal(readReview(home,trace(3),{includeText:false}).finalText,undefined);assert.equal(finalReads,0);
  assert.equal(journal.get(trace(3)).review.finalText,finals.get(trace(3)));assert.equal(finalReads,1);
  assert.throws(()=>journal.history({task_key:thread,query:'historical_body_needle'}),/query_requires_index/);
  const matches=await journal.recordIndex({task_key:thread,query:'historical_body_needle'});assert.equal(matches.total,1);assert.equal(matches.first_trace,trace(3));assert.equal(matches.items[0].traceId,trace(3));assert.equal(matches.search_scope,'saved_web_replies');assert.equal(matches.unavailable_body_count,0);assert.ok(finalReads>1);
 }finally{fs.readFileSync=original;}
});
test('explicit 500-long-reply search yields the event loop and bounds cached body bytes, while source changes stay isolated',async t=>{
 const {home,journal}=fixture(t,500,'long saved body '.repeat(9000));
 let ticks=0;const timer=setInterval(()=>{ticks++;},1);t.after(()=>clearInterval(timer));
 const promise=journal.recordIndex({task_key:thread,query:'historical_body_needle',position:'first'});assert.equal(typeof promise.then,'function');
 const replacement=path.join(home,'turn-sources',trace(500)+'.json');
 setImmediate(()=>{const row=JSON.parse(fs.readFileSync(replacement));row.threadId=otherThread;fs.writeFileSync(replacement,JSON.stringify(row));});
 const result=await promise;clearInterval(timer);
 assert.ok(ticks>0,'a long search must give timers an opportunity to progress');assert.equal(result.total,1);assert.equal(result.items[0].traceId,trace(3));
 const stats=finalDisplayCacheStats();assert.ok(stats.bytes<=stats.maxBytes);assert.ok(stats.entries<=stats.maxEntries);assert.ok(stats.entries<100,'the byte budget must evict before the entry limit for long replies');
 assert.equal(journal.history({task_key:thread}).total,499);assert.equal(journal.history({task_key:otherThread}).total,1);
});
test('search reports declared saved replies that are missing or fail their original hash',async t=>{
 const {home,journal}=fixture(t,3);
 fs.unlinkSync(path.join(home,'runtime','native-final-replay',trace(1)+'.json'));
 const file=path.join(home,'runtime','native-final-replay',trace(2)+'.json'),row=JSON.parse(fs.readFileSync(file));row.events[0].text='wrong saved body';fs.writeFileSync(file,JSON.stringify(row));
 const result=await journal.recordIndex({task_key:thread,query:'historical_body_needle'});
 assert.equal(result.unavailable_body_count,2);assert.equal(result.items[0].traceId,trace(3));assert.equal(result.search_scope,'saved_web_replies');
});
test('cursor validation preserves exact source identity and unmapped traces without guessing chronology',t=>{
 const {home,journal}=fixture(t,3);
 saveSource(home,{traceId:trace(7),threadId:otherThread,turnId:'44444444-4444-4444-8444-444444444444',model:'chatgpt-web/pro'});
 fs.writeFileSync(path.join(home,'turns',trace(7)+'.json'),JSON.stringify({traceId:trace(7),startedAt:'2026-09-01T00:02:00.000Z',status:'completed'}));
 fs.writeFileSync(path.join(home,'turns',trace(9)+'.json'),JSON.stringify({traceId:trace(9),startedAt:'2026-09-01T00:02:00.000Z',status:'completed'}));
 assert.equal(journal.history({task_key:otherThread}).total,1);assert.equal(journal.history({task_key:'unmapped:'+trace(9)}).total,1);
 assert.throws(()=>journal.history({task_key:thread,before_trace:'../../outside'}),/trace_invalid/);
 assert.throws(()=>journal.history({task_key:thread,around_trace:trace(7)}),/cursor_not_found/);
 assert.throws(()=>journal.history({task_key:thread,after_trace:trace(9)}),/cursor_not_found/);
 assert.throws(()=>journal.history({task_key:thread,before_trace:trace(1),after_trace:trace(2)}),/trace_invalid/);
 assert.throws(()=>journal.history({task_key:thread,limit:101}),/page_invalid/);
 const empty=journal.history({task_key:thread,before_trace:trace(1)});assert.equal(empty.first_trace,null);assert.equal(empty.last_trace,null);assert.equal(empty.has_after,true);
});
test('real storage revisions invalidate row, source, review and final caches, including changed running state',t=>{
 const {home,journal}=fixture(t,1),id=trace(1),file=path.join(home,'turns',id+'.json');
 const initial=journal.get(id);assert.equal(initial.status,'completed');assert.match(initial.review.finalText,/Saved answer/);
 const row=JSON.parse(fs.readFileSync(file));row.status='running';fs.writeFileSync(file,JSON.stringify(row));assert.equal(journal.list()[0].status,'running');
 row.status='failed';fs.writeFileSync(file,JSON.stringify(row));assert.equal(journal.list()[0].status,'failed');
 const bodyFile=path.join(home,'runtime','native-final-replay',id+'.json'),replay=JSON.parse(fs.readFileSync(bodyFile));replay.events[0].text='tampered saved final';fs.writeFileSync(bodyFile,JSON.stringify(replay));assert.equal(journal.get(id).review.finalText,null);assert.notEqual(journal.list()[0].bodyRevision,initial.bodyRevision);
 const reviewFile=path.join(home,'turn-reviews',id+'.json'),review=JSON.parse(fs.readFileSync(reviewFile));review.turnId='55555555-5555-4555-8555-555555555555';fs.writeFileSync(reviewFile,JSON.stringify(review));assert.equal(journal.list()[0].review,null);
 const sourceFile=path.join(home,'turn-sources',id+'.json'),source=JSON.parse(fs.readFileSync(sourceFile));source.threadId=otherThread;fs.writeFileSync(sourceFile,JSON.stringify(source));assert.equal(journal.history({task_key:thread}).total,0);assert.equal(journal.history({task_key:otherThread}).total,1);
 fs.unlinkSync(file);assert.equal(journal.get(id),null);assert.equal(journal.list().length,0);
});
test('summary projection excludes stray persisted body fields while full detail keeps its historical contract',t=>{
 const {home,journal}=fixture(t,1),id=trace(1),file=path.join(home,'turns',id+'.json');
 const stored=JSON.parse(fs.readFileSync(file));stored.finalText='STRAY_ROW_BODY';stored.review={finalText:'STRAY_EMBEDDED_BODY'};fs.writeFileSync(file,JSON.stringify(stored));
 const reviewFile=path.join(home,'turn-reviews',id+'.json'),review=JSON.parse(fs.readFileSync(reviewFile));review.finalText='STRAY_REVIEW_BODY';review.unexpectedTranscript='STRAY_EXTRA_BODY';fs.writeFileSync(reviewFile,JSON.stringify(review));
 assert.equal(JSON.stringify(journal.list()).includes('STRAY'),false);assert.equal(JSON.stringify(journal.history({task_key:thread})).includes('STRAY'),false);
 assert.match(journal.get(id).review.finalText,/Saved answer/);assert.equal(journal.get(id).finalText,'STRAY_ROW_BODY');
});
