const DEFAULT_ALLOWED_HEADERS = [
  "authorization",
  "x-client-info",
  "apikey",
  "content-type",
];
const DEFAULT_ALLOWED_METHODS = "GET, POST, OPTIONS";
const DEFAULT_EXPOSED_HEADERS = [
  "x-correlation-id",
  "traceparent",
  "tracestate",
];
const ACCESS_CONTROL_HEADER_PREFIX = "access-control-";
const CORS_VARY = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";

const normalizeOrigin = (value) => {
  if (typeof value !== "string") return "*";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "*";
};

const normalizeRequestedHeaders = (value) => {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
};

export const buildCorsHeaders = (req) => {
  const origin = normalizeOrigin(req?.headers?.get?.("origin"));
  const requestedHeaders = normalizeRequestedHeaders(
    req?.headers?.get?.("access-control-request-headers"),
  );
  const allowedHeaders = Array.from(
    new Set([...DEFAULT_ALLOWED_HEADERS, ...requestedHeaders]),
  ).join(", ");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": allowedHeaders,
    "Access-Control-Allow-Methods": DEFAULT_ALLOWED_METHODS,
    "Access-Control-Max-Age": "86400",
    Vary: CORS_VARY,
  };
};

const normalizeList = (value, fallback = []) => {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const normalized = source
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : [...fallback];
};

const normalizeMethods = (value) => {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const normalized = source
    .map((entry) => String(entry || "").trim().toUpperCase())
    .filter(Boolean);
  return normalized.length > 0
    ? normalized
    : DEFAULT_ALLOWED_METHODS.split(",").map((entry) => entry.trim());
};

const parseExactOrigin = (value) => {
  const raw = String(value || "").trim();
  if (!raw || raw === "*") return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    if (raw !== parsed.origin) return null;
    return parsed;
  } catch {
    return null;
  }
};

const normalizeHostname = (value) => {
  let hostname = String(value || "").trim().toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  return hostname.replace(/\.+$/, "");
};

const isIpv4Loopback = (hostname) => {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const values = octets.map(Number);
  return values.every((part) => part >= 0 && part <= 255) && values[0] === 127;
};

const isIpv4MappedLoopback = (hostname) => {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(hostname)?.[1];
  if (dotted) return isIpv4Loopback(dotted);
  const matched = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  if (!matched) return false;
  const highWord = Number.parseInt(matched[1], 16);
  const lowWord = Number.parseInt(matched[2], 16);
  return highWord <= 0xffff && lowWord <= 0xffff && (highWord >> 8) === 127;
};

export const isLoopbackHostname = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.endsWith("..")) return false;
  if ((raw.startsWith("[") && !raw.endsWith("]")) || (!raw.startsWith("[") && raw.endsWith("]"))) {
    return false;
  }
  const hostname = normalizeHostname(raw);
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isIpv4Loopback(hostname) ||
    hostname === "::1" ||
    isIpv4MappedLoopback(hostname)
  );
};

const isLoopbackRequestUrl = (req) => {
  try {
    return isLoopbackHostname(new URL(req?.url).hostname);
  } catch {
    return false;
  }
};

export const parseCorsOriginAllowlist = (value, { localOnly = false } = {}) => {
  const origins = new Set();
  const invalid = [];
  const entries = Array.isArray(value) ? value : String(value || "").split(",");

  for (const entry of entries) {
    const raw = String(entry || "").trim();
    if (!raw) continue;
    const parsed = parseExactOrigin(raw);
    const local = parsed ? isLoopbackHostname(parsed.hostname) : false;
    const valid = Boolean(
      parsed &&
        (localOnly ? local : parsed.protocol === "https:" && !local),
    );
    if (!valid) {
      invalid.push(raw);
      continue;
    }
    origins.add(parsed.origin);
  }

  return { origins, invalid };
};

