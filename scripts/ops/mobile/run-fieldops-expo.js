#!/usr/bin/env node
/* eslint-disable no-console */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { prepareMapWorker } = require('../../frontend/prepare-map-worker');
const { runGit } = require('../workspace/docker-runtime/git-metadata');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const fieldopsRoot = path.join(repoRoot, 'apps', 'fieldops');
const peerResolverPath = path.join(__dirname, 'fieldops-expo-peer-resolver.cjs');
const expoPublicAliasKeys = [
  'APP_NAME',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
  'AUTH_METHODS',
  'LOCALE',
];

function resolveFieldopsRepoRoot() {
  // Probe the checkout containing this launcher, not the caller's cwd.
  const resolved = runGit(repoRoot, ['rev-parse', '--show-toplevel']);
  if (!resolved.ok || !resolved.value) {
    throw new Error('FieldOps Android install requires a readable Git worktree root.');
  }
  const expectedRoot = fs.realpathSync(repoRoot);
  const gitRoot = fs.realpathSync(resolved.value);
  if (gitRoot !== expectedRoot) {
    throw new Error('FieldOps Android Git root does not match the launcher checkout.');
  }
  return gitRoot;
}

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
  const nextEnv = {
    ...env,
    FIELDOPS_EXPO_PROJECT_ROOT: fieldopsRoot,
    NODE_OPTIONS: appendNodeRequireOption(env.NODE_OPTIONS, peerResolverPath),
  };
  for (const suffix of expoPublicAliasKeys) {
    const expoKey = `EXPO_PUBLIC_${suffix}`;
    const nextKey = `NEXT_PUBLIC_${suffix}`;
    if (!nextEnv[expoKey] && env[nextKey]) {
      nextEnv[expoKey] = env[nextKey];
    }
  }
  return nextEnv;
}

function prepareFieldopsMapWorker(projectRoot = fieldopsRoot) {
  return prepareMapWorker(projectRoot);
}

function run(argv = process.argv.slice(2), env = process.env, { prepareMapWorker = prepareFieldopsMapWorker } = {}) {
  const projectRoot = argv[0] === 'run:android'
    ? path.join(resolveFieldopsRepoRoot(), 'apps', 'fieldops')
    : fieldopsRoot;
  const expoCliPath = path.join(projectRoot, 'node_modules', 'expo', 'bin', 'cli');
  if (!fs.existsSync(expoCliPath)) {
    throw new Error(`Missing FieldOps Expo CLI at ${expoCliPath}`);
  }
  // Interactive start may open web later; native run:android/run:ios remain untouched.
  if (!argv[0] || argv[0] === 'start' || argv[0] === 'export') prepareMapWorker(projectRoot);
  const result = spawnSync(process.execPath, [expoCliPath, ...argv], {
    cwd: projectRoot,
    env: { ...buildFieldopsExpoEnv(env), FIELDOPS_EXPO_PROJECT_ROOT: projectRoot },
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
  prepareFieldopsMapWorker,
  appendNodeRequireOption,
  buildFieldopsExpoEnv,
  quoteNodeOptionsValue,
  resolveFieldopsRepoRoot,
  run,
};
