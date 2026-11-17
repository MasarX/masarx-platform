const path = require('path');
const { loadEnv } = require('../../scripts/utils/load-env');

loadEnv();

function missingEnvVars(vars) {
  return vars.filter((name) => !process.env[name]);
}

function skipIfMissing(vars, context) {
  const missing = missingEnvVars(vars);
  if (missing.length) {
    if (String(process.env.STRICT_CORE_ENV || '').toLowerCase() === 'true') {
      throw new Error(
        `[test-skip] Missing environment variables for ${context}: ${missing.join(', ')}`
      );
    }
    console.warn(
      `[test-skip] Skipping ${context} - missing environment variables: ${missing.join(', ')}`
    );
    return missing;
  }
  return null;
}

module.exports = {
  missingEnvVars,
  skipIfMissing,
  requireEnv: skipIfMissing
};
