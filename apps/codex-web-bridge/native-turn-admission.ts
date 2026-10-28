import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { join,resolve,dirname,basename } from 'node:path';
import { atomicWriteFile } from './upstream/src/config';
import nativeReceipt from './native-terminal-receipt.cjs';
import {reconcileNativeOwnerThread} from './native-owner-admissions';
import {sessionRevision} from './native-session-stream.cjs';
import {hasFailedSettlement,reconcileLegacyFailedSettlement} from './failed-turn-settlement';
import {reconcileNativeCompactionFailure,reconcileNativeCompactionBeforeSend,reconcileNativeRetainedCompactionBeforePage,reconcileNativeCheckpointFailure} from './native-compaction-failure.cjs';

type AdmissionState = 'incomplete' | 'checkpoint' | 'completed' | 'settled_failed';
type TraceState = { ownerEpoch: string; state: AdmissionState; checkpointSha256?: string };
type IdentityRecord = { version: 1; identityKey: string; traces: Record<string, TraceState> };
type TraceRecord = { version: 1; identityKey: string; ownerEpoch: string; state: AdmissionState; checkpointSha256?: string };
type ThreadRecord = { version: 1; threadKey: string; turns: Record<string, TraceState> };
type TerminalRecord = { version: 1; identityKey: string; threadId: string; turnId: string; traceId: string;
  finalSha256: string; receiptSha256: string; sourceSha256: string; turnSha256: string; reviewSha256: string };

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_TRACES_PER_TURN = 512;
const TRACE_ID = /^[A-Za-z0-9_-]{6,128}$/;

// This value changes when the CLW runtime process is replaced. Adapter instances are created
// per Responses request, so the epoch must be shared across all requests in one process.
export const runtimeOwnerEpoch = randomUUID();
type OwnedAdmission={traceId:string;threadId:string;turnId:string};
type OwnerSet={pending:Map<string,OwnedAdmission>;reconciledThreads:Map<string,true>;terminalCount:number;terminalSha256:string};
const acceptedByOwner=new Map<string,OwnerSet>();
const ownerKey=(home:string,epoch:string)=>JSON.stringify([resolve(home),epoch]);
const newOwnerSet=():OwnerSet=>({pending:new Map(),reconciledThreads:new Map(),terminalCount:0,terminalSha256:createHash('sha256').update('CLW native owner terminal history v1').digest('hex')});
/** Actual pending process admissions; verified history remains on disk. */
export function currentNativeOwnerAdmissions(home:string,epoch:string){
 return [...(acceptedByOwner.get(ownerKey(home,epoch))?.pending.values()||[])].map(row=>({...row}));
}
export function currentNativeOwnerHistory(home:string,epoch:string){
 const owner=acceptedByOwner.get(ownerKey(home,epoch))||newOwnerSet();return {terminalCount:owner.terminalCount,terminalSha256:owner.terminalSha256};
}
// Large single-turn trace sets are sharded, not refused after an arbitrary
// lifetime count. This reader retains the logical index for existing callers.
export function expandNativeAdmissionRecord(file:string,value:any,read:(file:string)=>any):any{
 if(value?.version!==2)return value;
 const isIdentity=/^identity-[a-f0-9]{64}\.json$/.test(basename(file)),isThread=/^thread-[a-f0-9]{64}\.json$/.test(basename(file));
 const key=isIdentity?value.identityKey:value.threadKey,field=isIdentity?'traces':'turns',layout=isIdentity?'trace_members':'turn_members';
 if((!isIdentity&&!isThread)||value.layout!==layout||!/^[a-f0-9]{64}$/.test(key||''))throw new NativeTurnReconciliationError();
 const members=join(dirname(file),(isIdentity?'identity-':'thread-')+key+'-'+field),entries:Record<string,TraceState>={};
 for(const name of readdirSync(members)){
  if(!(isIdentity?/^[-A-Za-z0-9_]{6,128}\.json$/:/^[a-f0-9]{64}\.json$/).test(name))throw new NativeTurnReconciliationError();
  const row=read(join(members,name)),memberKey=name.slice(0,-5);
  if(row?.version!==1||(isIdentity?row.identityKey!==key||row.traceId!==memberKey:row.threadKey!==key||row.identityKey!==memberKey))throw new NativeTurnReconciliationError();entries[memberKey]=row.trace||row.turn;
 }
 return {version:1,[isIdentity?'identityKey':'threadKey']:key,[field]:entries};
}

export class NativeTurnReconciliationError extends Error {
  readonly code = 'native_turn_reconciliation_required';
  constructor(message = 'Codex+Web blocked this native turn because a previous runtime owner left unresolved submission or final-answer evidence. Check the original turn and browser record before continuing; no new Web message was sent.') {
    super(message);
    this.name = 'NativeTurnReconciliationError';
  }
}

function legacyReconciliationError(traceId: string): NativeTurnReconciliationError {
  return new NativeTurnReconciliationError(`Codex+Web blocked this native thread: earlier browser trace ${traceId} has no matched terminal receipt. A missing Send checkpoint does not prove the message was unsent. Reconcile that trace before continuing; no new Web message was sent.`);
}

function legacyExactReplayError(traceId: string): NativeTurnReconciliationError {
  return new NativeTurnReconciliationError(`Codex+Web blocked replay of historical browser trace ${traceId}. Its old runtime cannot provide a canonical Responses replay; reconciliation may allow a new native turn, never resend this trace. No new Web message was sent.`);
}

function completedTraceReplayError(traceId: string): NativeTurnReconciliationError {
  return new NativeTurnReconciliationError(`Codex+Web blocked exact replay of completed browser trace ${traceId}. The previous native Responses delivery is not durably replayable here; check its original native turn and results before continuing. No new Web message was sent.`);
}

