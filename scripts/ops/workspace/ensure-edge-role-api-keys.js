#!/usr/bin/env node
/**
 * Syncs `.env.cloud` with Management API keys and configures Edge DB JWTs.
 *
 * Rationale:
 * - Supabase may redact the project JWT secret via the Management API.
 * - Edge Functions can run with least-privilege DB roles when we can mint
 *   role-bound JWTs (requires SUPABASE_JWT_SECRET).
 * - When the JWT secret is unavailable/mismatched, this script keeps the
 *   workspace usable by falling back to the legacy service-role key for
 *   *_DB_JWT values (NOT least-privilege).
 *
 * Behavior:
 * 1) Fetch legacy anon/service_role keys via Management API (SSOT for keys).
 * 2) If SUPABASE_JWT_SECRET is present AND accepted by the project's auth signing keys,
 *    mint edge-role DB JWTs and wire them into `.env.cloud`.
 * 3) Otherwise, clear SUPABASE_JWT_SECRET and set *_DB_JWT to service_role.
 *
 * Usage:
 *   ENV_FILE=config/env/.env.cloud node scripts/ops/workspace/ensure-edge-role-api-keys.js
 *   ENV_FILE=config/env/.env.cloud node scripts/ops/workspace/ensure-edge-role-api-keys.js --require-least-privilege
 *   ENV_FILE=config/env/.env.cloud node scripts/ops/workspace/ensure-edge-role-api-keys.js --fix-jwt-secret
 *
 * `--fix-jwt-secret`:
 * - Rotates the project's auth signing keys to an HS256 signing key (via Supabase
 *   Management API) and persists its secret into `.env.cloud` so least-privilege
 *   edge-role DB JWTs can be minted.
 * - WARNING: This invalidates existing API keys/sessions for that project. Use
 *   only for workspace/preview projects, never for production.
 *
 * Notes:
 * - This script never prints secrets; it prints short non-reversible fingerprints.
 */

/* eslint-disable no-console */
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { loadEnv } = require('../../utils/load-env');
const {
  listAuthSigningKeys,
  createAuthSigningKeyInUse,
  randomJwtSecret,
} = require('./supabase-api');
const {
  buildEdgeDbJwtBundle,
  buildFallbackEdgeDbJwtBundle,
  buildSupabaseApiKeys,
  resolveJwtIssuer,
  resolveJwtSigningSecret,
  isJwtSignedWithSecret,
} = require('./edge-db-jwt');
const {
  resolveJwtPropagationOptions,
} = require('./supabase-runtime');
const {
  buildSupabaseApiBearerCandidates,
  selectAuthPlaneCandidateOnce,
  waitForAuthPlaneCandidate,
} = require('./jwt-rest-auth');
const {
  resolveTraceContext,
  emitTrace,
} = require('./trace-log');

