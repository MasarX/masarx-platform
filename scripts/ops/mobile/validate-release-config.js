#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { parseFlagArgs } = require('../../utils/cli-args');
const { resolveRepoRoot } = require('../fieldops-release-contract');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(normalizeString(value));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function resolveAppDir(startDir) {
  const repoRoot = resolveRepoRoot(startDir || process.cwd());
  return path.join(repoRoot, 'apps', 'fieldops');
}

function loadEasProfileEnv({ appDir, profile }) {
  const normalizedProfile = normalizeString(profile);
  if (!normalizedProfile) return {};
  const easJsonPath = path.join(appDir, 'eas.json');
  if (!fs.existsSync(easJsonPath)) {
    throw new Error(`[mobile-validate-release-config] Missing ${easJsonPath}`);
  }
  const payload = readJson(easJsonPath);
  const env = payload?.build?.[normalizedProfile]?.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, normalizeString(value)]).filter(([, value]) => value),
  );
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = parseFlagArgs(argv);
  return {
    appDir: normalizeString(args['app-dir']) || '',
    executeRelease: isTruthy(args['execute-release']),
    easCliVersion: normalizeString(args['eas-cli-version']) || normalizeString(process.env.EAS_CLI_VERSION) || '18.0.1',
    platform: normalizeString(args.platform) || 'all',
    profile: normalizeString(args.profile) || 'stg',
  };
}

function buildValidationPlan({
  appDir,
  easCliVersion,
  env = process.env,
  executeRelease = false,
  platform = 'all',
  profile = 'stg',
} = {}) {
  const targetAppDir = appDir || resolveAppDir(process.cwd());
  const profileEnv = loadEasProfileEnv({ appDir: targetAppDir, profile });
  const mergedEnv = {
    ...env,
    ...profileEnv,
  };
  const hasExpoToken = Boolean(normalizeString(mergedEnv.EXPO_TOKEN));
  const useEasConfig = Boolean(executeRelease) || hasExpoToken;
  const normalizedPlatform = normalizeString(platform) || 'all';
  const platforms = normalizedPlatform === 'all' ? ['android', 'ios'] : [normalizedPlatform];

  const versionStep = {
    label: 'tool-version',
    cmd: 'npx',
    args: [useEasConfig ? `eas-cli@${easCliVersion}` : 'expo', '--version'],
  };

  if (useEasConfig) {
    const steps = [
      versionStep,
      ...platforms.map((targetPlatform) => ({
        label: `eas-config-${targetPlatform}`,
        cmd: 'npx',
        args: [
          `eas-cli@${easCliVersion}`,
          'config',
          '--profile',
          profile,
          '--platform',
          targetPlatform,
          '--non-interactive',
        ],
      })),
    ];
    return {
      appDir: targetAppDir,
      env: mergedEnv,
      mode: 'eas-config',
      steps,
    };
  }

  return {
    appDir: targetAppDir,
    env: mergedEnv,
    mode: 'local-expo-config',
    steps: [
      versionStep,
      {
        label: 'expo-config',
        cmd: 'npx',
        args: ['expo', 'config', '--json'],
      },
    ],
  };
}

function runStep({ step, cwd, env, spawnSyncImpl = spawnSync }) {
  const result = spawnSyncImpl(step.cmd, step.args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform.startsWith('win') && step.cmd.toLowerCase() === 'npm',
  });
  if (result?.error) {
    throw new Error(`[mobile-validate-release-config] ${step.label} failed: ${result.error.message}`);
  }
  if (result?.status !== 0) {
    throw new Error(
      `[mobile-validate-release-config] ${step.label} failed with exit code ${result?.status ?? '<unknown>'}.`,
    );
  }
}

function runValidation(options = {}) {
  const plan = buildValidationPlan(options);
  for (const step of plan.steps) {
    runStep({
      step,
      cwd: plan.appDir,
      env: plan.env,
      spawnSyncImpl: options.spawnSyncImpl || spawnSync,
    });
  }
  return plan;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = runValidation({
    appDir: args.appDir || resolveAppDir(process.cwd()),
    easCliVersion: args.easCliVersion,
    env: process.env,
    executeRelease: args.executeRelease,
    platform: args.platform,
    profile: args.profile,
  });
  console.log(
    `[mobile-validate-release-config] mode=${plan.mode} profile=${args.profile} platform=${args.platform}`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  buildValidationPlan,
  loadEasProfileEnv,
  parseArgs,
  resolveAppDir,
  runStep,
  runValidation,
};
