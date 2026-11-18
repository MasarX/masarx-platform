#!/usr/bin/env node
/* eslint-disable no-console */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { prepareFieldopsMapWorker } = require('./run-fieldops-expo');

function isUrlLike(value) {
  return /^(file|data|node):/i.test(String(value || '').trim());
}

function isWindowsAbsolutePath(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z]:[\\/]/u.test(text) || /^\\\\[^\\]+\\[^\\]+/u.test(text);
}

function windowsPathToFileUrl(value) {
  const resolved = path.win32.resolve(String(value || '').trim());
  if (/^\\\\/u.test(resolved)) {
    const withoutPrefix = resolved.replace(/^\\\\/u, '').replace(/\\/g, '/');
    const [host, ...segments] = withoutPrefix.split('/');
    return `file://${host}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
  }
  const normalized = resolved.replace(/\\/g, '/');
  const encoded = normalized.split('/').map((segment, index) => {
    if (index === 0 && /^[A-Za-z]:$/u.test(segment)) return `${segment[0].toUpperCase()}:`;
    return encodeURIComponent(segment);
  }).join('/');
  return `file:///${encoded}`;
}

function normalizeMetroConfigOverride(value, { cwd = process.cwd() } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isUrlLike(raw)) return raw;
  if (isWindowsAbsolutePath(raw)) return windowsPathToFileUrl(raw);

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
  normalizeConfigOverride = normalizeMetroConfigOverride,
} = {}) {
  const appRoot = path.resolve(env.FIELDOPS_APP_ROOT || path.join(repoRoot, 'apps', 'fieldops'));
  const configPath = env.FIELDOPS_METRO_CONFIG_PATH || path.join(appRoot, 'metro.config.js');
  const expoCli = require.resolve('expo/bin/cli', { paths: [appRoot] });
  const metroConfigOverride = normalizeConfigOverride(
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

  // The same staging contract applies to this direct Expo-start entrypoint.
  prepareFieldopsMapWorker(context.appRoot);
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
