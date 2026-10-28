import { parseDataUrl } from "../image";
import { randomBytes } from "node:crypto";
import type {
  CodexContentPart,
  CodexParsedRequest,
  CodexToolResultMessage,
} from "../../types";
import { extractChatGptCompactionSourceRevision } from "./environment";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptWebCapabilities } from "./model";
import {
  activeCompactionToolResultInstruction,
  parseTextCompactionHandoff,
  textCompactionHandoffInstruction,
  zeroRiskActiveCompactionToolResultInstruction,
} from "./native-compaction-control";
import type { BrokerToolResult, TurnBroker, TurnBrokerOwner } from "./turn-broker";
import type { ChatGptTurnSession } from "./turn-execution";

export const LATEST_USER_PROMPT_MARKER = "CODEX_LATEST_USER_PROMPT_JSON";

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function interruptedByActiveCompaction(): BrokerToolResult {
  return {
    content: [{ type: "text", text: activeCompactionToolResultInstruction() }],
    isError: true,
  };
}

function withZeroRiskCompactionInstruction(result: BrokerToolResult): BrokerToolResult {
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: zeroRiskActiveCompactionToolResultInstruction(true),
      },
    ],
  };
}

function interruptedByZeroRiskCompaction(): BrokerToolResult {
  return {
    content: [{
      type: "text",
      text: zeroRiskActiveCompactionToolResultInstruction(false),
    }],
    isError: true,
  };
}

function userPromptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as { type?: unknown; text?: unknown };
    return (value.type === "input_text" || value.type === "text") && typeof value.text === "string"
      ? [value.text]
      : [];
  }).join("\n");
  return text || undefined;
}

export function canonicalizeCompactionHandoff(
  parsed: CodexParsedRequest,
  summary: string,
): string {
  const normalized = summary.trim();
  if (!normalized) throw new Error("ChatGPT returned an empty structured compaction handoff");
  const latestUserPrompt = userPromptText(extractChatGptCompactionSourceRevision(parsed).content);
  if (latestUserPrompt === undefined) {
    throw new Error("ChatGPT compaction source has no canonical latest user prompt");
  }
  const appendix = `${LATEST_USER_PROMPT_MARKER}\n${JSON.stringify(latestUserPrompt)}`;
  const markerOffset = normalized.lastIndexOf(`\n${LATEST_USER_PROMPT_MARKER}\n`);
  if (markerOffset < 0) return `${normalized}\n\n${appendix}`;
  if (normalized.slice(markerOffset + 1).trimEnd() !== appendix) {
    throw new Error("ChatGPT compaction handoff contains a conflicting latest-user marker");
  }
  return normalized;
}

function currentToolResults(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
): Map<string, CodexToolResultMessage> {
  const results = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (results.has(message.toolCallId)) {
      throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    }
    results.set(message.toolCallId, message);
  }
  return results;
}

export const MAX_COMPACTION_HANDOFF_TIMEOUT_MS = 5 * 60_000;
export const MAX_PRO_COMPACTION_HANDOFF_TIMEOUT_MS = 30 * 60_000;

export function compactionHandoffTimeoutMs(parsed: CodexParsedRequest, timeoutMs?: number): number {
  const limit = parsed.options.reasoning === "max"
    ? MAX_PRO_COMPACTION_HANDOFF_TIMEOUT_MS
    : MAX_COMPACTION_HANDOFF_TIMEOUT_MS;
  return Math.min(timeoutMs ?? limit, limit);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("ChatGPT compaction handoff aborted", "AbortError");
}

function withCompactionAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function settleActiveCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  signal?: AbortSignal,
): Promise<{ answer: string; compactionInstructionDelivered: boolean }> {
  return source.runExclusive(async () => {
    if (signal?.aborted) {
      source.cancel(abortReason(signal));
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools") {
      throw new Error("The active ChatGPT compaction source has no MCP tool boundary");
    }
    const outstanding = source.outstanding();
    const results = currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(
        `Codex supplied ${results.size} of ${outstanding.length} required tool results for compaction`,
      );
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      broker.requestCompaction(token, interruptedByActiveCompaction());
      for (const request of outstanding) {
        const result = results.get(request.callId)!;
        await broker.completeTool(
          token,
          request.callId,
          toolResult(result),
        );
        source.runtime.externalProgress.recordToolResult(request.callId);
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await withCompactionAbort(source.browserOutcome, signal);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      const compactionInstructionDelivered = broker.compactionDeliveryCount(token) > 0;
      // The one structured checkpoint message reuses this exact retained tab. It must not race the
      // helper's /turn/end handshake for the response that consumed the canonical tool results.
      // `requestCompaction` leaves those results untouched and only intercepts a later tool call, so
      // a zero delivery count proves that this is an ordinary publishable terminal response.
      await withCompactionAbort(source.physicalSettlement, signal);
      return {
        answer: browserOutcome.answer,
        compactionInstructionDelivered,
      };
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token) await broker.revoke(token);
    }
  });
}

