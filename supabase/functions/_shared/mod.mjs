const SECRETISH_ENV_KEY_PATTERN = /(token|jwt|key|password|secret)/i;

const sanitizeEnvValue = (key, value) => {
  const raw = String(value ?? "");
  if (!raw) return "";

  let out = raw.trim();
  // Strip control chars that break fetch Headers and other protocol parsers.
  out = out.replace(/[\u0000-\u001F\u007F]/g, "");

  if (SECRETISH_ENV_KEY_PATTERN.test(String(key || ""))) {
    // Secret material should be whitespace-free and ASCII-safe.
    out = out
      .replace(/[\u200B-\u200D\u2060\uFEFF\u2028\u2029]/g, "")
      .replace(/\s+/g, "")
      .replace(/[^\x20-\x7E]/g, "");
  }

  return out.trim();
};

export const readEnv = (primary, fallbacks = []) => {
  const keys = [primary, ...fallbacks];
  for (const key of keys) {
    const value = sanitizeEnvValue(key, Deno.env.get(key));
    if (value && value.length > 0) {
      return value;
    }
  }
  return "";
};

// Prefer over-redaction to prevent accidental credential leakage in structured logs.
// Match common secret-bearing keys including prefixed header names (e.g. x-webhook-token, x-signature, x-hub-signature-256).
const LOG_SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|set-cookie|x-api-key|api[_-]?key|password|secret|token|signature|private[_-]?key)/i;
const LOG_JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const LOG_BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._-]+\b/gi;
const INGRESS_SECRET_QUERY_PATTERN =
  /(^|[?&])(token|auth_token|api_key|apikey|secret|signature|hmac|x_signature|x-signature|x-hub-signature|x-hub-signature-256|key|password|credential)=([^&#\s]*)/gi;
const INGRESS_FORWARDED_PATH_HEADERS = new Set([
  "x-forwarded-path",
  "x-forwarded-url",
  "x-original-uri",
  "x-rewrite-url",
  "x-envoy-original-path",
  "referer",
]);
const UUID_CANONICAL_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/i;
const SHARED_STORAGE_NAMESPACES = new Set(["global", "fonts"]);
const INVALID_STORAGE_KEY_CHARACTERS = /[\\\p{Cc}]/u;
const STORAGE_OBJECT_URL = /^https?:\/\/[^/?#\\]+\/storage\/v1\/object\/(?:public\/|sign\/|authenticated\/)?([^/?#]+)\/([^?#]+)(?:[?#].*)?$/i;

export const canonicalStorageKey = (value, organizationId, { write = false, allowShared = false } = {}) => {
  if (typeof value !== "string" || typeof organizationId !== "string" || !UUID_CANONICAL_PATTERN.test(organizationId) ||
    INVALID_STORAGE_KEY_CHARACTERS.test(value)) return null;

  let key;
  try {
    key = decodeURIComponent(value);
  } catch {
    return null;
  }

  const [namespace, ...segments] = key.split("/");
  if (segments.length === 0 || INVALID_STORAGE_KEY_CHARACTERS.test(key) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  if (write) {
    return namespace === organizationId && key === value &&
        segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment))
      ? key : null;
  }
  return namespace === organizationId || (allowShared && SHARED_STORAGE_NAMESPACES.has(namespace)) ? key : null;
};

export const isStorageBucketId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

export const parseStorageObjectUrl = (value) => {
  if (INVALID_STORAGE_KEY_CHARACTERS.test(value)) return null;
  // Inspect the supplied path before URL parsing can remove dot segments.
  const match = STORAGE_OBJECT_URL.exec(value);
  return match && isStorageBucketId(match[1]) ? { bucket: match[1], path: match[2] } : null;
};

const TRACEPARENT_VERSION_PATTERN = /^[0-9a-f]{2}$/i;
const TRACEPARENT_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const TRACEPARENT_SPAN_ID_PATTERN = /^[0-9a-f]{16}$/i;
const TRACEPARENT_FLAGS_PATTERN = /^[0-9a-f]{2}$/i;

const trimToNull = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const redactIngressSecretText = (value) => {
  if (typeof value !== "string") return value;
  return value
    .replace(/(\/api-gateway\/t\/)[^/?#\s]+/gi, "$1[redacted]")
    .replace(/(\/api-gateway\/)(?!t(?:\/|$))[^/?#\s]+/gi, "$1[redacted]")
    .replace(INGRESS_SECRET_QUERY_PATTERN, "$1$2=[redacted]");
};

export const redactIngressForwardedHeaders = (headers = {}) => {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  const redacted = { ...headers };
  for (const [key, value] of Object.entries(redacted)) {
    if (!INGRESS_FORWARDED_PATH_HEADERS.has(String(key).toLowerCase())) continue;
    if (typeof value === "string") redacted[key] = redactIngressSecretText(value);
  }
  return redacted;
};

const redactStringForLog = (value) => {
  if (typeof value !== "string") return value;
  return redactIngressSecretText(value)
    .replace(LOG_BEARER_PATTERN, "Bearer [redacted]")
    .replace(LOG_JWT_PATTERN, "[redacted_jwt]");
};

export const redactLogValue = (value, maxDepth = 6) => {
  const walk = (current, depth) => {
    if (current === null || current === undefined) return current;
    if (depth > maxDepth) return "[truncated]";

    if (typeof current === "string") {
      return redactStringForLog(current);
    }

    if (Array.isArray(current)) {
      return current.map((item) => walk(item, depth + 1));
    }

    if (typeof current === "object") {
      const out = {};
      for (const [key, rawValue] of Object.entries(current)) {
        if (LOG_SENSITIVE_KEY_PATTERN.test(String(key))) {
          out[key] = "[redacted]";
        } else {
          out[key] = walk(rawValue, depth + 1);
        }
      }
      return out;
    }

    return current;
  };

  return walk(value, 0);
};

const normalizeUuid = (value) => {
  const trimmed = trimToNull(value);
  if (!trimmed) return null;
  const raw = trimmed.toLowerCase();
  if (UUID_CANONICAL_PATTERN.test(raw)) return raw;
  if (UUID_HEX_PATTERN.test(raw)) {
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  }
  return null;
};

const uuidToTraceId = (uuid) => {
  const normalized = normalizeUuid(uuid);
  return normalized ? normalized.replace(/-/g, "") : null;
};

const traceIdToUuid = (traceId) => {
  const trimmed = trimToNull(traceId);
  if (!trimmed) return null;
  const hex = trimmed.toLowerCase();
  if (!TRACEPARENT_TRACE_ID_PATTERN.test(hex)) return null;
  if (/^0{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const bytesToHex = (bytes) =>
  Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");

const generateUuidV4Fallback = () => {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      // RFC 4122 v4 variant.
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytesToHex(bytes);
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch (_err) {
    // ignore
  }
  // Last-resort deterministic shape (still UUID-format); randomness quality may be weaker but stays parseable.
  const seed = `${Date.now()}${Math.random()}${Math.random()}`.replace(/[^0-9]/g, "").padEnd(32, "0").slice(0, 32);
  return `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4000-8000-${seed.slice(20)}`;
};

export const parseTraceparent = (value) => {
  const trimmed = trimToNull(value);
  if (!trimmed) return null;
  const parts = trimmed.split("-");
  if (parts.length < 4) return null;

  const version = String(parts[0] || "").toLowerCase();
  const traceId = String(parts[1] || "").toLowerCase();
  const parentId = String(parts[2] || "").toLowerCase();
  const traceFlags = String(parts[3] || "").toLowerCase();

  if (!TRACEPARENT_VERSION_PATTERN.test(version)) return null;
  if (version === "ff") return null;
  if (!TRACEPARENT_TRACE_ID_PATTERN.test(traceId) || /^0{32}$/.test(traceId)) return null;
  if (!TRACEPARENT_SPAN_ID_PATTERN.test(parentId) || /^0{16}$/.test(parentId)) return null;
  if (!TRACEPARENT_FLAGS_PATTERN.test(traceFlags)) return null;

  // v00 forbids additional fields.
  if (version === "00" && parts.length !== 4) return null;

  return { version, traceId, parentId, traceFlags };
};

export const formatTraceparent = ({ version = "00", traceId, parentId, traceFlags = "01" }) => {
  const v = String(version || "").toLowerCase();
  const t = String(traceId || "").toLowerCase();
  const p = String(parentId || "").toLowerCase();
  const f = String(traceFlags || "").toLowerCase();
  if (!TRACEPARENT_VERSION_PATTERN.test(v) || v === "ff") return "";
  if (!TRACEPARENT_TRACE_ID_PATTERN.test(t) || /^0{32}$/.test(t)) return "";
  if (!TRACEPARENT_SPAN_ID_PATTERN.test(p) || /^0{16}$/.test(p)) return "";
  if (!TRACEPARENT_FLAGS_PATTERN.test(f)) return "";
  return `${v}-${t}-${p}-${f}`;
};

export const generateSpanId = () => {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Best-effort fallback.
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Avoid invalid all-zero IDs.
  if (bytes.every((b) => b === 0)) bytes[7] = 1;
  return bytesToHex(bytes);
};

const sanitizeTracestate = (value) => {
  const trimmed = trimToNull(value);
  if (!trimmed) return null;
  // Per W3C Trace Context: propagate at least 512 characters (combined). Clamp to be safe.
  return trimmed.length > 512 ? trimmed.slice(0, 512) : trimmed;
};

export const resolveTraceContext = (req, correlationId) => {
  const incomingTraceparent = trimToNull(req?.headers?.get?.("traceparent"));
  const parsed = parseTraceparent(incomingTraceparent);
  const tracestate = sanitizeTracestate(req?.headers?.get?.("tracestate"));

  if (parsed) {
    const spanId = generateSpanId();
    return {
      traceparent: formatTraceparent({
        version: parsed.version,
        traceId: parsed.traceId,
        parentId: spanId,
        traceFlags: parsed.traceFlags,
      }),
      tracestate,
      trace_id: parsed.traceId,
      span_id: spanId,
    };
  }

  const traceId = uuidToTraceId(correlationId) || uuidToTraceId(generateUuidV4Fallback());
  const spanId = generateSpanId();
  return {
    traceparent: formatTraceparent({
      version: "00",
      traceId,
      parentId: spanId,
      traceFlags: "01",
    }),
    tracestate,
    trace_id: traceId,
    span_id: spanId,
  };
};

export const deriveChildTraceparent = (traceparent) => {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return null;
  const spanId = generateSpanId();
  const next = formatTraceparent({
    version: parsed.version,
    traceId: parsed.traceId,
    parentId: spanId,
    traceFlags: parsed.traceFlags,
  });
  return next || null;
};

export const resolveCorrelationId = (req, fallback = "") => {
  const fromCorrelationHeader = normalizeUuid(req?.headers?.get?.("x-correlation-id"));
  if (fromCorrelationHeader) return fromCorrelationHeader;

  const fromTraceparent = parseTraceparent(req?.headers?.get?.("traceparent"));
  if (fromTraceparent) {
    const asUuid = traceIdToUuid(fromTraceparent.traceId);
    if (asUuid) return asUuid;
  }

  const fromRequestId = normalizeUuid(req?.headers?.get?.("x-request-id"));
  if (fromRequestId) return fromRequestId;

  const fallbackValue = normalizeUuid(fallback);
  if (fallbackValue) return fallbackValue;

  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return normalizeUuid(globalThis.crypto.randomUUID()) || generateUuidV4Fallback();
  }

  return generateUuidV4Fallback();
};

const normalizeErrorCode = (value, fallback = "edge.request.failed") => {
  const source = trimToNull(value) || fallback;
  return String(source)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "edge.request.failed";
};

const LOGGABLE_DATABASE_ERROR_CODES = new Set([
  "23505", "42501", "57014", "P0001",
  "PGRST116", "PGRST202", "PGRST301", "PGRST302",
]);

export const databaseErrorCodeForLog = (code) =>
  LOGGABLE_DATABASE_ERROR_CODES.has(code) ? code : null;

export const buildErrorEnvelope = ({
  status,
  code,
  message,
  correlationId,
  traceId,
  requestId,
  details,
  legacyError,
} = {}) => {
  const httpStatus = Number.isFinite(Number(status)) ? Number(status) : 500;
  const errorMessage = trimToNull(message) || "Request failed";
  const envelope = {
    code: normalizeErrorCode(code, `http_${httpStatus}`),
    message: errorMessage,
    status: httpStatus,
    correlation_id: normalizeUuid(correlationId) || null,
    trace_id: trimToNull(traceId),
    request_id: trimToNull(requestId),
    error: trimToNull(legacyError) || errorMessage,
  };

  if (details && typeof details === "object") {
    const keys = Object.keys(details);
    if (keys.length > 0) {
      envelope.details = details;
    }
  }

  return envelope;
};

export const classifyError = (error) => {
  const text = typeof error === "string"
    ? error
    : (error && typeof error === "object" && "message" in error)
      ? String(error.message || "")
      : "";
  const lowered = text.toLowerCase();

  if (lowered.includes("timeout") || lowered.includes("timed out")) return "timeout";
  if (
    lowered.includes("unauthorized") ||
    lowered.includes("forbidden") ||
    lowered.includes("not allowed") ||
    lowered.includes("missing authorization")
  ) {
    return "auth";
  }
  if (
    lowered.includes("invalid") ||
    lowered.includes("malformed") ||
    lowered.includes("validation")
  ) {
    return "validation";
  }
  if (
    lowered.includes("upstream") ||
    lowered.includes("rpc") ||
    lowered.includes("network") ||
    lowered.includes("fetch")
  ) {
    return "external_dependency";
  }
  return "unexpected";
};

const normalizeErrorForLog = (error) => {
  if (!error) return null;
  const errorType = classifyError(error);
  const rawStatus = typeof error === "object" && "status" in error ? error.status : null;
  const status = typeof rawStatus === "string" ? Number(rawStatus) : rawStatus;
  return {
    error_type: errorType,
    error_message: errorType,
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { error_status: status } : {}),
  };
};

export const buildStructuredLogRecord = (level, event, context = {}) => {
  const service =
    trimToNull(context?.service) ||
    trimToNull(readEnv("EDGE_SERVICE_NAME", ["SERVICE_NAME"])) ||
    "edge-function";
  const environment =
    trimToNull(context?.environment) ||
    trimToNull(readEnv("APP_ENV", ["ENVIRONMENT", "NODE_ENV", "DENO_ENV"])) ||
    "unknown";
  const version =
    trimToNull(context?.version) ||
    trimToNull(
      readEnv("DENO_DEPLOYMENT_ID", [
        "RELEASE_VERSION",
        "GITHUB_SHA",
        "VERCEL_GIT_COMMIT_SHA",
      ]),
    ) ||
    null;
  const correlationId =
    trimToNull(context?.correlation_id) ||
    trimToNull(context?.request_id) ||
    null;
  const requestId = trimToNull(context?.request_id) || null;
  const traceId = trimToNull(context?.trace_id) || null;
  const spanId = trimToNull(context?.span_id) || null;
  const errorContext = normalizeErrorForLog(context?.error);
  const cleanContext = { ...context };
  delete cleanContext.service;
  delete cleanContext.environment;
  delete cleanContext.version;
  delete cleanContext.trace_id;
  delete cleanContext.span_id;
  delete cleanContext.error;

  const base = {
    timestamp: new Date().toISOString(),
    level,
    event,
    environment,
    service,
    version,
    correlation_id: correlationId,
    request_id: requestId,
    ...(traceId ? { trace_id: traceId } : {}),
    ...(spanId ? { span_id: spanId } : {}),
  };

  const redacted = redactLogValue(cleanContext);
  return {
    ...base,
    ...redacted,
    ...(errorContext || {}),
  };
};

export const logStructured = (level, event, context = {}) => {
  const record = buildStructuredLogRecord(level, event, context);
  const line = JSON.stringify(record);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
  return record;
};

export const normaliseHeaders = (headers) => {
  const result = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
};

export const toResponseBody = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_err) {
    return text;
  }
};

export const normalizeHeaderKey = (key) => key?.trim().toLowerCase() ?? "";

export const extractToken = (req, options = {}) => {
  if (!req || typeof req.headers?.get !== "function") {
    return null;
  }

  const opts = options && typeof options === "object" ? options : {};
  const prefer = opts.prefer === "authorization" ? "authorization" : "webhook";
  const allowWebhookHeader = opts.allowWebhookHeader !== false;
  const allowAuthorization = opts.allowAuthorization !== false;
  const allowQueryParam = opts.allowQueryParam !== false;

  const readWebhookHeader = () => {
    if (!allowWebhookHeader) return null;
    const explicitToken = req.headers.get("x-webhook-token");
    if (explicitToken && explicitToken.trim().length > 0) {
      return explicitToken.trim();
    }
    return null;
  };

  const readAuthorizationHeader = () => {
    if (!allowAuthorization) return null;
    const authorization = req.headers.get("authorization");
    if (!authorization) return null;
    const [scheme, token] = authorization.split(" ");
    if (scheme && scheme.toLowerCase() === "bearer" && token && token.trim().length > 0) {
      return token.trim();
    }
    return null;
  };

  const readQueryParam = () => {
    if (!allowQueryParam) return null;
    try {
      const url = new URL(req.url);
      const token = url.searchParams.get("token");
      if (token && token.trim().length > 0) {
        return token.trim();
      }

      // Support token in path for webhook receiver style routes:
      // /functions/v1/webhook-receiver/<token>
      const parts = url.pathname.split("/").filter(Boolean);
      const webhookIdx = parts.indexOf("webhook-receiver");
      if (webhookIdx !== -1 && parts.length > webhookIdx + 1) {
        const pathToken = parts[webhookIdx + 1];
        if (pathToken && pathToken.trim().length > 0) {
          return decodeURIComponent(pathToken).trim();
        }
      }
    } catch (_err) {
      // ignore malformed URLs
    }
    return null;
  };

  const orderedReaders = prefer === "authorization"
    ? [readAuthorizationHeader, readWebhookHeader, readQueryParam]
    : [readWebhookHeader, readAuthorizationHeader, readQueryParam];

  for (const reader of orderedReaders) {
    const token = reader();
    if (token) return token;
  }

  return null;
};

const decodeJwtPart = (value) => {
  if (!value) return "";
  try {
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const padLen = normalized.length % 4;
    const padded = padLen === 0 ? normalized : normalized + "=".repeat(4 - padLen);
    return atob(padded);
  } catch (_err) {
    return "";
  }
};

export const decodeJwtPayload = (token) => {
  if (!token) return null;
  const parts = String(token).split(".");
  if (parts.length < 2) return null;
  try {
    const payloadText = decodeJwtPart(parts[1] ?? "");
    return payloadText ? JSON.parse(payloadText) : null;
  } catch (_err) {
    return null;
  }
};

export const getJwtRole = (token) => {
  const payload = decodeJwtPayload(token);
  const role = payload?.role ?? payload?.user_role ?? null;
  return typeof role === "string" ? role : null;
};

const trimToEmpty = (value) => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const isJwtLikeKey = (value) => {
  const token = trimToEmpty(value);
  return Boolean(token) && token.split(".").length === 3;
};

const formatRpcAuthAttempt = ({ apiKey, authorization, label }) => {
  const headers = {
    "content-type": "application/json",
    prefer: "tx=commit",
  };

  const key = trimToEmpty(apiKey);
  if (key) {
    headers.apikey = key;
  }

  const bearer = trimToEmpty(authorization);
  if (bearer) {
    headers.authorization = bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}`;
  }

  return {
    label: String(label || "rpc_auth_attempt").trim() || "rpc_auth_attempt",
    headers,
  };
};

export const isRetryableRpcAuthError = (status, body) => {
  const code = Number(status || 0);
  // PostgREST documents 401; retain the existing 403 transport compatibility.
  if (code !== 401 && code !== 403) return false;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  // Never promote permission/business errors based on words in their diagnostics.
  return ["PGRST301", "PGRST302", "PGRST303"].includes(body.code);
};

export const buildRpcAuthAttempts = ({
  dbJwt = "",
  secretKey = "",
  serviceRoleKey = "",
  anonKey = "",
} = {}) => {
  const attempts = [];
  const seen = new Set();
  const addAttempt = (label, apiKey, authorization = "") => {
    const key = trimToEmpty(apiKey);
    const bearer = trimToEmpty(authorization);
    const dedupeKey = `${key}::${bearer}`;
    if (!key || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    attempts.push(formatRpcAuthAttempt({ label, apiKey: key, authorization: bearer }));
  };

  const jwtCandidate = trimToEmpty(dbJwt);
  if (isJwtLikeKey(jwtCandidate)) {
    addAttempt("db_jwt", jwtCandidate, jwtCandidate);
  }

  const explicitSecret = trimToEmpty(secretKey);
  if (explicitSecret) {
    if (isJwtLikeKey(explicitSecret)) {
      addAttempt("secret_jwt", explicitSecret, explicitSecret);
    } else {
      addAttempt("secret_key", explicitSecret);
    }
  }

  const serviceCandidate = trimToEmpty(serviceRoleKey);
  if (serviceCandidate) {
    if (isJwtLikeKey(serviceCandidate)) {
      addAttempt("service_role_jwt", serviceCandidate, serviceCandidate);
    } else {
      addAttempt("service_role_key", serviceCandidate);
    }
  }

  const anonCandidate = trimToEmpty(anonKey);
  if (anonCandidate) {
    if (isJwtLikeKey(anonCandidate)) {
      addAttempt("anon_jwt", anonCandidate, anonCandidate);
    } else {
      addAttempt("anon_key", anonCandidate);
    }
  }

  return attempts;
};

const parseBooleanPolicyValue = (value) => {
  const normalized = trimToEmpty(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
};

export const resolveIngressDbAuth = ({
  dbJwt = "", secretKey = "", serviceRoleKey = "",
  requireDbJwt = "", allowServiceRoleFallback = "",
} = {}) => {
  const requirePolicy = parseBooleanPolicyValue(requireDbJwt);
  const dbJwtRequired = requirePolicy === null ? true : requirePolicy;
  const breakglassRequested = parseBooleanPolicyValue(allowServiceRoleFallback) === true;
  const serviceRoleFallbackAllowed = !dbJwtRequired && breakglassRequested;
  const authAttempts = buildRpcAuthAttempts({
    dbJwt,
    secretKey: dbJwtRequired ? "" : secretKey,
    serviceRoleKey: serviceRoleFallbackAllowed ? serviceRoleKey : "",
  });
  return {
    dbJwtRequired, serviceRoleFallbackAllowed, authAttempts,
    internalJwt: trimToEmpty(dbJwt) || (serviceRoleFallbackAllowed ? trimToEmpty(serviceRoleKey) : ""),
  };
};

export const invokeSupabaseRpcWithAuthFallback = async ({
  url,
  body,
  authAttempts = [],
  fetchInit = {},
  schema = "api",
  timeoutMs = 0,
} = {}) => {
  const rpcUrl = trimToEmpty(url);
  const attempts = Array.isArray(authAttempts) ? authAttempts.filter(Boolean) : [];
  const rpcSchema = trimToEmpty(schema);
  if (!rpcUrl) {
    throw new Error("invokeSupabaseRpcWithAuthFallback requires a url");
  }
  if (!attempts.length) {
    throw new Error("invokeSupabaseRpcWithAuthFallback requires authAttempts");
  }

  let lastResult = null;
  for (const attempt of attempts) {
    const headers = new Headers(fetchInit.headers || {});
    if (rpcSchema) {
      headers.set("accept-profile", rpcSchema);
      headers.set("content-profile", rpcSchema);
    }
    for (const [key, value] of Object.entries(attempt.headers || {})) {
      if (value !== undefined && value !== null && String(value).length > 0) {
        headers.set(key, String(value));
      }
    }

    const numericTimeoutMs = Number(timeoutMs || 0);
    const shouldTimeout = Number.isFinite(numericTimeoutMs) && numericTimeoutMs > 0 && !fetchInit.signal;
    const controller = shouldTimeout ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), numericTimeoutMs)
      : null;
    let response;
    try {
      response = await fetch(rpcUrl, {
        ...fetchInit,
        ...(controller ? { signal: controller.signal } : {}),
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      const isAbort =
        controller?.signal?.aborted ||
        error?.name === "AbortError" ||
        /abort/i.test(String(error?.message ?? ""));
      if (isAbort) {
        return {
          ok: false,
          attempted: attempt,
          response: null,
          body: {
            code: "edge_rpc_timeout",
            message: `RPC request timed out after ${numericTimeoutMs}ms`,
          },
          authRetry: false,
          timedOut: true,
        };
      }
      throw error;
    }
    if (timer) clearTimeout(timer);
    const responseBody = await toResponseBody(response);
    lastResult = { attempt, response, body: responseBody };
    if (response.ok) {
      return {
        ok: true,
        attempted: attempt,
        response,
        body: responseBody,
        authRetry: false,
      };
    }
    if (!isRetryableRpcAuthError(response.status, responseBody)) {
      return {
        ok: false,
        attempted: attempt,
        response,
        body: responseBody,
        authRetry: false,
      };
    }
  }

  return {
    ok: false,
    attempted: lastResult?.attempt ?? null,
    response: lastResult?.response ?? null,
    body: lastResult?.body ?? null,
    authRetry: Boolean(lastResult),
  };
};

export const parseRequestBody = async (req) => {
  const raw = await req.text();
  if (!raw) {
    return { raw: "", json: {} };
  }

  try {
    const json = JSON.parse(raw);
    if (json && typeof json === "object") {
      return { raw, json };
    }
    return { raw, json: { value: json } };
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${error.message}`);
  }
};

const normalizeAudience = (value) => {
  if (typeof value === "string") return [value.trim().toLowerCase()].filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean);
};

// Claim defense only: the native Supabase verify_jwt gate owns signature verification.
export const validateInternalEdgeClaims = (claims, role, options = {}) => {
  const nowSeconds = Number.isFinite(options.nowSeconds)
    ? Number(options.nowSeconds)
    : Math.floor(Date.now() / 1000);
  const expiresAt = Number(claims.exp);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds) {
    return { ok: false, status: 401, message: "Expired Authorization token" };
  }

  if (claims.nbf !== undefined && claims.nbf !== null) {
    const notBefore = Number(claims.nbf);
    if (!Number.isFinite(notBefore) || notBefore > nowSeconds) {
      return { ok: false, status: 401, message: "Authorization token not active" };
    }
  }

  const audiences = normalizeAudience(claims.aud);
  const subject = String(claims.sub || "").trim().toLowerCase();
  if (role === "service_role") {
    if (audiences.length > 0 && !audiences.includes("authenticated")) {
      return { ok: false, status: 403, message: "Invalid audience claim" };
    }
    if (subject && subject !== "edge-function") {
      return { ok: false, status: 403, message: "Invalid subject claim" };
    }
  } else {
    if (!audiences.includes("authenticated")) {
      return { ok: false, status: 403, message: "Invalid audience claim" };
    }
    if (subject !== "edge-function") {
      return { ok: false, status: 403, message: "Invalid subject claim" };
    }
  }

  return { ok: true };
};
