const crypto = require('crypto');
const { buildSupabaseApiKeys, isJwtSignedWithSecret } = require('./edge-db-jwt');
const { normalizeSupabaseUrl, shouldRetryJwtError } = require('./supabase-runtime');

const EDGE_DB_JWT_REQUIREMENTS = Object.freeze({
  WEBHOOK_DB_JWT: 'edge_webhook_role',
  API_CALLER_DB_JWT: 'edge_api_caller_role',
  API_GATEWAY_DB_JWT: 'edge_api_gateway_role',
  LABEL_RENDERER_DB_JWT: 'edge_label_renderer_role',
});
const DEFAULT_EDGE_DB_JWT_MIN_TTL_SECONDS = 2 * 60 * 60;
const DEFAULT_EDGE_DB_JWT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_EDGE_DB_JWT_MAX_LIFETIME_SECONDS = 366 * 24 * 60 * 60;

function formatErrorBody(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'object') {
    const msg = body.message || body.error || body.details;
    if (msg) return String(msg);
    try {
      return JSON.stringify(body);
    } catch {
      return String(body);
    }
  }
  return String(body);
}

function parseJsonSafe(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function sleep(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, n));
}

function resolveSigningSecretCandidates(secretRaw) {
  const raw = secretRaw instanceof Buffer ? secretRaw : String(secretRaw || '').trim();
  if (!raw) return [];
  const candidates = [{ label: 'raw', secret: raw }];

  // Some runtimes interpret JWT secret strings as encoded bytes (base64/hex).
  // Include both decodes so we can deterministically validate via live auth.
  if (typeof raw === 'string') {
    try {
      const base64 = Buffer.from(raw, 'base64');
      if (base64.length) candidates.push({ label: 'base64', secret: base64 });
    } catch {
      // ignore
    }

    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
      try {
        const hex = Buffer.from(raw, 'hex');
        if (hex.length) candidates.push({ label: 'hex', secret: hex });
      } catch {
        // ignore
      }
    }
  }

  return candidates;
}

function buildSupabaseApiBearerCandidates({ secretRaw, issuer, projectRef } = {}) {
  const candidates = resolveSigningSecretCandidates(secretRaw);
  return candidates
    .map((candidate) => {
      const minted = buildSupabaseApiKeys({ secret: candidate.secret, issuer, projectRef });
      if (!minted?.service) return null;
      return { label: candidate.label, secret: candidate.secret, bearerToken: minted.service };
    })
    .filter(Boolean);
}

function stringifyBody(body) {
  return String(formatErrorBody(body || '') || '').toLowerCase();
}

function isFunctionJwtRejected(status, body) {
  const code = Number(status || 0);
  if (code !== 401) return false;
  const text = stringifyBody(body);
  return (
    text.includes('invalid jwt') ||
    text.includes('jwt') ||
    text.includes('authorization')
  );
}

function classifyAuthProbe({ ok, status, body, error } = {}) {
  if (ok) {
    return {
      status: Number(status || 200),
      ok: true,
      retryable: false,
      classification: 'ok',
      body: body == null ? null : body,
      error: null,
    };
  }

  const probeStatus = Number(status || 0);
  if (error) {
    return {
      status: probeStatus || 0,
      ok: false,
      retryable: true,
      classification: 'network_error',
      body: body == null ? null : body,
      error: String(error?.message || error),
    };
  }

  const retryable = shouldRetryJwtError(probeStatus, body);
  return {
    status: probeStatus,
    ok: false,
    retryable,
    classification: retryable ? 'retryable_auth_error' : 'auth_rejected',
    body: body == null ? null : body,
    error: null,
  };
}

