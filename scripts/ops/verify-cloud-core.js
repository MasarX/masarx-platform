#!/usr/bin/env node
/**
 * verify-cloud-core.js
 * Canonical CI gate: asserts cloud env, runs lint + migrations + edge deploy + unit + pgTAP (cloud)
 * + integration (cloud) + edge smoke (cloud) + standard load (CI profile).
 *
 * This is the single definition of the core verify pipeline. Workflows should
 * only bootstrap env (checkout, npm ci, bootstrap-env-ci) then call this script;
 * the cloud env guard is run here.
 */
/* eslint-disable no-console */
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { loadEnv } = require('../utils/load-env');
const { upsertEnvFileValues } = require('../utils/env-file');
const { buildQaRunMetadata, createQaLogger } = require('../qa/qa-log');
const { shouldParallelizePgtapIntegration, planPgtapIntegrationSteps } = require('./verify-cloud-core-steps');
const { parsePositiveInt, resolveDsnCandidates, runConnectivitySmoke, shouldUseSsl } = require('./db-connect-smoke');
const { ensureCloudDbBootstrap } = require('./cloud-db-bootstrap');

loadEnv();

const allowExtendedSuites = isTruthy(process.env.VERIFY_CORE_ALLOW_EXTENDED_SUITES);
const forcedCoreToggleDefaults = {
  RUN_LIVE_GEOCODING_TESTS: 'false',
  RUN_LIVE_WEBHOOK_TESTS: 'false',
  RUN_LABELS_WEBHOOK_TESTS: 'false',
  RUN_EDGE_E2E: 'false',
  RUN_RLS_INTEGRATION_TESTS: 'false',
  RUN_MATRIX_E2E: 'false',
  RUN_LIVE_COMMS_TESTS: 'false',
  RUN_LIVE_3PL_TESTS: 'false',
};

const env = {
  ...process.env,
  STRICT_CORE_ENV: 'true',
  DEMO_ACCOUNTS_PROVISION_GUARD: String(process.env.DEMO_ACCOUNTS_PROVISION_GUARD || 'enabled').trim(),
  // Keep core verify deterministic: optional live/extended suites are disabled
  // unless explicitly opted-in for dedicated validation runs.
  ...(allowExtendedSuites ? {} : forcedCoreToggleDefaults),
  // Core verify should exercise real webhook HTTP intake paths by default.
  RUN_WEBHOOK_HTTP_TESTS: process.env.RUN_WEBHOOK_HTTP_TESTS || 'true',
  // Keep pgTAP in batched mode by default for callers that do not set an explicit batch size.
  PGTAP_FILES_PER_SESSION: process.env.PGTAP_FILES_PER_SESSION || '25',
  // CI-friendly load profile (lightweight)
  PARTITION_VUS: process.env.PARTITION_VUS || '2',
  PARTITION_DURATION: process.env.PARTITION_DURATION || '30s',
  PARTITION_P95_MS: process.env.PARTITION_P95_MS || '3000',
};

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

const skipEdgeDeploy = isTruthy(process.env.EDGE_DEPLOY_SKIP) || isTruthy(process.env.VERIFY_SKIP_EDGE_DEPLOY);
const skipEdgeSmoke = skipEdgeDeploy || isTruthy(process.env.VERIFY_SKIP_EDGE_SMOKE);
const skipFrontendChecks = isTruthy(process.env.VERIFY_SKIP_FRONTEND);
const skipDbPush = isTruthy(process.env.VERIFY_SKIP_DB_PUSH);
const skipPgtap = isTruthy(process.env.VERIFY_SKIP_PGTAP);
const skipLoadTests = isTruthy(process.env.VERIFY_SKIP_LOAD_TESTS);

const timingFile = String(process.env.VERIFY_CORE_TIMING_FILE || 'verify-core-timing.json').trim();

const npmCmd = process.platform.startsWith('win') ? 'npm.cmd' : 'npm';

const labelDesignerAppDir = path.join('tooling', 'apps', 'label-designer');
const hasLabelDesignerApp = fs.existsSync(path.join(labelDesignerAppDir, 'package.json'));
const parallelizePgtapIntegration = shouldParallelizePgtapIntegration(process.env, process.platform);
const parallelizeUnitWithIntegration =
  isTruthy(process.env.VERIFY_CORE_PARALLEL_UNIT_WITH_INTEGRATION) &&
  !process.platform.startsWith('win') &&
  skipPgtap;

