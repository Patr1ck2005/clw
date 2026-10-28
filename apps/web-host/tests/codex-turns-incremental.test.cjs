'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {renderTask,renderOverview,groupRows,invalidateTask,focusTrace}=require('../codex-turns.js');
const {displayIndexNotice}=require('../codex-turns.js');
const {turnView}=require('../codex-turns.js');
const trace='aaaaaaaaaaaa',oldTrace='bbbbbbbbbbbb',thread='native-task';
const source=id=>({traceId:id,threadId:thread,turnId:'saved-turn-'+id,workingDirectory:'D:/fixture',model:'chatgpt-web/pro'});
const row=(id,time)=>({traceId:id,startedAt:time,status:'completed',submission:'confirmed',source:source(id),bodyAvailable:true,bodyRevision:'saved-'+id});
const latest=row(trace,'2026-10-01T01:00:00Z'),old=row(oldTrace,'2026-10-01T00:00:00Z');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('a final answer mentioning a historical fault requests review without declaring the task blocked',()=>{
 const view=turnView({...latest,nativeState:{state:'completed'},review:{reportedBlockers:[{label:'调用被拦截',note:'原始报告保留'}]}});
 assert.match(view.status,/报告待核对/);assert.doesNotMatch(view.status,/受阻|执行失败/);
 assert.equal(view.needsAttention,true);assert.match(view.note,/本轮早期/);
});
test('display cache freshness is a quiet reading status, with no internal error or authority claim',()=>{
 assert.equal(displayIndexNotice({}), '');
 assert.match(displayIndexNotice({loading:true}), /读取/);
 assert.match(displayIndexNotice({stale:true,loading:true,errorCode:'PRIVATE_INTERNAL_ERROR'}), /待更新/);
 const unavailable=displayIndexNotice({stale:true,unavailable:true,errorCode:'PRIVATE_INTERNAL_ERROR'});
 assert.match(unavailable,/暂不可用/);assert.doesNotMatch(unavailable,/PRIVATE|失败|已停止/);
});
test('a stale display keeps the exact task, final text and native terminal state while its warning can clear',()=>dom(async(root)=>{
 const options={ready:true,loadBody:id=>({traceId:id,source:source(id),review:{finalText:'Exact saved final'}})};
 const terminal={...latest,nativeState:{state:'completed'}};
 renderTask(root,[terminal],options);await flush();const card=root.firstChild,message=card.querySelector('.message');
 renderTask(root,[{...terminal,display_read:{stale:true,unavailable:true,code:'private_failure'}}],options);await flush();
 assert.equal(root.firstChild,card);assert.equal(card.querySelector('.message'),message);assert.match(card.textContent,/记录暂不可用/);
 assert.match(card.querySelector('.codex-turn-state').textContent,/本轮完成/);assert.doesNotMatch(card.textContent,/private_failure/);
 renderTask(root,[terminal],options);await flush();assert.equal(card.querySelector('.message'),message);assert.doesNotMatch(card.textContent,/记录暂不可用/);
}));
async function dom(run){
 const previous=global.document,w=createWindow('<div id="root"></div>');global.document=w.document;
 for(const name of ['append','replaceChildren'])if(!w.Element.prototype[name])w.Element.prototype[name]=function(...items){if(name==='replaceChildren')while(this.firstChild)this.removeChild(this.firstChild);for(const item of items)this.appendChild(item);};
 if(!('dataset' in w.Element.prototype))Object.defineProperty(w.Element.prototype,'dataset',{get(){const attr=key=>'data-'+key.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());return new Proxy({},{get:(_,key)=>this.getAttribute(attr(key)),set:(_,key,value)=>{this.setAttribute(attr(key),value);return true;}});}});
 try{await run(w.document.getElementById('root'),w);}finally{global.document=previous;}
}
function toggle(w,node,open=true){if(open)node.setAttribute('open','');else node.removeAttribute('open');node.dispatchEvent(new w.Event('toggle'));}
function shown(node,root){
 if(!root.contains(node))return false;
 for(let child=node;child&&child!==root;child=child.parentNode){
  if(child.hasAttribute?.('hidden'))return false;
  const parent=child.parentNode;
  if(parent?.tagName==='DETAILS'&&!parent.hasAttribute('open')&&child!==parent.firstElementChild)return false;
 }
 return true;
}
const visibleButtons=(root,label)=>Array.from(root.querySelectorAll('button')).filter(button=>button.textContent.includes(label)&&shown(button,root));
test('latest loads its body; closed history builds only stable summaries until exact trace is expanded',()=>dom(async(root,w)=>{
 const loads=[],options={loadBody:id=>{loads.push(id);return {row:{traceId:id,source:source(id),review:{finalText:'Saved reply '+id}}};}};
 renderTask(root,[old,latest],options);await flush();
 assert.deepEqual(loads,[trace]);assert.match(root.textContent,/Saved reply aaaaaaaaaaaa/);assert.doesNotMatch(root.textContent,/Saved reply bbbbbbbbbbbb/);
 const historical=root.querySelector('.task-turn-history'),card=root.querySelector('[data-trace="'+oldTrace+'"]');assert.ok(card);assert.equal(historical.hasAttribute('open'),false);assert.ok(!card.querySelector('.message'));
 toggle(w,historical);assert.deepEqual(loads,[trace]);assert.ok(!card.querySelector('.message'));
 toggle(w,card.querySelector('.native-turn-body'));await flush();assert.deepEqual(loads,[trace,oldTrace]);assert.match(card.textContent,/Saved reply bbbbbbbbbbbb/);
 const message=card.querySelector('.message'),body=card.querySelector('.native-turn-body');root.scrollTop=321;
 renderTask(root,[{...old,status:'failed'},latest],options);await flush();
 assert.equal(root.querySelector('[data-trace="'+oldTrace+'"]'),card);assert.equal(card.querySelector('.message'),message);assert.equal(card.querySelector('.native-turn-body'),body);assert.equal(body.hasAttribute('open'),true);assert.equal(root.scrollTop,321);assert.equal(loads.length,2);
}));
test('tool activity creates details content on expansion and keeps nodes across a metadata-only heartbeat',()=>dom(async(root,w)=>{
 const call='call_'+'c'.repeat(32),event={eventId:1,atMs:1760000000001,traceId:trace,callId:call,phase:'delivered',tool:'exec_command'};
 const options={nativeActivity:{source:'native_broker_metadata',events:[event]},loadBody:id=>({traceId:id,source:source(id),review:{finalText:'Body survives heartbeats'}})};
 renderTask(root,[latest],options);await flush();const card=root.firstChild,message=card.querySelector('.message'),details=card.querySelector('.native-tool-activity');
 assert.ok(!details.querySelector('ol'));assert.match(details.textContent,/工具活动.*1/);
 toggle(w,details);const li=details.querySelector('li'),list=details.querySelector('ol');assert.ok(li);
 renderTask(root,[{...latest,submission:'unconfirmed'}],{...options,nativeActivity:{...options.nativeActivity,lastReadAtMs:9999}});await flush();
 assert.equal(root.firstChild,card);assert.equal(card.querySelector('.native-tool-activity'),details);assert.equal(details.querySelector('li'),li);assert.equal(details.querySelector('ol'),list);assert.equal(details.hasAttribute('open'),true);assert.equal(card.querySelector('.message'),message);
 renderTask(root,[latest],{...options,nativeActivity:{source:'native_broker_metadata',events:[{...event,eventId:2,phase:'result'}]}});assert.match(details.textContent,/成果待核验/);assert.equal(card.querySelector('.message'),message);
}));
test('switching task or refreshing saved body rejects stale async body and a wrong trace',()=>dom(async(root)=>{
 let finish;renderTask(root,[latest],{loadBody:()=>new Promise(resolve=>{finish=resolve;})});const oldCard=root.firstChild;
 const next={...row('cccccccccccc','2026-10-01T03:00:00Z'),source:{...source('cccccccccccc'),threadId:'another-task'}};
 renderTask(root,[next],{loadBody:id=>({traceId:id,source:next.source,review:{finalText:'New task exact body'}})});await flush();
 finish({traceId:trace,source:source(trace),review:{finalText:'Old task late body'}});await flush();
 assert.match(root.textContent,/New task exact body/);assert.doesNotMatch(root.textContent,/Old task late body/);assert.notEqual(root.firstChild,oldCard);
 renderTask(root,[{...next,bodyRevision:'changed-save'}],{loadBody:()=>({traceId:trace,source:source(trace),review:{finalText:'Wrong trace body'}})});await flush();
 assert.doesNotMatch(root.textContent,/Wrong trace body|New task exact body/);assert.match(root.textContent,/暂不可用/);
}));
test('directory navigation can open and locate a folded exact trace without replaying a task',()=>dom(async(root)=>{
 const loads=[];renderTask(root,[latest,old],{loadBody:id=>{loads.push(id);return {traceId:id,source:source(id),review:{finalText:'Body '+id}};}});await flush();
 assert.equal(focusTrace(root,oldTrace),true);await flush();assert.ok(!root.querySelector('.task-turn-history'));
 assert.equal(root.querySelector('[data-trace="'+oldTrace+'"]').parentNode,root);
 assert.equal(root.querySelector('[data-trace="'+oldTrace+'"] .native-turn-body').hasAttribute('open'),true);assert.deepEqual(loads,[trace,oldTrace]);assert.equal(focusTrace(root,'not-a-trace'),false);
}));
test('a page of earlier history can remain folded when the task latest trace is outside that page',()=>dom(async(root)=>{
 const loads=[];renderTask(root,[old],{taskKey:thread,latestTrace:trace,loadBody:id=>{loads.push(id);return {traceId:id,source:source(id),review:{finalText:'Saved older reply'}};}});await flush();
 assert.deepEqual(loads,[]);assert.equal(root.querySelector('.native-turn-body').hasAttribute('open'),false);assert.doesNotMatch(root.textContent,/Saved older reply/);
 assert.equal(focusTrace(root,oldTrace),true);await flush();assert.deepEqual(loads,[oldTrace]);
}));
test('body response must carry the exact trace and saved turn identity',()=>dom(async(root)=>{
 for(const response of [{source:source(trace),review:{finalText:'Missing trace'}},
   {traceId:trace,source:{...source(trace),turnId:'another-saved-turn'},review:{finalText:'Wrong same-thread turn'}},
   {traceId:trace,source:source(trace),bodyRevision:'another-body',review:{finalText:'Changed saved revision'}}]){
   renderTask(root,[{...latest,bodyRevision:'test-'+JSON.stringify(response)}],{loadBody:()=>response});await flush();
   assert.ok(!root.querySelector('.message'));assert.match(root.textContent,/暂不可用/);
 }
}));
test('source turn replacement invalidates a pending reply even if a caller reuses the same body revision',()=>dom(async(root)=>{
 let finish;renderTask(root,[latest],{loadBody:()=>new Promise(resolve=>{finish=resolve;})});
 const changed={...latest,source:{...latest.source,turnId:'new-saved-turn'}};
 renderTask(root,[changed],{loadBody:id=>({traceId:id,source:changed.source,bodyRevision:changed.bodyRevision,review:{finalText:'New exact turn reply'}})});await flush();
 finish({traceId:trace,source:source(trace),bodyRevision:latest.bodyRevision,review:{finalText:'Old source late reply'}});await flush();
 assert.match(root.textContent,/New exact turn reply/);assert.doesNotMatch(root.textContent,/Old source late reply/);
}));
test('closing a reply during its read invalidates the pending body and reopening performs an exact new read',()=>dom(async(root,w)=>{
 let finish,loads=0;const options={loadBody:id=>{loads++;return loads===1?new Promise(resolve=>{finish=resolve;}):{traceId:id,source:source(id),review:{finalText:'New expanded body'}};}};
 renderTask(root,[latest],options);const body=root.querySelector('.native-turn-body');toggle(w,body,false);
 finish({traceId:trace,source:source(trace),review:{finalText:'Late hidden body '+ 'x'.repeat(1000000)}});await flush();
 assert.ok(!root.querySelector('.message'));assert.equal(body.querySelector('.native-turn-body-content').textContent,'');
 toggle(w,body);await flush();assert.equal(loads,2);assert.match(body.textContent,/New expanded body/);
}));
test('closing an expanded long reply and tools releases their hidden DOM and rebuilds on demand',()=>dom(async(root,w)=>{
 const frames=new Map();let frameId=0;
 w.requestAnimationFrame=callback=>{const id=++frameId;frames.set(id,callback);return id;};w.cancelAnimationFrame=id=>frames.delete(id);
 const frame=()=>{const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback();};
 const full='Long source '+ 'x'.repeat(1000000),call='call_'+'z'.repeat(32),options={loadBody:id=>({traceId:id,source:source(id),review:{finalText:full}}),nativeActivity:{source:'native_broker_metadata',events:[{eventId:1,atMs:1760000000000,traceId:trace,callId:call,tool:'exec_command',phase:'result'}]}};
 renderTask(root,[latest],options);await flush();const body=root.querySelector('.native-turn-body');
 const content=body.querySelector('.native-turn-body-content');assert.ok(content.querySelector('.message'));
 const control=content.querySelector('.record-body'),nested=control.querySelector('.record-body-toggle');assert.ok(nested);
 let expansion;const click=nested.onclick;nested.onclick=event=>(expansion=click.call(nested,event));nested.click();
 assert.equal(nested.getAttribute('aria-busy'),'true');assert.equal(control.dataset.expanded,'false');assert.ok(content.querySelector('.text').textContent.length<2000);
 await flush();assert.equal(frames.size,1);frame();await flush();
 assert.equal(nested.getAttribute('aria-busy'),'true');assert.equal(control.dataset.expanded,'false');assert.ok(content.querySelector('.text').textContent.length<2000);
 frame();await expansion;assert.equal(frames.size,0);assert.equal(nested.getAttribute('aria-busy'),'false');
 assert.equal(control.dataset.expanded,'true');assert.equal(content.querySelector('.text').textContent,full);
 toggle(w,body,false);assert.equal(content.childNodes.length,0);assert.ok(root.textContent.length<10000);
 toggle(w,body);await flush();assert.ok(content.querySelector('.message'));
 const details=root.querySelector('.native-tool-activity');toggle(w,details);assert.ok(details.querySelector('li'));toggle(w,details,false);assert.ok(!details.querySelector('li'));assert.equal(details.childNodes.length,1);
 toggle(w,details);assert.ok(details.querySelector('li'));
}));
test('history folds affect unseen turns; an already displayed reply releases only on its own fold',()=>dom(async(root,w)=>{
 const unseen=row('eeeeeeeeeeee','2026-09-30T00:00:00Z'),folds={};let loads=0;
 const options={folds,onFold:(key,open)=>{folds[key]=open;},loadBody:id=>{loads++;return {traceId:id,source:source(id),review:{finalText:'Explicit history reply '+id}};}};
 renderTask(root,[latest,old,unseen],options);await flush();focusTrace(root,oldTrace);await flush();assert.equal(loads,2);
 const history=root.querySelector('.task-turn-history'),card=root.querySelector('[data-trace="'+oldTrace+'"]'),body=card.querySelector('.native-turn-body');
 toggle(w,history,false);assert.equal(card.parentNode,root);assert.ok(card.querySelector('.message'));
 toggle(w,body,false);assert.ok(!card.querySelector('.message'));
 renderTask(root,[{...latest,submission:'unconfirmed'},old,unseen],options);await flush();assert.equal(loads,2);assert.ok(!card.querySelector('.message'));
 toggle(w,body);await flush();assert.equal(loads,3);assert.match(card.textContent,/Explicit history reply bbbbbbbbbbbb/);
 assert.equal(history.hasAttribute('open'),false);assert.equal(root.querySelector('[data-trace="'+unseen.traceId+'"] .native-turn-body').hasAttribute('open'),false);
}));
test('following a new latest reply keeps shown bodies and honors an explicit old-body collapse',()=>dom(async(root,w)=>{
 const newer=row('cccccccccccc','2026-10-01T03:00:00Z'),folds={'native:history':false},loads=[];
 const options={folds,onFold:(key,open)=>{folds[key]=open;},loadBody:id=>{loads.push(id);return {traceId:id,source:source(id),review:{finalText:'Reply '+id}};}};
 renderTask(root,[latest,old],{...options,latestTrace:trace});await flush();const card=root.querySelector('[data-trace="'+trace+'"]'),latestBody=card.querySelector('.native-turn-body'),message=card.querySelector('.message');
 renderTask(root,[newer,latest,old],{...options,latestTrace:newer.traceId,preserveReading:false});await flush();
 assert.equal(card.parentNode,root);assert.equal(latestBody.hasAttribute('open'),true);assert.equal(card.querySelector('.message'),message);
 assert.equal(root.querySelector('.task-turn-history').hasAttribute('open'),false);assert.deepEqual(loads,[trace,newer.traceId]);
 toggle(w,latestBody,false);const next=row('dddddddddddd','2026-10-01T04:00:00Z');
 renderTask(root,[next,newer,latest,old],{...options,latestTrace:next.traceId,preserveReading:false});await flush();
 assert.equal(latestBody.hasAttribute('open'),false);assert.ok(!latestBody.querySelector('.message'));
 assert.deepEqual(loads,[trace,newer.traceId,next.traceId]);assert.equal(folds['native:history'],false);
 assert.deepEqual([...root.childNodes].filter(node=>node.dataset?.trace).map(node=>node.dataset.trace),[trace,newer.traceId,next.traceId]);
}));
test('A to B to A restores manual body, history, tool and source folds before any body read',()=>dom(async(root,w)=>{
 const folds={},writes=[],loads=[],event={eventId:1,atMs:1760000000000,traceId:oldTrace,callId:'call_'+'q'.repeat(32),tool:'exec_command',phase:'result'};
 const options={folds,onFold:(key,open)=>{folds[key]=open;writes.push([key,open]);},nativeActivity:{source:'native_broker_metadata',events:[event]},
  loadBody:id=>{loads.push(id);return {traceId:id,source:source(id),review:{finalText:'Saved task A '+id}};}};
 const unseen=row('eeeeeeeeeeee','2026-09-30T00:00:00Z');
 renderTask(root,[latest,old,unseen],options);await flush();
 const automatic=root.querySelector('[data-trace="'+trace+'"] .native-turn-body');automatic.dispatchEvent(new w.Event('toggle'));
 assert.deepEqual(writes,[]);assert.deepEqual(folds,{});
 toggle(w,automatic,false);const history=root.querySelector('.task-turn-history');toggle(w,history);
 const oldCard=root.querySelector('[data-trace="'+oldTrace+'"]'),oldBody=oldCard.querySelector('.native-turn-body'),oldTools=oldCard.querySelector('.native-tool-activity'),oldSource=oldCard.querySelector('details');
 toggle(w,oldBody);toggle(w,oldTools);toggle(w,oldSource);await flush();
 assert.deepEqual(folds,{'native:body:aaaaaaaaaaaa':false,'native:history':true,'native:body:bbbbbbbbbbbb':true,'native:activity:bbbbbbbbbbbb':true,'native:source:bbbbbbbbbbbb':true});
 for(const key of Object.keys(folds))assert.ok(root.querySelector('[data-record-key="'+key+'"]'));
 const other={...row('cccccccccccc','2026-10-01T03:00:00Z'),source:{...source('cccccccccccc'),threadId:'task-B'}};
 renderTask(root,[other],{folds:{},loadBody:id=>({traceId:id,source:other.source,review:{finalText:'Task B'}})});await flush();
 const before=loads.length,writesBefore=writes.length;toggle(w,oldBody,false);toggle(w,history,false);assert.equal(writes.length,writesBefore);
 renderTask(root,[latest,old,unseen],options);await flush();
 assert.deepEqual(loads.slice(before),[oldTrace]);assert.equal(root.querySelector('[data-trace="'+trace+'"] .native-turn-body').hasAttribute('open'),false);
 const restored=root.querySelector('[data-trace="'+oldTrace+'"]');assert.equal(root.querySelector('.task-turn-history').hasAttribute('open'),true);
 assert.equal(restored.querySelector('.native-turn-body').hasAttribute('open'),true);assert.match(restored.textContent,/Saved task A bbbbbbbbbbbb/);
 assert.equal(restored.querySelector('.native-tool-activity').hasAttribute('open'),true);assert.ok(restored.querySelector('.native-tool-activity li'));
 assert.equal(restored.querySelector('[data-record-key="native:source:bbbbbbbbbbbb"]').hasAttribute('open'),true);
}));
test('saved and external collapse choices suppress latest auto opening and release long hidden content',()=>dom(async(root,w)=>{
 const folds={'native:body:aaaaaaaaaaaa':false},loads=[],options={folds,onFold:(key,open)=>{folds[key]=open;},loadBody:id=>{loads.push(id);return {traceId:id,source:source(id),review:{finalText:'Long '+ 'x'.repeat(1000000)}};}};
 renderTask(root,[latest],options);await flush();assert.deepEqual(loads,[]);const body=root.querySelector('.native-turn-body');
 toggle(w,body);await flush();assert.deepEqual(loads,[trace]);assert.equal(folds['native:body:aaaaaaaaaaaa'],true);assert.ok(body.querySelector('.message'));
 folds['native:body:aaaaaaaaaaaa']=false;renderTask(root,[latest],options);await flush();
 assert.equal(body.hasAttribute('open'),false);assert.equal(body.querySelector('.native-turn-body-content').childNodes.length,0);
 renderTask(root,[{...latest,submission:'unconfirmed'}],options);await flush();assert.equal(loads.length,1);
 const newer=row('cccccccccccc','2026-10-01T03:00:00Z');renderTask(root,[newer,latest],{...options,latestTrace:trace});await flush();
 assert.equal(root.querySelector('[data-trace="'+trace+'"] .native-turn-body').hasAttribute('open'),false);assert.equal(loads.length,1);
}));
test('exact-trace navigation persists its explicit choice and restored expansion retains source guards',()=>dom(async(root)=>{
 const folds={},options={folds,onFold:(key,open)=>{folds[key]=open;},loadBody:id=>({traceId:id,source:source(id),review:{finalText:'Exact '+id}})};
 renderTask(root,[latest,old],options);await flush();assert.equal(focusTrace(root,oldTrace),true);await flush();
 assert.equal(folds['native:history'],true);assert.equal(folds['native:body:bbbbbbbbbbbb'],true);
 const corrupted={...old,bodyRevision:'bad-source',source:{...old.source,traceId:trace}};
 const activity={source:'native_broker_metadata',events:[{eventId:1,atMs:1760000000000,traceId:oldTrace,callId:'call_'+'w'.repeat(32),tool:'exec_command',phase:'result'}]};
 folds['native:activity:bbbbbbbbbbbb']=true;
 renderTask(root,[latest,corrupted],{...options,nativeActivity:activity,loadBody:id=>({traceId:id,source:source(id),review:{finalText:'Foreign source text'}})});await flush();
 const card=root.querySelector('[data-trace="'+oldTrace+'"]');assert.ok(!card.querySelector('.native-tool-activity'));assert.ok(!card.querySelector('.message'));assert.doesNotMatch(card.textContent,/Foreign source text/);assert.match(card.textContent,/暂不可用/);
}));

