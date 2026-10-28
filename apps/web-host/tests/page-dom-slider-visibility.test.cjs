'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {dom}=require('../page-dom.cjs');

function thumb({id='active-thumb',attrs='aria-hidden="true"',version='6',position=4,valueText=false}={}){
  return '<span id="'+id+'" role="slider" '+attrs+' aria-valuemin="0" aria-valuemax="4" aria-valuenow="'+position+'"'+
    (valueText?' aria-valuetext="'+version+' Pro，第 5 项，共 5 项。"':'')+'></span>';
}
function capturedMenu({thumbAttrs='aria-hidden="true"',prefix='',innerPrefix='',containerStyle='',thumbWrapper='',menuWrapper=''}={}){
  // Public fields captured in memory3-spire-public-slider-details.json: two
  // description IDs, five empty selected ticks, and a visually rendered thumb
  // with aria-hidden=true. No guessed labels or browser/network access.
  const ticks=Array.from({length:5},()=>'<span data-selected="true"></span>').join('');
  const activeThumb=thumb({attrs:thumbAttrs}),wrapped=thumbWrapper?'<span '+thumbWrapper+'>'+activeThumb+'</span>':activeThumb;
  let active='<div data-model-picker-power-slider style="'+containerStyle+'">'+innerPrefix+
    '<span data-orientation="horizontal" aria-disabled="false">'+ticks+wrapped+'</span></div>';
  if(menuWrapper)active='<div '+menuWrapper+'>'+active+'</div>';
  const window=createWindow('<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox"></div>'+
    '<button data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" aria-haspopup="menu" aria-controls="owned-picker">思考强度</button></form>'+
    '<div id="owned-picker" role="menu"><div role="menuitemradio" aria-checked="true">最新</div>'+prefix+
    '<span id="desc-value">6 Pro，第 5 项，共 5 项。</span><span id="desc-key">使用左右方向键调整强度</span>'+
    '<div id="active-item" role="menuitem" aria-describedby="desc-value desc-key">'+active+'</div></div>');
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.closest('[hidden],[inert]')?0:28;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return this.offsetWidth?28:0;}});
  window.HTMLElement.prototype.getClientRects=function(){return this.offsetWidth?[{}]:[];};
  for(const list of [window.document.querySelectorAll('div'),window.document.body.children])Object.defineProperty(Object.getPrototypeOf(list),Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
  const focused=[];for(const element of window.document.querySelectorAll('[role="slider"],[role="menuitem"]'))
    Object.defineProperty(element,'focus',{configurable:true,value(){focused.push(this);}});
  const context=vm.createContext({document:window.document,location:{href:'https://chatgpt.com/c/original'},
    getComputedStyle:element=>({display:element.style.display||'block',visibility:element.style.visibility||'visible'})});
  const read=action=>vm.runInContext(`(${dom.toString()})(${JSON.stringify(action)},{},()=>{},()=>false,()=>({required:false}))`,context);
  return {model:JSON.parse(JSON.stringify(read('model'))),focus:()=>read('focus-effort'),focused,window};
}

test('captured aria-hidden but visually rendered thumb reads exact 6 Pro from its actual menuitem descriptions',()=>{
  const h=capturedMenu(),m=h.model;
  assert.equal(m.sliderCount,1);assert.equal(m.sliderContainerCount,1);assert.equal(m.model,'GPT-6 · 最新');assert.equal(m.effort,'Pro');
  assert.equal(m.description,'6 Pro，第 5 项，共 5 项。 使用左右方向键调整强度');assert.deepEqual(m.slider,{min:0,max:4,value:4});
  assert.equal(m.efforts.length,5);assert.ok(m.efforts.every(choice=>choice.available));
  h.focus();assert.equal(h.focused.length,1);assert.equal(h.focused[0].id,'active-item');
});

test('CSS-hidden thumbs and hidden or inert ancestors are rejected even with nonzero reported geometry',()=>{
  for(const options of [
    {thumbAttrs:'aria-hidden="true" style="display:none"'},
    {thumbAttrs:'aria-hidden="true" style="visibility:hidden"'},
    {thumbAttrs:'aria-hidden="true" style="visibility:collapse"'},
    {thumbWrapper:'hidden'},{thumbWrapper:'inert'},{thumbWrapper:'style="display:none"'},
    {thumbWrapper:'style="visibility:hidden"'},
    {containerStyle:'display:none'},{containerStyle:'visibility:hidden'},
    {menuWrapper:'hidden'},{menuWrapper:'style="visibility:hidden"'}
  ]){
    const h=capturedMenu(options);assert.equal(h.model.sliderCount,0,JSON.stringify(options));assert.equal(h.model.slider,null);
    assert.throws(()=>h.focus(),/effort_slider_missing/);assert.equal(h.focused.length,0);
  }
});

test('hidden old container first cannot replace the visible aria-hidden native thumb',()=>{
  const stale='<div hidden><div data-model-picker-power-slider>'+thumb({id:'old-thumb',version:'7',valueText:true})+'</div></div>';
  const h=capturedMenu({prefix:stale});assert.equal(h.model.model,'GPT-6 · 最新');assert.equal(h.model.effort,'Pro');
  assert.equal(h.model.sliderCount,1);assert.equal(h.model.sliderContainerCount,1);h.focus();assert.equal(h.focused[0].id,'active-item');
});

test('a CSS-hidden older slider in the same container is excluded from the visual target',()=>{
  const h=capturedMenu({innerPrefix:thumb({id:'old-thumb',version:'7',valueText:true,attrs:'aria-hidden="true" style="visibility:hidden"'})});
  assert.equal(h.model.model,'GPT-6 · 最新');assert.equal(h.model.sliderCount,1);h.focus();assert.equal(h.focused[0].id,'active-item');
});

test('two visually rendered thumbs are ambiguous even when both are aria-hidden',()=>{
  const h=capturedMenu({innerPrefix:thumb({id:'other-thumb',attrs:'aria-hidden="true"'})});
  assert.equal(h.model.sliderCount,2);assert.equal(h.model.slider,null);assert.throws(()=>h.focus(),/effort_slider_missing/);assert.equal(h.focused.length,0);
});
