const DEFAULT_TOKEN_PATH_SEGMENT = 't';

const isTruthy = (value) => /^(1|true|yes)$/i.test(String(value || '').trim());

const parseCsv = (value) =>
  String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const resolveCorsAllowOrigin = (request, env) => {
  const origin = String(request.headers.get('origin') || '').trim();
  if (!origin) return null;

  const rawAllow = String(env.CORS_ALLOW_ORIGINS ?? env.CORS_ALLOW_ORIGIN ?? '').trim();
  if (!rawAllow) return null;

  if (rawAllow === '*') return '*';

  const allowlist = parseCsv(rawAllow);
  return allowlist.includes(origin) ? origin : null;
};

const corsHeadersFor = (request, env) => {
  const allowOrigin = resolveCorsAllowOrigin(request, env);
  if (!allowOrigin) return null;

  const exposeHeaders = String(env.CORS_EXPOSE_HEADERS || 'x-correlation-id,traceparent')
    .trim()
    .replace(/\s+/g, '');

  const headers = {
    'access-control-allow-origin': allowOrigin,
    ...(exposeHeaders ? { 'access-control-expose-headers': exposeHeaders } : {}),
  };

  if (allowOrigin !== '*') headers.vary = 'origin';

  if (isTruthy(env.CORS_ALLOW_CREDENTIALS)) {
    if (allowOrigin === '*') {
      throw new Error(
        'Invalid CORS config: CORS_ALLOW_CREDENTIALS requires an explicit origin allowlist.'
      );
    }
    headers['access-control-allow-credentials'] = 'true';
  }

  return headers;
};

const withCors = (request, env, response) => {
  let cors;
  try {
    cors = corsHeadersFor(request, env);
  } catch (err) {
    const correlationId = resolveCorrelationId(request);
    const trace = resolveTraceContext(request, correlationId);
    return jsonError({
      status: 500,
      error: err.message || 'Invalid CORS configuration.',
      correlationId,
      traceparent: trace.traceparent,
      tracestate: trace.tracestate,
    });
  }

  if (!cors) return response;
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(cors)) {
    if (!v) continue;
    out.headers.set(k, v);
  }
  return out;
};

const withHeaders = (response, headers) => {
  if (!headers || typeof headers !== 'object') return response;
  const entries = Object.entries(headers).filter(([, v]) => v !== null && v !== undefined && String(v).length);
  if (!entries.length) return response;
  const out = new Response(response.body, response);
  for (const [k, v] of entries) {
    out.headers.set(String(k).toLowerCase(), String(v));
  }
  return out;
};

const deprecationHeadersForAuthSource = (authSource) => {
  if (authSource !== 'query' && authSource !== 'path') return null;
  return {
    deprecation: 'true',
    'x-masarx-deprecated-auth': authSource === 'path' ? 'path-token' : 'EXAMPLE_PASSWORD',
  };
};

const jsonError = ({ status, error, correlationId, traceparent, tracestate }) => {
  const body = { error };
  if (correlationId) body.correlation_id = correlationId;
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  };
  if (correlationId) headers['x-correlation-id'] = correlationId;
  if (traceparent) headers.traceparent = traceparent;
  if (tracestate) headers.tracestate = tracestate;
  return new Response(JSON.stringify(body), { status, headers });
};

const buildHealthResponse = (request) => {
  const correlationId = resolveCorrelationId(request);
  const trace = resolveTraceContext(request, correlationId);
  const payload = JSON.stringify({
    ok: true,
    service: 'masarx-api-ingress-worker',
  });
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-correlation-id': correlationId,
    traceparent: trace.traceparent,
  };
  if (trace.tracestate) headers.tracestate = trace.tracestate;
  const isHead = String(request.method || '').toUpperCase() === 'HEAD';
  return new Response(isHead ? null : payload, {
    status: 200,
    headers,
  });
};

const UUID_CANONICAL_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/i;
const TRACEPARENT_VERSION_PATTERN = /^[0-9a-f]{2}$/i;
const TRACEPARENT_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const TRACEPARENT_SPAN_ID_PATTERN = /^[0-9a-f]{16}$/i;
const TRACEPARENT_FLAGS_PATTERN = /^[0-9a-f]{2}$/i;