const unitStep = { cmd: npmCmd, args: ['run', 'test:unit'], label: 'test:unit', logFile: 'unit.log', qaSuiteKey: 'jest:unit' };
const plannedPgtapIntegrationSteps = planPgtapIntegrationSteps({
  npmCmd,
  parallelize: parallelizePgtapIntegration,
  includePgtap: !skipPgtap,
  includeIntegration: true,
});
const plannedCloudTestSteps = (() => {
  if (!parallelizeUnitWithIntegration) {
    return [unitStep, ...plannedPgtapIntegrationSteps];
  }
  const [integrationOnly] = planPgtapIntegrationSteps({
    npmCmd,
    parallelize: false,
    includePgtap: false,
    includeIntegration: true,
  });
  return [
    {
      type: 'parallel',
      label: 'test:unit+integration',
      steps: [unitStep, integrationOnly],
    },
  ];
})();

const steps = [
  { cmd: 'node', args: [path.join('scripts', 'ops', 'assert-cloud-env.js')], label: 'assert-cloud-env' },
  // Ensure the Supabase control-plane API exposure settings match our hardening model.
  // (This is not migration-controlled; it is enforced via the Management API.)
  { cmd: process.execPath, args: [path.join('scripts', 'ops', 'workspace', 'harden-data-api.js')], label: 'harden:data-api' },
  { cmd: npmCmd, args: ['run', 'lint:structure'], label: 'lint:structure' },
  { cmd: npmCmd, args: ['run', 'lint:commands'], label: 'lint:commands' },
  { cmd: process.execPath, args: [path.join('scripts', 'tooling', 'validate-api-ingress-worker.js')], label: 'lint:ingress-worker' },
  { cmd: npmCmd, args: ['run', 'lint:objectives'], label: 'lint:objectives' },
  { cmd: npmCmd, args: ['run', 'typecheck:fieldops'], label: 'typecheck:fieldops', logFile: 'fieldops-typecheck.log' },
  ...(skipFrontendChecks
    ? []
    : [
      { cmd: npmCmd, args: ['run', 'lint:frontend'], label: 'lint:frontend' },
      { cmd: npmCmd, args: ['run', 'typecheck:frontend'], label: 'typecheck:frontend', logFile: 'frontend-typecheck.log' },
    ]),
  // Optional tooling app regression suite (only when present in repo).
  ...(hasLabelDesignerApp
    ? [
      { cmd: npmCmd, args: ['--prefix', labelDesignerAppDir, 'ci'], label: 'label-designer:ci' },
      { cmd: npmCmd, args: ['--prefix', labelDesignerAppDir, 'test'], label: 'label-designer:test', qaSuiteKey: 'label-designer:vitest' },
      { cmd: npmCmd, args: ['--prefix', labelDesignerAppDir, 'run', 'build'], label: 'label-designer:build' },
    ]
    : []),
  // Ensure each edge function has a local `_shared` copy before any tests run.
  // Some integration tests import edge entrypoints directly from the repo, so
  // this must not depend on whether edge deploy is skipped.
  { cmd: npmCmd, args: ['run', 'edge:sync-shared'], label: 'edge:sync-shared' },
  {
    cmd: process.execPath,
    args: [path.join('scripts', 'ops', 'ci', 'migration-fixture-guard.js')],
    label: 'guard:migration-fixtures',
    env: {
      MIGRATION_FIXTURE_GUARD_MODE: 'full',
    },
  },
  skipDbPush
    ? null
    : { cmd: process.execPath, args: [path.join('scripts', 'ops', 'supabase-cli.js'), 'push'], label: 'db:push' },
  // merge_group often sets VERIFY_SKIP_DB_PUSH=1 for speed. When preview-project
  // falls back to project-per-PR mode, the database can be blank; ensure the
  // baseline ladder/SSOT tables exist before any DB-dependent steps.
  { type: 'db_bootstrap', label: 'db:bootstrap' },
  // Shared preview DBs can retain SECURITY DEFINER search_path drift from other
  // runs; repair it deterministically before downstream DB tests assert the guard.
  {
    cmd: process.execPath,
    args: [path.join('scripts', 'ops', 'secdef-search-path-repair.js')],
    label: 'db:secdef-search-path-repair',
  },
  { cmd: npmCmd, args: ['run', 'ensure:storage-buckets'], label: 'ensure:storage-buckets' },
  skipDbPush
    ? null
    : { cmd: process.execPath, args: [path.join('scripts', 'docs', 'generate-public-openapi.js'), '--check'], label: 'docs:openapi:check', logFile: 'openapi.log' },
  skipEdgeDeploy
    ? null
    : {
      cmd: process.execPath,
      args: [path.join('scripts', 'edge', 'deploy-branch.js')],
      label: 'edge:deploy',
      env: {
        EDGE_SKIP_SMOKE: process.env.EDGE_SKIP_SMOKE || '1',
      },
    },
  // Ensure edge dispatch policy is configured for this project before any DB or edge tests run.
  // Derived from SUPABASE_URL (no hardcoding) and wired via settings/SSOT.
  { cmd: npmCmd, args: ['run', 'configure:edge-api-caller'], label: 'configure:edge-api-caller' },
  { cmd: npmCmd, args: ['run', 'validate:configs'], label: 'validate:configs', logFile: 'config-validation.log' },
  { cmd: process.execPath, args: [path.join('scripts', 'tooling', 'run-db-lint.js')], label: 'lint:db' },
  { cmd: npmCmd, args: ['run', 'ensure:label-provider'], label: 'ensure:label-provider' },
  // Stabilize preview DB auth propagation and pin the selected DSN before cloud tests.
  { type: 'db_smoke', label: 'db:connect:smoke' },
  ...plannedCloudTestSteps,
  { cmd: npmCmd, args: ['run', 'test:qa:cases:cloud'], label: 'test:qa:cases', logFile: 'qa-cases.log', qaSuiteKey: 'qa:cases' },
  skipEdgeSmoke
    ? null
    : { cmd: npmCmd, args: ['run', 'test:edge-smoke:cloud'], label: 'test:edge-smoke:cloud', logFile: 'edge.log', qaSuiteKey: 'edge:smoke' },
  skipLoadTests
    ? null
    : {
      cmd: npmCmd,
      args: ['run', 'test:load:cloud'],
      label: 'test:load:cloud',
      logFile: 'load.log',
      qaSuiteKey: 'load',
      env: {
        PARTITION_VUS: env.PARTITION_VUS,
        PARTITION_DURATION: env.PARTITION_DURATION,
        PARTITION_P95_MS: env.PARTITION_P95_MS,
      },
    },
].filter(Boolean);

