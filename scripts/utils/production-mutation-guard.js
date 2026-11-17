#!/usr/bin/env node
/**
 * Runtime helpers to keep write-heavy operational scripts fail-closed in production.
 *
 * Shared intent:
 * - Detect production targets using existing deploy environment contract.
 * - Block destructive/test mutations in production unless an explicit
 *   allow-production flag is provided.
 */

function parseEnabledFlag(value, fallback = false) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(raw)) return false;
  return fallback;
}

function resolveDeployEnvironmentName(env = process.env) {
  return String(
    env.DEPLOY_ENV ||
      env.DEPLOY_ENV_NAME ||
      env.GITHUB_ENVIRONMENT_NAME ||
      env.GITHUB_ENVIRONMENT ||
      ''
  )
    .trim()
    .toLowerCase();
}

function isProductionTarget(env = process.env) {
  if (String(env.PROD_DEPLOY_GUARD || '').trim().toLowerCase() === 'enabled') return true;
  const deployEnvName = resolveDeployEnvironmentName(env);
  return deployEnvName === 'prod' || /-prod$/.test(deployEnvName);
}

function assertMutationAllowed(options = {}) {
  const env = options.env || process.env;
  const operation = String(options.operation || 'mutation').trim();
  const allowProductionEnvVar = String(options.allowProductionEnvVar || '').trim();

  if (!allowProductionEnvVar) {
    throw new Error(
      `[production-mutation-guard] Missing allowProductionEnvVar for operation=${operation}.`,
    );
  }

  if (!isProductionTarget(env)) return;

  if (!parseEnabledFlag(env[allowProductionEnvVar], false)) {
    throw new Error(
      `[${operation}] Refusing to run against production by default. ` +
        `Set ${allowProductionEnvVar}=1 only for explicit, reviewed execution.`,
    );
  }
}

module.exports = {
  parseEnabledFlag,
  resolveDeployEnvironmentName,
  isProductionTarget,
  assertMutationAllowed,
};