test('shown replies survive reading, following, metadata and A to B to A without opening unseen history',()=>dom(async(root)=>{
 const folds={'native:history':false},options={folds,loadBody:id=>({traceId:id,source:source(id),review:{finalText:'Original saved reply '+id}})};
 renderTask(root,[latest,old],options);await flush();const original=root.querySelector('[data-trace="'+trace+'"]'),message=original.querySelector('.message');
 const newer=row('cccccccccccc','2026-10-01T03:00:00Z');
 renderTask(root,[newer,latest,old],{...options,preserveReading:true});await flush();
 assert.equal(root.querySelector('.task-turn-history').hasAttribute('open'),false);assert.equal(original.parentNode,root);
 assert.equal(original.querySelector('.native-turn-body').hasAttribute('open'),true);assert.match(original.textContent,/Original saved reply/);
 renderTask(root,[{...newer,display_read:{loading:true}},latest,old],{...options,preserveReading:true});await flush();
 assert.equal(root.querySelector('.task-turn-history').hasAttribute('open'),false);assert.equal(original.querySelector('.message'),message);
 assert.equal(original.querySelector('.native-turn-body').hasAttribute('open'),true);
 assert.equal(folds['native:history'],false,'An automatic reading preservation must not rewrite the saved user fold');
 const other={...row('dddddddddddd','2026-10-01T04:00:00Z'),source:{...source('dddddddddddd'),threadId:'other-task'}};
 renderTask(root,[other],{taskKey:'other-task',loadBody:id=>({traceId:id,source:other.source,review:{finalText:'Other task'}})});await flush();
 renderTask(root,[newer,latest,old],{...options,preserveReading:false});await flush();
 const restored=root.querySelector('[data-trace="'+trace+'"]');
 assert.equal(root.querySelector('.task-turn-history').hasAttribute('open'),false);assert.equal(restored.parentNode,root);
 assert.equal(restored.querySelector('.native-turn-body').hasAttribute('open'),true);
 assert.match(restored.textContent,/Original saved reply/);assert.equal(folds['native:history'],false);
 renderTask(root,[newer,latest,old],{...options,preserveReading:false});await flush();
 assert.equal(root.querySelector('.task-turn-history').hasAttribute('open'),false);
 assert.equal(restored.querySelector('.native-turn-body').hasAttribute('open'),true);
 assert.ok(restored.querySelector('.native-turn-body-content').childNodes.length>0);
}));

