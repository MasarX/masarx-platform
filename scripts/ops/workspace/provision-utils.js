function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function isFalsy(value) {
  return /^(0|false|no)$/i.test(String(value || '').trim());
}

function resolveProvisionFixJwtSecret({
  argv = [],
  env = process.env,
  edgeRequireDbJwt = '1',
  projectWasCreated = false,
} = {}) {
  if (String(edgeRequireDbJwt || '').trim() !== '1') return false;

  const args = Array.isArray(argv) ? argv : [];
  const explicit =
    args.includes('--fix-jwt-secret') ||
    args.includes('--rotate-jwt-secret') ||
    args.some((value) => /^(?:fix-jwt-secret|rotate-jwt-secret)$/i.test(String(value || '').trim()));

  const e = env && typeof env === 'object' ? env : process.env;
  const optIn =
    isTruthy(e.WORKSPACE_FIX_JWT_SECRET) ||
    // npm may strip unknown `--flag` args but still expose them as npm_config_*.
    isTruthy(e.npm_config_fix_jwt_secret) ||
    isTruthy(e.npm_config_rotate_jwt_secret);

  return Boolean(projectWasCreated || explicit || optIn);
}

function resolveProvisionRequireLeastPrivilege({
  env = process.env,
} = {}) {
  const e = env && typeof env === 'object' ? env : process.env;
  if (isTruthy(e.WORKSPACE_ALLOW_PREVIEW_FALLBACK)) return false;
  if (isFalsy(e.WORKSPACE_REQUIRE_LEAST_PRIVILEGE)) return false;
  return true;
}

function resolveProvisionAutoPreviewFallbackOnStrictFailure({
  env = process.env,
  projectWasCreated = false,
} = {}) {
  if (!projectWasCreated) return false;
  const e = env && typeof env === 'object' ? env : process.env;
  return !isFalsy(e.WORKSPACE_AUTO_PREVIEW_FALLBACK_ON_STRICT_FAIL || '1');
}

function resolveProvisionPushRetryConfig({
  env = process.env,
  projectWasCreated = false,
} = {}) {
  const e = env && typeof env === 'object' ? env : process.env;
  const defaults = projectWasCreated
    ? {
      attempts: '10',
      baseDelayMs: '20000',
      maxDelayMs: '180000',
    }
    : {
      attempts: '5',
      baseDelayMs: '15000',
      maxDelayMs: '120000',
    };

  return {
    attempts: String(e.SUPABASE_CLI_PUSH_RETRY_ATTEMPTS || defaults.attempts).trim() || defaults.attempts,
    baseDelayMs: String(e.SUPABASE_CLI_PUSH_RETRY_BASE_DELAY_MS || defaults.baseDelayMs).trim() || defaults.baseDelayMs,
    maxDelayMs: String(e.SUPABASE_CLI_PUSH_RETRY_MAX_DELAY_MS || defaults.maxDelayMs).trim() || defaults.maxDelayMs,
  };
}

module.exports = {
  isFalsy,
  isTruthy,
  resolveProvisionAutoPreviewFallbackOnStrictFailure,
  resolveProvisionFixJwtSecret,
  resolveProvisionPushRetryConfig,
  resolveProvisionRequireLeastPrivilege,
};
