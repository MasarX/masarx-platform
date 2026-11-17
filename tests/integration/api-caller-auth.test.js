const { execFileSync } = require("child_process");
const path = require("path");

const helperPath = path.resolve(__dirname, "helpers/run-auth.mjs");

function executeScenario(headers, roles) {
  const payload = JSON.stringify({ headers, roles });
  const output = execFileSync(process.execPath, ["--experimental-vm-modules", helperPath, payload], {
    encoding: "utf8"
  });
  return JSON.parse(output.trim());
}

function buildJwt(claims) {
  const payload = Buffer.from(JSON.stringify(claims || {})).toString("base64");
  return `header.${payload}.sig`;
}

describe("api-caller JWT role enforcement", () => {
  test("extractAuthToken reads bearer header", () => {
    const token = "jwt-token";
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
    const token = buildJwt({ role: "edge_api_gateway_role" });
    const result = executeScenario({ Authorization: `Bearer ${token}` }, "");
    expect(result.auth.ok).toBe(false);
    expect(result.auth.status).toBe(500);
  });

  test("accepts token when role is allowed", () => {
    const token = buildJwt({ role: "edge_api_gateway_role" });
    const result = executeScenario({ Authorization: `Bearer ${token}` }, "edge_api_gateway_role");
    expect(result.auth.ok).toBe(true);
  });

  test("rejects token with disallowed role", () => {
    const token = buildJwt({ role: "anon" });
    const result = executeScenario({ Authorization: `Bearer ${token}` }, "edge_api_gateway_role");
    expect(result.auth.ok).toBe(false);
    expect(result.auth.status).toBe(403);
  });

  test("rejects token missing role claim", () => {
    const token = buildJwt({ sub: "user" });
    const result = executeScenario({ Authorization: `Bearer ${token}` }, "edge_api_gateway_role");
    expect(result.auth.ok).toBe(false);
    expect(result.auth.status).toBe(403);
  });
});
