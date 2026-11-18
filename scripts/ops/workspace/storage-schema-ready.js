const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5000;

function isExplicitFalse(value) {
  const s = String(value || '').trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'no';
}

function isExplicitTrue(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return false;
  return !isExplicitFalse(s);
}

function resolveEnvNumber(env, keys, fallback) {
  const list = Array.isArray(keys) ? keys : [];
  for (const key of list) {
    const raw = String(env?.[key] || '').trim();
    if (!raw) continue;
    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) return Math.floor(num);
  }
  return fallback;
}

function shouldWaitForStorageSchema({ env = process.env, projectWasCreated = false } = {}) {
  const explicit = String(env.PREVIEW_WAIT_FOR_STORAGE_SCHEMA || env.SUPABASE_WAIT_FOR_STORAGE_SCHEMA || '').trim();
  if (explicit) return isExplicitTrue(explicit);
  return Boolean(projectWasCreated);
}

function resolveStorageSchemaReadyOptions(env = process.env, opts = {}) {
  const timeoutKeys = opts.timeoutKeys || [
    'PREVIEW_SUPABASE_STORAGE_SCHEMA_READY_TIMEOUT_MS',
    'SUPABASE_STORAGE_SCHEMA_READY_TIMEOUT_MS',
  ];
  const intervalKeys = opts.intervalKeys || [
    'PREVIEW_SUPABASE_STORAGE_SCHEMA_READY_INTERVAL_MS',
    'SUPABASE_STORAGE_SCHEMA_READY_INTERVAL_MS',
  ];

  return {
    timeoutMs: resolveEnvNumber(env, timeoutKeys, DEFAULT_TIMEOUT_MS),
    intervalMs: resolveEnvNumber(env, intervalKeys, DEFAULT_INTERVAL_MS),
  };
}

async function queryStorageSchemaStatus(client, queryTimeoutMs) {
  const res = await client.query({
    text: `
    SELECT
      to_regnamespace('storage') IS NOT NULL AS has_storage_schema,
      to_regclass('storage.objects') IS NOT NULL AS has_storage_objects,
      to_regclass('storage.buckets') IS NOT NULL AS has_storage_buckets
  `,
    query_timeout: queryTimeoutMs,
  });
  const row = res?.rows?.[0] || {};
  return {
    hasStorageSchema: row.has_storage_schema === true,
    hasStorageObjects: row.has_storage_objects === true,
    hasStorageBuckets: row.has_storage_buckets === true,
  };
}

async function waitForStorageSchema({
  connectionString,
  timeoutMs,
  intervalMs,
  deadlineMs,
  authErrorExtraMs = 0,
  connectionTimeoutMillis = 15000,
  createClient,
  nowFn = Date.now,
  sleep,
  logger = console,
  isAuthError,
} = {}) {
  const cs = String(connectionString || '').trim();
  if (!cs) throw new Error('Missing connectionString');
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const interval = Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : DEFAULT_INTERVAL_MS;
  const authExtra = Number.isFinite(authErrorExtraMs) && authErrorExtraMs > 0 ? authErrorExtraMs : 0;
  const mkClient =
    typeof createClient === 'function'
      ? createClient
      : ({ connectionTimeoutMillis: boundedConnectionTimeoutMillis }) => {
          const { Client } = require('pg');
          return new Client({ connectionString: cs, connectionTimeoutMillis: boundedConnectionTimeoutMillis });
        };
  const snooze = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));

  const authClassifier =
    typeof isAuthError === 'function'
      ? isAuthError
      : (err) => {
          const msg = String(err?.message || err || '').toLowerCase();
          return (
            msg.includes('tenant or user not found') ||
            msg.includes('password authentication failed') ||
            msg.includes('too many authentication errors')
          );
        };

  const clock = typeof nowFn === 'function' ? nowFn : Date.now;
  const start = clock();
  const configuredDeadlineMs = Number(deadlineMs);
  const timeoutDeadlineMs = start + timeout + authExtra;
  const absoluteDeadlineMs = Math.min(
    timeoutDeadlineMs,
    Number.isFinite(configuredDeadlineMs) && configuredDeadlineMs > 0
      ? configuredDeadlineMs
      : Number.POSITIVE_INFINITY,
  );
  let attempt = 0;
  let lastStatus = null;

  while (clock() < absoluteDeadlineMs) {
    attempt += 1;
    const remainingMs = absoluteDeadlineMs - clock();
    const client = mkClient({
      connectionTimeoutMillis: Math.max(1, Math.min(connectionTimeoutMillis, remainingMs)),
    });
    try {
      await client.connect();
      const queryRemainingMs = absoluteDeadlineMs - clock();
      if (queryRemainingMs <= 0) break;
      const status = await queryStorageSchemaStatus(client, queryRemainingMs);
      lastStatus = status;

      if (clock() >= absoluteDeadlineMs) break;
      if (status.hasStorageSchema && status.hasStorageObjects && status.hasStorageBuckets) {
        return { ok: true, attempts: attempt, status };
      }

      if (clock() >= absoluteDeadlineMs) break;

      if (attempt === 1 || attempt % 5 === 0) {
        logger.log('[storage-schema-ready] Waiting for storage schema/tables...');
      }
      await snooze(Math.min(interval, Math.max(0, absoluteDeadlineMs - clock())));
    } catch (err) {
      if (authClassifier(err)) {
        if (authExtra <= 0 || clock() >= absoluteDeadlineMs) throw err;
        if (attempt === 1 || attempt % 5 === 0) {
          logger.log('[storage-schema-ready] Waiting for DB auth propagation for storage schema check...');
        }
        await snooze(Math.min(interval, Math.max(0, absoluteDeadlineMs - clock())));
        continue;
      }

      if (clock() >= absoluteDeadlineMs) break;

      if (attempt === 1 || attempt % 5 === 0) {
        logger.log('[storage-schema-ready] Waiting for DB readiness for storage schema check...');
      }
      await snooze(Math.min(interval, Math.max(0, absoluteDeadlineMs - clock())));
    } finally {
      try { await client.end(); } catch { /* ignore cleanup errors */ }
    }
  }

  const statusMsg = lastStatus
    ? ` (schema=${lastStatus.hasStorageSchema}, buckets=${lastStatus.hasStorageBuckets}, objects=${lastStatus.hasStorageObjects})`
    : '';
  throw new Error(`Timeout waiting for storage schema/tables after ${attempt} attempts${statusMsg}`);
}

module.exports = {
  shouldWaitForStorageSchema,
  resolveStorageSchemaReadyOptions,
  waitForStorageSchema,
};
