#!/usr/bin/env node
/**
 * Cloud integration test runner (Jest)
 *
 * Centralizes CI-friendly integration test execution so workflows and verify
 * pipelines can tune parallelism via env without duplicating CLI flags.
 */
/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadEnv } = require('../utils/load-env');

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function firstNonEmpty(values) {
  for (const value of values || []) {
    if (String(value || '').trim()) return String(value).trim();
  }
  return '';
}

function resolveIntegrationEdgeAuthAliases(env = process.env) {
  const nextEnv = { ...env };
  const sharedEdgeToken = firstNonEmpty([
    nextEnv.EDGE_TASK_TOKEN,
    nextEnv.API_CALLER_SHARED_SECRET,
    nextEnv.API_CALLER_DB_JWT,
  ]);

  if (sharedEdgeToken && !firstNonEmpty([nextEnv.EDGE_TASK_TOKEN])) {
    nextEnv.EDGE_TASK_TOKEN = sharedEdgeToken;
  }

  return nextEnv;
}

const EDGE_DEPENDENT_IGNORE_PATTERNS = [
  'tests/integration/geocoding\\.webhook-receiver-edge\\.test\\.js',
  'tests/integration/label/',
  'tests/integration/label-designer/',
  'tests/integration/label-renderer-edge\\.test\\.js',
  'tests/integration/observability/label-renderer-observability\\.test\\.js',
  'tests/integration/workflows/labels-print-webhook-edge\\.test\\.js',
  'tests/integration/edge/',
];

function resolveJestBin() {
  try {
    return require.resolve('jest/bin/jest');
  } catch (e) {
    throw new Error('Unable to resolve jest binary. Run `npm ci` first.');
  }
}

function resolveCpuCount(runtime = {}) {
  const provided = Number(runtime.cpuCount);
  if (Number.isFinite(provided) && provided > 0) return Math.floor(provided);
  if (typeof os.availableParallelism === 'function') {
    const parallel = Number(os.availableParallelism());
    if (Number.isFinite(parallel) && parallel > 0) return Math.floor(parallel);
  }
  const cpus = Array.isArray(os.cpus()) ? os.cpus().length : 0;
  return Number.isFinite(cpus) && cpus > 0 ? cpus : 0;
}

function resolveAutoMaxWorkers(runtime = {}) {
  const cpuCount = resolveCpuCount(runtime);
  if (!cpuCount) return '';
  const workers = Math.max(Math.min(2, cpuCount), Math.min(4, Math.floor(cpuCount * 0.75)));
  return String(workers);
}

function resolveIntegrationJestMaxWorkers(env = process.env, runtime = {}) {
  const raw = String(env.INTEGRATION_JEST_MAX_WORKERS || '').trim();
  if (!raw) return '';
  if (/^auto$/i.test(raw)) {
    return resolveAutoMaxWorkers(runtime);
  }
  return raw;
}

function resolveIntegrationRetryCount(env = process.env) {
  const raw = String(env.INTEGRATION_JEST_RETRY_COUNT || '').trim();
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return parsed;
}

function resolveIntegrationRetryFastFailMs(env = process.env) {
  const raw = String(env.INTEGRATION_JEST_RETRY_FAST_FAIL_MS || '').trim();
  if (!raw) return 300000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 300000;
  return parsed;
}

function runNodeScript(scriptPath, { env, label }) {
  const args = [scriptPath];
  const res = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  if (res.error) {
    throw new Error(`${label} failed to start: ${res.error.message}`);
  }
  const status = typeof res.status === 'number' ? res.status : 1;
  if (status !== 0) {
    throw new Error(`${label} failed with exit code ${status}`);
  }
}

function shouldRetryAfterFailure({ status, attempt, maxAttempts, durationMs, fastFailMs }) {
  if (status === 0) return false;
  if (attempt >= maxAttempts) return false;
  return durationMs <= fastFailMs;
}

function resolveEdgeDependentIgnorePatterns(env = process.env) {
  const edgeDeploySkipped = isTruthy(env.EDGE_DEPLOY_SKIP) || isTruthy(env.VERIFY_SKIP_EDGE_DEPLOY);
  if (!edgeDeploySkipped) return [];
  if (isTruthy(env.INTEGRATION_INCLUDE_EDGE_DEPENDENT)) return [];
  return EDGE_DEPENDENT_IGNORE_PATTERNS;
}

function resolveTestPathIgnorePatterns(env = process.env) {
  const configuredPatterns = String(env.INTEGRATION_JEST_TEST_PATH_IGNORE || '')
    .trim()
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const defaults = resolveEdgeDependentIgnorePatterns(env);
  return Array.from(new Set([...configuredPatterns, ...defaults]));
}

function normalizePathSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

function parseRunTestsByPathArgs(argv = []) {
  const list = [];
  const args = Array.isArray(argv) ? argv : [];
  let capture = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '').trim();
    if (!arg) continue;
    if (arg === '--runTestsByPath') {
      capture = true;
      continue;
    }
    if (capture && arg.startsWith('--')) {
      capture = false;
      continue;
    }
    if (capture) {
      list.push(arg);
    }
  }
  return list;
}

function extractTrueEnvFlagsFromTestFile(filePath) {
  const out = new Set();
  const absolute = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolute)) {
    return out;
  }
  const body = fs.readFileSync(absolute, 'utf8');
  const pattern = /process\.env\.([A-Z0-9_]+)\s*===\s*['"]true['"]/g;
  for (const match of body.matchAll(pattern)) {
    const key = String(match[1] || '').trim();
    if (!key) continue;
    // Restrict auto-enable to explicit runtime toggle names.
    if (!/^RUN_[A-Z0-9_]+$/.test(key)) continue;
    out.add(key);
  }
  return out;
}

