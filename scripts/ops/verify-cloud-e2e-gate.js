#!/usr/bin/env node
/**
 * verify-cloud-e2e-gate.js
 *
 * Post-deploy E2E gate for shared environments (stg/prod):
 * - Assumes the target project is already deployed (migrations + edge).
 * - Runs shared-env-safe smoke checks first, then mandatory proofs, then extended UI coverage.
 * - Retries only infrastructure-class failures once with a bounded delay.
 */
/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../utils/load-env');
const {
  buildHostedUiGateSummary,
  classifyHostedUiRetryPolicy,
} = require('./gates/hosted-ui-state');
const { primePlaywrightBrowsersPath } = require('./ci/install-playwright-chromium');
const { loadUiFlakeQuarantine } = require('./ci/ui-flake-quarantine');

loadEnv();

const env = {
  ...process.env,
  STRICT_E2E_GATE_ENV: 'true',
  E2E_ALLOW_MUTATIONS: '0',
};
primePlaywrightBrowsersPath({ sourceEnv: env });

const logFile = 'e2e-gate.log';
const summaryFile = 'e2e-gate-summary.json';
const uiPreflightFile = 'ui-resource-preflight.json';
const smokeOnly = /^(1|true|yes|on)$/i.test(String(process.env.VERIFY_CLOUD_E2E_GATE_SMOKE_ONLY || '').trim());

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    'summary-out': '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = String(argv[i] || '').trim();
    if (!value.startsWith('--')) continue;
    if (value === '--summary-out') {
      out['summary-out'] = String(argv[i + 1] || '').trim();
      i += 1;
    } else if (value.startsWith('--summary-out=')) {
      out['summary-out'] = value.split('=').slice(1).join('=').trim();
    }
  }
  return out;
}

