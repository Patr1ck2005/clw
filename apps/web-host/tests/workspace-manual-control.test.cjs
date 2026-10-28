'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WorkspaceState,restoreConversationUrl}=require('../workspace-state.cjs');
const id='web-11111111-2222-3333-4444-555555555555',original='https://chatgpt.com/c/original-task',manual='https://chatgpt.com/c/manual-chat';
const allowed=raw=>{try{const u=new URL(raw);return u.protocol==='https:'&&['chatgpt.com','auth.openai.com'].includes(u.hostname);}catch{return false;}};
function fixture(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-manual-workspace-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const workspace=new WorkspaceState(home,allowed),record={page_id:id,phase:'bound',account:'A',url:original,latest_request:{id:'original-request',phase:'queued'}};
  workspace.update(id,{url:original,account:'A',kind:'task',requestId:record.latest_request.id});workspace.syncBindings([record]);
  return {home,workspace,record};
}

test('saving and restarting preserve a manually selected chat separately from the original bound task',t=>{
  const f=fixture(t),page={id,account:'A',kind:'task',url:manual,manualUrl:manual,manualControl:true,manualInteractionSequence:7};
  f.workspace.capture({selected:id,inspect:()=>[page]},new Map([[id,f.record]]));f.workspace.save();
  const restarted=new WorkspaceState(f.home,allowed),saved=restarted.tasks.get(id);
  assert.equal(saved.boundUrl,original);assert.equal(saved.url,manual);assert.equal(saved.manualUrl,manual);assert.equal(saved.manualControl,true);
  assert.equal(restoreConversationUrl(f.record,saved),manual);assert.equal(restarted.selected,id);
  restarted.syncBindings([f.record]);assert.equal(restoreConversationUrl(f.record,restarted.tasks.get(id)),manual);
  assert.equal(f.record.latest_request.id,'original-request');assert.equal(f.record.url,original);
});

test('a held manual homepage remains a homepage after restart instead of reopening the original task',t=>{
  const f=fixture(t);f.workspace.update(id,{manualControl:true,manualUrl:'https://chatgpt.com/',url:'https://chatgpt.com/'});f.workspace.save();
  const restarted=new WorkspaceState(f.home,allowed),saved=restarted.tasks.get(id);
  assert.equal(saved.boundUrl,original);assert.equal(restoreConversationUrl(f.record,saved),'https://chatgpt.com/');
});

test('auth redirects preserve the prior manual chat and never replace the bound task identity',t=>{
  const f=fixture(t);f.workspace.update(id,{manualControl:true,manualUrl:manual,url:manual});
  f.workspace.capture({selected:id,inspect:()=>[{id,account:'A',url:'https://auth.openai.com/login',manualControl:true,manualUrl:manual}]},new Map([[id,f.record]]));
  f.workspace.save();const restarted=new WorkspaceState(f.home,allowed),saved=restarted.tasks.get(id);
  assert.equal(saved.boundUrl,original);assert.equal(saved.manualUrl,manual);assert.equal(restoreConversationUrl(f.record,saved),manual);
});

test('another account or an unsafe manual URL cannot override the task restore position',t=>{
  const f=fixture(t);
  assert.equal(restoreConversationUrl(f.record,{id,account:'B',manualControl:true,manualUrl:manual}),original);
  for(const bad of ['https://example.org/c/chat','http://chatgpt.com/c/chat','file:///C:/private','https://chatgpt.com.evil.test/c/chat'])
    assert.equal(restoreConversationUrl(f.record,{id,account:'A',manualControl:true,manualUrl:bad}),original);
});

test('changing the descriptor account clears its previous manual ownership rather than carrying a held chat across accounts',t=>{
  const f=fixture(t);f.workspace.update(id,{manualControl:true,manualUrl:manual,url:manual});
  const changed=f.workspace.update(id,{account:'B'});assert.equal(changed.manualControl,undefined);assert.equal(changed.manualUrl,undefined);
  f.workspace.save();const restarted=new WorkspaceState(f.home,allowed),saved=restarted.tasks.get(id);
  assert.equal(saved.account,'B');assert.equal(saved.manualControl,undefined);assert.equal(saved.manualUrl,undefined);
  assert.equal(restoreConversationUrl(f.record,saved),original);
});

test('an explicit release stops restoring the old manual position without erasing its saved reference',t=>{
  const f=fixture(t);f.workspace.update(id,{manualControl:true,manualUrl:manual,url:manual});
  assert.equal(restoreConversationUrl(f.record,f.workspace.tasks.get(id)),manual);
  f.workspace.update(id,{manualControl:false});f.workspace.save();
  const restarted=new WorkspaceState(f.home,allowed);assert.equal(restoreConversationUrl(f.record,restarted.tasks.get(id)),original);
  assert.equal(restarted.tasks.get(id).boundUrl,original);
});
