'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const protocol=require('../focus-startup.cjs'),token='a'.repeat(32);
function loadFocus(argv,primary){
  const required=[],calls=[],app={
    setPath:(...args)=>calls.push(['setPath',...args]),setName:(...args)=>calls.push(['setName',...args]),
    requestSingleInstanceLock:data=>{calls.push(['lock',data]);return primary;},quit:()=>calls.push(['quit'])
  };
  const context={process:{argv},__dirname:path.resolve(__dirname,'..'),require:name=>{
    required.push(name);
    if(name==='./focus-startup.cjs')return protocol;
    if(name==='node:path')return path;
    if(name==='electron')return {app};
    throw Error('project initialization forbidden: '+name);
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),context);
  return {required,calls};
}
for(const primary of [false,true])test(`focus-only ${primary?'wins':'loses'} Electron lock without initializing a workspace`,()=>{
  const f=loadFocus(['electron','app',protocol.FLAG,protocol.TARGET+token],primary);
  assert.deepEqual(f.required,['./focus-startup.cjs','node:path','electron']);
  assert.deepEqual(f.calls.map(row=>row[0]),['setPath','setName','lock','quit']);
  assert.deepEqual(f.calls[2][1],{clwFocusExistingOnly:1,expectedGuiToken:token});
  assert.equal(f.calls[0][1],'userData');assert.match(f.calls[0][2],/[\\/]\.local[\\/]web-host$/);
});
test('invalid, missing, duplicate, or target-only focus arguments cannot enter normal initialization',()=>{
  for(const argv of [[protocol.FLAG],[protocol.FLAG,protocol.TARGET+'bad'],[protocol.FLAG,protocol.TARGET+token,protocol.TARGET+token],
    [protocol.FLAG,protocol.FLAG,protocol.TARGET+token],[protocol.TARGET+token],[protocol.FLAG+'=true']]){
    const f=loadFocus(['electron','app',...argv],true);assert.deepEqual(f.calls,[['quit']]);
    assert.equal(f.required.length,3);
  }
});
test('primary accepts its own GUI token from additionalData even if received argv is incomplete',()=>{
  const data={clwFocusExistingOnly:1,expectedGuiToken:token};
  assert.equal(protocol.shouldFocusExisting([],data,token),true);
  assert.equal(protocol.shouldFocusExisting([protocol.FLAG],data,token),true);
});
test('wrong GUI, malformed metadata, or bare focus flags cannot focus another primary',()=>{
  const rows=[null,{},[],{clwFocusExistingOnly:1},{clwFocusExistingOnly:1,expectedGuiToken:'b'.repeat(32)},
    {clwFocusExistingOnly:true,expectedGuiToken:token},{clwFocusExistingOnly:1,expectedGuiToken:token,extra:1},
    Object.assign(Object.create({expectedGuiToken:token}),{clwFocusExistingOnly:1})];
  for(const data of rows)assert.equal(protocol.shouldFocusExisting([protocol.FLAG],data,token),false);
  assert.equal(protocol.shouldFocusExisting([protocol.TARGET+token],{},token),false);
});
test('ordinary existing Electron second-instance opens retain their normal behavior',()=>{
  assert.equal(protocol.shouldFocusExisting(['electron','app'],{},token),true);
  assert.equal(protocol.shouldFocusExisting(['electron','app'],undefined,token),true);
});
