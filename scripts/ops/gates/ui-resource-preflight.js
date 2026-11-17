#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../../utils/load-env');
const { run: runUiSurfaceSmoke } = require('./ui-surface-smoke');
const { buildHostedUiGateSummary } = require('./hosted-ui-state');

loadEnv();

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    'summary-out': '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token.startsWith('--')) continue;
    if (token === '--summary-out') {
      out['summary-out'] = String(argv[i + 1] || '').trim();
      i += 1;
    } else if (token.startsWith('--summary-out=')) {
      out['summary-out'] = token.split('=').slice(1).join('=').trim();
    }
  }
  return out;
}

function readPositiveInt(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function writeSummary(targetPath, payload) {
  const resolved = path.resolve(process.cwd(), String(targetPath || 'ui-resource-preflight.json').trim() || 'ui-resource-preflight.json');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return resolved;
}

async function runUiResourcePreflight({ argv = process.argv.slice(2) } = {}) {
  const args = parseArgs(argv);
  const maxWaitMs = readPositiveInt('DEPLOY_UI_READY_MAX_WAIT_MS', 120_000);
  const retryDelayMs = readPositiveInt('DEPLOY_UI_READY_RETRY_DELAY_MS', 5_000);
  const perAttemptTimeoutMs = Math.max(5_000, Math.min(maxWaitMs, readPositiveInt('DEPLOY_UI_READY_REQUEST_TIMEOUT_MS', 15_000)));
  const maxAttempts = Math.max(1, Math.ceil(maxWaitMs / Math.max(1, retryDelayMs)));

  try {
    const smoke = await runUiSurfaceSmoke({
      argv: [
        '--timeout-ms', String(perAttemptTimeoutMs),
        '--max-attempts', String(maxAttempts),
        '--retry-delay-ms', String(retryDelayMs),
      ],
      env: process.env,
    });
    const summary = {
      generated_at: new Date().toISOString(),
      status: 'passed',
      failure_class: '',
      ui_state: 'ready',
      failed_step: '',
      matched_text: '',
      max_wait_ms: maxWaitMs,
      retry_delay_ms: retryDelayMs,
      request_timeout_ms: perAttemptTimeoutMs,
      max_attempts: maxAttempts,
      full_gate_ran: false,
      results: smoke.results || [],
    };
    const targetPath = writeSummary(args['summary-out'], summary);
    console.log(`[ui-resource-preflight] status=passed summary=${targetPath}`);
    return { summary, targetPath };
  } catch (error) {
    const base = buildHostedUiGateSummary({
      status: 'failed',
      failedStep: 'ui_resource_preflight',
      outputText: String(error?.message || error || ''),
    });
    const summary = {
      ...base,
      failure_class: base.failure_class || 'resource-unavailable',
      ui_state: base.ui_state || 'resource-unavailable',
      max_wait_ms: maxWaitMs,
      retry_delay_ms: retryDelayMs,
      request_timeout_ms: perAttemptTimeoutMs,
      max_attempts: maxAttempts,
      full_gate_ran: false,
      results: [],
    };
    const targetPath = writeSummary(args['summary-out'], summary);
    console.error(`[ui-resource-preflight] status=failed failure_class=${summary.failure_class} summary=${targetPath}`);
    throw Object.assign(new Error(summary.failure_class), {
      summary,
      targetPath,
      originalError: error,
    });
  }
}

if (require.main === module) {
  runUiResourcePreflight().catch((error) => {
    if (error?.summary) {
      process.exit(1);
    }
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  readPositiveInt,
  runUiResourcePreflight,
};
