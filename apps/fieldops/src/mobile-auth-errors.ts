import { redactOutboxErrorText } from "@masarx/mobile-core";

export function formatAuthErrorMessage(error: unknown, normalizedEmail: string): string {
  const base = redactOutboxErrorText(String((error as { message?: unknown })?.message || error || "Unknown error"));

  if (/failed to fetch|network request failed|fetch failed/i.test(base)) {
    return "Unable to reach the MasarX server. Check your connection and try again.";
  }

  if (/invalid login credentials/i.test(base)) {
    return `${base}. Verify email/password and remove spaces from email (e.g. ${normalizedEmail || "sipkxyzyxvgvtksowrxwjgpn@example.invalid"}).`;
  }

  if (/400|email|otp|token/i.test(base)) {
    return `${base}. Verify email format (no spaces), then retry.`;
  }

  return base;
}

/**
 * Return true when the given error indicates that the current auth session is no longer
 * valid (401 / 403, expired JWT, missing-session Supabase error, PostgREST 301, etc.).
 * Used by the outbox sync flow to short-circuit retry and raise a re-auth prompt
 * instead of silently looping on a permanently failing request.
 */
export function isAuthExpiredError(error: unknown): boolean {
  if (!error) return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    code?: unknown;
    name?: unknown;
  };
  const status = Number(candidate.status ?? candidate.statusCode ?? 0);
  if (status === 401 || status === 403) return true;
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  if (/\b(jwt|token)\b/.test(message) && /(expired|invalid|malformed|missing)/.test(message)) return true;
  if (message.includes("session missing") || message.includes("not authorized")) return true;
  if (message.includes("auth session missing")) return true;
  const code = typeof candidate.code === "string" ? candidate.code.toLowerCase() : "";
  return code === "pgrst301" || code === "unauthorized";
}