async function checkRestAuth({ supabaseUrl, apiKey, bearerToken, timeoutMs }) {
  const base = normalizeSupabaseUrl(supabaseUrl);
  if (!base) throw new Error('supabaseUrl is required to verify rest auth');
  const key = String(apiKey || '').trim();
  const bearer = String(bearerToken || '').trim();
  if (!key) throw new Error('apiKey is required to verify rest auth');
  if (!bearer) throw new Error('bearerToken is required to verify rest auth');
  const timeout = Number(timeoutMs || 0);
  const controller = Number.isFinite(timeout) && timeout > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const res = await fetch(`${base}/rest/v1/`, {
      method: 'GET',
      headers: {
        apikey: key,
        authorization: `Bearer ${bearer}`,
      },
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await res.text();
    const body = parseJsonSafe(text) || text;
    return { ok: res.ok, status: res.status, body };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function decodeJwtJsonSegment(segment) {
  const raw = String(segment || '').trim();
  if (!raw) return null;
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function fingerprintJwt(token) {
  const value = String(token || '').trim();
  return value ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 12) : '';
}

function resolveAcceptedEdgeDbJwtIssuers({ expectedIssuer, supabaseUrl, projectRef } = {}) {
  const accepted = new Set();
  const explicit = String(expectedIssuer || '').trim();
  if (explicit) accepted.add(explicit);
  const base = normalizeSupabaseUrl(supabaseUrl);
  if (base) accepted.add(`${base}/auth/v1`);
  const ref = String(projectRef || '').trim();
  if (ref) accepted.add(`https://${ref}.supabase.co/auth/v1`);
  return [...accepted];
}

function inspectEdgeDbJwtClaims({
  name,
  token,
  expectedRole,
  expectedIssuer,
  supabaseUrl,
  projectRef,
  nowSec,
  minTtlSec = DEFAULT_EDGE_DB_JWT_MIN_TTL_SECONDS,
  clockSkewSec = DEFAULT_EDGE_DB_JWT_CLOCK_SKEW_SECONDS,
  maxLifetimeSec = DEFAULT_EDGE_DB_JWT_MAX_LIFETIME_SECONDS,
} = {}) {
  const key = String(name || '').trim() || 'EDGE_DB_JWT';
  const value = String(token || '').trim();
  const expected = String(expectedRole || '').trim();
  const acceptedIssuers = resolveAcceptedEdgeDbJwtIssuers({
    expectedIssuer,
    supabaseUrl,
    projectRef,
  });
  const expectedRef = String(projectRef || '').trim();
  const now = Number.isFinite(Number(nowSec)) ? Number(nowSec) : Math.floor(Date.now() / 1000);
  const minimumTtl = Math.max(0, Number(minTtlSec) || 0);
  const skew = Math.max(0, Number(clockSkewSec) || 0);
  const maximumLifetime = Math.max(1, Number(maxLifetimeSec) || DEFAULT_EDGE_DB_JWT_MAX_LIFETIME_SECONDS);
  const base = {
    name: key,
    expected_role: expected,
    fingerprint_sha256_12: fingerprintJwt(value),
    valid: false,
  };
  if (!value) return { ...base, reason: 'missing' };
  const parts = value.split('.');
  if (parts.length !== 3) return { ...base, reason: 'malformed' };
  const header = decodeJwtJsonSegment(parts[0]);
  const claims = decodeJwtJsonSegment(parts[1]);
  if (!header || !claims) return { ...base, reason: 'malformed' };
  const role = typeof claims.role === 'string' ? claims.role : '';
  const actualIssuer = String(claims.iss || '').trim();
  const subject = String(claims.sub || '').trim();
  const audience = Array.isArray(claims.aud)
    ? claims.aud.map((entry) => String(entry || '').trim())
    : [String(claims.aud || '').trim()];
  const issuedAt = claims.iat;
  const expiresAt = claims.exp;
  const tokenRef = String(claims.ref || '').trim();
  const algorithm = typeof header.alg === 'string' ? header.alg : '';
  const canonicalProjectIssuer = expectedRef ? `https://${expectedRef}.supabase.co/auth/v1` : '';
  const projectBoundAuthority = Boolean(expectedRef && actualIssuer === canonicalProjectIssuer);
  const report = {
    ...base,
    algorithm,
    role,
    issuer_match: acceptedIssuers.includes(actualIssuer),
    project_ref_match: Boolean(!expectedRef || tokenRef === expectedRef || (!tokenRef && projectBoundAuthority)),
    expires_in_seconds: Number.isFinite(expiresAt) ? expiresAt - now : null,
  };
  if (!['HS256', 'ES256', 'RS256'].includes(algorithm)) return { ...report, reason: 'algorithm' };
  if (!expected || role !== expected) return { ...report, reason: 'role' };
  if (!audience.includes('authenticated')) return { ...report, reason: 'audience' };
  if (subject !== 'edge-function') return { ...report, reason: 'subject' };
  if (acceptedIssuers.length === 0 || !acceptedIssuers.includes(actualIssuer)) {
    return { ...report, reason: 'issuer' };
  }
  if (expectedRef && tokenRef !== expectedRef && !projectBoundAuthority) return { ...report, reason: 'project_ref' };
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt) || issuedAt > now + skew) return { ...report, reason: 'issued_at' };
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt < now + minimumTtl) return { ...report, reason: 'expiry' };
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maximumLifetime) return { ...report, reason: 'lifetime' };
  return { ...report, valid: true, reason: '' };
}