test('a real new saved reply appears without replacing shown text or reloading it on metadata heartbeats',()=>dom(async(root)=>{
 const newer=row('cccccccccccc','2026-10-01T03:00:00Z'),loads=[],options={folds:{'native:history':false},
  loadBody:id=>{loads.push(id);return {traceId:id,source:source(id),review:{finalText:'Exact saved reply '+id}};}};
 renderTask(root,[latest,old],options);await flush();
 const original=root.querySelector('[data-trace="'+trace+'"]'),originalMessage=original.querySelector('.message');
 renderTask(root,[{...newer,status:'running',bodyAvailable:false,bodyRevision:null},latest,old],options);await flush();
 const current=root.querySelector('[data-trace="'+newer.traceId+'"]');
 assert.equal(original.parentNode,root);assert.equal(original.querySelector('.message'),originalMessage);
 assert.match(current.textContent,/正在工作/);assert.deepEqual(loads,[trace]);
 renderTask(root,[newer,latest,old],options);await flush();const currentMessage=current.querySelector('.message');
 assert.match(current.textContent,/Exact saved reply cccccccccccc/);assert.deepEqual(loads,[trace,newer.traceId]);
 for(let i=0;i<20;i++)renderTask(root,[{...newer,display_read:{loading:i%2===0}},latest,old],{...options,preserveReading:i%2===0});
 await flush();assert.equal(original.querySelector('.message'),originalMessage);assert.equal(current.querySelector('.message'),currentMessage);
 assert.deepEqual(loads,[trace,newer.traceId]);assert.equal(root.querySelector('.task-turn-history').hasAttribute('open'),false);
}));