if (skipEdgeDeploy) {
  console.log('[verify:cloud:core] EDGE_DEPLOY_SKIP=1; skipping edge deploy step.');
}
if (skipEdgeSmoke) {
  console.log('[verify:cloud:core] Edge smoke skipped (edge deploy skipped or VERIFY_SKIP_EDGE_SMOKE=1).');
}
if (skipFrontendChecks) {
  console.log('[verify:cloud:core] VERIFY_SKIP_FRONTEND=1; skipping lint:frontend + typecheck:frontend.');
}
if (skipDbPush) {
  console.log(
    '[verify:cloud:core] VERIFY_SKIP_DB_PUSH=1; skipping explicit db:push step (may bootstrap when required tables are missing).',
  );
}
if (skipPgtap) {
  console.log('[verify:cloud:core] VERIFY_SKIP_PGTAP=1; skipping pgTAP suite (change-aware full gate mode).');
}
if (skipLoadTests) {
  console.log('[verify:cloud:core] VERIFY_SKIP_LOAD_TESTS=1; skipping load tests.');
}
if (!allowExtendedSuites) {
  const overridden = Object.keys(forcedCoreToggleDefaults).filter(
    (key) => String(process.env[key] || '').trim().toLowerCase() === 'true',
  );
  if (overridden.length > 0) {
    console.log(
      `[verify:cloud:core] Forcing optional live/extended suites off for core gate: ${overridden.join(', ')}. Set VERIFY_CORE_ALLOW_EXTENDED_SUITES=1 to opt in.`,
    );
  }
}
if (parallelizePgtapIntegration) {
  console.log('[verify:cloud:core] VERIFY_CORE_PARALLEL_PGTAP_INTEGRATION=1; running pgTAP + integration in parallel.');
}
if (parallelizeUnitWithIntegration) {
  console.log('[verify:cloud:core] VERIFY_CORE_PARALLEL_UNIT_WITH_INTEGRATION=1; running unit + integration in parallel.');
}

const skippedSteps = [];
if (skipDbPush) {
  skippedSteps.push({ label: 'db:push', reason: 'VERIFY_SKIP_DB_PUSH=1' });
}
if (skipPgtap) {
  skippedSteps.push({ label: 'test:pgtap:cloud', reason: 'VERIFY_SKIP_PGTAP=1' });
}
if (skipEdgeDeploy) {
  skippedSteps.push({ label: 'edge:deploy', reason: 'EDGE_DEPLOY_SKIP=1' });
}
if (skipEdgeSmoke) {
  skippedSteps.push({
    label: 'test:edge-smoke:cloud',
    reason: skipEdgeDeploy ? 'EDGE_DEPLOY_SKIP=1' : 'VERIFY_SKIP_EDGE_SMOKE=1',
  });
}
if (skipFrontendChecks) {
  skippedSteps.push({ label: 'lint:frontend', reason: 'VERIFY_SKIP_FRONTEND=1' });
  skippedSteps.push({ label: 'typecheck:frontend', reason: 'VERIFY_SKIP_FRONTEND=1' });
}
if (skipLoadTests) {
  skippedSteps.push({ label: 'test:load:cloud', reason: 'VERIFY_SKIP_LOAD_TESTS=1' });
}