const normalizeUuid = (value) => {
  const trimmed = String(value || '').trim();
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
  return normalized ? normalized.replace(/-/g, '') : null;
};

const traceIdToUuid = (traceId) => {
  const trimmed = String(traceId || '').trim();
  if (!trimmed) return null;
  const hex = trimmed.toLowerCase();
  if (!TRACEPARENT_TRACE_ID_PATTERN.test(hex) || /^0{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const bytesToHex = (bytes) =>
  Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');

const generateUuidV4Fallback = () => {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytesToHex(bytes);
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch {
    // ignore
  }
  const seed = `${Date.now()}${Math.random()}${Math.random()}`.replace(/[^0-9]/g, '').padEnd(32, '0').slice(0, 32);
  return `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4000-8000-${seed.slice(20)}`;
};

const parseTraceparent = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const parts = trimmed.split('-');
  if (parts.length < 4) return null;

  const version = String(parts[0] || '').toLowerCase();
  const traceId = String(parts[1] || '').toLowerCase();
  const parentId = String(parts[2] || '').toLowerCase();
  const traceFlags = String(parts[3] || '').toLowerCase();

  if (!TRACEPARENT_VERSION_PATTERN.test(version) || version === 'ff') return null;
  if (!TRACEPARENT_TRACE_ID_PATTERN.test(traceId) || /^0{32}$/.test(traceId)) return null;
  if (!TRACEPARENT_SPAN_ID_PATTERN.test(parentId) || /^0{16}$/.test(parentId)) return null;
  if (!TRACEPARENT_FLAGS_PATTERN.test(traceFlags)) return null;
  if (version === '00' && parts.length !== 4) return null;

  return { version, traceId, parentId, traceFlags };
};

const formatTraceparent = ({ version = '00', traceId, parentId, traceFlags = '01' }) => {
  const v = String(version || '').toLowerCase();
  const t = String(traceId || '').toLowerCase();
  const p = String(parentId || '').toLowerCase();
  const f = String(traceFlags || '').toLowerCase();
  if (!TRACEPARENT_VERSION_PATTERN.test(v) || v === 'ff') return '';
  if (!TRACEPARENT_TRACE_ID_PATTERN.test(t) || /^0{32}$/.test(t)) return '';
  if (!TRACEPARENT_SPAN_ID_PATTERN.test(p) || /^0{16}$/.test(p)) return '';
  if (!TRACEPARENT_FLAGS_PATTERN.test(f)) return '';
  return `${v}-${t}-${p}-${f}`;
};

const generateSpanId = () => {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  if (bytes.every((b) => b === 0)) bytes[7] = 1;
  return bytesToHex(bytes);
};

const sanitizeTracestate = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  return trimmed.length > 512 ? trimmed.slice(0, 512) : trimmed;
};

const resolveTraceContext = (req, correlationId) => {
  const parsed = parseTraceparent(req.headers.get('traceparent'));
  const tracestate = sanitizeTracestate(req.headers.get('tracestate'));
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
      traceId: parsed.traceId,
      spanId,
    };
  }
  const traceId = uuidToTraceId(correlationId) || uuidToTraceId(generateCorrelationId());
  const spanId = generateSpanId();
  return {
    traceparent: formatTraceparent({ version: '00', traceId, parentId: spanId, traceFlags: '01' }),
    tracestate,
    traceId,
    spanId,
  };
};

const readCorrelationId = (req) => {
  const explicit = req.headers.get('x-correlation-id') || req.headers.get('x-request-id');
  return normalizeUuid(explicit);
};

const generateCorrelationId = () => {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      const uuid = globalThis.crypto.randomUUID();
      return normalizeUuid(uuid) || generateUuidV4Fallback();
    }
  } catch {
    // ignore
  }
  return generateUuidV4Fallback();
};

const resolveCorrelationId = (req) => {
  const direct = readCorrelationId(req);
  if (direct) return direct;
  const parsed = parseTraceparent(req.headers.get('traceparent'));
  if (parsed) {
    const asUuid = traceIdToUuid(parsed.traceId);
    if (asUuid) return asUuid;
  }
  return generateCorrelationId();
};