function resolveRequiredTestToggles({ argv = [], env = process.env } = {}) {
  const selectedPaths = parseRunTestsByPathArgs(argv)
    .map((entry) => normalizePathSlashes(entry))
    .filter((entry) => /^tests\/integration\/.*\.(test|spec)\.[jt]sx?$/.test(entry));
  if (selectedPaths.length === 0) {
    return {};
  }

  const required = new Set();
  for (const relPath of selectedPaths) {
    const flags = extractTrueEnvFlagsFromTestFile(relPath);
    for (const flag of flags) required.add(flag);
  }

  const out = {};
  for (const flag of required) {
    if (!isTruthy(env[flag])) {
      out[flag] = 'true';
    }
  }
  return out;
}

function buildJestArgs({ configPath, env, argv }) {
  const args = [];
  const maxWorkers = resolveIntegrationJestMaxWorkers(env);
  const explicitRunInBandRaw = env.INTEGRATION_JEST_RUN_IN_BAND;
  const explicitRunInBand = explicitRunInBandRaw == null ? null : isTruthy(explicitRunInBandRaw);
  const runInBand = explicitRunInBand != null ? explicitRunInBand : !maxWorkers;

  args.push('--config', configPath);
  if (runInBand) {
    args.push('--runInBand');
  } else if (maxWorkers) {
    args.push('--maxWorkers', maxWorkers);
  }

  if (isTruthy(env.INTEGRATION_JEST_FORCE_EXIT)) {
    args.push('--forceExit');
  }

  if (isTruthy(env.INTEGRATION_JEST_DETECT_OPEN_HANDLES)) {
    args.push('--detectOpenHandles');
  }

  const patterns = resolveTestPathIgnorePatterns(env);
  for (const p of patterns) {
    args.push('--testPathIgnorePatterns', p);
  }

  const passThrough = Array.isArray(argv) ? argv : [];
  if (passThrough.length) {
    args.push(...passThrough);
  }

  return args;
}

function main() {
  const callerRunFlags = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^RUN_[A-Z0-9_]+$/.test(key)),
  );
  loadEnv();
  const runtimeEnv = { ...resolveIntegrationEdgeAuthAliases(process.env), ...callerRunFlags };
  const extraArgs = process.argv.slice(2);
  const requiredToggles = resolveRequiredTestToggles({ argv: extraArgs, env: runtimeEnv });
  // Child scripts load the file again, so keep the runner's resolved values authoritative.
  const executionEnv = { ...runtimeEnv, ...requiredToggles, ENV_FILE_OVERRIDE: '0' };
  if (Object.keys(requiredToggles).length > 0) {
    console.log(
      `[integration] Auto-enabled test toggles for selected paths: ${Object.keys(requiredToggles)
        .sort()
        .join(', ')}`,
    );
  }
  if (!isTruthy(executionEnv.INTEGRATION_SKIP_EDGE_SHARED_SYNC)) {
    runNodeScript(path.join('scripts', 'edge', 'sync-shared.js'), {
      env: executionEnv,
      label: 'edge:sync-shared',
    });
    runNodeScript(path.join('scripts', 'edge', 'verify-shared.js'), {
      env: executionEnv,
      label: 'edge:verify-shared',
    });
  } else {
    runNodeScript(path.join('scripts', 'edge', 'verify-npm-import-lock.js'), {
      env: executionEnv,
      label: 'edge:verify-npm-import-lock',
    });
  }

  if (!isTruthy(runtimeEnv.INTEGRATION_SKIP_FIXTURE_BOOTSTRAP)) {
    runNodeScript(path.join('scripts', 'tests', 'bootstrap', 'seed-integration-fixtures.js'), {
      env: executionEnv,
      label: 'integration-fixture-bootstrap',
    });
  }

  const configPath = path.join('config', 'tooling', 'jest.config.js');
  const jestBin = resolveJestBin();
  const retryCount = resolveIntegrationRetryCount(executionEnv);
  const fastFailMs = resolveIntegrationRetryFastFailMs(executionEnv);
  const maxAttempts = retryCount + 1;

  const args = ['--experimental-vm-modules', jestBin, ...buildJestArgs({ configPath, env: executionEnv, argv: extraArgs })];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const res = spawnSync(process.execPath, args, { stdio: 'inherit', env: executionEnv });
    const durationMs = Date.now() - startedAt;

    if (res.error) {
      console.error(`[integration] Failed to run jest: ${res.error.message}`);
      process.exit(1);
    }

    const status = typeof res.status === 'number' ? res.status : 1;
    if (status === 0) {
      process.exit(0);
    }

    if (!shouldRetryAfterFailure({ status, attempt, maxAttempts, durationMs, fastFailMs })) {
      process.exit(status);
    }

    console.warn(
      `[integration] Jest failed quickly after ${durationMs}ms (attempt ${attempt}/${maxAttempts}). Retrying for transient network stability...`,
    );
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[integration] ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildJestArgs,
  resolveEdgeDependentIgnorePatterns,
  resolveAutoMaxWorkers,
  resolveIntegrationJestMaxWorkers,
  resolveIntegrationRetryCount,
  resolveIntegrationRetryFastFailMs,
  resolveIntegrationEdgeAuthAliases,
  normalizePathSlashes,
  parseRunTestsByPathArgs,
  extractTrueEnvFlagsFromTestFile,
  resolveRequiredTestToggles,
  runNodeScript,
  resolveJestBin,
  resolveTestPathIgnorePatterns,
  shouldRetryAfterFailure,
};
