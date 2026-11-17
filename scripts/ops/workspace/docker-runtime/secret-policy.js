const SENSITIVE_KEY_SEGMENTS = Object.freeze([
  'ANON',
  'API_KEY',
  'AWS_ACCESS_KEY_ID',
  'CREDENTIAL',
  'CREDENTIALS',
  'DATABASE_URL',
  'DB_URL',
  'JWT',
  'KEY',
  'PASS',
  'PASSPHRASE',
  'PASSWORD',
  'PRIVATE_KEY',
  'PUBLISHABLE_KEY',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'SALT',
  'SECRET',
  'SECRET_KEY',
  'SERVICE_ROLE',
  'STORAGE_KEY',
  'TOKEN',
]);

const SENSITIVE_EXACT_KEYS = Object.freeze(new Set([
  'PGPASSWORD',
]));

const SAFE_METADATA_PATH_RULES = Object.freeze({
  AUTH_PASSWORD_FILE: /\.txt$/iu,
  DOCKER_RUNTIME_AUTH_MANIFEST: /\.json$/iu,
  DOCKER_RUNTIME_AUTH_PASSWORD_FILE: /\.txt$/iu,
  DOCKER_RUNTIME_AUTH_PROOF_SUMMARY: /\.json$/iu,
  DOCKER_RUNTIME_BACKEND_PROOF_SUMMARY: /\.json$/iu,
  DOCKER_RUNTIME_BROWSER_PROOF_SUMMARY: /\.json$/iu,
  DOCKER_RUNTIME_DEPENDENCY_SUMMARY_OUT: /\.json$/iu,
  DOCKER_RUNTIME_PROOF_SUMMARY_OUT: /\.json$/iu,
});

const SAFE_SECRET_BOUNDARY_VALUES = Object.freeze(new Set([
  'backend attribution audit reports keys and ports only; database URLs remain redacted',
  'database_urls_redacted_tokens_omitted',
  'env_presence_only_no_values',
  'peer_database_urls_only_in_runtime_env_and_redacted_from_summaries',
]));

function normalizeSensitiveKey(key = '') {
  return String(key || '')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeExpectedValues(expectedValues = {}) {
  return new Map(Object.entries(expectedValues || {}).map(([key, value]) => [
    normalizeSensitiveKey(key),
    String(value ?? ''),
  ]));
}

function isBoundedArtifactPath(key, value = '') {
  const normalizedKey = normalizeSensitiveKey(key);
  const rule = SAFE_METADATA_PATH_RULES[normalizedKey];
  const candidate = String(value ?? '').trim();
  if (!rule || !candidate || candidate.length > 4096) return false;
  if (/[\0\r\n]/u.test(candidate) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate)) return false;
  return rule.test(candidate.replace(/\\/g, '/'));
}

function isExpectedSafeMetadataAssignment(key, value, expectedValues = {}) {
  const normalizedKey = normalizeSensitiveKey(key);
  const candidate = String(value ?? '');
  if (normalizedKey === 'SECRET_BOUNDARY') {
    return SAFE_SECRET_BOUNDARY_VALUES.has(candidate);
  }
  const expected = normalizeExpectedValues(expectedValues);
  if (normalizedKey === 'SCHEMA_KEY') {
    return /^supabase-migrations:[0-9a-f]{32}$/u.test(candidate) && candidate === expected.get(normalizedKey);
  }
  if (normalizedKey === 'SCHEMA_KEY_SOURCE') {
    return candidate === 'supabase-migrations-content-sha256'
      && candidate === expected.get(normalizedKey);
  }
  if (normalizedKey === 'TRANSITION_DESIRED_SCHEMA_KEY') {
    return /^supabase-migrations:[0-9a-f]{32}$/u.test(candidate)
      && candidate === expected.get(normalizedKey);
  }
  if (
    Object.prototype.hasOwnProperty.call(SAFE_METADATA_PATH_RULES, normalizedKey)
    && candidate === expected.get(normalizedKey)
  ) {
    return isBoundedArtifactPath(normalizedKey, candidate);
  }
  return false;
}

function isSensitiveCredentialKey(key = '') {
  const normalizedKey = normalizeSensitiveKey(key);
  if (!normalizedKey) return false;
  if (SENSITIVE_EXACT_KEYS.has(normalizedKey)) return true;
  return SENSITIVE_KEY_SEGMENTS.some((segment) => (
    normalizedKey === segment ||
    normalizedKey.startsWith(`${segment}_`) ||
    normalizedKey.endsWith(`_${segment}`) ||
    normalizedKey.includes(`_${segment}_`)
  ));
}

function isSensitiveRuntimeAssignment(key, value = '', options = {}) {
  if (isExpectedSafeMetadataAssignment(key, value, options.expectedSafeMetadataValues)) return false;
  const normalizedKey = normalizeSensitiveKey(key);
  return Object.prototype.hasOwnProperty.call(SAFE_METADATA_PATH_RULES, normalizedKey) ||
    isSensitiveCredentialKey(normalizedKey);
}

module.exports = {
  SAFE_METADATA_PATH_RULES,
  isBoundedArtifactPath,
  isExpectedSafeMetadataAssignment,
  isSensitiveCredentialKey,
  isSensitiveRuntimeAssignment,
  normalizeSensitiveKey,
};