function inspectEdgeDbJwtBundleClaims({ env, tokens, expectedIssuer, supabaseUrl, projectRef, nowSec, minTtlSec, clockSkewSec } = {}) {
  const scope = tokens || env || process.env;
  const reports = Object.entries(EDGE_DB_JWT_REQUIREMENTS).map(([name, expectedRole]) =>
    inspectEdgeDbJwtClaims({
      name,
      token: scope?.[name],
      expectedRole,
      expectedIssuer,
      supabaseUrl,
      projectRef,
      nowSec,
      minTtlSec,
      clockSkewSec,
    }),
  );
  return { valid: reports.every((report) => report.valid), reports };
}

async function validateEdgeDbJwtToken({
  name,
  token,
  expectedRole,
  supabaseUrl,
  apiKey,
  expectedIssuer,
  projectRef,
  signingSecret,
  nowSec,
  minTtlSec,
  clockSkewSec,
  probeTimeoutMs = 15_000,
  probeAttempts = 3,
  probeRetryDelayMs = 1_000,
  checkRestAuthFn = checkRestAuth,
} = {}) {
  const report = inspectEdgeDbJwtClaims({
    name,
    token,
    expectedRole,
    expectedIssuer,
    supabaseUrl,
    projectRef,
    nowSec,
    minTtlSec,
    clockSkewSec,
  });
  if (!report.valid) {
    throw new Error(`Edge DB JWT claim validation failed: ${report.name}:${report.reason}`);
  }
  const secret = signingSecret instanceof Buffer ? signingSecret : String(signingSecret || '').trim();
  if (secret && report.algorithm === 'HS256') {
    if (!isJwtSignedWithSecret(String(token || '').trim(), secret)) {
      throw new Error(`Edge DB JWT signature validation failed: ${report.name}`);
    }
    return { ...report, validation: 'signature', signature_valid: true };
  }
  const base = normalizeSupabaseUrl(supabaseUrl);
  const key = String(apiKey || '').trim();
  if (!base || !key) {
    throw new Error('Edge DB JWT live validation requires SUPABASE_URL and a public API key.');
  }
  const attempts = Math.max(1, Number(probeAttempts) || 1);
  let lastStatus = 0;
  let lastClassification = 'network_error';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await checkRestAuthFn({
        supabaseUrl: base,
        apiKey: key,
        bearerToken: String(token || '').trim(),
        timeoutMs: probeTimeoutMs,
      });
      lastStatus = Number(result?.status || 0);
      if (result?.ok) {
        return { ...report, validation: 'live_rest', live_status: lastStatus, live_attempts: attempt };
      }
      lastClassification = shouldRetryJwtError(lastStatus, result?.body)
        ? 'retryable_auth_error'
        : 'auth_rejected';
      if (lastClassification === 'auth_rejected') break;
    } catch {
      lastClassification = 'network_error';
    }
    if (attempt < attempts) await sleep(probeRetryDelayMs);
  }
  throw new Error(`Edge DB JWT live validation failed: ${report.name}:${lastClassification}`);
}