const sanitizeToken = (raw) => {
  const token = String(raw || '').trim();
  if (!token) return null;
  if (token.includes('\n') || token.includes('\r')) return null;
  return token;
};

const base64Decode = (value) => {
  if (!value) return '';
  try {
    if (typeof atob === 'function') return atob(value);
  } catch {
    // fall through
  }
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
};

const extractTokenFromPath = (url, tokenPathSegment) => {
  const seg = String(tokenPathSegment || DEFAULT_TOKEN_PATH_SEGMENT).trim();
  if (!seg) return null;
  const prefix = `/${seg}/`;
  if (!url.pathname.startsWith(prefix)) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] !== seg) return null;

  const token = sanitizeToken(decodeURIComponent(parts[1] || ''));
  if (!token) return null;

  const remainder = parts.slice(2).join('/');
  const strippedPath = `/${remainder}`;

  return {
    token,
    source: 'path',
    strippedPath: strippedPath === '/undefined' || strippedPath === '/' ? '/' : strippedPath,
  };
};

const extractTokenFromHeaders = (req, { allowApiKeyHeader, allowBasicToken }) => {
  const webhookToken = sanitizeToken(req.headers.get('x-webhook-token'));
  if (webhookToken) return { token: webhookToken, source: 'x-webhook-token' };

  if (allowApiKeyHeader) {
    const apiKey = sanitizeToken(req.headers.get('x-api-key'));
    if (apiKey) return { token: apiKey, source: 'x-api-key' };
  }

  const authorization = String(req.headers.get('authorization') || '').trim();
  if (!authorization) return null;
  const [schemeRaw, rest] = authorization.split(/\s+/, 2);
  const scheme = String(schemeRaw || '').trim().toLowerCase();

  if (scheme === 'bearer') {
    const bearer = sanitizeToken(rest);
    if (bearer) return { token: bearer, source: 'authorization' };
    return null;
  }

  if (scheme === 'basic' && allowBasicToken) {
    const decoded = base64Decode(rest || '');
    const [username] = decoded.split(':', 2);
    const basicToken = sanitizeToken(username);
    if (basicToken) return { token: basicToken, source: 'basic' };
  }

  return null;
};

const extractTokenFromQuery = (url) => {
  const queryToken = sanitizeToken(url.searchParams.get('token'));
  if (!queryToken) return null;
  url.searchParams.delete('token');
  return { token: queryToken, source: 'query' };
};

const validateRewriteRule = (rule, index) => {
  if (!rule || typeof rule !== 'object') {
    throw new Error(`Rewrite rule #${index} must be an object.`);
  }
  const from = String(rule.from || '').trim();
  const to = String(rule.to || '').trim();
  if (!from || !to) {
    throw new Error(`Rewrite rule #${index} must include non-empty 'from' and 'to'.`);
  }
  if (!from.startsWith('/') || !to.startsWith('/')) {
    throw new Error(`Rewrite rule #${index} 'from' and 'to' must start with '/'.`);
  }
  const fromSegs = from.split('/').filter(Boolean);
  const toSegs = to.split('/').filter(Boolean);
  if (fromSegs.includes('..') || toSegs.includes('..')) {
    throw new Error(`Rewrite rule #${index} must not contain '..' segments.`);
  }
  const match = String(rule.match || 'prefix').trim().toLowerCase();
  if (!['prefix', 'exact'].includes(match)) {
    throw new Error(`Rewrite rule #${index} match must be 'prefix' or 'exact'.`);
  }

  const requireToken =
    typeof rule.require_token === 'boolean'
      ? rule.require_token
      : (typeof rule.requireToken === 'boolean' ? rule.requireToken : true);

  return { from, to, match, requireToken };
};

const loadRewriteRules = (env) => {
  const raw = env.REWRITE_RULES_JSON ?? env.REWRITE_RULES;
  if (!raw) {
    throw new Error('Missing required env REWRITE_RULES_JSON.');
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error('Invalid REWRITE_RULES_JSON (must be valid JSON).');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Invalid REWRITE_RULES_JSON (must be a JSON array).');
  }

  return parsed.map(validateRewriteRule);
};

