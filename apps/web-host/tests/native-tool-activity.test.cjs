'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {nativeCalls,nativeStatus,render}=require('../codex-turns.js');
const trace='a1b2c3d4e5f6',other='123456abcdef',call='call_'+'a'.repeat(32);
const event=(traceId,phase,eventId,tool='exec_command')=>({eventId,atMs:1750000000000+eventId,traceId,callId:call,phase,tool});
const source={traceId:trace,threadId:'01a0e08e-0564-7233-803b-258649ecd0dc',turnId:'01a0e08e-057f-7cb0-bbee-505bf95b01f4',workingDirectory:'D:\\fixture',model:'chatgpt-web/extra-high'};

test('native broker events group by exact trace/call and keep result separate from business success',()=>{
  const activity={source:'native_broker_metadata',events:[event(trace,'queued',1),event(other,'result',2),event(trace,'delivered',3),event(trace,'result',4)]};
  assert.deepEqual(nativeCalls(activity,trace).map(e=>e.phase),['result']);
  assert.match(nativeStatus('result'),/成果待核验/);
  assert.match(nativeStatus('retired'),/待核对/);
  assert.deepEqual(nativeCalls({...activity,source:'mcp_union_metadata'},trace),[]);
  assert.deepEqual(nativeCalls({...activity,events:[{...event(trace,'result',4),tool:'evil<script>'}]},trace),[]);
});

test('turn card only displays native events when saved source matches exact trace',()=>{
  const previous=global.document,window=createWindow('<div id="cards"></div>');global.document=window.document;
  if(!window.Element.prototype.replaceChildren)window.Element.prototype.replaceChildren=function(...children){while(this.firstChild)this.removeChild(this.firstChild);for(const child of children)this.appendChild(child);};
  if(!window.Element.prototype.append)window.Element.prototype.append=function(...children){for(const child of children)this.appendChild(child);};
  if(!('dataset' in window.Element.prototype))Object.defineProperty(window.Element.prototype,'dataset',{get(){return new Proxy({}, {get:(_,key)=>this.getAttribute('data-'+key),set:(_,key,value)=>{this.setAttribute('data-'+key,String(value));return true;}});}});
  try{
    const container=window.document.getElementById('cards');
    const row={traceId:trace,source,status:'completed',submission:'confirmed',startedAt:'2026-09-27T01:00:00Z'};
    const nativeActivity={source:'native_broker_metadata',events:[event(trace,'result',1,'exec_gateway')],windowTruncated:true};
    render(container,[row],{nativeActivity});
    assert.match(container.textContent,/工具活动/);
    assert.match(container.textContent,/内部步骤未展示/);
    assert.match(container.textContent,/近期窗口/);
    assert.doesNotMatch(container.textContent,/call_aaaa/);
    render(container,[{...row,source:{...source,traceId:other}}],{nativeActivity});
    assert.doesNotMatch(container.textContent,/工具活动/);
  }finally{global.document=previous;}
});
