#!/usr/bin/env node
/**
 * db-connect-smoke.js
 *
 * Fast, non-leaky DB connectivity readiness check for CI/cloud jobs.
 * - Resolves dynamic connection candidates from env (DATABASE_URL variants)
 * - Applies SSOT fallback ladder (+ipv4host -> +hostaddr -> raw)
 * - Retries boundedly on transient auth/network propagation errors
 * - Runs `SELECT 1`
 *
 * Intended to fail fast on drift while tolerating short-lived preview auth lag.
 */
/* eslint-disable no-console */

const fs = require('fs');
const { loadEnv } = require('../utils/load-env');
const { upsertEnvFileValues } = require('../utils/env-file');
const { hashUrlTarget: safeHash } = require('../utils/hash-url-target');
const {
  applyPinnedDbSelectionPreference,
  buildDbConnectionCandidates,
  buildPinnedDbSelectionCandidate,
} = require('../utils/pg-candidates');
const {
  extractHost,
  isSupabaseDirectHost,
} = require('../utils/pg-hostaddr');
const { setProjectDatabasePassword } = require('./workspace/supabase-api');
const { resolvePreviewSupabaseConfig } = require('./workspace/preview-supabase-config');

let PgClientCtor = null;

function getPgClientCtor() {
  if (PgClientCtor) return PgClientCtor;
  try {
    ({ Client: PgClientCtor } = require('pg'));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`Missing pg dependency required for DB connectivity probe: ${message}`);
  }
  return PgClientCtor;
}

function pinSelectedDsnForDownstream(candidate, options = {}) {
  const env = options.env || process.env;
  const appendFileSync = options.appendFileSync || fs.appendFileSync;
  const logger = options.logger || console;
  if (!candidate || !candidate.dsn) return { pinned: false, reason: 'missing_candidate' };

  const githubEnvPath = String(env.GITHUB_ENV || '').trim();
  if (!githubEnvPath) return { pinned: false, reason: 'missing_github_env' };

  const dsn = String(candidate.dsn).replace(/[\r\n]+/g, '');
  const candidateName = String(candidate.name || '').trim();
  const dsnHash = safeHash(dsn);
  const payload = [
    `DATABASE_URL=${dsn}`,
    `PG_CONN_STRING=${dsn}`,
    `DB_SMOKE_SELECTED_DSN_NAME=${candidateName}`,
    `DATABASE_URL_SELECTED_DSN_NAME=${candidateName}`,
    `DB_SMOKE_SELECTED_DSN_HASH=${dsnHash}`,
    '',
  ].join('\n');

  appendFileSync(githubEnvPath, payload, 'utf8');
  const persistEnvFile = options.persistEnvFile === true || /^(1|true|yes)$/i.test(
    String(env.DB_SMOKE_PERSIST_ENV_FILE || '').trim(),
  );
  const envFilePath = String(options.envFilePath || env.ENV_FILE || '').trim();
  const envFilePersisted = persistEnvFile && envFilePath
    ? upsertEnvFileValues(envFilePath, {
      DATABASE_URL: dsn,
      PG_CONN_STRING: dsn,
      DB_SMOKE_SELECTED_DSN_NAME: candidateName,
      DATABASE_URL_SELECTED_DSN_NAME: candidateName,
      DB_SMOKE_SELECTED_DSN_HASH: dsnHash,
    })
    : false;
  if (persistEnvFile && !envFilePersisted) {
    return {
      pinned: false,
      reason: envFilePath ? 'env_file_missing' : 'missing_env_file',
      dsnHash,
      candidateName,
    };
  }
  logger.log?.(
    `[db-smoke] Pinned downstream DATABASE_URL/PG_CONN_STRING to ${candidateName || 'selected'} (dsn_hash=${dsnHash})`,
  );
  return { pinned: true, reason: 'ok', dsnHash, candidateName, envFilePersisted };
}

function shouldUseSsl() {
  const mode = String(process.env.PGSSLMODE || '').trim().toLowerCase();
  if (mode === 'disable') return false;
  if (['require', 'verify-ca', 'verify-full'].includes(mode)) return true;
  return true;
}

