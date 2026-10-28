'use strict';

// Durable continuation for transport-sized MCP results. The original bytes are
// never truncated or rewritten; text is a separate, UTF-8 paged projection.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const KiB = 1024;
const MiB = 1024 * KiB;
const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_BYTES = 64 * KiB;
const MAX_PAGE_BYTES = 512 * KiB;
const RESULT_ID = /^result_[a-f0-9]{32}$/;
const PENDING_ID = /^\.pending-[a-f0-9]{32}$/;
const META_ALLOWANCE = 8192;
const localLocks = new Map();

class ResultStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ResultStoreError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ResultStoreError(code, message, details);
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('RESULT_INVALID_ARGUMENT', `${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function principalHash(principal) {
  if (typeof principal !== 'string' || !principal.trim() || principal.length > 32768) {
    fail('RESULT_INVALID_PRINCIPAL', 'A nonempty authenticated principal is required.');
  }
  return crypto.createHash('sha256').update('clw-result-principal-v1\0').update(principal).digest('hex');
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function durableWrite(file, data, flags = 'wx') {
  const handle = await fs.open(file, flags, 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  // Windows does not support fsync on directory handles. File data is synced
  // before publishing the directory; POSIX additionally syncs its parent.
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error;
  } finally { if (handle) await handle.close(); }
}

async function atomicJson(directory, name, value) {
  const temp = path.join(directory, `.${name}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await durableWrite(temp, JSON.stringify(value));
    await fs.rename(temp, path.join(directory, name));
  } finally { await fs.rm(temp, { force: true }); }
}

function descriptor(meta) {
  return {
    result_id: meta.result_id,
    sha256: meta.sha256,
    raw_bytes: meta.raw_bytes,
    text_bytes: meta.text_bytes,
    text_sha256: meta.text_sha256,
    content_type: meta.content_type,
    status: meta.status,
    tool: meta.tool,
    created_at: meta.created_at,
    complete: meta.complete === true,
    incomplete_reason: meta.incomplete_reason || null,
    formats: ['text', 'base64'],
    default_page_bytes: DEFAULT_PAGE_BYTES,
    max_page_bytes: MAX_PAGE_BYTES,
    ...(meta.call_id ? {call_id:meta.call_id,activity_part:meta.activity_part}:{}),
  };
}