async function validateEdgeDbJwtBundle({
  env,
  tokens,
  supabaseUrl,
  apiKey,
  expectedIssuer,
  projectRef,
  signingSecret,
  nowSec,
  minTtlSec,
  clockSkewSec,
  probeTimeoutMs = 15_000,
  probeAttempts = 3,
  probeRetryDelayMs = 1_000,
  checkRestAuthFn = checkRestAuth,
} = {}) {
  const scope = tokens || env || process.env;
  const outcomes = await Promise.allSettled(
    Object.entries(EDGE_DB_JWT_REQUIREMENTS).map(([name, expectedRole]) =>
      validateEdgeDbJwtToken({
        name,
        token: scope?.[name],
        expectedRole,
        supabaseUrl,
        apiKey,
        expectedIssuer,
        projectRef,
        signingSecret,
        nowSec,
        minTtlSec,
        clockSkewSec,
        probeTimeoutMs,
        probeAttempts,
        probeRetryDelayMs,
        checkRestAuthFn,
      }),
    ),
  );
  const failures = outcomes
    .filter((outcome) => outcome.status === 'rejected')
    .map((outcome) => String(outcome.reason?.message || 'unknown validation failure'));
  if (failures.length > 0) {
    throw new Error(`Edge DB JWT bundle validation failed (${failures.length}/4): ${failures.join('; ')}`);
  }
  const reports = outcomes.map((outcome) => outcome.value);
  return {
    valid: true,
    validation: reports.every((report) => report.validation === 'signature') ? 'signature' : 'live_rest',
    reports,
  };
}

