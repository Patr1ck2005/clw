import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, truncateSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../config";

/** A broker event describes only its own outer Codex tool, never tools nested inside exec. */
export type NativeToolActivityPhase = "queued" | "delivered" | "result" | "error" | "retired";
export type NativeToolActivityName =
  | "exec_command" | "shell_command" | "write_stdin" | "apply_patch" | "view_image"
  | "exec_gateway" | "other";

export interface NativeToolActivityEvent {
  version: 1;
  eventId: number;
  atMs: number;
  traceId: string;
  callId: string;
  phase: NativeToolActivityPhase;
  tool: NativeToolActivityName;
}

export interface NativeToolActivityPage {
  events: NativeToolActivityEvent[];
  oldestEventId: number | null;
  latestEventId: number | null;
  /** The requested global cursor predates the retained rolling window. */
  windowTruncated: boolean;
}

const MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 512;
const MAX_PAGE_EVENTS = 256;

export function nativeToolActivityPath(socketPath: string): string {
  // Named pipes do not have a filesystem parent. The configured private runtime directory owns
  // their journals; the socket hash keeps independent broker endpoints separate.
  const endpointHash = createHash("sha256").update(socketPath).digest("hex").slice(0, 20);
  return join(getConfigDir(), "runtime", `native-tool-activity-${endpointHash}.jsonl`);
}

export function nativeToolActivityName(wireName: string): NativeToolActivityName {
  // Names are allowlisted because a gateway-facing wire name can otherwise contain user data.
  switch (wireName) {
    case "exec_command":
    case "shell_command":
    case "write_stdin":
    case "apply_patch":
    case "view_image":
      return wireName;
    case "exec":
      return "exec_gateway";
    default:
      return "other";
  }
}

function boundedTraceId(traceId: string): string {
  // The normal adapter creates 12 hexadecimal characters from its native execution identity.
  // External owners may supply arbitrary labels; hash those rather than persisting a possible
  // credential that happens to consist only of URL-safe characters.
  return /^[0-9a-f]{12}$/.test(traceId)
    ? traceId
    : `trace_hash_${createHash("sha256").update(traceId).digest("hex").slice(0, 32)}`;
}

function validEvent(value: unknown): value is NativeToolActivityEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<NativeToolActivityEvent>;
  return Object.keys(value).sort().join(",") === "atMs,callId,eventId,phase,tool,traceId,version"
    && event.version === 1
    && Number.isSafeInteger(event.eventId) && event.eventId! > 0
    && Number.isSafeInteger(event.atMs) && event.atMs! > 0
    && typeof event.traceId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(event.traceId)
    && typeof event.callId === "string" && /^call_[A-Za-z0-9_-]{16,128}$/.test(event.callId)
    && ["queued", "delivered", "result", "error", "retired"].includes(event.phase ?? "")
    && ["exec_command", "shell_command", "write_stdin", "apply_patch", "view_image", "exec_gateway", "other"]
      .includes(event.tool ?? "");
}

function readSegment(path: string, repairTail: boolean): NativeToolActivityEvent[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  if (size > MAX_SEGMENT_BYTES + MAX_EVENT_BYTES) {
    throw new Error("native tool activity segment exceeds its bounded size");
  }
  const raw = readFileSync(path, "utf8");
  const completeEnd = raw.lastIndexOf("\n") + 1;
  if (completeEnd < raw.length && repairTail) {
    // A process death can leave a partial final JSON line. It was never a committed event.
    truncateSync(path, Buffer.byteLength(raw.slice(0, completeEnd)));
  }
  const lines = raw.slice(0, completeEnd).split("\n").filter(Boolean);
  const events: NativeToolActivityEvent[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error("native tool activity journal contains invalid JSON"); }
    if (!validEvent(parsed)) throw new Error("native tool activity journal contains an invalid event");
    if (events.length > 0 && parsed.eventId <= events[events.length - 1]!.eventId) {
      throw new Error("native tool activity journal event IDs are not ordered");
    }
    events.push(parsed);
  }
  return events;
}

