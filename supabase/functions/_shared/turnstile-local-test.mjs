export const LOCAL_MARKETING_TURNSTILE_TEST_SECRET =
  "EXAMPLE_PASSWORD";
export const LOCAL_MARKETING_TURNSTILE_TEST_TOKEN = "EXAMPLE_PASSWORD";

export function isTurnstileTestSecret(secret) {
  return /^[123]x0{31}AA$/.test(secret);
}

export function turnstileHostnameFailure(hostname, origin) {
  const actual = typeof hostname === "string" ? hostname.trim().toLowerCase() : "";
  if (!actual) return "hostname_missing";

  let expected;
  try {
    expected = new URL(origin).hostname.toLowerCase();
  } catch {
    return "origin_hostname_missing";
  }
  if (!expected) return "origin_hostname_missing";
  return expected === actual ? null : "hostname_mismatch";
}

const siteverifyErrorCodes = new Set([
  "missing-input-secret", "invalid-input-secret", "missing-input-response",
  "invalid-input-response", "bad-request", "timeout-or-duplicate", "internal-error",
]);

export function sanitizeTurnstileErrorCodes(codes) {
  return Array.isArray(codes)
    ? codes.slice(0, 10).map((code) => siteverifyErrorCodes.has(code) ? code : "[redacted]")
    : null;
}

export async function verifyMarketingTurnstile({
  token,
  secret,
  localContext,
  requestHostname,
  clientIp,
  fetchImpl = globalThis.fetch,
}) {
  if (!secret) {
    return { success: false, hostname: "", errorCodes: ["missing_turnstile_secret"] };
  }

  const normalizedRequestHostname = String(requestHostname || "").trim().toLowerCase();
  const isLoopbackRequest =
    // objectives:allow LOCALHOST Justification: local test token also requires local context and loopback.
    normalizedRequestHostname === "127.0.0.1" || normalizedRequestHostname === "localhost";
  if (
    localContext === true &&
    isLoopbackRequest &&
    secret === LOCAL_MARKETING_TURNSTILE_TEST_SECRET &&
    token === LOCAL_MARKETING_TURNSTILE_TEST_TOKEN
  ) {
    return { success: true, hostname: normalizedRequestHostname, errorCodes: null };
  }

  if (localContext !== true && isTurnstileTestSecret(secret)) {
    throw new Error("turnstile_testing_key_refused");
  }

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (clientIp) body.set("remoteip", clientIp);

  const response = await fetchImpl(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );

  const data = response.ok === false ? null : await response.json().catch(() => null);
  if (localContext !== true && data?.metadata?.result_with_testing_key === true) {
    throw new Error("turnstile_testing_key_refused");
  }
  const success = Boolean(data && typeof data === "object" && data.success === true);
  const hostname = typeof data?.hostname === "string" ? data.hostname.trim() : "";
  const errorCodes =
    data && typeof data === "object" ? (data["error-codes"] ?? null) : null;
  return { success, hostname, errorCodes };
}
