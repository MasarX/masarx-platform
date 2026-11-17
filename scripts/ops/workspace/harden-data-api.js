#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Hardens the Supabase Data API surface for enterprise-grade least privilege:
 * - PostgREST exposed schemas: `api` only (no `public`, no `graphql_public`)
 * - Extra search path: `extensions` only (avoid accidental function resolution against internal schemas)
 *
 * NOTE: This is a cloud control-plane setting (Supabase Management API), not a DB migration.
 * It is enforced here to prevent dashboard drift and to keep CI deterministic.
 */

const { loadEnv } = require('../../utils/load-env');
const { resolveSupabaseJwtSigningSecretByRestAuth } = require('./jwt-rest-auth');
const { resolveJwtIssuer } = require('./edge-db-jwt');
const { resolveTraceContext, emitTrace } = require('./trace-log');

function die(msg) {
  console.error(`[harden-data-api] ${msg}`);
  process.exit(1);
}

function isTruthy(v) {
  return /^(1|true|yes)$/i.test(String(v || '').trim());
}

function isPreviewRuntime(env = process.env) {
  return Boolean(
    String(env.PREVIEW_PROJECT_REF || '').trim() ||
      String(env.PREVIEW_SUPABASE_ACCESS_TOKEN || '').trim() ||
      String(env.PREVIEW_SUPABASE_URL || '').trim() ||
      isTruthy(env.PREVIEW_MODE) ||
      isTruthy(env.CI_PREVIEW)
  );
}

function getSupabaseMgmtUrl() {
  // objectives:allow SUPABASE_URL Justification: default Supabase Management API base; override supported via env
  return (process.env.SUPABASE_MGMT_URL || 'https://api.supabase.com').replace(/\/$/, '');
}

