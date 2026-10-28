import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateSnapshot,emptyAnnotations,validateAnnotations} from '../apps/control-center/model.mjs';
import {createAnnotationStore} from '../apps/control-center/annotations.mjs';
import {liveSelection,parseLiveEnvelope,createLiveController} from '../apps/control-center/live.mjs';
const sample=()=>validateSnapshot(JSON.parse(readFileSync(new URL('../apps/control-center/data/observed.json',import.meta.url),'utf8')));
function envelope(sel=liveSelection(),extra={}){
 const p=sample();p.runtime.id='wc-live-test';p.sessions=[];p.jobs=[];
 return {schema_version:1,connection_id:p.runtime.id,selection:sel,state:'connected',projection:p,
  revision:'epoch:view:1',observed_at:'2026-09-20T15:00:00Z',age_ms:0,unchanged:false,refresh_after_ms:5000,...extra};
}
const response=data=>({ok:true,text:async()=>JSON.stringify(data)});
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
function harness(fetcher){
 const data=[],states=[],timers=new Map();let next=0,hidden=false;
 const control=createLiveController({fetcher,onData:(v,e)=>data.push([v,e]),onState:s=>states.push(s),
 isHidden:()=>hidden,setTimer:(f,delay)=>{timers.set(++next,{f,delay});return next;},clearTimer:id=>timers.delete(id)});
 return {control,data,states,timers,setHidden:v=>hidden=v,runTimer:()=>{const [id,t]=[...timers].find(([,t])=>t.delay!==28000);timers.delete(id);t.f();}};
}
test('live selection requires exact project with valid session id',()=>{assert.throws(()=>liveSelection('','wc_sess_a'));assert.throws(()=>liveSelection('p','random'));assert.equal(liveSelection('p','wc_sess_a').session,'wc_sess_a');});
test('compact native Session can select exact current project',()=>{const sid='wc_sess_xtZ-pHxMTJ2jI0ap';assert.equal(liveSelection('p',sid).session,sid);assert.throws(()=>liveSelection('',sid));});
test('compact native Session accepts labels only for observed identity',()=>{const sid='wc_sess_xtZ-pHxMTJ2jI0ap',p=sample();p.sessions=[{...p.sessions[0],id:sid,events:[],events_total:0}];p.jobs=[];const a=emptyAnnotations(p.runtime.id);a.bindings=[{session_id:sid,account_alias:'A',role:'M',updated_at:'now'}];assert.equal(validateAnnotations(a,p).bindings[0].session_id,sid);p.sessions=[];assert.throws(()=>validateAnnotations(a,p));assert.equal(validateAnnotations(a,p,{retainDetached:true}).bindings[0].session_id,sid);});
test('malformed native compact Session is not admitted',()=>{for(const sid of ['wc_sess_a-b','wc_sess_xtZ-pHxMTJ2jI0a','wc_sess_xtZ-pHxMTJ2jI0app','wc_sess_xtZ-pHxMTJ2jI0ap\n','wc_sess_xtZ/pHxMTJ2jI0ap'])assert.throws(()=>liveSelection('p',sid));});
test('response cannot retarget current project',()=>assert.throws(()=>parseLiveEnvelope(envelope(liveSelection('other')),liveSelection('wanted'))));
test('response cannot change runtime identity',()=>{const e=envelope();e.projection.runtime.id='foreign';assert.throws(()=>parseLiveEnvelope(e,liveSelection()));});
test('cross-project session rejected',()=>{const e=envelope(liveSelection('p'));e.projection=sample();e.connection_id=e.projection.runtime.id;assert.throws(()=>parseLiveEnvelope(e,liveSelection('p')));});
test('JSON claiming live remains an observation projection',()=>{const e=envelope();e.projection.source.live=true;assert.equal(parseLiveEnvelope(e,liveSelection()).projection.source.live,false);});
test('server refresh delay is bounded',()=>{assert.equal(parseLiveEnvelope(envelope(liveSelection(),{refresh_after_ms:1}),liveSelection()).refresh_after_ms,1000);assert.equal(parseLiveEnvelope(envelope(liveSelection(),{refresh_after_ms:1e12}),liveSelection()).refresh_after_ms,300000);});
test('unchanged cannot contain competing baseline',()=>assert.throws(()=>parseLiveEnvelope(envelope(liveSelection(),{unchanged:true}),liveSelection())));
test('source switches ignore late result',async()=>{
 let resolve;const h=harness(()=>new Promise(r=>resolve=r));h.control.start(liveSelection('a'));h.control.stop();resolve(response(envelope(liveSelection('a'))));await flush();assert.equal(h.data.length,0);assert.equal(h.timers.size,0);
});
test('late old project response cannot replace the newly selected view',async()=>{
 const promises=[];const h=harness(()=>new Promise(r=>promises.push(r)));h.control.start(liveSelection('a'));h.control.select(liveSelection('b'));promises[1](response(envelope(liveSelection('b'))));await flush();promises[0](response(envelope(liveSelection('a'))));await flush();assert.equal(h.data.length,1);assert.equal(h.data[0][1].selection.project,'b');h.control.stop();
});
test('same view uses exact returned revision on next refresh',async()=>{
 const calls=[];const h=harness(async url=>{calls.push(url);return response(calls.length===1?envelope():envelope(liveSelection(),{projection:null,unchanged:true}));});
 h.control.start();await flush();h.runTimer();await flush();assert.ok(calls[1].includes('after=epoch%3Aview%3A1'));assert.equal(h.data.length,1);h.control.stop();
});
test('unowned unchanged response rejected',async()=>{
 const h=harness(async()=>response(envelope(liveSelection(),{projection:null,unchanged:true})));h.control.start();await flush();assert.equal(h.data.length,0);assert.equal(h.states.at(-1).state,'disconnected');h.control.stop();
});
test('authorization rejection drops data and does not schedule retry',async()=>{
 const h=harness(async()=>response(envelope(liveSelection(),{state:'auth_required',projection:null})));h.control.start();await flush();assert.equal(h.data.at(-1)[0],null);assert.equal(h.timers.size,0);assert.equal(h.control.active(),false);h.setHidden(true);h.control.visibility();h.setHidden(false);h.control.visibility();await flush();assert.equal(h.timers.size,0);
});
test('visibility suppresses polling and recovers same task view',async()=>{
 let calls=0;const h=harness(async()=>{calls++;return response(envelope());});h.setHidden(true);h.control.start();await flush();assert.equal(calls,0);h.setHidden(false);h.control.visibility();await flush();assert.equal(calls,1);h.setHidden(true);h.control.visibility();assert.equal(h.timers.size,0);h.control.stop();
});
test('network failure retains old UI and retries boundedly',async()=>{
 let n=0;const h=harness(async()=>{if(n++)throw Error('synthetic');return response(envelope());});h.control.start();await flush();h.runTimer();await flush();assert.equal(h.data.length,1);assert.equal(h.states.at(-1).state,'disconnected');assert.ok([...h.timers.values()].every(t=>t.delay<=60000));h.control.stop();
});
test('fresh native activity projection retains grouped row without inventing event id',()=>{
 const p=sample(),s=p.sessions[0];s.counts_available=false;s.activities_loaded=true;s.activity_total=1;s.activity_truncated=false;s.activities=[{kind:'Tool',tool:'run_process',state:'succeeded',job_handoff:true,started_at:1789910000,paths:[]}];const out=validateSnapshot(p).sessions[0];assert.equal(out.activities.length,1);assert.equal(out.activities[0].job_handoff,true);assert.equal(out.activities[0].id,undefined);
});
test('bad native activity retention is rejected',()=>{const p=sample();p.sessions[0].activities=[{kind:'Tool',tool:'read_files',state:'succeeded',started_at:1789910000,paths:[]}];assert.throws(()=>validateSnapshot(p));});
test('job owner outside list is retained but not made an observed session',()=>{const p=sample();p.jobs=[{id:'j',project_id:p.projects[0].id,session_id:null,owner_session_id:'wc_sess_outside',status:'running',exit_code:null}];const out=validateSnapshot(p);assert.equal(out.jobs[0].session_id,null);assert.equal(out.jobs[0].owner_session_id,'wc_sess_outside');});
test('detached labels survive live project switching without authorizing new labels',async()=>{
 const p=sample();let raw=null;const storage={getItem:()=>raw,setItem:(k,v)=>{raw=v;}};const locks={request:async(k,o,fn)=>fn()};
 const store=createAnnotationStore({key:'live',snapshot:p,storage,locks,retainDetached:true});const original=p.sessions[0];
 const value={session_id:original.id,account_alias:'个人A',role:'M',updated_at:'now'};await store.saveBinding(value,null);
 p.sessions=[];assert.equal(store.read().bindings[0].account_alias,'个人A');await assert.rejects(store.saveBinding({...value,account_alias:'should-fail'},value));
 assert.throws(()=>validateAnnotations(JSON.parse(raw),p));p.sessions=[original];assert.equal(store.read().bindings[0].account_alias,'个人A');
});
