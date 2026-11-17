const {
  filterCandidatesByPolicy,
  isRetryableDbConnectError,
  parsePositiveInt,
  resolveDsnCandidates,
  runConnectivitySmoke,
  sanitizeErrorMessage,
} = require('../ops/db-connect-smoke');

let PgPoolCtor = null;

function getPgPoolCtor() {
  if (PgPoolCtor) return PgPoolCtor;
  try {
    ({ Pool: PgPoolCtor } = require('pg'));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`Missing pg dependency required for DB URL connectivity probe: ${message}`);
  }
  return PgPoolCtor;
}

async function resolveDbCandidates(env = process.env, options = {}) {
  return resolveDsnCandidates({
    env,
    candidatePolicy: options.candidatePolicy,
  });
}

function resolveEnvOverride(env = process.env, envNames = [], fallbackName = '') {
  const names = [
    ...(Array.isArray(envNames) ? envNames : []),
    ...(fallbackName ? [fallbackName] : []),
  ].filter(Boolean);
  for (const name of names) {
    const value = env?.[name];
    if (String(value == null ? '' : value).trim()) return value;
  }
  return '';
}

function normalizeSslMode(value) {
  const mode = String(value == null ? '' : value).trim().toLowerCase();
  return mode;
}

function sslEnabledFromMode(mode) {
  if (!mode) return null;
  if (['disable', 'allow', 'prefer'].includes(mode)) return false;
  if (['require', 'verify-ca', 'verify-full', 'no-verify'].includes(mode)) return true;
  return null;
}

function inferSslEnabledForDsn(dsn, fallback = true) {
  try {
    const parsed = new URL(String(dsn || '').trim());
    const modeFromQuery = sslEnabledFromMode(normalizeSslMode(parsed.searchParams.get('sslmode')));
    if (modeFromQuery != null) return modeFromQuery;
    const host = String(parsed.hostname || '').trim().toLowerCase();
    // objectives:allow LOCALHOST Justification: localhost/loopback host detection is required to disable SSL for local Postgres DSNs.
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  } catch (_) {
    // Ignore URL parse errors and fall back to caller preference.
  }
  return fallback;
}

function resolveSslEnabledForCandidate(options = {}, env = process.env) {
  if (typeof options.sslEnabled === 'boolean') return options.sslEnabled;
  const modeFromEnv = sslEnabledFromMode(normalizeSslMode(env.PGSSLMODE));
  if (modeFromEnv != null) return modeFromEnv;
  return inferSslEnabledForDsn(options.dsn, true);
}

async function resolveDatabaseUrlWithFallback(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const candidatePolicy = options.candidatePolicy || env.DB_CONNECT_CANDIDATE_POLICY || '';
  const candidates = Array.isArray(options.candidates)
    ? filterCandidatesByPolicy(options.candidates, candidatePolicy)
    : await resolveDbCandidates(env, { candidatePolicy });
  if (!candidates.length) {
    throw new Error(
      candidatePolicy
        ? 'Missing DB connection candidates after applying candidate policy'
        : 'Missing DATABASE_URL/DATABASE_URL_DIRECT/DATABASE_URL_POOLER',
    );
  }

  const connectionTimeoutMs = parsePositiveInt(
    options.connectionTimeoutMs
      ?? resolveEnvOverride(env, options.connectionTimeoutEnvNames, options.connectionTimeoutEnv || 'DB_CONNECT_TIMEOUT_MS'),
    10000,
  );
  const maxWaitMs = parsePositiveInt(
    options.maxWaitMs
      ?? resolveEnvOverride(env, options.maxWaitEnvNames, options.maxWaitEnv || 'DB_CONNECT_MAX_WAIT_MS'),
    120000,
  );
  const retryDelayMs = parsePositiveInt(
    options.retryDelayMs
      ?? resolveEnvOverride(env, options.retryDelayEnvNames, options.retryDelayEnv || 'DB_CONNECT_RETRY_DELAY_MS'),
    2000,
  );
  const circuitBreakerRetryDelayMs = parsePositiveInt(
    options.circuitBreakerRetryDelayMs
      ?? resolveEnvOverride(
        env,
        options.circuitBreakerRetryDelayEnvNames,
        options.circuitBreakerRetryDelayEnv || 'DB_CONNECT_CIRCUIT_BREAKER_RETRY_DELAY_MS',
      ),
    Math.max(retryDelayMs, 15000),
  );
  const passwordSyncStabilizeMs = parsePositiveInt(
    options.passwordSyncStabilizeMs
      ?? resolveEnvOverride(
        env,
        options.passwordSyncStabilizeEnvNames,
        options.passwordSyncStabilizeEnv || 'DB_CONNECT_PASSWORD_SYNC_STABILIZE_MS',
      ),
    Math.max(retryDelayMs, 15000),
  );
  const queryText = String(options.queryText || 'SELECT 1');

  const probe =
    typeof options.probe === 'function'
      ? options.probe
      : async (candidate) => {
          const sslEnabled = resolveSslEnabledForCandidate(
            { dsn: candidate.dsn, sslEnabled: options.sslEnabled },
            env,
          );
          const Pool = getPgPoolCtor();
          const pool = new Pool({
            connectionString: candidate.dsn,
            connectionTimeoutMillis: connectionTimeoutMs,
            ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
          });
          try {
            const client = await pool.connect();
            try {
              await client.query(queryText);
            } finally {
              client.release();
              await pool.end();
            }
          } catch (error) {
            try {
              await pool.end();
            } catch {
              // ignore cleanup errors while probing candidates
            }
            throw error;
          }
        };

  const result = await runConnectivitySmoke({
    candidates,
    env,
    candidatePolicy,
    connectionTimeoutMs,
    maxWaitMs,
    retryDelayMs,
    circuitBreakerRetryDelayMs,
    passwordSyncStabilizeMs,
    logger,
    probe,
    now: options.now,
    sleepFn: options.sleepFn,
    syncProjectDbPassword: options.syncProjectDbPassword,
    buildPasswordSyncedCandidatesFn: options.buildPasswordSyncedCandidatesFn,
    ensureIpv4HostnameFn: options.ensureIpv4HostnameFn,
    ensureHostaddrFn: options.ensureHostaddrFn,
  });

  const selectedCandidate = result?.candidate || null;
  const selectedDsn = String(selectedCandidate?.dsn || result?.dsn || '').trim();
  const selectedName = String(selectedCandidate?.name || result?.candidateName || '').trim();
  return {
    dsn: selectedDsn,
    candidateName: selectedName,
    attempts: Number(result?.attempts || 0),
    durationMs: Number(result?.durationMs || 0),
  };
}

module.exports = {
  isRetryableDbConnectError,
  parsePositiveInt,
  resolveDbCandidates,
  resolveEnvOverride,
  resolveDatabaseUrlWithFallback,
  sanitizeErrorMessage,
};
