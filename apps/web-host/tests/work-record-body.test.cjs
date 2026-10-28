'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {body,message}=require('../work-record.js');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function dom(run){
 const previousDocument=global.document,previousWindow=global.window,w=createWindow('<div id="root"></div>'),commands=[];
 global.document=w.document;global.window={clw:{command:async(action,payload)=>{commands.push({action,payload});}}};
 for(const name of ['append','replaceChildren'])if(!w.Element.prototype[name])w.Element.prototype[name]=function(...items){if(name==='replaceChildren')while(this.firstChild)this.removeChild(this.firstChild);for(const item of items)this.appendChild(item);};
 if(!('dataset' in w.Element.prototype))Object.defineProperty(w.Element.prototype,'dataset',{get(){const attr=key=>'data-'+key.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());return new Proxy({},{get:(_,key)=>this.getAttribute(attr(key)),set:(_,key,value)=>{this.setAttribute(attr(key),value);return true;}});}});
 try{await run(w.document.getElementById('root'),commands);}finally{global.document=previousDocument;if(previousWindow===undefined)delete global.window;else global.window=previousWindow;}
}
const copyButton=node=>Array.from(node.querySelectorAll('button')).find(button=>button.textContent==='复制全文');
function frameClock(root){
 const view=root.ownerDocument.defaultView,frames=new Map();let serial=0;
 view.requestAnimationFrame=callback=>{const id=++serial;frames.set(id,callback);return id;};
 view.cancelAnimationFrame=id=>frames.delete(id);
 return {get pending(){return frames.size;},next(){const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback();}};
}

test('remote message holds a preview by default and releases expanded or copied full text when closed',()=>dom(async(root,commands)=>{
 const full='Exact source\n'+'x'.repeat(2000000)+'\nExact tail';let reads=0;
 root.append(message('Reply',full,{length:full.length,load:()=>{reads++;return full;}}));
 const control=root.querySelector('.record-body'),toggle=control.querySelector('.record-body-toggle'),copy=copyButton(control);
 assert.equal(reads,0);assert.ok(control.querySelector('.text').textContent.length<2000);assert.equal(control.dataset.expanded,'false');
 await toggle.onclick();assert.equal(reads,1);assert.equal(control.querySelector('.text').textContent,full);
 await copy.onclick();assert.equal(reads,1);assert.deepEqual(commands,[{action:'copy-record-text',payload:{text:full}}]);
 await toggle.onclick();assert.equal(control.dataset.expanded,'false');assert.ok(control.querySelector('.text').textContent.length<2000);
 await toggle.onclick();assert.equal(reads,2,'Collapsing releases the remote full value instead of keeping it in the body closure');
 control.collapse();await copy.onclick();assert.equal(reads,3);assert.equal(control.dataset.expanded,'false');
 await toggle.onclick();assert.equal(reads,4,'Copying a closed reply must not leave its full value resident');assert.equal(control.querySelector('.text').textContent,full);
}));

test('collapse during a remote read rejects its late value and a new expansion reads again',()=>dom(async(root)=>{
 let finish,reads=0;const control=body('Saved preview',{length:2000000,load:()=>++reads===1?new Promise(resolve=>{finish=resolve;}):'Exact new full'});root.append(control);
 const pending=control.expand();await flush();assert.equal(reads,1);control.collapse();finish('Late full '+'x'.repeat(2000000));await pending;
 assert.equal(control.dataset.expanded,'false');assert.equal(control.querySelector('.text').textContent,'Saved preview');assert.doesNotMatch(root.textContent,/Late full/);
 await control.expand();assert.equal(reads,2);assert.equal(control.querySelector('.text').textContent,'Exact new full');
}));

test('dispose cancels a pending copy before clipboard dispatch and prevents detached body reuse',()=>dom(async(root,commands)=>{
 let finish,reads=0;const control=body('Saved preview',{length:2000000,load:()=>{reads++;return new Promise(resolve=>{finish=resolve;});}});root.append(control);
 const copy=copyButton(control),pending=copy.onclick();await flush();assert.equal(reads,1);
 control.dispose();finish('Disposed old full '+'x'.repeat(2000000));await pending;
 assert.deepEqual(commands,[]);assert.equal(control.querySelector('.text').textContent,'');
 await copy.onclick();await control.expand();assert.equal(reads,1);assert.deepEqual(commands,[]);
}));

test('explicit expansion and copy share a pending source read without any automatic clipboard action',()=>dom(async(root,commands)=>{
 let finish,reads=0;const full='Exact shared full '+'x'.repeat(2000000),control=body('Saved preview',{length:full.length,load:()=>{reads++;return new Promise(resolve=>{finish=resolve;});}});root.append(control);
 assert.equal(reads,0);assert.deepEqual(commands,[]);
 const copied=copyButton(control).onclick(),expanded=control.expand();await flush();assert.equal(reads,1);
 finish(full);await Promise.all([copied,expanded]);assert.equal(control.querySelector('.text').textContent,full);
 assert.deepEqual(commands,[{action:'copy-record-text',payload:{text:full}}]);control.collapse();assert.ok(control.querySelector('.text').textContent.length<2000);
}));

