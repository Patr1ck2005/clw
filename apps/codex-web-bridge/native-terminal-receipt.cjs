'use strict';

// Read-only proof that one exact Codex Session turn reached a native final.
// The returned record contains no model output or local Session path. It does
// not authorize a browser resend or substitute for a CLI execution receipt.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const {createSessionScan,sessionRevision}=require('./native-session-stream.cjs');
const WINDOW_SLOP_MS = 2000;

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function sessionDays(threadId) {
  const created = Number.parseInt(threadId.replaceAll('-', '').slice(0, 12), 16);
  if (!Number.isSafeInteger(created)) throw Error('native_receipt_identity_invalid');
  return [-1, 0, 1].map(offset => {
    const date = new Date(created + offset * 86400000);
    if (!Number.isFinite(date.getTime())) throw Error('native_receipt_identity_invalid');
    return [String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')];
  });
}

function exactSessionFile(threadId, sessionsRoot) {
  const matches = [];
  for (const parts of sessionDays(threadId)) {
    const directory = path.join(sessionsRoot, ...parts);
    let entries;
    try {
      entries = fs.readdirSync(directory, {withFileTypes: true});
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw Error('native_receipt_session_unreadable');
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${threadId}.jsonl`)) {
        matches.push(path.join(directory, entry.name));
      }
    }
  }
  if (matches.length !== 1) throw Error('native_receipt_session_not_unique');
  return matches[0];
}

function finalAnswerText(payload) {
  if (payload?.type !== 'message' || payload.role !== 'assistant' || payload.phase !== 'final_answer' || !Array.isArray(payload.content)) return null;
  const parts = payload.content.map(part => part?.type === 'output_text' && typeof part.text === 'string' ? part.text : null);
  if (!parts.length || parts.some(part => part === null)) throw Error('native_receipt_final_invalid');
  return parts.join('');
}

// Shared native result envelopes for ordinary success and compaction recovery.
// These describe the returned call; command settlement still requires the exact
// canonical CommandExecution item and, after a yield, its own session polling.
function nativeCommandHeader(output) {
  if (typeof output !== 'string') return null;
  const header = /^Chunk ID: [^\r\n]+\r?\nWall time: [^\r\n]+\r?\n(?:Process exited with code (-?\d+)|Process running with session ID (\d+))\r?\n/.exec(output);
  return header ? {terminal: header[1] !== undefined, exitCode: Number(header[1]), sessionId: header[2] || null} : null;
}
function nativeTruncatedCommandBodyMatches(body, original, originalTokenCount) {
  // Only the observed CLI middle-truncation envelope is compatible. The outer
  // native header must independently carry the same original token count.
  const warning = /^Warning: truncated output \(original token count: ([1-9]\d*)\)\nTotal output lines: ([1-9]\d*)\n\n/.exec(body);
  if (!warning || warning[1] !== originalTokenCount || !Number.isSafeInteger(Number(warning[1])) ||
      !Number.isSafeInteger(Number(warning[2]))) return false;
  let lines = original.endsWith('\n') ? 0 : 1;
  for (let offset = original.indexOf('\n'); offset !== -1; offset = original.indexOf('\n', offset + 1)) lines++;
  return lines === Number(warning[2]) && nativeMiddleTruncatedTextMatches(body.slice(warning[0].length), original);
}
function nativeMiddleTruncatedTextMatches(body, original) {
  const markers = /…([1-9]\d*) chars truncated…/g, marker = markers.exec(body);
  if (!marker || markers.exec(body) || !Number.isSafeInteger(Number(marker[1])) || marker.index <= 0) return false;
  const prefix = body.slice(0, marker.index), suffix = body.slice(marker.index + marker[0].length);
  const omittedEnd = original.length - suffix.length;
  if (!suffix || !original.startsWith(prefix) || !original.endsWith(suffix) || prefix.length >= omittedEnd ||
      original.codePointAt(prefix.length - 1) > 0xffff) return false;
  let omitted = 0;
  for (let offset = prefix.length; offset < omittedEnd; omitted++) {
    offset += original.codePointAt(offset) > 0xffff ? 2 : 1;
    if (offset > omittedEnd) return false;
  }
  return omitted === Number(marker[1]);
}
function nativePersistedCommandBodyMatches(body, original, originalTokenCount) {
  // The CLI also caps the canonical persisted output at exactly 64 KiB.
  // Its missing middle cannot supply an exact full-output comparison. Bind
  // both surviving fragments and the native terminal independently instead.
  const persistence = '\n... command output truncated for persistence ...\n';
  const parts = original.split(persistence);
  const warning = /^Warning: truncated output \(original token count: ([1-9]\d*)\)\nTotal output lines: ([1-9]\d*)\n\n/.exec(body);
  if (parts.length !== 2 ||
      parts.some(part => Buffer.byteLength(part) < 32740 || Buffer.byteLength(part) > 32743) ||
      !warning || warning[1] !== originalTokenCount ||
      !Number.isSafeInteger(Number(warning[1])) || !Number.isSafeInteger(Number(warning[2]))) return false;
  const text = body.slice(warning[0].length), markers = /…([1-9]\d*) chars truncated…/g, marker = markers.exec(text);
  if (!marker || markers.exec(text) || !Number.isSafeInteger(Number(marker[1]))) return false;
  const prefix = text.slice(0, marker.index), suffix = text.slice(marker.index + marker[0].length);
  if (!prefix || !suffix || !parts[0].startsWith(prefix) || !parts[1].endsWith(suffix)) return false;
  const retainedMiddle = [...parts[0].slice(prefix.length)].length + [...parts[1].slice(0, parts[1].length - suffix.length)].length;
  const retainedLines = parts.join('').split('\n').length - (original.endsWith('\n') ? 1 : 0);
  return Number(marker[1]) > retainedMiddle && Number(warning[2]) >= retainedLines;
}
function nativeTokenTruncatedCommandBodyMatches(body, original, originalTokenCount, maxOutputTokens) {
  const warning = /^Warning: truncated output \(original token count: ([1-9]\d*)\)\nTotal output lines: ([1-9]\d*)\n\n/.exec(body);
  if (!warning || warning[1] !== originalTokenCount || !Number.isSafeInteger(Number(warning[1])) ||
      !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) return false;
  const text = body.slice(warning[0].length), markers = /…([1-9]\d*) tokens truncated…/g, marker = markers.exec(text);
  if (!marker || markers.exec(text) || !Number.isSafeInteger(Number(marker[1])) ||
      Number(warning[1]) - Number(marker[1]) !== maxOutputTokens) return false;
  const prefix = text.slice(0, marker.index), suffix = text.slice(marker.index + marker[0].length);
  return !!prefix && !!suffix && original.startsWith(prefix) && original.endsWith(suffix) &&
    prefix.length + suffix.length < original.length && Number(warning[2]) === original.split('\n').length - (original.endsWith('\n') ? 1 : 0);
}
function nativeImageOutput(output) {
  return Array.isArray(output) && output.length > 0 && output.every(part => part?.type === 'input_image' &&
    typeof part.image_url === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url));
}

function nativeCommandCreationFailure(output, item) {
  if (item?.status !== 'failed' || item.exit_code !== -1 || item.process_id != null ||
      !item.aggregated_output.startsWith('Failed to create unified exec process: ') || typeof output !== 'string' ||
      !output.startsWith('exec_command failed: CreateProcess { message: ') || !output.endsWith(' }')) return false;
  try {
    const message = JSON.parse(output.slice('exec_command failed: CreateProcess { message: '.length, -2));
    return message.startsWith('Rejected(') && message.endsWith(')') &&
      JSON.parse(message.slice('Rejected('.length, -1)) === item.aggregated_output;
  } catch { return false; }
}

function verifyNativeTerminalReceipt({threadId, turnId, expectedFinalSha256, sessionsRoot, startedAt, endedAt} = {}) {
  if (!UUID_V7.test(threadId) || !UUID_V7.test(turnId) || threadId === turnId || !SHA256.test(expectedFinalSha256)) {
    throw Error('native_receipt_identity_invalid');
  }
  if ((startedAt === undefined) !== (endedAt === undefined)) throw Error('native_receipt_window_invalid');
  const windowVerified = startedAt !== undefined;
  const windowStart = windowVerified ? Date.parse(startedAt) : null;
  const windowEnd = windowVerified ? Date.parse(endedAt) : null;
  if (windowVerified && (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowStart > windowEnd)) {
    throw Error('native_receipt_window_invalid');
  }

  const root = sessionsRoot || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const file = exactSessionFile(threadId, root);
  const scan=createSessionScan(file);
  let metaCount = 0;
  let starts = 0;
  let completions = 0;
  let finalCount = 0;
  let activeTurn = false;
  let startedTime;
  let finalTime;
  let completedTime;
  let startLine;
  let finalLine;
  let completeLine;
  let finalHash;
  let completionHash;
  for (const line of scan) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw Error('native_receipt_session_unreadable');
    }
    if (row.type === 'session_meta') {
      if (++metaCount !== 1 || row.payload?.id !== threadId) throw Error('native_receipt_session_identity_mismatch');
      continue;
    }
    if (metaCount !== 1) throw Error('native_receipt_session_identity_mismatch');
    const event = row.type === 'event_msg' ? row.payload : null;
    if (event?.type === 'task_started') {
      if (activeTurn) throw Error('native_receipt_turn_overlap');
      if (event.turn_id === turnId) {
        starts++;
        activeTurn = true;
        startedTime = Date.parse(row.timestamp);
        startLine = line;
      }
    }
    if (activeTurn && row.type === 'response_item') {
      const text = finalAnswerText(row.payload);
      if (text !== null) {
        finalCount++;
        finalTime = Date.parse(row.timestamp);
        finalHash = sha256(text.trim());
        finalLine = line;
      }
    }
    if (activeTurn && event?.type === 'task_complete' && event.turn_id !== turnId) {
      throw Error('native_receipt_turn_overlap');
    }
    if (event?.type === 'task_complete' && event.turn_id === turnId) {
      if (!activeTurn) throw Error('native_receipt_turn_boundary_mismatch');
      completions++;
      activeTurn = false;
      completedTime = Date.parse(row.timestamp);
      completeLine = line;
      if (typeof event.last_agent_message !== 'string' || !event.last_agent_message.trim()) {
        throw Error('native_receipt_final_invalid');
      }
      completionHash = sha256(event.last_agent_message.trim());
    }
  }
  if (metaCount !== 1 || activeTurn || starts !== 1 || completions !== 1 || finalCount !== 1 ||
      !Number.isFinite(startedTime) || !Number.isFinite(finalTime) || !Number.isFinite(completedTime) ||
      startedTime > finalTime || finalTime > completedTime) throw Error('native_receipt_terminal_missing');
  const expected = expectedFinalSha256.toLowerCase();
  if (finalHash !== expected || completionHash !== expected) throw Error('native_receipt_final_mismatch');
  if (windowVerified && (startedTime < windowStart - WINDOW_SLOP_MS ||
      finalTime < windowStart - WINDOW_SLOP_MS || completedTime < windowStart - WINDOW_SLOP_MS ||
      startedTime > windowEnd + WINDOW_SLOP_MS || finalTime > windowEnd + WINDOW_SLOP_MS ||
      completedTime > windowEnd + WINDOW_SLOP_MS)) throw Error('native_receipt_window_mismatch');

  return {
    version: 1,
    threadId,
    turnId,
    status: 'completed',
    finalSha256: expected,
    receiptSha256: sha256(`CLW native terminal v1\0${startLine}\0${finalLine}\0${completeLine}`),
    windowVerified,
  };
}

// This narrow proof covers only this turn's tracked native tools. A command's
// terminal receipt does not prove that arbitrary shell code left no detached
// process or independent Workflow Job, and it never certifies task acceptance.
function verifyNativeCompletedToolsReceipt(input = {}) {
  return verifyNativeTrackedToolsReceipt(input);
}

// Tool settlement only. The caller must separately prove the original local
// executor has exited and its owned Workflow Jobs ended before withdrawing.
function verifyNativeStoppedToolsReceipt(input = {}) {
  return verifyNativeTrackedToolsReceipt(input, {stopped:true,startedAt:input.startedAt,endedAt:input.endedAt});
}

function verifyNativeTrackedToolsReceipt(input, failure) {
  const {threadId, turnId, sessionsRoot, startedAt, endedAt} = input;
  if (!UUID_V7.test(threadId) || !UUID_V7.test(turnId) || threadId === turnId) throw Error('native_receipt_identity_invalid');
  if (startedAt === undefined || endedAt === undefined) throw Error('native_work_receipt_window_required');
  const root = sessionsRoot || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const file = exactSessionFile(threadId, root), originalRevision=sessionRevision(file);
  const terminal = failure || verifyNativeTerminalReceipt(input);
  const scan=createSessionScan(file);
  if(scan.revision!==originalRevision)throw Error('native_receipt_session_changed');
  const calls = new Map(), completed = new Map(), outputs = new Set();
  const evidenceHash=crypto.createHash('sha256').update('CLW native tools terminal v1\0[');let evidenceCount=0;
  const evidence={push(line){if(evidenceCount++)evidenceHash.update(',');evidenceHash.update(JSON.stringify(line));}};
  const commandSessions = new Map(), commandResults = new Map();
  const checkpoints = [], checkpointIds = new Set();
  const tools = {exec_command: {invocations: 0, terminal: 0}, apply_patch: {invocations: 0, terminal: 0}};
  let active = false, starts = 0, ends = 0, lastAt = -Infinity, finalSeen = false, endedCurrentTurn = false, sessionCwd = null;
  let startLine, finalLine, endLine, uncollectedCommandOutputs = 0;
  const canonicalDirectory = value => {
    if (typeof value !== 'string' || !value) return null;
    if (value.startsWith('file:')) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'file:' || url.hostname && url.hostname !== 'localhost') return null;
        value = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
      } catch { return null; }
    }
    if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value)) return null;
    return value.replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
  };
  for (const line of scan) {
    const row = JSON.parse(line), payload = row.payload, event = row.type === 'event_msg' ? payload : null;
    if (row.type === 'session_meta') sessionCwd = canonicalDirectory(payload?.cwd);
    if (event?.type === 'task_started') {
      if (active) throw Error('native_receipt_turn_overlap');
      endedCurrentTurn = false;
      if (event.turn_id === turnId) { active = true; starts++; startLine = line; }
    }
    if (!active) {
      if (event?.type === 'item_completed' && event.turn_id === turnId && ['CommandExecution', 'FileChange', 'ImageView', 'McpToolCall'].includes(event.item?.type) ||
          endedCurrentTurn && row.type === 'response_item' && !['message', 'reasoning'].includes(payload?.type))
        throw Error('native_work_tool_outside_turn');
      continue;
    }
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at) || at < lastAt) throw Error('native_work_tool_window_invalid');
    lastAt = at;
    if (row.type === 'compacted' && (failure?.priorFinalSha256 || failure?.stopped) && !finalSeen) {
      const history = payload?.replacement_history;
      const summaries = Array.isArray(history) ? history.filter(item => item?.type === 'compaction') : [];
      if (!Array.isArray(history) || history.some(item => !['message', 'compaction'].includes(item?.type)) || summaries.length !== 1 ||
          typeof summaries[0].encrypted_content !== 'string' || !/^ocx1:[A-Za-z0-9+/]+={0,2}$/.test(summaries[0].encrypted_content))
        throw Error('native_work_checkpoint_invalid');
      const encoded = summaries[0].encrypted_content.slice(5), decoded = Buffer.from(encoded, 'base64');
      if (decoded.toString('base64') !== encoded || !new TextDecoder('utf-8', {fatal: true}).decode(decoded).trim())
        throw Error('native_work_checkpoint_invalid');
      checkpoints.push({at, completed: false}); evidence.push(line); continue;
    }
    if (!['event_msg', 'response_item', 'turn_context', 'world_state', 'token_usage_record'].includes(row.type))
      throw Error('native_work_event_requires_review');
    if (row.type === 'turn_context' && payload?.turn_id !== undefined && payload.turn_id !== turnId)
      throw Error('native_work_tool_identity_mismatch');
    if (event) {
      if (!['task_started', 'task_complete', 'token_count', 'item_completed', 'thread_settings_applied'].includes(event.type))
        throw Error('native_work_event_requires_review');
      // Current CLI versions persist configuration metadata within a turn.
      // Match the original thread/workspace; this never supplies tool completion.
      if (event.type === 'thread_settings_applied' && (event.thread_id !== threadId || !sessionCwd ||
          !event.thread_settings || typeof event.thread_settings !== 'object' || Array.isArray(event.thread_settings) ||
          canonicalDirectory(event.thread_settings.cwd) !== sessionCwd ||
          typeof event.thread_settings.model !== 'string' || !event.thread_settings.model.trim() ||
          typeof event.thread_settings.model_provider_id !== 'string' || !event.thread_settings.model_provider_id.trim()))
        throw Error('native_work_settings_invalid');
      if (event.type === 'item_completed') {
        const item = event.item;
        if (event.thread_id !== threadId || event.turn_id !== turnId) throw Error('native_work_tool_identity_mismatch');
        if (!item || !['UserMessage', 'AgentMessage', 'Reasoning', 'CommandExecution', 'FileChange', 'ImageView',
            ...(failure ? ['McpToolCall'] : []), ...(failure?.priorFinalSha256 || failure?.stopped ? ['ContextCompaction'] : [])].includes(item.type))
          throw Error('native_work_tool_requires_review');
        if (item.type === 'ContextCompaction') {
          const matching = checkpoints.filter(checkpoint => !checkpoint.completed && checkpoint.at >= event.started_at_ms && checkpoint.at <= event.completed_at_ms);
          if (finalSeen || !UUID_V7.test(item.id) || checkpointIds.has(item.id) || matching.length !== 1 ||
              !Number.isSafeInteger(event.started_at_ms) || !Number.isSafeInteger(event.completed_at_ms) ||
              event.started_at_ms < Date.parse(startedAt) || event.completed_at_ms < event.started_at_ms || event.completed_at_ms > at)
            throw Error('native_work_checkpoint_invalid');
          checkpointIds.add(item.id); matching[0].completed = true; evidence.push(line);
        }
        if (['CommandExecution', 'FileChange', 'ImageView', 'McpToolCall'].includes(item.type)) {
          const call = calls.get(item.id);
          if (finalSeen || !call || completed.has(item.id)) throw Error('native_work_tool_item_unmatched');
          if (!Number.isSafeInteger(event.started_at_ms) || !Number.isSafeInteger(event.completed_at_ms) ||
              event.started_at_ms < call.at || event.completed_at_ms < event.started_at_ms || event.completed_at_ms > at)
            throw Error('native_work_tool_window_invalid');
          if (call.name === 'exec_command') {
            if (item.type !== 'CommandExecution' || !['completed', 'failed'].includes(item.status) ||
                !Number.isSafeInteger(item.exit_code) || !(typeof item.process_id === 'string' && item.process_id ||
                  failure && item.status === 'failed' && item.exit_code === -1 && item.process_id == null) ||
                !Array.isArray(item.command) || !item.command.length || !item.command.every(part => typeof part === 'string') ||
                item.command.at(-1) !== call.arguments.cmd || !canonicalDirectory(item.cwd) ||
                call.arguments.workdir !== undefined && canonicalDirectory(item.cwd) !== canonicalDirectory(call.arguments.workdir) ||
                typeof item.aggregated_output !== 'string') throw Error('native_work_command_not_terminal');
          } else if (call.toolKey === 'mcp') {
            if (item.type !== 'McpToolCall' || !(item.status === 'completed' ||
                failure && item.status === 'failed' && item.result?.isError === true) || typeof item.server !== 'string' || !item.server ||
                typeof item.tool !== 'string' || !item.tool || ![item.tool, `mcp__${item.server}__${item.tool}`].includes(call.name) ||
                !require('node:util').isDeepStrictEqual(item.arguments, call.arguments) || typeof item.result?.isError !== 'boolean' ||
                !Array.isArray(item.result.content) || !item.result.content.length) throw Error('native_work_mcp_not_terminal');
          } else if (call.name === 'view_image') {
            if (item.type !== 'ImageView' || !canonicalDirectory(item.path) ||
                canonicalDirectory(item.path) !== canonicalDirectory(call.arguments.path)) throw Error('native_work_image_not_terminal');
          } else if (call.name !== 'apply_patch' || item.type !== 'FileChange' || item.status !== 'completed' || !item.changes ||
                     typeof item.changes !== 'object' || Array.isArray(item.changes) || !Object.keys(item.changes).length ||
                     typeof item.stdout !== 'string' || item.stderr !== '') throw Error('native_work_patch_not_terminal');
          completed.set(item.id, {item, at}); evidence.push(line);
        }
      }
      if (event.type === 'task_complete') {
        if (event.turn_id !== turnId || (failure ? !event.error || sha256(event.error.message || '') !== failure.failureSha256 : event.error))
          throw Error('native_work_terminal_mismatch');
        active = false; endedCurrentTurn = true; ends++; endLine = line;
      }
    }
    if (row.type !== 'response_item') continue;
    const kind = payload?.type;
    if (['function_call', 'custom_tool_call'].includes(kind)) {
      if (finalSeen || typeof payload.call_id !== 'string' || !payload.call_id || calls.has(payload.call_id) ||
          !(kind === 'function_call' && (['exec_command', 'write_stdin', 'view_image'].includes(payload.name) ||
              failure && typeof payload.name === 'string' && payload.name && payload.name !== 'apply_patch') ||
            kind === 'custom_tool_call' && payload.name === 'apply_patch'))
        throw Error('native_work_tool_requires_review');
      let args;
      if (['exec_command', 'write_stdin', 'view_image'].includes(payload.name)) {
        try { args = JSON.parse(payload.arguments); } catch { throw Error('native_work_command_invalid'); }
        if (!args || Array.isArray(args) || typeof args !== 'object') throw Error('native_work_command_invalid');
        if (payload.name === 'exec_command' && (typeof args.cmd !== 'string' || !args.cmd ||
            args.workdir !== undefined && typeof args.workdir !== 'string')) throw Error('native_work_command_invalid');
        if (payload.name === 'write_stdin' && (!Number.isSafeInteger(args.session_id) || args.session_id <= 0 ||
            args.chars !== undefined && typeof args.chars !== 'string')) throw Error('native_work_tool_requires_review');
        if (payload.name === 'view_image' && !canonicalDirectory(args.path)) throw Error('native_work_image_invalid');
        if (payload.name === 'write_stdin' && !commandSessions.has(String(args.session_id))) throw Error('native_work_command_session_unmatched');
      } else if (kind === 'function_call') {
        try { args = JSON.parse(payload.arguments); } catch { throw Error('native_work_mcp_invalid'); }
        if (!args || Array.isArray(args) || typeof args !== 'object') throw Error('native_work_mcp_invalid');
      } else if (typeof payload.input !== 'string' || !payload.input) throw Error('native_work_patch_invalid');
      const toolKey = ['exec_command', 'write_stdin', 'view_image', 'apply_patch'].includes(payload.name) ? payload.name : 'mcp';
      tools[toolKey] ||= {invocations: 0, terminal: 0};
      calls.set(payload.call_id, {name: payload.name, toolKey, kind, arguments: args, at}); tools[toolKey].invocations++; evidence.push(line);
    } else if (['function_call_output', 'custom_tool_call_output'].includes(kind)) {
      const call = calls.get(payload.call_id), receipt = completed.get(payload.call_id);
      if (finalSeen || !call || outputs.has(payload.call_id) ||
          !['exec_command', 'write_stdin'].includes(call.name) && (!receipt || receipt.at > at) ||
          kind !== (call.kind === 'function_call' ? 'function_call_output' : 'custom_tool_call_output'))
        throw Error('native_work_tool_output_unmatched');
      if (['exec_command', 'write_stdin'].includes(call.name)) {
        if (failure && call.name === 'exec_command' && receipt && receipt.at <= at && nativeCommandCreationFailure(payload.output, receipt.item)) {
          commandResults.set(payload.call_id, {body: receipt.item.aggregated_output, terminal: true, exitCode: -1, lastOutputAt: at});
          outputs.add(payload.call_id); tools[call.toolKey].terminal++; evidence.push(line);
          continue;
        }
        const header = nativeCommandHeader(payload.output);
        const body = typeof payload.output === 'string' && /^Chunk ID: [^\r\n]+\r?\nWall time: [^\r\n]+\r?\n(?:Process exited with code -?\d+|Process running with session ID \d+)\r?\n(?:Original token count: (\d+)\r?\n)?(?:Output|Final output):\r?\n([\s\S]*)$/.exec(payload.output);
        if (!header || !body) throw Error('native_work_tool_output_not_terminal');
        let commandId = payload.call_id;
        if (call.name === 'write_stdin') commandId = commandSessions.get(String(call.arguments.session_id));
        let result = commandResults.get(commandId);
        if (!result) { result = {body: '', terminal: false, exitCode: null, lastOutputAt: at}; commandResults.set(commandId, result); }
        if (result.terminal) throw Error('native_work_command_session_unmatched');
        if (!header.terminal) {
          if (call.name === 'exec_command') {
            if (commandSessions.has(header.sessionId)) throw Error('native_work_command_session_unmatched');
            commandSessions.set(header.sessionId, commandId); result.sessionId = header.sessionId;
          } else if (header.sessionId !== String(call.arguments.session_id)) throw Error('native_work_command_session_unmatched');
        }
        result.body += body[2]; result.originalTokenCount = body[1];
        result.terminal = header.terminal; result.exitCode = header.exitCode; result.lastOutputAt = at;
      } else if (call.toolKey === 'mcp') {
        if (!Array.isArray(payload.output) || payload.output.length < 1 || payload.output[0]?.type !== 'input_text' ||
            typeof payload.output[0].text !== 'string' || !/^Wall time: [^\r\n]+\r?\nOutput:$/.test(payload.output[0].text))
          throw Error('native_work_mcp_output_invalid');
        let parts = receipt.item.result.content.map(part => {
          if (part?.type === 'text' && typeof part.text === 'string') return {type: 'input_text', text: part.text};
          if (part?.type === 'image' && /^image\/(png|jpeg|webp)$/.test(part.mimeType) &&
              typeof part.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(part.data))
            return {type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data}`,
              ...(part._meta?.['codex/imageDetail'] ? {detail: part._meta['codex/imageDetail']} : {})};
          throw Error('native_work_mcp_result_requires_review');
        });
        const outputs = payload.output.slice(1);
        // Native MCP rendering omits empty text blocks. A nonempty canonical
        // result still requires its matching returned block.
        if (parts.length !== outputs.length) parts = parts.filter(part => part.type !== 'input_text' || part.text !== '');
        if (parts.length !== outputs.length || parts.some((part, n) => !require('node:util').isDeepStrictEqual(part, outputs[n]) &&
            !(part.type === 'input_text' && outputs[n]?.type === 'input_text' && Object.keys(outputs[n]).length === 2 &&
              typeof outputs[n].text === 'string' && nativeMiddleTruncatedTextMatches(outputs[n].text, part.text))))
          throw Error('native_work_mcp_output_mismatch');
      } else if (call.name === 'view_image') {
        if (!nativeImageOutput(payload.output)) throw Error('native_work_image_not_terminal');
      } else {
        const patch = typeof payload.output === 'string' && /^Exit code: (-?\d+)\r?\nWall time: [^\r\n]+\r?\nOutput:\r?\n([\s\S]*)$/.exec(payload.output);
        if (!patch || Number(patch[1]) !== 0 || patch[2] !== receipt.item.stdout) throw Error('native_work_tool_output_not_terminal');
      }
      outputs.add(payload.call_id); tools[call.toolKey].terminal++; evidence.push(line);
    } else if (['message', 'reasoning'].includes(kind)) {
      const final = finalAnswerText(payload);
      if (final !== null) {
        if (failure && !failure.stopped && (!failure.priorFinalSha256 || finalSeen || sha256(final.trim()) !== failure.priorFinalSha256))
          throw Error('native_failure_final_invalid');
        if (failure?.stopped && finalSeen) throw Error('native_failure_final_invalid');
        finalSeen = true; finalLine = line;
      }
    } else throw Error('native_work_tool_requires_review');
  }
  for (const [callId, call] of calls) {
    if (call.name === 'write_stdin') continue;
    const receipt = completed.get(callId);
    if (!receipt) throw Error('native_work_tools_incomplete');
    if (call.name === 'exec_command') {
      const result = commandResults.get(callId);
      if (failure && result?.sessionId && !result.terminal && result.sessionId === receipt.item.process_id && receipt.at >= result.lastOutputAt) {
        // The canonical native item may arrive after the last yielded reply.
        // It proves execution ended, not that the caller collected all output.
        uncollectedCommandOutputs++; continue;
      }
      if (!result?.terminal || result.exitCode !== receipt.item.exit_code ||
          result.body !== receipt.item.aggregated_output && (result.sessionId && !failure ||
            !nativeTruncatedCommandBodyMatches(result.body, receipt.item.aggregated_output, result.originalTokenCount) &&
            !(failure && (nativePersistedCommandBodyMatches(result.body, receipt.item.aggregated_output, result.originalTokenCount) ||
              nativeTokenTruncatedCommandBodyMatches(result.body, receipt.item.aggregated_output, result.originalTokenCount, call.arguments.max_output_tokens)))) ||
          result.sessionId && result.sessionId !== receipt.item.process_id || receipt.at > result.lastOutputAt)
        throw Error('native_work_tool_output_not_terminal');
    }
  }
  if ((failure?.stopped ? !active || ends !== 0 || !Number.isFinite(Date.parse(startedAt)) ||
        !Number.isFinite(Date.parse(endedAt)) || Date.parse(startLine && JSON.parse(startLine).timestamp) < Date.parse(startedAt) ||
        lastAt > Date.parse(endedAt) : active || ends !== 1 || (failure ? finalSeen !== !!failure.priorFinalSha256 : !finalSeen)) ||
      starts !== 1 || checkpoints.some(checkpoint => !checkpoint.completed) || calls.size !== outputs.size)
    throw Error('native_work_tools_incomplete');
  if (!failure?.stopped && (failure ? sha256(JSON.stringify(finalSeen ? [JSON.parse(startLine), JSON.parse(finalLine), JSON.parse(endLine)] :
      [JSON.parse(startLine), JSON.parse(endLine)])) :
      sha256(`CLW native terminal v1\0${startLine}\0${finalLine}\0${endLine}`)) !== terminal.receiptSha256)
    throw Error('native_work_terminal_mismatch');
  scan.assertUnchanged();
  const toolEventSha256 = evidenceHash.update(']').digest('hex');
  if (failure?.stopped) return {version:1,kind:'native_stopped_with_terminal_tools',threadId,turnId,
    receiptSha256:sha256(JSON.stringify([scan.sessionSha256,toolEventSha256,threadId,turnId,startedAt,endedAt])),
    toolEventSha256,sessionSha256:scan.sessionSha256,returnedTools:outputs.size,tools,
    originalNativeTerminal:false,taskAcceptance:'unverified',automaticReplay:false};
  return {version: 1, kind: failure?.cancelled ? 'native_cancelled_with_terminal_tools' : failure ? failure.priorFinalSha256 ? 'native_failed_with_terminal_tools' :
    'native_compaction_failed_with_terminal_tools' : 'native_completed_tools_terminal', threadId, turnId,
    ...(failure ? {startedAt: failure.startedAt, endedAt: failure.endedAt, failureSha256: failure.failureSha256,
      ...(failure.priorFinalSha256 ? {priorFinalSha256: failure.priorFinalSha256} : {}),
      nativeTurnState: 'failed', automaticReplay: false, uncollectedCommandOutputs} : {finalSha256: terminal.finalSha256}),
    receiptSha256: failure ? sha256(`CLW native failed tools terminal v1\0${terminal.receiptSha256}\0${toolEventSha256}`) : terminal.receiptSha256,
    toolEventSha256,
    sessionSha256: scan.sessionSha256, returnedTools: outputs.size, tools, executionScope: 'tracked_native_turn_tools',
    taskAcceptance: 'unverified', workflowJobAbsenceProven: false};
}

