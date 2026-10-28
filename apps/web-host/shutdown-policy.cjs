'use strict';
// Maintenance preserves persisted intent; an ordinary explicit quit pauses it.
function exitRecord({maintenance=false,pid,at=new Date().toISOString()}={}){
  return {explicit:maintenance!==true,reason:maintenance===true?'maintenance':'user',pid,at};
}
function pausesOnStartup(raw){
  try{const value=typeof raw==='string'?JSON.parse(raw):raw;return !(value&&value.explicit===false&&value.reason==='maintenance');}
  catch{return true;}
}
function maintenanceIdle({pages=[],nativeTurns=[],now=Date.now(),ordinary=false}={}){
  return pages.every(p=>p.observation&&Number.isFinite(p.observation.at)&&now-p.observation.at>=0&&now-p.observation.at<=30000&&
    p.observation.generating===false&&(ordinary||!p.observation.draft)&&!p.observation.composing)&&
    nativeTurns.every(t=>!['preparing','running'].includes(t.status));
}
module.exports={exitRecord,pausesOnStartup,maintenanceIdle};
