const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {launchArguments,launchCodex,resumeTurnPayload}=require('../launch-codex.cjs');
test('native entry keeps workspace/model as argv and resume opens the native picker',()=>{
 const root=path.resolve(__dirname,'../../..');
 const args=launchArguments(root,{model:'pro',workingDirectory:root,resume:true});
 assert.equal(args[args.indexOf('-WorkingDirectory')+1],root);
 assert.equal(args[args.indexOf('-Model')+1],'pro');assert.deepEqual(args.slice(-2),['-Resume','pick']);
 assert.throws(()=>launchArguments(root,{model:'gpt-6-astra',workingDirectory:root}));
 assert.throws(()=>launchArguments(root,{model:'pro',workingDirectory:root+';exit'}));
});
test('the verified Web account stays a separate argv and an invalid account is rejected',()=>{
 const root=path.resolve(__dirname,'../../..');
 const args=launchArguments(root,{model:'high',workingDirectory:root,account:'A'});
 assert.equal(args[args.indexOf('-Account')+1],'A');
 assert.throws(()=>launchArguments(root,{model:'high',workingDirectory:root,account:'A;exit'}),/账号/);
});
test('account changes while connector checks wait cannot launch the original resume in another account',async t=>{
 const fs=require('node:fs'),os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-native-account-race-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let account='A';
 const bridge={snapshot:()=>({state:'ready',account}),checkTools:async()=>{account='B';return {ready:true};},health:async()=>({accepting_turns:true})};
 await assert.rejects(launchCodex(root,{model:'high',workingDirectory:root,account:'A'},bridge),/账号已改变/);
});
test('source changes or a newly running turn during health checks prevent opening a competing resume',async t=>{
 const fs=require('node:fs'),os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-native-source-race-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const row={traceId:'123456abcdef',status:'completed',browserStatus:'completed',nativeState:{state:'completed',threadId:'01a0dc7b-2a50-7140-a55b-eed50ff96b02',turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b03',source:'native_session_canonical',endedAt:'2026-10-04T10:00:00Z',threadActive:false,activeTurnId:null,nativeProof:{version:1,kind:'canonical_full_session',threadId:'01a0dc7b-2a50-7140-a55b-eed50ff96b02',turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b03',terminal:'task_complete_with_matching_final',sessionSha256:'a'.repeat(64),eventSha256:'b'.repeat(64)}},source:{threadId:'01a0dc7b-2a50-7140-a55b-eed50ff96b02',turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b03',model:'chatgpt-web/high',workingDirectory:root,account:'A'}};
 let rows=[row];const bridge={turns:()=>rows,snapshot:()=>({state:'ready',account:'A'}),checkTools:async()=>({ready:true}),health:async()=>({accepting_turns:true})};
 const payload=resumeTurnPayload(bridge,row.traceId);
 bridge.health=async()=>{rows=[{...row,source:{...row.source,model:'chatgpt-web/pro'}}];return {accepting_turns:true};};
 await assert.rejects(launchCodex(root,payload,bridge),/来源已改变/);
 rows=[row];bridge.health=async()=>{const turnId='01a0dc7b-2a50-7140-a55b-eed50ff96b04';rows=[{...row,nativeState:{...row.nativeState,turnId,nativeProof:{...row.nativeState.nativeProof,turnId}},source:{...row.source,turnId}}];return {accepting_turns:true};};
 await assert.rejects(launchCodex(root,payload,bridge),/来源已改变/);
 rows=[row];bridge.health=async()=>{rows.push({...row,traceId:'other',status:'running'});return {accepting_turns:true};};
 await assert.rejects(launchCodex(root,payload,bridge),/还有运行中/);
 rows=[row];bridge.health=async()=>{rows=[{...row,nativeState:{...row.nativeState,threadActive:true,activeTurnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b04'}}];return {accepting_turns:true};};
 await assert.rejects(launchCodex(root,payload,bridge),/运行或待核对/);
});
