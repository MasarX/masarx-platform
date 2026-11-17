#!/usr/bin/env node
/* eslint-disable no-console */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const fieldopsRoot = path.join(repoRoot, 'apps', 'fieldops');
const peerResolverPath = path.join(__dirname, 'fieldops-expo-peer-resolver.cjs');
const expoCliPath = path.join(fieldopsRoot, 'node_modules', 'expo', 'bin', 'cli');

function quoteNodeOptionsValue(value) {
  const text = String(value || '');
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function appendNodeRequireOption(existingNodeOptions, requirePath) {
  const existing = String(existingNodeOptions || '').trim();
  const resolvedRequirePath = path.resolve(requirePath);
  if (existing.includes(resolvedRequirePath)) {
    return existing;
  }
  const addition = `--require ${quoteNodeOptionsValue(resolvedRequirePath)}`;
  return [existing, addition].filter(Boolean).join(' ');
}

function buildFieldopsExpoEnv(env = process.env) {
  return {
    ...env,
    FIELDOPS_EXPO_PROJECT_ROOT: fieldopsRoot,
    NODE_OPTIONS: appendNodeRequireOption(env.NODE_OPTIONS, peerResolverPath),
  };
}

function run(argv = process.argv.slice(2), env = process.env) {
  if (!fs.existsSync(expoCliPath)) {
    throw new Error(`Missing FieldOps Expo CLI at ${expoCliPath}`);
  }
  const result = spawnSync(process.execPath, [expoCliPath, ...argv], {
    cwd: fieldopsRoot,
    env: buildFieldopsExpoEnv(env),
    stdio: 'inherit',
  });
  return typeof result.status === 'number' ? result.status : 1;
}

if (require.main === module) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  appendNodeRequireOption,
  buildFieldopsExpoEnv,
  quoteNodeOptionsValue,
  run,
};
