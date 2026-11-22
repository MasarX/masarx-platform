import { randomUUID } from "node:crypto";

type CrashModule = typeof import("../../../apps/fieldops/src/mobile-crash-reporting");

type SentryMock = {
  init: jest.Mock;
  setTag: jest.Mock;
  setUser: jest.Mock;
  addBreadcrumb: jest.Mock;
  captureException: jest.Mock;
};

function loadCrashModule(dev = false): { mod: CrashModule; sentry: SentryMock } {
  jest.resetModules();
  (globalThis as { __DEV__?: boolean }).__DEV__ = dev;

  const sentry: SentryMock = {
    init: jest.fn(),
    setTag: jest.fn(),
    setUser: jest.fn(),
    addBreadcrumb: jest.fn(),
    captureException: jest.fn(),
  };

  jest.doMock("@sentry/react-native", () => sentry, { virtual: true });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("../../../apps/fieldops/src/mobile-crash-reporting") as CrashModule;
  return { mod, sentry };
}

describe("mobile crash reporting", () => {
  test("stays disabled when DSN is missing", () => {
    const { mod, sentry } = loadCrashModule(false);

    expect(mod.initMobileCrashReporting({ dsn: null })).toBe(false);
    expect(mod.isMobileCrashReportingEnabled()).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
  });

  test("treats whitespace DSN as disabled", () => {
    const { mod, sentry } = loadCrashModule(false);
    expect(mod.initMobileCrashReporting({ dsn: "   " })).toBe(false);
    expect(mod.isMobileCrashReportingEnabled()).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
  });

  test("stays disabled in dev mode unless enabledInDev is true", () => {
    const { mod, sentry } = loadCrashModule(true);
    expect(mod.initMobileCrashReporting({ dsn: "https://dsn.example/1" })).toBe(false);
    expect(mod.isMobileCrashReportingEnabled()).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
  });

  test("initializes in dev mode when enabledInDev is true", () => {
    const { mod, sentry } = loadCrashModule(true);
    expect(
      mod.initMobileCrashReporting({
        dsn: "https://dsn.example/1",
        enabledInDev: true,
      })
    ).toBe(true);
    expect(sentry.init).toHaveBeenCalledTimes(1);
  });

  test("initializes in production and redacts sensitive payloads", () => {
    const { mod, sentry } = loadCrashModule(false);
    const marker = randomUUID();
    const authorization = "Authorization=" + "Bearer " + marker;

    expect(
      mod.initMobileCrashReporting({
        dsn: "https://mloqmmsjtklyzhkvmlhjtrlv@example.invalid/0",
        environment: "prod",
        release: "fieldops@1.0.0",
      })
    ).toBe(true);

    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(sentry.setTag).toHaveBeenCalledWith("surface", "fieldops");

    const options = sentry.init.mock.calls[0]?.[0] || {};
    const beforeSend = options.beforeSend as (event: Record<string, unknown>) => Record<string, unknown>;
    const event = beforeSend({
      message: authorization + " token=" + marker,
      request: {
        url: "https://example.com",
        method: "POST",
        headers: { authorization: "Bearer " + marker },
        data: { payload: true },
      },
      exception: {
        values: [{ type: "AuthError", value: "refresh_token=" + marker }],
      },
    });

    expect(event.request).toEqual({ url: "https://example.com", method: "POST" });
    expect(JSON.stringify(event)).not.toContain(marker);
    expect(event.message).toMatch(/\[REDACTED/);
    expect((event as any).exception.values[0].value).toMatch(/\[REDACTED/);

    const beforeBreadcrumb = options.beforeBreadcrumb as (breadcrumb: Record<string, unknown>) => Record<string, unknown>;
    const breadcrumb = beforeBreadcrumb({
      category: "auth.session",
      message: authorization,
      data: {
        token: marker,
        safe: "ok",
      },
    });
    expect(JSON.stringify(breadcrumb)).not.toContain(marker);
    expect(breadcrumb.message).toMatch(/\[REDACTED/);
    expect(breadcrumb.data).toEqual({});

    expect(
      beforeBreadcrumb({
        category: "navigation",
        message: "safe message",
        data: { safe: "ok", password: "hide", count: 1 },
      })
    ).toEqual({
      category: "navigation",
      message: "safe message",
      data: { safe: "ok", count: 1 },
    });

    expect(beforeBreadcrumb(null as any)).toBeNull();

    const compact = beforeSend({
      message: "safe",
      request: {
        headers: { authorization: "token" },
      },
      exception: {
        values: [{ type: "ErrorType", value: "details", extra: 1 }],
      },
    });
    expect(compact.request).toEqual({});
    expect((compact as any).exception.values[0]).toEqual(
      expect.objectContaining({ type: "ErrorType", value: "details", extra: 1 })
    );
  });

  test("adds redacted network breadcrumbs and captures exceptions when enabled", () => {
    const { mod, sentry } = loadCrashModule(false);
    const marker = randomUUID();

    mod.initMobileCrashReporting({ dsn: "https://dsn.example/1" });

    mod.addMobileNetworkFailureBreadcrumb({
      method: "POST",
      url: "https://api.example.com/mobile",
      status: 401,
      statusText: "Unauthorized",
      correlationId: "cid-1",
      traceparent: "tp-1",
      error: "Bearer " + marker,
    });

    expect(sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
    const breadcrumb = sentry.addBreadcrumb.mock.calls[0]?.[0] || {};
    expect(breadcrumb.category).toBe("http");
    expect(breadcrumb.data?.error).not.toContain(marker);
    expect(breadcrumb.data?.error).toMatch(/\[REDACTED/);

    mod.setMobileCrashReportingUser({ id: "u-1", email: "driver@example.com" });
    mod.captureMobileException(new Error("boom"), { feature: "location" }, { surface: "mobile" });
    mod.captureMobileException("string error", { source: "string" }, { scope: "fallback" } as any);
    mod.setMobileCrashReportingUser({ id: "u-2", email: "" as any });
    mod.setMobileCrashReportingUser(null);

    expect(sentry.setUser).toHaveBeenCalledWith({ id: "u-1", email: "driver@example.com" });
    expect(sentry.captureException).toHaveBeenCalledTimes(2);
    const secondCapture = sentry.captureException.mock.calls[1]?.[0];
    expect(secondCapture).toBeInstanceOf(Error);
    expect(String(secondCapture?.message || "")).toContain("string error");
    expect(sentry.setUser).toHaveBeenCalledWith({ id: "u-2" });
    expect(sentry.setUser).toHaveBeenLastCalledWith(null);

    mod.addMobileNetworkFailureBreadcrumb({
      method: "GET",
      url: "https://api.example.com/ping",
      status: undefined,
      statusText: undefined,
      correlationId: "cid-2",
      traceparent: "tp-2",
      error: undefined,
    });
    const secondBreadcrumb = sentry.addBreadcrumb.mock.calls[1]?.[0] || {};
    expect(secondBreadcrumb.data).toEqual(
      expect.objectContaining({
        status: null,
        statusText: null,
      })
    );
    expect(secondBreadcrumb.data.error).toBeUndefined();
  });

  test("no-ops breadcrumb/user/capture when reporting is disabled", () => {
    const { mod, sentry } = loadCrashModule(false);

    mod.addMobileNetworkFailureBreadcrumb({
      method: "GET",
      url: "https://api.example.com",
      status: 500,
      statusText: "Error",
      correlationId: "cid",
      traceparent: "tp",
      error: "token=abc",
    });
    mod.setMobileCrashReportingUser({ id: "u-1" });
    mod.captureMobileException(new Error("boom"));

    expect(sentry.addBreadcrumb).not.toHaveBeenCalled();
    expect(sentry.setUser).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  test("init is idempotent after first call", () => {
    const { mod, sentry } = loadCrashModule(false);

    expect(mod.initMobileCrashReporting({ dsn: "https://dsn.example/1" })).toBe(true);
    expect(mod.initMobileCrashReporting({ dsn: "https://dsn.example/2" })).toBe(true);
    expect(sentry.init).toHaveBeenCalledTimes(1);
  });
});
