const { execFileSync } = require("child_process");
const path = require("path");

const helperPath = path.resolve(__dirname, "helpers/run-auth.mjs");

function executeScenario(headers, roles, options = {}) {
  const payload = JSON.stringify({ headers, roles, ...options });
  const output = execFileSync(process.execPath, ["--experimental-vm-modules", helperPath, payload], {
    encoding: "utf8"
  });
  return JSON.parse(output.trim());
}

const token = "provider-verified-token";
const nowSeconds = 2_000_000_000;
const validClaims = (overrides = {}) => ({
  role: "edge_api_gateway_role",
  aud: "authenticated",
  sub: "edge-function",
  exp: nowSeconds + 300,
  ...overrides,
});

describe("api-caller JWT role enforcement", () => {
  test("extractAuthToken reads bearer header", () => {
    const bearer = executeScenario({ Authorization: `Bearer ${token}` }, "edge_api_gateway_role");
    expect(bearer.token).toBe(token);

    const missing = executeScenario({}, "edge_api_gateway_role");
    expect(missing.token).toBeNull();
  });

  test("rejects missing token with 401", () => {
    const result = executeScenario({}, "edge_api_gateway_role");
    expect(result.auth.ok).toBe(false);
    expect(result.auth.status).toBe(401);
  });

  test("rejects when allowlist is missing", () => {
    const result = executeScenario(
      { Authorization: `Bearer ${token}` },
      "",
      { claims: validClaims(), nowSeconds },
    );
    expect(result.auth.ok).toBe(false);
    expect(result.auth.status).toBe(500);
  });

  test("accepts token when role is allowed", () => {
    const result = executeScenario(
      { Authorization: `Bearer ${token}` },
      "edge_api_gateway_role",
      { claims: validClaims(), nowSeconds, operation: "job" },
    );
    expect(result.auth.ok).toBe(true);
    expect(result.operationAuth.ok).toBe(true);
  });

  test("rejects token with disallowed role", () => {
    const result = executeScenario(
      { Authorization: `Bearer ${token}` },
      "edge_api_gateway_role",
      { claims: validClaims({ role: "anon" }), nowSeconds },
    );
    expect(result.auth.ok).toBe(false);
    expect(result.auth.status).toBe(403);
  });

  test("rejects token missing role claim", () => {
    const result = executeScenario(
      { Authorization: `Bearer ${token}` },
      "edge_api_gateway_role",
      { claims: validClaims({ role: "" }), nowSeconds },
    );
    expect(result.auth.ok).toBe(false);
    expect(result.auth.status).toBe(403);
  });

  test.each([
    ["audience", { aud: "anon" }, 403],
    ["subject", { sub: "user" }, 403],
    ["expiry", { exp: nowSeconds }, 401],
    ["not-before", { nbf: nowSeconds + 1 }, 401],
  ])("rejects invalid %s claims", (_name, override, status) => {
    const result = executeScenario(
      { Authorization: `Bearer ${token}` },
      "edge_api_gateway_role",
      { claims: validClaims(override), nowSeconds },
    );
    expect(result.auth.ok).toBe(false);
    expect(result.auth.status).toBe(status);
  });

  test("gateway role cannot execute batch operations", () => {
    const result = executeScenario(
      { Authorization: `Bearer ${token}` },
      "edge_api_gateway_role",
      { claims: validClaims(), nowSeconds, operation: "batch" },
    );
    expect(result.auth.ok).toBe(true);
    expect(result.operationAuth.ok).toBe(false);
    expect(result.operationAuth.status).toBe(403);
  });

  test("api-caller worker role can execute batch operations", () => {
    const result = executeScenario(
      { Authorization: `Bearer ${token}` },
      "edge_api_caller_role",
      {
        claims: validClaims({ role: "edge_api_caller_role" }),
        nowSeconds,
        operation: "batch",
      },
    );
    expect(result.auth.ok).toBe(true);
    expect(result.operationAuth.ok).toBe(true);
  });
});
