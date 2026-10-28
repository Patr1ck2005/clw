'use strict';

// Canonical, low-frequency action reads. A batch belongs to one operation:
// it streams each owned Session once and retains only parsed metadata.
// It never consumes display receipts, reuses another batch, or grants release.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {cleanSource} = require('./turn-source.cjs');
const {createSessionScan} = require('./native-session-stream.cjs');

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = value => typeof value === 'string' && UUID_V7.test(value);
const RECORD_TYPES = new Set(['session_meta', 'event_msg', 'response_item', 'turn_context',
  'compacted', 'world_state', 'token_usage_record']);
const EVENT_TYPES = new Set(['task_started', 'task_complete', 'turn_aborted', 'token_count',
  'item_completed', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content',
  'user_message', 'context_compacted', 'warning', 'error', 'thread_settings_applied']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const boundary = {workflowJobAbsenceProven: false, taskAcceptance: 'unverified', claimReleaseAuthorized: false};

class ReadFault extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireValue(condition, code) {
  if (!condition) throw new ReadFault(code);
}
function cwdIdentity(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  if (/^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)) {
    return 'win:' + path.win32.normalize(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  }
  if (value.startsWith('/')) return 'posix:' + path.posix.normalize(value).replace(/\/$/, '');
  return null;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const [year, month, day, hour, minute, second] = value.match(/^\d+|\d+/g).slice(0, 6).map(Number);
  const calendar = new Date(0); calendar.setUTCFullYear(year, month, 0);
  if (month < 1 || month > 12 || day < 1 || day > calendar.getUTCDate() || hour > 23 || minute > 59 || second > 59) return NaN;
  return Date.parse(value);
}
function exactSession(threadId, root) {
  const created = Number.parseInt(threadId.replaceAll('-', '').slice(0, 12), 16);
  const files = [];
  for (const offset of [-1, 0, 1]) {
    const at = new Date(created + offset * 86400000);
    requireValue(Number.isFinite(at.getTime()), 'native_action_identity_invalid');
    const directory = path.join(root, String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, '0'), String(at.getUTCDate()).padStart(2, '0'));
    let entries;
    try {
      requireValue(fs.lstatSync(directory).isDirectory(), 'native_action_session_unreadable');
      entries = fs.readdirSync(directory, {withFileTypes: true});
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith(`-${threadId}.jsonl`)) continue;
      requireValue(entry.isFile(), 'native_action_session_unreadable');
      files.push(path.join(directory, entry.name));
    }
  }
  requireValue(files.length === 1, 'native_action_session_not_unique');
  return files[0];
}
function finalHash(payload) {
  if (payload.type !== 'message' || payload.role !== 'assistant' || payload.phase !== 'final_answer') return null;
  requireValue(Array.isArray(payload.content) && payload.content.length > 0 && payload.content.every(part =>
    object(part) && part.type === 'output_text' && typeof part.text === 'string'), 'native_action_final_invalid');
  const text = payload.content.map(part => part.text).join('').trim();
  requireValue(text.length > 0, 'native_action_final_invalid');
  return sha256(text);
}
function failureMessage(value) {
  if (value === undefined || value === null) return null;
  const message = typeof value === 'string' ? value : object(value) ? value.message : null;
  requireValue(typeof message === 'string' && message.trim().length > 0, 'native_action_error_invalid');
  return message;
}
function parseSession(scan, threadId) {
  const turns = new Map();
  let meta = null, active = null, lastTime = -Infinity;
  for (const line of scan) {
    requireValue(line.length > 0, 'native_action_record_invalid');
    let row;
    try { row = JSON.parse(line); } catch { throw new ReadFault('native_action_json_invalid'); }
    requireValue(object(row) && RECORD_TYPES.has(row.type) && object(row.payload), 'native_action_record_invalid');
    const at = instant(row.timestamp), payload = row.payload;
    requireValue(Number.isFinite(at) && at >= lastTime, 'native_action_time_invalid'); lastTime = at;
    if (row.type === 'session_meta') {
      requireValue(meta === null && turns.size === 0 && payload.id === threadId && cwdIdentity(payload.cwd), 'native_action_metadata_invalid');
      meta = {cwd: cwdIdentity(payload.cwd)};
      continue;
    }
    requireValue(meta !== null, 'native_action_metadata_invalid');
    const event = row.type === 'event_msg' ? payload : null;
    if (payload.thread_id !== undefined) requireValue(payload.thread_id === threadId, 'native_action_event_identity_mismatch');
    if (event) {
      requireValue(typeof event.type === 'string' && EVENT_TYPES.has(event.type), 'native_action_event_invalid');
      // Codex 0.155.1 persists settings updates between (and within) turns.
      // This is configuration metadata, never a start, end or tool receipt.
      if (event.type === 'thread_settings_applied') requireValue(event.thread_id === threadId &&
        object(event.thread_settings) && cwdIdentity(event.thread_settings.cwd) === meta.cwd &&
        typeof event.thread_settings.model === 'string' && event.thread_settings.model.trim().length > 0 &&
        typeof event.thread_settings.model_provider_id === 'string' && event.thread_settings.model_provider_id.trim().length > 0,
        'native_action_settings_invalid');
    }
    if (event?.type === 'task_started') {
      requireValue(uuid(event.turn_id) && event.turn_id.toLowerCase() !== threadId.toLowerCase(), 'native_action_turn_identity_invalid');
      requireValue(active === null && !turns.has(event.turn_id), 'native_action_turn_overlap_or_duplicate');
      active = {turnId: event.turn_id, state: 'running', endedAt: null, finalSha256: null,
        hash: crypto.createHash('sha256').update('CLW canonical native turn v1\0')};
      turns.set(active.turnId, active);
    } else if (payload.turn_id !== undefined) {
      requireValue(uuid(payload.turn_id) && active !== null && payload.turn_id === active.turnId,
        'native_action_event_identity_mismatch');
    }
    if (event?.type === 'item_completed') {
      requireValue(active !== null && event.turn_id === active.turnId && event.thread_id === threadId &&
        object(event.item) && typeof event.item.type === 'string' && event.item.type.length > 0 &&
        typeof event.item.id === 'string' && event.item.id.length > 0, 'native_action_item_invalid');
    }
    if (active !== null) active.hash.update(line).update('\n');
    if (row.type === 'response_item') {
      requireValue(typeof payload.type === 'string' && payload.type.length > 0, 'native_action_response_invalid');
      if (payload.type === 'message') requireValue(['system', 'developer', 'user', 'assistant', 'tool'].includes(payload.role) &&
        Array.isArray(payload.content) && payload.content.every(part => object(part) && typeof part.type === 'string') &&
        (payload.phase !== 'final_answer' || payload.role === 'assistant'), 'native_action_response_invalid');
      const final = finalHash(payload);
      if (final !== null) {
        requireValue(active !== null && active.finalSha256 === null, 'native_action_final_duplicate_or_unbound');
        active.finalSha256 = final;
      } else if (!['message', 'reasoning', 'compaction'].includes(payload.type)) {
        requireValue(active !== null, 'native_action_response_unbound');
      }
    }
    if (event && ['task_complete', 'turn_aborted'].includes(event.type)) {
      requireValue(active !== null && event.turn_id === active.turnId, 'native_action_terminal_unbound');
      if (event.type === 'turn_aborted') {
        active.state = 'aborted'; active.terminal = 'turn_aborted';
      } else {
        const error = failureMessage(event.error);
        if (error !== null) {
          requireValue(event.last_agent_message === undefined || event.last_agent_message === null || event.last_agent_message === '' ||
            typeof event.last_agent_message === 'string' && active.finalSha256 !== null &&
            sha256(event.last_agent_message.trim()) === active.finalSha256, 'native_action_terminal_conflict');
          active.state = 'failed'; active.terminal = 'task_complete_with_error';
          active.reason = /remote compact|compaction/i.test(error) ? 'compaction_failed' : 'native_turn_failed';
        } else {
          requireValue(typeof event.last_agent_message === 'string' && event.last_agent_message.trim().length > 0 &&
            active.finalSha256 !== null, 'native_action_final_missing');
          requireValue(sha256(event.last_agent_message.trim()) === active.finalSha256, 'native_action_final_mismatch');
          active.state = 'completed'; active.terminal = 'task_complete_with_matching_final';
        }
      }
      active.endedAt = row.timestamp; active.eventSha256 = active.hash.digest('hex'); delete active.hash;
      active = null;
    }
  }
  requireValue(meta !== null, 'native_action_metadata_invalid');
  if (active !== null) {
    active.terminal = 'task_started_without_terminal'; active.eventSha256 = active.hash.digest('hex'); delete active.hash;
  }
  return {cwd: meta.cwd, turns, threadActive: active !== null, activeTurnId: active?.turnId || null,
    sessionSha256: scan.sessionSha256};
}
function unavailable(source, reason) {
  return {state: 'unavailable', ...(uuid(source?.threadId) ? {threadId: source.threadId} : {}),
    ...(uuid(source?.turnId) ? {turnId: source.turnId} : {}), endedAt: null,
    threadActive: null, activeTurnId: null, nativeProof: null, reason, ...boundary};
}
function createNativeActionReadBatch({sessionsRoot} = {}) {
  const root = sessionsRoot === undefined ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions') : sessionsRoot;
  const parsed = new Map();
  return {
    read(source) {
      const cleaned = object(source) ? cleanSource(source) : null;
      if (!cleaned || !uuid(cleaned.threadId) || !uuid(cleaned.turnId) ||
          cleaned.threadId.toLowerCase() === cleaned.turnId.toLowerCase() || !cwdIdentity(cleaned.workingDirectory)) return unavailable(source, 'native_action_source_invalid');
      source = cleaned;
      if (typeof root !== 'string' || !path.isAbsolute(root)) return unavailable(source, 'native_action_root_invalid');
      if (!parsed.has(source.threadId)) {
        let result;
        try { result = parseSession(createSessionScan(exactSession(source.threadId, root),
          {prefix:'native_action',includeEmpty:true}), source.threadId); }
        catch (error) { result = {reason: error instanceof ReadFault ? error.code :
          error instanceof TypeError&&error.code==='ERR_ENCODING_INVALID_ENCODED_DATA'?'native_action_utf8_invalid':
          /^native_action_[a-z_]+$/.test(error.message||'')?error.message:'native_action_session_unreadable'}; }
        parsed.set(source.threadId, result);
      }
      const result = parsed.get(source.threadId);
      if (result.reason) return unavailable(source, result.reason);
      if (cwdIdentity(source.workingDirectory) !== result.cwd) return unavailable(source, 'native_action_cwd_mismatch');
      const turn = result.turns.get(source.turnId);
      if (!turn) return unavailable(source, 'native_action_turn_not_found');
      return {threadId: source.threadId, turnId: source.turnId, state: turn.state, endedAt: turn.endedAt,
        source: 'native_session_canonical', threadActive: result.threadActive, activeTurnId: result.activeTurnId,
        nativeProof: {version: 1, kind: 'canonical_full_session', threadId: source.threadId, turnId: source.turnId,
          sessionSha256: result.sessionSha256, eventSha256: turn.eventSha256, terminal: turn.terminal,
          ...(turn.finalSha256 ? {finalSha256: turn.finalSha256} : {})},
        ...(turn.reason ? {reason: turn.reason} : {}), ...boundary};
    },
  };
}

module.exports = {createNativeActionReadBatch};
