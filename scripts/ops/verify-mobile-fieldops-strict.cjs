#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawnSync } = require('child_process');
const { ensurePlaywrightChromium } = require('./ci/install-playwright-chromium');
const {
  evaluateNativeScreenshotManifest,
  validateFieldopsStorePreflightProfile,
} = require('./fieldops-store-preflight');
const {
  ensureCloudDbBootstrap,
  resolveBootstrapMode,
} = require('./cloud-db-bootstrap');
const { loadEnv } = require('../utils/load-env');
const {
  isSensitiveCredentialKey,
} = require('./workspace/docker-runtime/secret-policy');

const npmCmd = process.platform.startsWith('win') ? 'npm.cmd' : 'npm';
const npxCmd = process.platform.startsWith('win') ? 'npx.cmd' : 'npx';
const repoRoot = path.resolve(__dirname, '..', '..');
const coverageSummaryPath = path.join(repoRoot, 'coverage', 'coverage-summary.json');
const windowsNodeModulesDir = path.resolve(process.execPath, '..', 'node_modules', 'npm', 'bin');
const npmCliPath = path.join(windowsNodeModulesDir, 'npm-cli.js');
const npxCliPath = path.join(windowsNodeModulesDir, 'npx-cli.js');
// objectives:allow LOCALHOST Justification: strict FieldOps local verification binds only to loopback so the E2E harness never exposes ports beyond the developer machine.
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_LOCAL_DB_SMOKE_MAX_WAIT_MS = 600000;
const DEFAULT_STRICT_STEP_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_STRICT_INTEGRATION_TIMEOUT_MS = 15 * 60 * 1000;
const FIELDOPS_DRIVER_GO_LIVE_TEST_PATH =
  'tests/integration/fieldops/fieldops-driver-go-live.test.js';
const FIELDOPS_PGTAP_FILES = Object.freeze([
  '0zi_fieldops_mobile_hardening_v1.sql',
  '0zj_fieldops_mobile_sync_artifact_exception_v1.sql',
  '0zz_fieldops_driver_signup_status_v1.sql',
]);
const NATIVE_SCREENSHOT_SOURCE_DIR = path.join(
  repoRoot,
  'docs',
  'product',
  'examples',
  'mobile-field-ops-ui',
);

const COVERAGE_TARGETS = [
  { file: 'apps/fieldops/src/mobile-accessibility-audit.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-shell-access.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-memory-store.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-background-location.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-telemetry.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-crash-reporting.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-sync-policy.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-app-integrity.ts', minLines: 90, minBranches: 80 },
];

const UNIT_TEST_FILES = [
  'tests/unit/fieldops/mobile-shell-display.test.ts',
  'tests/unit/fieldops/mobile-theme.test.ts',
  'tests/unit/fieldops/mobile-i18n.test.ts',
  'tests/unit/fieldops/mobile-display-app-contract.test.ts',
  'tests/unit/fieldops/mobile-accessibility-audit.test.ts',
  'tests/unit/fieldops/mobile-native-e2e-test-ids.test.ts',
  'tests/unit/fieldops/mobile-shell-access.test.ts',
  'tests/unit/fieldops/mobile-memory-store.test.ts',
  'tests/unit/fieldops/mobile-background-location.test.ts',
  'tests/unit/fieldops/mobile-telemetry.test.ts',
  'tests/unit/fieldops/mobile-crash-reporting.test.ts',
  'tests/unit/fieldops/mobile-sync-policy.test.ts',
  'tests/unit/mobile-app-integrity.test.ts',
  'tests/unit/ops/fieldops-native-e2e-contract.test.js',
  'tests/unit/ops/fieldops-store-preflight.test.js',
];

const LOCAL_CI_FIELDOPS_BUILD_ENV_DEFAULTS = Object.freeze({
  NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS: 'com.masarx.fieldops',
  NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS: 'com.masarx.fieldops',
  NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS: '8b7b3e65-e22e-4ef7-949e-21c62f02506d',
});

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

const STATIC_CHILD_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'FORCE_COLOR', 'NO_COLOR',
  'CI', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'NODE_ENV', 'NODE_NO_WARNINGS',
  'NPM_CONFIG_CACHE', 'NPM_CONFIG_OFFLINE', 'NPM_CONFIG_PREFER_OFFLINE', 'NPM_CONFIG_LOGLEVEL',
  'NX_DAEMON', 'NX_SKIP_NX_CACHE', 'NX_WORKSPACE_DATA_DIRECTORY',
  'FIELDOPS_STRICT_STEP_TIMEOUT_MS',
]);

function buildStaticChildEnv(env = process.env) {
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => {
    const normalized = key.toUpperCase();
    const allowed = STATIC_CHILD_ENV_KEYS.has(normalized)
      || /^(NEXT_PUBLIC|EXPO_PUBLIC)_/.test(normalized);
    return allowed && !isSensitiveCredentialKey(key);
  }));
  return {
    ...childEnv,
    // Existing loadEnv returns after this empty file, without probing repository secrets.
    ENV_FILE: os.devNull,
    ENV_FILE_APPEND: 'false',
    ENV_FILE_OVERRIDE: 'false',
  };
}