test('closing unseen history during its read rejects the late body and does not promote hidden content',()=>dom(async(root,w)=>{
 const unseen=row('eeeeeeeeeeee','2026-09-30T00:00:00Z'),newer=row('cccccccccccc','2026-10-01T03:00:00Z'),folds={};
 let finish,oldReads=0;const options={folds,onFold:(key,open)=>{folds[key]=open;},loadBody:id=>{
  if(id===oldTrace&&++oldReads===1)return new Promise(resolve=>{finish=resolve;});
  return {traceId:id,source:source(id),review:{finalText:'Current exact reply '+id}};}};
 renderTask(root,[latest,old,unseen],options);await flush();focusTrace(root,oldTrace);
 const history=root.querySelector('.task-turn-history'),card=root.querySelector('[data-trace="'+oldTrace+'"]');
 toggle(w,history,false);renderTask(root,[newer,latest,old,unseen],options);await flush();
 finish({traceId:oldTrace,source:source(oldTrace),review:{finalText:'Late hidden reply '+ 'x'.repeat(1000000)}});await flush();
 assert.equal(history.hasAttribute('open'),false);assert.equal(card.parentNode,history.querySelector('div'));
 assert.ok(!card.querySelector('.message'));assert.doesNotMatch(root.textContent,/Late hidden reply/);assert.equal(oldReads,1);
 focusTrace(root,oldTrace);await flush();assert.equal(oldReads,2);assert.equal(card.parentNode,root);assert.match(card.textContent,/Current exact reply bbbbbbbbbbbb/);
}));

