const BROWSER_PUBLIC_ENV_KEY_PREFIXES = Object.freeze([
  'NEXT_PUBLIC_',
  'VITE_',
]);

function isValidEnvKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key || '').trim());
}

function isBrowserPublicEnvKey(key) {
  const normalized = String(key || '').trim().toUpperCase();
  return BROWSER_PUBLIC_ENV_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isValidServerOnlyEnvKey(key) {
  return isValidEnvKey(key) && !isBrowserPublicEnvKey(key);
}

function parseEnvKeyList(value) {
  return String(value || '')
    .split(/[,\s]+/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry && isValidEnvKey(entry));
}

function parseServerOnlyEnvKeyList(value) {
  return parseEnvKeyList(value).filter((entry) => isValidServerOnlyEnvKey(entry));
}

function formatEnvValue(value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  if (/[\r\n]/.test(raw)) {
    return JSON.stringify(raw);
  }
  if (/[\s#"']/.test(raw)) {
    return JSON.stringify(raw);
  }
  return raw;
}

module.exports = {
  BROWSER_PUBLIC_ENV_KEY_PREFIXES,
  formatEnvValue,
  isBrowserPublicEnvKey,
  isValidEnvKey,
  isValidServerOnlyEnvKey,
  parseEnvKeyList,
  parseServerOnlyEnvKeyList,
};