function settledTraceReplayError(traceId: string, state: AdmissionState): NativeTurnReconciliationError {
  return state === 'settled_failed'
    ? new NativeTurnReconciliationError(`Browser trace ${traceId} ended in failure and has been reconciled. Continue with a new native turn in the same task; the failed trace cannot be resent.`)
    : completedTraceReplayError(traceId);
}

function readRecord(file: string): unknown | undefined {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_RECORD_BYTES) throw new Error('invalid admission file');
    const value=JSON.parse(readFileSync(file, 'utf8'));return expandNativeAdmissionRecord(file,value,readRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new NativeTurnReconciliationError('Native turn admission evidence is unreadable. Reconcile the original turn before another Web send.');
  }
}

function identityRecord(value: unknown, key: string): IdentityRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeTurnReconciliationError();
  const row = value as Partial<IdentityRecord>;
  if (row.version !== 1 || row.identityKey !== key || !row.traces || typeof row.traces !== 'object' || Array.isArray(row.traces)) throw new NativeTurnReconciliationError();
  for (const [traceId, trace] of Object.entries(row.traces)) {
    if (!TRACE_ID.test(traceId) || !trace || typeof trace.ownerEpoch !== 'string' || !trace.ownerEpoch
      || !['incomplete', 'checkpoint', 'completed', 'settled_failed'].includes(trace.state)
      || trace.state === 'checkpoint' && !/^[a-f0-9]{64}$/.test(trace.checkpointSha256 || '')) throw new NativeTurnReconciliationError();
  }
  return row as IdentityRecord;
}

function traceRecord(value: unknown, key: string): TraceRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeTurnReconciliationError();
  const row = value as Partial<TraceRecord>;
  if (row.version !== 1 || row.identityKey !== key || typeof row.ownerEpoch !== 'string' || !row.ownerEpoch
    || !['incomplete', 'checkpoint', 'completed', 'settled_failed'].includes(row.state!)
    || row.state === 'checkpoint' && !/^[a-f0-9]{64}$/.test(row.checkpointSha256 || '')) throw new NativeTurnReconciliationError();
  return row as TraceRecord;
}

function threadRecord(value: unknown, key: string): ThreadRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeTurnReconciliationError();
  const row = value as Partial<ThreadRecord>;
  if (row.version !== 1 || row.threadKey !== key || !row.turns || typeof row.turns !== 'object' || Array.isArray(row.turns)) throw new NativeTurnReconciliationError();
  for (const [identityKey, turn] of Object.entries(row.turns)) {
    if (!/^[a-f0-9]{64}$/.test(identityKey) || !turn || typeof turn.ownerEpoch !== 'string' || !turn.ownerEpoch
      || !['incomplete', 'completed', 'settled_failed'].includes(turn.state)) throw new NativeTurnReconciliationError();
  }
  return row as ThreadRecord;
}