test('new replies preserve bounded previews while a large unseen archive receives no body reads',()=>dom(async(root)=>{
 const archive=Array.from({length:80},(_,i)=>row((i+1).toString(16).padStart(12,'0'),'2026-09-30T00:00:00Z'));
 const newer=row('cccccccccccc','2026-10-01T03:00:00Z'),loads=[],options={
  loadBody:id=>{loads.push(id);return {traceId:id,source:source(id),review:{finalText:'Saved long reply '+id+'\n'+'x'.repeat(1000000)}};}};
 renderTask(root,[latest,...archive],options);await flush();const message=root.querySelector('[data-trace="'+trace+'"] .message');
 renderTask(root,[newer,latest,...archive],options);await flush();
 assert.deepEqual(loads,[trace,newer.traceId]);assert.equal(root.querySelector('[data-trace="'+trace+'"] .message'),message);
 assert.equal(root.querySelectorAll('.native-turn-body-content .message').length,2);
 assert.ok([...root.querySelectorAll('.native-turn-body-content .text')].every(node=>node.textContent.length<2000));
 assert.equal(root.querySelector('.task-turn-history').hasAttribute('open'),false);assert.ok(!root.querySelector('.task-turn-history .message'));
}));

test('shown replies keep one current resume action while exact older actions are available in source details',()=>dom(async(root,w)=>{
 const newer={...row('cccccccccccc','2026-10-01T03:00:00Z'),nativeState:{state:'completed'}},folds={},callbacks=[];
 const first={...latest,nativeState:{state:'completed'}},earlier={...old,nativeState:{state:'completed'}};
 const options={ready:true,folds,onFold:(key,open)=>{folds[key]=open;},
  onView:id=>callbacks.push(['view',id]),onResume:id=>callbacks.push(['resume',id]),
  loadBody:id=>({traceId:id,source:source(id),review:{finalText:'Shown reply '+id}})};
 renderTask(root,[first,earlier],options);await flush();focusTrace(root,oldTrace);await flush();
 renderTask(root,[newer,first,earlier],{...options,latestTrace:newer.traceId});await flush();
 const current=root.querySelector('[data-trace="'+newer.traceId+'"]'),oldCard=root.querySelector('[data-trace="'+oldTrace+'"]');
 const oldSource=oldCard.querySelector('[data-record-key="native:source:'+oldTrace+'"]');
 const oldView=Array.from(oldSource.querySelectorAll('button')).find(button=>button.textContent.includes('查看对话网页'));
 const oldResume=Array.from(oldSource.querySelectorAll('button')).find(button=>button.textContent.includes('在 Codex 接续'));
 assert.equal(root.querySelectorAll('.message').length,3);assert.equal(visibleButtons(root,'查看对话网页').length,0);
 assert.equal(visibleButtons(root,'在 Codex 接续').length,1);assert.equal(visibleButtons(root,'在 Codex 接续')[0].parentNode,current);
 assert.ok(visibleButtons(root,'在 Codex 接续')[0].classList.contains('primary'));
 for(const card of Array.from(root.querySelectorAll('.work-record-turn'))){
  const generic=Array.from(card.querySelectorAll('p')).find(node=>node.textContent===turnView(card===current?newer:card===oldCard?earlier:first).note);
  assert.equal(generic.parentNode,card.querySelector('[data-record-key^="native:source:"]'));assert.equal(shown(generic,root),false);
 }
 assert.deepEqual(callbacks,[],'Rendering, loading and exact-trace reading must not execute an action');
 toggle(w,oldSource);assert.equal(visibleButtons(root,'查看对话网页').length,1);assert.equal(visibleButtons(root,'在 Codex 接续').length,2);
 assert.deepEqual(callbacks,[],'Opening source details only changes reading state');
 oldView.click();oldResume.click();visibleButtons(root,'在 Codex 接续').find(button=>button.parentNode===current).click();
 assert.deepEqual(callbacks,[['view',oldTrace],['resume',oldTrace],['resume',newer.traceId]]);
 const before=callbacks.length;
 for(let i=0;i<10;i++)renderTask(root,[{...newer,submission:i%2?'confirmed':'unconfirmed'},first,earlier],{...options,latestTrace:newer.traceId});
 assert.equal(oldCard.querySelector('[data-record-key="native:source:'+oldTrace+'"]'),oldSource);
 assert.equal(oldSource.hasAttribute('open'),true);assert.equal(oldView.parentNode,oldSource);assert.equal(oldResume.parentNode,oldSource);
 assert.equal(callbacks.length,before);toggle(w,oldSource,false);
 assert.equal(visibleButtons(root,'查看对话网页').length,0);assert.equal(visibleButtons(root,'在 Codex 接续').length,1);
}));

