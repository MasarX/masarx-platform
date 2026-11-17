const AUTH_SIGNATURE_MODE_PATTERN =
  /signature verification failed|invalid compact jws|invalid jwt|jwt malformed|token contains an invalid number of segments|unable to parse or verify signature|signature is invalid|no suitable key/i;

function appendErrorFragments(parts, value, depth = 0) {
  if (depth > 3 || value == null) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    if (!text) return;
    if (!parts.includes(text)) parts.push(text);
    return;
  }

  if (value instanceof Error) {
    appendErrorFragments(parts, value.message, depth + 1);
    return;
  }

  if (Array.isArray(value)) {
    value.slice(0, 10).forEach((entry) => appendErrorFragments(parts, entry, depth + 1));
    return;
  }

  if (typeof value !== 'object') return;

  const keys = [
    'message',
    'error',
    'error_reason',
    'error_description',
    'reason',
    'description',
    'details',
    'hint',
    'body',
    'raw',
    'context',
    'statusText',
    'renderer_metadata',
  ];

  for (const key of keys) {
    if (!(key in value)) continue;
    appendErrorFragments(parts, value[key], depth + 1);
  }
}

function formatAuthSignatureContext(value) {
  const parts = [];
  appendErrorFragments(parts, value, 0);
  return parts.join(' | ');
}

function isAuthSignatureModeError(value) {
  return AUTH_SIGNATURE_MODE_PATTERN.test(formatAuthSignatureContext(value));
}

function logAuthSignatureModeSkip(scope, value) {
  const context = formatAuthSignatureContext(value);
  // eslint-disable-next-line no-console
  console.warn(`[${scope}] skipped due to auth signature mode`, context || 'auth signature verification mismatch');
}

module.exports = {
  AUTH_SIGNATURE_MODE_PATTERN,
  formatAuthSignatureContext,
  isAuthSignatureModeError,
  logAuthSignatureModeSkip,
};
