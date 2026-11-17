export function formatAuthErrorMessage(error: unknown, normalizedEmail: string): string {
  const base = String((error as { message?: unknown })?.message || error || "Unknown error");

  if (/invalid login credentials/i.test(base)) {
    return `${base}. Verify email/password and remove spaces from email (e.g. ${normalizedEmail || "sipkxyzyxvgvtksowrxwjgpn@example.invalid"}).`;
  }

  if (/400|email|otp|token/i.test(base)) {
    return `${base}. Verify email format (no spaces), then retry.`;
  }

  return base;
}
