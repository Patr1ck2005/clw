'use strict';
(function(scope){
  function apply(previous,next){
    if(!next||typeof next!=='object'||Array.isArray(next))return {needsSnapshot:true};
    if(next.statePatch!==true)return {state:next,snapshot:true};
    const current=previous?.stateRevision,revision=next.stateRevision,base=next.baseRevision;
    if(Number.isSafeInteger(current)&&Number.isSafeInteger(revision)&&revision<=current)return {ignored:true};
    if(!Number.isSafeInteger(current)||!Number.isSafeInteger(base)||!Number.isSafeInteger(revision)||
      base!==current||revision!==base+1)return {needsSnapshot:true};
    const state={...previous,...next,statePatch:false};delete state.baseRevision;
    return {state,snapshot:false};
  }
  const api={apply};if(typeof module!=='undefined')module.exports=api;else scope.CLWStatePatch=api;
})(globalThis);
