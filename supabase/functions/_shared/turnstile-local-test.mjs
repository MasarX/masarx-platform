export const LOCAL_MARKETING_TURNSTILE_TEST_SECRET =
  "EXAMPLE_PASSWORD";
export const LOCAL_MARKETING_TURNSTILE_TEST_TOKEN = "EXAMPLE_PASSWORD";

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

  const data = await response.json().catch(() => null);
  const success = Boolean(data && typeof data === "object" && data.success === true);
  const hostname =
    data && typeof data === "object" ? String(data.hostname || "").trim() : "";
  const errorCodes =
    data && typeof data === "object" ? (data["error-codes"] ?? null) : null;
  return { success, hostname, errorCodes };
}
