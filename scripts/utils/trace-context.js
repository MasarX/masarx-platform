const crypto = require('crypto');
const { parseTraceparent, resolveTraceContext, emitTrace } = require('../ops/workspace/trace-log');

const UUID_CANONICAL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_HEX_RE = /^[0-9a-f]{32}$/i;
const TRACE_ID_HEX_RE = /^[0-9a-f]{32}$/i;

function trimToNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUuid(value) {
  const raw = trimToNull(String(value || ''));
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (UUID_CANONICAL_RE.test(lowered)) return lowered;
  if (UUID_HEX_RE.test(lowered)) {
    return `${lowered.slice(0, 8)}-${lowered.slice(8, 12)}-${lowered.slice(12, 16)}-${lowered.slice(16, 20)}-${lowered.slice(20)}`;
  }
  return null;
}

function uuidToTraceId(uuid) {
  const normalized = normalizeUuid(uuid);
  return normalized ? normalized.replace(/-/g, '') : null;
}

function traceIdToUuid(traceId) {
  const raw = trimToNull(String(traceId || ''));
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (!TRACE_ID_HEX_RE.test(lowered)) return null;
  if (lowered === '00000000000000000000000000000000') return null;
  return `${lowered.slice(0, 8)}-${lowered.slice(8, 12)}-${lowered.slice(12, 16)}-${lowered.slice(16, 20)}-${lowered.slice(20)}`;
}

function resolveCorrelationId(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const env = (opts.env && typeof opts.env === 'object') ? opts.env : process.env;

  const explicit = normalizeUuid(opts.correlationId);
  if (explicit) return explicit;

  const fromEnv =
    normalizeUuid(env.CORRELATION_ID) ||
    normalizeUuid(env.X_CORRELATION_ID) ||
    normalizeUuid(env.REQUEST_CORRELATION_ID);
  if (fromEnv) return fromEnv;

  const parsed = parseTraceparent(opts.traceparent || env.TRACEPARENT || '');
  if (parsed) {
    const fromTrace = traceIdToUuid(parsed.traceId);
    if (fromTrace) return fromTrace;
  }

  const fromRequestId =
    normalizeUuid(opts.requestId) ||
    normalizeUuid(env.REQUEST_ID) ||
    normalizeUuid(env.X_REQUEST_ID);
  if (fromRequestId) return fromRequestId;

  if (typeof crypto.randomUUID === 'function') {
    return normalizeUuid(crypto.randomUUID()) || crypto.randomUUID();
  }

  // Last-resort fallback (still UUID-shaped).
  const seed = `${Date.now()}${Math.random()}${Math.random()}`.replace(/[^0-9]/g, '').padEnd(32, '0').slice(0, 32);
  return `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4000-8000-${seed.slice(20)}`;
}

function resolveExecutionContext(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const operation = trimToNull(opts.operation) || 'backend.execution';
  const correlationId = resolveCorrelationId(opts);

  const parsed = parseTraceparent(opts.traceparent || opts.traceParent || process.env.TRACEPARENT || '');
  const baseTraceId = parsed?.traceId || uuidToTraceId(correlationId) || crypto.randomBytes(16).toString('hex');
  const trace = resolveTraceContext({
    operation,
    traceparent: parsed?.traceparent || opts.traceparent || opts.traceParent || process.env.TRACEPARENT || '',
    traceId: baseTraceId,
    traceFlags: opts.traceFlags,
  });

  return {
    correlationId,
    operation,
    traceId: trace.traceId,
    spanId: trace.spanId,
    traceFlags: trace.traceFlags,
    traceparent: trace.traceparent,
  };
}

function buildTraceHeaders(ctx) {
  const context = ctx && typeof ctx === 'object' ? ctx : {};
  const correlationId = trimToNull(context.correlationId) || trimToNull(context.correlation_id) || null;
  const traceparent = trimToNull(context.traceparent) || null;
  return {
    ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
    ...(traceparent ? { traceparent } : {}),
  };
}

function emitTraceWithContext(ctx, level, fields = {}) {
  const context = ctx && typeof ctx === 'object' ? ctx : resolveExecutionContext();
  const payload = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : { detail: fields };
  // Prefer context correlation id over any caller-provided value.
  const merged = { ...payload, correlation_id: context.correlationId };
  return emitTrace(
    {
      operation: context.operation,
      traceId: context.traceId,
      spanId: context.spanId,
      traceFlags: context.traceFlags,
      traceparent: context.traceparent,
    },
    level,
    merged,
  );
}

module.exports = {
  normalizeUuid,
  uuidToTraceId,
  traceIdToUuid,
  resolveCorrelationId,
  resolveExecutionContext,
  buildTraceHeaders,
  emitTraceWithContext,
};