const clearedLogs = new Set();
const captureMaxBufferBytes = 25 * 1024 * 1024;

function writeSkippedEvidenceLog(fileName, message) {
  try {
    fs.writeFileSync(fileName, `${message}\n`, 'utf8');
    clearedLogs.add(fileName);
  } catch (e) {
    console.warn(`[verify:cloud:core] Failed to write skipped evidence log (${fileName}): ${e.message}`);
  }
}

function ensureSkippedEvidenceLogs() {
  if (skipPgtap) {
    writeSkippedEvidenceLog('pgtap.log', '[verify:cloud:core] test:pgtap:cloud skipped (VERIFY_SKIP_PGTAP=1)');
  }
  if (skipEdgeSmoke) {
    writeSkippedEvidenceLog(
      'edge.log',
      `[verify:cloud:core] test:edge-smoke:cloud skipped (${skipEdgeDeploy ? 'EDGE_DEPLOY_SKIP=1' : 'VERIFY_SKIP_EDGE_SMOKE=1'})`,
    );
  }
}

function safeIso(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function summarizeSpawnResult(res) {
  return {
    status: typeof res.status === 'number' ? res.status : null,
    signal: res.signal || null,
    error: res.error ? String(res.error.message || res.error) : null,
  };
}

function writeTimingSummary(summary) {
  if (!timingFile) return;
  try {
    fs.writeFileSync(timingFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(`[verify:cloud:core] Timing summary written to ${timingFile}`);
  } catch (e) {
    console.warn(`[verify:cloud:core] Failed to write timing summary to ${timingFile}: ${e.message}`);
  }
}

function resolveVerifyCandidateIdentity({
  cwd = process.cwd(),
  env: sourceEnv = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const readGitObject = (revision, label) => {
    const result = spawnSyncImpl('git', ['rev-parse', '--verify', revision], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    const value = String(result.stdout || '').trim().toLowerCase();
    if (result.status !== 0 || result.error || !/^[0-9a-f]{40}$/.test(value)) {
      const error = new Error(`Unable to bind verify:cloud:core proof to checked-out ${label}.`);
      error.exitCode = 1;
      error.stepLabel = 'candidate:identity';
      throw error;
    }
    return value;
  };

  const headSha = readGitObject('HEAD', 'candidate SHA');
  const treeSha = readGitObject('HEAD^{tree}', 'candidate tree');
  return {
    head_sha: headSha,
    tree_sha: treeSha,
    workflow_sha: String(sourceEnv.GITHUB_SHA || '').trim().toLowerCase() || null,
  };
}

function persistSelectedDbEnvToExplicitFile({ explicitEnvFile, selectedDsn, selectedCandidateName, logger = console } = {}) {
  const rawEnvFile = String(explicitEnvFile || process.env.ENV_FILE || '').trim();
  const dsn = String(selectedDsn || '').trim();
  const candidateName = String(selectedCandidateName || '').trim();
  if (!rawEnvFile || !dsn) {
    return { persisted: false, reason: rawEnvFile ? 'missing_selected_dsn' : 'missing_env_file' };
  }

  const normalizedEnvFile = rawEnvFile.replace(/\\/g, '/');
  const resolvedEnvFile = path.isAbsolute(normalizedEnvFile)
    ? normalizedEnvFile
    : path.join(process.cwd(), normalizedEnvFile);

  const persisted = upsertEnvFileValues(resolvedEnvFile, {
    DATABASE_URL: dsn,
    PG_CONN_STRING: dsn,
    ...(candidateName
      ? {
        DB_SMOKE_SELECTED_DSN_NAME: candidateName,
        DATABASE_URL_SELECTED_DSN_NAME: candidateName,
      }
      : {}),
  });

  if (!persisted) {
    return { persisted: false, reason: 'env_file_missing', envFile: resolvedEnvFile };
  }

  logger.log?.(
    `[verify:cloud:core] Persisted smoke-selected DATABASE_URL to explicit ENV_FILE (${resolvedEnvFile})${candidateName ? ` using ${candidateName}` : ''}.`,
  );
  return { persisted: true, envFile: resolvedEnvFile };
}

function appendCapturedText(buf, chunk, maxBytes) {
  const state = buf || { text: '', bytes: 0, truncated: false };
  if (!chunk) return state;
  if (state.truncated) return state;
  const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const remaining = maxBytes - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return state;
  }
  const bytes = Buffer.byteLength(data);
  if (bytes <= remaining) {
    state.text += data;
    state.bytes += bytes;
    return state;
  }
  const slice = Buffer.from(data).slice(0, remaining).toString('utf8');
  state.text += slice;
  state.bytes += Buffer.byteLength(slice);
  state.truncated = true;
  return state;
}

function isPidAlive(pid) {
  const p = Number(pid) || 0;
  if (!Number.isFinite(p) || p <= 0) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
}

function tryKillPid(pid, signal) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p === 0) return false;
  try {
    process.kill(p, signal);
    return true;
  } catch {
    return false;
  }
}

function cancelChildProcess(child, { label, graceMs } = {}) {
  if (!child || typeof child.pid !== 'number') return;
  const pid = child.pid;
  const timeoutMs = Math.max(0, parseInt(String(graceMs ?? process.env.VERIFY_CORE_CANCEL_GRACE_MS ?? '5000'), 10) || 5000);
  const isWin = process.platform.startsWith('win');

  // Kill the process group first (when detached); this is critical for `npm` and
  // Jest workers which can survive a parent-only SIGTERM in CI.
  if (!isWin && child.detached) {
    tryKillPid(-pid, 'SIGTERM');
  }
  try {
    child.kill('SIGTERM');
  } catch (_) {}

  if (timeoutMs <= 0) return;
  setTimeout(() => {
    if (!isPidAlive(pid)) return;
    if (!isWin && child.detached) {
      tryKillPid(-pid, 'SIGKILL');
    }
    try {
      child.kill('SIGKILL');
    } catch (_) {}
    if (label) {
      console.warn(`[verify:cloud:core] Forced cancel of ${label} (pid=${pid}) after ${timeoutMs}ms grace.`);
    }
  }, timeoutMs);
}

function spawnWithCapture({ cmd, args, mergedEnv, capture, useShell }) {
  const detached = !process.platform.startsWith('win');
  const child = spawn(cmd, args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: mergedEnv,
    shell: useShell,
    detached,
  });
  child.detached = detached;

  const captureState = capture
    ? {
      stdout: { text: '', bytes: 0, truncated: false },
      stderr: { text: '', bytes: 0, truncated: false },
    }
    : null;

  if (capture) {
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        captureState.stdout = appendCapturedText(captureState.stdout, chunk, captureMaxBufferBytes);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        captureState.stderr = appendCapturedText(captureState.stderr, chunk, captureMaxBufferBytes);
      });
    }
  }

  const done = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: 1, signal: null, error }));
    child.on('close', (code, signal) => resolve({ code, signal, error: null }));
  });

  return { child, done, captureState };
}