export async function settleActiveZeroRiskCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBrokerOwner,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return source.runExclusive(async () => {
    if (signal?.aborted) {
      source.cancel(abortReason(signal));
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools" || !source.runtime.manualControl) {
      throw new Error("The active Zero Risk compaction source has no manual MCP tool boundary");
    }
    const outstanding = source.outstanding();
    const results = currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(
        `Codex supplied ${results.size} of ${outstanding.length} required tool results for Zero Risk compaction`,
      );
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      const interruptedQueued = await broker.requestCompaction(
        token,
        interruptedByZeroRiskCompaction(),
      );
      for (const [index, request] of outstanding.entries()) {
        const result = results.get(request.callId)!;
        const canonical = toolResult(result);
        await broker.completeTool(
          token,
          request.callId,
          interruptedQueued === 0 && index === outstanding.length - 1
            ? withZeroRiskCompactionInstruction(canonical)
            : canonical,
        );
        source.runtime.externalProgress.recordToolResult(request.callId);
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await withCompactionAbort(source.browserOutcome, signal);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      await withCompactionAbort(source.physicalSettlement, signal);
      const instructionDelivered = outstanding.length > 0
        || await broker.compactionDeliveryCount(token) > 0;
      if (!instructionDelivered) return undefined;
      const summary = browserOutcome.answer.trim();
      if (!summary) throw new Error("The active Zero Risk response returned an empty compaction summary");
      return summary;
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token) await broker.revoke(token);
    }
  });
}

export async function requestRetainedCompactionHandoff(
  worker: ChatGptBrowserWorker,
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  _broker: TurnBroker,
  capabilities: ChatGptWebCapabilities,
  traceId: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string> {
  const conversationKey = source.conversationKey();
  if (!conversationKey) throw new Error("The completed ChatGPT source has no retained conversation identity");
  const operationTimeoutMs = compactionHandoffTimeoutMs(parsed, timeoutMs);
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new Error(`ChatGPT compaction handoff timed out after ${operationTimeoutMs}ms`)),
    operationTimeoutMs,
  );
  deadlineTimer.unref?.();
  const operationSignal = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  const browserAbort = new AbortController();
  const abortBrowser = () => browserAbort.abort(operationSignal.reason);
  let browser: Promise<string> | undefined;
  if (operationSignal.aborted) abortBrowser();
  else operationSignal.addEventListener("abort", abortBrowser, { once: true });
  try {
    // Compaction is data transport. It does not need the arbitrary execution tool gateway.
    // Bind the fully settled public response to this exact retained agent and fresh checkpoint.
    // The old control API remains compatible, but no control token is issued to this response.
    if (operationSignal.aborted) throw abortReason(operationSignal);
    const checkpointId = `checkpoint_${randomBytes(16).toString("hex")}`;
    const instruction = textCompactionHandoffInstruction(checkpointId);
    const prepare = async () => ({ text: instruction, images: [], release: () => {} });
    browser = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
      // This summary response has no native tool environment or executable credentials.
      capabilities: { ...capabilities, localToolsEnabled: false },
      nativeConnector: false,
      prepare,
      prepareResume: prepare,
      conversationKey,
      requireRetainedConversation: true,
      abortSignal: browserAbort.signal,
      onTextDelta: () => {},
    });
    const answer = await withCompactionAbort(browser, operationSignal);
    if (operationSignal.aborted) throw abortReason(operationSignal);
    try {
      return parseTextCompactionHandoff(answer, checkpointId);
    } catch (cause) {
      throw new ChatGptWebAdapterError(
        "ChatGPT finished without a complete context checkpoint for this response. Check the original response; no continuation was accepted.",
        { status: 409, errorType: "invalid_request_error", code: "compaction_handoff_missing", retryable: false, cause },
      );
    }
  } finally {
    browserAbort.abort();
    if (browser) {
      // Logical cancellation is not physical retirement. The retained-session owner tracks
      // physical settlement separately, so this helper must not turn its own deadline into an
      // unbounded wait when the worker does not acknowledge abort immediately.
      await withCompactionAbort(
        browser.then(() => undefined, () => undefined),
        operationSignal,
      ).catch(() => {});
    }
    operationSignal.removeEventListener("abort", abortBrowser);
    clearTimeout(deadlineTimer);
  }
}

