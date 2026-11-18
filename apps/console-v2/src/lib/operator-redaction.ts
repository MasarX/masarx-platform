const SENSITIVE_QUERY_KEYS =
  'token|auth_token|api_key|apikey|secret|signature|hmac|x_signature|x-signature|x-hub-signature|x-hub-signature-256|key|password|credential';
const SENSITIVE_TEXT_KEYS =
  'cookie|set-cookie|x-api-key|api-key|apikey|x-webhook-token|x-signature|x-hub-signature|x-hub-signature-256|token|auth_token|api_key|secret|signature|hmac|password|credential';

export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apikey',
  'api-key',
  'x-webhook-token',
  'x-signature',
  'x-hub-signature',
  'x-hub-signature-256',
  'proxy-authorization',
]);

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(\/api-gateway\/t\/)[^/?#\s]+/gi, '$1[redacted]')
    .replace(
      new RegExp(`(^|[?&])(${SENSITIVE_QUERY_KEYS})=([^&#\\s]*)`, 'gi'),
      '$1$2=[redacted]',
    )
    .replace(
      /\b(authorization|proxy-authorization)\b\s*([:=])\s*((?:Bearer|Basic)\s+)?[^,\s;&}\]]+/gi,
      '$1$2 $3[redacted]',
    )
    .replace(/\b(Bearer)\s+[^,\s;&}[\]]+/gi, '$1 [redacted]')
    .replace(
      new RegExp(`(["']?)\\b(${SENSITIVE_TEXT_KEYS})\\b\\1\\s*:\\s*(["']?)([^"',\\s;&}\\\\[\\]]+)\\3`, 'gi'),
      '$1$2$1: $3[redacted]$3',
    )
    .replace(
      new RegExp(`(["']?)\\b(${SENSITIVE_TEXT_KEYS})\\b\\1\\s*=\\s*(["']?)([^"',\\s;&}\\\\[\\]]+)\\3`, 'gi'),
      '$1$2$1=$3[redacted]$3',
    );
}

export function redactHeader(name: string, value: string | null | undefined): string {
  if (value == null) return '';
  if (SENSITIVE_HEADERS.has(name.toLowerCase())) return '«redacted»';
  return redactSensitiveText(value);
}

export function redactJsonForOperator(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactJsonForOperator(item));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactSensitiveText(value) : value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (
      SENSITIVE_HEADERS.has(lowerKey) ||
      /(^|[_-])(token|secret|signature|hmac|password|credential|api[-_]?key|access[_-]?key|private[_-]?key)([_-]|$)/i.test(lowerKey)
    ) {
      redacted[key] = '[redacted]';
    } else {
      redacted[key] = redactJsonForOperator(child);
    }
  }
  return redacted;
}

export function prettyOperatorJson(value: unknown): string {
  try {
    return JSON.stringify(redactJsonForOperator(value), null, 2);
  } catch {
    return String(value);
  }
}
