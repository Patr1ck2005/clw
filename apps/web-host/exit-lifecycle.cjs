'use strict';
const {randomUUID}=require('node:crypto');
const stages=new Set(['idle','checking','waiting-current-turn','cancelled','blocked','closing-native','closing-host','awaiting-original-exit','saving','save-failed','completed']);
function reason(error,extra={}){
 const code=String(error?.code||error?.message||'exit_check_failed');
 const safe=/^[a-z][a-z0-9_]{0,159}$/.test(code)?code:'exit_check_failed';
 const rows=error?.blockedReasons||error?.details?.blockedReasons||error?.maintenanceClose?.blockedReasons;
 if(Array.isArray(rows)&&rows.length)return rows.slice(0,32).map(row=>({code:(typeof row?.code==='string'?row.code:typeof row?.kind==='string'?row.kind:safe).slice(0,200),...extra,
   ...Object.fromEntries(['page_id','thread_id','request_id','attempt_id','job_id','job_state','project','session_id','status','command_execution_state','scope','title','reason','operation_id'].filter(k=>typeof row?.[k]==='string'||Number.isSafeInteger(row?.[k])).map(k=>[k,typeof row[k]==='string'?row[k].slice(0,200):row[k]])),
   ...(Array.isArray(row?.job_ids)?{job_ids:row.job_ids.slice(0,16).filter(id=>typeof id==='string'&&id.length).map(id=>id.slice(0,200))}:{})}));
 return [{code:safe,...extra}];
}
function createExitLifecycle({onChange=()=>{},newId=()=>randomUUID()}={}){
 let current=null,pending=null;
 const snapshot=()=>current?structuredClone(current):{version:1,state:'idle',exit_id:null,operation_id:null,blocked_reasons:[],shutdown:{native:false,host:false}};
 const update=(state,values={})=>{if(!stages.has(state))throw Error('exit_stage_invalid');if(!current)return snapshot();Object.assign(current,values,{state,updated_at:new Date().toISOString()});onChange(snapshot());return snapshot();};
 return {snapshot,update,
  begin({maintenance=false,operation_id=null}={}){
   if(current&&['checking','waiting-current-turn','closing-native','closing-host','awaiting-original-exit','saving','save-failed'].includes(current.state))return snapshot();
   const at=new Date().toISOString(),id=newId();current={version:1,exit_id:id,operation_id:operation_id||'exit-'+id,mode:maintenance?'maintenance':'ordinary',state:'checking',started_at:at,updated_at:at,blocked_reasons:[],shutdown:{native:false,host:false},owners:{native:false,host:false}};onChange(snapshot());return snapshot();
  },
  run(fn){if(pending)return pending;pending=Promise.resolve().then(fn).finally(()=>{pending=null;});return pending;},
  get pending(){return pending;},
  assert(id){if(!current||id!==current.exit_id)throw Object.assign(Error('exit_original_context_changed'),{accepted:false,code:'exit_original_context_changed'});return snapshot();},
  block(error,extra={}){return update('blocked',{blocked_reasons:reason(error,extra)});},
  dispatched(owner){const value=snapshot();if(value.shutdown[owner])return false;update(owner==='native'?'closing-native':'closing-host',{shutdown:{...value.shutdown,[owner]:true},blocked_reasons:[]});return true;},
  exited(owner){const value=snapshot();return update(value.state,{owners:{...value.owners,[owner]:true}});}
 };
}
module.exports={createExitLifecycle,reason};
