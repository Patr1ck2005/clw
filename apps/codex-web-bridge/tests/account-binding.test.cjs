const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {bindThreadAccount}=require('../account-binding.cjs');
const id='01a0dc7b-2a50-7140-a55b-eed50ff96b02';
test('new A thread stays A across restart; unknown account and B replay are refused',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-account-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 bindThreadAccount(home,id,'A');bindThreadAccount(home,id,'A');
 assert.throws(()=>bindThreadAccount(home,id,'B'),/account_mismatch/);
 assert.throws(()=>bindThreadAccount(home,id,'C'),/binding_invalid/);
});
test('old B receipt cannot become an A thread; a damaged binding fails closed',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-account-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'turn-sources'));fs.writeFileSync(path.join(home,'turn-sources','123456abcdef.json'),JSON.stringify({threadId:id}));
 assert.throws(()=>bindThreadAccount(home,id,'A'),/account_mismatch/);
 bindThreadAccount(home,id,'B');fs.writeFileSync(path.join(home,'thread-accounts',id+'.json'),'{');
 assert.throws(()=>bindThreadAccount(home,id,'B'));
});
