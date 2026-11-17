const crypto = require('crypto');

const DEFAULT_REDACTION_REPLACEMENT = '[REDACTED]';
const TRUNCATED_VALUE = '[TRUNCATED]';
const CIRCULAR_VALUE = '[CIRCULAR]';
const DEFAULT_MAX_DEPTH = 6;
const RESERVED_TRACE_FIELDS = new Set([
  'ts',
  'level',
  'operation',
  'trace_id',
  'span_id',
  'trace_flags',
  'traceparent',
]);
const DEFAULT_SENSITIVE_KEY_PATTERNS = [
  /pass(word|code)?/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /authorization/i,
  /cookie/i,
  /jwt/i,
  /private[_-]?key/i,
  /connection[_-]?string/i,
  /service[_-]?role[_-]?key/i,
  /anon[_-]?key/i,
];
const JWT_LIKE_RE = /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const BASIC_AUTH_RE = /\bBasic\s+[A-Za-z0-9+/=]+/gi;
const CREDENTIAL_URL_RE = /((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?):\/\/[^:\s\/]+:)([^@\s\/]+)(@)/gi;

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function normalizeHex(value, len) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (!/^[0-9a-f]+$/.test(raw)) return '';
  if (raw.length === len) return raw;
  if (raw.length > len) return raw.slice(raw.length - len);
  return raw.padStart(len, '0');
}

function parseTraceparent(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parts = raw.split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, flags] = parts;
  const normVersion = normalizeHex(version, 2);
  const normTraceId = normalizeHex(traceId, 32);
  const normSpanId = normalizeHex(spanId, 16);
  const normFlags = normalizeHex(flags, 2);
  if (!normVersion || !normTraceId || !normSpanId || !normFlags) return null;
  if (normTraceId === '00000000000000000000000000000000') return null;
  if (normSpanId === '0000000000000000') return null;
  return {
    version: normVersion,
    traceId: normTraceId,
    parentSpanId: normSpanId,
    traceFlags: normFlags,
    traceparent: `${normVersion}-${normTraceId}-${normSpanId}-${normFlags}`,
  };
}

function buildTraceparent({ traceId, parentSpanId, traceFlags } = {}) {
  const version = '00';
  const normalizedTraceId = normalizeHex(traceId, 32) || randomHex(16);
  const normalizedParentSpanId = normalizeHex(parentSpanId, 16) || randomHex(8);
  const normalizedTraceFlags = normalizeHex(traceFlags, 2) || '01';
  return `${version}-${normalizedTraceId}-${normalizedParentSpanId}-${normalizedTraceFlags}`;
}

