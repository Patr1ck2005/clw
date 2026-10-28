import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from './upstream/src/config';
import type { AdapterEvent, CodexParsedRequest } from './upstream/src/types';
import source from './turn-source.cjs';
import review from './turn-review.cjs';

const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const TRACE = /^[a-f0-9]{12}$/;

type Identity = { threadId: string; turnId: string };
type ReplayPayload = {
  version: 1;
  threadId: string;
  turnId: string;
  traceId: string;
  requestSha256: string;
  rawModel: string;
  modelId: string;
  effort: string | null;
  responseId: string;
  createdAt: number;
  finalSha256: string;
  events: AdapterEvent[];
};
type ReplayRecord = ReplayPayload & { sha256: string };

export class NativeFinalReplayError extends Error {
  constructor(message = 'The completed native response replay journal is missing or invalid. Reconcile the original turn; no new Web message was sent.') {
    super(message);
    this.name = 'NativeFinalReplayError';
  }
}

// A compaction or opaque multi-agent turn still needs its original admission
// path. Do not confuse ineligibility with broken history.
export class NativeFinalReplayNotEligible extends NativeFinalReplayError {
  constructor() {
    super('This native request is outside completed final-only replay.');
    this.name = 'NativeFinalReplayNotEligible';
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    // Match JSON request semantics: undefined object fields are omitted. The raw
    // body comes from JSON, while parsed optional fields can still be undefined.
    return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new NativeFinalReplayError('The canonical native request is unavailable; no new Web message was sent.');
}

function rawBody(parsed: CodexParsedRequest): Record<string, unknown> {
  const body = parsed._rawBody;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray((body as { input?: unknown }).input)) {
    throw new NativeFinalReplayError('The full canonical native request is unavailable; no new Web message was sent.');
  }
  return body as Record<string, unknown>;
}

export function finalReplayBinding(parsed: CodexParsedRequest, identity: Identity, traceId: string): Omit<ReplayPayload, 'responseId' | 'createdAt' | 'finalSha256' | 'events'> {
  const body = rawBody(parsed);
  const rawModel = body.model;
  if (!TRACE.test(traceId) || typeof rawModel !== 'string' || !rawModel || typeof parsed.modelId !== 'string' || !parsed.modelId)
    throw new NativeFinalReplayError('The native replay identity or model is invalid; no new Web message was sent.');
  // The local previous_response_id prefix must have been restored before the adapter sees it.
  // Replaying only the suffix would silently discard prior Codex output/tool state.
  if ((typeof body.previous_response_id === 'string' || parsed.previousResponseId)
    && !(typeof parsed._replayPrefixLen === 'number' && parsed._replayPrefixLen > 0)) {
    throw new NativeFinalReplayError('The previous_response_id history is incomplete; no new Web message was sent.');
  }
  if (parsed._compactionRequest || parsed._opaqueMultiAgentV2Payload)
    throw new NativeFinalReplayNotEligible();
  const effort = parsed.options.reasoning ?? null;
  const requestSha256 = hash(canonical({
    rawBody: body,
    modelId: parsed.modelId,
    options: parsed.options,
    stream: parsed.stream === true,
    previousResponseId: parsed.previousResponseId ?? null,
    replayPrefixLen: parsed._replayPrefixLen ?? 0,
  }));
  return { version: 1, ...identity, traceId, requestSha256, rawModel, modelId: parsed.modelId, effort };
}

export function finalReplayResponseId(binding: ReturnType<typeof finalReplayBinding>): string {
  return `resp_${hash(canonical([binding.threadId, binding.turnId, binding.traceId, binding.requestSha256])).slice(0, 32)}`;
}

function finalText(events: AdapterEvent[]): string | null {
  let text = '';
  if (events.length < 2 || events.length > 100_000) return null;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.type === 'assistant_boundary') text = '';
    else if (event.type === 'text_delta') {
      if (typeof event.text !== 'string' || (event.phase !== 'final_answer' && event.phase !== 'commentary' && event.phase !== undefined)) return null;
      if (event.phase === 'final_answer') {
        text += event.text;
        if (text.length > 4 * 1024 * 1024) return null;
      }
    } else if (event.type === 'done') {
      if (index !== events.length - 1 || event.endTurn !== true || event.stopReason !== 'stop') return null;
    } else if (!['heartbeat', 'thinking_delta', 'thinking_signature', 'redacted_thinking', 'reasoning_raw_delta'].includes(event.type)) {
      return null;
    }
  }
  return text.length > 0 && events.at(-1)?.type === 'done' ? text : null;
}

function journalFile(home: string, traceId: string): string { return join(home, 'runtime', 'native-final-replay', `${traceId}.json`); }

