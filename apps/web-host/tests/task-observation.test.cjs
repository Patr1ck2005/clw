'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WebDriver}=require('../web-driver.cjs');
const {EventEmitter}=require('node:events');
test('formal observation reads a generating original page without opening controls or exposing its draft',async()=>{
  const wc={},page={id:'original',account:'A',documentGeneration:2,view:{webContents:wc}},calls=[];
  const driver=new WebDriver({pool:{},runtime:new EventEmitter(),dom:async(original,action,arg)=>{
    assert.equal(original,wc);calls.push(action);
    if(action==='snapshot')return {url:'https://chatgpt.com/c/original',generating:true,draft:true,userId:'user body',assistantId:'reply'};
    assert.equal(arg.expectedConnector,'Local-MCP');assert.equal(arg.diagnostics,true);
    return {editorCount:1,text:'原草稿',selected:['Local-MCP'],visibleSelectedCount:1,generating:true};
  }});
  const result=await driver.observeTask(page);
  assert.deepEqual(calls,['snapshot','connector-state']);assert.equal(result.snapshot.generating,true);
  assert.equal(result.composer.text_utf8_bytes,9);assert.equal(result.composer.text,undefined);
  assert.equal(result.user_turn_sha256.length,64);assert.equal(JSON.stringify(result).includes('user body'),false);
});
test('navigation between original reads discards observation rather than reading a replacement page',async()=>{
  const wc={},page={id:'original',account:'A',documentGeneration:2,view:{webContents:wc}},calls=[];
  const driver=new WebDriver({pool:{},runtime:new EventEmitter(),dom:async(_,action)=>{calls.push(action);page.documentGeneration++;return {};}});
  await assert.rejects(driver.observeTask(page),/task_observation_original_page_changed/);
  assert.deepEqual(calls,['snapshot']);
});