test('a newer running turn or a history page does not promote an older resume action',()=>dom(async(root,w)=>{
 const terminal={...latest,nativeState:{state:'completed'}},callbacks=[],options={ready:true,onView:id=>callbacks.push(['view',id]),onResume:id=>callbacks.push(['resume',id]),
  loadBody:id=>({traceId:id,source:source(id),review:{finalText:'Saved '+id}})};
 renderTask(root,[terminal],options);await flush();const previous=root.firstChild;
 const newer={...row('cccccccccccc','2026-10-01T03:00:00Z'),status:'running',nativeState:{state:'running'},bodyAvailable:false};
 renderTask(root,[newer,terminal],{...options,latestTrace:newer.traceId});await flush();
 assert.equal(previous.parentNode,root);assert.equal(visibleButtons(root,'在 Codex 接续').length,0);
 const previousSource=previous.querySelector('[data-record-key="native:source:'+trace+'"]');
 assert.equal(previousSource.querySelectorAll('button').length,2);assert.deepEqual(callbacks,[]);
 toggle(w,previousSource);assert.equal(visibleButtons(root,'在 Codex 接续').length,1);assert.deepEqual(callbacks,[]);
 toggle(w,previousSource,false);
 const other={...terminal,source:{...terminal.source,threadId:'task-B'}};
 renderTask(root,[other],{...options,taskKey:'task-B',loadBody:id=>({traceId:id,source:other.source,review:{finalText:'B'}})});await flush();
 renderTask(root,[newer,terminal],{...options,latestTrace:newer.traceId});await flush();
 assert.equal(root.querySelector('[data-record-key="native:source:'+trace+'"]').hasAttribute('open'),false);
 assert.equal(visibleButtons(root,'在 Codex 接续').length,0);assert.deepEqual(callbacks,[]);
 renderTask(root,[terminal],{...options,latestTrace:newer.traceId});await flush();
 assert.equal(visibleButtons(root,'在 Codex 接续').length,0,'Latest trace outside the page cannot be replaced by an older terminal action');
}));

test('failures and reported attention remain outside source details while ordinary explanations fold away',()=>dom(async(root)=>{
 const options={ready:true,loadBody:id=>({traceId:id,source:source(id),review:{finalText:'Exact saved result'}})};
 const terminal={...latest,nativeState:{state:'completed'}};
 for(const value of [
  {...terminal,nativeState:{state:'failed',reason:'compaction_failed'}},
  {...terminal,status:'failed'},
  {...terminal,status:'needs_reconciliation'},
  {...terminal,review:{reportedBlockers:[{note:'工具拒绝原文'}]}},
  {...terminal,publicState:{alerts:['Failed to fetch']}}
 ]){
  renderTask(root,[value],options);await flush();const card=root.firstChild,note=Array.from(card.querySelectorAll('p')).find(node=>node.textContent===turnView(value).note);
  assert.ok(note);assert.equal(note.parentNode,card);assert.equal(shown(note,root),true);
  assert.equal(card.querySelector('[data-record-key="native:source:'+trace+'"]').hasAttribute('open'),false);
 }
 renderTask(root,[terminal],options);await flush();const card=root.firstChild,generic=Array.from(card.querySelectorAll('p')).find(node=>node.textContent===turnView(terminal).note);
 assert.equal(generic.parentNode,card.querySelector('[data-record-key="native:source:'+trace+'"]'));assert.equal(shown(generic,root),false);
 for(const display_read of [{stale:true},{unavailable:true},{loading:true}]){
  renderTask(root,[{...terminal,display_read}],options);await flush();const notice=Array.from(card.querySelectorAll('p')).find(node=>node.textContent===displayIndexNotice(display_read));
  assert.equal(notice.parentNode,card);assert.equal(shown(notice,root),true);assert.equal(shown(generic,root),false);
 }
 renderTask(root,[terminal],options);await flush();assert.doesNotMatch(card.textContent,/工作记录待更新|工作记录暂不可用|正在读取工作记录/);
}));

test('a refused view keeps its saved reason inside source details without invoking view or resume',()=>dom(async(root,w)=>{
 const callbacks=[],unknown={...latest,source:null,account:'unknown',url:'https://invalid.example/c/no',bodyAvailable:false};
 renderTask(root,[unknown],{ready:true,onView:id=>callbacks.push(['view',id]),onResume:id=>callbacks.push(['resume',id])});await flush();
 const info=root.querySelector('[data-record-key="native:source:'+trace+'"]'),button=info.querySelector('button');
 assert.equal(button.disabled,true);assert.match(button.title,/原对话链接或账号归属尚未记录/);assert.match(info.textContent,/旧记录缺少来源映射/);
 assert.equal(visibleButtons(root,'查看对话网页').length,0);assert.equal(visibleButtons(root,'在 Codex 接续').length,0);
 toggle(w,info);assert.equal(visibleButtons(root,'查看对话网页').length,1);assert.equal(button.disabled,true);assert.deepEqual(callbacks,[]);
}));

