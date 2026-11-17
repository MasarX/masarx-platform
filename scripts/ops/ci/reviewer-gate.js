#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require('child_process');

function parseSteps(raw) {
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

function defaultSteps() {
  return [
    'npm run lint:structure',
    'npm run test:unit',
  ];
}

function main() {
  const steps = parseSteps(process.env.REVIEWER_GATE_STEPS);
  const commands = steps.length ? steps : defaultSteps();
  console.log(`[reviewer:gate] Running ${commands.length} step(s).`);
  for (const cmd of commands) {
    console.log(`[reviewer:gate] ${cmd}`);
    const status = runShell(cmd);
    if (status !== 0) {
      console.error(`[reviewer:gate] FAILED: ${cmd} (exit ${status})`);
      process.exit(status);
    }
  }
  console.log('[reviewer:gate] All steps passed.');
}

if (require.main === module) {
  main();
}

module.exports = {
  defaultSteps,
  parseSteps,
};
