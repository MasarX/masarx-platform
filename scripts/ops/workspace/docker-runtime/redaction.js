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
  {
    id: 'supabase_credential_table_row',
    scan: scanSupabaseCredentialTableRows,
  },
];

const {
  isSensitiveCredentialKey,
  isSensitiveRuntimeAssignment,
  normalizeSensitiveKey,
} = require('./secret-policy');

const SUPABASE_CREDENTIAL_TABLE_LABELS = new Set([
  'access key',
  'anon key',
  'database url',
  'db url',
  'jwt secret',
  'publishable key',
  's3 access key',
  's3 secret key',
  'secret key',
  'service role key',
]);

function normalizeSupabaseCredentialTableLabel(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function parseSupabaseCredentialTableRow(line = '') {
  const match = String(line || '').match(/^(\s*[|│]\s*)([^|│]+?)(\s*[|│]\s*)([^|│]*?)(\s*[|│]\s*)$/u);
  if (!match) return null;
  const label = normalizeSupabaseCredentialTableLabel(match[2]);
  if (!SUPABASE_CREDENTIAL_TABLE_LABELS.has(label)) return null;
  return {
    prefix: `${match[1]}${match[2]}${match[3]}`,
    value: String(match[4] || '').trim(),
    suffix: match[5],
  };
}

function scanSupabaseCredentialTableRows(source = '') {
  return String(source || '')
    .split(/\r?\n/u)
    .filter((line) => {
      const row = parseSupabaseCredentialTableRow(line);
      return row && row.value && !/^\[redacted(?:-[^\]]+)?\]$/iu.test(row.value);
    });
}

function redactSupabaseCredentialTableRows(source = '') {
  return String(source || '').replace(/[^\r\n]*(?:\r\n|\n|\r|$)/gu, (line) => {
    const lineEnding = line.match(/(?:\r\n|\n|\r)$/u)?.[0] || '';
    const body = lineEnding ? line.slice(0, -lineEnding.length) : line;
    if (!body) return line;
    const row = parseSupabaseCredentialTableRow(body);
    if (!row || !row.value) return line;
    return `${row.prefix}[redacted]${row.suffix}${lineEnding}`;
  });
}

function isSensitiveAssignmentKey(key = '') {
  return isSensitiveCredentialKey(key);
}

function assignmentRegexes() {
  const sensitiveTerm = '(?:SERVICE_ROLE|ANON|JWT|SECRET|PASSWORD|TOKEN|DATABASE_URL|DB_URL|S3_SECRET_KEY|S3_ACCESS_KEY|STORAGE_KEY|PUBLISHABLE_KEY|SECRET_KEY|SALT|API_KEY|PRIVATE_KEY|AWS_ACCESS_KEY_ID|PGPASSWORD|PASSPHRASE|CREDENTIALS?|KEY|PASS)';
  return [
    new RegExp(String.raw`(?<keyQuote>["'])(?<key>[A-Z0-9_ -]*${sensitiveTerm}[A-Z0-9_ -]*)\k<keyQuote>\s*:\s*(?<value>"(?:\\[^\r\n]|[^"\\\r\n])*"(?=\s*[,}\]]|$)|'[^'\r\n]*'|[^\r\n,}\]]+)`, 'giu'),
    new RegExp(`(?:^|[\\s"'])(?<key>[A-Z0-9_ -]*${sensitiveTerm}[A-Z0-9_ -]*)=(?<value>[^\\s"',}\\]]+)`, 'gimu'),
    new RegExp(`(?:^|\\s)(?<key>[A-Z0-9_ -]*${sensitiveTerm}[A-Z0-9_ -]*)\\s*:\\s*(?<value>[^\\r\\n]+)`, 'gimu'),
  ];
}