interface CachedCompactionRun {
  createdAt: number;
  ownerKey: string;
  traceIds: ReadonlySet<string>;
  nativeThreadId?: string;
  nativeTurnId?: string;
  abort: AbortController;
  active: boolean;
  promise: Promise<string>;
  settlement: Promise<void>;
}

interface StructuredCompactionInterruption {
  createdAt: number;
  reason: Error;
}

export interface StructuredCompactionOwner {
  ownerKey: string;
  /** Every externally addressable browser trace owned by this structured compaction. */
  traceIds: readonly string[];
  /** Exact native Codex owner, when supplied by the current Responses request. */
  nativeThreadId?: string;
  nativeTurnId?: string;
}

const structuredCompactionRuns = new Map<string, CachedCompactionRun>();
const structuredCompactionOwners = new Map<string, Promise<void>>();
const structuredCompactionInterruptions = new Map<string, StructuredCompactionInterruption>();
const STRUCTURED_COMPACTION_RUN_TTL_MS = 30 * 60_000;

/** Physical owners outlive timeout/cancellation delivery. No pruning or cancellation here. */
export function structuredCompactionMaintenanceState(): { pendingCompactions: number } {
  return {pendingCompactions: [...structuredCompactionRuns.values()].filter(run => run.active).length
    + structuredCompactionOwners.size};
}

function nativeTurnIdentityKey(threadId: string, turnId: string): string {
  if (!threadId.trim() || !turnId.trim()) {
    throw new Error("Structured compaction requires non-empty native thread and turn ids");
  }
  return JSON.stringify([threadId, turnId]);
}

function rememberStructuredCompactionInterruption(threadId: string, turnId: string, reason: Error): void {
  const identity = nativeTurnIdentityKey(threadId, turnId);
  const now = Date.now();
  pruneStructuredCompactionInterruptions(now);
  const existing = structuredCompactionInterruptions.get(identity);
  if (existing) {
    existing.createdAt = now;
    return;
  }
  structuredCompactionInterruptions.set(identity, { createdAt: now, reason });
}

function structuredCompactionInterruption(owner: StructuredCompactionOwner): Error | undefined {
  if (owner.nativeThreadId === undefined && owner.nativeTurnId === undefined) return undefined;
  pruneStructuredCompactionInterruptions();
  return structuredCompactionInterruptions.get(
    nativeTurnIdentityKey(owner.nativeThreadId ?? "", owner.nativeTurnId ?? ""),
  )?.reason;
}

function pruneStructuredCompactionInterruptions(now = Date.now()): void {
  const cutoff = now - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [identity, interruption] of structuredCompactionInterruptions) {
    if (interruption.createdAt < cutoff) structuredCompactionInterruptions.delete(identity);
  }
}

function pruneStructuredCompactionRuns(): void {
  const now = Date.now();
  const cutoff = now - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [candidate, run] of structuredCompactionRuns) {
    if (!run.active && run.createdAt < cutoff) structuredCompactionRuns.delete(candidate);
  }
  pruneStructuredCompactionInterruptions(now);
}

/** Return the canonical result of an exact compact request, even after its source was retired. */
export function existingStructuredCompactionRun(key: string): Promise<string> | undefined {
  pruneStructuredCompactionRuns();
  return structuredCompactionRuns.get(key)?.promise;
}

