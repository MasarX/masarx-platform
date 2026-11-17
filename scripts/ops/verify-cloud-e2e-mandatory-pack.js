#!/usr/bin/env node
/**
 * verify-cloud-e2e-mandatory-pack.js
 *
 * Executes mandatory go-live E2E suites for shipments + print labels + role matrix + run-log visibility.
 * Fails closed when any mandatory test is skipped.
 */
/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const npxCmd = process.platform.startsWith('win') ? 'npx.cmd' : 'npx';
const env = {
  ...process.env,
  STRICT_E2E_GATE_ENV: 'true',
  E2E_ALLOW_MUTATIONS: '0',
  E2E_REQUIRE_BASE_URLS: '1',
};

const reportFile = 'e2e-mandatory-pack.json';
const logFile = 'e2e-mandatory-pack.log';
const manifestPath = path.join(process.cwd(), 'tmp', 'demo-accounts.json');
const summaryPath = path.join(process.cwd(), 'tmp', 'demo-accounts-summary.json');
const cleanupSummaryPath = path.join(process.cwd(), 'tmp', 'demo-accounts-cleanup-summary.json');

const mandatorySpecs = [
  path.join('tests', 'e2e', 'action-shipments-actions.spec.ts'),
  path.join('tests', 'e2e', 'action-shipments-print-labels.spec.ts'),
  path.join('tests', 'e2e', 'console-role-matrix.spec.ts'),
  path.join('tests', 'e2e', 'portal-role-matrix.spec.ts'),
  path.join('tests', 'e2e', 'logging.workflow-run-logs-capture.spec.ts'),
];

function isTruthy(value) {
  return /^(1|true|yes|on|enabled)$/i.test(String(value || '').trim());
}

function requireAbsoluteUrl(raw, label) {
  const value = String(raw || '').trim();
  if (!value) throw new Error(`Missing required ${label}`);
  const parsed = new URL(value);
  if (!parsed.protocol || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new Error(`${label} must be http(s): ${value}`);
  }
  const host = String(parsed.hostname || '').toLowerCase();
  // objectives:allow LOCALHOST Justification: strict mandatory cloud gate must explicitly reject loopback hosts
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
    throw new Error(`${label} must point to a hosted URL in mandatory gate mode (got host=${host})`);
  }
  return parsed.toString();
}

function resolveEphemeralRunId() {
  const raw = String(
    env.E2E_EPHEMERAL_RUN_ID ||
      (env.GITHUB_RUN_ID && env.GITHUB_RUN_ATTEMPT
        ? `gh-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`
        : `local-${Date.now()}`),
  )
    .trim()
    .toLowerCase();
  const normalized = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (normalized) return normalized;
  return `local-${Date.now()}`;
}

function resolveSeedShipmentsPerClient() {
  const raw = String(
    process.env.E2E_SEED_SHIPMENTS_PER_CLIENT || env.E2E_SEED_SHIPMENTS_PER_CLIENT || '',
  ).trim();
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return String(parsed);
  return '2';
}

function runStep(step, { capture = false } = {}) {
  console.log(`[verify:cloud:e2e-mandatory-pack] ${step.label}`);
  const res = spawnSync(step.cmd, step.args, {
    stdio: capture ? 'pipe' : 'inherit',
    encoding: capture ? 'utf8' : undefined,
    env: { ...env, ...(step.env || {}) },
    shell: process.platform.startsWith('win') && String(step.cmd || '').toLowerCase().endsWith('.cmd'),
    ...(capture ? { maxBuffer: 150 * 1024 * 1024 } : {}),
  });

  if (capture) {
    const combined = `${res.stdout || ''}${res.stderr || ''}`;
    fs.writeFileSync(logFile, combined, 'utf8');
    if (res.status !== 0 && combined.trim()) {
      process.stdout.write(combined);
    }
  }

  if (res.error) {
    throw new Error(`${step.label} error: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`${step.label} failed (exit=${res.status || 1})`);
  }

  return res;
}

function collectMandatoryOutcomes(report) {
  const out = {
    total: 0,
    skipped: [],
    failed: [],
  };

  function walkSuite(suite, parents = []) {
    const title = String(suite?.title || '').trim();
    const chain = title ? [...parents, title] : parents;

    for (const spec of Array.isArray(suite?.specs) ? suite.specs : []) {
      const specTitle = String(spec?.title || '').trim();
      const specChain = specTitle ? [...chain, specTitle] : chain;
      for (const test of Array.isArray(spec?.tests) ? spec.tests : []) {
        out.total += 1;
        const outcome = String(test?.outcome || '').trim().toLowerCase();
        const project = String(test?.projectName || '').trim();
        const testLabel = `${project ? `[${project}] ` : ''}${specChain.join(' > ')}`;
        if (outcome === 'skipped') {
          out.skipped.push(testLabel);
        } else if (outcome === 'unexpected' || outcome === 'timedout' || outcome === 'interrupted') {
          out.failed.push(`${testLabel} (${outcome})`);
        }
      }
    }

    for (const child of Array.isArray(suite?.suites) ? suite.suites : []) {
      walkSuite(child, chain);
    }
  }

  for (const suite of Array.isArray(report?.suites) ? report.suites : []) {
    walkSuite(suite, []);
  }

  return out;
}

function runMandatoryPlaywright() {
  console.log('[verify:cloud:e2e-mandatory-pack] playwright:test:mandatory-pack');
  const res = spawnSync(
    npxCmd,
    ['--no-install', 'playwright', 'test', ...mandatorySpecs, '--reporter=line,json'],
    {
      stdio: 'inherit',
      env: {
        ...env,
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
      },
      shell: process.platform.startsWith('win') && String(npxCmd).toLowerCase().endsWith('.cmd'),
      maxBuffer: 150 * 1024 * 1024,
    },
  );
  if (res.error) {
    throw new Error(`playwright:test:mandatory-pack error: ${res.error.message}`);
  }
  if (!fs.existsSync(reportFile)) {
    throw new Error('Mandatory pack did not produce Playwright JSON output file.');
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse mandatory Playwright JSON report file: ${error.message}`);
  }

  const outcomes = collectMandatoryOutcomes(parsed);
  if (outcomes.total === 0) {
    throw new Error('Mandatory pack produced zero tests.');
  }
  if (outcomes.skipped.length > 0) {
    const sample = outcomes.skipped.slice(0, 8).join(' | ');
    throw new Error(
      `Mandatory E2E suites contain skipped tests (${outcomes.skipped.length}). ` +
        `Fail-closed; sample: ${sample}`,
    );
  }
  if (res.status !== 0 || outcomes.failed.length > 0) {
    const sample = outcomes.failed.slice(0, 8).join(' | ');
    throw new Error(
      `Mandatory E2E suites failed (${outcomes.failed.length}) with no skips. Sample: ${sample || 'unknown failure'}`,
    );
  }

  console.log(
    `[verify:cloud:e2e-mandatory-pack] Mandatory tests passed (total=${outcomes.total}, failed=${outcomes.failed.length}, skipped=${outcomes.skipped.length}).`,
  );
}

