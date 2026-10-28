'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Feedback}=require('../interaction-feedback.js');
function node(aria=null){const attributes=new Map(aria===null?[]:[['aria-busy',aria]]),classes=new Set();
  return {getAttribute:key=>attributes.get(key)??null,setAttribute:(key,value)=>attributes.set(key,value),
    removeAttribute:key=>attributes.delete(key),classList:{add:key=>classes.add(key),remove:key=>classes.delete(key),contains:key=>classes.has(key)}};}
test('pending feedback is immediate and returns to its original state after overlapping operations',()=>{
  const changes=[],feedback=new Feedback({onChange:()=>changes.push(feedback.snapshot()?.action||null),now:()=>123}),button=node('false');
  const first=feedback.begin('select',{node:button,owner:'A'});
  assert.equal(button.getAttribute('aria-busy'),'true');assert.equal(button.classList.contains('interaction-pending'),true);
  assert.equal(feedback.snapshot().startedAt,123);assert.deepEqual(changes,['select']);
  const second=feedback.begin('goal-save',{node:button,owner:'A'});first();first();
  assert.equal(feedback.snapshot().action,'goal-save');assert.equal(button.getAttribute('aria-busy'),'true');
  second();assert.equal(feedback.snapshot(),null);assert.equal(button.getAttribute('aria-busy'),'false');
  assert.equal(button.classList.contains('interaction-pending'),false);
});
test('a pending operation belongs to its original task and failure clears waiting without claiming success',async()=>{
  const feedback=new Feedback(),button=node(),finish=feedback.begin('record-body',{node:button,owner:'A'});
  assert.equal(feedback.snapshot(owner=>owner==='B'),null);
  assert.equal(feedback.snapshot(owner=>owner==='A').label,'正在读取正文');
  await assert.rejects((async()=>{try{throw Error('original read refused');}finally{finish();}})(),/original read refused/);
  assert.equal(feedback.snapshot(),null);assert.equal(button.getAttribute('aria-busy'),null);
});
