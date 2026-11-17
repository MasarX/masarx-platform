#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require('child_process');

function runNpmScript(script, label = script) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'cmd.exe' : 'npm';
  const args = isWin ? ['/c', 'npm', 'run', script] : ['run', script];
  console.log(`[workspace/init] Running ${label}...`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', env: process.env });
  const code = typeof res.status === 'number' ? res.status : 1;
  if (code !== 0) {
    console.error(`[workspace/init] ${label} failed with code ${res.status}`);
    process.exit(code);
  }
}

(function main() {
  // Local stack: configure, generate env, start DB, run tests + edge smoke.
  runNpmScript('local:configure', 'local:configure');
  runNpmScript('local:env', 'local:env');
  runNpmScript('local:start', 'local:start');
  runNpmScript('local:verify', 'local:verify');

  // Cloud stack: provision project, apply migrations, deploy edge functions, run tests.
  runNpmScript('cloud:provision', 'cloud:provision');

  console.log('[workspace/init] Workspace local + cloud initialization complete');
})();