async function runParallelGroup(group, qa, qaRunId, timing) {
  const groupSteps = Array.isArray(group?.steps) ? group.steps : [];
  if (groupSteps.length === 0) return;

  const labels = groupSteps.map((s) => s.label).filter(Boolean).join(' + ');
  console.log(`[verify:cloud:core] ${group.label || 'parallel'} (${labels})`);

  const executions = [];

  for (const step of groupSteps) {
    const mergedEnv = { ...env, ...(step.env || {}) };
    if (qaRunId) {
      mergedEnv.QA_RUN_ID = qaRunId;
    }
    if (step.qaSuiteKey) {
      mergedEnv.QA_SUITE_KEY = step.qaSuiteKey;
    }

    const useShell = process.platform.startsWith('win') && step.cmd.toLowerCase().includes('npm');
    const capture = Boolean(step.logFile);
    if (capture && !clearedLogs.has(step.logFile)) {
      fs.writeFileSync(step.logFile, '');
      clearedLogs.add(step.logFile);
    }

    const stepId = await qa.startStep(step.label, {
      cmd: step.cmd,
      args: step.args,
      logFile: step.logFile || null,
    });

    const startedAtMs = Date.now();
    const { child, done, captureState } = spawnWithCapture({
      cmd: step.cmd,
      args: step.args,
      mergedEnv,
      capture,
      useShell,
    });

    executions.push({
      step,
      stepId,
      startedAtMs,
      child,
      done,
      capture,
      captureState,
      cancelled: false,
      cancelledBy: null,
    });
  }

  let firstFailure = null;
  const pending = new Set(executions);

  while (pending.size > 0) {
    const settled = await Promise.race(
      Array.from(pending).map((exec) => exec.done.then((r) => ({ exec, ...r }))),
    );

    const exec = settled.exec;
    pending.delete(exec);

    const endedAtMs = Date.now();
    const exitCode = typeof settled.code === 'number' ? settled.code : 1;
    const signal = settled.signal || null;
    const error = settled.error ? String(settled.error.message || settled.error) : null;

    if (!firstFailure && exitCode !== 0 && !exec.cancelled) {
      firstFailure = { label: exec.step.label, exitCode: exitCode || 1 };
      for (const other of pending) {
        other.cancelled = true;
        other.cancelledBy = exec.step.label;
        cancelChildProcess(other.child, { label: other.step.label, graceMs: process.env.VERIFY_CORE_CANCEL_GRACE_MS });
      }
    }

    if (exec.capture) {
      const stdout = exec.captureState?.stdout?.text || '';
      const stderr = exec.captureState?.stderr?.text || '';
      const truncated = Boolean(exec.captureState?.stdout?.truncated || exec.captureState?.stderr?.truncated);
      const out = `${stdout}${stderr}${truncated ? '\n[verify:cloud:core] (output truncated)\n' : ''}`;
      fs.appendFileSync(exec.step.logFile, out);
      if (out) process.stdout.write(out);
    }

    timing.steps.push({
      label: exec.step.label,
      cmd: exec.step.cmd,
      args: exec.step.args,
      logFile: exec.step.logFile || null,
      qaSuiteKey: exec.step.qaSuiteKey || null,
      started_at: safeIso(exec.startedAtMs),
      ended_at: safeIso(endedAtMs),
      duration_ms: endedAtMs - exec.startedAtMs,
      status: exec.cancelled ? null : exitCode,
      signal,
      error: exec.cancelled ? `cancelled (due to failure in ${exec.cancelledBy})` : error,
    });

    if (exec.cancelled) {
      await qa.finishStep(exec.stepId, 'skipped', { cancelledBy: exec.cancelledBy }, `cancelled (due to failure in ${exec.cancelledBy})`);
      continue;
    }

    if (exitCode !== 0) {
      await qa.finishStep(exec.stepId, 'failed', { exitCode: exitCode || 1 }, error);
      continue;
    }
    await qa.finishStep(exec.stepId, 'passed', { exitCode: 0 }, null);
  }

  if (firstFailure) {
    console.error(`[verify:cloud:core] FAILED at step: ${firstFailure.label}`);
    const err = new Error(`verify:cloud:core failed at ${firstFailure.label}`);
    err.exitCode = firstFailure.exitCode || 1;
    err.stepLabel = firstFailure.label;
    throw err;
  }
}