const joinPath = (prefix, remainder) => {
  const p = String(prefix || '').trim();
  const r = String(remainder || '');
  const left = p.endsWith('/') ? p.slice(0, -1) : p;
  const right = r.startsWith('/') ? r : `/${r}`;
  return `${left}${right}`.replace(/\/{2,}/g, '/');
};

const matchRule = (pathname, rule) => {
  if (rule.match === 'exact') return pathname === rule.from;
  return pathname.startsWith(rule.from);
};

const resolveBestRule = (pathname, rules) => {
  let best = null;
  for (const rule of rules) {
    if (!matchRule(pathname, rule)) continue;
    if (!best) {
      best = rule;
      continue;
    }
    const bestExact = best.match === 'exact';
    const candidateExact = rule.match === 'exact';
    if (candidateExact && !bestExact) {
      best = rule;
      continue;
    }
    if (candidateExact === bestExact && rule.from.length > best.from.length) {
      best = rule;
    }
  }
  return best;
};

const applyRule = (pathname, rule) => {
  if (rule.match === 'exact') return rule.to;
  const remainder = pathname.slice(rule.from.length);
  return joinPath(rule.to, remainder);
};

export const resolveIngress = (request, env) => {
  const correlationId = resolveCorrelationId(request);
  const trace = resolveTraceContext(request, correlationId);
  const upstreamOrigin = String(env.UPSTREAM_ORIGIN || env.SUPABASE_URL || '').trim();
  if (!upstreamOrigin) {
    return {
      response: jsonError({
        status: 500,
        error: 'Missing required env UPSTREAM_ORIGIN (or SUPABASE_URL).',
        correlationId,
        traceparent: trace.traceparent,
        tracestate: trace.tracestate,
      }),
      authSource: null,
    };
  }

  let upstreamBase;
  try {
    upstreamBase = new URL(upstreamOrigin);
  } catch {
    return {
      response: jsonError({
        status: 500,
        error: 'Invalid UPSTREAM_ORIGIN (must be a valid URL origin).',
        correlationId,
        traceparent: trace.traceparent,
        tracestate: trace.tracestate,
      }),
      authSource: null,
    };
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return {
      response: jsonError({
        status: 400,
        error: 'Malformed URL.',
        correlationId,
        traceparent: trace.traceparent,
        tracestate: trace.tracestate,
      }),
      authSource: null,
    };
  }

  let rules;
  try {
    rules = loadRewriteRules(env);
  } catch (err) {
    return {
      response: jsonError({
        status: 500,
        error: err.message || 'Invalid rewrite rules.',
        correlationId,
        traceparent: trace.traceparent,
        tracestate: trace.tracestate,
      }),
    };
  }

  const tokenPathSegment = String(env.TOKEN_PATH_SEGMENT || DEFAULT_TOKEN_PATH_SEGMENT).trim();
  const allowQueryToken = isTruthy(env.ALLOW_QUERY_TOKEN);
  const allowBasicToken = isTruthy(env.ALLOW_BASIC_TOKEN);
  const allowApiKeyHeader = env.ALLOW_API_KEY_HEADER === undefined ? true : isTruthy(env.ALLOW_API_KEY_HEADER);

  const tokenFromPath = extractTokenFromPath(url, tokenPathSegment);
  if (tokenFromPath) {
    url.pathname = tokenFromPath.strippedPath;
  }

  const tokenFromHeaders = tokenFromPath
    ? null
    : extractTokenFromHeaders(request, { allowApiKeyHeader, allowBasicToken });
  const tokenFromQuery = (tokenFromPath || tokenFromHeaders || !allowQueryToken)
    ? null
    : extractTokenFromQuery(url);

  const tokenInfo = tokenFromPath || tokenFromHeaders || tokenFromQuery;
  const token = tokenInfo ? tokenInfo.token : null;
  const authSource = tokenInfo ? tokenInfo.source : null;

  const matched = resolveBestRule(url.pathname, rules);
  if (!matched) {
    return {
      response: jsonError({
        status: 404,
        error: 'Not found.',
        correlationId,
        traceparent: trace.traceparent,
        tracestate: trace.tracestate,
      }),
      authSource,
    };
  }

  if (matched.requireToken && !token) {
    return {
      response: jsonError({
        status: 401,
        error: 'Missing token.',
        correlationId,
        traceparent: trace.traceparent,
        tracestate: trace.tracestate,
      }),
      authSource,
    };
  }

  const rewrittenPath = applyRule(url.pathname, matched);

  const upstreamUrl = new URL(upstreamBase.toString());
  upstreamUrl.pathname = rewrittenPath;
  upstreamUrl.search = url.search;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('keep-alive');
  headers.delete('proxy-authenticate');
  headers.delete('proxy-authorization');
  headers.delete('te');
  headers.delete('trailer');
  headers.delete('transfer-encoding');
  headers.delete('upgrade');
  headers.set('x-correlation-id', correlationId);
  headers.set('traceparent', trace.traceparent);
  if (trace.tracestate) headers.set('tracestate', trace.tracestate);
  if (authSource) headers.set('x-masarx-auth-source', authSource);

  // If the token came from the URL (path/query) or non-standard headers, normalize it to x-webhook-token.
  if (token && ['path', 'query', 'x-api-key', 'basic'].includes(authSource)) {
    headers.set('x-webhook-token', token);
  }

  if (authSource === 'x-api-key') {
    headers.delete('x-api-key');
  }

  const preserveAuthorization = isTruthy(env.PRESERVE_AUTHORIZATION_HEADER);
  if (authSource === 'basic') {
    headers.delete('authorization');
  } else if (!preserveAuthorization && authSource && authSource !== 'authorization') {
    headers.delete('authorization');
  }

  const preserveCookies = isTruthy(env.PRESERVE_COOKIE_HEADERS);
  if (!preserveCookies) {
    headers.delete('cookie');
  }

  const upstreamRequest = new Request(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
  });

  return { upstreamUrl: upstreamUrl.toString(), upstreamRequest, authSource };
};

