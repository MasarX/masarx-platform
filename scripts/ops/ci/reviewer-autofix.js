#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require('child_process');

function parseCommands(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function runShell(command, env = process.env) {
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return typeof result.status === 'number' ? result.status : 1;
}

function main() {
  const commands = parseCommands(process.env.REVIEWER_AUTOFIX_STEPS);
  if (!commands.length) {
    console.log('[reviewer:autofix] No autofix steps configured (set REVIEWER_AUTOFIX_STEPS).');
    process.exit(0);
  }
  console.log(`[reviewer:autofix] Running ${commands.length} autofix step(s).`);
  for (const cmd of commands) {
    console.log(`[reviewer:autofix] ${cmd}`);
    const status = runShell(cmd);
    if (status !== 0) {
      console.error(`[reviewer:autofix] FAILED: ${cmd} (exit ${status})`);
      process.exit(status);
    }
  }
  console.log('[reviewer:autofix] Completed.');
}

if (require.main === module) {
  main();
}

module.exports = {
  parseCommands,
};
