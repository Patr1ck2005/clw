'use strict';
const activeRequestId=record=>['queued','processing','suspended'].includes(record?.latest_request?.phase)?record.latest_request.id:null;
function captureTaskIdentity({payload,resolvePage,recordFor,connectionGeneration,documentAware=false}){
  if(!payload||typeof payload.id!=='string'||!payload.id)throw Error('managed_task_identity_required');
  let page;try{page=resolvePage(payload.id);}catch{throw Error('managed_task_identity_required');}
  if(!page||page.id!==payload.id)throw Error('managed_task_identity_required');
  const record=recordFor(page.id),generation=connectionGeneration();
  const original={pageId:page.id,threadId:record?.thread_id||null,requestId:record?.latest_request?.id||null,
    account:record?.account||page.account||'B',documentGeneration:page.documentGeneration||0,generation};
  if(Object.hasOwn(payload,'expected_connection_generation')&&payload.expected_connection_generation!==generation)
    throw Error('managed_task_identity_changed');
  if(Object.hasOwn(payload,'expected_request_id')&&payload.expected_request_id!==activeRequestId(record))
    throw Error('managed_resume_request_changed');
  let documentPinned=false;
  function assertCurrent({response=false,allowRecordAdvance=false,allowDocumentChange=false,acceptedRequestId=null}={}){
    let current;
    try{current=resolvePage(page.id);}catch{}
    const row=recordFor(page.id);
    const recordMatches=allowRecordAdvance&&original.threadId===null||
      (row?.thread_id||null)===original.threadId&&((row?.latest_request?.id||null)===original.requestId||
        typeof acceptedRequestId==='string'&&acceptedRequestId!==''&&row?.latest_request?.id===acceptedRequestId);
    if(current!==page||current?.closed||connectionGeneration()!==generation||
      (documentAware&&documentPinned&&!allowDocumentChange&&(current.documentGeneration||0)!==original.documentGeneration)||
      (row?.account||current?.account||'B')!==original.account||!recordMatches)
      throw Error(response?'managed_task_response_stale':'managed_task_identity_changed');
    return page;
  }
  function pinDocument(){assertCurrent({allowDocumentChange:true});original.documentGeneration=page.documentGeneration||0;documentPinned=true;}
  async function run(operation,{allowRecordAdvance=false}={}){
    assertCurrent();const result=await operation(page,options=>assertCurrent(options));
    // This only fences display of a late response. It never retries, rolls back
    // or changes the receipt of an operation that the original task accepted.
    assertCurrent({response:true,allowRecordAdvance});return result;
  }
  return {page,original,assertCurrent,pinDocument,run};
}
module.exports={captureTaskIdentity,activeRequestId};
