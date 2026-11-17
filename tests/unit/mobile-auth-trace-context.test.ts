const createClientMock = jest.fn();

jest.mock("@supabase/supabase-js", () => ({
  createClient: (...args: any[]) => createClientMock(...args),
}));

import { createMobileClient } from "../../packages/auth/src/mobile";

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
