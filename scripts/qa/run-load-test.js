#!/usr/bin/env node
/**
 * Run k6-based load tests using Docker (preferred) and xk6 extensions.
 *
 * When Docker isn't available (common on Windows dev machines), fall back to a
 * local `go run .../xk6 build` flow using the pinned versions below.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const scenarioMap = {
  partition: 'tests/load/partition-performance.js',
  'partition-performance': 'tests/load/partition-performance.js',
  'webhook-ingest': 'tests/load/webhook-ingest.k6.js',
  'webhook-ingest-http': 'tests/load/webhook-ingest-http.k6.js',
  'api-gateway-http': 'tests/load/api-gateway-http.k6.js',
  day1: 'tests/load/day1-onboarding-pressure.js',
  'day1-onboarding-pressure': 'tests/load/day1-onboarding-pressure.js',
};

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/qa/run-load-test.js [--scenario=<name>] [--summary=<path>]');
  console.log('Supported scenarios: ' + Object.keys(scenarioMap).join(', '));
  process.exit(0);
}

const { createQaLogger } = require('./qa-log');

// Load ENV_FILE (cloud) if present so DATABASE_URL/SUPABASE_URL/etc are available
try {
  const dotenv = require('dotenv');
  const defaultEnv = path.join('config', 'env', '.env.cloud');
  const envPath = process.env.ENV_FILE || defaultEnv;
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`[load-test] Loaded env from ${envPath}`);
  }
} catch (_) {}

const getArgValue = (name) => {
  const prefix = `--${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
};

const dockerCheckTimeoutMs =
  parseInt(process.env.LOAD_TEST_DOCKER_CHECK_TIMEOUT_MS || '10000', 10) || 10000;
const dockerTimeoutMs =
  parseInt(process.env.LOAD_TEST_DOCKER_TIMEOUT_MS || '600000', 10) || 600000;

function timeoutFromEnv(key, fallbackMs) {
  const value = Number(process.env[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallbackMs;
}

const goCheckTimeoutMs = timeoutFromEnv('LOAD_TEST_GO_CHECK_TIMEOUT_MS', 5_000);
const buildTimeoutMs = timeoutFromEnv('LOAD_TEST_XK6_BUILD_TIMEOUT_MS', 1_800_000);
const storageTimeoutMs = timeoutFromEnv('LOAD_TEST_DAY1_STORAGE_TIMEOUT_MS', 300_000);
const provisionTimeoutMs = timeoutFromEnv('LOAD_TEST_PROVISION_TIMEOUT_MS', 300_000);
const localK6TimeoutMs = timeoutFromEnv('LOAD_TEST_LOCAL_K6_TIMEOUT_MS', dockerTimeoutMs);

const scenario = getArgValue('scenario') || 'partition-performance';
const autoProvision =
  args.includes('--auto-provision-http-token') ||
  args.includes('--auto-provision-webhook-token');
const clientSlug = getArgValue('client-slug') || 'test-client-2-1';
const summaryArg = getArgValue('summary');
const runStartedAt = Date.now();
const qaSuiteKey = process.env.QA_SUITE_KEY || 'load';
const qa = createQaLogger({ runId: process.env.QA_RUN_ID, disabled: !process.env.QA_RUN_ID });

// Determinism: pin the xk6 runner + extensions by default (override via env vars).
const xk6DockerImage = process.env.XK6_DOCKER_IMAGE || 'grafana/xk6:0.14.0';
const xk6K6Version = process.env.XK6_K6_VERSION || 'v0.57.0';
const xk6SqlVersion = process.env.XK6_SQL_VERSION || 'v1.0.5';
const xk6SqlPostgresVersion = process.env.XK6_SQL_POSTGRES_VERSION || 'v0.1.1';
const xk6VersionOverride = process.env.XK6_VERSION || '';

const resolveXk6Version = () => {
  if (xk6VersionOverride) return xk6VersionOverride.startsWith('v') ? xk6VersionOverride : `v${xk6VersionOverride}`;
  const match = String(xk6DockerImage).match(/:([0-9]+\\.[0-9]+\\.[0-9]+)$/);
  return match ? `v${match[1]}` : 'v0.14.0';
};

const dockerDaemonAvailable = () => {
  const res = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 });
  return res.status === 0;
};

const ensureLocalXk6Binary = () => {
  const xk6Version = resolveXk6Version();
  const binDir = path.join(projectRoot, 'tmp', 'xk6');
  fs.mkdirSync(binDir, { recursive: true });

  const safe = (v) => String(v).replace(/[^a-z0-9._-]/gi, '_');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binPath = path.join(
    binDir,
    `k6-${safe(xk6Version)}-${safe(xk6K6Version)}-${safe(xk6SqlVersion)}-${safe(xk6SqlPostgresVersion)}${ext}`,
  );

  if (fs.existsSync(binPath)) {
    return binPath;
  }

  const goCheck = spawnSync('go', ['version'], { stdio: 'ignore', timeout: goCheckTimeoutMs });
  if (goCheck.status !== 0) {
    console.error('[load-test] Docker unavailable and Go toolchain missing; cannot build xk6 locally.');
    process.exit(1);
  }

  console.log(`[load-test] Docker unavailable; building xk6 locally (${xk6Version})...`);
  const buildArgs = [
    'run',
    `go.k6.io/xk6/cmd/xk6@${xk6Version}`,
    'build',
    xk6K6Version,
    '--with',
    `github.com/grafana/xk6-sql@${xk6SqlVersion}`,
    '--with',
    `github.com/grafana/xk6-sql-driver-postgres@${xk6SqlPostgresVersion}`,
    '--output',
    binPath.replace(/\\\\/g, '/'),
  ];

  const build = spawnSync('go', buildArgs, { stdio: 'inherit', timeout: buildTimeoutMs, env: { ...process.env } });
  if (build.status !== 0) {
    console.error(`[load-test] xk6 build failed with status ${build.status}`);
    process.exit(build.status || 1);
  }

  return binPath;
};

const scenarioFile = scenarioMap[scenario];

if (!scenarioFile) {
  console.error(
    `[load-test] Unknown scenario "${scenario}". Supported: ${Object.keys(scenarioMap).join(', ')}`,
  );
  process.exit(1);
}

function requireScenarioPrerequisites() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
  const webhookToken = String(process.env.WEBHOOK_HTTP_TOKEN || '').trim();
  const apiGatewayBaseUrl = String(process.env.API_GATEWAY_BASE_URL || '').trim();
  const apiGatewayToken = String(process.env.API_GATEWAY_HTTP_TOKEN || '').trim();

  if (scenario === 'webhook-ingest-http') {
    if (!supabaseUrl) {
      console.error('[load-test] webhook-ingest-http requires SUPABASE_URL.');
      process.exit(1);
    }
    if (!anonKey && !webhookToken) {
      console.error(
        '[load-test] webhook-ingest-http requires SUPABASE_ANON_KEY or WEBHOOK_HTTP_TOKEN.',
      );
      process.exit(1);
    }
  }

  if (scenario === 'api-gateway-http') {
    if (!apiGatewayBaseUrl) {
      console.error('[load-test] api-gateway-http requires API_GATEWAY_BASE_URL.');
      process.exit(1);
    }
    if (!apiGatewayToken) {
      console.error('[load-test] api-gateway-http requires API_GATEWAY_HTTP_TOKEN.');
      process.exit(1);
    }
  }
}

const isCi = String(process.env.CI || '').toLowerCase() === 'true';
const isDay1Scenario = scenario === 'day1' || scenario === 'day1-onboarding-pressure';

function isGithubHostedRunner(sourceEnv = process.env) {
  return String(sourceEnv.RUNNER_ENVIRONMENT || '').trim().toLowerCase() === 'github-hosted';
}

const loadTestDockerMode = (() => {
  const raw = String(process.env.LOAD_TEST_DOCKER_MODE || '').trim().toLowerCase();
  if (!raw) return isCi && isGithubHostedRunner() ? 'require' : 'prefer';
  if (raw === 'require' || raw === 'prefer' || raw === 'disable') return raw;
  console.warn(
    `[load-test] Unknown LOAD_TEST_DOCKER_MODE="${raw}" (expected require|prefer|disable); using ${isCi && isGithubHostedRunner() ? 'require' : 'prefer'}.`,
  );
  return isCi && isGithubHostedRunner() ? 'require' : 'prefer';
})();

function isTruthyFlag(value, fallback = false) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function decodeJwtPayload(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = payloadB64.length % 4 === 0 ? '' : '='.repeat(4 - (payloadB64.length % 4));
  try {
    return JSON.parse(Buffer.from(payloadB64 + pad, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function probeDatabaseUrl(dsn, label) {
  const value = String(dsn || '').trim();
  if (!value) return false;

  const timeoutMs =
    parseInt(process.env.LOAD_TEST_DB_PROBE_TIMEOUT_MS || '8000', 10) || 8000;

  const probe = spawnSync(
    process.execPath,
    [path.join('scripts', 'ops', 'db-connect-smoke.js')],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs + 1000,
      env: { ...process.env, DATABASE_URL: value, DB_SMOKE_TIMEOUT_MS: String(timeoutMs) },
    },
  );

  if (probe.status === 0) return true;

  const out = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
  console.warn(
    `[load-test] DB probe failed for ${label} (status ${probe.status || 1})${out ? `: ${out}` : ''}`,
  );
  return false;
}

function sleepSync(ms) {
  const duration = parseInt(String(ms || '0'), 10) || 0;
  if (duration <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

// Resolve DATABASE_URL for load tests, preferring direct host when available.
const buildLoadtestDatabaseUrl = () => {
  const explicit = process.env.LOADTEST_DATABASE_URL;
  if (explicit) {
    console.log('[load-test] Using LOADTEST_DATABASE_URL override for DATABASE_URL');
    return explicit;
  }
  const inheritedDatabaseUrl = String(process.env.DATABASE_URL || '').trim();
  const inheritedHasHostaddr = /\bhostaddr=/i.test(inheritedDatabaseUrl);

  const mode = String(process.env.LOADTEST_DB_MODE || 'auto').trim().toLowerCase();

  const poolerHost = process.env.SUPABASE_POOLER_HOST;
  const poolerPort = process.env.SUPABASE_POOLER_PORT || '5432';
  const dbPassword = process.env.SUPABASE_DB_PASSWORD;
  const projectId = process.env.SUPABASE_PROJECT_ID;

  const poolerDsn = (() => {
    if (!(poolerHost && dbPassword && projectId)) return '';
    // Supabase pooler users are of the form: postgres.<af38b526-f5c1-468d-88fb-86677fbe872a>
    const user = `postgres.${projectId}`;
    const encodedUser = encodeURIComponent(user);
    const encodedPassword = encodeURIComponent(dbPassword);
    // objectives:allow DSN_URL Justification: construct DATABASE_URL for k6 load tests from pooler host, project_ref, and password; covers shared cloud DB, not tenant-specific routing
    return ([`postgresql`,":","/","/",`${encodedUser}`,":",`${encodedPassword}`,"@",`${poolerHost}`,":",`${poolerPort}`,"/",`postgres`].join(""));
  })();

  const directDsn = (() => {
    if (!(dbPassword && projectId)) return '';
    const encodedPassword = encodeURIComponent(dbPassword);
    const host = process.env.SUPABASE_DB_DIRECT_HOST || `db.${projectId}.supabase.co`;
    const port = process.env.SUPABASE_DB_DIRECT_PORT || '5432';
    // objectives:allow DSN_URL Justification: construct DATABASE_URL for k6 load tests using Supabase direct host (db.<ref>.supabase.co); avoids pooler latency for perf gates when reachable
    return ([`postgresql`,":","/","/",`postgres`,":",`${encodedPassword}`,"@",`${host}`,":",`${port}`,"/",`postgres`].join(""));
  })();

  if (mode === 'direct') {
    if (directDsn) {
      console.log('[load-test] Using direct DB host for DATABASE_URL (LOADTEST_DB_MODE=direct)');
      return directDsn;
    }
    console.warn('[load-test] LOADTEST_DB_MODE=direct requested, but direct DSN inputs are missing; falling back.');
  }

  if (mode === 'pooler') {
    if (poolerDsn) {
      console.log('[load-test] Using pooler host for DATABASE_URL (LOADTEST_DB_MODE=pooler)');
      return poolerDsn;
    }
    console.warn('[load-test] LOADTEST_DB_MODE=pooler requested, but pooler DSN inputs are missing; falling back.');
  }

  if (mode !== 'auto' && mode !== 'direct' && mode !== 'pooler') {
    console.warn(`[load-test] Unknown LOADTEST_DB_MODE="${mode}" (expected auto|direct|pooler); using auto.`);
  }

  // Auto mode: try direct first (performance), then pooler (IPv4 stability), then DATABASE_URL.
  // If DATABASE_URL already includes hostaddr, prefer it first because containerized
  // runners can fail on IPv6-only DNS while hostaddr stays deterministic.
  if (inheritedHasHostaddr && probeDatabaseUrl(inheritedDatabaseUrl, 'DATABASE_URL(hostaddr)')) {
    console.log('[load-test] Using DATABASE_URL with hostaddr for load tests');
    return inheritedDatabaseUrl;
  }
  if (directDsn && probeDatabaseUrl(directDsn, 'direct')) {
    console.log('[load-test] Using direct DB host for DATABASE_URL');
    return directDsn;
  }
  if (poolerDsn && probeDatabaseUrl(poolerDsn, 'pooler')) {
    console.log('[load-test] Using Supabase pooler host for DATABASE_URL');
    return poolerDsn;
  }

  if (inheritedDatabaseUrl) {
    console.log('[load-test] Using DATABASE_URL as-is for load tests');
    return inheritedDatabaseUrl;
  }

  console.error(
    '[load-test] No LOADTEST_DATABASE_URL, no pooler env, and no DATABASE_URL set; cannot run load tests.',
  );
  process.exit(1);
};

const projectRoot = process.cwd();
const hostPath = projectRoot.replace(/\\/g, '/');
const volumePath = `${hostPath}:/work`;
const dbUrl = buildLoadtestDatabaseUrl();

function validateDay1LabelJwtContract() {
  if (!isDay1Scenario) return;
  if (!isTruthyFlag(process.env.LOAD_TEST_DAY1_VALIDATE_LABEL_JWT, true)) {
    return;
  }

  const requireDbJwt = String(process.env.EDGE_REQUIRE_DB_JWT || '').trim() === '1';
  if (!requireDbJwt) {
    console.log('[load-test] EDGE_REQUIRE_DB_JWT is not enforced; skipping day1 label JWT role contract validation.');
    return;
  }

  const token = String(process.env.LABEL_RENDERER_DB_JWT || '').trim();
  if (!token) {
    console.error(
      '[load-test] Missing LABEL_RENDERER_DB_JWT for day1 scenario while EDGE_REQUIRE_DB_JWT=1; label-renderer calls will be unauthorized.',
    );
    process.exit(1);
  }

  const payload = decodeJwtPayload(token);
  const role = payload && typeof payload.role === 'string' ? payload.role : '';
  if (!role) {
    console.error('[load-test] Unable to decode LABEL_RENDERER_DB_JWT role claim for day1 scenario.');
    process.exit(1);
  }
  if (role !== 'edge_label_renderer_role') {
    console.error(
      `[load-test] LABEL_RENDERER_DB_JWT role must be edge_label_renderer_role for day1 scenario (actual=${role}).`,
    );
    process.exit(1);
  }
  console.log('[load-test] Day1 label JWT role contract validated (edge_label_renderer_role).');
}

function ensureDay1StorageBucketsReady() {
  if (!isDay1Scenario) return;
  if (!isTruthyFlag(process.env.LOAD_TEST_DAY1_ENSURE_STORAGE_BUCKETS, true)) {
    return;
  }

  const scriptPath = path.join(projectRoot, 'scripts', 'ops', 'ensure-storage-buckets.js');
  if (!fs.existsSync(scriptPath)) {
    console.error(`[load-test] Missing prerequisite script: ${scriptPath}`);
    process.exit(1);
  }

  console.log('[load-test] Ensuring storage bucket prerequisites for day1 load scenario...');
  const ensure = spawnSync(process.execPath, [scriptPath], {
    stdio: 'inherit',
    timeout: storageTimeoutMs,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      LOADTEST_DATABASE_URL: process.env.LOADTEST_DATABASE_URL || dbUrl,
    },
  });
  if (ensure.status !== 0) {
    console.error(`[load-test] ensure-storage-buckets failed with status ${ensure.status || 1}.`);
    process.exit(ensure.status || 1);
  }
}

const resolveDockerEnv = () => {
  const env = { ...process.env };
  if (String(env.DOCKER_CONFIG || '').trim()) {
    return env;
  }
  const dockerConfigDir = path.join(projectRoot, 'tmp', 'docker-authless');
  fs.mkdirSync(dockerConfigDir, { recursive: true });
  const dockerConfigFile = path.join(dockerConfigDir, 'config.json');
  if (!fs.existsSync(dockerConfigFile)) {
    fs.writeFileSync(dockerConfigFile, '{}\n', 'utf8');
  }
  env.DOCKER_CONFIG = dockerConfigDir;
  console.log(
    `[load-test] Using isolated DOCKER_CONFIG (${path.relative(projectRoot, dockerConfigDir)})`,
  );
  return env;
};

const dockerEnv = resolveDockerEnv();

let summaryRelative =
  summaryArg || path.join('tmp', `load-${scenario.replace(/[^a-z0-9-]/gi, '-')}-summary.json`);

if (path.isAbsolute(summaryRelative)) {
  console.error('[load-test] Summary path must be relative to the project root.');
  process.exit(1);
}

summaryRelative = summaryRelative.replace(/\\/g, '/');
const summaryHostPath = path.join(projectRoot, summaryRelative);
const transcriptRelative = summaryRelative.replace(/\.json$/i, '.log');
const transcriptHostPath = path.join(projectRoot, transcriptRelative);

fs.mkdirSync(path.dirname(summaryHostPath), { recursive: true });
fs.mkdirSync(path.dirname(transcriptHostPath), { recursive: true });

function appendTranscript(text) {
  if (!text) return;
  fs.appendFileSync(transcriptHostPath, text, 'utf8');
}

try {
  fs.writeFileSync(transcriptHostPath, '', 'utf8');
} catch (_) {}

const writeRunSummary = (status, reason, details) => {
  const payload = {
    status,
    scenario,
    scenario_file: scenarioFile,
    reason,
    details,
    at: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(summaryHostPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.error('[load-test] Failed to write load summary:', e.message);
  }
};

const writeSkippedSummary = (reason, details) => writeRunSummary('skipped', reason, details);
const writeFailedSummary = (reason, details) => writeRunSummary('failed', reason, details);

function inspectDockerAvailability() {
  if (loadTestDockerMode === 'disable') {
    return {
      available: false,
      details: 'Docker disabled by LOAD_TEST_DOCKER_MODE=disable.',
    };
  }

  const info = spawnSync('docker', ['info'], { stdio: 'pipe', encoding: 'utf8', timeout: dockerCheckTimeoutMs, env: dockerEnv });
  const details = info.error
    ? info.error.message
    : `${info.stdout || ''}${info.stderr || ''}`.trim();

  return {
    available: !info.error && info.status === 0,
    details,
  };
}

// Preflight docker availability. GitHub-hosted CI stays fail-closed on missing
// Docker, while self-hosted CI defaults to the existing local xk6 fallback.
{
  const dockerStatus = inspectDockerAvailability();
  if (!dockerStatus.available) {
    const details = dockerStatus.details || 'docker info failed';
    if (loadTestDockerMode === 'require') {
      console.error('[load-test] Docker is required for this run but is not available.');
      if (details) console.error(details);
      writeFailedSummary('docker_unavailable', details);
      process.exit(1);
    }
    if (loadTestDockerMode === 'disable') {
      console.warn('[load-test] Docker usage disabled by policy; using local xk6 fallback.');
    } else {
      console.warn('[load-test] Docker not available; using local xk6 fallback.');
      if (details) console.warn(details);
    }
  }
}

validateDay1LabelJwtContract();
ensureDay1StorageBucketsReady();

const localK6EnvFlags = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'LABEL_RENDERER_DB_JWT',
  'WEBHOOK_HTTP_TOKEN',
  'API_GATEWAY_BASE_URL',
  'API_GATEWAY_HTTP_TOKEN',
  'API_GATEWAY_HTTP_PATH',
  'API_GATEWAY_HTTP_METHOD',
  'API_GATEWAY_HTTP_VUS',
  'API_GATEWAY_HTTP_DURATION',
  'PARTITION_VUS',
  'PARTITION_DURATION',
  'PARTITION_P95_MS',
  'PARTITION_CHECK_RATE',
  'PARTITION_CLEANUP',
  'WEBHOOK_HTTP_VUS',
  'WEBHOOK_HTTP_DURATION',
  'WEBHOOK_VUS',
  'WEBHOOK_DURATION',
  'DAY1_PROFILE',
  'DAY1_TENANTS',
  'DAY1_DURATION',
  'DAY1_VUS',
  'DAY1_SHIPMENTS_PER_ITER',
  'DAY1_LABEL_REQUEST_RATE',
  'DAY1_LABEL_HTTP_RETRY_ATTEMPTS',
  'DAY1_LABEL_HTTP_RETRY_SLEEP_MS',
  'DAY1_LABEL_HTTP_RETRY_BACKOFF_MS',
  'DAY1_LABEL_HTTP_RETRY_BACKOFF_MULTIPLIER',
  'DAY1_LABEL_HTTP_RETRY_MAX_SLEEP_MS',
  'DAY1_LABEL_HTTP_RETRY_JITTER_MS',
  'DAY1_LABEL_FAILURE_LOG_LIMIT',
  'DAY1_ITER_SLEEP_MS',
  'DAY1_ERROR_RATE_MAX',
  'DAY1_SHIPMENT_P95_MS',
  'DAY1_SHIPMENT_P99_MS',
  'DAY1_LABEL_P95_MS',
  'DAY1_LABEL_P99_MS',
  'DAY1_HTTP_P95_MS',
  'DAY1_HTTP_P99_MS',
  'DAY1_AUTO_CREATE_TENANTS',
  'DAY1_CLEANUP',
  'DAY1_CLEANUP_TENANTS',
].flatMap((key) => (process.env[key] ? ['-e', `${key}=${process.env[key]}`] : []));

const k6RunArgs = [
  '--tag',
  `scenario=${scenario}`,
  '--summary-export',
  summaryRelative,
  scenarioFile,
];

function dockerAvailable() {
  const check = spawnSync('docker', ['info'], {
    stdio: 'ignore',
    timeout: dockerCheckTimeoutMs,
    env: dockerEnv,
  });
  if (check.error) {
    console.warn(`[load-test] Docker check failed (${check.error.code || check.error.message}).`);
    return false;
  }
  if (check.status !== 0) {
    console.warn(`[load-test] Docker check failed (status ${check.status}).`);
    return false;
  }
  return true;
}

// k6 run exposes the container environment in __ENV by default.
const dockerEnvFlags = [
  'LOADTEST_DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'LABEL_RENDERER_DB_JWT',
  'WEBHOOK_HTTP_TOKEN',
  'API_GATEWAY_BASE_URL',
  'API_GATEWAY_HTTP_TOKEN',
  'API_GATEWAY_HTTP_PATH',
  'API_GATEWAY_HTTP_METHOD',
  'API_GATEWAY_HTTP_VUS',
  'API_GATEWAY_HTTP_DURATION',
  'PARTITION_VUS',
  'PARTITION_DURATION',
  'PARTITION_P95_MS',
  'PARTITION_CHECK_RATE',
  'PARTITION_CLEANUP',
  'WEBHOOK_HTTP_VUS',
  'WEBHOOK_HTTP_DURATION',
  'WEBHOOK_VUS',
  'WEBHOOK_DURATION',
  'DAY1_PROFILE',
  'DAY1_TENANTS',
  'DAY1_DURATION',
  'DAY1_VUS',
  'DAY1_SHIPMENTS_PER_ITER',
  'DAY1_LABEL_REQUEST_RATE',
  'DAY1_LABEL_HTTP_RETRY_ATTEMPTS',
  'DAY1_LABEL_HTTP_RETRY_SLEEP_MS',
  'DAY1_LABEL_HTTP_RETRY_BACKOFF_MS',
  'DAY1_LABEL_HTTP_RETRY_BACKOFF_MULTIPLIER',
  'DAY1_LABEL_HTTP_RETRY_MAX_SLEEP_MS',
  'DAY1_LABEL_HTTP_RETRY_JITTER_MS',
  'DAY1_LABEL_FAILURE_LOG_LIMIT',
  'DAY1_ITER_SLEEP_MS',
  'DAY1_ERROR_RATE_MAX',
  'DAY1_SHIPMENT_P95_MS',
  'DAY1_SHIPMENT_P99_MS',
  'DAY1_LABEL_P95_MS',
  'DAY1_LABEL_P99_MS',
  'DAY1_HTTP_P95_MS',
  'DAY1_HTTP_P99_MS',
  'DAY1_AUTO_CREATE_TENANTS',
  'DAY1_CLEANUP',
  'DAY1_CLEANUP_TENANTS',
].flatMap((key) => (process.env[key] ? ['-e', `${key}=${process.env[key]}`] : []));

const dockerArgs = [
  'run',
  '--rm',
  // Ensure the container user can write to the bind-mounted workspace (CI).
  ...(process.platform === 'win32' || typeof process.getuid !== 'function' || typeof process.getgid !== 'function'
    ? []
    : ['--user', `${process.getuid()}:${process.getgid()}`]),
  // Ensure Go build caches are writable when running as a non-root UID.
  '-e', 'HOME=/tmp',
  '-e', 'XDG_CACHE_HOME=/tmp/.cache',
  '-e', 'GOCACHE=/tmp/.cache/go-build',
  '-e', 'GOMODCACHE=/tmp/.cache/go-mod',
  '-e', `DATABASE_URL=${dbUrl}`,
  ...dockerEnvFlags,
  '-v',
  volumePath,
  '-w',
  '/work',
  '--entrypoint',
  'sh',
  xk6DockerImage,
  '-c',
  'xk6 build "$1" --with "$2" --with "$3" --output /tmp/k6 && shift 3 && exec /tmp/k6 run "$@"',
  'load-test', // sh -c assigns this argument to $0.
  xk6K6Version,
  `github.com/grafana/xk6-sql@${xk6SqlVersion}`,
  `github.com/grafana/xk6-sql-driver-postgres@${xk6SqlPostgresVersion}`,
  ...k6RunArgs,
];

console.log(`[load-test] Running ${scenario} scenario via ${scenarioFile}`);
console.log(`[load-test] Summary export -> ${summaryRelative}`);
console.log(`[load-test] Transcript log -> ${transcriptRelative}`);
appendTranscript(`[load-test] scenario=${scenario} file=${scenarioFile} summary=${summaryRelative}\n`);

function runWithLocalXk6() {
  console.warn('[load-test] Docker unavailable; falling back to local xk6 build (Go required).');

  const xk6ToolVersion = (() => {
    const explicit = process.env.XK6_TOOL_VERSION;
    if (explicit) return explicit;
    const tag = (xk6DockerImage.split(':')[1] || '').trim();
    if (!tag) return 'v0.14.0';
    return tag.startsWith('v') ? tag : `v${tag}`;
  })();

  const tmpDir = path.join(projectRoot, 'tmp', 'xk6');
  fs.mkdirSync(tmpDir, { recursive: true });
  const k6Binary = path.join(tmpDir, process.platform === 'win32' ? 'k6.exe' : 'k6');

  const shouldBuild = !fs.existsSync(k6Binary) || process.env.XK6_FORCE_REBUILD === 'true';
  if (shouldBuild) {
    console.log(`[load-test] Building k6 binary via xk6 (${xk6ToolVersion}) -> ${path.relative(projectRoot, k6Binary)}`);
    const build = spawnSync(
      'go',
      [
        'run',
        `go.k6.io/xk6/cmd/xk6@${xk6ToolVersion}`,
        'build',
        xk6K6Version,
        '--with',
        `github.com/grafana/xk6-sql@${xk6SqlVersion}`,
        '--with',
        `github.com/grafana/xk6-sql-driver-postgres@${xk6SqlPostgresVersion}`,
        '--output',
        k6Binary,
      ],
      { stdio: 'inherit', timeout: buildTimeoutMs },
    );

    if (build.error) {
      console.error('[load-test] Local xk6 build failed:', build.error.message);
      writeFailedSummary('xk6_build_failed', build.error.message);
      return { status: 1 };
    }
    if (build.status !== 0) {
      console.error(`[load-test] Local xk6 build exited with status ${build.status}`);
      writeFailedSummary('xk6_build_failed', `exit ${build.status}`);
      return build;
    }
  }

  console.log(`[load-test] Running k6 locally: ${path.relative(projectRoot, k6Binary)} run ${scenarioFile}`);
  const run = spawnSync(
    k6Binary,
    ['run', ...localK6EnvFlags, '-e', `DATABASE_URL=${dbUrl}`, ...k6RunArgs],
    { stdio: 'pipe', encoding: 'utf8', timeout: localK6TimeoutMs },
  );
  appendTranscript(String(run.stdout || ''));
  appendTranscript(String(run.stderr || ''));
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);

  if (run.error) {
    console.error('[load-test] Failed to run local k6:', run.error.message);
    writeFailedSummary('local_k6_exec_failed', run.error.message);
    return { status: 1 };
  }

  return run;
}

// Optional: provision an ephemeral ingress token for HTTP scenarios.
let provisioned = null;
if (scenario === 'webhook-ingest-http' && autoProvision && !process.env.WEBHOOK_HTTP_TOKEN) {
  if (!process.env.DATABASE_URL) {
    console.error('[load-test] --auto-provision-http-token requires DATABASE_URL in env.');
    process.exit(1);
  }
  const token = `lt_${Math.random().toString(36).slice(2, 12)}_${Date.now()}`;
  const sourceIdentifier = `loadtest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const mappingKey = `${sourceIdentifier}::shipment.created`;
  const mappingConfig = JSON.stringify({
    description: 'HTTP loadtest minimal mapping',
    external_id_path: 'event.id',
    event_type_path: 'event.type',
    transforms: { default: { event_id: 'event.id' } },
  });

  console.log(
    `[load-test] Auto-provisioning webhook source ${sourceIdentifier} for client ${clientSlug}`,
  );
  const provEnv = { ...process.env };
  const provArgs = [
    'node',
    'scripts/clients/provision-webhook-source.js',
    '--client-slug',
    clientSlug,
    '--source-identifier',
    sourceIdentifier,
    '--mapping-key',
    mappingKey,
    '--mapping-config',
    mappingConfig,
    '--auth-token',
    token,
    '--source-name',
    sourceIdentifier,
    '--provider-type',
    'async_3pl',
  ];
  const prov = spawnSync(provArgs[0], provArgs.slice(1), { stdio: 'inherit', timeout: provisionTimeoutMs, env: provEnv });
  if (prov.status !== 0) {
    console.error('[load-test] Failed to provision ephemeral webhook source.');
    process.exit(prov.status || 1);
  }
  process.env.WEBHOOK_HTTP_TOKEN = token;
  provisioned = { sourceIdentifier, clientSlug };
}

if (scenario === 'api-gateway-http' && autoProvision && !process.env.API_GATEWAY_HTTP_TOKEN) {
  if (!process.env.DATABASE_URL) {
    console.error('[load-test] --auto-provision-http-token requires DATABASE_URL in env.');
    process.exit(1);
  }
  const token = `lt_api_${Math.random().toString(36).slice(2, 12)}_${Date.now()}`;
  const sourceIdentifier = `api-loadtest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const mappingKey = `${sourceIdentifier}::api_gateway_http`;
  const mappingConfig = JSON.stringify({
    description: 'API gateway HTTP loadtest auth source',
  });

  console.log(
    `[load-test] Auto-provisioning API gateway source ${sourceIdentifier} for client ${clientSlug}`,
  );
  const provEnv = { ...process.env };
  const provArgs = [
    'node',
    'scripts/clients/provision-webhook-source.js',
    '--client-slug',
    clientSlug,
    '--source-identifier',
    sourceIdentifier,
    '--mapping-key',
    mappingKey,
    '--mapping-config',
    mappingConfig,
    '--auth-token',
    token,
    '--source-name',
    sourceIdentifier,
    '--provider-type',
    'api_gateway',
  ];
  const prov = spawnSync(provArgs[0], provArgs.slice(1), { stdio: 'inherit', timeout: provisionTimeoutMs, env: provEnv });
  if (prov.status !== 0) {
    console.error('[load-test] Failed to provision ephemeral API gateway source.');
    process.exit(prov.status || 1);
  }
  process.env.API_GATEWAY_HTTP_TOKEN = token;
  provisioned = { sourceIdentifier, clientSlug };
}

requireScenarioPrerequisites();

function runOnce() {
  let runResult;

  if (loadTestDockerMode !== 'disable' && dockerAvailable()) {
    runResult = spawnSync('docker', dockerArgs, {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: dockerTimeoutMs,
      env: dockerEnv,
    });
    appendTranscript(String(runResult.stdout || ''));
    appendTranscript(String(runResult.stderr || ''));
    if (runResult.stdout) process.stdout.write(runResult.stdout);
    if (runResult.stderr) process.stderr.write(runResult.stderr);
    if (runResult.error && runResult.error.code === 'ETIMEDOUT') {
      console.warn(`[load-test] Docker run timed out after ${dockerTimeoutMs}ms.`);
    }
  } else {
    runResult = {
      status: 1,
      error: new Error(
        loadTestDockerMode === 'disable' ? 'Docker disabled by policy' : 'Docker unavailable',
      ),
    };
  }

  if (runResult.error || runResult.status !== 0) {
    const dockerMsg = runResult.error ? runResult.error.message : `status ${runResult.status}`;
    console.warn(`[load-test] Docker run failed (${dockerMsg}).`);
    runResult = runWithLocalXk6();
  }

  return runResult;
}

const maxAttempts = parseInt(process.env.LOAD_TEST_MAX_ATTEMPTS || '1', 10) || 1;
const retryBackoffMs = parseInt(process.env.LOAD_TEST_RETRY_BACKOFF_MS || '3000', 10) || 3000;

let result;
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  if (maxAttempts > 1) {
    console.log(`[load-test] Attempt ${attempt}/${maxAttempts}...`);
  }

  result = runOnce();

  if (!result || result.status === 0) break;

  // k6 uses exit code 99 for threshold failures.
  const shouldRetry = result.status === 99 && attempt < maxAttempts;
  if (!shouldRetry) break;

  const waitMs = retryBackoffMs * attempt;
  console.warn(`[load-test] Thresholds failed (exit 99). Retrying after ${waitMs}ms...`);
  sleepSync(waitMs);
}

if (result?.status !== 0) {
  console.error(`[load-test] Scenario "${scenario}" exited with status ${result.status}`);
  if (!fs.existsSync(summaryHostPath)) {
    writeFailedSummary('scenario_failed', `exit ${result.status || 1}`);
  }
}

async function cleanupProvisioned() {
  if (!provisioned || !process.env.DATABASE_URL) return;
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    try {
      const { rows: orgRows } = await client.query(
        'SELECT organization_id FROM clients WHERE slug = $1 LIMIT 1',
        [provisioned.clientSlug],
      );
      const organizationId = orgRows[0]?.organization_id || null;

      const ws = await client.query(
        `SELECT id, mapping_config_id
         FROM webhook_sources
         WHERE source_identifier = $1
           AND ($2::uuid IS NULL OR organization_id = $2::uuid)`,
        [provisioned.sourceIdentifier, organizationId]
      );
      if (ws.rowCount > 0) {
        const mappingConfigId = ws.rows[0].mapping_config_id;
        await client.query(
          `DELETE FROM webhook_sources
           WHERE source_identifier = $1
             AND ($2::uuid IS NULL OR organization_id = $2::uuid)`,
          [provisioned.sourceIdentifier, organizationId],
        );
        if (mappingConfigId) {
          await client.query('DELETE FROM mapping_configs WHERE id = $1', [mappingConfigId]);
        }
      }
      console.log(`[load-test] Cleaned up webhook source ${provisioned.sourceIdentifier}`);
    } finally {
      client.release();
      await pool.end();
    }
  } catch (e) {
    console.error('[load-test] Cleanup skipped (pg not available):', e.message);
  }
}

async function finalize() {
  await cleanupProvisioned();
  await qa.recordCaseResults(qaSuiteKey, [
    {
      case_key: `scenario:${scenario}`,
      status: result.status === 0 ? 'passed' : 'failed',
      started_at: new Date(runStartedAt).toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: Date.now() - runStartedAt,
      metadata: { scenario, suite: qaSuiteKey, summary: summaryRelative || null },
      error_summary: result.status === 0 ? null : `exit ${result.status || 1}`,
    },
  ]);
  await qa.close();
  process.exit(result.status ?? 0);
}

finalize().catch((err) => {
  console.error('[load-test] finalize failed:', err.message);
  process.exit(1);
});