function mergedRanges(ranges, start, end) {
  if (end <= start) return ranges || [];
  const sorted = [...(ranges || []), [start, end]].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

function consumed(ranges, bytes) {
  return bytes === 0 || (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= bytes);
}

async function* chunksOf(raw) {
  if (typeof raw === 'string' || Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    // Snapshot caller-owned buffers so mutation during awaited disk writes does
    // not change either the durable bytes or their digest.
    const bytes = Buffer.from(raw);
    for (let offset = 0; offset < bytes.length; offset += DEFAULT_PAGE_BYTES) {
      yield bytes.subarray(offset, offset + DEFAULT_PAGE_BYTES);
    }
    return;
  }
  if (raw && typeof raw[Symbol.asyncIterator] === 'function') {
    try {
      for await (const item of raw) {
        if (typeof item !== 'string' && !Buffer.isBuffer(item) && !(item instanceof Uint8Array)) {
          fail('RESULT_INVALID_ARGUMENT', 'Result stream chunks must be bytes or strings.');
        }
        const bytes = Buffer.from(item);
        for (let offset = 0; offset < bytes.length; offset += DEFAULT_PAGE_BYTES) {
          yield bytes.subarray(offset, offset + DEFAULT_PAGE_BYTES);
        }
      }
    } catch (error) {
      if (error instanceof ResultStoreError) throw error;
      fail('RESULT_INCOMPLETE', 'The upstream response stream was interrupted.', { cause_code: String(error.code || '').slice(0, 80) });
    }
    return;
  }
  fail('RESULT_INVALID_ARGUMENT', 'raw must be bytes, a string, or an async iterable of bytes.');
}

function createResultStore(options = {}) {
  if (typeof options.home !== 'string' || !path.isAbsolute(options.home)) {
    fail('RESULT_INVALID_ARGUMENT', 'home must be an absolute path to a dedicated result-store directory.');
  }
  const home = path.resolve(options.home);
  const maxBytes = integer(options.maxBytes ?? 768 * MiB, 'maxBytes', META_ALLOWANCE, Number.MAX_SAFE_INTEGER);
  const maxEntries = integer(options.maxEntries ?? 64, 'maxEntries', 1, 100000);
  const maxEntryBytes = integer(options.maxEntryBytes ?? Math.min(384 * MiB, maxBytes - META_ALLOWANCE), 'maxEntryBytes', 1, maxBytes);
  const retentionMs = integer(options.retentionMs ?? DAY, 'retentionMs', DAY, Number.MAX_SAFE_INTEGER);
  const lockTimeoutMs = integer(options.lockTimeoutMs ?? 30000, 'lockTimeoutMs', 50, 300000);
  const now = options.now || Date.now;
  const lockDirectory = path.join(home, '.write-lock');

  async function processLock(action, key = home) {
    const previous = localLocks.get(key) || Promise.resolve();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => held);
    localLocks.set(key, tail);
    let timeout;
    try {
      await Promise.race([
        previous.catch(() => {}),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new ResultStoreError('RESULT_STORE_BUSY',
            'Another result is still being stored. Preserve this original response; do not repeat the command.')), lockTimeoutMs);
        }),
      ]);
      clearTimeout(timeout);
      return await action();
    } finally {
      clearTimeout(timeout);
      release();
      if (localLocks.get(key) === tail) localLocks.delete(key);
    }
  }

  async function locked(action) {
    return processLock(async () => {
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      const deadline = Date.now() + lockTimeoutMs;
      const nonce = crypto.randomBytes(16).toString('hex');
      let acquired = false;
      while (!acquired) {
        try {
          await fs.mkdir(lockDirectory, { mode: 0o700 });
          acquired = true;
          await durableWrite(path.join(lockDirectory, 'owner.json'), JSON.stringify({ pid: process.pid, nonce }));
        } catch (error) {
          if (acquired) { await fs.rm(lockDirectory, { recursive: true, force: true }); throw error; }
          if (error.code !== 'EEXIST') throw error;
          let owner;
          try { owner = await readJson(path.join(lockDirectory, 'owner.json')); } catch (_) {}
          if (owner && /^[a-f0-9]{32}$/.test(owner.nonce || '') && !isAlive(owner.pid)) {
            // One permanent recovery claim per dead owner prevents a second
            // process that observed that old owner from removing a new lock.
            // Empty claim directories are negligible and can be discarded
            // when the dedicated store is archived.
            const claim = path.join(home, `.recovered-${owner.nonce}`);
            const stale = `${lockDirectory}.stale-${nonce}`;
            try {
              await fs.mkdir(claim);
              const current = await readJson(path.join(lockDirectory, 'owner.json')).catch(() => null);
              if (current?.nonce !== owner.nonce || isAlive(current.pid)) continue;
              await fs.rename(lockDirectory, stale);
              await fs.rm(stale, { recursive: true, force: true });
              continue;
            } catch (renameError) {
              if (!['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(renameError.code)) throw renameError;
            }
          }
          if (!owner) {
            try {
              const stat = await fs.stat(lockDirectory);
              if (Date.now() - stat.mtimeMs > 60000) {
                const identity = crypto.createHash('sha256').update(String(stat.birthtimeMs)).update(String(stat.mtimeMs)).digest('hex').slice(0, 32);
                await fs.mkdir(path.join(home, `.recovered-${identity}`));
                // A writer may have completed owner publication meanwhile.
                if (await readJson(path.join(lockDirectory, 'owner.json')).catch(() => null)) continue;
                const stale = `${lockDirectory}.stale-${nonce}`;
                await fs.rename(lockDirectory, stale);
                await fs.rm(stale, { recursive: true, force: true });
                continue;
              }
            } catch (statError) {
              if (!['ENOENT', 'EEXIST'].includes(statError.code)) throw statError;
            }
          }
          if (Date.now() >= deadline) fail('RESULT_STORE_BUSY', 'The result store has a live writer; retry the same result read, not the original command.');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      try { return await action(); } finally {
        const owner = await readJson(path.join(lockDirectory, 'owner.json')).catch(() => null);
        if (owner?.nonce === nonce) await fs.rm(lockDirectory, { recursive: true, force: true });
      }
    });
  }

  async function inventory() {
    const entries = [];
    let otherBytes = 0;
    for (const item of await fs.readdir(home, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const directory = path.join(home, item.name);
      if (PENDING_ID.test(item.name)) {
        const owner = await readJson(path.join(directory, 'owner.json')).catch(() => null);
        // A hard process interruption may leave the only received prefix in
        // staging. Fresh unread bytes keep the same24h retention guarantee.
        if (owner && !isAlive(owner.pid) && Number.isSafeInteger(owner.created_at_ms) && now() - owner.created_at_ms >= retentionMs) {
          await fs.rm(directory, { recursive: true, force: true });
          continue;
        }
        // An interrupted same-process put removes its own staging directory.
        // Unknown pending data is accounted, never silently deleted.
        for (const file of await fs.readdir(directory, { withFileTypes: true })) {
          if (file.isFile()) otherBytes += (await fs.stat(path.join(directory, file.name))).size;
        }
        continue;
      }
      if (!RESULT_ID.test(item.name)) continue;
      const meta = await readJson(path.join(directory, 'meta.json')).catch(() => null);
      const state = await readJson(path.join(directory, 'read.json')).catch(() => ({}));
      let bytes = 0;
      for (const file of await fs.readdir(directory, { withFileTypes: true })) {
        if (file.isFile()) bytes += (await fs.stat(path.join(directory, file.name))).size;
      }
      if (!meta || meta.result_id !== item.name || !Number.isSafeInteger(meta.created_at_ms)) {
        otherBytes += bytes;
        continue;
      }
      // Mutable coverage files are separately capped below; reserve that
      // allowance even when the current read state is still small.
      entries.push({ directory, meta, state, bytes: bytes + META_ALLOWANCE });
    }
    return { entries, otherBytes };
  }

  async function metadata(resultId, principal) {
    if (typeof resultId !== 'string' || !RESULT_ID.test(resultId)) {
      fail('RESULT_NOT_FOUND', 'The result reference is unknown or invalid.');
    }
    const binding = principalHash(principal);
    const directory = path.join(home, resultId);
    let meta;
    try { meta = await readJson(path.join(directory, 'meta.json')); } catch (error) {
      if (error.code === 'ENOENT') fail('RESULT_NOT_FOUND', 'This stored result is unavailable. Do not re-execute the original command.');
      fail('RESULT_CORRUPT', 'Stored result metadata cannot be read.', { result_id: resultId });
    }
    if (meta.version !== 1 || meta.result_id !== resultId || !/^[a-f0-9]{64}$/.test(meta.principal_hash || '') ||
        !Number.isSafeInteger(meta.raw_bytes) || meta.raw_bytes < 0 ||
        !Number.isSafeInteger(meta.text_bytes) || meta.text_bytes < 0) {
      fail('RESULT_CORRUPT', 'Stored result metadata is invalid.', { result_id: resultId });
    }
    if (!crypto.timingSafeEqual(Buffer.from(binding, 'hex'), Buffer.from(meta.principal_hash, 'hex'))) {
      fail('RESULT_NOT_FOUND', 'The result reference is unknown or invalid.');
    }
    return { directory, meta };
  }

  async function put(raw, context = {}) {
    const binding = principalHash(context.principal);
    if(context.callId!==undefined&&(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(context.callId)||
      !['arguments','response'].includes(context.part)))fail('RESULT_INVALID_ARGUMENT','Original call identity and part are required.');
    if (context.projection !== undefined && typeof context.projection !== 'string' && !Buffer.isBuffer(context.projection)) {
      fail('RESULT_INVALID_ARGUMENT', 'projection must be UTF-8 text or bytes.');
    }
    return locked(async () => {
      const snapshot = await inventory();
      const eligible = snapshot.entries.filter(entry => entry.meta.activity_only===true||
        context.activityOnly!==true&&(entry.state.fully_read===true||now()-entry.meta.created_at_ms>=retentionMs))
        .sort((a,b)=>Number(b.meta.activity_only===true)-Number(a.meta.activity_only===true)||a.meta.created_at_ms-b.meta.created_at_ms);
      let liveBytes = snapshot.otherBytes + snapshot.entries.reduce((sum, entry) => sum + entry.bytes, 0);
      let liveCount = snapshot.entries.length;
      async function room(required) {
        while ((liveBytes + required > maxBytes || liveCount + 1 > maxEntries) && eligible.length) {
          const candidate = eligible.shift();
          try {
            await fs.rm(candidate.directory, { recursive: true });
            liveBytes -= candidate.bytes;
            liveCount--;
          } catch (error) {
            if (error.code !== 'ENOENT') continue;
            liveBytes -= candidate.bytes;
            liveCount--;
          }
        }
        if (liveBytes + required > maxBytes || liveCount + 1 > maxEntries) {
          fail('RESULT_STORE_FULL', 'Result storage is full of retained results. The original command must not be repeated.',
            { max_bytes: maxBytes, retained_bytes: liveBytes, max_entries: maxEntries, retained_entries: liveCount });
        }
      }
      await room(META_ALLOWANCE);
      const suffix = crypto.randomBytes(16).toString('hex');
      const resultId = `result_${suffix}`;
      const staging = path.join(home, `.pending-${suffix}`);
      await fs.mkdir(staging, { mode: 0o700 });
      let rawHandle, textHandle;
      let published = false;
      let publishedMeta;
      try {
        await durableWrite(path.join(staging, 'owner.json'), JSON.stringify({ pid: process.pid, created_at_ms: now() }));
        rawHandle = await fs.open(path.join(staging, 'raw.bin'), 'wx', 0o600);
        if (context.projection !== undefined) textHandle = await fs.open(path.join(staging, 'text.utf8'), 'wx', 0o600);
        const rawHash = crypto.createHash('sha256');
        const textHash = crypto.createHash('sha256');
        let rawBytes = 0, textBytes = 0;
        async function appendText(text) {
          const bytes = Buffer.from(text);
          if (textBytes + bytes.length > maxEntryBytes) fail('RESULT_TOO_LARGE', 'The readable projection exceeds the configured result limit.');
          await room(rawBytes + textBytes + bytes.length + META_ALLOWANCE);
          await textHandle.writeFile(bytes);
          textHash.update(bytes);
          textBytes += bytes.length;
        }
        let sourceError;
        try {
          for await (const bytes of chunksOf(raw)) {
            if (rawBytes + bytes.length > maxEntryBytes) fail('RESULT_TOO_LARGE', 'The original result exceeds the configured result limit.', { max_entry_bytes: maxEntryBytes });
            await room(rawBytes + textBytes + bytes.length + META_ALLOWANCE);
            await rawHandle.writeFile(bytes);
            rawHash.update(bytes);
            rawBytes += bytes.length;
          }
        } catch (error) {
          // A failed upstream stream is an incomplete response to the same
          // accepted command, never a reason to dispatch that command again.
          // Retain the successfully written prefix when it can be published.
          if (!(error instanceof ResultStoreError) || !['RESULT_INCOMPLETE', 'RESULT_STORE_FULL', 'RESULT_TOO_LARGE'].includes(error.code) || rawBytes === 0) throw error;
          sourceError = error;
        }
        if (context.projection !== undefined) {
          const projectionDecoder = new StringDecoder('utf8');
          try {
            for await (const bytes of chunksOf(context.projection)) await appendText(projectionDecoder.write(bytes));
            await appendText(projectionDecoder.end());
          } catch (error) {
            if (!(error instanceof ResultStoreError) || !['RESULT_STORE_FULL', 'RESULT_TOO_LARGE'].includes(error.code) || rawBytes === 0) throw error;
            sourceError = sourceError || error;
          }
        }
        await rawHandle.sync(); await rawHandle.close(); rawHandle = null;
        if (textHandle) { await textHandle.sync(); await textHandle.close(); textHandle = null; }
        const digest = rawHash.digest('hex');
        const projectionDigest = context.projection === undefined ? digest : textHash.digest('hex');
        if (context.projection === undefined) textBytes = rawBytes;
        const created = now();
        const meta = {
          version: 1, result_id: resultId, principal_hash: binding,
          sha256: digest, raw_bytes: rawBytes,
          text_sha256: projectionDigest, text_bytes: textBytes,
          created_at_ms: created, created_at: new Date(created).toISOString(),
          content_type: String(context.contentType || 'application/octet-stream').slice(0, 256),
          status: Number.isInteger(context.status) ? context.status : null,
          tool: context.tool == null ? null : String(context.tool).slice(0, 256),
          projection_kind: context.projection === undefined ? 'utf8' : 'provided',
          ...(context.callId?{call_id:context.callId,activity_part:context.part}:{}),
          ...(context.activityOnly===true?{activity_only:true}:{}),
          complete: context.complete !== false && !sourceError,
          incomplete_reason: sourceError?.code === 'RESULT_TOO_LARGE' ? 'result_limit_reached' :
            sourceError?.code === 'RESULT_STORE_FULL' ? 'store_capacity_reached' :
              sourceError || context.complete === false ? 'upstream_stream_interrupted' : null,
        };
        await durableWrite(path.join(staging, 'meta.json'), JSON.stringify(meta));
        await durableWrite(path.join(staging, 'read.json'), JSON.stringify({ version: 1, text: [], raw: [], fully_read: false }));
        await syncDirectory(staging);
        await fs.rename(staging, path.join(home, resultId));
        published = true;
        publishedMeta = meta;
        await syncDirectory(home);
        if (sourceError) fail(sourceError.code, 'The response could not be retained completely. The saved prefix belongs to the original command; do not repeat it.',
          { ...sourceError.details, result: descriptor(meta) });
        return descriptor(meta);
      } catch (error) {
        if (published && !(error instanceof ResultStoreError)) {
          fail('RESULT_STORAGE_ERROR', 'The original response was published but durability verification failed. Use this result reference; do not repeat the command.',
            { cause_code: String(error.code || '').slice(0, 80), result: descriptor(publishedMeta) });
        }
        throw error;
      } finally {
        if (rawHandle) await rawHandle.close();
        if (textHandle) await textHandle.close();
        if (!published) await fs.rm(staging, { recursive: true, force: true });
      }
    }).catch(error => {
      if (error instanceof ResultStoreError) throw error;
      fail('RESULT_STORAGE_ERROR', 'The response could not be durably stored. Do not repeat the original command.', { cause_code: String(error.code || '').slice(0, 80) });
    });
  }

  async function read(query = {}, principal, {trackCoverage=true,expectedCallId,expectedPart}={}) {
    const offset = integer(query.offset ?? 0, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const max = integer(query.max_bytes ?? DEFAULT_PAGE_BYTES, 'max_bytes', 4, MAX_PAGE_BYTES);
    const format = query.format ?? 'text';
    if (!['text', 'base64'].includes(format)) fail('RESULT_INVALID_ARGUMENT', 'format must be text or base64.');
    // A slow upstream response may hold the quota writer lock for minutes.
    // Published results remain readable throughout that stream. Coverage
    // updates are atomic and conservative if different processes read at once.
    return processLock(async () => {
      const { directory, meta } = await metadata(query.result_id, principal);
      if(expectedCallId!==undefined&&(meta.call_id!==expectedCallId||meta.activity_part!==expectedPart))
        fail('RESULT_NOT_FOUND','The original call result reference does not match.');
      const total = format === 'text' ? meta.text_bytes : meta.raw_bytes;
      if (offset > total) fail('RESULT_INVALID_ARGUMENT', 'offset exceeds the selected result length.', { total_bytes: total });
      const file = path.join(directory, format === 'text' && meta.projection_kind === 'provided' ? 'text.utf8' : 'raw.bin');
      let handle;
      let bytes;
      try {
        handle = await fs.open(file, 'r');
        const stat = await handle.stat();
        if (stat.size !== total) fail('RESULT_CORRUPT', 'Stored result payload length does not match its durable metadata.');
        const buffer = Buffer.alloc(Math.min(max + 3, total - offset));
        const got = await handle.read(buffer, 0, buffer.length, offset);
        bytes = buffer.subarray(0, got.bytesRead);
      } catch (error) {
        if (error.code === 'ENOENT') fail('RESULT_CORRUPT', 'Stored result payload is missing.', { result_id: meta.result_id });
        throw error;
      } finally { if (handle) await handle.close(); }
      let end = Math.min(max, bytes.length);
      if (format === 'text') {
        if (bytes.length && (bytes[0] & 0xc0) === 0x80) {
          fail('RESULT_INVALID_ARGUMENT', 'Text offset must start at a UTF-8 character boundary. Use next_offset from the previous page.');
        }
        // If max would split a UTF-8 character, leave that whole character to
        // the next page. The hard four-byte minimum always permits progress.
        while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
      }
      bytes = bytes.subarray(0, end);
      const next = offset + bytes.length;
      if(trackCoverage){
      const state = await readJson(path.join(directory, 'read.json')).catch(() => ({ version: 1, text: [], raw: [], fully_read: false }));
      const key = format === 'text' ? 'text' : 'raw';
      state[key] = mergedRanges(state[key], offset, next);
      if (state[key].length > 128) {
        state[key] = state[key].slice(0, 128);
        state.coverage_limited = true;
      }
      // Jumping to the last page is not an acknowledgement of skipped data.
      // A provided text summary does not mark unread original bytes consumed.
      state.fully_read = meta.complete === true && (consumed(state.raw || [], meta.raw_bytes) ||
        (meta.projection_kind === 'utf8' && consumed(state.text || [], meta.text_bytes)));
      state.last_read_at = new Date(now()).toISOString();
      await atomicJson(directory, 'read.json', state);
      }
      return {
        ...descriptor(meta), format, offset, next_offset: next,
        bytes_returned: bytes.length, total_bytes: total, eof: next === total,
        data: format === 'base64' ? bytes.toString('base64') : bytes.toString('utf8'),
      };
    }, `${home}/${query.result_id}`).catch(error => {
      if (error instanceof ResultStoreError) throw error;
      fail('RESULT_STORAGE_ERROR', 'The stored response could not be read. Retry this result reference, not the original command.', { cause_code: String(error.code || '').slice(0, 80) });
    });
  }

  async function putStream(stream, context = {}) {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      fail('RESULT_INVALID_ARGUMENT', 'putStream requires an async iterable of bytes.');
    }
    return put(stream, context);
  }

  return Object.freeze({ put, putStream, read });
}

module.exports = { createResultStore, ResultStoreError, DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES };
