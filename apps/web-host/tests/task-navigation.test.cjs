'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {taskList,canArchive,renderOverview,renderTask,renderNavigation}=require('../codex-turns.js');
const row=(thread,trace,status='completed',time='2026-09-28T00:00:00Z')=>({traceId:trace,status,startedAt:time,account:'A',submission:'confirmed',url:'https://chatgpt.com/c/'+thread,source:{threadId:thread,traceId:trace,workingDirectory:'D:/Games/'+thread,model:'chatgpt-web/pro'}});
const rows=[row('camp','111111111111'),row('camp','222222222222','completed','2026-09-28T01:00:00Z'),row('tenet','333333333333','running')];
function dom(run){const prev=global.document,w=createWindow('<div id="root"></div>');global.document=w.document;for(const name of ['append','replaceChildren'])if(!w.Element.prototype[name])w.Element.prototype[name]=function(...items){if(name==='replaceChildren')while(this.firstChild)this.removeChild(this.firstChild);for(const item of items)this.appendChild(item);};if(!('dataset' in w.Element.prototype))Object.defineProperty(w.Element.prototype,'dataset',{get(){return new Proxy({},{set:(_,k,v)=>{this.setAttribute('data-'+k,v);return true;}});}});try{run(w.document.getElementById('root'));}finally{global.document=prev;}}
test('overview counts tasks instead of rounds; search matches same task and archive scope',()=>{assert.equal(taskList(rows).length,2);assert.equal(taskList(rows,{query:'111111111111'})[0].turns.length,2);assert.deepEqual(taskList(rows,{archived:['camp']}).map(g=>g.key),['tenet']);assert.deepEqual(taskList(rows,{archived:['camp'],archiveView:true}).map(g=>g.key),['camp']);});
test('in-flight or unknown execution cannot disappear into archive; new work resurfaces',()=>{const unknown=row('unknown','444444444444','needs_reconciliation');const groups=taskList([...rows,unknown],{archived:['tenet','unknown']});assert.equal(groups.length,3);assert.equal(canArchive(groups.find(g=>g.key==='tenet')),false);assert.equal(canArchive(groups.find(g=>g.key==='unknown')),false);});
test('overview selection and archive only invoke display callbacks',()=>dom(root=>{let selected=null,archived=null;renderOverview(root,taskList(rows),{onSelect:key=>selected=key,onArchive:(...args)=>archived=args});assert.equal(root.querySelectorAll('article').length,2);root.querySelector('button').click();assert.equal(selected,'camp');root.querySelectorAll('button')[1].click();assert.deepEqual(archived,['camp',true]);assert.equal(root.querySelectorAll('button')[3].disabled,true);}));
test('single task shows latest round with prior rounds collapsed and exact page action',()=>dom(root=>{
 let opened=null;renderTask(root,rows.filter(r=>r.source.threadId==='camp'),{onView:trace=>opened=trace});
 const history=root.querySelector('.task-turn-history'),latest=root.lastChild;
 assert.equal(root.childElementCount,2);
 assert.equal(root.firstChild,history,'Prior rounds precede the latest reply in reading order');
 assert.equal(latest.tagName,'ARTICLE');assert.equal(latest.getAttribute('data-trace'),'222222222222');
 assert.equal(latest.querySelector('.native-turn-body').hasAttribute('open'),true);
 assert.equal(history.hasAttribute('open'),false);assert.equal(history.querySelectorAll('article').length,1);
 assert.equal(history.querySelector('article').getAttribute('data-trace'),'111111111111');
 Array.from(latest.querySelectorAll('button')).find(b=>b.textContent.includes('查看对话网页')).click();
 assert.equal(opened,'222222222222');
 Array.from(history.querySelectorAll('button')).find(b=>b.textContent.includes('查看对话网页')).click();
 assert.equal(opened,'111111111111','An earlier round opens its own saved page');
}));
test('navigation and overview share the archive and search filter',()=>dom(root=>{renderNavigation(root,rows,{selected:'camp',archived:['camp'],archiveView:true,query:'camp',onSelect:()=>{}});assert.equal(root.querySelectorAll('button').length,1);assert.equal(root.querySelector('button').getAttribute('aria-current'),'page');}));
test('Codex work record uses the shared reply presentation without interpreting model text as HTML',()=>dom(root=>{
 const text='**Answer**\n$$x^2$$\n<script>not executed</script>';
 renderTask(root,[{...rows[0],review:{finalText:text}}]);
 assert.equal(root.querySelector('.message .text strong').textContent,'Answer');assert.equal(root.querySelectorAll('.message .text .katex').length,1);
 assert.match(root.querySelector('.message .text').textContent,/<script>not executed<\/script>/);assert.equal(root.querySelectorAll('script').length,0);
 assert.match(root.querySelector('.message-meta').textContent,/网页.*回复/);
}));