async function runStep(step, qa, qaRunId, timing) {
  const mergedEnv = { ...env, ...(step.env || {}) };
  if (qaRunId) {
    mergedEnv.QA_RUN_ID = qaRunId;
  }
  if (step.qaSuiteKey) {
    mergedEnv.QA_SUITE_KEY = step.qaSuiteKey;
  }
  console.log(`[verify:cloud:core] ${step.label}`);
  const useShell = process.platform.startsWith('win') && step.cmd.toLowerCase().includes('npm');
  const capture = Boolean(step.logFile);
  if (capture && !clearedLogs.has(step.logFile)) {
    fs.writeFileSync(step.logFile, '');
    clearedLogs.add(step.logFile);
  }
  const stepId = await qa.startStep(step.label, {
    cmd: step.cmd,
    args: step.args,
    logFile: step.logFile || null,
  });
  const startedAtMs = Date.now();
  const res = spawnSync(step.cmd, step.args, {
    stdio: capture ? 'pipe' : 'inherit',
    encoding: capture ? 'utf8' : undefined,
    maxBuffer: capture ? captureMaxBufferBytes : undefined,
    env: mergedEnv,
    shell: useShell,
  });
  const endedAtMs = Date.now();
  if (capture) {
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    fs.appendFileSync(step.logFile, out);
    if (out) process.stdout.write(out);
  }
  timing.steps.push({
    label: step.label,
    cmd: step.cmd,
    args: step.args,
    logFile: step.logFile || null,
    qaSuiteKey: step.qaSuiteKey || null,
    started_at: safeIso(startedAtMs),
    ended_at: safeIso(endedAtMs),
    duration_ms: endedAtMs - startedAtMs,
    ...summarizeSpawnResult(res),
  });
  if (res.error) {
    console.error(`[verify:cloud:core] ${step.label} error: ${res.error.message}`);
  }
  if (res.status !== 0) {
    await qa.finishStep(stepId, 'failed', { exitCode: res.status || 1 }, res.error?.message || null);
    console.error(`[verify:cloud:core] FAILED at step: ${step.label}`);
    const err = new Error(`verify:cloud:core failed at ${step.label}`);
    err.exitCode = res.status || 1;
    err.stepLabel = step.label;
    throw err;
  }
  await qa.finishStep(stepId, 'passed', { exitCode: 0 }, null);
}

