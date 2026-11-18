/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  parsePositiveInt,
  resolveDsnCandidates,
  runConnectivitySmoke,
  shouldUseSsl,
} = require('./db-connect-smoke');
const {
  loadDeploySurfaceRegistry,
  compileRegistry,
  findDeployTargetByEnvironmentName,
} = require('./ci/deploy-surface-registry');

let compiledDeploySurfaceRegistry = null;

async function hasTable({ connectionString, qualifiedName, env = process.env }) {
  const name = String(qualifiedName || '').trim();
  if (!name) return false;

  const { Client } = require('pg');
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: parsePositiveInt(env.DB_SMOKE_TIMEOUT_MS, 10000),
    ssl: shouldUseSsl() ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await client.connect();
    const res = await client.query('select to_regclass($1) as reg', [name]);
    const value = res?.rows?.[0]?.reg;
    return Boolean(value);
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

function getLatestRepoMigrationVersion(repoRoot = process.cwd()) {
  const dir = path.join(repoRoot, 'supabase', 'migrations');
  if (!fs.existsSync(dir)) return '';
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^\d{12,}_.*\.sql$/i.test(String(name || '').trim()));
  if (!files.length) return '';
  files.sort();
  const latest = String(files[files.length - 1] || '');
  const match = latest.match(/^(\d{12,})_/);
  return match && match[1] ? String(match[1]) : '';
}