function resolveTraceContext(options = {}) {
  const parsed = parseTraceparent(options.traceparent || options.traceParent || process.env.TRACEPARENT || '');
  const traceId = normalizeHex(options.traceId, 32) || parsed?.traceId || randomHex(16);
  const traceFlags = normalizeHex(options.traceFlags, 2) || parsed?.traceFlags || '01';
  const parentSpanId = normalizeHex(options.parentSpanId, 16) || parsed?.parentSpanId || '';
  const spanId = randomHex(8);
  const operation = String(options.operation || '').trim() || 'workspace.operation';
  return {
    traceId,
    spanId,
    parentSpanId,
    traceFlags,
    operation,
    traceparent: buildTraceparent({ traceId, parentSpanId: spanId, traceFlags }),
  };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCustomSensitiveKeys(raw) {
  const source = String(raw || '').trim();
  if (!source) return [];
  return source
    .split(',')
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .map((token) => new RegExp(escapeRegExp(token).replace(/_/g, '[_-]?'), 'i'));
}

function resolveRedactionConfig(options = {}) {
  const replacement = String(
    options.replacement || process.env.TRACE_LOG_REDACTION_VALUE || DEFAULT_REDACTION_REPLACEMENT,
  ).trim() || DEFAULT_REDACTION_REPLACEMENT;
  const maxDepthRaw = Number(options.maxDepth ?? process.env.TRACE_LOG_REDACTION_MAX_DEPTH);
  const maxDepth = Number.isFinite(maxDepthRaw) && maxDepthRaw > 0 ? Math.floor(maxDepthRaw) : DEFAULT_MAX_DEPTH;
  const customPatterns = parseCustomSensitiveKeys(
    options.redactKeys ?? process.env.TRACE_LOG_REDACT_KEYS ?? '',
  );
  return {
    replacement,
    maxDepth,
    sensitiveKeyPatterns: [...DEFAULT_SENSITIVE_KEY_PATTERNS, ...customPatterns],
  };
}

function redactSensitiveString(value, replacement) {
  const text = String(value || '');
  if (!text) return text;
  return text
    .replace(BEARER_TOKEN_RE, `Bearer ${replacement}`)
    .replace(BASIC_AUTH_RE, `Basic ${replacement}`)
    .replace(JWT_LIKE_RE, replacement)
    .replace(CREDENTIAL_URL_RE, `$1${replacement}$3`);
}

function isSensitiveKey(key, sensitiveKeyPatterns) {
  const raw = String(key || '').trim();
  if (!raw) return false;
  return sensitiveKeyPatterns.some((pattern) => pattern.test(raw));
}

function sanitizeValue(value, state, key) {
  const {
    replacement,
    sensitiveKeyPatterns,
    maxDepth,
    depth,
    seen,
  } = state;

  if (isSensitiveKey(key, sensitiveKeyPatterns)) return replacement;
  if (value == null) return value;
  if (depth > maxDepth) return TRUNCATED_VALUE;

  if (typeof value === 'string') return redactSensitiveString(value, replacement);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function:${value.name || 'anonymous'}]`;
  if (typeof value !== 'object') return value;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveString(value.message, replacement),
      stack: redactSensitiveString(value.stack || '', replacement),
    };
  }

  if (seen.has(value)) return CIRCULAR_VALUE;
  seen.add(value);

  if (Array.isArray(value)) {
    const out = value.map((item) => sanitizeValue(item, {
      replacement,
      sensitiveKeyPatterns,
      maxDepth,
      depth: depth + 1,
      seen,
    }));
    seen.delete(value);
    return out;
  }

  const out = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    out[nestedKey] = sanitizeValue(nestedValue, {
      replacement,
      sensitiveKeyPatterns,
      maxDepth,
      depth: depth + 1,
      seen,
    }, nestedKey);
  }
  seen.delete(value);
  return out;
}

function sanitizeLogFields(fields = {}, options = {}) {
  const base = fields && typeof fields === 'object' && !Array.isArray(fields)
    ? fields
    : { detail: fields };
  const cfg = resolveRedactionConfig(options);
  return sanitizeValue(base, {
    replacement: cfg.replacement,
    sensitiveKeyPatterns: cfg.sensitiveKeyPatterns,
    maxDepth: cfg.maxDepth,
    depth: 0,
    seen: new WeakSet(),
  });
}

function stripReservedTraceFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (RESERVED_TRACE_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function emitTrace(context, level, fields = {}) {
  const ctx = context || resolveTraceContext();
  const sanitized = sanitizeLogFields(fields);
  const payload = stripReservedTraceFields(sanitized);
  const entry = {
    ...payload,
    ts: nowIso(),
    level: String(level || 'info').trim() || 'info',
    operation: ctx.operation,
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    trace_flags: ctx.traceFlags,
    traceparent: ctx.traceparent,
  };
  const line = JSON.stringify(entry);
  if (entry.level === 'error') {
    console.error(line);
  } else if (entry.level === 'warn' || entry.level === 'warning') {
    console.warn(line);
  } else {
    console.log(line);
  }
  return entry;
}

async function withTraceTiming(context, step, fn) {
  const ctx = context || resolveTraceContext();
  const name = String(step || '').trim() || 'step';
  const start = Date.now();
  emitTrace(ctx, 'info', { step: name, status: 'start' });
  try {
    const result = await fn();
    emitTrace(ctx, 'info', { step: name, status: 'ok', duration_ms: Date.now() - start });
    return result;
  } catch (err) {
    emitTrace(ctx, 'error', {
      step: name,
      status: 'error',
      duration_ms: Date.now() - start,
      error_message: String(err?.message || err || 'unknown error'),
    });
    throw err;
  }
}

module.exports = {
  parseTraceparent,
  buildTraceparent,
  resolveTraceContext,
  sanitizeLogFields,
  resolveRedactionConfig,
  redactSensitiveString,
  emitTrace,
  withTraceTiming,
};
