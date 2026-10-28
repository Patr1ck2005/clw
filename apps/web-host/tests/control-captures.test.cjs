'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createCaptureStore}=require('../control-captures.cjs');
test('repeated captures retain a bounded recent cache and preserve unrelated control files',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clw-captures-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'operations.sqlite'),'journal');await fs.writeFile(path.join(dir,'user.png'),'user');
  const store=createCaptureStore(dir,{limit:4});const results=await Promise.all(Array.from({length:80},(_,i)=>store.capture(Buffer.from('capture'+i))));
  assert.equal((await fs.readdir(dir)).filter(name=>name.startsWith('capture-')).length,4);
  assert.equal(await fs.readFile(results.at(-1).path,'utf8'),'capture79');
  assert.equal(await fs.readFile(path.join(dir,'operations.sqlite'),'utf8'),'journal');
  assert.equal(await fs.readFile(path.join(dir,'user.png'),'utf8'),'user');
});
test('a locked old capture does not invalidate the new snapshot and is retried on next capture',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clw-captures-lock-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let locked=true;const io={...fs,unlink:async file=>{if(locked)throw Object.assign(Error('locked'),{code:'EPERM'});return fs.unlink(file);}};
  const store=createCaptureStore(dir,{limit:1,io});await store.capture(Buffer.from('first'));
  assert.equal((await store.capture(Buffer.from('second'))).cleanup_pending,true);
  locked=false;assert.equal((await store.capture(Buffer.from('third'))).cleanup_pending,false);
  assert.equal((await fs.readdir(dir)).length,1);
});