test('multiple two-million-character shown replies pass only previews to the message presenter and read exact full text on demand',()=>dom(async(root)=>{
 const record=require('../work-record.js'),previousPresenter=global.CLWWorkRecord,previousWindow=global.window,presented=[],loads=[],copies=[];
 global.CLWWorkRecord={...record,message:(label,text,options)=>{presented.push({text,length:options?.length,remote:typeof options?.load==='function'});return record.message(label,text,options);}};
 global.window={clw:{command:async(action,payload)=>copies.push({action,payload})}};
 const textFor=id=>'Exact '+id+'\n'+'x'.repeat(2000000)+'\nSaved tail '+id;
 const options={loadBody:id=>{loads.push(id);return {traceId:id,source:source(id),bodyRevision:'saved-'+id,review:{finalText:textFor(id)}};}};
 try{
  const rows=[];for(let i=0;i<12;i++){rows.push(row((i+1).toString(16).padStart(12,'0'),new Date(Date.UTC(2026,9,1,i)).toISOString()));renderTask(root,rows,options);await flush();}
  assert.equal(root.querySelectorAll('.message').length,12);assert.equal(loads.length,12);assert.equal(presented.length,12);
  assert.ok(presented.every(value=>value.remote&&value.length>2000000&&value.text.length<2000));
  assert.ok(Array.from(root.querySelectorAll('.native-turn-body-content .text')).every(node=>node.textContent.length<2000));
  const first=root.querySelector('[data-trace="'+rows[0].traceId+'"]'),control=first.querySelector('.record-body'),toggle=control.querySelector('.record-body-toggle');
  const copy=Array.from(control.querySelectorAll('button')).find(button=>button.textContent==='复制全文');
  for(let i=0;i<10;i++)renderTask(root,rows,{...options,preserveReading:!!(i%2)});
  assert.equal(first.querySelector('.record-body'),control);assert.equal(loads.length,12);assert.equal(presented.length,12);assert.deepEqual(copies,[]);
  await toggle.onclick();assert.equal(loads.at(-1),rows[0].traceId);assert.equal(loads.length,13);assert.equal(control.querySelector('.text').textContent,textFor(rows[0].traceId));
  await copy.onclick();assert.equal(loads.length,13);assert.deepEqual(copies,[{action:'copy-record-text',payload:{text:textFor(rows[0].traceId)}}]);
  await toggle.onclick();assert.ok(control.querySelector('.text').textContent.length<2000);
  await copy.onclick();assert.equal(loads.length,14);assert.equal(loads.at(-1),rows[0].traceId);assert.equal(control.dataset.expanded,'false');
  await toggle.onclick();assert.equal(loads.length,15,'A closed-copy result is released, so expansion reads through the bounded record cache again');
  assert.equal(control.querySelector('.text').textContent,textFor(rows[0].traceId));
  assert.ok(Array.from(root.querySelectorAll('.native-turn-body-content .text')).filter(node=>node!==control.querySelector('.text')).every(node=>node.textContent.length<2000));
 }finally{if(previousPresenter===undefined)delete global.CLWWorkRecord;else global.CLWWorkRecord=previousPresenter;if(previousWindow===undefined)delete global.window;else global.window=previousWindow;}
}));

test('long inline records are compacted to previews without an initial extra read; short records stay direct',()=>dom(async(root)=>{
 const record=require('../work-record.js'),previous=global.CLWWorkRecord,presented=[],loads=[];
 global.CLWWorkRecord={...record,message:(label,text,options)=>{presented.push({text,length:options?.length,remote:typeof options?.load==='function'});return record.message(label,text,options);}};
 const full='Inline saved head '+'x'.repeat(2000000)+' inline saved tail',options={loadBody:id=>{loads.push(id);return {traceId:id,source:source(id),bodyRevision:latest.bodyRevision,review:{finalText:full}};}};
 try{
  renderTask(root,[{...latest,review:{finalText:full}}],options);await flush();assert.deepEqual(loads,[]);
  assert.equal(presented.length,1);assert.ok(presented[0].text.length<2000);assert.equal(presented[0].length,full.length);assert.equal(presented[0].remote,true);
  const control=root.querySelector('.record-body');await control.expand();assert.deepEqual(loads,[trace]);assert.equal(control.querySelector('.text').textContent,full);
  renderTask(root,[{...latest,bodyRevision:'short-save',review:{finalText:'Short unchanged direct result'}}],options);await flush();
  assert.deepEqual(loads,[trace]);assert.equal(presented.at(-1).remote,false);assert.equal(root.querySelector('.text').textContent,'Short unchanged direct result');
  assert.equal(control.querySelector('.text').textContent,'','A replaced long body is disposed even when the next message is short');
 }finally{if(previous===undefined)delete global.CLWWorkRecord;else global.CLWWorkRecord=previous;}
}));

for(const boundary of ['source','revision','close','eviction','task-switch'])test('a pending long-body copy cannot escape its '+boundary+' boundary',()=>dom(async(root,w)=>{
 const previousWindow=global.window,copies=[];global.window={clw:{command:async(action,payload)=>copies.push({action,payload})}};
 let finish,reads=0,currentSource=source(trace),currentRevision=latest.bodyRevision;
 const options={loadBody:id=>{reads++;if(reads===2)return new Promise(resolve=>{finish=resolve;});return {traceId:id,source:currentSource,bodyRevision:currentRevision,review:{finalText:reads===1?'Original long reply '+'x'.repeat(2000000):'Updated exact reply'}};}};
 try{
  renderTask(root,[latest],options);await flush();const control=root.querySelector('.record-body'),copy=Array.from(control.querySelectorAll('button')).find(button=>button.textContent==='复制全文');
  const pending=copy.onclick();await flush();assert.equal(reads,2);
  if(boundary==='source'){currentSource={...currentSource,turnId:'new-source-turn'};renderTask(root,[{...latest,source:currentSource}],options);}
  else if(boundary==='revision'){currentRevision='new-save';renderTask(root,[{...latest,bodyRevision:currentRevision}],options);}
  else if(boundary==='close')toggle(w,root.querySelector('.native-turn-body'),false);
  else if(boundary==='eviction')renderTask(root,[],{...options,taskKey:thread});
  else{currentSource={...currentSource,threadId:'task-B'};renderTask(root,[{...latest,source:currentSource}],{...options,taskKey:'task-B'});}
  finish({traceId:trace,source:source(trace),bodyRevision:latest.bodyRevision,review:{finalText:'Late old saved full '+'x'.repeat(2000000)}});await pending;await flush();
  assert.deepEqual(copies,[]);assert.equal(control.querySelector('.text').textContent,'');assert.doesNotMatch(root.textContent,/Late old saved full/);
  await copy.onclick();assert.deepEqual(copies,[],'Detached controls must remain inert after disposal');
 }finally{if(previousWindow===undefined)delete global.window;else global.window=previousWindow;}
}));

