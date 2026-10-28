'use strict';
// A quit intent stops future admission and observes the current web turn. It
// never sends a recovery message or changes an unfinished business outcome.
function createOrdinaryExit({pauseFuture,readActivity,close,onChange=()=>{},intervalMs=1000,
  schedule=(fn,ms)=>setTimeout(fn,ms),unschedule=id=>clearTimeout(id)}={}){
 let intent=null;
 const state=()=>intent?{...(intent.result||{}),state:intent.state,active_conversations:intent.active,blocked_reasons:intent.reasons,
   future_sends_paused:intent.paused,cancel_available:!intent.closing}:null;
 const changed=()=>onChange(state());
 const probe=async current=>{
  if(intent!==current||current.running)return;
  current.running=true;
  try{
   if(!current.paused){await pauseFuture();if(intent!==current)return;current.paused=true;}
   const activity=await readActivity();if(intent!==current)return;
   current.active=activity.active||[];current.reasons=activity.blocked||[];
   if(current.reasons.length){current.state='blocked';changed();return;}
   if(current.active.length){current.state='waiting-current-turn';changed();return;}
   current.closing=true;current.state='checking';changed();
   current.result=await close();if(intent===current)current.state='closing';
  }catch(error){
   if(intent!==current)return;
   current.closing=false;
   if(error.code==='native_maintenance_execution_active'||error.message==='native_maintenance_execution_active'){
    current.state='waiting-current-turn';current.active=[{title:'Codex＋Web',reason:'native_current_turn'}];current.reasons=[];
   }else{current.state='blocked';current.reasons=error.blockedReasons||[{code:error.code||error.message||'exit_check_failed'}];}
   changed();
  }finally{
   current.running=false;
   // A real current-turn wait is retried by the program. A failed proof is
   // explicit attention rather than an infinite animation or model loop.
   if(intent===current&&current.state==='waiting-current-turn'){
    current.timer=schedule(()=>{current.timer=null;void probe(current);},intervalMs);current.timer?.unref?.();
   }
  }
 };
 return {snapshot:state,
  async begin(){if(!intent)intent={state:'checking',active:[],reasons:[],paused:false,closing:false,running:false,timer:null};
   const current=intent;await probe(current);return state();},
  async reconcile(){if(intent){if(intent.timer){unschedule(intent.timer);intent.timer=null;}await probe(intent);}return state();},
  cancel(){if(!intent)return {cancelled:true,future_sends_paused:true};if(intent.closing)throw Object.assign(Error('exit_shutdown_already_dispatched'),{code:'exit_shutdown_already_dispatched'});
   const current=intent;intent=null;if(current.timer)unschedule(current.timer);onChange({state:'cancelled',active_conversations:[],blocked_reasons:[],future_sends_paused:current.paused,cancel_available:false});
   return {cancelled:true,future_sends_paused:current.paused};}
 };
}
module.exports={createOrdinaryExit};
