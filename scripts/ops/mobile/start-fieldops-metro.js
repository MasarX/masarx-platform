#!/usr/bin/env node
/* eslint-disable no-console */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function isUrlLike(value) {
  return /^(file|data|node):/i.test(String(value || '').trim());
}

function normalizeMetroConfigOverride(value, { cwd = process.cwd() } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isUrlLike(raw)) return raw;

  const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  return pathToFileURL(resolved).href;
}

function hasHostModeArg(argv) {
  return argv.some((arg) => {
    const value = String(arg || '');
    return (
      value === '--localhost' ||
      value === '--lan' ||
      value === '--tunnel' ||
      value === '--host' ||
      value === '-m' ||
      value.startsWith('--host=') ||
      value.startsWith('-m=')
    );
  });
}

function normalizeExpoStartArgs(argv = []) {
  const args = [...argv];
  if (!hasHostModeArg(args)) {
    args.push('--localhost');
  }
  return args;
}

function resolveRepoRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function buildLaunchContext({
  argv = process.argv.slice(2),
  env = process.env,
  repoRoot = resolveRepoRoot(),
} = {}) {
  const appRoot = path.resolve(env.FIELDOPS_APP_ROOT || path.join(repoRoot, 'apps', 'fieldops'));
  const configPath = path.resolve(
    env.FIELDOPS_METRO_CONFIG_PATH || path.join(appRoot, 'metro.config.js'),
  );
  const expoCli = require.resolve('expo/bin/cli', { paths: [appRoot] });
  const metroConfigOverride = normalizeMetroConfigOverride(
    env.EXPO_OVERRIDE_METRO_CONFIG || configPath,
    { cwd: appRoot },
  );

  return {
    appRoot,
    args: [expoCli, 'start', ...normalizeExpoStartArgs(argv)],
    command: process.execPath,
    env: {
      ...env,
      EXPO_OVERRIDE_METRO_CONFIG: metroConfigOverride,
    },
    metroConfigOverride,
  };
}

function main() {
  const context = buildLaunchContext();
  if (!fs.existsSync(path.join(context.appRoot, 'package.json'))) {
    throw new Error(`[fieldops-metro] FieldOps app root is invalid: ${context.appRoot}`);
  }

  const child = spawn(context.command, context.args, {
    cwd: context.appRoot,
    env: context.env,
    stdio: 'inherit',
    windowsHide: false,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildLaunchContext,
  normalizeExpoStartArgs,
  normalizeMetroConfigOverride,
};
