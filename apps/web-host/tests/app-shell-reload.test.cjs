'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const main=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
const code=main.slice(main.indexOf('async function reloadShell('),main.indexOf('function pageById('));
function fixture(){
  const contents=new EventEmitter(),web={isDestroyed:()=>false},page={view:{webContents:web}};
  const calls=[],runtime={child:{pid:123}},context={shellReloading:false,quitting:false,maintenanceChecking:false,
    appControlIdentity:require('../app-control-identity.cjs'),runtime,driver:{},nativeBridge:{},shellRevision:1,shellSources:null,
    __dirname:'D:/clw/apps/web-host',path,ownedQuitPages:()=>[{page,contents:web}],
    currentShellSources:()=>({index:'original'}),publish:()=>calls.push('publish'),
    win:{webContents:contents,async loadFile(file){calls.push(file);}},
    shellControl:{request:async action=>action==='prepare-reload'?{safe:true}:{selected:'original'},invalidate:()=>calls.push('invalidate')}};
  vm.runInNewContext(code,context);return {context,calls,page,web,contents};
}
test('real main shell reload keeps the original webpage, driver and Host and only loads index',async()=>{
  const f=fixture(),result=await f.context.reloadShell();
  assert.equal(result.reloaded,true);assert.equal(result.model_sends,0);assert.equal(result.web_owners_preserved,true);
  assert.equal(f.page.view.webContents,f.web);assert.equal(f.context.runtime.child.pid,123);
  assert.deepEqual(f.calls,['invalidate',path.join('D:/clw/apps/web-host','index.html'),'publish']);
  assert.equal(f.contents.listenerCount('before-input-event'),0);assert.equal(f.context.shellReloading,false);
});
test('a selection change while preparing reload cannot load a newer task shell',async()=>{
  const f=fixture();let done;f.context.shellControl.request=()=>new Promise(resolve=>{done=resolve;});
  const pending=f.context.reloadShell(()=>{throw Object.assign(Error('selection changed'),{accepted:false});});
  done({safe:true});await assert.rejects(pending,/selection changed/);
  assert.equal(f.calls.length,0);assert.equal(f.contents.listenerCount('before-input-event'),0);
});
test('unsaved draft refusal preserves original renderer and releases only its input gate',async()=>{
  const f=fixture();f.context.shellControl.request=async()=>({safe:false});
  await assert.rejects(f.context.reloadShell(),e=>e.accepted===false&&/draft_not_saved/.test(e.message));
  assert.equal(f.calls.length,0);assert.equal(f.page.view.webContents,f.web);
  assert.equal(f.contents.listenerCount('before-mouse-event'),0);
});
test('original owner or source drift after load is retained as unknown; no retry',async()=>{
  for(const which of ['owner','source']){
    const f=fixture();let hashes=0;
    if(which==='owner')f.context.win.loadFile=async file=>{f.calls.push(file);f.context.runtime={child:{pid:456}};};
    else f.context.currentShellSources=()=>({index:++hashes===1?'original':'changed'});
    await assert.rejects(f.context.reloadShell(),/app_shell_(original_owner_changed|sources_changed)/);
    assert.equal(f.calls.filter(item=>String(item).endsWith('index.html')).length,1);
    assert.equal(f.contents.listenerCount('before-input-event'),0);
  }
});
