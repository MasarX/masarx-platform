const { isPreviewEnv } = require('./assert-cloud-env');

function normalizeBool(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

function normalizeBoolFalse(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'false' || v === '0';
}

function shouldIncludeAllMigrations(env = process.env) {
  const e = env && typeof env === 'object' ? env : {};
  const explicit = String(e.SUPABASE_DB_PUSH_INCLUDE_ALL || '').trim();
  if (explicit) {
    if (normalizeBool(explicit)) return true;
    if (normalizeBoolFalse(explicit)) return false;
  }
  if (isPreviewEnv(e)) return true;
  if (normalizeBool(e.GITHUB_ACTIONS)) return true;
  if (normalizeBool(e.CI)) return true;
  return false;
}

module.exports = {
  shouldIncludeAllMigrations,
};