function writeSummary(summaryPath, payload) {
  const targetPath = path.resolve(process.cwd(), String(summaryPath || summaryFile).trim() || summaryFile);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return targetPath;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runStep(step) {
  console.log(`[verify:cloud:e2e-gate] ${step.label}`);
  const useShell = process.platform.startsWith('win') && step.cmd.toLowerCase().includes('npm');
  if (step.logFile) fs.writeFileSync(step.logFile, '');
  const res = spawnSync(step.cmd, step.args, {
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...env, ...(step.env || {}) },
    shell: useShell,
    maxBuffer: 150 * 1024 * 1024,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (step.logFile) fs.appendFileSync(step.logFile, out);
  if (out) process.stdout.write(out);
  if (res.error) {
    console.error(`[verify:cloud:e2e-gate] ${step.label} error: ${res.error.message}`);
  }
  return {
    label: step.label,
    status: res.status || 0,
    error: res.error ? String(res.error.message || res.error) : '',
    output: out,
  };
}

async function runStepWithRetry(step, summary) {
  const retryDelayMs = Number.parseInt(String(process.env.VERIFY_CLOUD_UI_INFRA_RETRY_DELAY_MS || '15000').trim(), 10) || 15000;
  let retryCount = 0;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = runStep(step);
    if (result.status === 0) {
      return { result, retryCount };
    }

    const failureSummary = buildHostedUiGateSummary({
      status: 'failed',
      failedStep: step.label,
      outputText: `${result.output || ''}\n${result.error || ''}`,
    });
    const retryPolicy = classifyHostedUiRetryPolicy({
      failureClass: failureSummary.failure_class,
      outputText: `${result.output || ''}\n${result.error || ''}`,
      stepLabel: step.label,
    });
    if (!retryPolicy.retryable || attempt > retryPolicy.max_retries) {
      return { result, retryCount };
    }

    retryCount += 1;
    summary.retry_events.push({
      step: step.label,
      retry_class: retryPolicy.retry_class,
      attempt,
      delay_ms: retryDelayMs,
    });
    console.warn(`[verify:cloud:e2e-gate] retrying ${step.label} after ${retryDelayMs}ms (${retryPolicy.retry_class}).`);
    await sleep(retryDelayMs);
  }

  return {
    result: runStep(step),
    retryCount,
  };
}

async function main() {
  const args = parseArgs();
  const steps = [
    { cmd: 'node', args: [path.join('scripts', 'ops', 'assert-cloud-env.js')], label: 'assert-cloud-env' },
    {
      cmd: 'node',
      args: [path.join('scripts', 'ops', 'gates', 'workflow-intake-smoke.js')],
      label: 'workflow-intake-smoke',
      logFile,
    },
    {
      cmd: 'node',
      args: [
        path.join('scripts', 'ops', 'gates', 'ui-resource-preflight.js'),
        '--summary-out',
        uiPreflightFile,
      ],
      label: 'ui_resource_preflight',
    },
  ];

  if (!smokeOnly) {
    steps.push(
      {
        cmd: 'node',
        args: [path.join('scripts', 'ops', 'ci', 'install-playwright-chromium.js')],
        label: 'playwright:install:chromium',
        logFile: 'playwright-install.log',
      },
      {
        cmd: 'node',
        args: [path.join('scripts', 'ops', 'verify-cloud-e2e-mandatory-pack.js')],
        label: 'verify:cloud:e2e-mandatory-pack',
      },
      {
        cmd: 'node',
        args: [path.join('scripts', 'ops', 'verify-cloud-ui.js')],
        label: 'verify:cloud:ui',
      },
    );
  }

  const quarantine = loadUiFlakeQuarantine(process.cwd());
  const summary = {
    generated_at: new Date().toISOString(),
    status: 'passed',
    failed_step: '',
    failure_class: '',
    ui_state: 'ready',
    full_gate_ran: false,
    smoke_only: smokeOnly,
    ui_resource_preflight_path: '',
    gate_owner: String(process.env.UI_GATE_OWNER || `${process.env.GITHUB_WORKFLOW || 'verify-ui'}:${process.env.GITHUB_SHA || 'local'}:hosted-ui`).trim(),
    quarantine_manifest_path: quarantine.path,
    quarantined_specs_total: Array.isArray(quarantine.entries) ? quarantine.entries.length : 0,
    mandatory_pack_ran: false,
    extended_pack_ran: false,
    retry_count: 0,
    retry_events: [],
    silent_skip_count: 0,
    steps: [],
  };

  for (const step of steps) {
    const { result, retryCount } = await runStepWithRetry(step, summary);
    summary.retry_count += retryCount;
    summary.steps.push({
      label: result.label,
      exit_code: result.status,
    });
    if (result.status !== 0) {
      Object.assign(summary, buildHostedUiGateSummary({
        status: 'failed',
        failedStep: result.label,
        outputText: `${result.output || ''}\n${result.error || ''}`,
      }));
      summary.full_gate_ran = false;
      if (step.label === 'ui_resource_preflight') {
        summary.ui_resource_preflight_path = path.resolve(process.cwd(), uiPreflightFile);
      }
      const targetPath = writeSummary(args['summary-out'], summary);
      console.error(`[verify:cloud:e2e-gate] FAILED at step: ${step.label}`);
      console.error(`[verify:cloud:e2e-gate] summary=${targetPath} failure_class=${summary.failure_class || '<unknown>'}`);
      process.exit(result.status || 1);
    }
    if (step.label === 'ui_resource_preflight') {
      summary.ui_resource_preflight_path = path.resolve(process.cwd(), uiPreflightFile);
    }
    if (step.label === 'verify:cloud:e2e-mandatory-pack') {
      summary.mandatory_pack_ran = true;
    }
    if (step.label === 'verify:cloud:ui') {
      summary.extended_pack_ran = true;
    }
  }

  summary.full_gate_ran = !smokeOnly;
  writeSummary(args['summary-out'], summary);
  console.log(`[verify:cloud:e2e-gate] ${smokeOnly ? 'Smoke-only gate' : 'Full gate'} passed.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}
