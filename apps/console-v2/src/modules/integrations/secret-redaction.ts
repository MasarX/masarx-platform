const SENSITIVE_INTEGRATION_SECRET_KEY =
  /(authorization|x-api-key|api[_-]?key|apikey|credential|password|private[_-]?key|secret|signature|token)/i;

export function isRedactedIntegrationSecret(value: string): boolean {
  return /^(REDACTED|\[redacted\]|redacted-token)$/i.test(value.trim());
}

export function redactIntegrationSecretText(value: string): string {
  return value
    .replace(/Bearer\s+[^"'\s]+/gi, 'Bearer REDACTED')
    .replace(/Basic\s+[^"'\s]+/gi, 'Basic REDACTED')
    .replace(/("[^"]*(?:authorization|x-api-key|api[_-]?key|apikey|credential|password|private[_-]?key|secret|signature|token)[^"]*"\s*:\s*")[^"]*(")/gi, '$1REDACTED$2')
    .replace(/((?:authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|signature)\s*[:=]\s*)[^&\r\n"',;}]+/gi, '$1REDACTED')
    .replace(/([?&](?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|signature|password)=)[^&\s"']+/gi, '$1REDACTED');
}

export function redactIntegrationSecretValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactIntegrationSecretValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_INTEGRATION_SECRET_KEY.test(key) ? 'REDACTED' : redactIntegrationSecretValue(entry),
      ]),
    );
  }
  if (typeof value === 'string') return redactIntegrationSecretText(value);
  return value;
}

export function displayRedactedIntegrationJson(value: unknown): string {
  return JSON.stringify(redactIntegrationSecretValue(value), null, 2);
}

export function redactIntegrationSourceTextForDisplay(value: string): string {
  try {
    return displayRedactedIntegrationJson(JSON.parse(value));
  } catch {
    return redactIntegrationSecretText(value);
  }
}
