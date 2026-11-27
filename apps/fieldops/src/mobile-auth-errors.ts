import { redactOutboxErrorText } from "@masarx/mobile-core";
import { EN_STRINGS, type FieldOpsStrings } from "./i18n";

// Sample address inside the credentials hint; data, not copy.
const EXAMPLE_EMAIL = "sipkxyzyxvgvtksowrxwjgpn@example.invalid";

export function formatAuthErrorMessage(error: unknown, strings: FieldOpsStrings = EN_STRINGS): string {
  const copy = strings.signIn;
  const message = String((error as { message?: unknown })?.message || error || copy.unknownError);

  if (/failed to fetch|network request failed|fetch failed/i.test(message)) {
    return strings.auth.networkUnreachable;
  }

  if (/invalid login credentials/i.test(message)) {
    return copy.invalidCredentials.replace("{example}", EXAMPLE_EMAIL);
  }

  if (/\bemail not confirmed\b/i.test(message)) {
    return copy.emailNotConfirmed;
  }

  if (/\bemail rate limit exceeded\b/i.test(message)) {
    return copy.emailRateLimited;
  }

  if (/\btoken has expired or is invalid\b/i.test(message)) {
    return copy.tokenExpired;
  }

  const passwordMinimum = /\bpassword should be at least\b(?: ([0-9]{1,3}) characters\b)?/i.exec(message);
  if (passwordMinimum) {
    const hint = copy.passwordHint;
    return passwordMinimum[1] ? `${copy.passwordMinimum.replace("{count}", passwordMinimum[1])} ${hint}` : hint;
  }

  if (/400|email|otp|token/i.test(message)) {
    return copy.checkEmailFormat;
  }

  return redactOutboxErrorText(message);
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
