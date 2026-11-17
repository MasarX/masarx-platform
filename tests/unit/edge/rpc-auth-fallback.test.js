const path = require("path");
const { pathToFileURL } = require("url");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const sharedModulePath = path.join(repoRoot, "supabase", "functions", "_shared", "mod.mjs");

function fakeJwt(role = "service_role") {
  const encode = (value) => Buffer.from(value).toString("base64url");
  return `${encode(JSON.stringify({ alg: "none", typ: "JWT" }))}.${encode(JSON.stringify({ role }))}.sig`;
}

describe("edge rpc auth fallback", () => {
  let shared;
  let originalDeno;
  let originalFetch;

  beforeAll(async () => {
    originalDeno = global.Deno;
    global.Deno = {
      env: {
        get: () => "",
      },
    };
    shared = await import(pathToFileURL(sharedModulePath).href);
  });

  afterAll(() => {
    global.Deno = originalDeno;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
      originalFetch = undefined;
    }
    jest.restoreAllMocks();
  });

  test("buildRpcAuthAttempts prefers jwt-plane auth before secret-key plane auth", () => {
    const attempts = shared.buildRpcAuthAttempts({
      dbJwt: fakeJwt("edge_webhook_role"),
      secretKey: "sb_secret_test_value",
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[0].label).toBe("db_jwt");
    expect(attempts[0].headers.apikey).toBeDefined();
    expect(attempts[0].headers.authorization).toMatch(/^Bearer /);
    expect(attempts[1].label).toBe("secret_key");
    expect(attempts[1].headers.apikey).toBe("sb_secret_test_value");
    expect(attempts[1].headers.authorization).toBeUndefined();
  });

  test("invokeSupabaseRpcWithAuthFallback retries on PGRST301 auth-plane failure", async () => {
    const attempts = shared.buildRpcAuthAttempts({
      dbJwt: fakeJwt("edge_webhook_role"),
      secretKey: "sb_secret_test_value",
    });

    originalFetch = global.fetch;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "PGRST301",
            details: "None of the keys was able to decode the JWT",
            hint: null,
            message: "No suitable key or wrong key type",
          }),
          {
            status: 401,
            statusText: "Unauthorized",
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, status: 200 }),
          {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          },
        ),
      );
    global.fetch = fetchMock;

    const result = await shared.invokeSupabaseRpcWithAuthFallback({
      url: "https://example.test/rest/v1/rpc/workflow_intake_webhook",
      body: { p_token: "token-123" },
      authAttempts: attempts,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ ok: true, status: 200 });

    const firstHeaders = new Headers(fetchMock.mock.calls[0][1].headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1][1].headers);
    expect(firstHeaders.get("authorization")).toMatch(/^Bearer /);
    expect(secondHeaders.get("authorization")).toBeNull();
    expect(secondHeaders.get("apikey")).toBe("sb_secret_test_value");
  });
});
