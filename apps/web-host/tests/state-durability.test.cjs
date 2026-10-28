'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WorkspaceState}=require('../workspace-state.cjs');
const {writeStatusFiles}=require('../status-files.cjs');
const {writePrivateFileAtomic}=require('../../codex-web-bridge/upstream/launcher/electron/atomic-file.cjs');

test('failure to flush an intent preserves the last complete workspace across reopen',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-durable-'));
 const fsync=fs.fsyncSync;
 try{
  const state=new WorkspaceState(folder,()=>true);state.pendingStarts.original={operation_id:'accepted-original',objective:'original'};state.save();
  const before=fs.readFileSync(state.file);
  state.pendingStarts.new={operation_id:'never-sent',objective:'new'};
  fs.fsyncSync=()=>{throw Object.assign(Error('disk full'),{code:'ENOSPC'});};
  assert.throws(()=>state.save(),/disk full/);
  fs.fsyncSync=fsync;
  assert.deepEqual(fs.readFileSync(state.file),before);
  const reopened=new WorkspaceState(folder,()=>true);
  assert.deepEqual(Object.keys(reopened.pendingStarts),['original']);
  assert.deepEqual(fs.readdirSync(folder),['workspace.json']);
 }finally{fs.fsyncSync=fsync;fs.rmSync(folder,{recursive:true,force:true});}
});

test('a failed status replacement preserves the old file and still publishes other snapshots',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-status-'));
 const rename=fs.renameSync;
 try{
  writeStatusFiles(folder,{'health.json':{at:1},'task-status.json':{at:1}});
  fs.renameSync=(from,to)=>{if(to.endsWith('health.json'))throw Object.assign(Error('disk error'),{code:'EIO'});return rename(from,to);};
  const failures=writeStatusFiles(folder,{'health.json':{at:2},'task-status.json':{at:2}});
  assert.deepEqual(failures,[{file:'health.json',code:'EIO'}]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'health.json'))).at,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'task-status.json'))).at,2);
  assert.equal(fs.readdirSync(folder).length,2);
 }finally{fs.renameSync=rename;fs.rmSync(folder,{recursive:true,force:true});}
});

test('after atomic commit, a cleanup error cannot make the accepted write appear uncommitted',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-commit-'));
 const remove=fs.rmSync;
 try{
  fs.rmSync=()=>{throw Error('cleanup failed');};
  const file=path.join(folder,'workspace.json');
  assert.doesNotThrow(()=>writePrivateFileAtomic(file,'{"accepted":true}',{flush:true}));
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),{accepted:true});
 }finally{fs.rmSync=remove;fs.rmSync(folder,{recursive:true,force:true});}
});
