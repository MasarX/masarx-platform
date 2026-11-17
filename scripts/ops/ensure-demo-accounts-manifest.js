#!/usr/bin/env node
/**
 * ensure-demo-accounts-manifest.js
 *
 * Ensures Playwright E2E has a usable demo-accounts manifest at runtime.
 *
 * Why:
 * - The UI E2E suite runs in STRICT mode in CI (`STRICT_E2E_GATE_ENV=true`) and fails if the
 *   demo accounts manifest is missing.
 * - Provisioning is safe in non-production environments when guarded.
 *
 * Behavior:
 * - If the manifest exists and `--force` is not set: no-op.
 * - If missing:
 *   - In strict mode: auto-provision only when `DEMO_ACCOUNTS_PROVISION_GUARD` is truthy (`enabled|true|1`),
 *     otherwise fail with an actionable error.
 *   - In non-strict mode: skip unless `DEMO_ACCOUNTS_PROVISION_GUARD` is truthy.
 * - Refuses to provision in production unless `DEMO_ACCOUNTS_ALLOW_PRODUCTION=true`.
 *
 * Inputs:
 * - CLI:
 *   - --out <path> (default: $DEMO_ACCOUNTS_PATH or tmp/demo-accounts.json)
 *   - --config <path> (default: config/demo/demo-accounts.json)
 *   - --force (provision even if manifest exists)
 * - Env (read-only):
 *   - DEMO_ACCOUNTS_PROVISION_GUARD=enabled|true|1
 *   - DEMO_ACCOUNTS_ALLOW_PRODUCTION=true|false
 *   - STRICT_E2E_GATE_ENV=true|false
 *   - CI=true|false
 *
 * Provisioner:
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseFlagArgs } = require('../utils/cli-args');
const { loadEnv } = require('../utils/load-env');

function isTruthy(value) {
  return /^(1|true|yes|on|enabled)$/i.test(String(value || '').trim());
}

function isStrict(env) {
  return isTruthy(env.STRICT_E2E_GATE_ENV) || isTruthy(env.CI);
}

function die(msg) {
  console.error(`[ensure-demo-accounts] ${msg}`);
  process.exit(1);
}

function parseArgs(argvInput) {
  const args = parseFlagArgs(Array.isArray(argvInput) ? argvInput : []);
  const outPath = String(args.out || '').trim();
  const configPath = String(args.config || '').trim();
  const force = isTruthy(args.force);
  return { outPath, configPath, force };
}

function resolveManifestPath({ args, env, cwd }) {
  const explicit = String(args.outPath || '').trim();
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit);
  const fromEnv = String(env.DEMO_ACCOUNTS_PATH || '').trim();
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(cwd, fromEnv);
  return path.resolve(cwd, 'tmp', 'demo-accounts.json');
}

function resolveConfigPath({ args, cwd }) {
  const explicit = String(args.configPath || '').trim();
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit);
  return path.resolve(cwd, 'config', 'demo', 'demo-accounts.json');
}

function guardAllowsProvision(env) {
  return isTruthy(env.DEMO_ACCOUNTS_PROVISION_GUARD);
}

function isProductionEnv(env) {
  // Prod deploy runs export PROD_DEPLOY_GUARD=enabled in the prod GH environment.
  if (isTruthy(env.PROD_DEPLOY_GUARD)) return true;
  const deployEnvName = String(
    env.DEPLOY_ENV || env.DEPLOY_ENV_NAME || env.GITHUB_ENVIRONMENT_NAME || env.GITHUB_ENVIRONMENT || ''
  )
    .trim()
    .toLowerCase();
  return deployEnvName === 'prod' || /-prod$/.test(deployEnvName);
}

function validateManifestContents({ manifestPath, fsImpl }) {
  let raw = '';
  try {
    raw = String(fsImpl.readFileSync(manifestPath, 'utf8') || '');
  } catch (e) {
    throw new Error(`Unable to read manifest: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Manifest JSON parse failed: ${e.message}`);
  }
  const users = Array.isArray(parsed?.users) ? parsed.users : [];
  if (users.length === 0) {
    throw new Error('Manifest contains no users; provisioning did not produce a usable user pool.');
  }
  return { ok: true, userCount: users.length };
}

function ensureDemoAccountsManifest({
  argv,
  env,
  cwd = process.cwd(),
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  const args = parseArgs(argv || []);
  const manifestPath = resolveManifestPath({ args, env: env || {}, cwd });
  const configPath = resolveConfigPath({ args, cwd });
  const strict = isStrict(env || {});
  const exists = fsImpl.existsSync(manifestPath);

  if (exists && !args.force) {
    const validated = validateManifestContents({ manifestPath, fsImpl });
    console.log(`[ensure-demo-accounts] OK: manifest present (${validated.userCount} user(s)) at ${path.relative(cwd, manifestPath)}`);
    return { ok: true, action: 'exists', manifestPath, userCount: validated.userCount };
  }

  const canProvision = guardAllowsProvision(env || {});
  if (!canProvision) {
    const rel = path.relative(cwd, manifestPath);
    if (strict) {
      throw new Error(
        [
          `Demo accounts manifest is missing (${rel}) and strict mode is enabled.`,
          'Enable auto-provisioning by setting DEMO_ACCOUNTS_PROVISION_GUARD=enabled (or true) in the target GitHub Environment,',
          'or provision manually:',
          `  node scripts/ops/provision-demo-accounts.js --out ${rel}`,
        ].join('\n'),
      );
    }
    console.log(`[ensure-demo-accounts] Skip: manifest missing (${rel}) and DEMO_ACCOUNTS_PROVISION_GUARD is not truthy.`);
    return { ok: true, action: 'skipped', manifestPath, reason: 'guard_disabled' };
  }

  if (isProductionEnv(env || {}) && !isTruthy((env || {}).DEMO_ACCOUNTS_ALLOW_PRODUCTION)) {
    throw new Error(
      [
        'Refusing to provision demo accounts in production.',
        'Set DEMO_ACCOUNTS_ALLOW_PRODUCTION=true only if you explicitly accept creating test identities in production.',
      ].join(' '),
    );
  }

  if (!fsImpl.existsSync(configPath)) {
    throw new Error(`Demo accounts config file missing: ${path.relative(cwd, configPath)}`);
  }

  fsImpl.mkdirSync(path.dirname(manifestPath), { recursive: true });

  const node = process.execPath;
  const scriptPath = path.join('scripts', 'ops', 'provision-demo-accounts.js');
  const cmdArgs = [scriptPath, '--config', path.relative(cwd, configPath), '--out', path.relative(cwd, manifestPath)];

  console.log(`[ensure-demo-accounts] Provisioning demo accounts -> ${path.relative(cwd, manifestPath)}`);
  const res = spawnSyncImpl(node, cmdArgs, {
    cwd,
    env: { ...(env || {}), DEMO_ACCOUNTS_PATH: manifestPath },
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Provisioning failed (exit ${res.status})`);

  const validated = validateManifestContents({ manifestPath, fsImpl });
  console.log(`[ensure-demo-accounts] OK: provisioned (${validated.userCount} user(s))`);
  return { ok: true, action: 'provisioned', manifestPath, userCount: validated.userCount };
}

function main() {
  loadEnv();
  try {
    ensureDemoAccountsManifest({ argv: process.argv.slice(2), env: process.env });
  } catch (e) {
    die(e.message || String(e));
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  resolveManifestPath,
  resolveConfigPath,
  isStrict,
  guardAllowsProvision,
  isProductionEnv,
  validateManifestContents,
  ensureDemoAccountsManifest,
};
