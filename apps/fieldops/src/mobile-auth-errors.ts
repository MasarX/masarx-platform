import { redactOutboxErrorText } from "@masarx/mobile-core";

export function formatAuthErrorMessage(error: unknown): string {
  const message = String((error as { message?: unknown })?.message || error || "Unknown error");

  if (/failed to fetch|network request failed|fetch failed/i.test(message)) {
    return "Unable to reach the MasarX server. Check your connection and try again.";
  }

  if (/invalid login credentials/i.test(message)) {
    return "Invalid login credentials. Verify email/password and remove spaces from email (e.g. sipkxyzyxvgvtksowrxwjgpn@example.invalid).";
  }

  if (/\bemail not confirmed\b/i.test(message)) {
    return "Email not confirmed. Check your inbox for the confirmation email, then retry.";
  }

  if (/\bemail rate limit exceeded\b/i.test(message)) {
    return "Email rate limit exceeded. Wait before requesting another email.";
  }

  if (/\btoken has expired or is invalid\b/i.test(message)) {
    return "Token has expired or is invalid. Request a new link or code, then retry.";
  }

  const passwordMinimum = /\bpassword should be at least\b(?: ([0-9]{1,3}) characters\b)?/i.exec(message);
  if (passwordMinimum) {
    const hint = "Choose a longer password and try again.";
    return passwordMinimum[1] ? `Password should be at least ${passwordMinimum[1]} characters. ${hint}` : hint;
  }

  if (/400|email|otp|token/i.test(message)) {
    return "Verify email format (no spaces), then retry.";
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
