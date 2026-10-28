'use strict';

const requestId=r=>r?.latest_request?.id||null;
const account=r=>r?.account||'B';
const scopeSignature=r=>JSON.stringify([r?.page_id,r?.target_id,r?.thread_id||null,requestId(r),account(r),
  r?.root||null,r?.access||null,r?.write_paths||[],r?.parent_target||null,r?.stop_scope||null]);

function uniqueIndex(records,field){
  const index=new Map();
  for(const row of records){const id=row?.[field];if(!id)continue;
    // Ambiguous identities cannot authorize another page's Stop.
    if(index.has(id))index.set(id,null);else index.set(id,row);
  }
  return index;
}

function selectStopScope(records,pageId){
  records=[...records];const byPage=uniqueIndex(records,'page_id'),byTarget=uniqueIndex(records,'target_id');
  const owner=byPage.get(pageId);if(!owner)throw Error('managed_stop_owner_unavailable');
  const originalScope=owner.stop_scope;
  const handedTo=(record,expected)=>{
    const seen=new Set();let current=record;
    while(current&&current!==expected&&current.successor&&current.successor_state==='active'){
      if(seen.has(current.page_id))return false;seen.add(current.page_id);
      const successor=byPage.get(current.successor);
      if(!successor||account(successor)!==account(current))return false;
      current=successor;
    }
    return current===expected;
  };
  const targets=[owner],unavailable=[];
  for(const row of records){
    if(row===owner||account(row)!==account(owner))continue;
    let current=row,found=false,valid=true;const seen=new Set();
    while(current?.parent_target){
      if(seen.has(current.page_id)){valid=false;break;}seen.add(current.page_id);
      // parent_target is a foreign key to target_id, never to page_id.
      const originalParent=byTarget.get(current.parent_target);
      const parentTarget=current.stop_scope&&Object.hasOwn(current.stop_scope,'parent_target')?
        current.stop_scope.parent_target:current.parent_target;
      const parent=byTarget.get(parentTarget);
      if(!parent||account(parent)!==account(row)){valid=false;break;}
      if(originalParent!==parent&&!handedTo(originalParent,parent)){valid=false;break;}
      // Verify the immediate original delegation when the producer provides it.
      if(current.stop_scope?.parent_request_id&&
        current.stop_scope.parent_request_id!==requestId(parent)){valid=false;break;}
      if(current.stop_scope?.original_parent_request_id&&
        current.stop_scope.original_parent_request_id!==requestId(originalParent)){valid=false;break;}
      if(parent===owner){found=true;break;}
      current=parent;
    }
    if(!found||!valid)continue;
    const scope=row.stop_scope;
    if(!scope||scope.available===false||scope.request_id!==requestId(row)||
      !originalScope||originalScope.available===false||originalScope.request_id!==requestId(owner)||
      !scope.run_id||!originalScope.run_id){
      unavailable.push({page_id:row.page_id,reason:'managed_stop_scope_unavailable'});continue;
    }
    if(scope.run_id!==originalScope.run_id||scope.controller_target!==originalScope.controller_target||
      scope.controller_request!==originalScope.controller_request)continue;
    // Each actual child retains its own granted root/access/write_paths. A
    // worktree may legitimately be outside its parent's root.
    targets.push(row);
  }
  return {targets,unavailable};
}

function captureStopTarget(record,page,recordFor,resolvePage,connectionGeneration){
  const signature=scopeSignature(record),generation=connectionGeneration();let document=page?.documentGeneration||0;
  const original={pageId:record.page_id,requestId:requestId(record),signature};
  function assertCurrent({allowDocumentChange=false}={}){
    const current=resolvePage(record.page_id);
    if(!page||current!==page||current.closed||connectionGeneration()!==generation||
      scopeSignature(recordFor(record.page_id))!==signature||
      (!allowDocumentChange&&(current.documentGeneration||0)!==document))
      throw Error('managed_stop_original_task_changed');
    return page;
  }
  function pinDocument(){assertCurrent({allowDocumentChange:true});document=page.documentGeneration||0;}
  return {original,assertCurrent,pinDocument};
}

module.exports={selectStopScope,captureStopTarget,scopeSignature};
