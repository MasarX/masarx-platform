/* eslint-disable @typescript-eslint/no-var-requires */

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
});

