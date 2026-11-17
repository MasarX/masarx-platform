#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');
const { ensurePlaywrightChromium } = require('./ci/install-playwright-chromium');
const {
  ensureCloudDbBootstrap,
  resolveBootstrapMode,
} = require('./cloud-db-bootstrap');
const { loadEnv } = require('../utils/load-env');

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
const NATIVE_SCREENSHOT_SOURCE_DIR = path.join(
  repoRoot,
  'docs',
  'product',
  'examples',
  'mobile-field-ops-ui',
);

const COVERAGE_TARGETS = [
  { file: 'apps/fieldops/src/mobile-shell-access.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-memory-store.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-background-location.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-telemetry.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-crash-reporting.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-sync-policy.ts', minLines: 90, minBranches: 80 },
  { file: 'apps/fieldops/src/mobile-app-integrity.ts', minLines: 90, minBranches: 80 },
];

const UNIT_TEST_FILES = [
  'tests/unit/fieldops/mobile-shell-access.test.ts',
  'tests/unit/fieldops/mobile-memory-store.test.ts',
  'tests/unit/fieldops/mobile-background-location.test.ts',
  'tests/unit/fieldops/mobile-telemetry.test.ts',
  'tests/unit/fieldops/mobile-crash-reporting.test.ts',
  'tests/unit/fieldops/mobile-sync-policy.test.ts',
  'tests/unit/mobile-app-integrity.test.ts',
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
  return {
    generated_at: new Date().toISOString(),
    status: 'passed',
    failed_step: '',
    failure_class: '',
    store_preflight_profile: String(env.FIELDOPS_STORE_PREFLIGHT_PROFILE || '').trim().toLowerCase(),
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
  return {
    ...env,
    // Assertions are complete when Jest finishes; this prevents release proof from
    // hanging on remote Supabase/Postgres socket teardown after successful tests.
    INTEGRATION_JEST_FORCE_EXIT: 'true',
  };
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
    formatDateYmd(now),
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
  if (profile !== 'ci' || isTruthy(sourceEnv.CI) || isTruthy(sourceEnv.GITHUB_ACTIONS)) {
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

async function main() {
  try {
    loadEnv();
  } catch {
    // DB bootstrap below reports the concrete missing/invalid runtime settings.
  }
  const env = applyLocalCiFieldopsBuildEnvDefaults({
    ...process.env,
    STRICT_CORE_ENV: 'true',
    DEMO_ACCOUNTS_PROVISION_GUARD: String(process.env.DEMO_ACCOUNTS_PROVISION_GUARD || 'enabled').trim(),
  });
  const summary = createStrictSummary(env);
  const summaryPath = String(env.MOBILE_STRICT_SUMMARY_OUT || '').trim();

  try {
    await runTrackedStep(summary, 'typecheck:fieldops', () =>
      runStep('typecheck:fieldops', npmCmd, ['run', 'typecheck:fieldops'], env),
    );

    await runTrackedStep(summary, 'unit-test-coverage', () => {
      removeCoverageSummaryIfExists();
      const unitEnv = {
        ...env,
        NODE_OPTIONS: [String(env.NODE_OPTIONS || '').trim(), '--experimental-vm-modules']
          .filter(Boolean)
          .join(' '),
      };
      runStep(
        'test:unit fieldops critical modules (coverage)',
        npxCmd,
        [
          '--no-install',
          'jest',
          '--config',
          'config/tooling/jest.config.unit.js',
          '--runInBand',
          '--coverage',
          '--coverageReporters=json-summary',
          '--coverageReporters=text-summary',
          '--coverageThreshold={"global":{"lines":0}}',
          '--collectCoverageFrom=apps/fieldops/src/mobile-shell-access.ts',
          '--collectCoverageFrom=apps/fieldops/src/mobile-memory-store.ts',
          '--collectCoverageFrom=apps/fieldops/src/mobile-background-location.ts',
          '--collectCoverageFrom=apps/fieldops/src/mobile-telemetry.ts',
          '--collectCoverageFrom=apps/fieldops/src/mobile-crash-reporting.ts',
          '--collectCoverageFrom=apps/fieldops/src/mobile-sync-policy.ts',
          '--collectCoverageFrom=apps/fieldops/src/mobile-app-integrity.ts',
          ...UNIT_TEST_FILES,
        ],
        unitEnv,
      );

      const coverageSummary = readCoverageSummary();
      enforceCoverageThresholds(coverageSummary);
      console.log('[verify:mobile:fieldops:strict] coverage thresholds passed.');
    });

    await runTrackedStep(summary, 'db-bootstrap', () => ensureMobileRuntimeReady(env));

    await runTrackedStep(summary, 'test:integration fieldops driver go-live', () =>
      runStep(
        'test:integration fieldops driver go-live',
        process.execPath,
        buildFieldopsDriverGoLiveIntegrationArgs(),
        buildFieldopsDriverGoLiveIntegrationEnv(env),
      ),
    );

    await runTrackedStep(summary, 'test:pgtap fieldops mobile pack', () =>
      runStep('test:pgtap fieldops mobile pack', npmCmd, ['run', 'test:pgtap'], {
        ...env,
        PGTAP_ONLY_FILES: [
          '0zi_fieldops_mobile_hardening_v1.sql',
          '0zj_fieldops_mobile_sync_artifact_exception_v1.sql',
        ].join(','),
      }),
    );

    if (!isTruthy(env.FIELDOPS_VERIFY_SKIP_E2E)) {
      await runTrackedStep(summary, 'test:e2e:fieldops', async () => {
        const fieldopsE2ePort = await resolveFieldopsE2ePort(env, { logger: console });
        ensurePlaywrightChromium({ sourceEnv: env, logger: console });
        const e2eEnv = {
          ...env,
          FIELDOPS_E2E_PORT: String(fieldopsE2ePort),
          ...(isTruthy(env.FIELDOPS_E2E_REUSE_SERVER)
            ? {}
            : {
                CI: env.CI || 'true',
              }),
        };
        runStep(
          'test:e2e:fieldops',
          npmCmd,
          ['run', 'test:e2e:fieldops', '--', 'tests/fieldops-e2e/fieldops-driver-smoke.spec.ts'],
          e2eEnv,
        );
      });
    } else {
      summary.e2e_skipped = true;
      summary.steps.push({
        label: 'test:e2e:fieldops',
        status: 'skipped',
        reason: 'FIELDOPS_VERIFY_SKIP_E2E=1',
      });
    }

    const nativeEvidence = await runTrackedStep(
      summary,
      'fieldops:screenshots:native-runtime',
      () => captureNativeScreenshotEvidence(env),
      { successMeta: { enabled: isTruthy(env.FIELDOPS_CAPTURE_NATIVE_SCREENSHOTS) } },
    );
    if (nativeEvidence?.captured) {
      env.FIELDOPS_NATIVE_SCREENSHOT_MANIFEST_PATH = nativeEvidence.manifestPath;
      summary.native_screenshot_manifest_path = nativeEvidence.manifestPath;
    }

    if (isTruthy(env.FIELDOPS_VERIFY_SKIP_STORE_PREFLIGHT)) {
      summary.store_preflight_skipped = true;
      summary.steps.push({
        label: 'fieldops:store:preflight',
        status: 'skipped',
        reason: 'FIELDOPS_VERIFY_SKIP_STORE_PREFLIGHT=1',
      });
      console.log(
        '[verify:mobile:fieldops:strict] fieldops:store:preflight skipped (FIELDOPS_VERIFY_SKIP_STORE_PREFLIGHT=1).',
      );
    } else {
      const preflightOutputPath = String(env.MOBILE_PREFLIGHT_REPORT_PATH || '').trim();
      const preflightProfile = String(env.FIELDOPS_STORE_PREFLIGHT_PROFILE || '').trim().toLowerCase();
      const preflightNativeManifest = resolveNativeScreenshotManifestFromReport(env);
      await runTrackedStep(summary, 'fieldops:store:preflight', () =>
        runStep(
          'fieldops:store:preflight',
          npmCmd,
          [
            'run',
            'fieldops:store:preflight',
            '--',
            ...(preflightNativeManifest ? ['--native-manifest', preflightNativeManifest] : []),
            ...(preflightOutputPath ? ['--output', preflightOutputPath] : []),
            ...(preflightProfile ? ['--profile', preflightProfile] : []),
          ],
          env,
        ),
      );
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
  main,
  parsePositivePort,
  canBindPort,
  reserveEphemeralPort,
  resolveFieldopsE2ePort,
  classifyStrictFailureClass,
  createStrictSummary,
  writeStrictSummary,
  buildMobileBootstrapEnv,
  resolveStrictStepTimeoutMs,
  buildFieldopsDriverGoLiveIntegrationArgs,
  buildFieldopsDriverGoLiveIntegrationEnv,
  applyLocalCiFieldopsBuildEnvDefaults,
  normalizeWindowsExecPath,
  resolveBundledWindowsNpmCli,
  resolveBundledWindowsNpxCli,
  resolveStepCommand,
  resolveNativeScreenshotOutputDir,
  ensureMobileRuntimeReady,
  captureNativeScreenshotEvidence,
  enforceCoverageThresholds,
  findCoverageEntry,
};