function retainedEvents(path: string, repairTail = false): NativeToolActivityEvent[] {
  const older = readSegment(`${path}.previous`, repairTail);
  const current = readSegment(path, repairTail);
  if (older.length > 0 && current.length > 0 && older[older.length - 1]!.eventId >= current[0]!.eventId) {
    throw new Error("native tool activity journal segments overlap or are out of order");
  }
  return [...older, ...current];
}

/** A bounded local read; callers must authorize access to this private runtime file themselves. */
export function readNativeToolActivity(
  path: string,
  afterEventId = 0,
  limit = 100,
  traceId?: string,
): NativeToolActivityPage {
  if (!Number.isSafeInteger(afterEventId) || afterEventId < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_EVENTS) {
    throw new Error("native tool activity cursor or page size is invalid");
  }
  const retained = retainedEvents(path);
  const oldestEventId = retained[0]?.eventId ?? null;
  const latestEventId = retained.at(-1)?.eventId ?? null;
  return {
    events: retained.filter(event => event.eventId > afterEventId
      && (traceId === undefined || event.traceId === traceId)).slice(0, limit),
    oldestEventId,
    latestEventId,
    windowTruncated: oldestEventId !== null && afterEventId < oldestEventId - 1,
  };
}

function eventKey(event: Pick<NativeToolActivityEvent, "traceId" | "callId" | "phase">): string {
  return `${event.traceId}\u0000${event.callId}\u0000${event.phase}`;
}

/** Synchronous append + fsync makes a reported event survive an ordinary broker restart. */
export class NativeToolActivityJournal {
  private nextEventId: number;
  private currentBytes: number;
  private readonly seen = new Map<string, NativeToolActivityEvent>();
  private faulted = false;

  constructor(readonly path: string, private readonly maxSegmentBytes = MAX_SEGMENT_BYTES) {
    if (!Number.isSafeInteger(maxSegmentBytes)
      || maxSegmentBytes < 2 * MAX_EVENT_BYTES || maxSegmentBytes > MAX_SEGMENT_BYTES) {
      throw new Error("native tool activity segment size is invalid");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(path), 0o700); } catch { /* Windows ACLs belong to the installer. */ }
    const events = retainedEvents(path, true);
    this.nextEventId = (events.at(-1)?.eventId ?? 0) + 1;
    this.currentBytes = existsSync(path) ? statSync(path).size : 0;
    for (const event of events) this.seen.set(eventKey(event), event);
  }

  record(
    traceId: string,
    callId: string,
    phase: NativeToolActivityPhase,
    tool: NativeToolActivityName,
  ): NativeToolActivityEvent {
    if (this.faulted) throw new Error("native tool activity journal needs restart after a write failure");
    if (!/^call_[A-Za-z0-9_-]{16,128}$/.test(callId)) {
      throw new Error("native tool activity call ID is invalid");
    }
    const safeTraceId = boundedTraceId(traceId);
    const key = eventKey({ traceId: safeTraceId, callId, phase });
    const previous = this.seen.get(key);
    if (previous) {
      if (previous.tool !== tool) throw new Error("native tool activity duplicate conflicts with its tool");
      return previous;
    }
    if (!Number.isSafeInteger(this.nextEventId)) throw new Error("native tool activity event ID exhausted");
    const event: NativeToolActivityEvent = {
      version: 1,
      eventId: this.nextEventId,
      atMs: Date.now(),
      traceId: safeTraceId,
      callId,
      phase,
      tool,
    };
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_EVENT_BYTES) throw new Error("native tool activity event exceeds its size limit");
    try {
      if (this.currentBytes + bytes > this.maxSegmentBytes) this.rotate();
      const fd = openSync(this.path, "a", 0o600);
      try {
        writeFileSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try { chmodSync(this.path, 0o600); } catch { /* Windows ACLs belong to the installer. */ }
    } catch (error) {
      this.faulted = true;
      throw error;
    }
    this.currentBytes += bytes;
    this.nextEventId += 1;
    this.seen.set(key, event);
    return event;
  }

  private rotate(): void {
    const previousPath = `${this.path}.previous`;
    if (existsSync(previousPath)) unlinkSync(previousPath);
    if (existsSync(this.path)) renameSync(this.path, previousPath);
    this.currentBytes = 0;
    this.seen.clear();
    for (const event of readSegment(previousPath, false)) this.seen.set(eventKey(event), event);
  }
}
