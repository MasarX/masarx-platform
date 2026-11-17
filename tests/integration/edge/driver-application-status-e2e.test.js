// Plan: PLAN-202603-marketplace-network-product-complete / Step: S95
// Driver application status edge E2E coverage.

const { loadEnv } = require("../../../scripts/utils/load-env");
const {
  buildAllowedOriginCandidates,
  probeAllowedOrigin,
} = require("../helpers/edge-origin-probe");

loadEnv();

const edgeE2eEnabled = process.env.RUN_EDGE_E2E === "true";
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();

const runIfEdge = edgeE2eEnabled && SUPABASE_URL ? describe : describe.skip;

function buildFnUrl(fnName) {
  const base = SUPABASE_URL.replace(/\/+$/g, "");
  return `${base}/functions/v1/${fnName}`;
}

function resolveAllowedOriginCandidate() {
  return buildAllowedOriginCandidates({
    allowlistValues: [
      process.env.DRIVER_SIGNUP_CORS_ALLOW_ORIGINS,
      process.env.MARKETING_CORS_ALLOW_ORIGINS,
      process.env.LANDING_CORS_ALLOW_ORIGINS,
    ],
    envValues: [
      process.env.SUPABASE_URL,
      process.env.LANDING_SITE_URL,
      process.env.LANDING_APP_URL,
      "http://127.0.0.1:3333",
      "https://localhost:3333",
      "https://localhost:3000",
    ],
    canonicalHosts: [
      "https://hguxuguuvhxjwymmxhlmkwwp.example.invalid",
      "https://grtgggvjriwqrxhykymmloov.example.invalid",
      "https://nzxmhryhtqlzoshjkyozkpup.example.invalid",
      "https://yslvnlqxjhkzismlnkrrvyvs.example.invalid",
    ],
  });
}

async function requestStatus({ origin, method = "POST", token } = {}) {
  const url = method === "GET"
    ? `${buildFnUrl("driver-application-status")}?token=${encodeURIComponent(token || "")}`
    : buildFnUrl("driver-application-status");
  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(origin ? { origin } : {}),
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ token }) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

runIfEdge("driver-application-status edge (E2E)", () => {
  test("POST without Origin returns 403 origin_required", async () => {
    const { status, body } = await requestStatus({
      token: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({ ok: false, error: { code: "origin_required" } });
  });

  test("POST with disallowed Origin returns 403 origin_not_allowed", async () => {
    const { status, body } = await requestStatus({
      origin: "https://evil.example",
      token: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({ ok: false, error: { code: "origin_not_allowed" } });
  });

  test("allowed Origin with invalid token shape returns invalid_status_token", async () => {
    const { origin: allowedOrigin, attempts } = await probeAllowedOrigin(
      resolveAllowedOriginCandidate(),
      async (origin) =>
        requestStatus({
          origin,
          token: "bad-token",
        }),
    );

    if (!allowedOrigin) {
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts.every((attempt) => attempt.status === 403)).toBe(true);
      return;
    }

    const { status, body } = await requestStatus({
      origin: allowedOrigin,
      token: "bad-token",
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: { code: "invalid_status_token" } });
  });
});