const PUBLIC_CHILD_ENV_KEYS = Object.freeze([
  'DEMO_ACCOUNTS_PROVISION_GUARD', 'FIELDOPS_CAPTURE_NATIVE_SCREENSHOTS',
  'FIELDOPS_DRIVER_GO_LIVE_STEP_TIMEOUT_MS', 'FIELDOPS_DRIVER_GO_LIVE_TEST_TIMEOUT_MS',
  'FIELDOPS_E2E_PORT', 'FIELDOPS_E2E_REUSE_SERVER',
  'FIELDOPS_NATIVE_SCREENSHOT_ANDROID_SERIAL', 'FIELDOPS_NATIVE_SCREENSHOT_HOST',
  'FIELDOPS_NATIVE_SCREENSHOT_IOS_UDID', 'FIELDOPS_NATIVE_SCREENSHOT_LAUNCH_WAIT_MS',
  'FIELDOPS_NATIVE_SCREENSHOT_MANIFEST_PATH', 'FIELDOPS_NATIVE_SCREENSHOT_OUTPUT_DIR',
  'FIELDOPS_NATIVE_SCREENSHOT_PLATFORMS', 'FIELDOPS_NATIVE_SCREENSHOT_PORT',
  'FIELDOPS_NATIVE_SCREENSHOT_RENDER_WAIT_MS', 'FIELDOPS_NATIVE_SCREENSHOT_SOURCE_DIR',
  'FIELDOPS_STORE_PREFLIGHT_PROFILE', 'FIELDOPS_NATIVE_ACCEPTANCE_DEFERRED',
  'FIELDOPS_STRICT_INTEGRATION_TIMEOUT_MS',
  'FIELDOPS_STRICT_STEP_TIMEOUT_MS', 'FIELDOPS_VERIFY_PHASES', 'FIELDOPS_VERIFY_SKIP_E2E',
  'FIELDOPS_VERIFY_SKIP_STORE_PREFLIGHT', 'MOBILE_PREFLIGHT_REPORT_PATH',
  'NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS', 'NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS',
  'NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_URL', 'STRICT_CORE_ENV', 'SUPABASE_ANON_KEY', 'SUPABASE_URL',
]);
const DB_INTEGRATION_ENV_KEYS = Object.freeze([
  'API_CALLER_DB_JWT', 'API_GATEWAY_DB_JWT', 'DATABASE_URL', 'DATABASE_URL_DIRECT',
  'DATABASE_URL_POOLER', 'DB_SMOKE_SELECTED_DSN_NAME', 'INTEGRATION_JEST_FORCE_EXIT',
  'LABEL_RENDERER_DB_JWT', 'PG_CONN_STRING', 'PGSSLMODE', 'SHARED_LANE_DB_PROBE_OK',
  'SHARED_LANE_DB_PROBE_SELECTED_DSN_NAME', 'SHARED_LANE_PREFLIGHT_OK',
  'SUPABASE_SERVICE_ROLE_KEY', 'WEBHOOK_DB_JWT',
]);
const FIELDOPS_E2E_ENV_KEYS = Object.freeze([
  // Git receipt identity may borrow the runner's read-only object store.
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'MASARX_RUNTIME_LEASE_DIR',
  'WORKSPACE_NAME', 'BRANCH_CONVERGENCE_RUNTIME_OWNER',
  'WORKSPACE_BACKEND_ALLOCATION_RECEIPT',
  'WORKSPACE_BRANCH_CONVERGENCE_HEARTBEAT_LEASE_DESCRIPTORS',
  'SELF_KYC_PROOF_DISPOSAL_REQUIRED',
  'SELF_KYC_BROWSER_EN_PROOF_EVIDENCE_PATH',
  'SELF_KYC_BROWSER_AR_PROOF_EVIDENCE_PATH',
  'FINANCIAL_BROWSER_PROOF_DISPOSAL_REQUIRED',
  'FINANCIAL_BROWSER_EN_PROOF_EVIDENCE_PATH',
  'FINANCIAL_BROWSER_AR_PROOF_EVIDENCE_PATH',
]);
const DB_PGTAP_ENV_KEYS = Object.freeze([
  'DATABASE_URL', 'DATABASE_URL_DIRECT', 'DATABASE_URL_POOLER', 'DB_SMOKE_SELECTED_DSN_NAME',
  'PG_CONN_STRING', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE',
  'PGTAP_ONLY_FILES', 'SHARED_LANE_DB_PROBE_OK', 'SHARED_LANE_DB_PROBE_SELECTED_DSN_NAME',
  'SHARED_LANE_PREFLIGHT_OK',
]);
const STRICT_PHASES = Object.freeze(['public', 'db']);
const PUBLIC_ANON_KEY_NAMES = new Set(['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY']);

function copyExactChildEnv(env, keys, overrides = {}) {
  const allowed = new Set([...STATIC_CHILD_ENV_KEYS, ...keys].map(key => key.toUpperCase()));
  const selected = Object.fromEntries(Object.entries(env || {}).filter(([key, value]) => {
    const normalized = key.toUpperCase();
    return value != null && allowed.has(normalized)
      && (!isSensitiveCredentialKey(key) || PUBLIC_ANON_KEY_NAMES.has(normalized));
  }));
  return {
    ...selected,
    ENV_FILE: os.devNull,
    ENV_FILE_APPEND: 'false',
    ENV_FILE_OVERRIDE: 'false',
    ...overrides,
  };
}

