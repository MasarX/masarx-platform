#!/usr/bin/env node
const { loadEnv } = require('../utils/load-env');
const {
  parsePositiveInt,
  resolveDsnCandidates,
  runConnectivitySmoke,
  shouldSyncTenantNotFoundOnPreviewEnv,
} = require('./db-connect-smoke');

const INVOKE_URL_KEYS = [
  'LABEL_PROVIDER_INVOKE_URL',
  'LABEL_RENDERER_INVOKE_URL',
  'LABEL_PROVIDER_INVOKE_BASE_URL',
  'LABEL_RENDERER_INVOKE_BASE_URL',
  'LABEL_PROVIDER_INVOKE_URL_BASE',
  'EDGE_SUPABASE_URL',
  'SUPABASE_URL',
];
const INVOKE_SECRET_KEYS = [
  'LABEL_PROVIDER_INVOKE_SECRET',
  'LABEL_RENDERER_BENCHMARK_AUTH_JWT',
  'LABEL_RENDERER_DB_JWT',
  'LABEL_RENDERER_TOKEN',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SERVICE_ROLE_KEY',
];

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
  const key = INVOKE_URL_KEYS.find((name) => String(env[name] || '').trim());
  if (!key) return '';

  const value = String(env[key]).trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (!url || !/^https?:\/\//i.test(value) || !url.hostname
    || url.username || url.password || /[\s\\?#]/.test(value)) {
    throw new Error(`${key} must be an absolute HTTP(S) URL without credentials, query, or fragment`);
  }
  return key === 'LABEL_PROVIDER_INVOKE_URL' || key === 'LABEL_RENDERER_INVOKE_URL'
    ? value
    : `${value}/functions/v1/label-renderer`;
}

async function main() {
  const { Pool } = require('pg');
  const { upsertSettings } = require('../utils/settings-upsert');
  loadEnv();
  const { DATABASE_URL } = process.env;
  const secretKey = INVOKE_SECRET_KEYS.find((name) => process.env[name]);
  const SECRET = secretKey ? process.env[secretKey] : undefined;

  if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
  const invokeUrl = resolveLabelProviderInvokeUrl(process.env);
  if (!invokeUrl || !SECRET) {
    throw new Error(
      'A label renderer invoke URL or base URL and a renderer credential are required. '
      + 'URL variables: ' + INVOKE_URL_KEYS.join(', ') + '. '
      + 'Credential variables: ' + INVOKE_SECRET_KEYS.join(', ') + '.',
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