async function runDbConnectSmokeStep(step, qa, timing) {
  console.log(`[verify:cloud:core] ${step.label}`);
  const stepId = await qa.startStep(step.label, {
    cmd: 'internal:db-connect-smoke',
    args: [],
    logFile: null,
  });
  const startedAtMs = Date.now();

  try {
    const candidates = await resolveDsnCandidates({ env });
    const result = await runConnectivitySmoke({
      candidates,
      connectionTimeoutMs: parsePositiveInt(env.DB_SMOKE_TIMEOUT_MS, 10000),
      maxWaitMs: parsePositiveInt(env.DB_SMOKE_MAX_WAIT_MS, 120000),
      retryDelayMs: parsePositiveInt(env.DB_SMOKE_RETRY_DELAY_MS, 2000),
      logger: console,
    });

    const selectedDsn = String(result?.candidate?.dsn || '').trim();
    const selectedCandidateName = String(result?.candidate?.name || '').trim();
    if (selectedDsn) {
      // Keep downstream unit/integration suites on the known-good DSN selected by
      // the smoke ladder instead of the unresolved raw URL.
      env.DATABASE_URL = selectedDsn;
      env.PG_CONN_STRING = selectedDsn;
      process.env.DATABASE_URL = selectedDsn;
      process.env.PG_CONN_STRING = selectedDsn;
    }
    if (selectedCandidateName) {
      env.DB_SMOKE_SELECTED_DSN_NAME = selectedCandidateName;
      env.DATABASE_URL_SELECTED_DSN_NAME = selectedCandidateName;
      process.env.DB_SMOKE_SELECTED_DSN_NAME = selectedCandidateName;
      process.env.DATABASE_URL_SELECTED_DSN_NAME = selectedCandidateName;
    }
    persistSelectedDbEnvToExplicitFile({
      explicitEnvFile: env.ENV_FILE || process.env.ENV_FILE,
      selectedDsn,
      selectedCandidateName,
      logger: console,
    });
    if (selectedCandidateName) {
      console.log(`[verify:cloud:core] db:connect:smoke pinned DATABASE_URL using ${selectedCandidateName}.`);
    }

    const endedAtMs = Date.now();
    timing.steps.push({
      label: step.label,
      cmd: 'internal:db-connect-smoke',
      args: [],
      logFile: null,
      qaSuiteKey: null,
      started_at: safeIso(startedAtMs),
      ended_at: safeIso(endedAtMs),
      duration_ms: endedAtMs - startedAtMs,
      status: 0,
      signal: null,
      error: null,
    });
    await qa.finishStep(stepId, 'passed', { exitCode: 0, selectedCandidate: selectedCandidateName || null }, null);
  } catch (error) {
    const endedAtMs = Date.now();
    timing.steps.push({
      label: step.label,
      cmd: 'internal:db-connect-smoke',
      args: [],
      logFile: null,
      qaSuiteKey: null,
      started_at: safeIso(startedAtMs),
      ended_at: safeIso(endedAtMs),
      duration_ms: endedAtMs - startedAtMs,
      status: 1,
      signal: null,
      error: String(error?.message || error),
    });
    await qa.finishStep(stepId, 'failed', { exitCode: 1 }, String(error?.message || error));
    console.error(`[verify:cloud:core] FAILED at step: ${step.label}`);
    const err = new Error(`verify:cloud:core failed at ${step.label}`);
    err.exitCode = 1;
    err.stepLabel = step.label;
    throw err;
  }
}

