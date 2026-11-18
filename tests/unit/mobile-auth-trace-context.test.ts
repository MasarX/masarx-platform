const createClientMock = jest.fn();

jest.mock("@supabase/supabase-js", () => ({
  ...jest.requireActual("@supabase/supabase-js"),
  createClient: (...args: any[]) => createClientMock(...args),
}));

import { createMobileClient, createSupabaseExecutor } from "../../packages/auth/src/mobile";

type Storage = {
  getItem: jest.Mock<Promise<string | null>, [string]>;
  setItem: jest.Mock<Promise<void>, [string, string]>;
  removeItem: jest.Mock<Promise<void>, [string]>;
};

function createMemoryStorage(): Storage {
  return {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  };
}

describe("mobile trace context instrumentation", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    createClientMock.mockReset();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test.each(["ok", "http", "throw"])("traces one %s transport lifecycle without exposing secrets or changing outcomes", async outcome => {
    const response = new Response("private response body", { status: outcome === "http" ? 503 : 200, statusText: "private status text" });
    const failure = new Error("private exception message");
    const events: any[] = [];
    global.fetch = jest.fn(async (_input, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      expect(headers.get("x-correlation-id")).toBe("correlation");
      expect(headers.get("traceparent")).toBe("trace");
      if (outcome === "throw") throw failure;
      return response;
    });
    createClientMock.mockReturnValue({});
    createMobileClient({
      supabaseUrl: "https://rpc-proof.invalid", supabaseAnonKey: "private key", storage: createMemoryStorage(),
      getTraceContext: () => ({ correlationId: "correlation", traceparent: "trace" }),
      onRequestTrace: event => { events.push(event); throw new Error("observer failed"); },
    });
    const run = createClientMock.mock.calls[0][2].global.fetch(
      (["https",":","/","/","user",":","private-password","@","rpc-proof.invalid","/","rest","/","v1","/","rpc","/","action","?","token=private-query","#","private-fragment"].join("")),
      { method: "POST", body: "private body", headers: { authorization: "Bearer private-token" } },
    );
    if (outcome === "throw") await expect(run).rejects.toBe(failure);
    else await expect(run).resolves.toBe(response);
    expect(events).toHaveLength(2);
    expect(events.map(e => e.phase)).toEqual(["start", outcome === "ok" ? "end" : "error"]);
    for (const event of events) expect(event).toMatchObject({
      method: "POST", url: "https://rpc-proof.invalid/rest/v1/rpc/action",
      correlationId: "correlation", traceparent: "trace",
    });
    expect(events[0].durationMs).toBeUndefined();
    expect(Number.isFinite(events[1].durationMs)).toBe(true);
    expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(events[1].status).toBe(outcome === "throw" ? undefined : response.status);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test.each(["ui_log_events_v1", "ui_log_events_v1_extra"])("lifecycle suppresses only exact telemetry RPC %s", async name => {
    const events: any[] = [], onRequestFailure = jest.fn();
    global.fetch = jest.fn(async () => new Response("{}", { status: 503 }));
    createClientMock.mockReturnValue({});
    createMobileClient({ supabaseUrl: "https://rpc-proof.invalid", supabaseAnonKey: "key",
      storage: createMemoryStorage(), onRequestTrace: e => events.push(e), onRequestFailure });
    await createClientMock.mock.calls[0][2].global.fetch("https://rpc-proof.invalid/rest/v1/rpc/" + name);
    expect(events).toHaveLength(name === "ui_log_events_v1" ? 0 : 2);
    expect(onRequestFailure).toHaveBeenCalledTimes(1);
  });
  test("lifecycle does not expose dynamic Storage object paths", async () => {
    const events: any[] = [];
    global.fetch = jest.fn(async () => new Response("{}", { status: 200 }));
    createClientMock.mockReturnValue({});
    createMobileClient({ supabaseUrl: "https://rpc-proof.invalid", supabaseAnonKey: "key",
      storage: createMemoryStorage(), onRequestTrace: e => events.push(e) });
    await createClientMock.mock.calls[0][2].global.fetch("https://rpc-proof.invalid/storage/v1/object/private-bucket/private-key?token=private");
    expect(events).toHaveLength(2);
    expect(events.every(e => e.url === "https://rpc-proof.invalid/[redacted-path]")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private");
  });
  test.each([undefined, "api", "public"])("preserves API default and explicit schema %s without changing auth options", schema => {
    const storage = createMemoryStorage();
    createClientMock.mockReturnValue({ rpc: jest.fn() });
    createMobileClient({
      supabaseUrl: "https://rpc-proof.invalid", supabaseAnonKey: "test-only-key", storage,
      ...(schema === undefined ? {} : { schema }),
    });
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledWith("https://rpc-proof.invalid", "test-only-key", {
      db: { schema: schema ?? "api" },
      auth: { storage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
      global: { fetch: expect.any(Function) },
    });
  });

  test("adds correlation headers and calls failure hook on non-ok responses", async () => {
    const storage = createMemoryStorage();
    const onRequestFailure = jest.fn();

    global.fetch = jest.fn(async (input, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      expect(headers.get("x-existing")).toBe("existing-value");
      expect(headers.get("x-correlation-id")).toBe("corr-mobile-1");
      expect(headers.get("traceparent")).toBe("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");

      return new Response("{}", { status: 503, statusText: "Service Unavailable" });
    });

    createClientMock.mockReturnValue({ rpc: jest.fn() });

    createMobileClient({
      supabaseUrl: "https://tenant.supabase.co",
      supabaseAnonKey: "anon-key",
      storage,
      getTraceContext: () => ({
        correlationId: "corr-mobile-1",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      }),
      onRequestFailure,
    });

    const clientOptions = createClientMock.mock.calls[0][2] as {
      global: { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> };
    };

    const tracedFetch = clientOptions.global.fetch;
    const response = await tracedFetch("https://tenant.supabase.co/rest/v1/rpc/issue_mobile_attestation_challenge_v1?x-token=abc", {
      method: "post",
      headers: { "x-existing": "existing-value" },
    });

    expect(response.status).toBe(503);
    expect(onRequestFailure).toHaveBeenCalledTimes(1);
    expect(onRequestFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "https://tenant.supabase.co/rest/v1/rpc/issue_mobile_attestation_challenge_v1",
        status: 503,
        correlationId: "corr-mobile-1",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      })
    );
  });

  test("does not call failure hook for successful responses", async () => {
    const storage = createMemoryStorage();
    const onRequestFailure = jest.fn();

    global.fetch = jest.fn(async () => new Response("{}", { status: 200, statusText: "OK" }));
    createClientMock.mockReturnValue({ rpc: jest.fn() });

    createMobileClient({
      supabaseUrl: "https://tenant.supabase.co",
      supabaseAnonKey: "anon-key",
      storage,
      onRequestFailure,
    });

    const clientOptions = createClientMock.mock.calls[0][2] as {
      global: { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> };
    };

    const response = await clientOptions.global.fetch("https://tenant.supabase.co/rest/v1/rpc/test", {
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(onRequestFailure).not.toHaveBeenCalled();
  });

  test("calls failure hook when request throws", async () => {
    const storage = createMemoryStorage();
    const onRequestFailure = jest.fn();
    const networkFailure = new Error("network down");

    global.fetch = jest.fn(async () => {
      throw networkFailure;
    });
    createClientMock.mockReturnValue({ rpc: jest.fn() });

    createMobileClient({
      supabaseUrl: "https://tenant.supabase.co",
      supabaseAnonKey: "anon-key",
      storage,
      getTraceContext: () => ({
        correlationId: "corr-mobile-2",
        traceparent: "00-abcdef1234567890abcdef1234567890-abcdef1234567890-01",
      }),
      onRequestFailure,
    });

    const clientOptions = createClientMock.mock.calls[0][2] as {
      global: { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> };
    };

    const tracedFetch = clientOptions.global.fetch;
    await expect(
      tracedFetch("https://tenant.supabase.co/rest/v1/rpc/test-transport-failure", { method: "GET" })
    ).rejects.toThrow("network down");

    expect(onRequestFailure).toHaveBeenCalledTimes(1);
    expect(onRequestFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: "https://tenant.supabase.co/rest/v1/rpc/test-transport-failure",
        correlationId: "corr-mobile-2",
        traceparent: "00-abcdef1234567890abcdef1234567890-abcdef1234567890-01",
        error: "network down",
      })
    );
  });

  test("preserves successful request when callback is absent", async () => {
    const storage = createMemoryStorage();

    global.fetch = jest.fn(async () => new Response("{}", { status: 200, statusText: "OK" }));
    createClientMock.mockReturnValue({ rpc: jest.fn() });

    createMobileClient({
      supabaseUrl: "https://tenant.supabase.co",
      supabaseAnonKey: "anon-key",
      storage,
    });

    const clientOptions = createClientMock.mock.calls[0][2] as {
      global: { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> };
    };

    const response = await clientOptions.global.fetch("https://tenant.supabase.co/rest/v1/health", {
      method: "PUT",
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);

    const usedHeaders = new Headers((global.fetch as jest.Mock).mock.calls[0][1].headers as HeadersInit);
    expect(usedHeaders.get("x-correlation-id")).toMatch(
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
    );
    expect(usedHeaders.get("traceparent")).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/
    );
  });
});

describe("mobile outbox transport executor", () => {
  function setup(error: unknown = null) {
    const client = { rpc: jest.fn().mockResolvedValue({ data: { rpc: true }, error: null }),
      functions: { invoke: jest.fn().mockResolvedValue({ data: { edge: true }, error }) } };
    return { client, execute: createSupabaseExecutor(client as any) };
  }
  test("legacy RPC and explicit Edge use independent SDK methods", async () => {
    const { client, execute } = setup();
    await expect(execute("legacy", { x: 1 })).resolves.toEqual({ rpc: true });
    await expect(execute("fieldops-reassignment-request", { x: 2 }, "edge")).resolves.toEqual({ edge: true });
    expect(client.rpc).toHaveBeenCalledWith("legacy", { x: 1 });
    expect(client.functions.invoke).toHaveBeenCalledWith("fieldops-reassignment-request", { body: { x: 2 } });
  });
  test.each([401, 429, 503])("HTTP %i preserves status for the existing retry classifier", async (status) => {
    const error = Object.assign(new Error("HTTP"), { name: "FunctionsHttpError", context: new Response(null, { status }) });
    const { execute } = setup(error);
    await expect(execute("function-name", {}, "edge")).rejects.toMatchObject({ status });
    const { isRetriableSupabaseError } = require("../../packages/api/src/retry");
    expect(isRetriableSupabaseError(error)).toBe(status !== 401);
  });
  test("relay with HTTP 200 remains retryable and fetch failure maps to network error", async () => {
    const relay = Object.assign(new Error("relay"), {
      name: "FunctionsRelayError", context: new Response(null, { status: 200, headers: { "x-relay-error": "true" } }),
    });
    await expect(setup(relay).execute("function-name", {}, "edge")).rejects.toMatchObject({ status: 503 });
    const { isRetriableSupabaseError, isRetriableNetworkError } = require("../../packages/api/src/retry");
    expect(isRetriableSupabaseError(relay)).toBe(true);
    const fetchError = await setup(Object.assign(new Error("fetch"), { name: "FunctionsFetchError" }))
      .execute("function-name", {}, "edge").then(() => { throw new Error("expected rejection"); }, (error) => error);
    expect(fetchError).toBeInstanceOf(TypeError);
    expect(isRetriableNetworkError(fetchError)).toBe(true);
  });
  test("unknown transport and URL-like targets never invoke a client", async () => {
    const { client, execute } = setup();
    await expect(execute("name", {}, "http" as any)).rejects.toThrow("Unsupported");
    await expect(execute("https://foreign.invalid", {}, "edge")).rejects.toThrow("Unsupported");
    expect(client.functions.invoke).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
