const SECRET_SCAN_PATTERNS = [
  {
    id: 'postgres_connection_password',
    pattern: /\bpostgres(?:ql)?:\/\/[^/\s"'<>:@]+:[^@\s"'<>]+@[^\s"'<>]+/giu,
  },
  {
    id: 'jwt_token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  },
  {
    id: 'supabase_secret_key',
    pattern: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/giu,
  },
  {
    id: 'bearer_token',
    pattern: /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{16,}\b/giu,
  },
  {
    id: 'cookie_header',
    pattern: /\b(?:cookie|set-cookie)\s*[:=]\s*(?!\[redacted\])[^;\r\n=]+=[^\r\n]+/giu,
  },
  {
    id: 'secret_assignment',
    scan: scanSecretAssignments,
  },
  {
    id: 'password_grant',
    pattern: /\bgrant_type=password\b|\bpassword\s*[:=]\s*(?!\[redacted\])[^&\s\r\n]{6,}/giu,
  },
];

function scanSecretAssignments(source = '') {
  const text = String(source || '');
  const sensitiveTerm = '(?:SERVICE_ROLE|ANON|JWT|SECRET|PASSWORD|TOKEN|DATABASE_URL|DB_URL|S3_SECRET_KEY|S3_ACCESS_KEY|STORAGE_KEY|PUBLISHABLE_KEY|SECRET_KEY|SALT)';
  const assignmentRes = [
    new RegExp(`["'](?<key>[A-Z0-9_ -]*${sensitiveTerm}[A-Z0-9_ -]*)["']\\s*:\\s*(?<value>"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\r\\n,}\\]]+)`, 'giu'),
    new RegExp(`(?:^|[\\s"'])(?<key>[A-Z0-9_ -]*${sensitiveTerm}[A-Z0-9_ -]*)=(?<value>[^\\s"',}\\]]+)`, 'gimu'),
  ];
  const matches = [];
  const normalizeKey = (key) => String(key || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const hasSensitiveSegment = (normalizedKey) => (
    /(?:^|_)(?:ANON|JWT|SECRET|PASSWORD|TOKEN|SALT)(?:_|$)/.test(normalizedKey) ||
    /(?:^|_)(?:SERVICE_ROLE|DATABASE_URL|DB_URL|S3_SECRET_KEY|S3_ACCESS_KEY|STORAGE_KEY|PUBLISHABLE_KEY|SECRET_KEY)(?:_|$)/.test(normalizedKey)
  );
  for (const assignmentRe of assignmentRes) {
    for (const match of text.matchAll(assignmentRe)) {
      const key = String(match.groups?.key || '').trim();
      const normalizedKey = normalizeKey(key);
      const rawValue = String(match.groups?.value || '').trim();
      const value = rawValue.replace(/^["']|["']$/g, '').trim();
      if (!normalizedKey || !value) continue;
      if (!hasSensitiveSegment(normalizedKey)) continue;
      if (/(?:^|_)SECRET_BOUNDARY(?:_|$)/.test(normalizedKey)) continue;
      if (/(?:^|_)(?:FILE|PATH|MANIFEST|SUMMARY)(?:_|$)/.test(normalizedKey) && !/(?:DATABASE_URL|DB_URL)\b/.test(normalizedKey)) continue;
      if (/\[redacted/i.test(value)) continue;
      if (/(?:DATABASE_URL|DB_URL)\b/.test(normalizedKey) && /^postgres(?:ql)?:\/\/[^@\s]+$/i.test(value)) continue;
      if (/^(?:true|false|null|undefined)$/i.test(value)) continue;
      if (/^[0-9]+$/.test(value)) continue;
      if (/^[{\[]/.test(value)) continue;
      matches.push(match[0]);
    }
  }
  return matches;
}

function redactRuntimeOutput(value = '') {
  let text = String(value || '');
  text = text.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/giu, 'postgresql://[redacted]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, '[redacted-jwt]');
  text = text.replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/giu, '[redacted-supabase-key]');
  text = text.replace(
    /((?:SUPABASE_)?(?:SERVICE_ROLE|ANON|JWT|SECRET|PASSWORD|TOKEN|DATABASE_URL|DB_URL|S3_SECRET_KEY|S3_ACCESS_KEY|STORAGE_KEY|PUBLISHABLE_KEY|SECRET_KEY|SALT)[A-Z0-9_ -]*\s*[:=]\s*)([^\r\n]+)/giu,
    '$1[redacted]',
  );
  text = text.replace(
    /\b((?:service[_ -]?role|anon|jwt|database|db|s3 secret|s3 access|storage|publishable|secret|salt)[_ -]?(?:key|secret|token|password|url|value)?\s*[:=]\s*)([^\r\n]+)/giu,
    '$1[redacted]',
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/giu, 'Bearer [redacted]');
  text = text.replace(/\b(cookie|set-cookie)\s*[:=]\s*[^\r\n]+/giu, '$1: [redacted]');
  return text;
}

function scanSecretText(text = '') {
  const source = String(text || '');
  const findings = [];
  for (const matcher of SECRET_SCAN_PATTERNS) {
    const matches = matcher.scan ? matcher.scan(source) : (source.match(matcher.pattern) || []);
    if (!matches.length) continue;
    findings.push({
      id: matcher.id,
      count: matches.length,
    });
  }
  return findings;
}

module.exports = {
  SECRET_SCAN_PATTERNS,
  redactRuntimeOutput,
  scanSecretText,
};