function buildPublicChildEnv(env = process.env, overrides = {}) {
  return copyExactChildEnv(env, PUBLIC_CHILD_ENV_KEYS, overrides);
}

function buildDbIntegrationEnv(env = process.env, overrides = {}) {
  const selected = Object.fromEntries(Object.entries(env || {}).filter(([key, value]) =>
    value != null && DB_INTEGRATION_ENV_KEYS.includes(key)));
  return { ...buildPublicChildEnv(env), ...selected, ...overrides };
}

function buildFieldopsE2eEnv(env = process.env, overrides = {}) {
  const selected = Object.fromEntries(Object.entries(env || {}).filter(([key, value]) =>
    value != null && FIELDOPS_E2E_ENV_KEYS.includes(key)));
  return { ...buildDbIntegrationEnv(env), ...selected, ...overrides };
}

function buildDbPgtapEnv(env = process.env, overrides = {}) {
  const selected = Object.fromEntries(Object.entries(env || {}).filter(([key, value]) =>
    value != null && DB_PGTAP_ENV_KEYS.includes(key)));
  return { ...buildPublicChildEnv(env), ...selected, ...overrides };
}

function resolveStrictPhases(env = process.env) {
  const raw = String(env.FIELDOPS_VERIFY_PHASES || 'all').trim().toLowerCase();
  if (!raw || raw === 'all') return new Set(STRICT_PHASES);
  const selected = new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean));
  const invalid = [...selected].filter((entry) => !STRICT_PHASES.includes(entry));
  if (invalid.length || !selected.size) throw new Error(`Invalid FIELDOPS_VERIFY_PHASES: ${invalid.join(',') || raw}`);
  return selected;
}

function validateExplicitEnvFileBeforeLoad(env = process.env) {
  if (!isTruthy(env.FIELDOPS_REMOVE_ENV_FILE_AFTER_LOAD)) return null;
  const explicit = String(env.ENV_FILE || '').trim();
  const runnerTempRaw = String(env.RUNNER_TEMP || '').trim();
  if (!explicit || !runnerTempRaw) throw new Error('FIELDOPS_REMOVE_ENV_FILE_AFTER_LOAD requires ENV_FILE and RUNNER_TEMP.');
  const runnerTemp = fs.realpathSync(path.resolve(runnerTempRaw));
  const resolved = path.resolve(repoRoot, explicit);
  if (path.dirname(resolved) !== runnerTemp) throw new Error(`Refusing ENV_FILE that is not a direct child of RUNNER_TEMP: ${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing non-regular or symlink ENV_FILE: ${resolved}`);
  if (typeof process.getuid === 'function' && Number.isInteger(stat.uid) && stat.uid !== process.getuid()) throw new Error(`Refusing ENV_FILE not owned by the current user: ${resolved}`);
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) throw new Error(`Refusing ENV_FILE without mode 0600: ${resolved}`);
  const realResolved = fs.realpathSync(resolved);
  if (path.dirname(realResolved) !== runnerTemp) throw new Error(`Refusing ENV_FILE resolved outside RUNNER_TEMP: ${resolved}`);
  return { path: realResolved, dev: stat.dev, ino: stat.ino };
}