export const resolveCorsPolicy = (req, {
  hostedAllowedOrigins = "",
  localAllowedOrigins = "",
  allowedMethods = DEFAULT_ALLOWED_METHODS,
  allowedHeaders = DEFAULT_ALLOWED_HEADERS,
  exposedHeaders = DEFAULT_EXPOSED_HEADERS,
} = {}) => {
  const hosted = parseCorsOriginAllowlist(hostedAllowedOrigins);
  const local = parseCorsOriginAllowlist(localAllowedOrigins, { localOnly: true });
  const configuredHeaders = normalizeList(allowedHeaders, DEFAULT_ALLOWED_HEADERS);
  const configuredHeaderSet = new Set(configuredHeaders);
  const configuredMethods = Array.from(new Set(normalizeMethods(allowedMethods)));
  const configuredMethodSet = new Set(configuredMethods);
  const exposed = Array.from(
    new Set(normalizeList(exposedHeaders, DEFAULT_EXPOSED_HEADERS)),
  );
  const originRaw = req?.headers?.get?.("origin")?.trim() || "";
  const requestOrigin = originRaw ? parseExactOrigin(originRaw) : null;
  const requestedMethod = String(
    req?.headers?.get?.("access-control-request-method") || req?.method || "",
  ).trim().toUpperCase();
  const requestedHeaders = normalizeRequestedHeaders(
    req?.headers?.get?.("access-control-request-headers"),
  );
  const configurationValid = hosted.invalid.length === 0 && local.invalid.length === 0;
  const localQaAllowed = isLoopbackRequestUrl(req);
  const originAllowed = Boolean(
    requestOrigin &&
      configurationValid &&
      (hosted.origins.has(requestOrigin.origin) ||
        (localQaAllowed && local.origins.has(requestOrigin.origin))),
  );
  const methodAllowed = !requestedMethod || configuredMethodSet.has(requestedMethod);
  const headersAllowed = requestedHeaders.every((header) => configuredHeaderSet.has(header));
  const isCorsRequest = originRaw.length > 0;
  const allowed = isCorsRequest && originAllowed && methodAllowed && headersAllowed;
  const headers = { Vary: CORS_VARY };

  if (allowed) {
    headers["Access-Control-Allow-Origin"] = requestOrigin.origin;
    headers["Access-Control-Allow-Headers"] = configuredHeaders.join(", ");
    headers["Access-Control-Allow-Methods"] = configuredMethods.join(", ");
    headers["Access-Control-Expose-Headers"] = exposed.join(", ");
    headers["Access-Control-Max-Age"] = "86400";
  }

  let reason = "allowed";
  if (!isCorsRequest) reason = "not_cors";
  else if (!configurationValid) reason = "invalid_configuration";
  else if (!requestOrigin) reason = "invalid_origin";
  else if (!originAllowed) reason = "origin_not_allowed";
  else if (!methodAllowed) reason = "method_not_allowed";
  else if (!headersAllowed) reason = "headers_not_allowed";

  return {
    allowed,
    configurationValid,
    headers,
    isCorsRequest,
    localQaAllowed,
    reason,
  };
};

// Browser-only facades require an Origin and explicit, configured local QA authority.
// Generic machine ingress continues to use resolveCorsPolicy directly.
export const resolveBrowserCorsPolicy = (req, {
  hostedAllowedOrigins = "",
  localAllowedOrigins = "",
  localQaEnabled = false,
  allowedMethods = DEFAULT_ALLOWED_METHODS,
  allowedHeaders = ["accept", "content-type", "authorization", "apikey", "x-client-info"],
} = {}) => {
  const localOrigins = localQaEnabled === true ? localAllowedOrigins : "";
  const policy = resolveCorsPolicy(req, {
    hostedAllowedOrigins, localAllowedOrigins: localOrigins, allowedMethods, allowedHeaders,
  });
  const hosted = parseCorsOriginAllowlist(hostedAllowedOrigins);
  const local = parseCorsOriginAllowlist(localOrigins, { localOnly: true });
  const origin = req?.headers?.get?.("origin")?.trim() || "";
  const localContext = Boolean(
    localQaEnabled === true && policy.allowed && policy.localQaAllowed && local.origins.has(origin),
  );
  const headers = { ...policy.headers };
  const denied = (status, code, message) => ({
    ok: false, origin, localContext: false, status,
    body: { ok: false, error: { code, ...(message ? { message } : {}) } },
    headers,
  });
  if (!policy.configurationValid) {
    return denied(500, "server_misconfigured", "cors_allowlist_invalid");
  }
  if (!hosted.origins.size && !local.origins.size) {
    return denied(500, "server_misconfigured", "cors_allowlist_missing");
  }
  if (!policy.isCorsRequest) return denied(403, "origin_required");
  if (!policy.allowed) {
    if (policy.reason === "method_not_allowed") {
      return denied(req.method === "OPTIONS" ? 403 : 405, "method_not_allowed");
    }
    if (policy.reason === "headers_not_allowed") return denied(403, "headers_not_allowed");
    return denied(403, "origin_not_allowed");
  }
  headers["Access-Control-Max-Age"] = "600";
  return { ok: true, origin, localContext, headers };
};

const mergeVaryValues = (...values) => {
  const merged = new Map();
  for (const value of values) {
    for (const entry of String(value || "").split(",")) {
      const normalized = entry.trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (!merged.has(key)) merged.set(key, normalized);
    }
  }
  if (merged.has("*")) return "*";
  return Array.from(merged.values()).join(", ");
};

// The edge ingress policy is authoritative for CORS response fields, while
// Vary remains a union so upstream cache dimensions are never discarded.
export const applyCorsHeaders = (headers, corsHeaders = {}) => {
  const out = new Headers(headers);
  const cors = new Headers(corsHeaders);
  const existingVary = out.get("vary");
  const corsVary = cors.get("vary");

  for (const key of Array.from(out.keys())) {
    if (key.toLowerCase().startsWith(ACCESS_CONTROL_HEADER_PREFIX)) {
      out.delete(key);
    }
  }

  for (const [key, value] of cors.entries()) {
    if (key.toLowerCase() === "vary") continue;
    out.set(key, value);
  }

  const mergedVary = mergeVaryValues(existingVary, CORS_VARY, corsVary);
  if (mergedVary) out.set("vary", mergedVary);
  return out;
};

export const withCorsJson = (status, body, corsHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json",
    },
  });