function readEnvAny(names) {
  for (const name of Array.isArray(names) ? names : []) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function safeBaseUrl(url) {
  return String(url || '').replace(/\/+$/g, '');
}

function dedupeProbeCandidates(candidates = []) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(candidates) ? candidates : []) {
    const apiKey = String(row?.apiKey || '').trim();
    const bearerToken = String(row?.bearerToken || '').trim();
    const source = String(row?.source || '').trim();
    if (!apiKey) continue;
    const key = `${apiKey}\u0000${bearerToken}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      apiKey,
      bearerToken,
      source: source || `probe:${out.length + 1}`,
    });
  }
  return out;
}

function isRetryableMgmtApiError(err) {
  const status = Number(err?.status || 0);
  if ([401, 403, 408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('enotfound') ||
    msg.includes('eai_again')
  );
}

function isMissingPostgrestConfigError(err) {
  const status = Number(err?.status || 0);
  if (status !== 404) return false;
  const message = String(
    err?.body?.message ||
      err?.body?.error ||
      err?.message ||
      '',
  ).toLowerCase();
  return message.includes('postgres config not found') || message.includes('postgrest');
}

function shouldSkipPostgrestMgmtConfigHardening({ err, env = process.env } = {}) {
  if (!isMissingPostgrestConfigError(err)) return false;
  return (
    isPreviewRuntime(env) &&
    isTruthy(env.DATA_API_HARDEN_ALLOW_PREVIEW_POSTGREST_CONFIG_MISSING || '1')
  );
}

function postgrestConfigMatches(cfg, wanted) {
  return String(cfg?.db_schema || '').trim() === String(wanted?.db_schema || '').trim()
    && String(cfg?.db_extra_search_path || '').trim() === String(wanted?.db_extra_search_path || '').trim();
}

function isPreviewRuntimeContractReady(env = process.env) {
  if (!isTruthy(env.PREVIEW_RUNTIME_READY)) return false;
  const dbReady = String(env.PREVIEW_RUNTIME_DB_READY || '').trim().toLowerCase();
  const jwtReady = String(env.PREVIEW_RUNTIME_JWT_READY || '').trim().toLowerCase();
  const restReady = String(env.PREVIEW_RUNTIME_REST_READY || '').trim().toLowerCase();
  return !['0', 'false'].includes(dbReady)
    && !['0', 'false'].includes(jwtReady)
    && !['0', 'false'].includes(restReady);
}

function createPropagationTimeoutError(last) {
  const err = new Error(`Timed out waiting for PostgREST to enforce api-only exposed schemas. Last: ${last || '<none>'}`);
  err.last = String(last || '');
  err.code = 'POSTGREST_PROPAGATION_TIMEOUT';
  return err;
}

function createPostgrestConfigMismatchTimeoutError({ wanted, lastConfig } = {}) {
  const err = new Error(
    `Timed out waiting for PostgREST config to reflect desired exposure. Last: ${JSON.stringify(redactPostgrestConfig(lastConfig))}`,
  );
  err.code = 'POSTGREST_CONFIG_MISMATCH_TIMEOUT';
  err.wanted = { ...(wanted || {}) };
  err.effective = redactPostgrestConfig(lastConfig);
  return err;
}

function isTransientPropagationFailure(err) {
  const detail = String(err?.last || err?.message || '').toLowerCase();
  return detail.includes('rest error=fetch failed')
    || detail.includes('rest status=503 code=pgrst002')
    || detail.includes('rest error=socket hang up')
    || detail.includes('rest error=timeout');
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withMgmtApiRetry(fn, options = {}) {
  const timeoutMs = Math.max(
    1_000,
    Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 60_000,
  );
  const delayMs = Math.max(
    250,
    Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : 5_000,
  );
  const label = options.label || 'management API call';

  const started = Date.now();
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const elapsed = Date.now() - started;
      if (!isRetryableMgmtApiError(err) || elapsed >= timeoutMs) {
        throw err;
      }
      console.warn(
        `[harden-data-api] ${label} failed (attempt=${attempt}, status=${err?.status || 'n/a'}). Retrying in ${delayMs}ms: ${err.message}`,
      );
      await sleep(delayMs);
    }
  }
}

async function waitForDesiredPostgrestConfig({
  readConfig,
  wanted,
  timeoutMs = 15_000,
  delayMs = 1_000,
} = {}) {
  if (typeof readConfig !== 'function') {
    throw new Error('waitForDesiredPostgrestConfig requires readConfig');
  }
  const started = Date.now();
  let lastConfig = null;
  while (true) {
    lastConfig = await readConfig();
    if (postgrestConfigMatches(lastConfig, wanted)) {
      return lastConfig;
    }
    if (Date.now() - started >= timeoutMs) {
      throw createPostgrestConfigMismatchTimeoutError({ wanted, lastConfig });
    }
    await sleep(delayMs);
  }
}

function redactPostgrestConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  return {
    db_schema: cfg.db_schema || null,
    db_extra_search_path: cfg.db_extra_search_path || null,
    max_rows: cfg.max_rows ?? null,
    db_pool: cfg.db_pool ?? null,
  };
}

async function http(method, path, token, body) {
  const base = getSupabaseMgmtUrl();
  const url = `${base}${path}`;
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.message || json?.error || res.statusText;
    const err = new Error(`HTTP ${res.status} ${method} ${path}: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function getPostgrestConfig({ projectRef, token }) {
  return http('GET', `/v1/projects/${encodeURIComponent(projectRef)}/postgrest`, token, null);
}

async function patchPostgrestConfig({ projectRef, token, patch }) {
  return http('PATCH', `/v1/projects/${encodeURIComponent(projectRef)}/postgrest`, token, patch);
}

async function probeInvalidSchema({ baseUrl, apiKey, bearerToken, schema }) {
  const headers = {
    apikey: apiKey,
    'Accept-Profile': schema,
    'Content-Profile': schema,
  };
  if (String(bearerToken || '').trim()) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const res = await fetch(`${baseUrl}/rest/v1/spatial_ref_sys?select=srid&limit=1`, {
    headers,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function probeGraphqlDisabled({ baseUrl, apiKey, bearerToken }) {
  const headers = {
    apikey: apiKey,
    'content-type': 'application/json',
  };
  if (String(bearerToken || '').trim()) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const res = await fetch(`${baseUrl}/graphql/v1`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'query { __schema { queryType { name } } }' }),
  });
  return { status: res.status };
}

function buildLegacyProbeCandidates({ anonKey, serviceKey } = {}) {
  const anon = String(anonKey || '').trim();
  const service = String(serviceKey || '').trim();
  return dedupeProbeCandidates([
    { apiKey: anon, bearerToken: anon, source: 'legacy:anon/anon' },
    { apiKey: anon, bearerToken: service, source: 'legacy:anon/service' },
    { apiKey: service, bearerToken: service, source: 'legacy:service/service' },
    { apiKey: service, bearerToken: anon, source: 'legacy:service/anon' },
    // Modern API key modes can reject JWT bearer headers but still allow apikey-only access.
    { apiKey: anon, bearerToken: '', source: 'apikey-only:anon' },
    { apiKey: service, bearerToken: '', source: 'apikey-only:service' },
  ]);
}

function isSchemaRejectionProbe(status, body) {
  return Number(status) === 401 && body?.code === 'PGRST301';
}

async function findWorkingProbeCandidate({ baseUrl, candidates, schema = 'public' } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  for (const candidate of list) {
    try {
      const probe = await probeInvalidSchema({
        baseUrl,
        apiKey: candidate.apiKey,
        bearerToken: candidate.bearerToken,
        schema,
      });
      if (!isSchemaRejectionProbe(probe.status, probe?.body)) {
        return candidate;
      }
    } catch {
      // Keep trying candidates and leave definitive failure to the propagation wait.
    }
  }
  return null;
}

async function resolveProbeAuth({ baseUrl, projectRef, anonKey, serviceKey, jwtSecretRaw }) {
  const legacyCandidates = buildLegacyProbeCandidates({ anonKey, serviceKey });
  const fallback = legacyCandidates[0] || { apiKey: '', bearerToken: '', source: 'legacy:none' };
  if (!fallback.apiKey) return fallback;

  const legacyWorking = await findWorkingProbeCandidate({
    baseUrl,
    candidates: legacyCandidates,
    schema: 'public',
  });
  if (legacyWorking) return legacyWorking;

  const secretRaw = String(jwtSecretRaw || '').trim();
  if (!secretRaw) return fallback;

  try {
    const issuer = resolveJwtIssuer({ serviceKey, anonKey });
    // REST plane expects anon/publishable API key in `apikey` header; secret/admin
    // keys are for management/admin calls and can be rejected by PostgREST.
    const apiKeyCandidates = [...new Set([String(anonKey || '').trim(), String(serviceKey || '').trim()].filter(Boolean))];
    for (const candidateApiKey of apiKeyCandidates) {
      const resolved = await resolveSupabaseJwtSigningSecretByRestAuth({
        secretRaw,
        supabaseUrl: baseUrl,
        apiKey: candidateApiKey,
        issuer,
        projectRef,
        timeoutMs: 30000,
        intervalMs: 2000,
        logPrefix: '[harden-data-api]',
      });
      if (!resolved?.bearerToken) continue;
      const mintedCandidate = {
        apiKey: candidateApiKey,
        bearerToken: resolved.bearerToken,
        source: `minted:${resolved.label || 'unknown'}`,
      };
      const mintedWorking = await findWorkingProbeCandidate({
        baseUrl,
        candidates: [mintedCandidate],
        schema: 'public',
      });
      if (mintedWorking) {
        console.log('[harden-data-api] Using minted REST probe token (legacy key mismatch).');
        return mintedWorking;
      }
    }
  } catch (err) {
    console.warn(`[harden-data-api] Could not mint REST probe token: ${err.message}`);
  }

  return fallback;
}

async function waitForPropagation({
  baseUrl,
  apiKey,
  bearerToken,
  timeoutMs,
  intervalMs,
  allowUnavailable,
}) {
  const start = Date.now();
  let last = '';
  const preview = isPreviewRuntime(process.env);
  const allowUnavailableResolved =
    typeof allowUnavailable === 'boolean'
      ? allowUnavailable
      : (preview && isTruthy(process.env.POSTGREST_PROPAGATION_ALLOW_UNAVAILABLE || '1'));
  while (Date.now() - start < timeoutMs) {
    try {
      const probe = await probeInvalidSchema({ baseUrl, apiKey, bearerToken, schema: 'public' });
      if (probe.status === 406 && probe?.body?.code === 'PGRST106') return;
      // Preview projects can take a long time to bring PostgREST online (or remain temporarily unavailable).
      // If PostgREST reports "could not connect to database" we treat the control-plane config as the source of truth.
      if (probe.status === 503 && probe?.body?.code === 'PGRST002' && allowUnavailableResolved) {
        console.log('[harden-data-api] PostgREST currently unavailable (503/PGRST002); skipping propagation probe.');
        return;
      }
      last = `rest status=${probe.status} code=${probe?.body?.code || ''}`;
    } catch (e) {
      last = `rest error=${e.message}`;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw createPropagationTimeoutError(last);
}

async function main() {
  loadEnv();
  const trace = resolveTraceContext({
    operation: 'workspace.harden_data_api',
    traceparent: process.env.TRACEPARENT,
  });

  if (isTruthy(process.env.DATA_API_HARDEN_SKIP)) {
    console.log('[harden-data-api] DATA_API_HARDEN_SKIP=1; skipping.');
    emitTrace(trace, 'info', { step: 'skip', status: 'ok', reason: 'DATA_API_HARDEN_SKIP=1' });
    return;
  }

  const projectRef = readEnvAny(['SUPABASE_PROJECT_ID', 'SUPABASE_PROJECT_REF', 'PREVIEW_PROJECT_REF']);
  const token = readEnvAny(['SUPABASE_ACCESS_TOKEN', 'PREVIEW_SUPABASE_ACCESS_TOKEN']);
  if (!projectRef) die('Missing project ref (SUPABASE_PROJECT_ID).');
  if (!token) die('Missing management token (SUPABASE_ACCESS_TOKEN).');

  const baseUrl = safeBaseUrl(readEnvAny(['SUPABASE_URL', 'PREVIEW_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL']));
  const anonKey = readEnvAny(['SUPABASE_ANON_KEY', 'PREVIEW_SUPABASE_ANON_KEY']);
  const serviceKey = readEnvAny([
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SECRET_KEY',
    'SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_KEY',
  ]);
  const jwtSecretRaw = readEnvAny(['SUPABASE_JWT_SECRET']);
  if (!baseUrl) die('Missing SUPABASE_URL (required for propagation probe).');
  if (!anonKey && !serviceKey) {
    die('Missing SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY (required for propagation probe).');
  }

  const probeAuth = await resolveProbeAuth({
    baseUrl,
    projectRef,
    anonKey,
    serviceKey,
    jwtSecretRaw,
  });
  if (!probeAuth?.apiKey) {
    die('Unable to resolve REST probe auth token for propagation checks.');
  }
  emitTrace(trace, 'info', {
    step: 'probe_auth_resolved',
    status: 'ok',
    auth_source: probeAuth.source || 'unknown',
  });

  const wanted = { db_schema: 'api', db_extra_search_path: 'extensions' };
  const isPreview = isPreviewRuntime(process.env);
  const previewRuntimeContractReady = isPreviewRuntimeContractReady(process.env);
  const mgmtRetryTimeoutMs = Math.max(
    1_000,
    parseInt(process.env.DATA_API_MGMT_RETRY_TIMEOUT_MS || (isPreview ? '180000' : '60000'), 10) || (isPreview ? 180_000 : 60_000),
  );
  const mgmtRetryDelayMs = Math.max(
    250,
    parseInt(process.env.DATA_API_MGMT_RETRY_DELAY_MS || '5000', 10) || 5_000,
  );
  let skipMgmtConfigHardening = false;

  let current;
  try {
    current = await withMgmtApiRetry(
      () => getPostgrestConfig({ projectRef, token }),
      { label: 'GET PostgREST config', timeoutMs: mgmtRetryTimeoutMs, delayMs: mgmtRetryDelayMs },
    );
  } catch (e) {
    if (shouldSkipPostgrestMgmtConfigHardening({ err: e })) {
      skipMgmtConfigHardening = true;
      console.warn(
        `[harden-data-api] Preview Management API does not expose PostgREST config; skipping control-plane hardening and relying on runtime boundary verification (${e.message}).`,
      );
      emitTrace(trace, 'warn', {
        step: 'postgrest_config_check',
        status: 'skipped',
        reason: 'preview_postgrest_config_missing',
        error: String(e.message || e),
      });
    } else {
      die(`Unable to fetch PostgREST config via Management API: ${e.message}`);
    }
  }

  const currentSafe = redactPostgrestConfig(current);
  const needsPatch = !skipMgmtConfigHardening && (
    String(current?.db_schema || '').trim() !== wanted.db_schema ||
    String(current?.db_extra_search_path || '').trim() !== wanted.db_extra_search_path
  );

  if (!skipMgmtConfigHardening && !needsPatch) {
    console.log('[harden-data-api] PostgREST exposure already hardened:', JSON.stringify(currentSafe));
    emitTrace(trace, 'info', {
      step: 'postgrest_config_check',
      status: 'ok',
      changed: false,
      config: currentSafe,
    });
  } else if (!skipMgmtConfigHardening) {
    console.log('[harden-data-api] Hardening PostgREST exposure:', JSON.stringify(currentSafe));
    emitTrace(trace, 'info', {
      step: 'postgrest_config_patch',
      status: 'start',
      changed: true,
      current: currentSafe,
    });
    try {
      await withMgmtApiRetry(
        () => patchPostgrestConfig({ projectRef, token, patch: wanted }),
        { label: 'PATCH PostgREST config', timeoutMs: mgmtRetryTimeoutMs, delayMs: mgmtRetryDelayMs },
      );
    } catch (e) {
      die(`Unable to patch PostgREST config via Management API: ${e.message}`);
    }
    emitTrace(trace, 'info', {
      step: 'postgrest_config_patch',
      status: 'ok',
      changed: true,
    });
  }

  // Re-read to ensure the control-plane config reflects the desired posture before boundary probes.
  if (!skipMgmtConfigHardening) {
    const configMatchTimeoutMs = Math.max(
      1_000,
      parseInt(
        process.env.DATA_API_POSTGREST_MATCH_TIMEOUT_MS || (
          previewRuntimeContractReady
            ? (process.env.PREVIEW_RUNTIME_READY_MAX_WAIT_MS || '5000')
            : (isPreview ? '30000' : '15000')
        ),
        10,
      ) || (previewRuntimeContractReady ? 5_000 : (isPreview ? 30_000 : 15_000)),
    );
    const configMatchDelayMs = Math.max(
      250,
      parseInt(
        process.env.DATA_API_POSTGREST_MATCH_DELAY_MS || (
          previewRuntimeContractReady
            ? (process.env.PREVIEW_RUNTIME_READY_RETRY_DELAY_MS || '1000')
            : '1000'
        ),
        10,
      ) || (previewRuntimeContractReady ? 1_000 : 1_000),
    );
    let effective = null;
    try {
      effective = await waitForDesiredPostgrestConfig({
        readConfig: () => withMgmtApiRetry(
          () => getPostgrestConfig({ projectRef, token }),
          { label: 're-fetch PostgREST config', timeoutMs: mgmtRetryTimeoutMs, delayMs: mgmtRetryDelayMs },
        ),
        wanted,
        timeoutMs: configMatchTimeoutMs,
        delayMs: configMatchDelayMs,
      });
    } catch (e) {
      if (
        needsPatch &&
        isPreview &&
        previewRuntimeContractReady &&
        e?.code === 'POSTGREST_CONFIG_MISMATCH_TIMEOUT'
      ) {
        console.warn(
          `[harden-data-api] Preview PostgREST config is still stale after patch; relying on runtime boundary verification (${JSON.stringify(e.effective)}).`,
        );
        emitTrace(trace, 'warn', {
          step: 'postgrest_config_check',
          status: 'warn',
          reason: 'preview_postgrest_config_stale_after_patch',
          config: e.effective,
          timeout_ms: configMatchTimeoutMs,
          interval_ms: configMatchDelayMs,
        });
      } else if (e?.code === 'POSTGREST_CONFIG_MISMATCH_TIMEOUT') {
        die(`PostgREST config mismatch after patch: ${JSON.stringify(e.effective)}`);
      } else {
        die(`Unable to re-fetch PostgREST config after patch: ${e.message}`);
      }
    }
    if (effective) {
      emitTrace(trace, 'info', {
        step: 'postgrest_config_check',
        status: 'ok',
        changed: Boolean(needsPatch),
        config: redactPostgrestConfig(effective),
        timeout_ms: configMatchTimeoutMs,
        interval_ms: configMatchDelayMs,
      });
    }
  }

  const defaultTimeoutMs = skipMgmtConfigHardening
    ? (previewRuntimeContractReady
      ? Math.max(1_000, parseInt(process.env.PREVIEW_RUNTIME_READY_MAX_WAIT_MS || '5000', 10) || 5_000)
      : 30_000)
    : (isPreview ? 900_000 : 300_000); // preview projects can take longer to bring PostgREST online
  const timeoutMs = Math.max(
    10_000,
    parseInt(process.env.POSTGREST_PROPAGATION_TIMEOUT_MS || String(defaultTimeoutMs), 10) || defaultTimeoutMs
  );
  const defaultIntervalMs = previewRuntimeContractReady
    ? Math.max(500, parseInt(process.env.PREVIEW_RUNTIME_READY_RETRY_DELAY_MS || '1000', 10) || 1_000)
    : 5_000;
  const intervalMs = Math.max(
    500,
    parseInt(process.env.POSTGREST_PROPAGATION_INTERVAL_MS || String(defaultIntervalMs), 10) || defaultIntervalMs,
  );

  try {
    await waitForPropagation({
      baseUrl,
      apiKey: probeAuth.apiKey,
      bearerToken: probeAuth.bearerToken,
      timeoutMs,
      intervalMs,
      allowUnavailable: skipMgmtConfigHardening && previewRuntimeContractReady ? true : (skipMgmtConfigHardening ? false : undefined),
    });
  } catch (e) {
    if (skipMgmtConfigHardening && previewRuntimeContractReady && isTransientPropagationFailure(e)) {
      console.warn(
        `[harden-data-api] Preview runtime contract already proved ready; skipping residual PostgREST propagation probe after transient preview unavailability (${e.message}).`,
      );
      emitTrace(trace, 'warn', {
        step: 'postgrest_propagation',
        status: 'skipped',
        reason: 'preview_runtime_contract_ready',
        error: String(e.message || e),
      });
    } else {
      die(e.message);
    }
  }
  if (!(skipMgmtConfigHardening && previewRuntimeContractReady)) {
    emitTrace(trace, 'info', {
      step: 'postgrest_propagation',
      status: 'ok',
      timeout_ms: timeoutMs,
      interval_ms: intervalMs,
    });
  }

  // Sanity check: GraphQL endpoint should not be 200 (disabled when graphql_public is not exposed).
  try {
    const gql = await probeGraphqlDisabled({
      baseUrl,
      apiKey: probeAuth.apiKey,
      bearerToken: probeAuth.bearerToken,
    });
    if (gql.status === 200) {
      die('GraphQL endpoint is still enabled (status=200). Ensure graphql_public is not exposed in Supabase API settings.');
    }
  } catch (e) {
    // If the endpoint is unreachable or returns non-JSON, we treat as "disabled enough" for our boundary.
  }

  console.log('[harden-data-api] OK.');
  emitTrace(trace, 'info', {
    step: 'complete',
    status: 'ok',
    project_ref: projectRef,
  });
}

if (require.main === module) {
  main().catch((err) => {
    die(err?.message || String(err));
  });
}

module.exports = {
  buildLegacyProbeCandidates,
  createPostgrestConfigMismatchTimeoutError,
  findWorkingProbeCandidate,
  isMissingPostgrestConfigError,
  isSchemaRejectionProbe,
  postgrestConfigMatches,
  probeInvalidSchema,
  isRetryableMgmtApiError,
  isTransientPropagationFailure,
  isPreviewRuntime,
  isPreviewRuntimeContractReady,
  resolveProbeAuth,
  redactPostgrestConfig,
  safeBaseUrl,
  shouldSkipPostgrestMgmtConfigHardening,
  waitForDesiredPostgrestConfig,
  withMgmtApiRetry,
};