async function runDbBootstrapStep(step, qa, qaRunId, timing) {
  console.log(`[verify:cloud:core] ${step.label}`);
  const stepId = await qa.startStep(step.label, {
    cmd: 'internal:db-bootstrap',
    args: [],
    logFile: null,
  });
  const startedAtMs = Date.now();

  try {
    const {
      selectedCandidateName,
      bootstrapped,
      bootstrapReason,
    } = await ensureCloudDbBootstrap({
      env,
      logger: console,
      qaRunId,
      repoRoot: process.cwd(),
    });

    const endedAtMs = Date.now();
    timing.steps.push({
      label: step.label,
      cmd: 'internal:db-bootstrap',
      args: [],
      logFile: null,
      qaSuiteKey: null,
      started_at: safeIso(startedAtMs),
      ended_at: safeIso(endedAtMs),
      duration_ms: endedAtMs - startedAtMs,
      status: 0,
      signal: null,
      error: null,
    });
    await qa.finishStep(stepId, 'passed', {
      exitCode: 0,
      selectedCandidate: selectedCandidateName || null,
      bootstrapped,
      bootstrapReason: bootstrapReason || null,
    }, null);
  } catch (error) {
    const endedAtMs = Date.now();
    timing.steps.push({
      label: step.label,
      cmd: 'internal:db-bootstrap',
      args: [],
      logFile: null,
      qaSuiteKey: null,
      started_at: safeIso(startedAtMs),
      ended_at: safeIso(endedAtMs),
      duration_ms: endedAtMs - startedAtMs,
      status: 1,
      signal: null,
      error: String(error?.message || error),
    });
    await qa.finishStep(stepId, 'failed', { exitCode: 1 }, String(error?.message || error));
    console.error(`[verify:cloud:core] FAILED at step: ${step.label}`);
    const err = new Error(`verify:cloud:core failed at ${step.label}`);
    err.exitCode = 1;
    err.stepLabel = step.label;
    throw err;
  }
}

async function main() {
  const qa = createQaLogger({ runId: process.env.QA_RUN_ID });
  const runKey = process.env.QA_RUN_KEY || 'verify:cloud:core';
  const runInfo = buildQaRunMetadata();
  let qaRunId = null;
  const runStartedAtMs = Date.now();
  const timing = {
    schema_version: 1,
    run_key: runKey,
    started_at: safeIso(runStartedAtMs),
    ended_at: null,
    duration_ms: null,
    env: {
      ci: isTruthy(process.env.CI),
      github: isTruthy(process.env.GITHUB_ACTIONS),
      github_run_id: process.env.GITHUB_RUN_ID || null,
      github_workflow: process.env.GITHUB_WORKFLOW || null,
      github_job: process.env.GITHUB_JOB || null,
      github_repository: process.env.GITHUB_REPOSITORY || null,
      github_ref: process.env.GITHUB_REF || null,
      github_sha: process.env.GITHUB_SHA || null,
    },
    skipped_steps: skippedSteps.map((s) => ({
      label: s.label,
      reason: s.reason,
    })),
    steps: [],
    result: {
      status: 'unknown',
      failed_step: null,
      exit_code: null,
    },
    candidate: {
      head_sha: null,
      tree_sha: null,
      workflow_sha: String(process.env.GITHUB_SHA || '').trim().toLowerCase() || null,
    },
  };
  try {
    timing.candidate = resolveVerifyCandidateIdentity();
    qaRunId = await qa.startRun(runKey, runInfo);
    timing.qa_run_id = qaRunId;
    for (const skipped of skippedSteps) {
      const stepId = await qa.startStep(skipped.label, { skipped: true, reason: skipped.reason });
      await qa.finishStep(stepId, 'skipped', { reason: skipped.reason }, null);
    }
    for (const step of steps) {
      if (step && step.type === 'parallel') {
        await runParallelGroup(step, qa, qaRunId, timing);
        continue;
      }
      if (step && step.type === 'db_bootstrap') {
        await runDbBootstrapStep(step, qa, qaRunId, timing);
        continue;
      }
      if (step && step.type === 'db_smoke') {
        await runDbConnectSmokeStep(step, qa, timing);
        continue;
      }
      await runStep(step, qa, qaRunId, timing);
    }
    ensureSkippedEvidenceLogs();
    await qa.finishRun('passed', { stepCount: timing.steps.length }, null);
    await qa.close();
    timing.result.status = 'passed';
    timing.result.exit_code = 0;
    timing.ended_at = safeIso(Date.now());
    timing.duration_ms = Date.now() - runStartedAtMs;
    writeTimingSummary(timing);
    console.log('[verify:cloud:core] All steps passed.');
    process.exit(0);
  } catch (err) {
    ensureSkippedEvidenceLogs();
    if (qaRunId) {
      await qa.finishRun('failed', { failedStep: err.stepLabel || null }, err.message);
    }
    await qa.close();
    timing.result.status = 'failed';
    timing.result.failed_step = err.stepLabel || null;
    timing.result.exit_code = err.exitCode || 1;
    timing.ended_at = safeIso(Date.now());
    timing.duration_ms = Date.now() - runStartedAtMs;
    writeTimingSummary(timing);
    console.error(`[verify:cloud:core] FAILED: ${err.message}`);
    process.exit(err.exitCode || 1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  persistSelectedDbEnvToExplicitFile,
  resolveVerifyCandidateIdentity,
  upsertEnvFileValues,
};