// Older failed turns did not write a CLW settlement receipt. Reconcile only the
// narrow, provable no-tool case from the exact native error terminal. A prior
// final is retained as evidence, never success when that turn then failed.
function verifyNativeFailureReceipt({threadId, turnId, sessionsRoot} = {}) {
  if (!UUID_V7.test(threadId) || !UUID_V7.test(turnId) || threadId === turnId) throw Error('native_receipt_identity_invalid');
  const root = sessionsRoot || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const file = exactSessionFile(threadId, root), scan=createSessionScan(file);
  let meta = 0, starts = 0, terminal = 0, active = false, start, end, priorFinal, priorFinalHash, lastAt = -Infinity;
  for (const line of scan) {
    const row = JSON.parse(line), event = row.type === 'event_msg' ? row.payload : null;
    if (row.type === 'session_meta') {
      if (++meta !== 1 || row.payload?.id !== threadId) throw Error('native_receipt_session_identity_mismatch');
      continue;
    }
    if (meta !== 1) throw Error('native_receipt_session_identity_mismatch');
    if (event?.type === 'task_started') {
      if (active) throw Error('native_receipt_turn_overlap');
      if (event.turn_id === turnId) { starts++; active = true; start = row; }
    }
    if (event?.type === 'task_complete' && event.turn_id === turnId && !active) throw Error('native_failure_terminal_missing');
    if (active) {
      const at = Date.parse(row.timestamp);
      if (!Number.isFinite(at) || at < lastAt) throw Error('native_failure_window_invalid');
      lastAt = at;
      if (row.type === 'turn_context' && row.payload?.turn_id !== undefined && row.payload.turn_id !== turnId)
        throw Error('native_receipt_turn_overlap');
      if (event?.type === 'turn_aborted') throw Error('native_failure_terminal_missing');
      if (event?.type === 'item_completed' && (event.thread_id !== threadId || event.turn_id !== turnId ||
          !['UserMessage', 'AgentMessage', 'Reasoning', 'Error'].includes(event.item?.type)))
        throw Error('native_failure_requires_tool_reconciliation');
    }
    if (active && row.type === 'response_item') {
      const p = row.payload;
      // Any action item (including future tool kinds) requires explicit review.
      if (!['message', 'reasoning', 'compaction'].includes(p?.type))
        throw Error('native_failure_requires_tool_reconciliation');
      const final = finalAnswerText(p);
      if (final !== null) {
        if (priorFinal || !final.trim()) throw Error('native_failure_final_invalid');
        priorFinal = row; priorFinalHash = sha256(final.trim());
      }
    }
    if (active && event?.type === 'task_complete') {
      if (event.turn_id !== turnId) throw Error('native_receipt_turn_overlap');
      if (!event.error || typeof event.error.message !== 'string' || !event.error.message.trim() || event.last_agent_message)
        throw Error('native_failure_terminal_missing');
      terminal++; active = false; end = row;
    }
  }
  if (active || starts !== 1 || terminal !== 1 || !Number.isFinite(Date.parse(start?.timestamp)) ||
      !Number.isFinite(Date.parse(end?.timestamp)) || Date.parse(end.timestamp) < Date.parse(start.timestamp))
    throw Error('native_failure_terminal_missing');
  scan.assertUnchanged();
  return {version: 1, threadId, turnId, kind: 'native_failed_without_tools',
    startedAt: start.timestamp, endedAt: end.timestamp,
    ...(priorFinal ? {priorFinalSha256: priorFinalHash} : {}),
    failureSha256: sha256(end.payload.error.message), sessionSha256: scan.sessionSha256,
    nativeTurnState: 'failed', taskAcceptance: 'unverified', automaticReplay: false,
    receiptSha256: sha256(JSON.stringify(priorFinal ? [start, priorFinal, end] : [start, end]))};
}

