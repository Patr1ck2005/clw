'use strict';
// Sampling rate follows actual activity, never limits worker or model concurrency.
function mayObserve(record,page,cache,{selected=false,now=Date.now()}={}){
 const o=page?.observation;
 const signature=JSON.stringify([record.paused,record.attention,record.pause_origin?.source,
   record.latest_request?.id,record.latest_request?.phase,page?.documentGeneration,!!o?.generating,selected]);
 const prior=cache.get(record.page_id);
 if(prior?.signature===signature&&now<prior.due)return false;
 const idle=record.paused&&o?.generating===false;
 const interval=idle?(selected?5000:record.attention&&record.pause_origin?.source==='attention'?3000:30000):1500;
 cache.set(record.page_id,{signature,due:now+interval});return true;
}
module.exports={mayObserve};
