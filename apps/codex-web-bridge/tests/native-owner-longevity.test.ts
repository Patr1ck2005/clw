import {test,expect} from 'bun:test';
import {appendFileSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeTurnAdmission,currentNativeOwnerAdmissions,currentNativeOwnerHistory} from '../native-turn-admission';
import {readNativeOwnerAdmissions} from '../native-owner-admissions';
import maintenance from '../native-maintenance-session.cjs';

const threadId='01a10714-bd83-7830-87b6-3d663d9f8ba2';
const turnId=(n:number)=>'01a10714-c266-7e91-9feb-'+n.toString(16).padStart(12,'0');
const traceId=(n:number)=>n.toString(16).padStart(12,'0');
const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const event=(n:number,type:string,payload:any)=>({timestamp:new Date(Date.parse('2026-10-04T13:00:00Z')+n*1000).toISOString(),type,payload});
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'clw-owner-longevity-')),sessionsRoot=join(home,'sessions'),day=join(sessionsRoot,'2026/10/04');mkdirSync(day,{recursive:true});
 const file=join(day,'rollout-fixture-'+threadId+'.jsonl');writeFileSync(file,JSON.stringify(event(0,'session_meta',{id:threadId,cwd:home}))+'\n');
 for(const directory of ['turn-sources','turn-reviews'])mkdirSync(join(home,directory));
 const owner='offline-owner',admission=createNativeTurnAdmission(home,owner,sessionsRoot);
 const source=(n:number)=>{const trace=traceId(n),turn=turnId(n);writeFileSync(join(home,'turn-sources',trace+'.json'),JSON.stringify({traceId:trace,threadId,turnId:turn,account:'A',model:'chatgpt-web/high',workingDirectory:home,purpose:'response'}));writeFileSync(join(home,'turn-reviews',trace+'.json'),JSON.stringify({traceId:trace,threadId,turnId:turn,finalSha256:digest('final '+n)}));};
 const native=(n:number,terminal=true)=>{const turn=turnId(n),base=n*3;appendFileSync(file,JSON.stringify(event(base,'event_msg',{type:'task_started',turn_id:turn}))+'\n');if(terminal)appendFileSync(file,[event(base+1,'response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'final '+n}]}),event(base+2,'event_msg',{type:'task_complete',turn_id:turn,last_agent_message:'final '+n})].map(row=>JSON.stringify(row)).join('\n')+'\n');};
 return {home,sessionsRoot,file,owner,admission,source,native,clean:()=>rmSync(home,{recursive:true,force:true}),read:()=>readNativeOwnerAdmissions(home,owner,'A',{sessionsRoot})};
}

test('2,005 real native turns retire to durable summaries; maintenance work stays constant and archived turns cannot reopen',()=>{
 const f=fixture();try{
  for(let n=1;n<=2005;n++){const admitted=f.admission.admit({threadId,turnId:turnId(n)},traceId(n));f.source(n);admitted.complete();f.native(n);}
  expect(currentNativeOwnerAdmissions(f.home,f.owner)).toHaveLength(1);
  const final=f.read();expect(final.admitted).toHaveLength(0);expect(final.terminalHistory.terminalCount).toBe(2005);
  const directory=join(f.home,'runtime/native-turn-admission');expect(readdirSync(directory).filter(name=>name.startsWith('owner-terminal-'))).toHaveLength(2005);
  const summary=JSON.parse(readFileSync(join(directory,'owner-terminal-'+traceId(1)+'.json'),'utf8'));expect(summary).toMatchObject({threadId,turnId:turnId(1),ownerEpoch:f.owner,nativeToolsTerminal:true});expect(summary.sourceSha256).toBe(digest(readFileSync(join(f.home,'turn-sources',traceId(1)+'.json'))));expect(summary.nativeProof.sessionSha256).toMatch(/^[a-f0-9]{64}$/);
  let reads=0;const original=fs.readFileSync;(fs as any).readFileSync=(...args:any[])=>{reads++;return (original as any)(...args);};
  try{for(let n=0;n<3;n++){expect(f.read()).toEqual(final);expect(maintenance.readMaintenanceSessions(final.admitted,{sessionsRoot:f.sessionsRoot,account:'A'})).toEqual([]);}expect(reads).toBe(0);}finally{(fs as any).readFileSync=original;}
  expect(()=>f.admission.admit({threadId,turnId:turnId(1)},traceId(3000))).toThrow('archived terminal');
  expect(()=>createNativeTurnAdmission(f.home,'next-owner',f.sessionsRoot).admit({threadId,turnId:turnId(1)},traceId(3001))).toThrow('archived terminal');
  expect(currentNativeOwnerHistory(f.home,f.owner).terminalCount).toBe(2005);
 }finally{f.clean();}
},240000);

test('browser final before native delivery and a live original turn stay pending; a matching native terminal retires them',()=>{
 const f=fixture();try{
  const admitted=f.admission.admit({threadId,turnId:turnId(1)},traceId(1));f.source(1);admitted.complete();
  expect(f.read().admitted).toHaveLength(1);f.native(1,false);expect(f.read().admitted).toHaveLength(1);
  appendFileSync(f.file,[event(4,'response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'final 1'}]}),event(5,'event_msg',{type:'task_complete',turn_id:turnId(1),last_agent_message:'final 1'})].map(row=>JSON.stringify(row)).join('\n')+'\n');
  expect(f.read().admitted).toHaveLength(0);
 }finally{f.clean();}
});

test('more than 512 actual traces in one original turn use a sharded identity and preserve replay tombstones',()=>{
 const f=fixture();try{
  const turn=turnId(1);let last:any;
  for(let n=1;n<=515;n++)last=f.admission.admit({threadId,turnId:turn},traceId(n));
  last.complete();const key=digest(JSON.stringify([threadId,turn])),manifest=JSON.parse(readFileSync(join(f.home,'runtime/native-turn-admission','identity-'+key+'.json'),'utf8'));
  expect(manifest).toEqual({version:2,identityKey:key,layout:'trace_members'});expect(currentNativeOwnerAdmissions(f.home,f.owner)).toHaveLength(515);
  expect(()=>f.admission.admit({threadId,turnId:turn},traceId(516))).toThrow('completed browser final');
  expect(()=>createNativeTurnAdmission(f.home,'replacement').admit({threadId,turnId:turn},traceId(1))).toThrow();
 }finally{f.clean();}
},240000);

test('failed archive persistence keeps original pending membership and retries its original terminal without replay',()=>{
 const f=fixture();try{
  const identity={threadId,turnId:turnId(1)},accepted=f.admission.admit(identity,traceId(1));f.source(1);accepted.complete();f.native(1);
  const directory=join(f.home,'runtime/native-turn-admission'),member=join(directory,'thread-'+digest(threadId)+'-terminal-'+digest(JSON.stringify([threadId,turnId(1)]))+'.json');mkdirSync(member);
  expect(()=>f.read()).toThrow();expect(currentNativeOwnerAdmissions(f.home,f.owner)).toHaveLength(1);expect(currentNativeOwnerHistory(f.home,f.owner).terminalCount).toBe(0);
  expect(()=>f.admission.admit(identity,traceId(1))).toThrow();rmSync(member,{recursive:true});
  expect(f.read().admitted).toHaveLength(0);expect(currentNativeOwnerHistory(f.home,f.owner).terminalCount).toBe(1);
 }finally{f.clean();}
});

test('wrong original browser final and changed original source stay pending and cannot borrow terminal history',()=>{
 const f=fixture();try{
  const accepted=f.admission.admit({threadId,turnId:turnId(1)},traceId(1));f.source(1);accepted.complete();f.native(1);
  const review=join(f.home,'turn-reviews',traceId(1)+'.json'),original=readFileSync(review);writeFileSync(review,JSON.stringify({traceId:traceId(1),threadId,turnId:turnId(1),finalSha256:'0'.repeat(64)}));
  expect(f.read().admitted).toHaveLength(1);expect(currentNativeOwnerHistory(f.home,f.owner).terminalCount).toBe(0);
  writeFileSync(review,original);writeFileSync(join(f.home,'turn-sources',traceId(1)+'.json'),JSON.stringify({traceId:traceId(1),threadId,turnId:turnId(2),account:'A',workingDirectory:f.home}));
  expect(()=>f.read()).toThrow('source_unknown');expect(currentNativeOwnerAdmissions(f.home,f.owner)).toHaveLength(1);
 }finally{f.clean();}
});

test('more than 512 unknown original turns remain pending in sharded thread membership without losing any identity',()=>{
 const f=fixture();try{
  // Original admission is durable, but its source/delivery is unavailable.
  // None of these rows may become verified history merely because complete ran.
  for(let n=1;n<=515;n++)f.admission.admit({threadId,turnId:turnId(n)},traceId(n)).complete();
  const directory=join(f.home,'runtime/native-turn-admission'),key=digest(threadId),manifest=JSON.parse(readFileSync(join(directory,'thread-'+key+'.json'),'utf8'));
  expect(manifest).toEqual({version:2,threadKey:key,layout:'turn_members'});expect(currentNativeOwnerAdmissions(f.home,f.owner)).toHaveLength(515);expect(currentNativeOwnerHistory(f.home,f.owner).terminalCount).toBe(0);
  expect(readdirSync(join(directory,'thread-'+key+'-turns'))).toHaveLength(515);expect(()=>f.read()).toThrow();
  const member=join(directory,'thread-'+key+'-turns',digest(JSON.stringify([threadId,turnId(1)]))+'.json'),original=readFileSync(member);rmSync(member);
  expect(()=>f.admission.admit({threadId,turnId:turnId(516)},traceId(516))).toThrow('lost pending original membership');writeFileSync(member,original);
  expect(()=>createNativeTurnAdmission(f.home,'replacement',f.sessionsRoot).admit({threadId,turnId:turnId(1)},traceId(1))).toThrow();
 }finally{f.clean();}
},240000);
