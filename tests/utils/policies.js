const { Pool } = require('pg');
const {
  normalizeWebhookIngestPolicy,
} = require('../../scripts/utils/webhook-ingest-policy');
const { normalizeGeocodingPolicy } = require('../../scripts/utils/geocoding-policy');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.DATABASE_URL_DIRECT ||
  process.env.DATABASE_URL_POOLER;
if (!DATABASE_URL) {
  // Allow importing without immediate failure; callers will fail at runtime if
  // a DB connection is actually needed.
  // eslint-disable-next-line no-console
  console.warn('[tests/utils/policies] DATABASE_URL/DATABASE_URL_DIRECT/DATABASE_URL_POOLER not set at import time');
}

const pool = new Pool({ connectionString: DATABASE_URL });
const POLICY_UPSERT_RETRYABLE_SQLSTATES = new Set(['57014', '40001', '40P01']);

function isRetryablePolicyError(err) {
  if (!err) return false;
  const code = String(err.code || '').trim();
  if (POLICY_UPSERT_RETRYABLE_SQLSTATES.has(code)) return true;
  const message = String(err.message || '').toLowerCase();
  return (
    message.includes('statement timeout') ||
    message.includes('deadlock detected') ||
    message.includes('serialization')
  );
}

async function queryWithRetry(runner, text, values, options = {}) {
  const maxAttempts = Number(options.maxAttempts || process.env.POLICY_UPSERT_MAX_ATTEMPTS || 3);
  const baseDelayMs = Number(options.baseDelayMs || process.env.POLICY_UPSERT_RETRY_DELAY_MS || 150);
  const queryTimeoutMs = Number(options.queryTimeoutMs || process.env.POLICY_UPSERT_QUERY_TIMEOUT_MS || 45000);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runner.query({ text, values, query_timeout: queryTimeoutMs });
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryablePolicyError(err)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }

  throw new Error('queryWithRetry exhausted attempts unexpectedly');
}

async function fetchActiveSchemaVersion(category, runner) {
  const { rows } = await runner.query(
    `SELECT version
       FROM public.schema_registry
      WHERE category = $1
        AND is_active = TRUE
      ORDER BY version DESC
      LIMIT 1`,
    [category],
  );
  const v = rows[0]?.version;
  return typeof v === 'number' ? v : 1;
}

async function upsertSettings(
  category,
  scopeType,
  scopeId,
  value,
  changeReason = 'test helper upsert',
  client = null,
) {
  const normalizedScopeType = (scopeType || '').toLowerCase().trim();
  if (!normalizedScopeType) {
    throw new Error('scopeType is required for upsertSettings');
  }
  if (normalizedScopeType !== 'global' && !scopeId) {
    throw new Error(`scopeId required for scopeType "${normalizedScopeType}"`);
  }

  const normalizedValue =
    category === 'webhook_ingest_policy'
      ? normalizeWebhookIngestPolicy(value)
      : category === 'geocoding_policy'
        ? normalizeGeocodingPolicy(value)
      : value;

  const SCOPE_HASH_SENTRY = '00000000-0000-0000-0000-000000000000';
  const scopeHash = normalizedScopeType === 'global' ? SCOPE_HASH_SENTRY : scopeId;
  const runner = client || pool;

  let schemaVersion = 1;
  try {
    schemaVersion = await fetchActiveSchemaVersion(category, runner);
  } catch {
    schemaVersion = 1;
  }

  const versionUpdate = await queryWithRetry(
    runner,
    `WITH target AS (
       SELECT id
         FROM public.settings_versions
        WHERE category = $1
          AND scope_type = $2
          AND scope_hash = $3::uuid
          AND effective_until IS NULL
        ORDER BY effective_from DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT 1
     )
     UPDATE public.settings_versions sv
        SET value = jsonb_strip_nulls(COALESCE(sv.value, '{}'::jsonb) || $4::jsonb),
            schema_version = $5,
            change_reason = COALESCE(NULLIF($6::text, ''), sv.change_reason),
            approved_at = COALESCE(sv.approved_at, clock_timestamp()),
            effective_from = COALESCE(sv.effective_from, sv.approved_at, clock_timestamp())
       FROM target
      WHERE sv.id = target.id
      RETURNING sv.id`,
    [
      category,
      normalizedScopeType,
      scopeHash,
      normalizedValue,
      schemaVersion,
      changeReason,
    ],
  );
  let settingsVersionId = versionUpdate.rows[0]?.id || null;

  if (!settingsVersionId) {
    const insertVersion = await queryWithRetry(
      runner,
      `INSERT INTO public.settings_versions (
         id,
         category,
         scope_type,
         scope_id,
         scope_hash,
         version,
         value,
         schema_version,
         change_reason,
         approved_at,
         effective_from
       ) VALUES (
         gen_random_uuid(),
         $1::text,
         $2::text,
         ($3)::uuid,
         $6::uuid,
         1,
         $4::jsonb,
         $7::int,
         COALESCE(NULLIF($5::text, ''), format('seed %s settings via tests', $1::text)),
         clock_timestamp(),
         clock_timestamp()
       )
       RETURNING id`,
      [
        category,
        normalizedScopeType,
        scopeId,
        normalizedValue,
        changeReason,
        scopeHash,
        schemaVersion,
      ],
    );
    settingsVersionId = insertVersion.rows[0].id;
  }

  const versionValueRes = await queryWithRetry(
    runner,
    `SELECT value
       FROM public.settings_versions
      WHERE id = $1::uuid
      LIMIT 1`,
    [settingsVersionId],
  );
  const syncedValue = versionValueRes.rows[0]?.value || normalizedValue;

  const settingsUpdate = await queryWithRetry(
    runner,
    `UPDATE public.settings
        SET settings_version_id = $4::uuid,
            cached_value = $3::jsonb,
            last_updated = clock_timestamp()
      WHERE category = $1
        AND scope_type = $2
        AND scope_hash = $5::uuid`,
    [
      category,
      normalizedScopeType,
      syncedValue,
      settingsVersionId,
      scopeHash,
    ],
  );

  if (settingsUpdate.rowCount === 0) {
    await queryWithRetry(
      runner,
      `INSERT INTO public.settings (
         id,
         category,
         scope_type,
         scope_id,
         scope_hash,
         settings_version_id,
         cached_value,
         last_updated
       ) VALUES (
         gen_random_uuid(),
         $1::text,
         $2::text,
         ($3)::uuid,
         $4::uuid,
         $5::uuid,
         $6::jsonb,
         clock_timestamp()
       )`,
      [
        category,
        normalizedScopeType,
        scopeId,
        scopeHash,
        settingsVersionId,
        syncedValue,
      ],
    );
  }
}

async function upsertWebhookPolicy(
  scopeType,
  scopeId,
  policy,
  reason = 'test helper webhook policy upsert',
  client = null,
) {
  return upsertSettings('webhook_ingest_policy', scopeType, scopeId, policy, reason, client);
}

module.exports = {
  upsertSettings,
  upsertWebhookPolicy,
  pool,
};
