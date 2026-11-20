/* eslint-disable @typescript-eslint/no-require-imports */

describe("ui-context-cache", () => {
  const originalEnv = process.env;
  let now = 0;
  let nowSpy: jest.SpyInstance<number, []> | null = null;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    now = 0;
    nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    nowSpy?.mockRestore();
    process.env = originalEnv;
  });

  function loadModule() {
    return require("../../apps/shared/ui-context-cache") as typeof import("../../apps/shared/ui-context-cache");
  }

  function makeContext(label: string) {
    return {
      me: {
        user: { id: label },
        capabilities: ["*"]
      },
      navigation: { app: "console", sections: [] }
    };
  }

  test("caches context within TTL", async () => {
    process.env.MASARX_UI_CONTEXT_CACHE_TTL_MS = "1000";
    process.env.MASARX_UI_CONTEXT_CACHE_STALE_IF_ERROR_MS = "0";
    const { loadUiContextCached } = loadModule();

    const load = jest.fn(async () => makeContext("fresh"));
    const params = { appKey: "console", accessToken: "token-a", load };

    const first = await loadUiContextCached(params);
    const second = await loadUiContextCached(params);

    expect(first).toEqual(second);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("bypasses cache by default outside production", async () => {
    delete process.env.MASARX_UI_CONTEXT_CACHE_TTL_MS;
    delete process.env.MASARX_UI_CONTEXT_CACHE_STALE_IF_ERROR_MS;
    process.env = { ...process.env, NODE_ENV: "test" };
    const { loadUiContextCached } = loadModule();

    const load = jest
      .fn()
      .mockImplementationOnce(async () => makeContext("first"))
      .mockImplementationOnce(async () => makeContext("second"));
    const params = { appKey: "portal", accessToken: "token-dev", load };

    const first = await loadUiContextCached(params);
    const second = await loadUiContextCached(params);

    expect(first).not.toEqual(second);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("returns stale context on transient errors after TTL expiry", async () => {
    process.env.MASARX_UI_CONTEXT_CACHE_TTL_MS = "100";
    process.env.MASARX_UI_CONTEXT_CACHE_STALE_IF_ERROR_MS = "1000";
    const { loadUiContextCached } = loadModule();

    const load = jest
      .fn()
      .mockImplementationOnce(async () => makeContext("stale"))
      .mockImplementationOnce(async () => {
        throw new TypeError("fetch failed");
      });
    const params = { appKey: "console", accessToken: "token-b", load };

    const first = await loadUiContextCached(params);
    expect(load).toHaveBeenCalledTimes(1);

    now = 200; // expired TTL but within stale-if-error window
    const second = await loadUiContextCached(params);
    expect(second).toEqual(first);
    expect(load).toHaveBeenCalledTimes(2);

    now = 250;
    const third = await loadUiContextCached(params);
    expect(third).toEqual(first);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("does not return stale context for non-transient errors", async () => {
    process.env.MASARX_UI_CONTEXT_CACHE_TTL_MS = "100";
    process.env.MASARX_UI_CONTEXT_CACHE_STALE_IF_ERROR_MS = "1000";
    const { loadUiContextCached } = loadModule();

    const load = jest
      .fn()
      .mockImplementationOnce(async () => makeContext("stale"))
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("permission denied"), { status: 403 });
      });
    const params = { appKey: "console", accessToken: "token-c", load };

    await loadUiContextCached(params);
    now = 200;
    await expect(loadUiContextCached(params)).rejects.toThrow("permission denied");
  });

  test("repeated failures cannot extend the original stale deadline or retry TTL past it", async () => {
    process.env.MASARX_UI_CONTEXT_CACHE_TTL_MS = "100";
    process.env.MASARX_UI_CONTEXT_CACHE_STALE_IF_ERROR_MS = "1000";
    const { loadUiContextCached } = loadModule();
    const context = makeContext("last-success");
    const load = jest.fn()
      .mockResolvedValueOnce(context)
      .mockRejectedValue(new TypeError("fetch failed"));
    const params = { appKey: "console", accessToken: "bounded-token", load };

    await loadUiContextCached(params);
    now = 200;
    expect(await loadUiContextCached(params)).toEqual(context);
    now = 1050;
    expect(await loadUiContextCached(params)).toEqual(context);
    now = 1099;
    expect(await loadUiContextCached(params)).toEqual(context);
    expect(load).toHaveBeenCalledTimes(3);

    now = 1100; // The original success expired at 100, plus the 1000ms stale allowance.
    await expect(loadUiContextCached(params)).rejects.toThrow("fetch failed");
    expect(load).toHaveBeenCalledTimes(4);
  });

  test("does not serve stale context when a slow refresh fails after its deadline", async () => {
    process.env.MASARX_UI_CONTEXT_CACHE_TTL_MS = "100";
    process.env.MASARX_UI_CONTEXT_CACHE_STALE_IF_ERROR_MS = "1000";
    const { loadUiContextCached } = loadModule();
    const load = jest.fn()
      .mockResolvedValueOnce(makeContext("expired"))
      .mockImplementationOnce(async () => {
        now = 1100;
        throw new TypeError("fetch failed");
      });
    const params = { appKey: "console", accessToken: "slow-token", load };

    await loadUiContextCached(params);
    now = 1050;
    await expect(loadUiContextCached(params)).rejects.toThrow("fetch failed");
  });

  test("another token refreshing does not prune context still eligible for stale fallback", async () => {
    process.env.MASARX_UI_CONTEXT_CACHE_TTL_MS = "100";
    process.env.MASARX_UI_CONTEXT_CACHE_STALE_IF_ERROR_MS = "1000";
    const { loadUiContextCached } = loadModule();
    const context = makeContext("retained");
    const load = jest.fn()
      .mockResolvedValueOnce(context)
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const params = { appKey: "console", accessToken: "retained-token", load };

    await loadUiContextCached(params);
    now = 200;
    await loadUiContextCached({
      appKey: "console",
      accessToken: "other-token",
      load: async () => makeContext("other-user"),
    });

    expect(await loadUiContextCached(params)).toEqual(context);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("a successful refresh establishes a new stale deadline", async () => {
    process.env.MASARX_UI_CONTEXT_CACHE_TTL_MS = "100";
    process.env.MASARX_UI_CONTEXT_CACHE_STALE_IF_ERROR_MS = "1000";
    const { loadUiContextCached } = loadModule();
    const refreshed = makeContext("refreshed");
    const load = jest.fn()
      .mockResolvedValueOnce(makeContext("original"))
      .mockResolvedValueOnce(refreshed)
      .mockRejectedValue(new TypeError("fetch failed"));
    const params = { appKey: "console", accessToken: "refresh-token", load };

    await loadUiContextCached(params);
    now = 200;
    expect(await loadUiContextCached(params)).toEqual(refreshed);
    now = 1200; // Beyond the first success's deadline, within the refreshed deadline.
    expect(await loadUiContextCached(params)).toEqual(refreshed);
    now = 1300;
    await expect(loadUiContextCached(params)).rejects.toThrow("fetch failed");
  });
});

