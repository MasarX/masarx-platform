#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sanitizeEnvCloud } = require('./env-sanitize');

function safeUnlink(p) {
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`[workspace/reset] Removed ${p}`);
    }
  } catch (err) {
    console.warn(`[workspace/reset] Failed to remove ${p}:`, err.message);
  }
}

function restoreSupabaseConfig() {
  const baseline = path.join('supabase', '.temp', 'config.baseline.toml');
  const cfg = path.join('supabase', 'config.toml');
  if (fs.existsSync(baseline)) {
    try {
      fs.copyFileSync(baseline, cfg);
      console.log('[workspace/reset] Restored supabase/config.toml from baseline');
    } catch (err) {
      console.warn('[workspace/reset] Failed to restore supabase/config.toml:', err.message);
    }
  }
}

function clearLocalMetadata() {
  // Remove per-workspace local config/env
  safeUnlink(path.join('config', 'env', '.env.local'));

  // Clear supabase/.temp local metadata (ports, db containers, overlays can be rebuilt)
  const tempDir = path.join('supabase', '.temp');
  if (fs.existsSync(tempDir)) {
    try {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        if (
          file.startsWith('local_config_') ||
          file.startsWith('local_db_')
        ) {
          safeUnlink(path.join(tempDir, file));
        }
      }
    } catch (err) {
      console.warn('[workspace/reset] Failed to scan supabase/.temp:', err.message);
    }
  }
}

function resetCloudEnv() {
  const envPath = path.join('config', 'env', '.env.cloud');
  if (!fs.existsSync(envPath)) return;

  const changed = sanitizeEnvCloud(envPath);
  const msg = changed
    ? '[workspace/reset] Cleared project-specific fields from config/env/.env.cloud'
    : '[workspace/reset] No project-specific fields to clear in config/env/.env.cloud';
  console.log(msg);
}

function clearTmpArtifacts() {
  const tmpDir = path.join('tmp');
  if (!fs.existsSync(tmpDir)) return;
  try {
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      const p = path.join(tmpDir, entry);
      try {
        const stat = fs.statSync(p);
        if (stat.isFile()) {
          safeUnlink(p);
        }
      } catch (err) {
        console.warn('[workspace/reset] Failed to inspect tmp entry:', err.message);
      }
    }
  } catch (err) {
    console.warn('[workspace/reset] Failed to scan tmp/:', err.message);
  }
}

(function main() {
  // Stop Supabase local stack for this workspace before resetting files.
  try {
    const isWin = process.platform === 'win32';
    const supabaseArgs = ['--yes', 'supabase@2', 'stop'];
    const res = isWin
      ? spawnSync('cmd.exe', ['/c', 'npx', ...supabaseArgs], { stdio: 'inherit' })
      : spawnSync('npx', supabaseArgs, { stdio: 'inherit' });
    if (res.status !== 0 && res.status !== null) {
      console.warn('[workspace/reset] supabase stop exited with', res.status);
    } else {
      console.log('[workspace/reset] Supabase local stack stopped');
    }
  } catch (e) {
    console.warn('[workspace/reset] Failed to stop Supabase local stack:', e.message || e);
  }

  restoreSupabaseConfig();
  clearLocalMetadata();
  resetCloudEnv();
  clearTmpArtifacts();
  console.log('[workspace/reset] Workspace cleared. You can now run workspace:init for a fresh local + cloud setup.');
})();