const displayCache = new Map();
const displayStatKey = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const DISPLAY_ANCHOR_BYTES = 4096, DISPLAY_PENDING_BYTES = 65536, DISPLAY_MAX_TURNS = 50000;
let displayTurns = 0;
function emptyDisplayParser() {
  return {starts:new Map(),invalid:new Set(),states:new Map(),meta:0,active:null,first:true,
    valid:true,incomplete:false,pending:null,unterminatedComplete:false,appendable:true};
}
function cloneDisplayParser(parser) {
  return {...parser,starts:new Map(parser.starts),invalid:new Set(parser.invalid),states:new Map(parser.states)};
}
function displayLine(parser, text, threadId, parsed) {
    if (!text) return;
    if (parser.first) { text = text.replace(/^\uFEFF/, ''); parser.first = false; }
    const row = parsed || JSON.parse(text), event = row.type === 'event_msg' ? row.payload : null;
    if (row.type === 'session_meta') {
      if (++parser.meta !== 1 || row.payload?.id !== threadId) parser.valid = false;
      return;
    }
    if (parser.meta !== 1) { parser.valid = false; return; }
    if (event?.type === 'task_started') {
      // An overlapping start invalidates the active turn. A different later
      // turn retains its own exact boundaries, as in the previous per-turn scan.
      if (parser.active !== null) { parser.invalid.add(parser.active); parser.states.delete(parser.active); }
      parser.active = typeof event.turn_id === 'string' ? event.turn_id : null;
      if (parser.active !== null) {
        parser.starts.set(parser.active, (parser.starts.get(parser.active) || 0) + 1);
        if (parser.starts.get(parser.active) !== 1) { parser.invalid.add(parser.active); parser.states.delete(parser.active); }
      }
    }
    if (parser.active !== null && ['task_complete', 'turn_aborted'].includes(event?.type)) {
      if (event.turn_id !== parser.active || !Number.isFinite(Date.parse(row.timestamp))) { parser.invalid.add(parser.active); parser.states.delete(parser.active); }
      else if (!parser.invalid.has(parser.active)) {
        const state = event.type === 'turn_aborted' ? 'aborted' : event.error ? 'failed' :
          typeof event.last_agent_message === 'string' && event.last_agent_message.trim() ? 'completed' : 'unavailable';
        parser.states.set(parser.active, {state, threadId, turnId: parser.active, endedAt: row.timestamp, source: 'native_session_terminal',
          ...(state === 'failed' ? {reason: /remote compact|compaction/i.test(event.error?.message || '') ? 'compaction_failed' : 'native_turn_failed'} : {})});
      }
      parser.active = null;
    }
}
function feedDisplay(parser, bytes, threadId) {
  if (parser.unterminatedComplete) {
    const newline = bytes.indexOf(10), prefix = bytes.subarray(0, newline < 0 ? bytes.length : newline).toString('utf8');
    if (!/^\s*$/.test(prefix)) return null;
    if (newline < 0) return parser;
    bytes = bytes.subarray(newline + 1); parser.unterminatedComplete = false;
  }
  const chunk = parser.pending ? Buffer.concat([parser.pending, bytes]) : bytes;
  parser.pending = null; parser.incomplete = false;
  let offset = 0, newline;
  while ((newline = chunk.indexOf(10, offset)) >= 0) {
    try { displayLine(parser, chunk.subarray(offset, newline).toString('utf8'), threadId); }
    catch { parser.valid = false; }
    offset = newline + 1;
    if (!parser.valid) { parser.appendable = false; return parser; }
  }
  const tail = chunk.subarray(offset);
  if (tail.length) {
    let row;
    try { row = JSON.parse(tail.toString('utf8').replace(parser.first ? /^\uFEFF/ : /$^/, '')); }
    catch { parser.incomplete = true; }
    if (!parser.incomplete) {
      try { displayLine(parser, tail.toString('utf8'), threadId, row); parser.unterminatedComplete = true; }
      catch { parser.valid = false; }
    } else if (tail.length <= DISPLAY_PENDING_BYTES) parser.pending = Buffer.from(tail);
    else parser.appendable = false;
  }
  return parser;
}
function displayValue(parser, turnId) {
  return {...(parser.valid && !parser.incomplete && parser.meta === 1 ? parser.states.get(turnId) : null) || {state:'unavailable'}};
}
function readDisplayBytes(fd, length, position) {
  const bytes = Buffer.allocUnsafe(length); let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, bytes, offset, length - offset, position + offset);
    if (!count) throw Error('native_display_changed'); offset += count;
  }
  return bytes;
}
const displayAnchor = bytes => sha256(bytes);
function appendedDisplay(file, before, cached, threadId) {
  if (!cached || cached.threadId !== threadId || !cached.parser.valid || !cached.parser.appendable || cached.stat.size <= DISPLAY_ANCHOR_BYTES * 2 ||
      before.dev !== cached.stat.dev || before.ino !== cached.stat.ino || before.size <= cached.stat.size) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    if (displayStatKey(fs.fstatSync(fd)) !== displayStatKey(before)) return null;
    const prefix = readDisplayBytes(fd, cached.prefixLength, 0), suffix = readDisplayBytes(fd, cached.suffixLength, cached.stat.size - cached.suffixLength);
    if (displayAnchor(prefix) !== cached.prefixHash || displayAnchor(suffix) !== cached.suffixHash) return null;
    const tail = readDisplayBytes(fd, before.size - cached.stat.size, cached.stat.size);
    if (displayStatKey(fs.fstatSync(fd)) !== displayStatKey(before)) return null;
    const parser = feedDisplay(cloneDisplayParser(cached.parser), tail, threadId); if (!parser) return null;
    const prefixLength = Math.min(before.size, DISPLAY_ANCHOR_BYTES), suffixLength = prefixLength;
    const newPrefix = prefix.length === prefixLength ? prefix : Buffer.concat([prefix, tail.subarray(0, prefixLength - prefix.length)]);
    const newSuffix = tail.length >= suffixLength ? tail.subarray(-suffixLength) : Buffer.concat([suffix.subarray(-(suffixLength - tail.length)), tail]);
    return {parser,prefixLength,suffixLength,prefixHash:displayAnchor(newPrefix),suffixHash:displayAnchor(newSuffix)};
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function removeDisplayCache(file) {
  const cached = displayCache.get(file); if (cached) { displayTurns -= cached.parser.starts.size; displayCache.delete(file); }
}
function saveDisplayCache(file, entry) {
  removeDisplayCache(file); const turns = entry.parser.starts.size;
  if (turns > DISPLAY_MAX_TURNS) return;
  while (displayCache.size >= 100 || displayTurns + turns > DISPLAY_MAX_TURNS) removeDisplayCache(displayCache.keys().next().value);
  displayCache.set(file, entry); displayTurns += turns;
}
// Status display shares the exact Session lookup, but grants no execution,
// resend or settlement authority. It returns metadata only, never transcript text.
function nativeTurnStateForDisplay({threadId, turnId, sessionsRoot} = {}) {
  if (!UUID_V7.test(threadId) || !UUID_V7.test(turnId) || threadId === turnId) return {state:'unavailable'};
  try {
    const root = sessionsRoot || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    const file = exactSessionFile(threadId, root), before = fs.statSync(file);
    if (!before.isFile() || before.size < 1) { removeDisplayCache(file); return {state:'unavailable'}; }
    const key = [threadId, displayStatKey(before)].join(':');
    const cached = displayCache.get(file);
    if (cached?.key === key) { displayCache.delete(file); displayCache.set(file,cached); return displayValue(cached.parser,turnId); }
    let projection = appendedDisplay(file,before,cached,threadId);
    if (!projection) {
      const parser=emptyDisplayParser(),scan=createSessionScan(file);
      for(const line of scan){try{displayLine(parser,line,threadId);}catch{parser.valid=false;}}
      const length=Math.min(before.size,DISPLAY_ANCHOR_BYTES),fd=fs.openSync(file,'r');
      let prefix,suffix;try{prefix=readDisplayBytes(fd,length,0);suffix=readDisplayBytes(fd,length,before.size-length);}finally{fs.closeSync(fd);}
      projection={parser,prefixLength:length,suffixLength:length,prefixHash:displayAnchor(prefix),suffixHash:displayAnchor(suffix)};
    }
    if (displayStatKey(before) !== displayStatKey(fs.statSync(file))) return {state:'unavailable'};
    // Display follows the owned append-only JSONL with small head/tail anchors.
    // Replacement, truncation, rewritten anchors and same-size edits rebuild it.
    // Complete terminal/settlement proofs above always perform their full scan.
    saveDisplayCache(file,{key,threadId,stat:before,...projection});
    return displayValue(projection.parser,turnId);
  } catch { return {state:'unavailable'}; }
}

// Compaction can end a native turn after earlier synchronous tools returned.
// This proves their terminal envelopes, never their success or the task's acceptance.
function verifyNativeCompactionFailureReceipt({threadId, turnId, sessionsRoot, expectedCheckpointSha256, expectedCancellationFailureSha256} = {}) {
  if (!UUID_V7.test(threadId) || !UUID_V7.test(turnId) || threadId === turnId) throw Error('native_receipt_identity_invalid');
  if (expectedCheckpointSha256 !== undefined && !SHA256.test(expectedCheckpointSha256)) throw Error('native_receipt_identity_invalid');
  if (expectedCancellationFailureSha256 !== undefined && !SHA256.test(expectedCancellationFailureSha256)) throw Error('native_receipt_identity_invalid');
  const root = sessionsRoot || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const file = exactSessionFile(threadId, root), scan=createSessionScan(file);
  if (!expectedCheckpointSha256) {
    let meta = 0, starts = 0, active = false, start, end, priorFinal, priorFinalHash;
    for (const line of scan) {
      const row = JSON.parse(line), event = row.type === 'event_msg' ? row.payload : null;
      if (row.type === 'session_meta') {
        if (++meta !== 1 || row.payload?.id !== threadId) throw Error('native_receipt_session_identity_mismatch');
        continue;
      }
      if (meta !== 1) throw Error('native_receipt_session_identity_mismatch');
      if (event?.type === 'task_started') {
        if (active) throw Error('native_receipt_turn_overlap');
        if (event.turn_id === turnId) { starts++; active = true; start = row; }
      }
      if (event?.type === 'task_complete' && event.turn_id === turnId && !active) throw Error('native_compaction_failure_terminal_missing');
      if (!active) continue;
      if (row.type === 'response_item') {
        const final = finalAnswerText(row.payload);
        if (final !== null) {
          if (priorFinal || !final.trim()) throw Error('native_failure_final_invalid');
          priorFinal = row; priorFinalHash = sha256(final.trim());
        }
      }
      if (event?.type === 'turn_aborted') throw Error('native_compaction_failure_stopped');
      if (event?.type === 'task_complete') {
        if (event.turn_id !== turnId || event.last_agent_message || typeof event.error?.message !== 'string' ||
            !event.error.message.trim() || (expectedCancellationFailureSha256 ? sha256(event.error.message)!==expectedCancellationFailureSha256 :
              !priorFinal && !/^Error running remote compact task:/.test(event.error.message)))
          throw Error('native_compaction_failure_terminal_missing');
        active = false; end = row;
      }
    }
    if (meta !== 1 || active || starts !== 1 || !end || !Number.isFinite(Date.parse(start?.timestamp)) ||
        !Number.isFinite(Date.parse(end.timestamp)) || Date.parse(end.timestamp) < Date.parse(start.timestamp))
      throw Error('native_compaction_failure_terminal_missing');
    scan.assertUnchanged();
    const proof = verifyNativeTrackedToolsReceipt({threadId, turnId, sessionsRoot, startedAt: start.timestamp, endedAt: end.timestamp},
      {startedAt: start.timestamp, endedAt: end.timestamp, failureSha256: sha256(end.payload.error.message),cancelled:!!expectedCancellationFailureSha256,
        ...(priorFinal ? {priorFinalSha256: priorFinalHash} : {}),
        receiptSha256: sha256(JSON.stringify(priorFinal ? [start, priorFinal, end] : [start, end]))});
    if (proof.sessionSha256 !== scan.sessionSha256) throw Error('native_receipt_session_changed');
    return proof;
  }
  let meta = 0, starts = 0, terminal = 0, active = false, start, end;
  const calls = new Map(), returned = new Set(), evidence = [];
  const nativeItems = new Map(), yieldedCommands = new Map(), imageCalls = new Set();
  const mcpCalls = new Map(), mcpOutputs = new Map();
  let lastAt = -Infinity, checkpoints = 0;
  for (const line of scan) {
    const row = JSON.parse(line), event = row.type === 'event_msg' ? row.payload : null;
    if (row.type === 'session_meta') {
      if (++meta !== 1 || row.payload?.id !== threadId) throw Error('native_receipt_session_identity_mismatch');
      continue;
    }
    if (meta !== 1) throw Error('native_receipt_session_identity_mismatch');
    if (event?.type === 'task_started') {
      if (active) throw Error('native_receipt_turn_overlap');
      if (event.turn_id === turnId) {starts++; active = true; start = row;}
    }
    if (!active) continue;
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at) || at < Date.parse(start.timestamp) || at < lastAt) throw Error('native_receipt_window_invalid');
    lastAt = at;
    if (expectedCheckpointSha256 && event?.type === 'item_completed' &&
        ['CommandExecution', 'ImageView', 'McpToolCall'].includes(event.item?.type)) {
      const item = event.item;
      if (event.thread_id !== threadId || event.turn_id !== turnId || typeof item.id !== 'string' || nativeItems.has(item.id) ||
          !Number.isSafeInteger(event.started_at_ms) || !Number.isSafeInteger(event.completed_at_ms) ||
          event.started_at_ms < Date.parse(start.timestamp) || event.completed_at_ms < event.started_at_ms ||
          event.completed_at_ms > at) throw Error('native_checkpoint_tool_receipt_invalid');
      nativeItems.set(item.id, item); evidence.push(line);
    }
    if (expectedCheckpointSha256 && row.type === 'compacted') {
      const items = row.payload?.replacement_history?.filter(p => p?.type === 'compaction');
      if (items?.length !== 1 || typeof items[0].encrypted_content !== 'string'
        || !/^ocx1:[A-Za-z0-9+/]+={0,2}$/.test(items[0].encrypted_content)) throw Error('native_checkpoint_invalid');
      const summary = Buffer.from(items[0].encrypted_content.slice(5), 'base64').toString('utf8');
      if (sha256(summary.trim()) !== expectedCheckpointSha256.toLowerCase()) throw Error('native_checkpoint_mismatch');
      checkpoints++; evidence.push(line);
    }
    if (row.type === 'response_item') {
      const p = row.payload;
      if (finalAnswerText(p) !== null) throw Error('native_compaction_failure_has_final');
      if (['function_call', 'custom_tool_call'].includes(p?.type)) {
        if (typeof p.call_id !== 'string' || calls.has(p.call_id) ||
            !(p.type === 'function_call' && (p.name === 'exec_command' || expectedCheckpointSha256 && typeof p.name === 'string') ||
              p.type === 'custom_tool_call' && p.name === 'apply_patch'))
          throw Error('native_compaction_tool_requires_review');
        if (expectedCheckpointSha256 && p.type === 'function_call' && !['exec_command', 'write_stdin', 'view_image'].includes(p.name)) {
          if (typeof p.arguments !== 'string') throw Error('native_checkpoint_mcp_call_invalid');
          mcpCalls.set(p.call_id, {name: p.name, arguments: JSON.parse(p.arguments)});
        }
        calls.set(p.call_id, p.name); evidence.push(line);
      } else if (['function_call_output', 'custom_tool_call_output'].includes(p?.type)) {
        const name = calls.get(p.call_id), output = p.output;
        if (!name || returned.has(p.call_id) || (name !== 'view_image' && !mcpCalls.has(p.call_id) && typeof output !== 'string') ||
            (name === 'apply_patch' ? p.type !== 'custom_tool_call_output' : p.type !== 'function_call_output')) throw Error('native_compaction_tool_output_unmatched');
        // Match only the native result header; echoed file content cannot prove settlement.
        const commandHeader = nativeCommandHeader(output), command = commandHeader?.terminal === true;
        const patch = typeof output === 'string' && /^Exit code: -?\d+\r?\nWall time: [^\r\n]+\r?\nOutput:\r?\n/.test(output);
        const yielded = name === 'exec_command' && expectedCheckpointSha256 ? commandHeader?.sessionId : null;
        if (mcpCalls.has(p.call_id)) {
          if (!Array.isArray(output) || output.length < 2 || output[0]?.type !== 'input_text' ||
              typeof output[0].text !== 'string' || !/^Wall time: [^\r\n]+\r?\nOutput:$/.test(output[0].text))
            throw Error('native_checkpoint_mcp_output_invalid');
          mcpOutputs.set(p.call_id, output.slice(1));
        } else if (yielded) yieldedCommands.set(p.call_id, yielded);
        else if (name === 'view_image' && expectedCheckpointSha256) {
          if (!nativeImageOutput(output))
            throw Error('native_checkpoint_image_not_terminal');
          imageCalls.add(p.call_id);
        } else if (['exec_command', 'write_stdin'].includes(name) ? !command : !patch) throw Error('native_compaction_tool_not_terminal');
        returned.add(p.call_id); evidence.push(line);
      } else if (expectedCheckpointSha256 && p?.type === 'tool_search_call') {
        if (typeof p.call_id !== 'string' || calls.has(p.call_id) || p.status !== 'completed' || p.execution !== 'client')
          throw Error('native_checkpoint_search_invalid');
        calls.set(p.call_id, 'tool_search'); evidence.push(line);
      } else if (expectedCheckpointSha256 && p?.type === 'tool_search_output') {
        if (calls.get(p.call_id) !== 'tool_search' || returned.has(p.call_id) || p.status !== 'completed' ||
            p.execution !== 'client' || !Array.isArray(p.tools)) throw Error('native_checkpoint_search_unmatched');
        returned.add(p.call_id); evidence.push(line);
      } else if (!['message', 'reasoning', 'compaction'].includes(p?.type)) throw Error('native_compaction_tool_requires_review');
    }
    if (event?.type === 'task_complete') {
      if (event.turn_id !== turnId || event.last_agent_message ||
          typeof event.error?.message !== 'string' || !event.error.message
          || (expectedCheckpointSha256 ? checkpoints !== 1 : !/^Error running remote compact task:/.test(event.error.message))) throw Error('native_compaction_failure_terminal_missing');
      terminal++; active = false; end = row;
    } else if (event?.type === 'turn_aborted') throw Error('native_compaction_failure_stopped');
  }
  if (active || starts !== 1 || terminal !== 1 || calls.size !== returned.size || !end ||
      Date.parse(end.timestamp) < Date.parse(start.timestamp)) throw Error('native_compaction_failure_terminal_missing');
  if (expectedCheckpointSha256 && checkpoints !== 1) throw Error('native_checkpoint_missing');
  for (const [callId, sessionId] of yieldedCommands) {
    const item = nativeItems.get(callId);
    if (item?.type !== 'CommandExecution' || item.process_id !== sessionId ||
        !['completed', 'failed'].includes(item.status) || !Number.isSafeInteger(item.exit_code))
      throw Error('native_checkpoint_command_still_running');
  }
  for (const callId of imageCalls) if (nativeItems.get(callId)?.type !== 'ImageView') throw Error('native_checkpoint_image_receipt_missing');
  for (const [callId, call] of mcpCalls) {
    const item = nativeItems.get(callId);
    if (item?.type !== 'McpToolCall' || item.status !== 'completed' || typeof item.server !== 'string' || !item.server ||
        typeof item.tool !== 'string' || !item.tool || ![item.tool, `mcp__${item.server}__${item.tool}`].includes(call.name) ||
        !require('node:util').isDeepStrictEqual(item.arguments, call.arguments) || typeof item.result?.isError !== 'boolean' ||
        !Array.isArray(item.result.content) || !item.result.content.length) throw Error('native_checkpoint_mcp_receipt_missing');
    const parts = item.result.content.map(part => {
      if (part?.type === 'text' && typeof part.text === 'string') return {type: 'input_text', text: part.text};
      if (part?.type === 'image' && /^image\/(png|jpeg|webp)$/.test(part.mimeType) &&
          typeof part.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(part.data))
        return {type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data}`,
          ...(part._meta?.['codex/imageDetail'] ? {detail: part._meta['codex/imageDetail']} : {})};
      throw Error('native_checkpoint_mcp_result_requires_review');
    });
    if (!require('node:util').isDeepStrictEqual(parts, mcpOutputs.get(callId))) throw Error('native_checkpoint_mcp_output_mismatch');
  }
  for (const [callId, item] of nativeItems) {
    if (item.type === 'McpToolCall' ? !mcpCalls.has(callId) : calls.get(callId) !== (item.type === 'CommandExecution' ? 'exec_command' : 'view_image'))
      throw Error('native_checkpoint_tool_receipt_unmatched');
  }
  return {version: 1, threadId, turnId, kind: expectedCheckpointSha256 ? 'native_failed_after_matching_checkpoint' : 'native_compaction_failed_with_terminal_tools',
    startedAt: start.timestamp, endedAt: end.timestamp, returnedTools: returned.size,
    ...(expectedCheckpointSha256 ? {failureSha256: sha256(end.payload.error.message)} : {}),
    receiptSha256: sha256(JSON.stringify([start, evidence, end]))};
}

module.exports = {verifyNativeTerminalReceipt, verifyNativeCompletedToolsReceipt, verifyNativeStoppedToolsReceipt, verifyNativeFailureReceipt, verifyNativeCompactionFailureReceipt, nativeTurnStateForDisplay};