function assignmentValue(groups = {}) {
  const rawValue = String(groups.value || '').trim();
  // Compare serialized JSON strings with the exact decoded plan-bound metadata.
  if (groups.keyQuote === '"' && rawValue.startsWith('"')) {
    try { return JSON.parse(rawValue); }
    catch { return rawValue; }
  }
  return rawValue.replace(/^["']|["']$/g, '').trim();
}

function scanSecretAssignments(source = '', options = {}) {
  const text = String(source || '');
  const matches = [];
  for (const assignmentRe of assignmentRegexes()) {
    for (const match of text.matchAll(assignmentRe)) {
      const key = String(match.groups?.key || '').trim();
      const value = assignmentValue(match.groups);
      if (!isSensitiveRuntimeAssignment(key, value, options) || !value) continue;
      const rawValue = String(match.groups?.value || '').trim().replace(/^["']|["']$/g, '').trim();
      if (/\[redacted/i.test(rawValue)) continue;
      if (/(?:DATABASE_URL|DB_URL)\b/.test(normalizeSensitiveKey(key)) && /^postgres(?:ql)?:\/\/[^@?\s]+(?:\/[^?\s]*)?$/i.test(rawValue)) continue;
      if (/^(?:true|false|null|undefined)$/i.test(rawValue)) continue;
      if (/^[0-9]+$/.test(rawValue)) continue;
      if (/^[{\[]/.test(rawValue)) continue;
      matches.push(match[0]);
    }
  }
  return matches;
}

function redactSecretAssignments(value = '', options = {}) {
  let text = String(value || '');
  for (const assignmentRe of assignmentRegexes()) {
    text = text.replace(assignmentRe, (match, ...args) => {
      const groups = args.at(-1) || {};
      const key = String(groups.key || '').trim();
      const rawValue = String(groups.value || '').trim();
      const unquotedValue = assignmentValue(groups);
      if (!unquotedValue || !isSensitiveRuntimeAssignment(key, unquotedValue, options)) return match;
      if (/\[redacted/i.test(unquotedValue)) return match;
      const quote = /^["']/.test(rawValue) ? rawValue[0] : '';
      const prefix = match.slice(0, match.lastIndexOf(rawValue));
      const jsonQuotedKey = /["'][^"']+["']\s*:\s*$/u.test(prefix);
      const replacement = quote ? `${quote}[redacted]${quote}` : (jsonQuotedKey ? '"[redacted]"' : '[redacted]');
      return `${match.slice(0, match.lastIndexOf(rawValue))}${replacement}`;
    });
  }
  return text;
}

function redactRuntimeOutput(value = '', options = {}) {
  let text = redactSupabaseCredentialTableRows(value);
  text = redactSecretAssignments(text, options);
  text = text.replace(/\b(https?:\/\/)[^/\s"'<>]+@/giu, '$1[redacted]@');
  text = text.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/giu, 'postgresql://[redacted]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, '[redacted-jwt]');
  text = text.replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/giu, '[redacted-supabase-key]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/giu, 'Bearer [redacted]');
  text = text.replace(/\b(cookie|set-cookie)\s*[:=]\s*[^\r\n]+/giu, '$1: [redacted]');
  return text;
}

function createRuntimeOutputRedactor(options = {}) {
  const onText = typeof options.onText === 'function' ? options.onText : () => {};
  const maxPendingChars = Number.isFinite(options.maxPendingChars) && options.maxPendingChars > 0
    ? Math.floor(options.maxPendingChars)
    : 65536;
  let pending = '';
  let discardingOversizedLine = false;

  const emit = (value) => {
    const redacted = redactRuntimeOutput(value);
    if (redacted) onText(redacted);
    return redacted;
  };

  const write = (chunk) => {
    let source = String(chunk || '');
    let emitted = '';

    while (source) {
      const lfIndex = source.indexOf('\n');
      const crIndex = source.indexOf('\r');
      const terminatorIndex = lfIndex < 0
        ? crIndex
        : (crIndex < 0 ? lfIndex : Math.min(lfIndex, crIndex));

      if (discardingOversizedLine) {
        if (terminatorIndex < 0) return emitted;
        source = source.slice(terminatorIndex + 1);
        discardingOversizedLine = false;
        continue;
      }

      if (terminatorIndex >= 0) {
        const completeLine = source.slice(0, terminatorIndex + 1);
        source = source.slice(terminatorIndex + 1);
        if (pending.length + completeLine.length > maxPendingChars) {
          pending = '';
          emitted += emit('[redacted-oversized-runtime-output-line]\n');
          continue;
        }
        pending += completeLine;
        emitted += emit(pending);
        pending = '';
        continue;
      }

      if (pending.length + source.length > maxPendingChars) {
        pending = '';
        discardingOversizedLine = true;
        emitted += emit('[redacted-oversized-runtime-output-line]\n');
        return emitted;
      }

      pending += source;
      source = '';
    }
    return emitted;
  };

  const flush = () => {
    const remaining = pending;
    pending = '';
    discardingOversizedLine = false;
    return remaining ? emit(remaining) : '';
  };

  return {
    flush,
    pendingLength: () => pending.length,
    write,
  };
}

function scanSecretText(text = '', options = {}) {
  const source = String(text || '');
  const findings = [];
  for (const matcher of SECRET_SCAN_PATTERNS) {
    const matches = matcher.scan ? matcher.scan(source, options) : (source.match(matcher.pattern) || []);
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
  createRuntimeOutputRedactor,
  isSensitiveAssignmentKey,
  redactSupabaseCredentialTableRows,
  redactRuntimeOutput,
  scanSupabaseCredentialTableRows,
  scanSecretText,
};