function removeExplicitEnvFileAfterLoad(env = process.env, validatedBeforeLoad = null) {
  if (!isTruthy(env.FIELDOPS_REMOVE_ENV_FILE_AFTER_LOAD)) return false;
  const current = validateExplicitEnvFileBeforeLoad(env);
  if (validatedBeforeLoad && (current.path !== validatedBeforeLoad.path || current.dev !== validatedBeforeLoad.dev || current.ino !== validatedBeforeLoad.ino)) {
    throw new Error(`Refusing ENV_FILE whose identity changed during load: ${current.path}`);
  }
  fs.rmSync(current.path);
  if (fs.existsSync(current.path)) throw new Error(`Failed to remove ENV_FILE: ${current.path}`);
  delete env.ENV_FILE;
  delete process.env.ENV_FILE;
  return true;
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeFailureToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function classifyStrictFailureClass(stepLabel) {
  const label = String(stepLabel || '').trim();
  if (!label) return 'mobile-strict-failed';
  const normalized = normalizeFailureToken(label);
  if (normalized === 'typecheck-fieldops') return 'typecheck';
  if (normalized === 'coverage-thresholds' || normalized === 'unit-test-coverage') return 'unit-coverage';
  if (normalized === 'db-bootstrap') return 'db-bootstrap';
  if (normalized === 'test-integration-fieldops-driver-go-live') return 'integration';
  if (normalized === 'test-pgtap-fieldops-mobile-pack') return 'pgtap';
  if (normalized === 'test-e2e-fieldops') return 'e2e';
  if (normalized === 'fieldops-screenshots-native-runtime') return 'native-screenshots';
  if (normalized === 'fieldops-store-preflight') return 'store-preflight';
  return normalized || 'mobile-strict-failed';
}

function createStrictSummary(env = process.env) {
  const profile = String(env.FIELDOPS_STORE_PREFLIGHT_PROFILE || '').trim().toLowerCase();
  return {
    generated_at: new Date().toISOString(),
    status: 'passed',
    failed_step: '',
    failure_class: '',
    store_preflight_profile: profile,
    native_evidence_status: profile === 'convergence' ? 'deferred' : 'required',
    native_release_eligible: profile === 'convergence' ? false : null,
    native_screenshot_capture_enabled: isTruthy(env.FIELDOPS_CAPTURE_NATIVE_SCREENSHOTS),
    native_screenshot_manifest_path: String(env.FIELDOPS_NATIVE_SCREENSHOT_MANIFEST_PATH || '').trim(),
    store_preflight_skipped: false,
    e2e_skipped: false,
    steps: [],
  };
}

function resolveStrictStepTimeoutMs(label, env = process.env) {
  const normalized = normalizeFailureToken(label);
  if (normalized === 'test-integration-fieldops-driver-go-live') {
    return (
      parsePositiveInteger(env.FIELDOPS_DRIVER_GO_LIVE_STEP_TIMEOUT_MS) ||
      parsePositiveInteger(env.FIELDOPS_STRICT_INTEGRATION_TIMEOUT_MS) ||
      DEFAULT_STRICT_INTEGRATION_TIMEOUT_MS
    );
  }
  return (
    parsePositiveInteger(env.FIELDOPS_STRICT_STEP_TIMEOUT_MS) || DEFAULT_STRICT_STEP_TIMEOUT_MS
  );
}

function buildFieldopsDriverGoLiveIntegrationArgs() {
  return [
    path.join('scripts', 'tests', 'run-integration-cloud.js'),
    '--runTestsByPath',
    FIELDOPS_DRIVER_GO_LIVE_TEST_PATH,
  ];
}

function buildFieldopsDriverGoLiveIntegrationEnv(env = process.env) {
  return buildDbIntegrationEnv(env, {
    // Assertions are complete when Jest finishes; prevent socket teardown stalls.
    INTEGRATION_JEST_FORCE_EXIT: 'true',
  });
}

function writeStrictSummary(targetPath, payload) {
  const resolved = String(targetPath || '').trim();
  if (!resolved) return '';
  const absolutePath = path.resolve(process.cwd(), resolved);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return absolutePath;
}

function resolveNativeScreenshotOutputDir(env = process.env, now = new Date()) {
  const explicit = String(env.FIELDOPS_NATIVE_SCREENSHOT_OUTPUT_DIR || '').trim();
  if (explicit) {
    return path.resolve(repoRoot, explicit);
  }
  return path.join(
    repoRoot,
    'docs',
    'ops',
    'evidence',
    now.toISOString().slice(0, 10),
    'mobile-fieldops',
    'ui-screenshots-native-runtime',
  );
}

function parsePositivePort(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 0;
}

function canBindPort(port, host = LOOPBACK_HOST) {
  const resolvedPort = parsePositivePort(port);
  if (!resolvedPort) return Promise.resolve(false);
  return new Promise((resolve) => {
    const server = net.createServer();
    const finalize = (available) => {
      try {
        server.close(() => resolve(available));
      } catch {
        resolve(available);
      }
    };
    server.once('error', () => resolve(false));
    server.once('listening', () => finalize(true));
    server.listen(resolvedPort, host);
  });
}

function reserveEphemeralPort(host = LOOPBACK_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = Number(address && typeof address === 'object' ? address.port : 0);
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function resolveFieldopsE2ePort(
  env = process.env,
  { preferredPort = 8081, host = LOOPBACK_HOST, logger = console } = {},
) {
  const explicitPort = parsePositivePort(env.FIELDOPS_E2E_PORT);
  if (explicitPort) {
    logger.log?.(`[verify:mobile:fieldops:strict] fieldops e2e port=${explicitPort} source=explicit`);
    return explicitPort;
  }
  const fallbackPort = await reserveEphemeralPort(host);
  if (!fallbackPort) {
    throw new Error('Unable to reserve a free port for FieldOps E2E.');
  }
  logger.log?.(
    `[verify:mobile:fieldops:strict] fieldops e2e port=${fallbackPort} source=ephemeral (default ${preferredPort})`,
  );
  return fallbackPort;
}

function quoteWindowsArg(value) {
  const text = String(value ?? '');
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function normalizeWindowsExecPath(processExecPath = process.execPath) {
  return String(processExecPath || '').trim().replace(/^"+|"+$/g, '');
}

function resolveBundledWindowsNpmCli(processExecPath = process.execPath) {
  const normalizedExecPath = normalizeWindowsExecPath(processExecPath);
  if (!normalizedExecPath) return '';
  return path.win32.join(
    path.win32.dirname(normalizedExecPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
}

function resolveBundledWindowsNpxCli(processExecPath = process.execPath) {
  const normalizedExecPath = normalizeWindowsExecPath(processExecPath);
  if (!normalizedExecPath) return '';
  return path.win32.join(
    path.win32.dirname(normalizedExecPath),
    'node_modules',
    'npm',
    'bin',
    'npx-cli.js',
  );
}

function resolveStepCommand(cmd, args, options = {}) {
  const platform = String(options.platform || process.platform);
  const processExecPath = normalizeWindowsExecPath(options.processExecPath || process.execPath);
  const comSpec = String(options.comSpec || process.env.ComSpec || 'cmd.exe');
  const existsSyncFn = options.existsSyncFn || fs.existsSync;
  const normalizedArgs = Array.isArray(args) ? [...args] : [];
  if (!platform.startsWith('win')) {
    return { cmd, args: normalizedArgs };
  }

  const normalizeWinPath = (value) => path.win32.normalize(String(value || '')).toLowerCase();
  const normalizeWinCommand = (value) => String(value || '').trim().toLowerCase();
  if (normalizeWinPath(cmd) === normalizeWinPath(processExecPath)) {
    return {
      cmd: processExecPath,
      args: normalizedArgs,
    };
  }

  const resolvedNpmCliPath = resolveBundledWindowsNpmCli(processExecPath);
  if (['npm', 'npm.cmd'].includes(normalizeWinCommand(cmd)) && existsSyncFn(resolvedNpmCliPath)) {
    return {
      cmd: processExecPath,
      args: [resolvedNpmCliPath, ...normalizedArgs],
    };
  }

  const resolvedNpxCliPath = resolveBundledWindowsNpxCli(processExecPath);
  if (['npx', 'npx.cmd'].includes(normalizeWinCommand(cmd)) && existsSyncFn(resolvedNpxCliPath)) {
    return {
      cmd: processExecPath,
      args: [resolvedNpxCliPath, ...normalizedArgs],
    };
  }

  return {
    cmd: comSpec,
    args: ['/d', '/s', '/c', [cmd, ...normalizedArgs].map(quoteWindowsArg).join(' ')],
  };
}

function runStep(label, cmd, args, env = process.env) {
  console.log(`[verify:mobile:fieldops:strict] ${label}`);
  const resolved = resolveStepCommand(cmd, args, {
    processExecPath: process.execPath,
    existsSyncFn: (candidate) => {
      if (!process.platform.startsWith('win')) return fs.existsSync(candidate);
      const normalizedCandidate = path.win32.normalize(String(candidate || ''));
      if (normalizedCandidate === path.win32.normalize(npmCliPath)) {
        return fs.existsSync(npmCliPath);
      }
      if (normalizedCandidate === path.win32.normalize(npxCliPath)) {
        return fs.existsSync(npxCliPath);
      }
      return fs.existsSync(candidate);
    },
  });
  const spawnOptions = {
    env,
    stdio: 'inherit',
    cwd: repoRoot,
    timeout: resolveStrictStepTimeoutMs(label, env),
  };
  const result = spawnSync(resolved.cmd, resolved.args, spawnOptions);
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(`${label} timed out after ${spawnOptions.timeout}ms`);
    }
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`${label} terminated with signal ${result.signal}`);
  }
  if (result.status !== 0) {
    const code = typeof result.status === 'number' ? result.status : 1;
    throw new Error(`${label} failed with exit code ${code}`);
  }
}

async function runTrackedStep(summary, label, work, options = {}) {
  const successMeta = options.successMeta && typeof options.successMeta === 'object' ? options.successMeta : null;
  try {
    const result = await Promise.resolve().then(work);
    summary.steps.push({
      label,
      status: 'passed',
      ...(successMeta || {}),
    });
    return result;
  } catch (error) {
    summary.steps.push({
      label,
      status: 'failed',
      error: String(error?.message || error),
    });
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.strictStep = label;
    throw wrapped;
  }
}

function removeCoverageSummaryIfExists() {
  if (fs.existsSync(coverageSummaryPath)) {
    fs.rmSync(coverageSummaryPath, { force: true });
  }
}

function readCoverageSummary() {
  if (!fs.existsSync(coverageSummaryPath)) {
    throw new Error(`Missing coverage summary: ${coverageSummaryPath}`);
  }
  return JSON.parse(fs.readFileSync(coverageSummaryPath, 'utf8'));
}

function findCoverageEntry(summary, filePath) {
  const exact = summary[filePath];
  if (exact) return exact;

  const normalizedTarget = String(filePath || '').replace(/\\/g, '/');
  const keys = Object.keys(summary || {});
  const bySuffix = keys.find((key) => String(key || '').replace(/\\/g, '/').endsWith(normalizedTarget));
  if (bySuffix) return summary[bySuffix];

  return null;
}

function enforceCoverageThresholds(summary) {
  const failures = [];

  for (const target of COVERAGE_TARGETS) {
    const entry = findCoverageEntry(summary, target.file);
    if (!entry) {
      failures.push(`${target.file}: coverage entry missing`);
      continue;
    }

    const linesPct = Number(entry?.lines?.pct || 0);
    const branchesPct = Number(entry?.branches?.pct || 0);
    if (linesPct < target.minLines) {
      failures.push(`${target.file}: line coverage ${linesPct.toFixed(2)}% < ${target.minLines}%`);
    }
    if (branchesPct < target.minBranches) {
      failures.push(
        `${target.file}: branch coverage ${branchesPct.toFixed(2)}% < ${target.minBranches}%`,
      );
    }
  }

  if (failures.length) {
    throw new Error(`Coverage thresholds failed:\n- ${failures.join('\n- ')}`);
  }
}

async function ensureMobileRuntimeReady(env) {
  console.log('[verify:mobile:fieldops:strict] db:bootstrap');
  const bootstrapMode = resolveBootstrapMode(env);
  const bootstrapEnv = buildMobileBootstrapEnv(env, { bootstrapMode });
  const preflightOk = isTruthy(env.SHARED_LANE_PREFLIGHT_OK);
  const dbProbeOk = isTruthy(env.SHARED_LANE_DB_PROBE_OK);
  const selectedCandidateName = String(
    env.SHARED_LANE_DB_PROBE_SELECTED_DSN_NAME || env.DB_SMOKE_SELECTED_DSN_NAME || '',
  ).trim();

  if (bootstrapMode === 'shared-strict' && preflightOk && dbProbeOk && selectedCandidateName) {
    console.log(
      `[verify:mobile:fieldops:strict] db:bootstrap candidate=${selectedCandidateName} bootstrapped=false reason=shared_lane_preflight_reused`,
    );
    return;
  }

  const { selectedCandidateName: bootstrappedCandidateName, bootstrapped, bootstrapReason } =
    await ensureCloudDbBootstrap({
      env: bootstrapEnv,
      logger: console,
      repoRoot,
    });

  console.log(
    `[verify:mobile:fieldops:strict] db:bootstrap candidate=${bootstrappedCandidateName || '<none>'} bootstrapped=${bootstrapped ? 'true' : 'false'} reason=${bootstrapReason || '<none>'}`,
  );
}

function buildMobileBootstrapEnv(env = process.env, options = {}) {
  const sourceEnv = env && typeof env === 'object' ? env : process.env;
  const bootstrapMode = String(options.bootstrapMode || '').trim().toLowerCase();
  const explicitMaxWaitMs = String(sourceEnv.DB_SMOKE_MAX_WAIT_MS || '').trim();
  if (explicitMaxWaitMs) {
    return sourceEnv;
  }

  const envFile = String(sourceEnv.ENV_FILE || '').trim().replace(/\\/g, '/').toLowerCase();
  const usesLocalEnvFile =
    envFile.endsWith('/config/env/.env.local') || envFile === 'config/env/.env.local';
  if (bootstrapMode !== 'ephemeral' && !usesLocalEnvFile) {
    return sourceEnv;
  }

  return {
    ...sourceEnv,
    DB_SMOKE_MAX_WAIT_MS: String(DEFAULT_LOCAL_DB_SMOKE_MAX_WAIT_MS),
  };
}

function applyLocalCiFieldopsBuildEnvDefaults(env = process.env) {
  const sourceEnv = env && typeof env === 'object' ? env : process.env;
  const profile = String(sourceEnv.FIELDOPS_STORE_PREFLIGHT_PROFILE || '').trim().toLowerCase();
  if (!['ci', 'convergence'].includes(profile) || isTruthy(sourceEnv.GITHUB_ACTIONS)) {
    return sourceEnv;
  }

  const nextEnv = { ...sourceEnv };
  for (const [key, value] of Object.entries(LOCAL_CI_FIELDOPS_BUILD_ENV_DEFAULTS)) {
    if (String(nextEnv[key] || '').trim()) continue;
    nextEnv[key] = value;
  }
  return nextEnv;
}

async function captureNativeScreenshotEvidence(env) {
  if (!isTruthy(env.FIELDOPS_CAPTURE_NATIVE_SCREENSHOTS)) {
    return { captured: false, outputDir: null, manifestPath: null };
  }

  const outputDir = resolveNativeScreenshotOutputDir(env);
  const manifestPath = path.join(outputDir, 'manifest.json');
  const androidSerial = String(env.FIELDOPS_NATIVE_SCREENSHOT_ANDROID_SERIAL || '').trim();
  const iosUdid = String(env.FIELDOPS_NATIVE_SCREENSHOT_IOS_UDID || '').trim();
  const host = String(env.FIELDOPS_NATIVE_SCREENSHOT_HOST || LOOPBACK_HOST).trim() || LOOPBACK_HOST;
  const port = String(env.FIELDOPS_NATIVE_SCREENSHOT_PORT || '4179').trim() || '4179';
  const launchWaitMs = String(env.FIELDOPS_NATIVE_SCREENSHOT_LAUNCH_WAIT_MS || '2000').trim();
  const renderWaitMs = String(env.FIELDOPS_NATIVE_SCREENSHOT_RENDER_WAIT_MS || '250').trim();

  console.log(
    `[verify:mobile:fieldops:strict] fieldops native screenshots output=${outputDir} manifest=${manifestPath}`,
  );

  const captureArgs = [
    'run',
    'fieldops:screenshots:native-runtime',
    '--',
    '--require-native-app',
    '--output-dir',
    outputDir,
    '--source-dir',
    NATIVE_SCREENSHOT_SOURCE_DIR,
    '--host',
    host,
    '--port',
    port,
    '--launch-wait-ms',
    launchWaitMs,
    '--render-wait-ms',
    renderWaitMs,
  ];
  if (androidSerial) {
    captureArgs.push('--android-serial', androidSerial);
  }
  if (iosUdid) {
    captureArgs.push('--ios-udid', iosUdid);
  }

  runStep('fieldops:screenshots:native-runtime', npmCmd, captureArgs, env);
  return { captured: true, outputDir, manifestPath };
}

function resolveNativeScreenshotManifestFromReport(env) {
  const explicit = String(env.FIELDOPS_NATIVE_SCREENSHOT_MANIFEST_PATH || '').trim();
  if (explicit) {
    return path.resolve(repoRoot, explicit);
  }
  return null;
}

function requiresExistingNativeManifestAdmission(env, selectedPhases = resolveStrictPhases(env)) {
  return selectedPhases.has('public')
    && !isTruthy(env.FIELDOPS_VERIFY_SKIP_STORE_PREFLIGHT)
    && !isTruthy(env.FIELDOPS_CAPTURE_NATIVE_SCREENSHOTS)
    && String(env.FIELDOPS_STORE_PREFLIGHT_PROFILE || '').trim().toLowerCase() !== 'convergence';
}

function admitExistingNativeScreenshotManifest(env) {
  const admission = evaluateNativeScreenshotManifest({
    repoRoot,
    env,
    profile: String(env.FIELDOPS_STORE_PREFLIGHT_PROFILE || '').trim().toLowerCase(),
    manifestPath: String(env.FIELDOPS_NATIVE_SCREENSHOT_MANIFEST_PATH || '').trim(),
  });
  if (!admission.summary.pass) {
    const failures = admission.checks
      .filter((check) => check.required && !check.pass)
      .map((check) => check.name);
    throw new Error(`Existing native screenshot manifest admission failed: ${failures.join(', ')}`);
  }
  return {
    manifest_path: admission.manifestPath,
    profile: admission.profile,
    checks: admission.summary.checks,
  };
}

async function main() {
  const validatedEnvFile = validateExplicitEnvFileBeforeLoad(process.env);
  try { loadEnv(); } catch { /* DB phase reports concrete runtime failures. */ }
  const env = applyLocalCiFieldopsBuildEnvDefaults({
    ...process.env,
    STRICT_CORE_ENV: 'true',
    DEMO_ACCOUNTS_PROVISION_GUARD: String(process.env.DEMO_ACCOUNTS_PROVISION_GUARD || 'enabled').trim(),
  });
  removeExplicitEnvFileAfterLoad(env, validatedEnvFile);
  const selectedPhases = resolveStrictPhases(env);
  const publicEnv = buildPublicChildEnv(env);
  const summary = createStrictSummary(env);
  summary.selected_phases = [...selectedPhases];
  const summaryPath = String(env.MOBILE_STRICT_SUMMARY_OUT || '').trim();

  try {
    validateFieldopsStorePreflightProfile(
      env.FIELDOPS_STORE_PREFLIGHT_PROFILE,
      env,
    );
    if (requiresExistingNativeManifestAdmission(publicEnv, selectedPhases)) {
      await runTrackedStep(summary, 'fieldops:native-manifest:early-admission', () =>
        admitExistingNativeScreenshotManifest(publicEnv));
    }

    if (selectedPhases.has('public')) {
      await runTrackedStep(summary, 'fieldops:deps:check', () =>
        runStep('fieldops:deps:check', npmCmd, ['run', 'fieldops:deps:check'], publicEnv));
      await runTrackedStep(summary, 'typecheck:fieldops', () =>
        runStep('typecheck:fieldops', npmCmd, ['run', 'typecheck:fieldops'], publicEnv));
      await runTrackedStep(summary, 'unit-test-coverage', () => {
        removeCoverageSummaryIfExists();
        const unitEnv = buildPublicChildEnv(publicEnv, { NODE_OPTIONS: '--experimental-vm-modules' });
        runStep('test:unit fieldops critical modules (coverage)', npxCmd, [
          '--no-install', 'jest', '--config', 'config/tooling/jest.config.unit.js', '--runInBand',
          '--reporters=default', '--coverage', '--coverageReporters=json-summary',
          '--coverageReporters=text-summary', '--coverageThreshold={"global":{"lines":0}}',
          ...COVERAGE_TARGETS.map(({ file }) => `--collectCoverageFrom=${file}`), ...UNIT_TEST_FILES,
        ], unitEnv);
        enforceCoverageThresholds(readCoverageSummary());
      });
    }

    if (selectedPhases.has('db')) {
      await runTrackedStep(summary, 'db-bootstrap', () => ensureMobileRuntimeReady(env));
      await runTrackedStep(summary, 'test:integration fieldops driver go-live', () =>
        runStep('test:integration fieldops driver go-live', process.execPath,
          buildFieldopsDriverGoLiveIntegrationArgs(), buildFieldopsDriverGoLiveIntegrationEnv(env)));
      await runTrackedStep(summary, 'test:pgtap fieldops mobile pack', () =>
        runStep('test:pgtap fieldops mobile pack', npmCmd, ['run', 'test:pgtap'],
          buildDbPgtapEnv(env, { PGTAP_ONLY_FILES: FIELDOPS_PGTAP_FILES.join(',') })));

      if (!isTruthy(env.FIELDOPS_VERIFY_SKIP_E2E)) {
        await runTrackedStep(summary, 'test:e2e:fieldops', async () => {
          const port = await resolveFieldopsE2ePort(env, { logger: console });
          const e2eEnv = buildFieldopsE2eEnv(env, {
            FIELDOPS_E2E_PORT: String(port),
            ...(isTruthy(env.FIELDOPS_E2E_REUSE_SERVER) ? {} : { CI: env.CI || 'true' }),
          });
          ensurePlaywrightChromium({ sourceEnv: publicEnv, logger: console });
          if (publicEnv.PLAYWRIGHT_BROWSERS_PATH) {
            e2eEnv.PLAYWRIGHT_BROWSERS_PATH = publicEnv.PLAYWRIGHT_BROWSERS_PATH;
          }
          const grep = String(env.FIELDOPS_E2E_GREP || '').trim();
          runStep('test:e2e:fieldops', npmCmd,
            ['run', 'test:e2e:fieldops', '--', 'tests/fieldops-e2e/fieldops-driver-smoke.spec.ts',
              ...(grep ? ['--grep', grep] : [])],
            e2eEnv);
        });
      } else {
        summary.e2e_skipped = true;
        summary.steps.push({ label: 'test:e2e:fieldops', status: 'skipped', reason: 'FIELDOPS_VERIFY_SKIP_E2E=1' });
      }
    }

    if (selectedPhases.has('public')) {
      const nativeEvidence = await runTrackedStep(summary, 'fieldops:screenshots:native-runtime',
        () => captureNativeScreenshotEvidence(publicEnv),
        { successMeta: { enabled: isTruthy(publicEnv.FIELDOPS_CAPTURE_NATIVE_SCREENSHOTS) } });
      if (nativeEvidence?.captured) {
        publicEnv.FIELDOPS_NATIVE_SCREENSHOT_MANIFEST_PATH = nativeEvidence.manifestPath;
        summary.native_screenshot_manifest_path = nativeEvidence.manifestPath;
      }
      if (isTruthy(publicEnv.FIELDOPS_VERIFY_SKIP_STORE_PREFLIGHT)) {
        summary.store_preflight_skipped = true;
        summary.steps.push({ label: 'fieldops:store:preflight', status: 'skipped', reason: 'FIELDOPS_VERIFY_SKIP_STORE_PREFLIGHT=1' });
      } else {
        const output = String(publicEnv.MOBILE_PREFLIGHT_REPORT_PATH || '').trim();
        const profile = String(publicEnv.FIELDOPS_STORE_PREFLIGHT_PROFILE || '').trim().toLowerCase();
        const manifest = resolveNativeScreenshotManifestFromReport(publicEnv);
        await runTrackedStep(summary, 'fieldops:store:preflight', () =>
          runStep('fieldops:store:preflight', npmCmd, ['run', 'fieldops:store:preflight', '--',
            ...(manifest ? ['--native-manifest', manifest] : []), ...(output ? ['--output', output] : []),
            ...(profile ? ['--profile', profile] : [])], publicEnv));
      }
    }
    summary.status = 'passed';
    console.log('[verify:mobile:fieldops:strict] all checks passed.');
  } catch (error) {
    summary.status = 'failed';
    summary.failed_step = String(error?.strictStep || '').trim();
    summary.failure_class = classifyStrictFailureClass(summary.failed_step);
    writeStrictSummary(summaryPath, summary);
    throw error;
  }
  writeStrictSummary(summaryPath, summary);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  COVERAGE_TARGETS,
  UNIT_TEST_FILES,
  FIELDOPS_PGTAP_FILES,
  main,
  parsePositivePort,
  canBindPort,
  reserveEphemeralPort,
  resolveFieldopsE2ePort,
  classifyStrictFailureClass,
  createStrictSummary,
  writeStrictSummary,
  buildMobileBootstrapEnv,
  buildStaticChildEnv,
  buildPublicChildEnv,
  buildDbIntegrationEnv,
  buildFieldopsE2eEnv,
  buildDbPgtapEnv,
  resolveStrictPhases,
  validateExplicitEnvFileBeforeLoad,
  removeExplicitEnvFileAfterLoad,
  resolveStrictStepTimeoutMs,
  buildFieldopsDriverGoLiveIntegrationArgs,
  buildFieldopsDriverGoLiveIntegrationEnv,
  applyLocalCiFieldopsBuildEnvDefaults,
  normalizeWindowsExecPath,
  resolveBundledWindowsNpmCli,
  resolveBundledWindowsNpxCli,
  resolveStepCommand,
  resolveNativeScreenshotOutputDir,
  requiresExistingNativeManifestAdmission,
  admitExistingNativeScreenshotManifest,
  ensureMobileRuntimeReady,
  captureNativeScreenshotEvidence,
  enforceCoverageThresholds,
  findCoverageEntry,
};