export default {
  async fetch(request, env) {
    let requestUrl = null;
    try {
      requestUrl = new URL(request.url);
    } catch {
      // Keep malformed URL behavior on the shared resolver path.
    }

    const method = String(request.method || '').toUpperCase();
    if (requestUrl && requestUrl.pathname === '/healthz' && (method === 'GET' || method === 'HEAD')) {
      return withCors(request, env, buildHealthResponse(request));
    }

    if (request.method === 'OPTIONS') {
      let base;
      try {
        base = corsHeadersFor(request, env);
      } catch (err) {
        const correlationId = resolveCorrelationId(request);
        const trace = resolveTraceContext(request, correlationId);
        return jsonError({
          status: 500,
          error: err.message || 'Invalid CORS configuration.',
          correlationId,
          traceparent: trace.traceparent,
          tracestate: trace.tracestate,
        });
      }

      if (!base) return new Response(null, { status: 204 });

      const allowMethods = String(
        env.CORS_ALLOW_METHODS || 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
      ).trim();
      const allowHeaders =
        String(env.CORS_ALLOW_HEADERS || '').trim() ||
        String(request.headers.get('access-control-request-headers') || '').trim() ||
        'authorization,content-type,traceparent,tracestate,x-webhook-token,x-api-key,x-correlation-id,x-request-id';

      return new Response(null, {
        status: 204,
        headers: {
          ...base,
          'access-control-allow-methods': allowMethods,
          'access-control-allow-headers': allowHeaders,
          'access-control-max-age': '86400',
        },
      });
    }

    const { response, upstreamRequest, authSource } = resolveIngress(request, env);
    if (response) {
      return withCors(request, env, withHeaders(response, deprecationHeadersForAuthSource(authSource)));
    }
    const upstreamResponse = await fetch(upstreamRequest);
    return withCors(
      request,
      env,
      withHeaders(upstreamResponse, deprecationHeadersForAuthSource(authSource))
    );
  },
};
