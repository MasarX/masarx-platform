const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const sharedModulePath = path.join(repoRoot, "supabase", "functions", "_shared", "mod.mjs");
const apiGatewaySharedModulePath = path.join(repoRoot, "supabase", "functions", "api-gateway", "_shared", "mod.mjs");
const webhookReceiverSharedModulePath = path.join(repoRoot, "supabase", "functions", "webhook-receiver", "_shared", "mod.mjs");

function fakeJwt(role = "service_role") {
  const encode = (value) => Buffer.from(value).toString("base64url");
  return `${encode(JSON.stringify({ alg: "none", typ: "JWT" }))}.${encode(JSON.stringify({ role }))}.sig`;
}

describe("edge rpc auth fallback", () => {
  let shared;
  let originalDeno;
  let originalFetch;
  let fixtureRoot;
  let functionSharedModulePaths;

  beforeAll(async () => {
    const sync = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "edge", "sync-shared.js")], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    if (sync.status !== 0) {
      throw new Error("edge shared sync failed before rpc auth fallback tests");
    }
    originalDeno = global.Deno;
    global.Deno = {
      env: {
        get: () => "",
      },
    };
    shared = await import(pathToFileURL(sharedModulePath).href);
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "masarx-edge-rpc-shared-"));
    const syncScript = path.join(fixtureRoot, "scripts", "edge", "sync-shared.js");
    fs.mkdirSync(path.dirname(syncScript), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "scripts", "edge", "sync-shared.js"), syncScript);
    const functionsRoot = path.join(fixtureRoot, "supabase", "functions");
    fs.cpSync(path.dirname(sharedModulePath), path.join(functionsRoot, "_shared"), { recursive: true });
    functionSharedModulePaths = ["api-gateway", "webhook-receiver"].map((name) => {
      const functionRoot = path.join(functionsRoot, name);
      fs.mkdirSync(functionRoot, { recursive: true });
      return path.join(functionRoot, "_shared", "mod.mjs");
    });
    execFileSync(process.execPath, [syncScript], { cwd: fixtureRoot, stdio: "pipe" });
  });

  afterAll(() => {
    global.Deno = originalDeno;
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
      originalFetch = undefined;
    }
    jest.restoreAllMocks();
  });


  test.each([401, 403])("classifies only explicit auth codes at HTTP %s", (status) => {
    for (const code of ["PGRST301", "PGRST302", "PGRST303"]) {
      expect(shared.isRetryableRpcAuthError(status, { code })).toBe(true);
      expect(shared.isRetryableRpcAuthError(status, { code, message: "غير متاح" })).toBe(true);
    }
    for (const code of ["42501", "P0001", "PT401", "PT403", "23505", "PGRST100", "PGRST102", "PGRST202", "PGRST300", "PGRST304", "pgrst301", "PGRST301_extra"]) {
      expect(shared.isRetryableRpcAuthError(status, {
        code, message: "Invalid JWT authorization", details: "PGRST301",
      })).toBe(false);
    }
    for (const body of [null, undefined, [], 301, "Invalid JWT", { message: "No suitable key or wrong key type" },
      { code: null }, { code: 301 }, { code: ["PGRST301"] }, { code: { value: "PGRST301" } },
      { error: { code: "PGRST301" } }]) {
      expect(shared.isRetryableRpcAuthError(status, body)).toBe(false);
    }
  });

  test.each([200, 400, 429, 500])("does not retry auth-code bodies at HTTP %s", (status) => {
    for (const code of ["PGRST301", "PGRST302", "PGRST303"]) {
      expect(shared.isRetryableRpcAuthError(status, { code, message: "Invalid JWT" })).toBe(false);
    }
  });

  test("retains numeric HTTP status normalization without relaxing code identity", () => {
    expect(shared.isRetryableRpcAuthError("401", { code: "PGRST302" })).toBe(true);
  });

  test.each(["PGRST301", "PGRST302", "PGRST303"])("retries %s only through supplied credentials with unchanged request", async (code) => {
    const attempts = shared.buildRpcAuthAttempts({ dbJwt: fakeJwt(), secretKey: "sb_secret_next" });
    originalFetch = global.fetch;
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const url = "https://example.test/rest/v1/rpc/workflow_intake_webhook";
    const body = { p_token: "fixture-token" };
    const result = await shared.invokeSupabaseRpcWithAuthFallback({ url, body, authAttempts: attempts });
    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    for (const [calledUrl, init] of global.fetch.mock.calls) {
      expect(calledUrl).toBe(url);
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify(body));
      expect(new Headers(init.headers).get("accept-profile")).toBe("api");
      expect(new Headers(init.headers).get("content-profile")).toBe("api");
    }
    expect(new Headers(global.fetch.mock.calls[1][1].headers).get("apikey")).toBe("sb_secret_next");
    expect(new Headers(global.fetch.mock.calls[1][1].headers).get("authorization")).toBeNull();
  });

  test.each([401, 403])("does not escalate credentials after HTTP %s permission denial with auth words", async (status) => {
    const attempts = shared.buildRpcAuthAttempts({ dbJwt: fakeJwt(), secretKey: "sb_secret_forbidden" });
    const denied = { code: "42501", message: "JWT authorization denied", details: "PGRST301" };
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(denied), { status }));
    const result = await shared.invokeSupabaseRpcWithAuthFallback({
      url: "https://example.test/rest/v1/rpc/operation", body: {}, authAttempts: attempts,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.body).toEqual(denied);
    expect(result.authRetry).toBe(false);
  });

  test("auth exhaustion never repeats or invents credential candidates", async () => {
    const attempts = shared.buildRpcAuthAttempts({ dbJwt: fakeJwt(), secretKey: "sb_secret_last" });
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ code: "PGRST302" }), { status: 401 }));
    const result = await shared.invokeSupabaseRpcWithAuthFallback({
      url: "https://example.test/rest/v1/rpc/operation", body: {}, authAttempts: attempts,
    });
    expect(global.fetch).toHaveBeenCalledTimes(attempts.length);
    expect(result.ok).toBe(false);
    expect(result.body).toEqual({ code: "PGRST302" });
    expect(result.attempted).toBe(attempts[attempts.length - 1]);
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
    expect(firstHeaders.get("accept-profile")).toBe("api");
    expect(firstHeaders.get("content-profile")).toBe("api");
    expect(firstHeaders.get("authorization")).toMatch(/^Bearer /);
    expect(secondHeaders.get("accept-profile")).toBe("api");
    expect(secondHeaders.get("content-profile")).toBe("api");
    expect(secondHeaders.get("authorization")).toBeNull();
    expect(secondHeaders.get("apikey")).toBe("sb_secret_test_value");
  });

  test("invokeSupabaseRpcWithAuthFallback fails closed when the RPC fetch times out", async () => {
    const attempts = shared.buildRpcAuthAttempts({
      dbJwt: fakeJwt("edge_webhook_role"),
    });

    originalFetch = global.fetch;
    const fetchMock = jest.fn((_url, init = {}) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }));
    global.fetch = fetchMock;

    const result = await shared.invokeSupabaseRpcWithAuthFallback({
      url: "https://example.test/rest/v1/rpc/record_intake_auth_rejection_v1",
      body: { p_args: { failure_code: "missing_token" } },
      authAttempts: attempts,
      timeoutMs: 5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.response).toBeNull();
    expect(result.body).toMatchObject({
      code: "edge_rpc_timeout",
      message: expect.stringContaining("5ms"),
    });
  });

  test("function-local api gateway and webhook receiver helper copies pin api schema", async () => {
    const attempts = shared.buildRpcAuthAttempts({
      dbJwt: fakeJwt("edge_webhook_role"),
      secretKey: "sb_secret_test_value",
    });

    originalFetch = global.fetch;
    for (const modulePath of functionSharedModulePaths) {
      const fetchMock = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        }),
      );
      global.fetch = fetchMock;

      const localShared = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}-${Math.random()}`);
      const result = await localShared.invokeSupabaseRpcWithAuthFallback({
        url: "https://example.test/rest/v1/rpc/workflow_intake_webhook",
        body: { p_token: "token-123" },
        authAttempts: attempts,
      });

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const headers = new Headers(fetchMock.mock.calls[0][1].headers);
      expect(headers.get("accept-profile")).toBe("api");
      expect(headers.get("content-profile")).toBe("api");
    }
  });
});