async function checkFunctionAuth({
  supabaseUrl,
  apiKey,
  bearerToken,
  functionName = 'label-renderer',
  payload = { lease_seconds: 1, max_jobs: 1 },
} = {}) {
  const base = normalizeSupabaseUrl(supabaseUrl);
  if (!base) throw new Error('supabaseUrl is required to verify function auth');
  const key = String(apiKey || '').trim();
  const bearer = String(bearerToken || '').trim();
  const fnName = String(functionName || '').trim();
  if (!key) throw new Error('apiKey is required to verify function auth');
  if (!bearer) throw new Error('bearerToken is required to verify function auth');
  if (!fnName) throw new Error('functionName is required to verify function auth');
  const res = await fetch(`${base}/functions/v1/${encodeURIComponent(fnName)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: key,
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  const body = parseJsonSafe(text) || text;
  const rejected = isFunctionJwtRejected(res.status, body);
  return { ok: res.ok, status: res.status, body, jwtRejected: rejected };
}

async function evaluateAuthPlaneCandidate({
  supabaseUrl,
  restApiKey,
  functionApiKey,
  apiKey,
  bearerToken,
  functionName = 'label-renderer',
  payload,
} = {}) {
  const key = String(apiKey || '').trim();
  const restKey = String(restApiKey || key).trim();
  const fnKey = String(functionApiKey || key).trim();
  const bearer = String(bearerToken || '').trim();
  if (!restKey || !fnKey || !bearer) {
    throw new Error('evaluateAuthPlaneCandidate requires rest/function api key(s) and bearerToken');
  }

  let restProbe;
  try {
    const rest = await checkRestAuth({ supabaseUrl, apiKey: restKey, bearerToken: bearer });
    restProbe = classifyAuthProbe({ ok: rest.ok, status: rest.status, body: rest.body });
  } catch (error) {
    restProbe = classifyAuthProbe({ ok: false, error });
  }

  let functionProbe;
  try {
    const fn = await checkFunctionAuth({
      supabaseUrl,
      apiKey: fnKey,
      bearerToken: bearer,
      functionName,
      payload,
    });
    const base = classifyAuthProbe({ ok: !fn.jwtRejected, status: fn.status, body: fn.body });
    functionProbe = {
      ...base,
      jwtRejected: Boolean(fn.jwtRejected),
      classification: fn.jwtRejected ? 'jwt_rejected' : base.classification,
    };
  } catch (error) {
    functionProbe = {
      ...classifyAuthProbe({ ok: false, error }),
      jwtRejected: false,
    };
  }

  const accepted = Boolean(restProbe.ok && functionProbe.ok && !functionProbe.jwtRejected);
  let classification = 'accepted';
  if (!accepted) {
    if (!restProbe.ok) classification = `rest:${restProbe.classification}`;
    else if (functionProbe.jwtRejected) classification = 'function:jwt_rejected';
    else classification = `function:${functionProbe.classification}`;
  }

  return {
    accepted,
    classification,
    retryable: Boolean(!accepted && (restProbe.retryable || functionProbe.retryable)),
    rest: restProbe,
    function: functionProbe,
  };
}

async function selectRestAuthCandidateOnce({ supabaseUrl, apiKey, candidates } = {}) {
  const base = normalizeSupabaseUrl(supabaseUrl);
  const key = String(apiKey || '').trim();
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!base || !key || !list.length) return null;

  for (const candidate of list) {
    const bearer = String(candidate?.bearerToken || candidate?.serviceKey || '').trim();
    if (!bearer) continue;
    try {
      const res = await checkRestAuth({ supabaseUrl: base, apiKey: key, bearerToken: bearer });
      if (res.ok) return { candidate, status: res.status };
    } catch {
      // ignore and continue
    }
  }
  return null;
}

async function selectFunctionAuthCandidateOnce({
  supabaseUrl,
  apiKey,
  candidates,
  functionName,
  payload,
} = {}) {
  const base = normalizeSupabaseUrl(supabaseUrl);
  const key = String(apiKey || '').trim();
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!base || !key || !list.length) return null;

  for (const candidate of list) {
    const bearer = String(candidate?.bearerToken || candidate?.serviceKey || '').trim();
    if (!bearer) continue;
    try {
      const res = await checkFunctionAuth({
        supabaseUrl: base,
        apiKey: key,
        bearerToken: bearer,
        functionName,
        payload,
      });
      if (!res.jwtRejected) return { candidate, status: res.status };
    } catch {
      // ignore and continue
    }
  }
  return null;
}

async function selectAuthPlaneCandidateOnce({
  supabaseUrl,
  restApiKey,
  functionApiKey,
  apiKey,
  candidates,
  functionName,
  payload,
} = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!list.length) return null;
  const key = String(apiKey || '').trim();
  const resolvedRestKey = String(restApiKey || key).trim();
  const resolvedFunctionKey = String(functionApiKey || key).trim();
  if (!resolvedRestKey || !resolvedFunctionKey) return null;

  let best = null;
  for (const candidate of list) {
    const bearer = String(candidate?.bearerToken || candidate?.serviceKey || '').trim();
    if (!bearer) continue;
    const evaluation = await evaluateAuthPlaneCandidate({
      supabaseUrl,
      restApiKey: resolvedRestKey,
      functionApiKey: resolvedFunctionKey,
      bearerToken: bearer,
      functionName,
      payload,
    });
    if (evaluation.accepted) {
      return { candidate, evaluation };
    }
    if (!best || (best.evaluation.retryable && !evaluation.retryable)) {
      best = { candidate, evaluation };
    }
  }
  return best;
}

async function waitForAuthPlaneCandidate({
  supabaseUrl,
  restApiKey,
  functionApiKey,
  apiKey,
  candidates,
  functionName,
  payload,
  timeoutMs,
  intervalMs,
  logPrefix,
} = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!list.length) throw new Error('candidates are required to evaluate auth plane');
  const key = String(apiKey || '').trim();
  const resolvedRestKey = String(restApiKey || key).trim();
  const resolvedFunctionKey = String(functionApiKey || key).trim();
  if (!resolvedRestKey || !resolvedFunctionKey) {
    throw new Error('rest/function api key(s) are required to evaluate auth plane');
  }

  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 10 * 60 * 1000;
  const interval = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0 ? Number(intervalMs) : 5000;
  const prefix = String(logPrefix || '[jwt-rest-auth]').trim() || '[jwt-rest-auth]';

  const start = Date.now();
  let attempt = 0;
  let last = null;
  while (Date.now() - start < timeout) {
    attempt += 1;
    const selected = await selectAuthPlaneCandidateOnce({
      supabaseUrl,
      restApiKey: resolvedRestKey,
      functionApiKey: resolvedFunctionKey,
      candidates: list,
      functionName,
      payload,
    });
    if (selected?.evaluation?.accepted) {
      return { ...selected, attempts: attempt };
    }
    last = selected?.evaluation || null;
    if (selected?.evaluation && !selected.evaluation.retryable) {
      return { ...selected, attempts: attempt };
    }
    if (attempt === 1 || attempt % 5 === 0) {
      console.log(`${prefix} Waiting for auth plane propagation...`);
    }
    await sleep(interval);
  }
  return {
    candidate: null,
    evaluation: last || null,
    attempts: attempt,
    timeout: true,
  };
}

async function waitForRestAuthAny({ supabaseUrl, apiKey, candidates, timeoutMs, intervalMs, logPrefix } = {}) {
  const base = normalizeSupabaseUrl(supabaseUrl);
  const key = String(apiKey || '').trim();
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const prefix = String(logPrefix || '[jwt-rest-auth]').trim() || '[jwt-rest-auth]';
  if (!base) throw new Error('supabaseUrl is required to verify rest auth');
  if (!key) throw new Error('apiKey is required to verify rest auth');
  if (!list.length) throw new Error('candidates are required to verify rest auth');

  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 10 * 60 * 1000;
  const interval = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0 ? Number(intervalMs) : 5000;

  const start = Date.now();
  let attempt = 0;
  let last = null;
  while (Date.now() - start < timeout) {
    attempt += 1;
    let retryable = false;
    let lastNonRetryable = null;

    for (const candidate of list) {
      const bearer = String(candidate?.bearerToken || candidate?.serviceKey || '').trim();
      if (!bearer) continue;
      try {
        const res = await checkRestAuth({ supabaseUrl: base, apiKey: key, bearerToken: bearer });
        last = res;
        if (res.ok) return { ok: true, candidate, attempts: attempt, status: res.status };
        if (shouldRetryJwtError(res.status, res.body)) {
          retryable = true;
        } else {
          lastNonRetryable = res;
        }
      } catch {
        retryable = true;
      }
    }

    if (!retryable && lastNonRetryable) {
      throw new Error(
        `Rest auth check failed (status ${lastNonRetryable.status}): ${formatErrorBody(lastNonRetryable.body)}`,
      );
    }

    if (attempt === 1 || attempt % 5 === 0) {
      console.log(`${prefix} Waiting for rest JWT propagation...`);
    }
    await sleep(interval);
  }

  const suffix = last ? ` (last status ${last.status}: ${formatErrorBody(last.body)})` : '';
  throw new Error(`Timeout waiting for rest auth after ${attempt} attempts${suffix}`);
}

async function resolveSupabaseJwtSigningSecretByRestAuth({
  secretRaw,
  supabaseUrl,
  apiKey,
  issuer,
  projectRef,
  timeoutMs,
  intervalMs,
  logPrefix,
} = {}) {
  const candidates = buildSupabaseApiBearerCandidates({ secretRaw, issuer, projectRef });
  if (!candidates.length) {
    throw new Error('Unable to mint rest auth candidates from secret (missing issuer/projectRef/secretRaw).');
  }

  const selected = await selectRestAuthCandidateOnce({ supabaseUrl, apiKey, candidates });
  if (selected?.candidate?.secret) {
    return {
      secret: selected.candidate.secret,
      label: String(selected.candidate.label || '').trim(),
      bearerToken: String(selected.candidate.bearerToken || '').trim(),
      attempts: 1,
      waited: false,
    };
  }

  const ready = await waitForRestAuthAny({
    supabaseUrl,
    apiKey,
    candidates,
    timeoutMs,
    intervalMs,
    logPrefix,
  });

  return {
    secret: ready.candidate.secret,
    label: String(ready.candidate.label || '').trim(),
    bearerToken: String(ready.candidate.bearerToken || '').trim(),
    attempts: ready.attempts,
    waited: true,
  };
}

module.exports = {
  EDGE_DB_JWT_REQUIREMENTS,
  inspectEdgeDbJwtClaims,
  inspectEdgeDbJwtBundleClaims,
  validateEdgeDbJwtToken,
  validateEdgeDbJwtBundle,
  fingerprintJwt,
  resolveAcceptedEdgeDbJwtIssuers,
  resolveSigningSecretCandidates,
  buildSupabaseApiBearerCandidates,
  checkRestAuth,
  checkFunctionAuth,
  evaluateAuthPlaneCandidate,
  selectRestAuthCandidateOnce,
  selectFunctionAuthCandidateOnce,
  selectAuthPlaneCandidateOnce,
  waitForAuthPlaneCandidate,
  waitForRestAuthAny,
  resolveSupabaseJwtSigningSecretByRestAuth,
};
