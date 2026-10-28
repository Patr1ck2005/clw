'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {pickContext,MAX_REFERENCES}=require('../context-picker.cjs');
const {captureTaskIdentity}=require('../task-action-identity.cjs');
function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'clw-context-picker-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'project'),outside=path.join(base,'outside');fs.mkdirSync(root);fs.mkdirSync(outside);
  const file=path.join(root,'中文 equation.md'),folder=path.join(root,'models'),foreign=path.join(outside,'private.txt');
  fs.writeFileSync(file,'not read by the picker');fs.writeFileSync(foreign,'not read either');fs.mkdirSync(folder);
  const page={id:'task',kind:'task',account:'A',root},rows=new Map([['task',{page_id:'task',phase:'bound',thread_id:'thread-original',account:'A',root,
    latest_request:{id:'request-original',phase:'processing'}}]]),pages=new Map([['task',page]]);
  let generation=7,available=true,dialogCount=0;
  const payload={id:'task',kind:'files',expected_connection_generation:7,expected_request_id:'request-original'};
  const capture=value=>captureTaskIdentity({payload:value,resolvePage:id=>pages.get(id),recordFor:id=>rows.get(id),connectionGeneration:()=>generation});
  const options=[],args=()=>({payload,identity:capture(payload),recordFor:id=>rows.get(id),
    assertAvailable:()=>{if(!available)throw Error('fixture_unavailable');},showOpenDialog:async opt=>{dialogCount++;options.push(opt);return {canceled:false,filePaths:[file]};}});
  return {base,root,outside,file,folder,foreign,page,pages,rows,payload,capture,args,options,
    disconnect:()=>{generation++;},unavailable:()=>{available=false;},dialogCount:()=>dialogCount};
}

test('files and folders produce exact authorized canonical references with zero sends, never file contents',async t=>{
  const f=fixture(t),a=f.args(),metadata=[];
  a.files={realpath:async value=>{metadata.push(['realpath',value]);return fs.promises.realpath(value);},stat:async value=>{metadata.push(['stat',value]);return fs.promises.stat(value);}};
  const result=await pickContext(a);
  assert.deepEqual(result,{references:[{path:fs.realpathSync(f.file),relative_path:'中文 equation.md',kind:'file'}],model_sends:0});
  assert.deepEqual(f.options[0].properties,['openFile','multiSelections']);assert.equal(f.options[0].defaultPath,fs.realpathSync(f.root));
  assert.deepEqual(new Set(metadata.map(item=>item[0])),new Set(['realpath','stat']));
  const b=f.args();b.payload={...f.payload,kind:'folder'};b.showOpenDialog=async options=>{assert.deepEqual(options.properties,['openDirectory']);return {canceled:false,filePaths:[f.folder]};};
  assert.deepEqual(await pickContext(b),{references:[{path:fs.realpathSync(f.folder),relative_path:'models',kind:'folder'}],model_sends:0});
});
test('a direct conversation without a project references only user-selected paths, without reading contents or changing a grant',async t=>{
 const f=fixture(t),row=f.rows.get('task');row.root='';row.conversation_mode='direct';const before=JSON.stringify(row),a=f.args(),metadata=[];
 a.showOpenDialog=async options=>{assert.equal(options.defaultPath,undefined);return {canceled:false,filePaths:[f.foreign]};};
 a.files={realpath:async selected=>{metadata.push(selected);return fs.promises.realpath(selected);},stat:fs.promises.stat};
 const result=await pickContext(a);assert.equal(result.model_sends,0);assert.deepEqual(result.references,[{path:fs.realpathSync(f.foreign),relative_path:fs.realpathSync(f.foreign),kind:'file'}]);
 assert.ok(metadata.every(selected=>selected===f.foreign));assert.equal(JSON.stringify(row),before);
});

test('the authorized root itself may be referenced as a folder without enumerating it',async t=>{
  const f=fixture(t),a=f.args();a.payload={...f.payload,kind:'folder'};a.showOpenDialog=async()=>({canceled:false,filePaths:[f.root]});
  assert.deepEqual((await pickContext(a)).references,[{path:fs.realpathSync(f.root),relative_path:'.',kind:'folder'}]);
});

test('cancel and an empty selection return no references, preserving original identity and payload',async t=>{
  const f=fixture(t),before=JSON.stringify([...f.rows]);
  for(const canceled of [true,false]){const a=f.args();a.showOpenDialog=async()=>({canceled,filePaths:[]});assert.deepEqual(await pickContext(a),{references:[],model_sends:0});}
  assert.equal(JSON.stringify([...f.rows]),before);assert.equal(f.payload.expected_request_id,'request-original');
});