function safeFingerprint(value) {
  if (!value) return '<empty>';
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function decodeBase64UrlJson(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  try {
    return JSON.parse(Buffer.from(normalized + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function base64UrlEncode(input) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return raw
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function decodeJwtHeaderAlg(token) {
  const jwt = String(token || '').trim();
  const parts = jwt.split('.');
  if (parts.length < 2) return '';
  const header = decodeBase64UrlJson(parts[0]);
  const alg = header && typeof header.alg === 'string' ? header.alg.trim() : '';
  return alg;
}

function getSupabaseMgmtUrl() {
  // objectives:allow SUPABASE_URL Justification: default management API base; override supported via env
  return (process.env.SUPABASE_MGMT_URL || 'https://api.supabase.com').replace(/\/$/, '');
}

async function http(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json && json.message ? json.message : text || `${res.status}`;
    const err = new Error(`${method} ${url} failed: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json == null ? text : json;
}

async function listApiKeys({ projectRef, token }) {
  const url = `${getSupabaseMgmtUrl()}/v1/projects/${projectRef}/api-keys`;
  const keys = await http('GET', url, token);
  if (!Array.isArray(keys)) return [];
  return keys;
}

function findLegacyKey(keys, name) {
  return keys.find((k) => String(k?.type || '').toLowerCase() === 'legacy' && String(k?.name || '') === name) || null;
}

function resolveEdgeGuardSettings(secretMatches) {
  if (secretMatches) {
    return {
      modeLabel: 'least-privilege (edge roles)',
      previewMode: '0',
      edgeRequireDbJwt: '1',
    };
  }
  return {
    modeLabel: 'fallback (service_role)',
    previewMode: '1',
    edgeRequireDbJwt: '0',
  };
}

async function writeEnv({ envFile, payload }) {
  const script = path.join('scripts', 'ops', 'branches', 'gen-env.js');
  await new Promise((resolve, reject) => {
    const child = spawn('node', [script, '--file', envFile], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('gen-env failed'))));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLegacyApiKeysToMatchSecret({
  listApiKeysFn,
  projectRef,
  token,
  secret,
  timeoutMs,
  intervalMs,
} = {}) {
  const listFn = typeof listApiKeysFn === 'function' ? listApiKeysFn : listApiKeys;
  const jwtSecretRaw = String(secret || '').trim();
  if (!jwtSecretRaw) throw new Error('waitForLegacyApiKeysToMatchSecret requires a jwt secret');

  const timeout =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 60_000;
  const interval =
    Number.isFinite(Number(intervalMs)) && Number(intervalMs) >= 0 ? Number(intervalMs) : 2_000;

  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeout) {
    attempt += 1;
    const keys = await listFn({ projectRef, token });
    const legacyAnon = findLegacyKey(keys, 'anon');
    const legacyService = findLegacyKey(keys, 'service_role');
    if (legacyAnon?.api_key && legacyService?.api_key) {
      const signingSecret = resolveJwtSigningSecret({
        secret: jwtSecretRaw,
        serviceKey: legacyService.api_key,
        anonKey: legacyAnon.api_key,
      });
      const matches =
        Boolean(signingSecret) &&
        isJwtSignedWithSecret(legacyService.api_key, signingSecret) &&
        isJwtSignedWithSecret(legacyAnon.api_key, signingSecret);
      if (matches) {
        return { legacyAnon, legacyService, attempts: attempt };
      }
    }
    await sleep(interval);
  }

  throw new Error('Timed out waiting for Supabase API keys to rotate after JWT secret update.');
}

async function main() {
  loadEnv();
  const trace = resolveTraceContext({
    operation: 'workspace.ensure_edge_role_api_keys',
    traceparent: process.env.TRACEPARENT,
  });

  const projectRef = String(process.env.SUPABASE_PROJECT_ID || '').trim();
  const token = String(process.env.SUPABASE_ACCESS_TOKEN || '').trim();
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const fixJwtSecret = process.argv.includes('--fix-jwt-secret') || process.argv.includes('--rotate-jwt-secret');
  const requireLeastPrivilege = process.argv.includes('--require-least-privilege');
  const ttlSeconds = (() => {
    const raw = String(process.env.EDGE_DB_JWT_TTL_SECONDS || '').trim();
    if (!raw) return 60 * 60 * 24 * 365; // 1 year
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 24 * 365;
  })();
  if (!projectRef) throw new Error('Missing SUPABASE_PROJECT_ID (set ENV_FILE=config/env/.env.cloud).');
  if (!token) throw new Error('Missing SUPABASE_ACCESS_TOKEN (required for Supabase Management API).');
  if (!supabaseUrl) throw new Error('Missing SUPABASE_URL (set ENV_FILE=config/env/.env.cloud).');

  const envFile = process.argv.includes('--file')
    ? String(process.argv[process.argv.indexOf('--file') + 1] || '').trim()
    : path.join('config', 'env', '.env.cloud');

  emitTrace(trace, 'info', {
    step: 'start',
    status: 'ok',
    project_ref: projectRef,
    fix_jwt_secret: fixJwtSecret,
    require_least_privilege: requireLeastPrivilege,
    env_file: envFile,
  });

  const existingKeys = await listApiKeys({ projectRef, token });

  // Always refresh legacy anon/service keys from management API so the local env
  // file remains the single source of truth for the current project.
  let legacyAnon = findLegacyKey(existingKeys, 'anon');
  let legacyService = findLegacyKey(existingKeys, 'service_role');
  if (!legacyAnon?.api_key || !legacyService?.api_key) {
    throw new Error('Unable to resolve legacy anon/service_role API keys from Supabase Management API.');
  }

  // Resolve JWT issuer from the legacy keys. We keep using legacy keys as the
  // `apikey` header (Supabase JS requirement), while `Authorization` may be a
  // distinct role-scoped DB JWT.
  let issuer = resolveJwtIssuer({ serviceKey: legacyService.api_key, anonKey: legacyAnon.api_key });
  let probeApiKey = legacyService.api_key;

  let rawSecret = String(process.env.SUPABASE_JWT_SECRET || '').trim();
  let effectiveSecret = null;
  let effectiveSecretLabel = '';
  let authPlaneMismatch = false;

  if (rawSecret) {
    const bearerCandidates = buildSupabaseApiBearerCandidates({ secretRaw: rawSecret, issuer, projectRef });
    const selected = await selectAuthPlaneCandidateOnce({
      supabaseUrl,
      restApiKey: probeApiKey,
      functionApiKey: legacyAnon.api_key,
      candidates: bearerCandidates,
      functionName: 'label-renderer',
    });
    emitTrace(trace, 'info', {
      step: 'existing_secret_probe',
      status: selected?.evaluation?.accepted ? 'ok' : 'not_ok',
      classification: selected?.evaluation?.classification || 'none',
      retryable: Boolean(selected?.evaluation?.retryable),
    });
    if (selected?.evaluation?.accepted && selected?.candidate?.secret) {
      effectiveSecret = selected.candidate.secret;
      effectiveSecretLabel = String(selected.candidate.label || '').trim();
    } else if (selected?.evaluation?.classification === 'function:jwt_rejected') {
      authPlaneMismatch = true;
      console.warn(
        '[ensure-edge-role-api-keys] Existing SUPABASE_JWT_SECRET validates REST but not Functions auth. Falling back to preview-compatible mode.',
      );
      emitTrace(trace, 'warn', {
        step: 'existing_secret_probe',
        status: 'fallback',
        reason: 'auth_plane_mismatch',
      });
    } else if (selected?.candidate?.secret) {
      // Retry once with explicit wait in case of transient readiness lag.
      const waited = await waitForAuthPlaneCandidate({
        supabaseUrl,
        restApiKey: probeApiKey,
        functionApiKey: legacyAnon.api_key,
        candidates: [selected.candidate],
        functionName: 'label-renderer',
        timeoutMs: 60_000,
        intervalMs: 2_000,
        logPrefix: '[ensure-edge-role-api-keys]',
      });
      emitTrace(trace, 'info', {
        step: 'existing_secret_wait',
        status: waited?.evaluation?.accepted ? 'ok' : 'not_ok',
        classification: waited?.evaluation?.classification || 'none',
        attempts: Number(waited?.attempts || 0),
      });
      if (waited?.evaluation?.accepted && waited?.candidate?.secret) {
        effectiveSecret = waited.candidate.secret;
        effectiveSecretLabel = String(waited.candidate.label || '').trim();
      } else {
        authPlaneMismatch = true;
        console.warn(
          '[ensure-edge-role-api-keys] Existing SUPABASE_JWT_SECRET validates REST but not Functions auth. Falling back to preview-compatible mode.',
        );
      }
    }
  }

  let leastPrivilegeReady = Boolean(effectiveSecret);

  if (fixJwtSecret) {
    const { timeoutMs, intervalMs } = resolveJwtPropagationOptions(process.env);
    const signingKeys = await listAuthSigningKeys(projectRef, token);
    const inUse = signingKeys.find((row) => row.status === 'in_use') || null;
    const inUseAlg = String(inUse?.algorithm || '').trim();
    if (inUseAlg && inUseAlg !== 'HS256') {
      console.warn(
        `[ensure-edge-role-api-keys] Project auth signing key in_use is ${inUseAlg}; rotating to HS256 so edge DB JWTs can be minted.`,
      );
    }

    const nextSecretHex = randomJwtSecret();
    const secretBytes = Buffer.from(nextSecretHex, 'hex');
    const privateJwk = {
      kty: 'oct',
      k: base64UrlEncode(secretBytes),
      alg: 'HS256',
      use: 'sig',
    };

    console.log(
      `[ensure-edge-role-api-keys] Creating HS256 auth signing key (sha256/12=${safeFingerprint(nextSecretHex)})...`,
    );
    const created = await createAuthSigningKeyInUse(projectRef, token, {
      algorithm: 'HS256',
      privateJwk,
      maxRevokeAttempts: 2,
      onRevoke: (candidate) => {
        const recovery = String(candidate?.recovery || '').trim();
        if (recovery === 'standby_conflict') {
          console.warn(
            `[ensure-edge-role-api-keys] Demoting standby auth signing key to previously_used to free standby capacity (id=${String(
              candidate?.id || '',
            ).trim()}; alg=${String(candidate?.algorithm || '').trim() || 'unknown'}).`,
          );
          return;
        }
        console.warn(
          `[ensure-edge-role-api-keys] Revoking previously_used auth signing key to free capacity (id=${String(
            candidate?.id || '',
          ).trim()}; alg=${String(candidate?.algorithm || '').trim() || 'unknown'}).`,
        );
      },
      onRecycleStandby: (candidate) => {
        console.warn(
          `[ensure-edge-role-api-keys] Recycling standby auth signing key to previously_used before retry (id=${String(
            candidate?.id || '',
          ).trim()}; alg=${String(candidate?.algorithm || '').trim() || 'unknown'}).`,
        );
      },
    });
    const keyId = String(created?.id || '').trim();
    if (!keyId) throw new Error('Auth signing key creation did not return an id.');

    let rotated = null;
    try {
      rotated = await waitForLegacyApiKeysToMatchSecret({
        projectRef,
        token,
        secret: nextSecretHex,
        timeoutMs,
        intervalMs,
      });
      legacyAnon = rotated.legacyAnon;
      legacyService = rotated.legacyService;
      issuer = resolveJwtIssuer({ serviceKey: legacyService.api_key, anonKey: legacyAnon.api_key });
      probeApiKey = legacyService.api_key;
      emitTrace(trace, 'info', {
        step: 'fix_jwt_secret_refresh_legacy_keys',
        status: 'ok',
        attempts: Number(rotated?.attempts || 0),
      });
    } catch (err) {
      authPlaneMismatch = true;
      leastPrivilegeReady = false;
      console.warn(
        `[ensure-edge-role-api-keys] ${err.message} Using preview-compatible fallback.`,
      );
      emitTrace(trace, 'warn', {
        step: 'fix_jwt_secret_refresh_legacy_keys',
        status: 'fallback',
        reason: 'legacy_api_key_rotation_timeout',
      });
    }

    if (rotated) {
      const minted = buildSupabaseApiKeys({ secret: secretBytes, issuer, projectRef });
      if (!minted?.service) throw new Error('Failed to mint service_role probe JWT after signing key rotation.');

      const authPlaneReady = await waitForAuthPlaneCandidate({
        supabaseUrl,
        restApiKey: probeApiKey,
        functionApiKey: legacyAnon.api_key,
        candidates: [{ label: 'hs256', secret: secretBytes, bearerToken: minted.service }],
        functionName: 'label-renderer',
        payload: { lease_seconds: 1, max_jobs: 1 },
        timeoutMs,
        intervalMs,
        logPrefix: '[ensure-edge-role-api-keys]',
      });
      emitTrace(trace, 'info', {
        step: 'fix_jwt_secret_probe',
        status: authPlaneReady?.evaluation?.accepted ? 'ok' : 'not_ok',
        classification: authPlaneReady?.evaluation?.classification || 'none',
        attempts: Number(authPlaneReady?.attempts || 0),
        bearer_sha256_12: safeFingerprint(minted.service),
      });
      if (authPlaneReady?.evaluation?.accepted) {
        rawSecret = nextSecretHex;
        effectiveSecret = secretBytes;
        effectiveSecretLabel = 'hs256';
        leastPrivilegeReady = true;
      } else {
        authPlaneMismatch = true;
        leastPrivilegeReady = false;
        console.warn(
          `[ensure-edge-role-api-keys] Auth-plane probe rejected HS256 token after ${authPlaneReady?.attempts || 0} attempts; using preview-compatible fallback.`,
        );
      }
    }
  }

  if (requireLeastPrivilege && !leastPrivilegeReady) {
    throw new Error(
      'SUPABASE_JWT_SECRET is missing or not accepted by the project signing keys. ' +
        'If the project uses HS256 signing and you have the legacy secret, set SUPABASE_JWT_SECRET from Supabase Dashboard -> JWT Keys -> Legacy JWT Secret, then rerun. ' +
        'If this is a workspace project and the Management API redacts the secret, run ' +
        '`ENV_FILE=config/env/.env.cloud node scripts/ops/workspace/ensure-edge-role-api-keys.js --fix-jwt-secret` ' +
        '(WARNING: rotates project auth signing keys; invalidates existing JWTs/sessions; workspace/preview only).',
    );
  }

  const edgeBundle = leastPrivilegeReady
    ? buildEdgeDbJwtBundle({ secret: effectiveSecret, issuer, ttlSec: ttlSeconds })
    : buildFallbackEdgeDbJwtBundle(legacyService.api_key);
  const edgeGuard = resolveEdgeGuardSettings(leastPrivilegeReady);

  await writeEnv({
    envFile,
    payload: {
      project_ref: projectRef,
      supabase_url: supabaseUrl,
      anon_key: legacyAnon.api_key,
      service_role_key: legacyService.api_key,
      // Persist only a verified jwt secret. When absent/mismatched, clear it so
      // future scripts do not mint invalid JWTs.
      jwt_secret: leastPrivilegeReady ? rawSecret : '',
      webhook_db_jwt: edgeBundle.webhook_db_jwt,
      api_caller_db_jwt: edgeBundle.api_caller_db_jwt,
      api_gateway_db_jwt: edgeBundle.api_gateway_db_jwt,
      label_renderer_db_jwt: edgeBundle.label_renderer_db_jwt,
      edge_db_jwt: edgeBundle.api_gateway_db_jwt,
      preview_mode: edgeGuard.previewMode,
      edge_require_db_jwt: edgeGuard.edgeRequireDbJwt,
    },
  });

  console.log('[ensure-edge-role-api-keys] Updated ENV file:', envFile);
  console.log('[ensure-edge-role-api-keys] Mode:', edgeGuard.modeLabel);
  if (authPlaneMismatch && !leastPrivilegeReady) {
    console.warn(
      '[ensure-edge-role-api-keys] Auth plane mismatch detected (REST vs Functions). Wrote fallback env (PREVIEW_MODE=1, EDGE_REQUIRE_DB_JWT=0).',
    );
  }
  console.log(
    `[ensure-edge-role-api-keys] Guard toggles: PREVIEW_MODE=${edgeGuard.previewMode}, EDGE_REQUIRE_DB_JWT=${edgeGuard.edgeRequireDbJwt}`,
  );
  console.log('[ensure-edge-role-api-keys] Key fingerprints (sha256/12):');
  console.log(`  SUPABASE_ANON_KEY:          ${safeFingerprint(legacyAnon.api_key)}`);
  console.log(`  SUPABASE_SERVICE_ROLE_KEY:  ${safeFingerprint(legacyService.api_key)}`);
  console.log(`  WEBHOOK_DB_JWT:             ${safeFingerprint(edgeBundle.webhook_db_jwt)}`);
  console.log(`  API_CALLER_DB_JWT:          ${safeFingerprint(edgeBundle.api_caller_db_jwt)}`);
  console.log(`  API_GATEWAY_DB_JWT:         ${safeFingerprint(edgeBundle.api_gateway_db_jwt)}`);
  console.log(`  LABEL_RENDERER_DB_JWT:      ${safeFingerprint(edgeBundle.label_renderer_db_jwt)}`);
  emitTrace(trace, 'info', {
    step: 'complete',
    status: 'ok',
    mode: edgeGuard.modeLabel,
    least_privilege_ready: leastPrivilegeReady,
    secret_format: effectiveSecretLabel || '',
    auth_plane_mismatch: authPlaneMismatch,
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[ensure-edge-role-api-keys] Failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  resolveEdgeGuardSettings,
  decodeJwtHeaderAlg,
  waitForLegacyApiKeysToMatchSecret,
};