export function runStructuredCompactionOnce(
  key: string,
  owner: StructuredCompactionOwner,
  start: (operatorSignal: AbortSignal, retainOwnershipUntil: (settlement: Promise<void>) => void) => Promise<string>,
  replayOnly = false,
): Promise<string> {
  pruneStructuredCompactionRuns();
  const existing = structuredCompactionRuns.get(key);
  if (existing) return existing.promise;
  if (replayOnly) return Promise.reject(new Error("Canonical compaction round is no longer available; a replay cannot open another Web send"));
  const interrupted = structuredCompactionInterruption(owner);
  if (interrupted) return Promise.reject(interrupted);
  const abort = new AbortController();
  const previousOwner = structuredCompactionOwners.get(owner.ownerKey);
  const physicalSettlements: Promise<void>[] = previousOwner ? [previousOwner] : [];
  const promise = Promise.resolve().then(async () => {
    if (previousOwner) await withCompactionAbort(previousOwner, abort.signal);
    if (abort.signal.aborted) throw abortReason(abort.signal);
    return start(abort.signal, settlement => { physicalSettlements.push(settlement); });
  });
  // Return a deadline failure promptly, while its physical browser owner still blocks retries
  // and cancel-all completion. A cancelled queued run must also retain its predecessor's gate.
  const ownerSettlement = promise.then(() => false, () => true).then(async failed => {
    await Promise.allSettled(physicalSettlements);
    run.active = false;
    if (structuredCompactionOwners.get(owner.ownerKey) === ownerSettlement) {
      structuredCompactionOwners.delete(owner.ownerKey);
    }
    if (failed && structuredCompactionRuns.get(key) === run) structuredCompactionRuns.delete(key);
  });
  const run: CachedCompactionRun = {
    createdAt: Date.now(),
    ownerKey: owner.ownerKey,
    traceIds: new Set(owner.traceIds),
    ...(owner.nativeThreadId ? { nativeThreadId: owner.nativeThreadId } : {}),
    ...(owner.nativeTurnId ? { nativeTurnId: owner.nativeTurnId } : {}),
    abort,
    active: true,
    promise,
    settlement: ownerSettlement,
  };
  structuredCompactionRuns.set(key, run);
  structuredCompactionOwners.set(owner.ownerKey, ownerSettlement);
  return promise;
}

function beginCancelStructuredCompactionRuns(
  matches: (run: CachedCompactionRun) => boolean,
  reason: Error,
): { cancelled: number; settlement: Promise<void> } {
  const runs = [...structuredCompactionRuns.values()].filter(run => run.active && matches(run));
  for (const run of runs) {
    if (!run.abort.signal.aborted) run.abort.abort(reason);
  }
  return { cancelled: runs.length, settlement: Promise.allSettled(runs.map(run => run.settlement)).then(() => undefined) };
}

/** Begin cancelling the structured compaction owned by one exact native Codex turn. */
export function cancelStructuredCompactionNativeTurn(
  threadId: string,
  turnId: string,
  reason: Error,
): { cancelled: number; settlement: Promise<void> } {
  // Record before scanning active owners. Registration and cancellation share this synchronous
  // boundary, so either registration wins and is aborted below, or interruption wins and the later
  // registration rejects without invoking its detached work.
  rememberStructuredCompactionInterruption(threadId, turnId, reason);
  const runs = [...structuredCompactionRuns.values()].filter(run => (
    run.active
    && run.nativeThreadId === threadId
    && run.nativeTurnId === turnId
  ));
  for (const run of runs) {
    if (!run.abort.signal.aborted) run.abort.abort(reason);
  }
  return {
    cancelled: runs.length,
    settlement: Promise.allSettled(runs.map(run => run.settlement)).then(() => undefined),
  };
}

/** Cancel a user-requested compaction without treating an HTTP observer disconnect as terminal. */
export function beginCancelStructuredCompactionTrace(traceId: string, reason: Error): { cancelled: number; settlement: Promise<void> } {
  return beginCancelStructuredCompactionRuns(run => run.traceIds.has(traceId), reason);
}

export async function cancelStructuredCompactionTrace(traceId: string, reason: Error): Promise<number> {
  const cancellation = beginCancelStructuredCompactionTrace(traceId, reason);
  await cancellation.settlement;
  return cancellation.cancelled;
}

/** Cancel every active compaction owner and wait for its browser/helper cleanup. */
export async function cancelAllStructuredCompactions(reason: Error): Promise<number> {
  const cancellation = beginCancelStructuredCompactionRuns(() => true, reason);
  await cancellation.settlement;
  return cancellation.cancelled;
}
