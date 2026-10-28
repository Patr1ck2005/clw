import { createHash } from "node:crypto";
import { SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";

// Observation of successfully completed sends only. Preparing a prompt cannot
// acknowledge it; failed/unknown sends retain canonical context on retry.
const retainedSystems = new Map<string, readonly string[]>();
const systemBytes = (system: readonly string[]) => Buffer.byteLength(JSON.stringify(system));
export function retainedSystemContext(key: string): readonly string[] | undefined {
  return retainedSystems.get(key);
}
export function rememberRetainedSystemContext(key: string, parsed: CodexParsedRequest): void {
  retainedSystems.delete(key);
  const system = [...(parsed.context.systemPrompt ?? [])];
  if (systemBytes(system) > 2 * 1024 * 1024) return;
  retainedSystems.set(key, system);
  while (retainedSystems.size > 64 || [...retainedSystems.values()].reduce((sum, value) => sum + systemBytes(value), 0) > 8 * 1024 * 1024) {
    retainedSystems.delete(retainedSystems.keys().next().value!);
  }
}
export function forgetRetainedSystemContext(key: string): void {
  retainedSystems.delete(key);
}

function messageText(item: Record<string, unknown>): string | undefined {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap(block => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

/** Native compaction remains part of the exact identity of a replayed Codex turn. */
function compactionEpoch(input: unknown[] | undefined): unknown {
  return input?.findLast(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return record.type === "compaction"
      || record.type === "compaction_summary"
      || record.type === "context_compaction"
      || (record.role === "user" && messageText(record)?.startsWith(`${SUMMARY_PREFIX}\n`));
  }) ?? null;
}

export function chatGptConversationKey(
  parsed: CodexParsedRequest,
  namespace: string,
): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  const raw = parsed._rawBody as { input?: unknown[] } | undefined;
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
    compaction: compactionEpoch(raw?.input),
  })).digest("hex");
}

/** Full history remains canonical; a retained epoch receives only the suffix after its last assistant reply. */
export function retainedConversationResumeRequest(
  parsed: CodexParsedRequest,
  previousSystem?: readonly string[],
): CodexParsedRequest | undefined {
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === "assistant");
  if (lastAssistant < 0 || lastAssistant === parsed.context.messages.length - 1) return undefined;
  return {
    ...parsed,
    context: {
      ...parsed.context,
      ...(previousSystem !== undefined ? {
        systemPrompt: JSON.stringify(previousSystem) === JSON.stringify(parsed.context.systemPrompt ?? [])
          ? []
          : ["Updated operational context replaces the earlier supplied system context:", ...(parsed.context.systemPrompt ?? [])],
      } : {}),
      messages: parsed.context.messages.slice(lastAssistant + 1),
    },
  };
}
