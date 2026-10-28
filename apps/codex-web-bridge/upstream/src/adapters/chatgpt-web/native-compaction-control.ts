import { COMPACT_PROMPT } from "../../responses/compaction";
import type { CompactionTransactionHandle } from "./compaction-transaction";

export const CODEX_COMPACTION_CONTROL_WIRE_NAME = "codex.control.compaction_handoff";
export const CODEX_ACTIVE_COMPACTION_REQUEST_MARKER = "CODEX_ACTIVE_COMPACTION_REQUEST";

const CHECKPOINT_ID = /^checkpoint_[a-f0-9]{32}$/;
const CHECKPOINT_BEGIN = "CODEX_CHECKPOINT_BEGIN";
const CHECKPOINT_END = "CODEX_CHECKPOINT_END";

/** A public response binding, not an execution capability or a tool credential. */
export function textCompactionHandoffInstruction(checkpointId: string): string {
  if (!CHECKPOINT_ID.test(checkpointId)) throw new Error("Invalid text checkpoint identity");
  return [
    "Automatic Codex context compaction has started. Stop ordinary task work.",
    "This response only returns a context summary as ordinary assistant text. Do not call any tools, use previous tool credentials, execute commands, or change files.",
    COMPACT_PROMPT,
    "Preserve actual errors, rejected operations, user stops, unfinished work, and their original scope. Do not claim that unfinished or rejected work succeeded.",
    "The local client will read only this response after it has completely ended and validate the response identity below. The identity is not a tool token.",
    "Return exactly the following plain-text envelope, replacing the placeholder with the complete summary. Do not add any text outside it:",
    `${CHECKPOINT_BEGIN} ${checkpointId}`,
    "<complete checkpoint summary>",
    `${CHECKPOINT_END} ${checkpointId}`,
  ].join("\n");
}

/** Ordinary replies, partial streams and other checkpoint identities are never accepted. */
export function parseTextCompactionHandoff(answer: string, checkpointId: string): string {
  if (!CHECKPOINT_ID.test(checkpointId)) throw new Error("Invalid text checkpoint identity");
  let normalized = answer.replace(/\r\n?/g, "\n").trim();
  const fenced = normalized.match(/^```(?:text|plaintext)?\n([\s\S]*)\n```$/);
  if (fenced) normalized = fenced[1]!.trim();
  // The established DOM-to-Markdown serializer escapes literal underscores in paragraphs.
  // Decode only the two envelope lines; never rewrite the checkpoint's actual body or data.
  const lines = normalized.split("\n");
  if (lines.length >= 2) {
    lines[0] = lines[0]!.replace(/\\_/g, "_").trim();
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(/\\_/g, "_").trim();
    normalized = lines.join("\n");
  }
  const begin = `${CHECKPOINT_BEGIN} ${checkpointId}\n`;
  const end = `\n${CHECKPOINT_END} ${checkpointId}`;
  if (normalized.length > 1_000_000 || !normalized.startsWith(begin) || !normalized.endsWith(end)) {
    throw new Error("The completed response has no exact text checkpoint envelope");
  }
  const summary = normalized.slice(begin.length, -end.length).trim();
  if (!summary || summary === "<complete checkpoint summary>"
    || summary.includes(CHECKPOINT_BEGIN) || summary.includes(CHECKPOINT_END)) {
    throw new Error("The text checkpoint is empty, duplicated, or incomplete");
  }
  return summary;
}

function compactionControlBinding(transaction: CompactionTransactionHandle): string[] {
  return [
    "Submit the summary to the pending Codex task through the attached Codex Native plugin using codex_tool_call with the binding below.",
    "The reserved codex.control.compaction_handoff operation stores this summary for task continuation. It does not run commands, read or edit files, or invoke other tools, and it is not listed by tool inventory.",
    "This one-shot control token is valid only for the reserved compaction operation; do not use it with codex_exec, codex_tool_inventory, or any outer Codex tool.",
    "<codex_compaction_control>",
    `turn_token ${transaction.token}`,
    `wire_name ${CODEX_COMPACTION_CONTROL_WIRE_NAME}`,
    `handoff_id ${transaction.handoffId}`,
    "</codex_compaction_control>",
    `Call codex_tool_call exactly once with ${JSON.stringify({
      turn_token: transaction.token,
      wire_name: CODEX_COMPACTION_CONTROL_WIRE_NAME,
      arguments: {
        handoff_id: transaction.handoffId,
        summary: "<complete checkpoint summary>",
      },
    })}.`,
  ];
}

/**
 * Stop an active browser response only if it asks for another tool after Codex requested
 * compaction. Results for calls already handed to Codex remain byte-for-byte canonical: when they
 * are enough to finish the task, that ordinary final answer remains publishable. A later tool call
 * is intercepted before execution and receives this instruction; the retained conversation then
 * receives the sole structured checkpoint request on a clean message boundary.
 */
export function activeCompactionToolResultInstruction(): string {
  return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    "Codex reached its context limit before this newly requested tool could be sent for execution. The tool was not executed.",
    "Stop ordinary task work now, call no more tools, and end this Web response normally.",
    "Do not create or submit a checkpoint in this response. After it settles, the retained conversation will receive exactly one separate structured compaction handoff request.",
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
}

/**
 * Zero Risk cannot submit a second browser message automatically. When Codex compacts at an
 * already-visible native tool boundary, the same manually submitted response returns the
 * checkpoint through the same Zero Risk request instead.
 */
export function zeroRiskActiveCompactionToolResultInstruction(toolExecuted: boolean): string {
  return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    toolExecuted
      ? "Codex reached its context limit while this Web response was waiting for the tool result above."
      : "Codex reached its context limit before the requested tool could be sent for execution. The tool was not executed.",
    toolExecuted
      ? "Consume that canonical result, stop ordinary task work now, and do not call any more work tools."
      : "Stop ordinary task work now and do not call any more work tools.",
    COMPACT_PROMPT,
    "Call no more work tools. Return only the complete checkpoint summary to Codex with codex_turn_complete.",
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
}

export function structuredCompactionHandoffInstruction(
  transaction: CompactionTransactionHandle,
): string {
  return [
    "Automatic Codex context compaction has started. Stop ordinary task work and do not call any more work tools.",
    COMPACT_PROMPT,
    ...compactionControlBinding(transaction),
    "After the control call returns submitted=true, call no more tools. The bridge will close this one-purpose Web response after accepting the checkpoint.",
    "If the call is rejected or fails, stop and report its actual error. Do not retry through another tool or claim the summary was submitted without submitted=true.",
  ].join("\n");
}