test('outside paths, sibling prefixes, and traversal cannot borrow permission from the chooser',async t=>{
  const f=fixture(t),sibling=path.join(f.base,'project-extra');fs.mkdirSync(sibling);const siblingFile=path.join(sibling,'secret.txt');fs.writeFileSync(siblingFile,'metadata only');
  for(const selected of [f.foreign,siblingFile,path.join(f.root,'..','outside','private.txt')]){
    const a=f.args();a.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});await assert.rejects(pickContext(a),/managed_context_path_forbidden/);
  }
});

test('junction escape is rejected; duplicate canonical paths are collapsed without reading their bodies',async t=>{
  const f=fixture(t),escape=path.join(f.root,'external'),alias=path.join(f.root,'alias');
  fs.symlinkSync(f.outside,escape,'junction');fs.symlinkSync(f.root,alias,'junction');
  const rejected=f.args();rejected.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(escape,'private.txt')]});
  await assert.rejects(pickContext(rejected),/managed_context_path_forbidden/);
  const duplicate=f.args();duplicate.showOpenDialog=async()=>({canceled:false,filePaths:[f.file,path.join(alias,'中文 equation.md'),f.file]});
  assert.deepEqual((await pickContext(duplicate)).references,[{path:fs.realpathSync(f.file),relative_path:'中文 equation.md',kind:'file'}]);
});

test('bounded selection rejects too many items before resolving their paths',async t=>{
  const f=fixture(t),a=f.args(),resolved=[];a.files={realpath:async value=>{resolved.push(value);return fs.promises.realpath(value);},stat:fs.promises.stat};
  a.showOpenDialog=async()=>({canceled:false,filePaths:Array(MAX_REFERENCES+1).fill(f.file)});
  await assert.rejects(pickContext(a),/managed_context_selection_limit/);assert.ok(resolved.every(value=>value===f.root));
});

test('malformed dialog results, relative paths, controls, missing paths and wrong entry kinds are refused',async t=>{
  const f=fixture(t);
  for(const result of [null,{}, {canceled:false,filePaths:'file'}, {canceled:false,filePaths:[null]}, {canceled:false,filePaths:['relative.md']},
    {canceled:false,filePaths:[f.file+'\n']}, {canceled:false,filePaths:[f.folder]}]){
    const a=f.args();a.showOpenDialog=async()=>result;await assert.rejects(pickContext(a),/managed_context_selection_invalid/);
  }
  const missing=f.args();missing.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(f.root,'missing.md')]});await assert.rejects(pickContext(missing),/ENOENT/);
  const folder=f.args();folder.payload={...f.payload,kind:'folder'};folder.showOpenDialog=async()=>({canceled:false,filePaths:[f.file]});await assert.rejects(pickContext(folder),/managed_context_selection_invalid/);
});

test('picker requires the renderer connection and active request CAS before opening any dialog',async t=>{
  const f=fixture(t);
  for(const change of [p=>delete p.expected_connection_generation,p=>p.expected_connection_generation='7',p=>delete p.expected_request_id,
    p=>p.expected_request_id=undefined,p=>p.kind='mixed']){
    const a=f.args();a.payload={...f.payload};change(a.payload);await assert.rejects(pickContext(a),/managed_context_request_invalid/);
  }
  assert.throws(()=>f.capture({...f.payload,expected_connection_generation:6}),/managed_task_identity_changed/);
  assert.throws(()=>f.capture({...f.payload,expected_request_id:'other'}),/managed_resume_request_changed/);assert.equal(f.dialogCount(),0);
});

test('unsupported tasks and unavailable original roots never open a chooser',async t=>{
  for(const change of [f=>f.page.kind='account',f=>f.page.hidden=true,f=>f.rows.get('task').phase='reserved',f=>f.rows.get('task').thread_id=null,
    f=>f.rows.get('task').successor='new-page',f=>f.rows.get('task').page_id='foreign',f=>f.rows.get('task').root='',f=>f.rows.get('task').root=f.file]){
    const f=fixture(t);change(f);await assert.rejects(pickContext(f.args()),/managed_context_(task_unsupported|root_unavailable)/);assert.equal(f.dialogCount(),0);
  }
});

test('new request, thread, account, page replacement, close and reconnect during selection reject the late result',async t=>{
  for(const change of [f=>f.rows.get('task').latest_request.id='next-request',f=>f.rows.get('task').thread_id='new-thread',f=>f.rows.get('task').account='B',
    f=>f.pages.set('task',{...f.page}),f=>f.page.closed=true,f=>f.disconnect()]){
    const f=fixture(t),a=f.args();a.showOpenDialog=async()=>{change(f);return {canceled:false,filePaths:[f.file]};};
    await assert.rejects(pickContext(a),/managed_task_response_stale/);
  }
});