function admissionComplete(home: string, identity: Identity, traceId: string): boolean {
  const directory = join(home, 'runtime', 'native-turn-admission');
  const identityKey = hash(JSON.stringify([identity.threadId, identity.turnId]));
  const threadKey = hash(identity.threadId);
  const read = (name: string): Record<string, any> => {
    const path = join(directory, name);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > 256 * 1024) throw new NativeFinalReplayError();
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  };
  try {
    const trace = read(`trace-${traceId}.json`);
    const turn = read(`identity-${identityKey}.json`);
    const thread = read(`thread-${threadKey}.json`);
    const epoch = trace.ownerEpoch;
    return trace.version === 1 && trace.identityKey === identityKey && trace.state === 'completed'
      && typeof epoch === 'string' && epoch.length > 0
      && turn.version === 1 && turn.identityKey === identityKey
      && turn.traces?.[traceId]?.state === 'completed' && turn.traces[traceId].ownerEpoch === epoch
      && thread.version === 1 && thread.threadKey === threadKey
      && thread.turns?.[identityKey]?.state === 'completed' && thread.turns[identityKey].ownerEpoch === epoch;
  } catch { return false; }
}

function evidenceMatches(home: string, payload: ReplayPayload): boolean {
  const { traceId, threadId, turnId, rawModel, finalSha256 } = payload;
  const bound = source.readSource(home, traceId);
  const checkedReview = review.readReview(home, traceId);
  return bound?.traceId === traceId && bound.threadId === threadId && bound.turnId === turnId
    && bound.model === rawModel && bound.purpose === 'response'
    && checkedReview?.threadId === threadId && checkedReview.turnId === turnId
    && checkedReview.finalSha256 === finalSha256
    && admissionComplete(home, { threadId, turnId }, traceId);
}

export function readFinalReplay(home: string, binding: ReturnType<typeof finalReplayBinding>): ReplayPayload | null {
  const file = journalFile(home, binding.traceId);
  if (!existsSync(file)) return null;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_JOURNAL_BYTES) throw new Error('invalid size');
    const record = JSON.parse(readFileSync(file, 'utf8')) as ReplayRecord;
    const { sha256, ...payload } = record;
    if (!SHA256.test(sha256) || hash(canonical(payload)) !== sha256
      || payload.version !== 1 || payload.threadId !== binding.threadId || payload.turnId !== binding.turnId
      || payload.traceId !== binding.traceId || payload.requestSha256 !== binding.requestSha256
      || payload.rawModel !== binding.rawModel || payload.modelId !== binding.modelId || payload.effort !== binding.effort
      || payload.responseId !== finalReplayResponseId(binding)
      || !Number.isInteger(payload.createdAt) || payload.createdAt <= 0
      || !Array.isArray(payload.events) || !SHA256.test(payload.finalSha256)
      || hash(finalText(payload.events)?.trim() ?? '') !== payload.finalSha256
      || !finalText(payload.events) || !evidenceMatches(home, payload)) throw new Error('invalid replay record');
    return payload;
  } catch {
    throw new NativeFinalReplayError();
  }
}

export function commitFinalReplay(home: string, binding: ReturnType<typeof finalReplayBinding>, createdAt: number, events: AdapterEvent[]): void {
  const text = finalText(events);
  if (!text || !Number.isInteger(createdAt) || createdAt <= 0) throw new NativeFinalReplayError('The final-only response cannot be journaled; no terminal response was emitted.');
  const payload: ReplayPayload = { ...binding, responseId: finalReplayResponseId(binding), createdAt,
    finalSha256: hash(text.trim()), events: JSON.parse(JSON.stringify(events)) as AdapterEvent[] };
  if (!evidenceMatches(home, payload)) throw new NativeFinalReplayError('The native final evidence is incomplete; no terminal response was emitted.');
  const serialized = JSON.stringify({ ...payload, sha256: hash(canonical(payload)) }) + '\n';
  if (Buffer.byteLength(serialized) > MAX_JOURNAL_BYTES) throw new NativeFinalReplayError('The native final replay journal size limit was reached; no terminal response was emitted.');
  const file = journalFile(home, binding.traceId);
  if (existsSync(file)) {
    const prior = readFinalReplay(home, binding);
    if (prior && canonical(prior) === canonical(payload)) return;
    throw new NativeFinalReplayError('A conflicting completed final replay journal exists; no new Web message was sent.');
  }
  try { atomicWriteFile(file, serialized); }
  catch { throw new NativeFinalReplayError('The native final replay journal could not be saved; no terminal response was emitted.'); }
}

export function finalReplayJournalExists(home: string, traceId: string): boolean {
  return TRACE.test(traceId) && existsSync(journalFile(home, traceId));
}