function runProvision() {
  if (!isTruthy(env.DEMO_ACCOUNTS_PROVISION_GUARD)) {
    throw new Error(
      'Mandatory E2E pack requires DEMO_ACCOUNTS_PROVISION_GUARD=enabled for ephemeral identities.',
    );
  }
  if (
    isTruthy(env.PROD_DEPLOY_GUARD) &&
    !isTruthy(env.E2E_EPHEMERAL_ALLOW_PRODUCTION) &&
    !isTruthy(env.DEMO_ACCOUNTS_ALLOW_PRODUCTION)
  ) {
    throw new Error(
      'Mandatory E2E pack is blocked in production by default. Set E2E_EPHEMERAL_ALLOW_PRODUCTION=1 (or DEMO_ACCOUNTS_ALLOW_PRODUCTION=1) to proceed.',
    );
  }
  if (fs.existsSync(manifestPath)) {
    fs.rmSync(manifestPath, { force: true });
  }
  runStep({
    cmd: 'node',
    args: [
      path.join('scripts', 'ops', 'provision-demo-accounts.js'),
      '--config',
      path.join('config', 'demo', 'demo-accounts.json'),
      '--out',
      manifestPath,
      '--summary-out',
      summaryPath,
      '--include-password',
      '1',
      '--ephemeral',
      '--ephemeral-run-id',
      resolveEphemeralRunId(),
      '--seed-shipments',
      '1',
      '--seed-shipments-per-client',
      resolveSeedShipmentsPerClient(),
    ],
    label: 'provision-demo-accounts:mandatory-ephemeral',
  });
}

function runCleanup() {
  if (!fs.existsSync(manifestPath)) return;
  runStep({
    cmd: 'node',
    args: [
      path.join('scripts', 'ops', 'provision-demo-accounts.js'),
      '--cleanup-manifest',
      manifestPath,
      '--summary-out',
      cleanupSummaryPath,
    ],
    label: 'provision-demo-accounts:cleanup',
  });
  if (fs.existsSync(manifestPath)) {
    fs.rmSync(manifestPath, { force: true });
  }
}

function main() {
  let failed = null;
  let cleanupFailed = null;

  try {
    requireAbsoluteUrl(env.CONSOLE_BASE_URL, 'CONSOLE_BASE_URL');
    requireAbsoluteUrl(env.PORTAL_BASE_URL, 'PORTAL_BASE_URL');
    runProvision();
    runMandatoryPlaywright();
  } catch (error) {
    failed = error;
  } finally {
    try {
      runCleanup();
    } catch (error) {
      cleanupFailed = error;
      if (!failed) failed = error;
    }
  }

  if (failed) {
    console.error(`[verify:cloud:e2e-mandatory-pack] ${failed.message || String(failed)}`);
    if (cleanupFailed && cleanupFailed !== failed) {
      console.error(
        `[verify:cloud:e2e-mandatory-pack] Cleanup error: ${cleanupFailed.message || String(cleanupFailed)}`,
      );
    }
    process.exit(1);
  }

  console.log('[verify:cloud:e2e-mandatory-pack] All mandatory suites passed with zero skips.');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  isTruthy,
  requireAbsoluteUrl,
  resolveEphemeralRunId,
  resolveSeedShipmentsPerClient,
  collectMandatoryOutcomes,
  mandatorySpecs,
};
