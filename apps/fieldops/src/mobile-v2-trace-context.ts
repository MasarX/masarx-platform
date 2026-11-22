// Mobile V2 trace-context helper — RN-compatible parallel of
// `scripts/utils/trace-context.js` (which is Node CommonJS and not bundleable
// into the FE). Produces a W3C-format `traceparent` plus a UUID
// `correlation_id` per RPC call so mobile decisions can be linked back to
// `decision_log` rows server-side and to other surfaces in the trace stream.
//
// Closes the engineering audit's MINOR follow-up:
//   "callRpc still calls client.rpc(name, params) directly with no
//    x-correlation-id / traceparent headers. AGENTS.md trace-context
//    end-to-end propagation applies to scripts; mobile-FE propagation is a
//    follow-up."
//
// supabase-js v2 does not expose a per-call HTTP header hook, so we publish
// the correlation_id + traceparent via:
//   1. The existing `p_idempotency_key` body parameter — server-side already
//      maps it to `decision_log.correlation_id` (see
//      202605120300_fieldops_mobile_v2_write_rpcs_pack_v1.sql:245).
//   2. A structured console.debug event under tag MV2-RPC so the local
//      log stream picks it up and aggregators can group by traceId.
//
// All helpers are pure; safe to import from any RN target (Web / iOS /
// Android via Hermes).

import { redactOutboxErrorText } from "@masarx/mobile-core";

/** RFC 4122 UUID v4 string. */
export type MobileV2Uuid = string;

/** W3C traceparent string: `00-<traceId>-<parentId>-<flags>`. */
export type MobileV2Traceparent = string;

export interface MobileV2TraceContext {
  readonly correlationId: MobileV2Uuid;
  readonly traceId: string;
  readonly parentId: string;
  readonly traceparent: MobileV2Traceparent;
}

const UUID_CANONICAL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Generate a random RFC 4122 v4 UUID. Hermes (RN 0.74+) ships
 *  crypto.randomUUID; we fall back to a getRandomValues path for older
 *  environments (Jest jsdom, legacy RN). */
export function newMobileV2Uuid(): MobileV2Uuid {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  let bytes: Uint8Array;
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    bytes = crypto.getRandomValues(new Uint8Array(16));
  } else {
    bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Convert a canonical UUID into a 32-char hex trace-id (W3C). */
export function uuidToTraceId(uuid: MobileV2Uuid): string {
  if (!UUID_CANONICAL_RE.test(uuid)) {
    throw new Error(`uuidToTraceId: not a canonical UUID: ${uuid}`);
  }
  return uuid.replace(/-/g, "").toLowerCase();
}

/** Generate a 16-char hex span/parent id (random). */
export function newSpanId(): string {
  let bytes: Uint8Array;
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    bytes = crypto.getRandomValues(new Uint8Array(8));
  } else {
    bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build a complete trace context for one RPC invocation. */
export function newMobileV2TraceContext(): MobileV2TraceContext {
  const correlationId = newMobileV2Uuid();
  const traceId = uuidToTraceId(correlationId);
  const parentId = newSpanId();
  const flags = "01"; // sampled
  return Object.freeze({
    correlationId,
    traceId,
    parentId,
    traceparent: `00-${traceId}-${parentId}-${flags}`,
  });
}

/** Emit a structured trace event to the local log stream. Tag is
 *  `MV2-RPC` so aggregators can group/filter cleanly. Sensitive values
 *  (auth tokens, signed URLs) should never be passed — caller is
 *  responsible for upstream redaction. */
export type MobileV2TraceEventStep =
  | "rpc.start"
  | "rpc.end"
  | "rpc.error"
  | "rpc.outbox.enqueued"
  | "rpc.outbox.enqueue_failed"
  | "rpc.outbox.drain.start"
  | "rpc.outbox.drain.end"
  | "rpc.outbox.drain.error"
  | "loader.submit.press"
  | "loader.submit.blocked"
  | "loader.submit.route_load.start"
  | "loader.submit.route_load.readback";

export function emitMobileV2TraceEvent(
  step: MobileV2TraceEventStep,
  fields: Readonly<Record<string, unknown>>,
): void {
  // Use console.debug so RN's prod log filter can suppress these by level
  // without losing them in development. Single-line JSON keeps the stream
  // grep-friendly.
  try {
    const message = fields.message;
    const safeFields = typeof message === "string"
      ? { ...fields, message: redactOutboxErrorText(message) }
      : fields;
    // eslint-disable-next-line no-console
    console.debug(
      "MV2-RPC",
      JSON.stringify({ step, ...safeFields, ts: new Date().toISOString() }),
    );
  } catch {
    /* never propagate a logging failure into the caller */
  }
}
