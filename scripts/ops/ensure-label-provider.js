#!/usr/bin/env node
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { upsertSettings } = require('../utils/settings-upsert');
const {
  parsePositiveInt,
  resolveDsnCandidates,
  runConnectivitySmoke,
  shouldSyncTenantNotFoundOnPreviewEnv,
} = require('./db-connect-smoke');

function resolveDbCandidatePolicy(env = process.env, explicitPolicy = '') {
  const requestedPolicy = String(explicitPolicy || '').trim();
  if (requestedPolicy) return requestedPolicy;
  const envPolicy = String(env.DB_CONNECT_CANDIDATE_POLICY || '').trim();
  if (envPolicy) return envPolicy;
  if (shouldSyncTenantNotFoundOnPreviewEnv(env)) {
    return 'shared-lane-safe';
  }
  return '';
}

async function resolveDbCandidate(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const resolveCandidates = options.resolveCandidates || resolveDsnCandidates;
  const runSmoke = options.runSmoke || runConnectivitySmoke;
  const parseIntFn = options.parseIntFn || parsePositiveInt;
  const candidatePolicy = resolveDbCandidatePolicy(env, options.candidatePolicy);

  const candidates = await resolveCandidates({ env, candidatePolicy });
  const connectionTimeoutMs = parseIntFn(env.DB_SMOKE_TIMEOUT_MS, 10000);
  const maxWaitMs = parseIntFn(env.DB_SMOKE_MAX_WAIT_MS, 120000);
  const retryDelayMs = parseIntFn(env.DB_SMOKE_RETRY_DELAY_MS, 2000);

  const result = await runSmoke({
    candidates,
    env,
    connectionTimeoutMs,
    maxWaitMs,
    retryDelayMs,
    logger,
    candidatePolicy,
  });

  return result.candidate;
}

function resolveLabelProviderInvokeUrl(env = process.env) {
  const key = [
    'LABEL_PROVIDER_INVOKE_URL',
    'LABEL_RENDERER_INVOKE_URL',
    'EDGE_SUPABASE_URL',
    'SUPABASE_URL',
  ].find((name) => String(env[name] || '').trim());
  if (!key) return '';

  const value = String(env[key]).trim().replace(/\/+$/, '');
  const url = URL.parse(value);
  if (!url || !/^https?:\/\//i.test(value) || !url.hostname
    || url.username || url.password || /[\s\\?#]/.test(value)) {
    throw new Error(`${key} must be an absolute HTTP(S) URL without credentials, query, or fragment`);
  }
  return key.startsWith('LABEL_') ? value : `${value}/functions/v1/label-renderer`;
}

async function main() {
  loadEnv();
  const { DATABASE_URL } = process.env;
  const SECRET =
    process.env.LABEL_PROVIDER_INVOKE_SECRET ||
    process.env.LABEL_RENDERER_BENCHMARK_AUTH_JWT ||
    process.env.LABEL_RENDERER_DB_JWT ||
    process.env.LABEL_RENDERER_TOKEN ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY;

  if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
  const invokeUrl = resolveLabelProviderInvokeUrl(process.env);
  if (!invokeUrl || !SECRET) {
    throw new Error(
      'LABEL_PROVIDER_INVOKE_URL/LABEL_RENDERER_INVOKE_URL/EDGE_SUPABASE_URL/SUPABASE_URL and LABEL_RENDERER_TOKEN/SERVICE_ROLE required',
    );
  }

  const provider = {
    version: 2,
    providers: [
      {
        name: 'internal_renderer',
        mode: 'internal',
        invoke_url: invokeUrl,
        invoke_secret: SECRET,
        timeout_ms: 20000,
      },
    ],
  };

  const candidate = await resolveDbCandidate();
  const pool = new Pool({ connectionString: candidate.dsn });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The service writer seals invoke_secret in Vault before any settings persistence.
    await upsertSettings({
      db: client,
      category: 'label_provider',
      scopeType: 'global',
      scopeId: null,
      value: provider,
      changeReason:
        '[ensure-label-provider] Ensure global label_provider settings',
    });

    await client.query('COMMIT');
    console.log('[ensure-label-provider] Upserted global label_provider settings');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ensure-label-provider] Failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  resolveDbCandidate,
  resolveDbCandidatePolicy,
  resolveLabelProviderInvokeUrl,
};