test('short messages and local folded text do not add a remote read path',()=>dom(async(root,commands)=>{
 root.append(message('Reply','Short exact result'));assert.equal(root.querySelector('.text').textContent,'Short exact result');assert.ok(!root.querySelector('.record-body'));
 root.append(message('Lines',Array.from({length:30},(_,i)=>'Line '+i).join('\n')));
 const control=root.querySelector('.record-body');assert.ok(control);await control.expand();assert.match(control.querySelector('.text').textContent,/Line 29/);
 assert.deepEqual(commands,[]);
}));

test('current-owner guard cancels a cached full copy after its await and before clipboard dispatch',()=>dom(async(root,commands)=>{
 let current=true,reads=0;const control=body('Saved preview',{length:2000000,isCurrent:()=>current,load:()=>{reads++;return 'Original exact full '+'x'.repeat(2000000);}});root.append(control);
 await control.expand();assert.equal(reads,1);const copy=copyButton(control),pending=copy.onclick();current=false;await pending;
 assert.deepEqual(commands,[]);await copy.onclick();assert.deepEqual(commands,[]);assert.equal(reads,1);
 control.dispose();assert.equal(control.querySelector('.text').textContent,'');
}));

test('large cached and remote bodies leave their preview and pending controls through the first animation frame',()=>dom(async(root)=>{
 const clock=frameClock(root),full='Exact full\n'+'x'.repeat(2000000)+'\nExact tail';
 for(const remote of [false,true]){
  const control=body(remote?'Saved preview':full,remote?{length:full.length,load:()=>full}:{});root.append(control);
  const toggle=control.querySelector('.record-body-toggle'),pending=control.expand();await flush();
  assert.equal(clock.pending,1);assert.equal(toggle.getAttribute('aria-busy'),'true');
  assert.equal(control.dataset.expanded,'false');assert.ok(control.querySelector('.text').textContent.length<2000);
  clock.next();await flush();assert.equal(clock.pending,1);
  assert.equal(toggle.getAttribute('aria-busy'),'true');assert.equal(control.dataset.expanded,'false');
  assert.match(control.querySelector('[role="status"]').textContent,/正在展开正文/);
  clock.next();await pending;assert.equal(clock.pending,0);assert.equal(toggle.getAttribute('aria-busy'),'false');
  assert.equal(control.querySelector('.text').textContent,full);control.dispose();control.remove();
 }
}));

test('collapse, disposal and owner change while pending never render the delayed full body',()=>dom(async(root)=>{
 const clock=frameClock(root),full='Delayed exact full '+'x'.repeat(2000000);
 for(const action of ['collapse','dispose','owner']){
  let current=true;const control=body('Saved preview',{length:full.length,load:()=>full,isCurrent:()=>current});root.append(control);
  const pending=control.expand();await flush();assert.equal(clock.pending,1);clock.next();await flush();
  if(action==='owner')current=false;else control[action]();
  if(action==='owner')clock.next();assert.equal(clock.pending,0);await pending;
  assert.notEqual(control.querySelector('.text').textContent,full);assert.equal(control.dataset.expanded,'false');
  control.dispose();control.remove();
 }
}));

test('a detached body, hidden workflow or closed outer message cancels its pending large paint',()=>dom(async(root)=>{
 const clock=frameClock(root),full='Original exact full '+'x'.repeat(2000000);
 for(const action of ['detach','hidden','closed']){
  const details=root.ownerDocument.createElement('details');details.open=true;root.append(details);
  const control=body('Saved preview',{length:full.length,load:()=>full});details.append(control);
  const pending=control.expand();await flush();clock.next();await flush();
  if(action==='detach')details.remove();else if(action==='hidden')details.hidden=true;else details.open=false;
  clock.next();await pending;assert.equal(clock.pending,0);assert.equal(control.dataset.expanded,'false');
  assert.equal(control.querySelector('.text').textContent,'Saved preview');assert.equal(control.querySelector('.record-body-toggle').getAttribute('aria-busy'),'false');
  control.dispose();details.remove();
 }
}));

test('hidden documents and visibility changes finish without waiting for suspended frames',()=>dom(async(root)=>{
 const clock=frameClock(root),doc=root.ownerDocument,full='Exact hidden full '+'x'.repeat(2000000);let hidden=true;
 Object.defineProperty(doc,'hidden',{configurable:true,get:()=>hidden});
 const control=body('Saved preview',{length:full.length,load:()=>full});root.append(control);
 await control.expand();assert.equal(clock.pending,0);assert.equal(control.querySelector('.text').textContent,full);
 control.collapse();hidden=false;const pending=control.expand();await flush();assert.equal(clock.pending,1);
 hidden=true;const event=doc.createEvent('Event');event.initEvent('visibilitychange',false,false);doc.dispatchEvent(event);
 await pending;assert.equal(clock.pending,0);assert.equal(control.querySelector('.text').textContent,full);control.dispose();
}));

test('missing frame delivery is bounded and short folded text does not wait for animation frames',()=>dom(async(root)=>{
 const clock=frameClock(root),full='Exact bounded full '+'x'.repeat(2000000);
 const control=body('Saved preview',{length:full.length,load:()=>full});root.append(control);
 await control.expand();assert.equal(clock.pending,0);assert.equal(control.querySelector('.text').textContent,full);control.dispose();
 const short=body(Array.from({length:30},(_,i)=>'Line '+i).join('\n'));root.append(short);
 await short.expand();assert.equal(clock.pending,0);assert.match(short.querySelector('.text').textContent,/Line 29/);short.dispose();
}));