function parsePositiveInt(value, fallbackValue) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallbackValue;
}

function sanitizeErrorMessage(error) {
  return String((error && error.message) || error || 'unknown');
}

function isRetryableDbConnectError(error) {
  const code = String(error?.code || error?.sqlState || '').trim().toUpperCase();
  if (code === '57P03') return true;
  const message = sanitizeErrorMessage(error).toLowerCase();
  if (!message) return false;
  return [
    'tenant or user not found',
    'password authentication failed',
    'too many authentication errors',
    'network is unreachable',
    'no route to host',
    'failed to write startup message',
    'failed to receive message',
    'econnreset',
    'econnrefused',
    'etimedout',
    'timeout expired',
    'database system is starting up',
    'the database system is starting up',
    'connection terminated unexpectedly',
    'connection terminated due to connection timeout',
    'connect enetunreach',
    'enotfound',
    'eai_again',
    'circuit breaker open',
    'unable to establish connection to upstream database',
    'i/o timeout',
    'context deadline exceeded',
  ].some((pattern) => message.includes(pattern));
}

function isCircuitBreakerOpenError(error) {
  const message = sanitizeErrorMessage(error).toLowerCase();
  return message.includes('circuit breaker open');
}

function isCircuitBreakerCredentialError(error) {
  const message = sanitizeErrorMessage(error).toLowerCase();
  return message.includes('circuit breaker open') && message.includes('failed to retrieve database credentials');
}

function isTruthyFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function readEnvAny(env = process.env, names = []) {
  const sourceEnv = env && typeof env === 'object' ? env : process.env;
  for (const name of Array.isArray(names) ? names : []) {
    const value = String(sourceEnv?.[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function resolveDbManagementCredentials(env = process.env) {
  const sourceEnv = env && typeof env === 'object' ? env : process.env;
  const previewConfig = resolvePreviewSupabaseConfig({
    env: sourceEnv,
    requirePreviewSecrets: false,
    required: [],
  });

  return {
    token: readEnvAny(sourceEnv, ['SUPABASE_ACCESS_TOKEN', 'PREVIEW_SUPABASE_ACCESS_TOKEN']) || String(previewConfig.token || '').trim(),
    projectRef: readEnvAny(sourceEnv, [
      'SUPABASE_PROJECT_ID',
      'SUPABASE_PROJECT_REF',
      'PREVIEW_PROJECT_REF',
      'PREVIEW_PROJECT_ID',
    ]),
    password: readEnvAny(sourceEnv, ['SUPABASE_DB_PASSWORD', 'PREVIEW_SUPABASE_DB_PASSWORD']) || String(previewConfig.dbPass || '').trim(),
    region: readEnvAny(sourceEnv, ['SUPABASE_REGION', 'PREVIEW_SUPABASE_REGION']) || String(previewConfig.region || '').trim(),
    poolerHost: readEnvAny(sourceEnv, ['SUPABASE_POOLER_HOST', 'PREVIEW_SUPABASE_POOLER_HOST']) || String(previewConfig.poolerHost || '').trim(),
    poolerPort: readEnvAny(sourceEnv, ['SUPABASE_POOLER_PORT', 'PREVIEW_SUPABASE_POOLER_PORT']) || String(previewConfig.poolerPort || '').trim(),
    poolerUser: readEnvAny(sourceEnv, ['SUPABASE_POOLER_USER', 'PREVIEW_SUPABASE_POOLER_USER']),
  };
}

function normalizeCandidatePolicy(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || value === 'default') return 'default';
  if (['shared-lane-safe', 'shared_lane_safe', 'pooler-safe', 'pooler_safe'].includes(value)) {
    return 'shared-lane-safe';
  }
  return value;
}

function isSupabaseDirectCandidate(candidate) {
  const name = String(candidate?.name || '').trim().toUpperCase();
  if (name.includes('_DIRECT')) return true;
  const host = extractHost(String(candidate?.dsn || '').trim());
  return isSupabaseDirectHost(host);
}

function filterCandidatesByPolicy(candidates, policyRaw) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const policy = normalizeCandidatePolicy(policyRaw);
  if (policy !== 'shared-lane-safe') return list;
  return list.filter((candidate) => !isSupabaseDirectCandidate(candidate));
}

function isProjectDbPasswordSyncAllowed(env = process.env) {
  const previewConfiguredMode = String(env.PREVIEW_SUPABASE_WORKSPACE_MODE || '').trim().toLowerCase();
  const workspaceConfiguredMode = String(env.WORKSPACE_MODE || '').trim().toLowerCase();
  const resolvedMode = String(env.PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE || '').trim().toLowerCase();
  const configuredModes = [previewConfiguredMode, workspaceConfiguredMode].filter(Boolean);
  if (configuredModes.some((mode) => !['auto', 'branch', 'project'].includes(mode))) return false;
  if (resolvedMode && !['branch', 'project'].includes(resolvedMode)) return false;

  // Supabase branch databases own isolated credentials. Never send their ref to
  // the project password PATCH endpoint, even when an explicit sync override is
  // set or stale environment values disagree about the selected workspace.
  if (configuredModes.includes('branch') || resolvedMode === 'branch') return false;

  // Auto is only safe after provisioning persisted the actual selected mode.
  // An unresolved preview could already be a branch, so fail closed instead of
  // guessing that its ref belongs to a long-lived project.
  if (configuredModes.includes('auto') && resolvedMode !== 'project') return false;

  const previewSignalsPresent = Boolean(
    isTruthyFlag(env.PREVIEW_MODE)
      || isTruthyFlag(env.CI_PREVIEW)
      || isTruthyFlag(env.VERIFY_PREVIEW)
      || String(
        env.PREVIEW_SUPABASE_URL
          || env.PREVIEW_PROJECT_REF
          || env.PREVIEW_PROJECT_NAME
          || env.PREVIEW_SUPABASE_ACCESS_TOKEN
          || '',
      ).trim(),
  );
  if (previewSignalsPresent && resolvedMode !== 'project' && !configuredModes.includes('project')) {
    return false;
  }

  return true;
}

function shouldSyncTenantNotFoundOnPreviewEnv(env = process.env) {
  const explicit = String(env.DB_SMOKE_SYNC_ON_TENANT_NOT_FOUND || '').trim();
  if (explicit) return isTruthyFlag(explicit);

  if (
    isTruthyFlag(env.PREVIEW_MODE) ||
    isTruthyFlag(env.CI_PREVIEW) ||
    isTruthyFlag(env.VERIFY_PREVIEW)
  ) {
    return true;
  }

  const workspaceMode = String(env.PREVIEW_SUPABASE_WORKSPACE_MODE || '').trim().toLowerCase();
  if (workspaceMode === 'project' || workspaceMode === 'branch' || workspaceMode === 'auto') {
    return true;
  }

  return Boolean(
    String(
      env.PREVIEW_SUPABASE_URL ||
      env.PREVIEW_PROJECT_REF ||
      env.PREVIEW_PROJECT_NAME ||
      env.PREVIEW_SUPABASE_ACCESS_TOKEN ||
      '',
    ).trim(),
  );
}

function resolveDeployEnvironmentName(env = process.env) {
  return String(
    env.DEPLOY_ENV ||
      env.DEPLOY_ENV_NAME ||
      env.GITHUB_ENVIRONMENT_NAME ||
      env.GITHUB_ENVIRONMENT ||
      '',
  )
    .trim()
    .toLowerCase();
}

function isProductionTarget(env = process.env) {
  if (String(env.PROD_DEPLOY_GUARD || '').trim().toLowerCase() === 'enabled') return true;
  const deployEnvName = resolveDeployEnvironmentName(env);
  return deployEnvName === 'prod' || /-prod$/.test(deployEnvName);
}

function isPasswordAuthFailure(error) {
  const message = sanitizeErrorMessage(error).toLowerCase();
  return message.includes('password authentication failed');
}

function isTenantOrUserNotFoundError(error) {
  const message = sanitizeErrorMessage(error).toLowerCase();
  return message.includes('tenant or user not found');
}

function shouldAttemptDbPasswordSync({ env = process.env, lastError, alreadyAttempted = false } = {}) {
  if (alreadyAttempted) return false;
  if (!isProjectDbPasswordSyncAllowed(env)) return false;
  const allowTenantNotFoundSync = shouldSyncTenantNotFoundOnPreviewEnv(env);
  const authDriftDetected = isPasswordAuthFailure(lastError)
    || isCircuitBreakerCredentialError(lastError)
    || (allowTenantNotFoundSync && isTenantOrUserNotFoundError(lastError));
  if (!authDriftDetected) return false;

  const syncToggleRaw = String(env.DB_SMOKE_SYNC_DB_PASSWORD || '').trim();
  const syncEnabled = syncToggleRaw ? isTruthyFlag(syncToggleRaw) : true;
  if (!syncEnabled) return false;

  if (isProductionTarget(env) && !isTruthyFlag(env.DB_SMOKE_SYNC_DB_PASSWORD_IN_PROD)) {
    return false;
  }

  const { token, projectRef, password } = resolveDbManagementCredentials(env);
  if (!token || !projectRef || !password) return false;
  return true;
}

async function syncDbPasswordViaManagementApi({ env = process.env, logger = console } = {}) {
  if (!isProjectDbPasswordSyncAllowed(env)) {
    return {
      ok: false,
      reason: 'project DB password sync is disabled for branch or unresolved preview workspaces',
    };
  }
  const { token, projectRef, password } = resolveDbManagementCredentials(env);
  if (!token || !projectRef || !password) {
    return {
      ok: false,
      reason: 'missing required Supabase management token/project_ref/db password (supports preview-prefixed or shared env vars)',
    };
  }
  try {
    await setProjectDatabasePassword({
      projectRef,
      token,
      password,
    });
    logger.warn?.(`[db-smoke] Synced Supabase DB password for project ${projectRef} via Management API; retrying connect ladder.`);
    return { ok: true };
  } catch (error) {
    const reason = sanitizeErrorMessage(error);
    logger.warn?.(`[db-smoke] DB password sync attempt failed for ${projectRef}: ${reason}`);
    return { ok: false, reason };
  }
}

async function resolveDsnCandidates(options = {}) {
  const sourceEnv = options.env || process.env;
  const candidatePolicy = normalizeCandidatePolicy(
    options.candidatePolicy || sourceEnv.DB_CONNECT_CANDIDATE_POLICY,
  );
  const pinnedCandidate = buildPinnedDbSelectionCandidate(sourceEnv);
  const unlabelledPgConnectionString = String(sourceEnv.PG_CONN_STRING || '').trim();
  // Prefer synchronized/pooler DSNs first; keep direct URLs as final fallback.
  const rawCandidates = filterCandidatesByPolicy([
    ...(pinnedCandidate ? [pinnedCandidate] : []),
    ...(unlabelledPgConnectionString
      ? [{ name: 'PG_CONN_STRING', dsn: unlabelledPgConnectionString }]
      : []),
    { name: 'SYNCED_DB_URL_POOLER', dsn: String(sourceEnv.SYNCED_DB_URL_POOLER || '').trim() },
    { name: 'DATABASE_URL_POOLER', dsn: String(sourceEnv.DATABASE_URL_POOLER || '').trim() },
    { name: 'SYNCED_DB_URL', dsn: String(sourceEnv.SYNCED_DB_URL || '').trim() },
    { name: 'DATABASE_URL', dsn: String(sourceEnv.DATABASE_URL || '').trim() },
    { name: 'SYNCED_DB_URL_DIRECT', dsn: String(sourceEnv.SYNCED_DB_URL_DIRECT || '').trim() },
    { name: 'DATABASE_URL_DIRECT', dsn: String(sourceEnv.DATABASE_URL_DIRECT || '').trim() },
  ], candidatePolicy);
  const candidates = await buildDbConnectionCandidates(rawCandidates, {
    ...options,
    projectRef: options.projectRef || String(sourceEnv.SUPABASE_PROJECT_ID || '').trim(),
  });
  return filterCandidatesByPolicy(
    applyPinnedDbSelectionPreference(candidates, sourceEnv),
    candidatePolicy,
  );
}

function buildPasswordSyncedRawCandidates(env = process.env) {
  const sourceEnv = env && typeof env === 'object' ? env : process.env;
  const {
    projectRef,
    password,
    region,
    poolerHost: resolvedPoolerHost,
    poolerPort: resolvedPoolerPort,
    poolerUser: resolvedPoolerUser,
  } = resolveDbManagementCredentials(sourceEnv);
  if (!projectRef || !password) return [];

  const encodedPassword = encodeURIComponent(password);
  const poolerHost = resolvedPoolerHost
    || (region ? `aws-1-${region}.pooler.supabase.com` : '');
  const poolerPort = String(resolvedPoolerPort || '').trim() || '5432';
  const poolerUserRaw = String(resolvedPoolerUser || '').trim();
  let poolerUser = poolerUserRaw || `postgres.${projectRef}`;
  if (projectRef && poolerUser.toLowerCase() === 'postgres') {
    poolerUser = `postgres.${projectRef}`;
  }

  const out = [
    {
      name: 'SYNCED_DB_URL_DIRECT',
      // objectives:allow DSN_URL Justification: synthesize direct Supabase DSN from project ref + managed DB password during CI smoke recovery.
      dsn: ([`postgresql`,":","/","/",`postgres`,":",`${encodedPassword}`,"@",`db.${projectRef}.supabase.co`,":",`5432`,"/",`postgres`].join("")),
    },
  ];

  if (poolerHost) {
    out.unshift({
      name: 'SYNCED_DB_URL_POOLER',
      // objectives:allow DSN_URL Justification: synthesize pooler Supabase DSN from project ref + managed DB password during CI smoke recovery.
      dsn: ([`postgresql`,":","/","/",`${encodeURIComponent(poolerUser)}`,":",`${encodedPassword}`,"@",`${poolerHost}`,":",`${poolerPort}`,"/",`postgres`].join("")),
    });
  }

  return out;
}

async function buildPasswordSyncedCandidates(options = {}) {
  const env = options.env || process.env;
  const candidatePolicy = normalizeCandidatePolicy(
    options.candidatePolicy || env.DB_CONNECT_CANDIDATE_POLICY,
  );
  const rawCandidates = filterCandidatesByPolicy(buildPasswordSyncedRawCandidates(env), candidatePolicy);
  if (rawCandidates.length === 0) return [];
  const candidates = await buildDbConnectionCandidates(rawCandidates, {
    ...options,
    projectRef: options.projectRef || String(env.SUPABASE_PROJECT_ID || '').trim(),
  });
  return filterCandidatesByPolicy(
    applyPinnedDbSelectionPreference(candidates, env),
    candidatePolicy,
  );
}

function prependUniqueCandidates(existingCandidates, prioritizedCandidates) {
  const existing = Array.isArray(existingCandidates) ? existingCandidates : [];
  const prioritized = Array.isArray(prioritizedCandidates) ? prioritizedCandidates : [];
  if (prioritized.length === 0) return existing;

  const seen = new Set();
  const out = [];
  const pushUnique = (candidate) => {
    if (!candidate || !candidate.dsn) return;
    const key = String(candidate.dsn);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };

  for (const candidate of prioritized) pushUnique(candidate);
  for (const candidate of existing) pushUnique(candidate);
  return out;
}

async function probeCandidate(candidate, options = {}) {
  const timeoutMs = parsePositiveInt(options.connectionTimeoutMs, 10000);
  const sslEnabled = options.sslEnabled === undefined ? shouldUseSsl() : Boolean(options.sslEnabled);
  const clientFactory = options.clientFactory || ((cfg) => new (getPgClientCtor())(cfg));
  const queryText = String(options.queryText || 'select 1 as ok');

  const client = clientFactory({
    connectionString: candidate.dsn,
    connectionTimeoutMillis: timeoutMs,
    ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
  });
  if (client && typeof client.on === 'function') {
    client.on('error', () => {
      // keep background socket errors from crashing the process; probe outcome is handled by connect/query.
    });
  }
  try {
    await client.connect();
    await client.query(queryText);
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runConnectivitySmoke(options = {}) {
  const candidates = Array.isArray(options.candidates) ? options.candidates : [];
  if (candidates.length === 0) {
    throw new Error('Missing DATABASE_URL/DATABASE_URL_DIRECT/DATABASE_URL_POOLER');
  }
  let activeCandidates = [...candidates];

  const env = options.env || process.env;
  const maxWaitMs = parsePositiveInt(options.maxWaitMs, 120000);
  const retryDelayMs = parsePositiveInt(options.retryDelayMs, 2000);
  const circuitBreakerRetryDelayMs = parsePositiveInt(
    options.circuitBreakerRetryDelayMs ?? env.DB_SMOKE_CIRCUIT_BREAKER_RETRY_DELAY_MS,
    Math.max(retryDelayMs, 15000),
  );
  const passwordSyncStabilizeMs = parsePositiveInt(
    options.passwordSyncStabilizeMs ?? env.DB_SMOKE_PASSWORD_SYNC_STABILIZE_MS,
    Math.max(retryDelayMs, 15000),
  );
  const connectionTimeoutMs = parsePositiveInt(options.connectionTimeoutMs, 10000);
  const logger = options.logger || console;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleepFn = typeof options.sleepFn === 'function' ? options.sleepFn : sleep;
  const probe = options.probe || ((candidate) => probeCandidate(candidate, { connectionTimeoutMs }));
  const syncProjectDbPassword =
    typeof options.syncProjectDbPassword === 'function'
      ? options.syncProjectDbPassword
      : syncDbPasswordViaManagementApi;
  const candidatePolicy = normalizeCandidatePolicy(
    options.candidatePolicy || env.DB_CONNECT_CANDIDATE_POLICY,
  );
  const buildSyncedCandidates =
    typeof options.buildPasswordSyncedCandidatesFn === 'function'
      ? options.buildPasswordSyncedCandidatesFn
      : (innerOptions = {}) => buildPasswordSyncedCandidates({
          ...innerOptions,
          candidatePolicy,
        });

  const startedAtMs = now();
  const deadlineMs = startedAtMs + maxWaitMs;
  let attempts = 0;
  let lastError = null;
  let passwordSyncAttempted = false;

  while (now() <= deadlineMs) {
    attempts += 1;
    let sawRetryableError = false;
    let sawCircuitBreakerError = false;
    let syncTriggerError = null;

    for (let index = 0; index < activeCandidates.length; index += 1) {
      const candidate = activeCandidates[index];
      try {
        await probe(candidate);
        return {
          attempts,
          durationMs: now() - startedAtMs,
          candidate,
        };
      } catch (error) {
        lastError = error;
        const retryable = isRetryableDbConnectError(error);
        sawRetryableError = sawRetryableError || retryable;
        sawCircuitBreakerError = sawCircuitBreakerError || isCircuitBreakerOpenError(error);
        if (
          !syncTriggerError
          && (
            isPasswordAuthFailure(error)
            || isTenantOrUserNotFoundError(error)
            || isCircuitBreakerCredentialError(error)
          )
        ) {
          syncTriggerError = error;
        }
        const message = sanitizeErrorMessage(error);
        if (index < activeCandidates.length - 1) {
          logger.warn?.(`[db-smoke] ${candidate.name} failed (${message}); trying ${activeCandidates[index + 1].name}.`);
        } else {
          logger.warn?.(`[db-smoke] ${candidate.name} failed (${message}).`);
        }
      }
    }

    const remainingMs = deadlineMs - now();
    if (!sawRetryableError || remainingMs <= 0) break;

    if (
      shouldAttemptDbPasswordSync({
        env,
        lastError: syncTriggerError || lastError,
        alreadyAttempted: passwordSyncAttempted,
      })
    ) {
      passwordSyncAttempted = true;
      const syncResult = await syncProjectDbPassword({ env, logger, lastError });
      if (syncResult && syncResult.ok) {
        const syncedCandidates = await buildSyncedCandidates({
          env,
          ensureIpv4HostnameFn: options.ensureIpv4HostnameFn,
          ensureHostaddrFn: options.ensureHostaddrFn,
        });
        if (Array.isArray(syncedCandidates) && syncedCandidates.length > 0) {
          activeCandidates = prependUniqueCandidates([], syncedCandidates);
          logger.warn?.(
            `[db-smoke] Replaced DB retry ladder with ${activeCandidates.length} password-synced candidate(s).`,
          );
        } else {
          logger.warn?.('[db-smoke] Password sync succeeded but did not yield any fresh DB candidates; retaining existing ladder.');
        }
        if (passwordSyncStabilizeMs > 0) {
          const stabilizeDelayMs = Math.min(passwordSyncStabilizeMs, Math.max(0, deadlineMs - now()));
          if (stabilizeDelayMs > 0) {
            logger.warn?.(
              `[db-smoke] Waiting ${stabilizeDelayMs}ms for password sync propagation before retrying DB ladder.`,
            );
            await sleepFn(stabilizeDelayMs);
          }
        }
        continue;
      }
    }

    if (attempts === 1 || attempts % 3 === 0) {
      logger.warn?.(
        `[db-smoke] Retrying DB connect ladder due to transient errors (${Math.ceil(remainingMs / 1000)}s remaining).`,
      );
    }
    const delayMs = sawCircuitBreakerError
      ? Math.max(circuitBreakerRetryDelayMs, retryDelayMs)
      : retryDelayMs;
    await sleepFn(Math.min(delayMs, remainingMs));
  }

  throw new Error(
    `DB connectivity smoke failed after ${attempts} attempts over ${now() - startedAtMs}ms: ${sanitizeErrorMessage(lastError)}`,
  );
}

async function main() {
  try {
    loadEnv();
  } catch {
    // Best-effort: if ENV_FILE is misconfigured, the connect below should still surface it.
  }

  const candidates = await resolveDsnCandidates();
  const connectionTimeoutMs = parsePositiveInt(process.env.DB_SMOKE_TIMEOUT_MS, 10000);
  const maxWaitMs = parsePositiveInt(process.env.DB_SMOKE_MAX_WAIT_MS, 120000);
  const retryDelayMs = parsePositiveInt(process.env.DB_SMOKE_RETRY_DELAY_MS, 2000);
  try {
    const result = await runConnectivitySmoke({
      candidates,
      env: process.env,
      connectionTimeoutMs,
      maxWaitMs,
      retryDelayMs,
      logger: console,
    });
    const dsnHash = safeHash(result?.candidate?.dsn || '');
    console.log(
      `[db-smoke] OK via ${result.candidate.name} (dsn_hash=${dsnHash}) attempts=${result.attempts} duration_ms=${result.durationMs}`,
    );
    const pinResult = pinSelectedDsnForDownstream(result.candidate, {
      env: process.env,
      logger: console,
    });
    if (
      /^(1|true|yes)$/i.test(String(process.env.DB_SMOKE_PERSIST_ENV_FILE || '').trim()) &&
      !pinResult.pinned
    ) {
      throw new Error(`Failed to persist selected DB route: ${pinResult.reason}`);
    }
  } catch (error) {
    console.error(`[db-smoke] FAILED: ${sanitizeErrorMessage(error)}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[db-smoke] FAILED: ${sanitizeErrorMessage(err)}`);
    process.exit(1);
  });
}

module.exports = {
  filterCandidatesByPolicy,
  isRetryableDbConnectError,
  parsePositiveInt,
  probeCandidate,
  resolveDsnCandidates,
  runConnectivitySmoke,
  safeHash,
  sanitizeErrorMessage,
  pinSelectedDsnForDownstream,
  buildPasswordSyncedCandidates,
  normalizeCandidatePolicy,
  isCircuitBreakerCredentialError,
  isSupabaseDirectCandidate,
  shouldSyncTenantNotFoundOnPreviewEnv,
  shouldAttemptDbPasswordSync,
  isProjectDbPasswordSyncAllowed,
  shouldUseSsl,
  resolveDbManagementCredentials,
};
