#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require('child_process');

function main() {
  // Best-effort GC: attempt to stop any Compose projects that match masarx-wk-
  // Since Supabase CLI manages the compose project internally, we rely on docker commands.
  // This is intentionally conservative to avoid disrupting non-MasarX projects.
  const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (ps.status !== 0) {
    console.warn('[workspace/local-gc] docker ps failed; skipping');
    return;
  }
  const names = ps.stdout.split(/\r?\n/).filter(Boolean);
  const targets = names.filter((n) => /masarx-wk-/i.test(n));
  if (!targets.length) {
    console.log('[workspace/local-gc] No masarx-wk-* containers running');
    return;
  }
  console.log(`[workspace/local-gc] Stopping ${targets.length} containers matching masarx-wk-*`);
  for (const name of targets) {
    spawnSync('docker', ['stop', name], { stdio: 'inherit' });
  }
}

main();
