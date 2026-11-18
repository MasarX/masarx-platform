#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadEnv } = require('../../utils/load-env');
const { resolvePreviewSupabaseConfig } = require('./preview-supabase-config');
const { deleteProjectWithRetries } = require('./supabase-api');

loadEnv();

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return '';
}

(async () => {
  // Resolve the project ref from CLI args, ENV, or ENV_FILE *before* we
  // reset local state so that we can safely delete the cloud project.
  let projectRef = getArg('--af38b526-f5c1-468d-88fb-86677fbe872a') || process.env.SUPABASE_PROJECT_ID || '';
  const envFile = process.env.ENV_FILE || '';
  const cfg = resolvePreviewSupabaseConfig({ requirePreviewSecrets: false });
  const token = cfg.token || '';
  if (!projectRef && envFile && fs.existsSync(envFile)) {
    const env = Object.fromEntries(
      String(fs.readFileSync(envFile, 'utf8'))
        .split(/\n+/)
        .map((line) => line.split('='))
        .filter((kv) => kv[0])
    );
    projectRef = env.SUPABASE_PROJECT_ID || env['SUPABASE_PROJECT_ID'] || '';
  }
  if (!projectRef) {
    console.warn('[workspace/destroy] No SUPABASE_PROJECT_ID found; skipping remote delete.');
  }
  if (projectRef && !token) {
    throw new Error('SUPABASE_ACCESS_TOKEN is required to delete project/branch');
  }

  // First, tear down local state for this workspace (Supabase stack,
  // overlays, local env). This reuses the existing reset workflow so
  // behaviour stays consistent with workspace:reset.
  try {
    const nodeCmd = process.execPath || 'node';
    const resetPath = path.join('scripts', 'ops', 'workspace', 'reset.js');
    const res = spawnSync(nodeCmd, [resetPath], { stdio: 'inherit', env: process.env });
    if (res.status !== 0 && res.status !== null) {
      console.warn('[workspace/destroy] workspace reset exited with', res.status);
    } else {
      console.log('[workspace/destroy] Local Supabase stack and workspace env reset');
    }
  } catch (e) {
    console.warn('[workspace/destroy] Failed to reset local workspace state:', e.message || e);
  }

  // Then delete the corresponding cloud project/branch.
  if (projectRef && token) {
    try {
      await deleteProjectWithRetries(projectRef, token, {
        organizationId: cfg.orgId,
        timeoutMs: parseInt(process.env.WORKSPACE_DELETE_TIMEOUT_MS || '900000', 10) || 900000,
        intervalMs: parseInt(process.env.WORKSPACE_DELETE_INTERVAL_MS || '15000', 10) || 15000,
      });
      console.log(`[workspace/destroy] Deleted project/branch ${projectRef}`);
    } catch (err) {
      if (err && err.status === 404) {
        console.warn(
          `[workspace/destroy] Project ${projectRef} is already absent.`
        );
      } else {
        throw err;
      }
    }
  }
})().catch((err) => {
  console.error('[workspace/destroy] Failed:', err.message);
  process.exit(1);
});