test('long-body reads reject a foreign trace, source turn, model, account or saved revision before expansion or copy',()=>dom(async(root)=>{
 const previousWindow=global.window,copies=[];global.window={clw:{command:async(action,payload)=>copies.push({action,payload})}};
 const original={traceId:trace,source:source(trace),bodyRevision:latest.bodyRevision,review:{finalText:'Exact long source '+'x'.repeat(2000000)}};
 let reads=0,response=original;const options={loadBody:()=>{reads++;return response;}};
 try{
  renderTask(root,[latest],options);await flush();const control=root.querySelector('.record-body'),copy=Array.from(control.querySelectorAll('button')).find(button=>button.textContent==='复制全文');
  for(const invalid of [
   {...original,traceId:oldTrace},
   {...original,source:{...original.source,turnId:'foreign-turn'}},
   {...original,source:{...original.source,model:'chatgpt-web/high'}},
   {...original,source:{...original.source,account:'A'}},
   {...original,bodyRevision:'foreign-save'},
   {...original,bodyRevision:undefined,review:{finalSha256:'foreign-save',finalText:original.review.finalText}}
  ]){
   response=invalid;await control.expand();assert.equal(control.dataset.expanded,'false');assert.ok(control.querySelector('.text').textContent.length<2000);
   await copy.onclick();assert.deepEqual(copies,[]);assert.match(control.textContent,/复制未完成/);
  }
  response=original;await control.expand();assert.equal(control.querySelector('.text').textContent,original.review.finalText);await copy.onclick();
  assert.deepEqual(copies,[{action:'copy-record-text',payload:{text:original.review.finalText}}]);assert.equal(reads,14);
 }finally{if(previousWindow===undefined)delete global.window;else global.window=previousWindow;}
}));

test('a new latest reply keeps an explicit pending copy of an already shown exact earlier reply valid',()=>dom(async(root)=>{
 const previousWindow=global.window,copies=[];global.window={clw:{command:async(action,payload)=>copies.push({action,payload})}};
 let finish,originalReads=0;const full='Original exact full '+'x'.repeat(2000000),options={loadBody:id=>{
  if(id===trace&&++originalReads===2)return new Promise(resolve=>{finish=resolve;});
  return {traceId:id,source:source(id),bodyRevision:'saved-'+id,review:{finalText:id===trace?full:'New short reply'}};}};
 try{
  renderTask(root,[latest],options);await flush();const earlier=root.firstChild,control=earlier.querySelector('.record-body'),copy=Array.from(control.querySelectorAll('button')).find(button=>button.textContent==='复制全文');
  const pending=copy.onclick();await flush();const newer=row('cccccccccccc','2026-10-01T03:00:00Z');renderTask(root,[newer,latest],options);await flush();
  assert.equal(earlier.parentNode,root);assert.equal(earlier.querySelector('.record-body'),control);
  finish({traceId:trace,source:source(trace),bodyRevision:latest.bodyRevision,review:{finalText:full}});await pending;
  assert.deepEqual(copies,[{action:'copy-record-text',payload:{text:full}}]);assert.equal(control.dataset.expanded,'false');assert.ok(control.querySelector('.text').textContent.length<2000);
 }finally{if(previousWindow===undefined)delete global.window;else global.window=previousWindow;}
}));

test('leaving a task for overview disposes a cached expanded copy and restores shown replies when the task returns',()=>dom(async(root)=>{
 const previousWindow=global.window,copies=[];global.window={clw:{command:async(action,payload)=>copies.push({action,payload})}};
 const options={loadBody:id=>({traceId:id,source:source(id),bodyRevision:'saved-'+id,review:{finalText:id===trace?'Exact original full '+'x'.repeat(2000000):'Earlier short reply'}})};
 try{
  renderTask(root,[latest,old],options);await flush();focusTrace(root,oldTrace);await flush();
  const control=root.querySelector('[data-trace="'+trace+'"] .record-body');await control.expand();
  const copy=Array.from(control.querySelectorAll('button')).find(button=>button.textContent==='复制全文'),pending=copy.onclick();
  renderOverview(root,groupRows([latest,old]));await pending;
  assert.deepEqual(copies,[]);assert.equal(control.querySelector('.text').textContent,'');assert.equal(invalidateTask(root),false);
  renderTask(root,[latest,old],options);await flush();
  assert.equal(root.querySelector('[data-trace="'+oldTrace+'"]').parentNode,root);assert.equal(root.querySelectorAll('.message').length,2);
  assert.ok(root.querySelector('[data-trace="'+trace+'"] .text').textContent.length<2000);assert.deepEqual(copies,[]);
 }finally{if(previousWindow===undefined)delete global.window;else global.window=previousWindow;}
}));

test('current-owner guard rejects both a late initial body and a cached expanded copy before host dispatch',()=>dom(async(root)=>{
 const previousWindow=global.window,copies=[];global.window={clw:{command:async(action,payload)=>copies.push({action,payload})}};
 let current=true,finish,reads=0;const full='Original owner full '+'x'.repeat(2000000),value={traceId:trace,source:source(trace),bodyRevision:latest.bodyRevision,review:{finalText:full}};
 const options={isCurrent:()=>current,loadBody:()=>++reads===1?new Promise(resolve=>{finish=resolve;}):value};
 try{
  renderTask(root,[latest],options);current=false;finish(value);await flush();
  assert.ok(!root.querySelector('.message'));assert.doesNotMatch(root.textContent,/Original owner full/);assert.equal(reads,1);
  assert.equal(invalidateTask(root),true);assert.equal(invalidateTask(root),false);current=true;
  renderTask(root,[latest],options);await flush();const control=root.querySelector('.record-body');await control.expand();
  assert.equal(control.querySelector('.text').textContent,full);const copy=Array.from(control.querySelectorAll('button')).find(button=>button.textContent==='复制全文');
  const pending=copy.onclick();current=false;await pending;assert.deepEqual(copies,[]);
  invalidateTask(root);assert.equal(control.querySelector('.text').textContent,'');await copy.onclick();assert.deepEqual(copies,[]);
 }finally{if(previousWindow===undefined)delete global.window;else global.window=previousWindow;}
}));

test('short folded replies keep direct text but their async copy still belongs to the current owner',()=>dom(async(root)=>{
 const previousWindow=global.window,copies=[];global.window={clw:{command:async(action,payload)=>copies.push({action,payload})}};
 let current=true,reads=0;const text=Array.from({length:30},(_,i)=>'Short line '+i).join('\n');
 try{
  renderTask(root,[{...latest,review:{finalText:text}}],{isCurrent:()=>current,loadBody:()=>{reads++;throw Error('Short text must not reread');}});await flush();
  const control=root.querySelector('.record-body'),copy=Array.from(control.querySelectorAll('button')).find(button=>button.textContent==='复制全文');
  await control.expand();assert.equal(control.querySelector('.text').textContent,text);assert.equal(reads,0);
  const pending=copy.onclick();current=false;await pending;assert.deepEqual(copies,[]);assert.equal(reads,0);invalidateTask(root);
 }finally{if(previousWindow===undefined)delete global.window;else global.window=previousWindow;}
}));
