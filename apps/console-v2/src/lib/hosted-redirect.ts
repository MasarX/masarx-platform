import { CONSOLE_AUTH_CALLBACK_PATH } from './auth';

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isDisallowedHostedRedirectHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === 'local' ||
    normalized.startsWith('local-') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.localhost')
  );
}

export function normalizeHostedHttpUrl(value: unknown): string | null {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  try {
    const candidate = raw.includes('://') ? raw : `https://${raw}`;
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      isDisallowedHostedRedirectHost(hostname)
    ) {
      return null;
    }
    parsed.hash = '';
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) return parsed.origin;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeHostedConsoleCallbackUrl(value: unknown): string | null {
  const normalized = normalizeHostedHttpUrl(value);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if ((parsed.pathname === '/' || parsed.pathname === '') && !parsed.search && !parsed.hash) {
      parsed.pathname = CONSOLE_AUTH_CALLBACK_PATH;
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function hostedInviteRedirect(): string | null {
  const configuredRedirect = normalizeHostedConsoleCallbackUrl(
    asNonEmptyString(import.meta.env.VITE_AUTH_REDIRECT_URL) ??
      asNonEmptyString(import.meta.env.VITE_CONSOLE_AUTH_REDIRECT_URL),
  );
  if (configuredRedirect) return configuredRedirect;

  const configuredHost = normalizeHostedConsoleCallbackUrl(asNonEmptyString(import.meta.env.VITE_APP_HOST));
  if (configuredHost) return configuredHost;

  if (typeof window === 'undefined') return null;
  return normalizeHostedConsoleCallbackUrl(window.location.origin);
}
