#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadEnv } = require('../../utils/load-env');
const { run } = require('../../utils/exec');

loadEnv();

function tryRun(label, npmScript, env) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'cmd.exe' : 'npm';
  const args = isWin ? ['/c', 'npm', 'run', npmScript] : ['run', npmScript];
  const t0 = Date.now();
  const res = spawnSync(cmd, args, { stdio: 'inherit', env });
  const ms = Date.now() - t0;
  const code = typeof res.status === 'number' ? res.status : 1;
  if (code !== 0) {
    console.error(`[verify-cloud] ${label} failed with code ${res.status}`);
    return { label, ok: false, ms };
  }
  return { label, ok: true, ms };
}

(async () => {
  const envFile = process.env.ENV_FILE;
  if (!envFile) throw new Error('ENV_FILE must point to config/env/.env.cloud');

  const env = { ...process.env, ENV_FILE: envFile };
  await run('node', ['scripts/ops/assert-cloud-env.js'], { env });
  // Ensure control-plane API exposure settings are hardened before running any integration tests.
  await run('node', ['scripts/ops/workspace/harden-data-api.js'], { env });
  const projectRef = process.env.SUPABASE_PROJECT_ID || '';
  const supaUrl = process.env.SUPABASE_URL || '';

  // Self-check: ensure we are targeting a specific workspace environment
  if (!projectRef || !supaUrl) {
    throw new Error('[verify-cloud] Missing SUPABASE_PROJECT_ID or SUPABASE_URL in ENV_FILE; refusing to run.');
  }
  console.log(`[verify-cloud] Target project_ref=${projectRef} url=${supaUrl}`);

  const results = {};
  // IMPORTANT: use scripts that honor ENV_FILE; do not override to default .env.cloud
  const pgtap = tryRun('pgtap', 'test:pgtap', env);
  results.pgtap = pgtap.ok ? 'pass' : 'fail';
  const integration = tryRun('integration', 'test:integration', env);
  results.integration = integration.ok ? 'pass' : 'fail';
  const edge = tryRun('edge-smoke', 'test:edge-smoke', env);
  results.edge = edge.ok ? 'pass' : 'fail';

  const summary = {
    project_ref: projectRef,
    supabase_url: supaUrl,
    results,
    durations_ms: {
      pgtap: pgtap.ms,
      integration: integration.ms,
      edge: edge.ms,
    }
  };
  fs.mkdirSync('tmp', { recursive: true });
  const outPath = path.join('tmp', `verify-summary-${projectRef || 'unknown'}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`[workspace/verify-cloud] Wrote ${outPath}`);

  if (!pgtap.ok || !integration.ok || !edge.ok) process.exit(1);
  console.log('[workspace/verify-cloud] All checks passed');
})().catch((err) => { console.error('[workspace/verify-cloud] Failed:', err.message); process.exit(1); });