function readTextOptional(file:string){try{return readFileSync(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
function statSyncOptionalLayout(file:string){const text=readTextOptional(file);return !!text&&JSON.parse(text).version===2;}
function persist(file: string, value: IdentityRecord | TraceRecord | ThreadRecord | TerminalRecord): void {
  try {
    const isIdentity='traces' in value,isThread='turns' in value,entries=isIdentity?value.traces:isThread?value.turns:undefined;
    if(entries&&(Object.keys(entries).length>MAX_TRACES_PER_TURN||statSyncOptionalLayout(file))){
      const key=isIdentity?value.identityKey:value.threadKey,field=isIdentity?'traces':'turns',members=join(dirname(file),(isIdentity?'identity-':'thread-')+key+'-'+field);mkdirSync(members,{recursive:true});
      for(const [memberKey,entry]of Object.entries(entries)){
        const member=join(members,memberKey+'.json'),next=JSON.stringify(isIdentity?{version:1,identityKey:key,traceId:memberKey,trace:entry}:{version:1,threadKey:key,identityKey:memberKey,turn:entry})+'\n';
        if(readTextOptional(member)!==next)atomicWriteFile(member,next);
      }
      if(isThread)for(const name of readdirSync(members))if(!Object.hasOwn(entries,name.slice(0,-5))){
        if(!/^[a-f0-9]{64}\.json$/.test(name)||!archivedTurn(dirname(file),key,name.slice(0,-5)))throw new NativeTurnReconciliationError();
        // Exact archived membership was saved first; deletion cannot erase the
        // original execution identity or authorize replay after a partial write.
        unlinkSync(join(members,name));
      }
      atomicWriteFile(file,JSON.stringify({version:2,[isIdentity?'identityKey':'threadKey']:key,layout:isIdentity?'trace_members':'turn_members'})+'\n');
    }else atomicWriteFile(file, `${JSON.stringify(value)}\n`);
  } catch {
    throw new NativeTurnReconciliationError('Native turn admission evidence could not be saved. Reconcile the original turn before another Web send.');
  }
}

function withAdmissionLocks<T>(directory: string, lockNames: string[], action: () => T): T {
  const acquired: string[] = [];
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Exclusive mkdir closes the first-admission race across runtime processes. A crash
    // retains its lock for reconciliation; it cannot be silently stolen.
    for (const name of [...new Set(lockNames)].sort()) {
      const lock = join(directory, `lock-${name}`);
      mkdirSync(lock);
      acquired.push(lock);
    }
    return action();
  } catch (error) {
    if (error instanceof NativeTurnReconciliationError) throw error;
    throw new NativeTurnReconciliationError('Native turn admission is locked or unavailable. Reconcile the original owner before another Web send.');
  } finally {
    for (const lock of acquired.reverse()) {
      try { rmdirSync(lock); } catch { /* A retained lock keeps this turn closed. */ }
    }
  }
}

function archivedTurn(directory:string,threadKey:string,key:string):any{
 const row=readRecord(join(directory,`thread-${threadKey}-terminal-${key}.json`)) as any;
 if(row===undefined)return undefined;
 if(row.version!==1||row.kind!=='verified_native_turn_membership'||row.threadKey!==threadKey||row.identityKey!==key||typeof row.threadId!=='string'||typeof row.turnId!=='string'||createHash('sha256').update(row.threadId).digest('hex')!==threadKey||createHash('sha256').update(JSON.stringify([row.threadId,row.turnId])).digest('hex')!==key||row.nativeProof?.threadId!==row.threadId||row.nativeProof?.turnId!==row.turnId||!['sessionSha256','eventSha256'].every(field=>/^[a-f0-9]{64}$/.test(row.nativeProof[field]||'')))throw new NativeTurnReconciliationError();
 return row;
}
export function retireNativeOwnerAdmissions(home:string,epoch:string,records:any[]):void{
 const owner=acceptedByOwner.get(ownerKey(home,epoch));if(!owner||!records.length)return;
 const directory=join(home,'runtime/native-turn-admission');
 const locks=records.map(row=>'owner-'+createHash('sha256').update(row.threadId).digest('hex'));
 withAdmissionLocks(directory,locks,()=>{
  // Validate the original batch before retiring any shared native turn member.
  const indices=new Map<string,any>();
  for(const row of records){
   const key=createHash('sha256').update(JSON.stringify([row.threadId,row.turnId])).digest('hex'),threadKey=createHash('sha256').update(row.threadId).digest('hex');
   const trace=traceRecord(readRecord(join(directory,'trace-'+row.traceId+'.json')),key);
   if(!indices.has(key))indices.set(key,identityRecord(readRecord(join(directory,'identity-'+key+'.json')),key));
   const thread=threadRecord(readRecord(join(directory,'thread-'+threadKey+'.json')),threadKey),membership=thread?.turns[key]||{ownerEpoch:archivedTurn(directory,threadKey,key)?.ownerEpoch,state:'completed'};
   if(!trace||createHash('sha256').update(JSON.stringify([trace,indices.get(key),membership])).digest('hex')!==row.admissionSha256||row.reviewSha256&&createHash('sha256').update(readFileSync(join(home,'turn-reviews',row.traceId+'.json'))).digest('hex')!==row.reviewSha256)throw new NativeTurnReconciliationError('Native terminal admission changed before retirement.');
  }
  for(const row of records){
   const original=owner.pending.get(row.traceId);if(!original||original.threadId!==row.threadId||original.turnId!==row.turnId)throw new NativeTurnReconciliationError();
   const key=createHash('sha256').update(JSON.stringify([row.threadId,row.turnId])).digest('hex'),threadKey=createHash('sha256').update(row.threadId).digest('hex');
   if(row.nativeToolsTerminal!==true||row.workflowJobs?.length||row.workflowSessions?.length||row.nativeProof?.threadId!==row.threadId||row.nativeProof?.turnId!==row.turnId)throw new NativeTurnReconciliationError();
   const trace=traceRecord(readRecord(join(directory,'trace-'+row.traceId+'.json')),key),thread=threadRecord(readRecord(join(directory,'thread-'+threadKey+'.json')),threadKey);
   if(!trace||trace.ownerEpoch!==epoch||!thread||thread.turns[key]?.ownerEpoch!==epoch&&!archivedTurn(directory,threadKey,key))throw new NativeTurnReconciliationError();
   if(!/^[a-f0-9]{64}$/.test(row.sourceSha256||'')||createHash('sha256').update(readFileSync(join(home,'turn-sources',row.traceId+'.json'))).digest('hex')!==row.sourceSha256||sessionRevision(row.sessionFile)!==row.sessionRevision)throw new NativeTurnReconciliationError();
   const summary={version:1,kind:'verified_native_owner_terminal',ownerEpoch:epoch,...row};
   atomicWriteFile(join(directory,'owner-terminal-'+row.traceId+'.json'),JSON.stringify(summary)+'\n');
   if(!archivedTurn(directory,threadKey,key))atomicWriteFile(join(directory,`thread-${threadKey}-terminal-${key}.json`),JSON.stringify({version:1,kind:'verified_native_turn_membership',threadKey,identityKey:key,ownerEpoch:epoch,threadId:row.threadId,turnId:row.turnId,nativeProof:row.nativeProof})+'\n');
   if(thread.turns[key]){delete thread.turns[key];persist(join(directory,'thread-'+threadKey+'.json'),thread);}
   owner.terminalSha256=createHash('sha256').update(JSON.stringify([owner.terminalSha256,createHash('sha256').update(JSON.stringify(summary)).digest('hex')])).digest('hex');owner.terminalCount++;owner.pending.delete(row.traceId);
  }
 });
}

function legacyFinalObserved(home: string, traceId: string, identity: { threadId?: string; turnId?: string }, sessionsRoot?: string): boolean {
  const turn = readRecord(join(home, 'turns', `${traceId}.json`)) as Record<string, unknown> | undefined;
  const review = readRecord(join(home, 'turn-reviews', `${traceId}.json`)) as Record<string, unknown> | undefined;
  const proof = review?.nativeProof as Record<string, unknown> | undefined;
  // A missing send checkpoint is uncertainty, including when the old journal says
  // submission:not-observed. Browser completion alone is not a native final answer.
  if (!(turn?.traceId === traceId && turn.status === 'completed' && turn.submission === 'confirmed'
    && review?.traceId === traceId && review.threadId === identity.threadId && review.turnId === identity.turnId
    && review.taskAcceptance === 'unverified' && typeof review.observedAt === 'string'
    && typeof review.finalSha256 === 'string' && /^[a-f0-9]{64}$/.test(review.finalSha256)
    // Only explicit historical imports carry CLI completion and time-window
    // checks. An ordinary browser final must not unlock a pre-gate thread.
    && typeof review.sourceFile === 'string' && typeof review.sourceSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(review.sourceSha256)
    && proof?.version === 1 && proof.threadId === identity.threadId && proof.turnId === identity.turnId
    && proof.terminal === 'task_complete_with_matching_final' && proof.finalSha256 === review.finalSha256
    && typeof proof.eventSha256 === 'string' && /^[a-f0-9]{64}$/.test(proof.eventSha256)
    && typeof identity.threadId === 'string' && typeof identity.turnId === 'string')) return false;
  try {
    const receipt = nativeReceipt.verifyNativeTerminalReceipt({ threadId: identity.threadId, turnId: identity.turnId,
      expectedFinalSha256: review.finalSha256, sessionsRoot });
    return receipt.receiptSha256 === proof.eventSha256;
  } catch { return false; }
}

function recordSha256(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hasExactNativeTerminal(home: string, directory: string, threadId: string, identityKey: string, sessionsRoot?: string): boolean {
  // The identity index bounds candidate traces; never rescan every source file
  // for each prior turn in a long-running thread.
  const identity = identityRecord(readRecord(join(directory, `identity-${identityKey}.json`)), identityKey);
  if (!identity) return false;
  for (const [traceId, traceState] of Object.entries(identity.traces)) {
    if (traceState.state !== 'completed') continue;
    const source = readRecord(join(home, 'turn-sources', `${traceId}.json`)) as Record<string, unknown> | undefined;
    if (source?.traceId !== traceId || source.threadId !== threadId || typeof source.turnId !== 'string') continue;
    const sourceKey = createHash('sha256').update(JSON.stringify([threadId, source.turnId])).digest('hex');
    if (sourceKey !== identityKey) continue;
    const isCompaction = source.purpose === 'compaction';
    const turn = isCompaction ? undefined : readRecord(join(home, 'turns', `${traceId}.json`)) as Record<string, unknown> | undefined;
    const review = readRecord(join(home, 'turn-reviews', `${traceId}.json`)) as Record<string, unknown> | undefined;
    // Structured compaction's logical trace is not the physical handoff Send
    // trace. Its exact native final plus bound review is the terminal evidence;
    // a normal response still requires its own confirmed browser submission.
    if ((!isCompaction && (turn?.traceId !== traceId || turn.status !== 'completed' || turn.submission !== 'confirmed'))
      || review?.traceId !== traceId || review.threadId !== threadId || review.turnId !== source.turnId
      || typeof review.finalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(review.finalSha256)) continue;
    const terminalFile = join(directory, `native-terminal-${identityKey}.json`);
    const sourceSha256 = recordSha256(source);
    const turnSha256 = recordSha256(isCompaction ? { purpose: 'compaction', traceId } : turn!);
    const reviewSha256 = recordSha256(review);
    const cached = readRecord(terminalFile) as Partial<TerminalRecord> | undefined;
    if (cached?.version === 1 && cached.identityKey === identityKey && cached.threadId === threadId
      && cached.turnId === source.turnId && cached.traceId === traceId && cached.finalSha256 === review.finalSha256
      && cached.sourceSha256 === sourceSha256 && cached.turnSha256 === turnSha256
      && cached.reviewSha256 === reviewSha256 && typeof cached.receiptSha256 === 'string'
      && /^[a-f0-9]{64}$/.test(cached.receiptSha256)) return true;
    try {
      const receipt = nativeReceipt.verifyNativeTerminalReceipt({ threadId, turnId: source.turnId, expectedFinalSha256: review.finalSha256, sessionsRoot });
      persist(terminalFile, { version: 1, identityKey, threadId, turnId: source.turnId, traceId,
        finalSha256: review.finalSha256, receiptSha256: receipt.receiptSha256,
        sourceSha256, turnSha256, reviewSha256 });
      return true;
    } catch { /* Another candidate trace may carry the exact final receipt. */ }
  }
  return false;
}

function assertPriorNativeTerminals(home: string, directory: string, threadId: string | undefined, currentKey: string, prior: ThreadRecord | undefined, ownerEpoch: string, sessionsRoot?: string): void {
  if (!threadId || !prior) return;
  for (const [identityKey, turn] of Object.entries(prior.turns)) {
    if (turn.ownerEpoch === ownerEpoch || turn.state !== 'completed') continue;
    if (identityKey === currentKey || !hasExactNativeTerminal(home, directory, threadId, identityKey, sessionsRoot)) {
      throw new NativeTurnReconciliationError('A previous browser final is recorded, but the exact Codex native turn has no verified terminal receipt. Check the original task and results before a new Web send; no message was sent.');
    }
  }
}

function assertLegacyEvidenceReconciled(
  home: string,
  identity: { threadId?: string; turnId?: string },
  traceId: string,
  ownerEpoch: string,
  directory: string,
  key: string,
  threadIndex: ThreadRecord | undefined,
  sessionsRoot?: string,
): void {
  const admissionHasEvidence = (sourceTrace: string, sourceKey: string): boolean => {
    const current = traceRecord(readRecord(join(directory, `trace-${sourceTrace}.json`)), sourceKey);
    return current?.ownerEpoch === ownerEpoch || current?.state === 'completed' || current?.state === 'settled_failed';
  };
  if (!admissionHasEvidence(traceId, key)) {
    const priorTurn = readRecord(join(home, 'turns', `${traceId}.json`));
    if (priorTurn !== undefined) throw legacyExactReplayError(traceId);
  }
  let names: string[];
  try {
    names = readdirSync(join(home, 'turn-sources'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new NativeTurnReconciliationError('Native turn source evidence is unreadable. Reconcile the original turn before another Web send.');
  }
  for (const name of names) {
    if (!/^[-A-Za-z0-9_]{6,128}\.json$/.test(name)) continue;
    const sourceTrace = name.slice(0, -5);
    let source: Record<string, unknown> | undefined;
    try { source = readRecord(join(home, 'turn-sources', name)) as Record<string, unknown> | undefined; }
    catch (error) {
      if (sourceTrace === traceId) throw error;
      continue; // An unrelated unreadable source cannot identify this turn.
    }
    const sameThread = identity.threadId && source?.threadId === identity.threadId;
    if (sourceTrace !== traceId && !sameThread && (source?.threadId !== identity.threadId || source?.turnId !== identity.turnId)) continue;
    if (!source || source.traceId !== sourceTrace || typeof source.threadId !== 'string' || typeof source.turnId !== 'string'
      || (sourceTrace === traceId && (source.threadId !== identity.threadId || source.turnId !== identity.turnId))) {
      throw legacyReconciliationError(sourceTrace);
    }
    const sourceIdentity = { threadId: source.threadId, turnId: source.turnId };
    const sourceKey = createHash('sha256').update(JSON.stringify([sourceIdentity.threadId, sourceIdentity.turnId])).digest('hex');
    // A missing thread index cannot silently erase a prior gate-owned turn.
    // Legacy pre-gate sources have neither admission record and retain their
    // old reconciliation path below.
    const archived=sameThread&&archivedTurn(directory,createHash('sha256').update(source.threadId).digest('hex'),sourceKey);
    if(archived){const terminal=readRecord(join(directory,'owner-terminal-'+sourceTrace+'.json')) as any;if(!terminal||terminal.threadId!==source.threadId||terminal.turnId!==source.turnId||terminal.sourceSha256!==createHash('sha256').update(readFileSync(join(home,'turn-sources',name))).digest('hex'))throw new NativeTurnReconciliationError('Archived native source no longer matches its original terminal.');}
    if ((!threadIndex || !threadIndex.turns[sourceKey]) && !archived && sameThread && sourceTrace !== traceId) {
      const sourceAdmission = readRecord(join(directory, `trace-${sourceTrace}.json`));
      const sourceIdentityAdmission = readRecord(join(directory, `identity-${sourceKey}.json`));
      if (sourceAdmission !== undefined || sourceIdentityAdmission !== undefined) {
        throw new NativeTurnReconciliationError('Native thread admission index is missing a prior admitted turn. Reconcile that thread before another Web send.');
      }
    }
    if (sourceTrace === traceId && !admissionHasEvidence(sourceTrace, sourceKey)) throw legacyExactReplayError(sourceTrace);
    if (!admissionHasEvidence(sourceTrace, sourceKey) && !legacyFinalObserved(home, sourceTrace, sourceIdentity, sessionsRoot)
        && !hasFailedSettlement(home, sourceIdentity, sourceTrace)) {
      throw legacyReconciliationError(sourceTrace);
    }
  }
}

/** Persist before entering the upstream adapter, where broker registration and Web send begin. */
export function createNativeTurnAdmission(home: string, ownerEpoch = runtimeOwnerEpoch, sessionsRoot?: string,
  canReplayIncomplete?: (threadId: string, turnId: string, traceId: string) => boolean,
  acceptedCheckpointSha256?: (threadId: string, turnId: string) => string | undefined) {
  const directory = join(home, 'runtime', 'native-turn-admission');
  // Called under the thread lock, only for an earlier turn. Preserve failed
  // traces as tombstones; neither native reconnection nor a changed trace may
  // reopen that turn. Reconciliation authorizes no model send by itself.
  function reconcilePriorFailures(threadId: string, currentKey: string, prior?: ThreadRecord): void {
    if (!prior) return;
    for (const [key, entry] of Object.entries(prior.turns)) {
      if (key === currentKey) continue;
      const identityFile = join(directory, `identity-${key}.json`);
      const row = identityRecord(readRecord(identityFile), key);
      if (!row || !Object.keys(row.traces).length) {
        if (entry.state === 'settled_failed') throw new NativeTurnReconciliationError('Failed-turn trace index is missing.');
        continue;
      }
      let changed = false;
      const groupTraces = Object.keys(row.traces);
      const groupSource = readRecord(join(home, 'turn-sources', `${groupTraces[0]}.json`)) as Record<string, unknown> | undefined;
      const groupIdentity = {threadId, turnId: groupSource?.turnId};
      const checkpointFailure = typeof groupIdentity.turnId === 'string'
        && reconcileNativeCheckpointFailure(home, groupIdentity, groupTraces, sessionsRoot);
      if (entry.state === 'completed' && !checkpointFailure) continue;
      if (typeof groupIdentity.turnId === 'string' &&
          createHash('sha256').update(JSON.stringify([threadId, groupIdentity.turnId])).digest('hex') === key &&
          (checkpointFailure || reconcileNativeCompactionFailure(home, groupIdentity, groupTraces, sessionsRoot))) {
        for (const [traceId, state] of Object.entries(row.traces)) {
          const traceFile = join(directory, `trace-${traceId}.json`);
          const original = traceRecord(readRecord(traceFile), key);
          if (!original || original.ownerEpoch !== state.ownerEpoch || state.state === 'completed' && !checkpointFailure) throw new NativeTurnReconciliationError();
          if (state.state === 'settled_failed') continue;
          persist(traceFile, {...original, state: 'settled_failed'});
          row.traces[traceId] = {...state, state: 'settled_failed'};
        }
        persist(identityFile, row);
        prior.turns[key] = {...entry, state: 'settled_failed'};
        continue;
      }
      for (const [traceId, state] of Object.entries(row.traces)) {
        if (state.state === 'completed') continue;
        const source = readRecord(join(home, 'turn-sources', `${traceId}.json`)) as Record<string, unknown> | undefined;
        if (source?.threadId !== threadId || typeof source.turnId !== 'string' ||
            createHash('sha256').update(JSON.stringify([threadId, source.turnId])).digest('hex') !== key) {
          if (state.state === 'settled_failed') throw new NativeTurnReconciliationError('Failed-turn source no longer matches its settlement.');
          continue;
        }
        const identity = {threadId, turnId: source.turnId};
        if (!reconcileLegacyFailedSettlement(home, identity, traceId, sessionsRoot)) {
          if (state.state === 'settled_failed') throw new NativeTurnReconciliationError('Failed-turn settlement evidence no longer matches the original turn.');
          continue;
        }
        const traceFile = join(directory, `trace-${traceId}.json`);
        const original = traceRecord(readRecord(traceFile), key);
        if (!original || original.ownerEpoch !== state.ownerEpoch) throw new NativeTurnReconciliationError();
        if (state.state === 'settled_failed') continue;
        persist(traceFile, {...original, state: 'settled_failed'});
        row.traces[traceId] = {...state, state: 'settled_failed'};
        changed = true;
      }
      if (changed) persist(identityFile, row);
      if (Object.values(row.traces).length && Object.values(row.traces).every(trace => trace.state === 'completed' || trace.state === 'settled_failed')) {
        prior.turns[key] = {...entry, state: Object.values(row.traces).some(trace => trace.state === 'completed') ? 'completed' : 'settled_failed'};
      }
    }
    persist(join(directory, `thread-${prior.threadKey}.json`), prior);
  }
  return {
    reconcileRetainedCompactionBeforePage(identity: {threadId:string;turnId:string}, logicalTraceId:string, physicalTraceId:string, auditFile:string): {settledFailures:number;unresolved:number} {
      const threadKey=createHash('sha256').update(identity.threadId).digest('hex');
      const key=createHash('sha256').update(JSON.stringify([identity.threadId,identity.turnId])).digest('hex');
      return withAdmissionLocks(directory,[`owner-${threadKey}`],()=>{
        const prior=threadRecord(readRecord(join(directory,`thread-${threadKey}.json`)),threadKey);
        const row=identityRecord(readRecord(join(directory,`identity-${key}.json`)),key);
        if(!prior?.turns[key]||!row?.traces[logicalTraceId]||Object.keys(row.traces).length<2)throw new NativeTurnReconciliationError();
        reconcileNativeRetainedCompactionBeforePage(home,identity,logicalTraceId,physicalTraceId,auditFile,sessionsRoot);
        reconcilePriorFailures(identity.threadId,'',prior);
        const turns=Object.values(prior.turns);
        return {settledFailures:turns.filter(row=>row.state==='settled_failed').length,unresolved:turns.filter(row=>row.state==='incomplete').length};
      });
    },
    reconcileCompactionBeforeSend(identity: {threadId:string;turnId:string}, physicalTraceId:string): {settledFailures:number;unresolved:number} {
      const threadKey=createHash('sha256').update(identity.threadId).digest('hex');
      const key=createHash('sha256').update(JSON.stringify([identity.threadId,identity.turnId])).digest('hex');
      return withAdmissionLocks(directory,[`owner-${threadKey}`],()=>{
        const prior=threadRecord(readRecord(join(directory,`thread-${threadKey}.json`)),threadKey);
        const row=identityRecord(readRecord(join(directory,`identity-${key}.json`)),key);
        if(!prior?.turns[key]||!row||Object.keys(row.traces).length!==1)throw new NativeTurnReconciliationError();
        const trace=Object.keys(row.traces)[0];
        reconcileNativeCompactionBeforeSend(home,identity,trace,physicalTraceId,sessionsRoot);
        reconcilePriorFailures(identity.threadId,'',prior);
        const turns=Object.values(prior.turns);
        return {settledFailures:turns.filter(row=>row.state==='settled_failed').length,
          unresolved:turns.filter(row=>row.state==='incomplete').length};
      });
    },
    reconcileThread(threadId: string): { settledFailures: number; unresolved: number } {
      if (!threadId) throw new NativeTurnReconciliationError();
      const threadKey = createHash('sha256').update(threadId).digest('hex');
      return withAdmissionLocks(directory, [`owner-${threadKey}`], () => {
        const prior = threadRecord(readRecord(join(directory, `thread-${threadKey}.json`)), threadKey);
        reconcilePriorFailures(threadId, '', prior);
        const turns = Object.values(prior?.turns || {});
        return {settledFailures: turns.filter(row => row.state === 'settled_failed').length,
          unresolved: turns.filter(row => row.state === 'incomplete').length};
      });
    },
    /** Reconcile one already archived failure; never recreate its thread membership or send it again. */
    reconcileFailedTrace(identity: {threadId:string;turnId:string}, traceId:string): void {
      const threadKey=createHash('sha256').update(identity.threadId).digest('hex');
      const key=createHash('sha256').update(JSON.stringify([identity.threadId,identity.turnId])).digest('hex');
      if(!TRACE_ID.test(traceId))throw new NativeTurnReconciliationError();
      withAdmissionLocks(directory,[`owner-${threadKey}`,`trace-${traceId}`],()=>{
        const archived=archivedTurn(directory,threadKey,key),terminal=readRecord(join(directory,`owner-terminal-${traceId}.json`)) as any;
        const sourceFile=join(home,'turn-sources',traceId+'.json'),source=readRecord(sourceFile) as any;
        const traceFile=join(directory,`trace-${traceId}.json`),trace=traceRecord(readRecord(traceFile),key);
        const identityFile=join(directory,`identity-${key}.json`),member=identityRecord(readRecord(identityFile),key);
        if(!archived||terminal?.state!=='failed'||terminal.threadId!==identity.threadId||terminal.turnId!==identity.turnId||
          source?.threadId!==identity.threadId||source.turnId!==identity.turnId||source.traceId!==traceId||
          terminal.sourceSha256!==createHash('sha256').update(readFileSync(sourceFile)).digest('hex')||
          !trace||!member||trace.ownerEpoch!==archived.ownerEpoch||member.traces[traceId]?.ownerEpoch!==archived.ownerEpoch||
          !['incomplete','settled_failed'].includes(trace.state)||member.traces[traceId]?.state!==trace.state||
          !hasFailedSettlement(home,identity,traceId))throw new NativeTurnReconciliationError('Original archived failure settlement is unavailable.');
        nativeReceipt.verifyNativeFailureReceipt({...identity,sessionsRoot});
        persist(identityFile,{...member,traces:{...member.traces,[traceId]:{ownerEpoch:trace.ownerEpoch,state:'settled_failed'}}});
        persist(traceFile,{...trace,state:'settled_failed'});
      });
    },
    /** Original-thread preflight only: no new native identity, broker token, source or Web Send. */
    inspectThread(threadId:string): {ready:true;threadId:string;modelSends:0} {
      if(!threadId)throw new NativeTurnReconciliationError();
      const threadKey=createHash('sha256').update(threadId).digest('hex');
      return withAdmissionLocks(directory,[`owner-${threadKey}`],()=>{
        const prior=threadRecord(readRecord(join(directory,`thread-${threadKey}.json`)),threadKey);
        if(Object.values(prior?.turns||{}).some(row=>row.state==='incomplete'||row.state==='checkpoint'))throw new NativeTurnReconciliationError();
        assertPriorNativeTerminals(home,directory,threadId,'',prior,ownerEpoch,sessionsRoot);
        assertLegacyEvidenceReconciled(home,{threadId},'',ownerEpoch,directory,'',prior,sessionsRoot);
        return {ready:true,threadId,modelSends:0};
      });
    },
    admit(identity: { threadId?: string; turnId?: string }, traceId: string): { replayOnly: boolean; complete(kind?: 'final' | 'checkpoint'): void } {
      // A turn ID without its native thread does not give a durable owner scope.
      // The upstream adapter can fall back to promptCacheKey, but that value is
      // not a native Session identity and cannot prove a later terminal receipt.
      if (!identity.threadId || !identity.turnId || !TRACE_ID.test(traceId)) throw new NativeTurnReconciliationError('Native thread or turn identity is unavailable; no Web send was admitted.');
      if(currentNativeOwnerAdmissions(home,ownerEpoch).some(row=>row.threadId===identity.threadId&&row.turnId!==identity.turnId)){try{reconcileNativeOwnerThread(home,ownerEpoch,identity.threadId,sessionsRoot);}catch{/* Unknown original work stays pending; existing admission rules still apply. */}}
      const key = createHash('sha256').update(JSON.stringify([identity.threadId ?? null, identity.turnId])).digest('hex');
      const threadKey = identity.threadId ? createHash('sha256').update(identity.threadId).digest('hex') : undefined;
      const lockNames = [`trace-${traceId}`, `owner-${threadKey ?? key}`];
      const identityFile = join(directory, `identity-${key}.json`);
      const traceFile = join(directory, `trace-${traceId}.json`);
      const threadFile = threadKey ? join(directory, `thread-${threadKey}.json`) : undefined;
      let replayOnly = false;
      withAdmissionLocks(directory, lockNames, () => {
        if(threadKey&&archivedTurn(directory,threadKey,key))throw new NativeTurnReconciliationError('This native turn has a verified archived terminal and cannot be reopened; no new Web message was sent.');
        const priorIdentity = identityRecord(readRecord(identityFile), key);
        const priorTrace = traceRecord(readRecord(traceFile), key);
        const priorThread = threadFile && threadKey ? threadRecord(readRecord(threadFile), threadKey) : undefined;
        for(const owned of currentNativeOwnerAdmissions(home,ownerEpoch))if(owned.threadId===identity.threadId&&owned.turnId!==identity.turnId){const ownedKey=createHash('sha256').update(JSON.stringify([owned.threadId,owned.turnId])).digest('hex');if(!priorThread?.turns[ownedKey]&&!archivedTurn(directory,threadKey!,ownedKey))throw new NativeTurnReconciliationError('Native thread index lost pending original membership.');}
        // Reusing this owner's thread audit never grants replay to a pre-gate
        // trace. The exact trace check is independent of archive enumeration.
        if(!priorTrace&&!priorIdentity?.traces[traceId]&&(readRecord(join(home,'turn-sources',traceId+'.json'))!==undefined||readRecord(join(home,'turns',traceId+'.json'))!==undefined))throw legacyExactReplayError(traceId);
        // The original owner already reconciled this turn before its first
        // Send. Tool-result requests stay on that execution path; they do not
        // rescan every historical source or reopen old Session receipts.
        const ownsTurn = priorThread?.turns[key]?.ownerEpoch === ownerEpoch
          && priorIdentity && Object.values(priorIdentity.traces).every(row => row.ownerEpoch === ownerEpoch);
        // A completed browser/adapter round is never a durable Responses replay,
        // even in this process: the upstream canonical cache is pruned or retired.
        // Only an incomplete trace may reconnect to its current in-memory owner.
        const replayable = (row: TraceState) => ['incomplete', 'checkpoint'].includes(row.state);
        if (priorTrace && (!replayable(priorTrace) || priorTrace.ownerEpoch !== ownerEpoch)) {
          throw !replayable(priorTrace) ? settledTraceReplayError(traceId, priorTrace.state) : new NativeTurnReconciliationError();
        }
        if (priorIdentity?.traces[traceId] && (!replayable(priorIdentity.traces[traceId]) || priorIdentity.traces[traceId].ownerEpoch !== ownerEpoch)) {
          throw !replayable(priorIdentity.traces[traceId]) ? settledTraceReplayError(traceId, priorIdentity.traces[traceId].state) : new NativeTurnReconciliationError();
        }
        // A different trace with the same native turn after its final is also a
        // replay (for example changed revision/model or an evicted upstream key).
        if (priorIdentity && !priorIdentity.traces[traceId] && Object.values(priorIdentity.traces).some(row => row.state === 'completed' || row.state === 'settled_failed')) {
          const reason=Object.values(priorIdentity.traces).some(row => row.state === 'completed') ? 'completed browser final' : 'reconciled browser failure';
          throw new NativeTurnReconciliationError(`This native turn already has a ${reason}. A changed trace cannot reopen it; no new Web message was sent.`);
        }
        if (priorIdentity && !priorIdentity.traces[traceId]) {
          const checkpoints = Object.values(priorIdentity.traces).filter(row => row.state === 'checkpoint');
          if (checkpoints.length && (checkpoints.some(row => row.ownerEpoch !== ownerEpoch)
            || !checkpoints.some(row => row.checkpointSha256 === acceptedCheckpointSha256?.(identity.threadId!, identity.turnId!)))) {
            throw new NativeTurnReconciliationError('Native compaction continuation has no matching checkpoint from this runtime; no new Web message was sent.');
          }
        }
        // Same-owner incomplete reentry is safe only while the upstream
        // canonical session is still present. Explicit stop, retirement and
        // TTL pruning remove it; admitting afterward would send again.
        if ((priorTrace || priorIdentity?.traces[traceId])
          && !canReplayIncomplete?.(identity.threadId, identity.turnId, traceId)) {
          throw new NativeTurnReconciliationError('The original in-memory browser round is no longer available for replay. Reconcile the original turn; no new Web message was sent.');
        }
        replayOnly = Boolean(priorTrace || priorIdentity?.traces[traceId]);
        if (!ownsTurn) reconcilePriorFailures(identity.threadId, key, priorThread);
        if (priorIdentity && Object.values(priorIdentity.traces).some(row => row.state === 'incomplete' && row.ownerEpoch !== ownerEpoch)) {
          throw new NativeTurnReconciliationError();
        }
        if (priorThread && Object.values(priorThread.turns).some(row => row.state === 'incomplete' && row.ownerEpoch !== ownerEpoch)) {
          throw new NativeTurnReconciliationError();
        }
        if (priorThread && Object.entries(priorThread.turns).some(([priorKey, row]) => priorKey !== key && row.state === 'incomplete')) {
          throw new NativeTurnReconciliationError('Another native turn in this thread has not settled. Reconcile its original browser execution before a new Web send.');
        }
        // Adapter completion can precede native Codex delivery. On a new owner,
        // a different turn in this thread may proceed only after the exact prior
        // Session records the matching final; the old trace stays tombstoned.
        if (!ownsTurn) {
          assertPriorNativeTerminals(home, directory, identity.threadId, key, priorThread, ownerEpoch, sessionsRoot);
          if(!acceptedByOwner.get(ownerKey(home,ownerEpoch))?.reconciledThreads.has(identity.threadId))assertLegacyEvidenceReconciled(home, identity, traceId, ownerEpoch, directory, key, priorThread, sessionsRoot);
        }
        const traces = { ...priorIdentity?.traces, [traceId]: priorIdentity?.traces[traceId] || { ownerEpoch, state: 'incomplete' as const } };
        const turns = { ...priorThread?.turns, [key]: { ownerEpoch, state: 'incomplete' as const } };
        // Write broader ownership first. A crash between writes blocks the same thread,
        // then the same native turn, even if the next request has a different trace.
        if (threadFile && threadKey) persist(threadFile, { version: 1, threadKey, turns });
        persist(identityFile, { version: 1, identityKey: key, traces });
        persist(traceFile, { version: 1, identityKey: key, ...traces[traceId] });
        // No browser/broker delegation occurs before these three durable writes.
        // A partial-write failure never reaches this process-owned registration.
        const owner=ownerKey(home,ownerEpoch),accepted=acceptedByOwner.get(owner)||newOwnerSet();
        accepted.pending.set(traceId,{traceId,threadId:identity.threadId!,turnId:identity.turnId!});accepted.reconciledThreads.delete(identity.threadId!);accepted.reconciledThreads.set(identity.threadId!,true);while(accepted.reconciledThreads.size>256)accepted.reconciledThreads.delete(accepted.reconciledThreads.keys().next().value!);acceptedByOwner.set(owner,accepted);
      });
      return {
        replayOnly,
        complete(kind = 'final'): void {
          withAdmissionLocks(directory, lockNames, () => {
            const currentTrace = traceRecord(readRecord(traceFile), key);
            const currentIdentity = identityRecord(readRecord(identityFile), key);
            const currentThread = threadFile && threadKey ? threadRecord(readRecord(threadFile), threadKey) : undefined;
            if (!currentTrace || !currentIdentity || currentTrace.ownerEpoch !== ownerEpoch || currentIdentity.traces[traceId]?.ownerEpoch !== ownerEpoch
              || (threadFile && currentThread?.turns[key]?.ownerEpoch !== ownerEpoch)) throw new NativeTurnReconciliationError();
            let checkpointSha256: string | undefined;
            if (kind === 'checkpoint') {
              const source = readRecord(join(home, 'turn-sources', `${traceId}.json`)) as Record<string, unknown> | undefined;
              const review = readRecord(join(home, 'turn-reviews', `${traceId}.json`)) as Record<string, unknown> | undefined;
              if (source?.purpose !== 'compaction' || source.threadId !== identity.threadId || source.turnId !== identity.turnId
                || review?.traceId !== traceId || review.threadId !== identity.threadId || review.turnId !== identity.turnId
                || typeof review.finalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(review.finalSha256)) throw new NativeTurnReconciliationError();
              checkpointSha256 = review.finalSha256;
            }
            const completedTrace: TraceState = {ownerEpoch, state: kind === 'checkpoint' ? 'checkpoint' : 'completed',
              ...(checkpointSha256 ? {checkpointSha256} : {})};
            const traces = { ...currentIdentity.traces, [traceId]: completedTrace };
            // The broader thread entry remains incomplete if any trace of this native
            // turn has not produced a settled final answer.
            persist(traceFile, {version: 1, identityKey: key, ...completedTrace});
            persist(identityFile, { ...currentIdentity, traces });
            if (threadFile && threadKey && currentThread) persist(threadFile, {
              ...currentThread,
              turns: { ...currentThread.turns, [key]: {
                ownerEpoch,
                state: Object.values(traces).every(row => row.state === 'completed' || row.state === 'checkpoint')
                  && Object.values(traces).some(row => row.state === 'completed') ? 'completed' : 'incomplete',
              } },
            });
          });
        },
      };
    },
  };
}