async function hasSchemaMigrationVersion({ connectionString, version, env = process.env }) {
  const normalizedVersion = String(version || '').trim();
  if (!normalizedVersion) return true;

  const hasMigrationsTable = await hasTable({
    connectionString,
    qualifiedName: 'supabase_migrations.schema_migrations',
    env,
  });
  if (!hasMigrationsTable) return false;

  const { Client } = require('pg');
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: parsePositiveInt(env.DB_SMOKE_TIMEOUT_MS, 10000),
    ssl: shouldUseSsl() ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await client.connect();
    const res = await client.query(
      `select exists (
         select 1
           from supabase_migrations.schema_migrations
          where version = $1
       ) as present`,
      [normalizedVersion],
    );
    return Boolean(res?.rows?.[0]?.present);
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

function getCompiledDeploySurfaceRegistry() {
  if (compiledDeploySurfaceRegistry) return compiledDeploySurfaceRegistry;
  const { registry } = loadDeploySurfaceRegistry({});
  compiledDeploySurfaceRegistry = compileRegistry(registry);
  return compiledDeploySurfaceRegistry;
}

function resolveBootstrapMode(env = process.env) {
  const explicit = String(env.CLOUD_DB_BOOTSTRAP_MODE || '').trim().toLowerCase();
  if (explicit) return explicit;

  const targetEnvironment = String(
    env.TARGET_DEPLOY_ENV || env.DEPLOY_ENV || env.DEPLOY_ENVIRONMENT || '',
  ).trim();
  if (!targetEnvironment) return 'ephemeral';

  const registry = getCompiledDeploySurfaceRegistry();
  const deployTarget = findDeployTargetByEnvironmentName(registry, targetEnvironment);
  if (!deployTarget) return 'ephemeral';

  return 'shared-strict';
}

function resolveSharedBootstrapError({
  targetEnvironment,
  bootstrapReason,
  latestRepoMigrationVersion,
}) {
  const envName = String(targetEnvironment || '').trim() || '<unknown>';
  const reason = String(bootstrapReason || '').trim();
  if (reason === 'baseline_missing') {
    return (
      `[cloud-db-bootstrap] Shared deploy environment "${envName}" is missing the baseline schema. ` +
      'Shared environments must be reconciled through the DB deploy pipeline; auto-bootstrap push is disabled.'
    );
  }

  const version = String(latestRepoMigrationVersion || '').trim();
  return (
    `[cloud-db-bootstrap] Shared deploy environment "${envName}" is behind repo migrations` +
    `${version ? ` (missing version ${version})` : ''}. ` +
    'Shared environments must be updated through the DB deploy pipeline; auto-bootstrap push is disabled.'
  );
}

async function ensureCloudDbBootstrap({
  env = process.env,
  logger = console,
  qaRunId = '',
  repoRoot = process.cwd(),
} = {}) {
  const candidates = await resolveDsnCandidates({ env });
  const result = await runConnectivitySmoke({
    candidates,
    connectionTimeoutMs: parsePositiveInt(env.DB_SMOKE_TIMEOUT_MS, 10000),
    maxWaitMs: parsePositiveInt(env.DB_SMOKE_MAX_WAIT_MS, 120000),
    retryDelayMs: parsePositiveInt(env.DB_SMOKE_RETRY_DELAY_MS, 2000),
    logger,
  });
  const selectedDsn = String(result?.candidate?.dsn || '').trim();
  const selectedCandidateName = String(result?.candidate?.name || '').trim();
  if (selectedDsn) {
    env.DATABASE_URL = selectedDsn;
    env.PG_CONN_STRING = selectedDsn;
    if (selectedCandidateName) {
      env.DB_SMOKE_SELECTED_DSN_NAME = selectedCandidateName;
    }
    process.env.DATABASE_URL = selectedDsn;
    process.env.PG_CONN_STRING = selectedDsn;
    if (selectedCandidateName) {
      process.env.DB_SMOKE_SELECTED_DSN_NAME = selectedCandidateName;
    }
  }

  const connectionString = selectedDsn || env.DATABASE_URL;
  const baselineOk = await hasTable({
    connectionString,
    qualifiedName: 'public.scope_type_registry',
    env,
  });
  const latestRepoMigrationVersion = getLatestRepoMigrationVersion(repoRoot);
  const latestRepoMigrationApplied = latestRepoMigrationVersion
    ? await hasSchemaMigrationVersion({
        connectionString,
        version: latestRepoMigrationVersion,
        env,
      })
    : true;

  let bootstrapped = false;
  let bootstrapReason = '';
  const bootstrapMode = resolveBootstrapMode(env);
  const targetEnvironment = String(
    env.TARGET_DEPLOY_ENV || env.DEPLOY_ENV || env.DEPLOY_ENVIRONMENT || '',
  ).trim();

  if (!baselineOk) {
    bootstrapReason = 'baseline_missing';
    logger.warn(
      '[cloud-db-bootstrap] DB baseline schema missing (scope_type_registry). Running migrations via supabase-cli push.',
    );
  } else if (!latestRepoMigrationApplied) {
    bootstrapReason = `missing_migration_${latestRepoMigrationVersion}`;
    logger.warn(
      `[cloud-db-bootstrap] DB is behind repo migrations (missing version ${latestRepoMigrationVersion}). Running migrations via supabase-cli push.`,
    );
  }

  if (bootstrapReason) {
    const allowSharedPush = String(env.CLOUD_DB_BOOTSTRAP_ALLOW_SHARED_PUSH || '').trim() === '1';
    if (bootstrapMode === 'shared-strict' && !allowSharedPush) {
      throw new Error(
        resolveSharedBootstrapError({
          targetEnvironment,
          bootstrapReason,
          latestRepoMigrationVersion,
        }),
      );
    }
    const mergedEnv = {
      ...env,
      SUPABASE_DB_PUSH_INCLUDE_ALL: '0',
    };
    if (qaRunId) mergedEnv.QA_RUN_ID = qaRunId;
    const res = spawnSync(process.execPath, [path.join('scripts', 'ops', 'supabase-cli.js'), 'push'], {
      stdio: 'inherit',
      env: mergedEnv,
      shell: false,
      cwd: repoRoot,
    });
    if (res.error) {
      throw new Error(`db:bootstrap supabase-cli push failed: ${res.error.message}`);
    }
    if (res.status !== 0) {
      throw new Error(`db:bootstrap supabase-cli push failed with exit code ${res.status || 1}`);
    }
    bootstrapped = true;
  }

  return {
    selectedDsn,
    selectedCandidateName,
    bootstrapped,
    bootstrapReason,
    latestRepoMigrationVersion,
    bootstrapMode,
    targetEnvironment,
  };
}

module.exports = {
  ensureCloudDbBootstrap,
  getLatestRepoMigrationVersion,
  hasSchemaMigrationVersion,
  hasTable,
  resolveBootstrapMode,
  resolveSharedBootstrapError,
};