test('runtime unavailability, phase change and a root change during selection reject the original result',async t=>{
  for(const [change,code] of [[f=>f.unavailable(),'fixture_unavailable'],[f=>f.rows.get('task').phase='unbound','managed_context_task_unsupported'],
    [f=>f.rows.get('task').root=f.outside,'managed_context_root_changed']]){
    const f=fixture(t),a=f.args();a.showOpenDialog=async()=>{change(f);return {canceled:false,filePaths:[f.file]};};await assert.rejects(pickContext(a),new RegExp(code));
  }
});

test('redirecting the same lexical authorized root during the dialog is rejected',async t=>{
  const f=fixture(t),aliasRoot=path.join(f.base,'authorized');fs.symlinkSync(f.root,aliasRoot,'junction');f.rows.get('task').root=aliasRoot;
  const a=f.args();a.showOpenDialog=async()=>{fs.unlinkSync(aliasRoot);fs.symlinkSync(f.outside,aliasRoot,'junction');return {canceled:false,filePaths:[f.foreign]};};
  await assert.rejects(pickContext(a),/managed_context_root_changed/);
});

test('a task changed during filesystem metadata validation cannot return an apparently valid reference',async t=>{
  const f=fixture(t),a=f.args();a.files={realpath:fs.promises.realpath,stat:async value=>{const metadata=await fs.promises.stat(value);if(value===fs.realpathSync(f.file))f.disconnect();return metadata;}};
  await assert.rejects(pickContext(a),/managed_task_response_stale/);
});

test('a directory replaced by an outside junction during metadata checks cannot escape the final reference validation',async t=>{
  const f=fixture(t),selected=path.join(f.folder,'asset.txt');fs.writeFileSync(selected,'fixture');fs.writeFileSync(path.join(f.outside,'asset.txt'),'fixture outside');
  const a=f.args();a.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});
  a.files={realpath:fs.promises.realpath,stat:async value=>{const metadata=await fs.promises.stat(value);
    if(value===fs.realpathSync(selected)){fs.renameSync(f.folder,path.join(f.base,'old-models'));fs.symlinkSync(f.outside,f.folder,'junction');}return metadata;}};
  await assert.rejects(pickContext(a),/managed_context_path_forbidden/);
});

test('a second picker for the same page is refused and cancellation releases only its local picker slot',async t=>{
  const f=fixture(t),a=f.args();let release,opened;const wait=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{opened=resolve;});
  a.showOpenDialog=async()=>{opened();await wait;return {canceled:true,filePaths:[]};};const original=pickContext(a);await ready;
  await assert.rejects(pickContext(f.args()),/managed_context_picker_already_open/);release();assert.deepEqual(await original,{references:[],model_sends:0});
  assert.equal((await pickContext(f.args())).references.length,1);
});

const main=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),start=main.indexOf('    const identityActions='),end=main.indexOf("    if(action==='prompt-preview')",start);
assert.ok(start>0&&end>start);const actionSource='(async function(action,payload){'+main.slice(start,end)+'})';
function route(t){
  const f=fixture(t),runtime={ready:true,call:()=>assert.fail('no managed model or runtime operation')},driver={records:f.rows,recordsLoaded:true,busy:new Set()};
  const context={captureTaskIdentity,contextPicker:{pickContext},runtimeGeneration:7,pageById:id=>f.pages.get(id),driver,runtime,workspaceRestored:true,
    quitting:false,maintenanceChecking:false,pool:{selected:'task',ensure:()=>assert.fail('no renderer hydration')},win:{},dialog:{showOpenDialog:async(_win,options)=>{
      assert.deepEqual(options.properties,['openFile','multiSelections']);return {canceled:false,filePaths:[f.file]};}}};
  return {...f,context,run:vm.runInNewContext(actionSource,context)};
}

test('the real IPC route captures original identity and returns metadata only without hydration, busy flags, or runtime calls',async t=>{
  const f=route(t);f.payload.root=f.outside;const before=JSON.stringify([...f.rows]);
  assert.deepEqual(await f.run('pick-context',f.payload),{references:[{path:fs.realpathSync(f.file),relative_path:'中文 equation.md',kind:'file'}],model_sends:0});
  assert.equal(f.context.driver.busy.size,0);assert.equal(JSON.stringify([...f.rows]),before);
});

test('the real IPC route refuses selection changes, reconnect, driver replacement, unload, quit and maintenance during the picker',async t=>{
  for(const change of [f=>f.context.pool.selected='other',f=>f.context.runtime.ready=false,f=>f.context.runtime={ready:true},f=>f.context.driver={...f.context.driver},
    f=>f.context.driver.recordsLoaded=false,f=>f.context.workspaceRestored=false,f=>f.context.quitting=true,f=>f.context.maintenanceChecking=true]){
    const f=route(t);f.context.dialog.showOpenDialog=async()=>{change(f);return {canceled:false,filePaths:[f.file]};};
    await assert.rejects(f.run('pick-context',f.payload),/managed_context_task_unavailable/);
  }
});
