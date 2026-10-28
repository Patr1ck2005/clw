'use strict';
const fs=require('node:fs'),path=require('node:path');
const MAX_REFERENCES=32,activePickers=new WeakSet();
const pathKey=value=>process.platform==='win32'?value.toLowerCase():value;
const absolutePath=value=>typeof value==='string'&&value.length>0&&!/[\x00-\x1f]/.test(value)&&path.isAbsolute(value);
function inside(root,target){
  const relative=path.relative(root,target);
  return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));
}

// This picker returns references only. It reads filesystem metadata, never
// file contents, and does not change the task grant or submit a model message.
async function pickContext({payload,identity,recordFor,assertAvailable,showOpenDialog,files=fs.promises}){
  if(!['files','folder'].includes(payload?.kind)||!Object.hasOwn(payload,'expected_connection_generation')||
    !Number.isSafeInteger(payload.expected_connection_generation)||payload.expected_connection_generation<0||
    !Object.hasOwn(payload,'expected_request_id')||!(payload.expected_request_id===null||
      typeof payload.expected_request_id==='string'&&payload.expected_request_id.length>0))
    throw Error('managed_context_request_invalid');
  const page=identity.page;
  if(activePickers.has(page))throw Error('managed_context_picker_already_open');
  const originalRoot=recordFor(page.id)?.root;
  const direct=recordFor(page.id)?.conversation_mode==='direct';
  if(!direct&&!absolutePath(originalRoot))throw Error('managed_context_root_unavailable');
  const rootKey=absolutePath(originalRoot)?pathKey(path.resolve(originalRoot)):null;
  function current(response=false){
    assertAvailable();identity.assertCurrent({response});
    const row=recordFor(page.id);
    if(page.kind!=='task'||page.hidden||row?.page_id!==page.id||row.phase!=='bound'||
      !row.thread_id||row.successor||page.successor)throw Error('managed_context_task_unsupported');
    if((row.conversation_mode==='direct')!==direct||
      (absolutePath(row.root)?pathKey(path.resolve(row.root)):null)!==rootKey)
      throw Error('managed_context_root_changed');
  }
  activePickers.add(page);
  try{
    current();
    const root=rootKey?await files.realpath(originalRoot):null;current();
    if(root&&!(await files.stat(root)).isDirectory())throw Error('managed_context_root_unavailable');
    current();
    const assertRoot=async()=>{
      current(true);
      if(root&&pathKey(await files.realpath(originalRoot))!==pathKey(root))throw Error('managed_context_root_changed');
      current(true);
    };
    await assertRoot();
    // Windows cannot combine openFile and openDirectory in one dialog.
    const result=await showOpenDialog({title:payload.kind==='folder'?'引用文件夹':'引用文件',
      ...(root?{defaultPath:root}:{}),buttonLabel:'引用路径',properties:payload.kind==='folder'?['openDirectory']:['openFile','multiSelections']});
    await assertRoot();
    if(!result||typeof result.canceled!=='boolean'||!Array.isArray(result.filePaths))throw Error('managed_context_selection_invalid');
    if(result.canceled)return {references:[],model_sends:0};
    if(result.filePaths.length>MAX_REFERENCES)throw Error('managed_context_selection_limit');
    const references=[],seen=new Set();
    for(const selected of result.filePaths){
      current(true);
      if(!absolutePath(selected))throw Error('managed_context_selection_invalid');
      // Validate the displayed selection as well as its actual target. A
      // symlink/junction cannot smuggle a path outside the authorized root.
      if(!direct&&!inside(root,path.resolve(selected))&&!inside(path.resolve(originalRoot),path.resolve(selected)))
        throw Error('managed_context_path_forbidden');
      const target=await files.realpath(selected);current(true);
      if(!direct&&!inside(root,target))throw Error('managed_context_path_forbidden');
      const metadata=await files.stat(target);current(true);
      const kind=metadata.isFile()?'file':metadata.isDirectory()?'folder':null;
      if(!kind||kind!==(payload.kind==='folder'?'folder':'file'))throw Error('managed_context_selection_invalid');
      const key=pathKey(target);if(seen.has(key))continue;seen.add(key);
      references.push({path:target,relative_path:root&&inside(root,target)?path.relative(root,target).split(path.sep).join('/')||'.':target,kind});
    }
    await assertRoot();
    // Metadata checks can yield to another filesystem operation. Re-resolve
    // the returned canonical paths so a moved directory or newly replaced
    // junction cannot change the reference target during validation.
    for(const reference of references){
      const actual=await files.realpath(reference.path);current(true);
      if(!direct&&!inside(root,actual)||pathKey(actual)!==pathKey(reference.path))throw Error('managed_context_path_forbidden');
    }
    await assertRoot();
    return {references,model_sends:0};
  }finally{activePickers.delete(page);}
}
module.exports={pickContext,MAX_REFERENCES};
