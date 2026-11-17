import type { Page } from "@playwright/test";
import {
  LANDING_TURNSTILE_DUMMY_TOKEN,
  mergeRuntimeConfig,
  mockTurnstile,
  patchRuntimeConfig,
} from "../../tests/landing-e2e/helpers";

describe("landing runtime patching", () => {
  test("mergeRuntimeConfig preserves existing keys while applying runtime overrides", () => {
    expect(
      mergeRuntimeConfig(
        {
          appUrl: "https://app.example.com/login",
          trackingEndpoint: "/__landing-tracking",
        },
        { turnstileSiteKey: "site-key", untouched: true },
      ),
    ).toEqual({
      appUrl: "https://app.example.com/login",
      trackingEndpoint: "/__landing-tracking",
      turnstileSiteKey: "site-key",
      untouched: true,
    });
  });

  test("patchRuntimeConfig installs an init script that merges assigned runtime config", async () => {
    const addInitScript = jest.fn(async () => undefined);
    const fakePage = {
      addInitScript,
    } as unknown as Page;

    await patchRuntimeConfig(fakePage, {
      appUrl: "https://app.example.com/login",
      contactEndpoint: "/__landing-contact",
    });

    expect(addInitScript).toHaveBeenCalledTimes(1);
    const [initScript, runtimePatch] = addInitScript.mock.calls[0] || [];
    expect(typeof initScript).toBe("function");
    expect(runtimePatch).toEqual({
      appUrl: "https://app.example.com/login",
      contactEndpoint: "/__landing-contact",
      tenantSignupEndpoint: "/__tenant-signup",
      driverSignupEndpoint: "/__landing-contact",
    });

    const globalWindow = globalThis as typeof globalThis & {
      window?: { MASARX_RUNTIME?: unknown };
    };
    const originalWindow = globalWindow.window;
    try {
      globalWindow.window = {
        MASARX_RUNTIME: {
          turnstileSiteKey: "site-key",
          untouched: true,
        },
      };

      await initScript(runtimePatch);

      expect(globalWindow.window?.MASARX_RUNTIME).toEqual({
        appUrl: "https://app.example.com/login",
        contactEndpoint: "/__landing-contact",
        tenantSignupEndpoint: "/__tenant-signup",
        driverSignupEndpoint: "/__landing-contact",
        turnstileSiteKey: "site-key",
        untouched: true,
      });

      globalWindow.window!.MASARX_RUNTIME = {
        ...(globalWindow.window?.MASARX_RUNTIME as Record<string, unknown>),
        trackingEndpoint: "/__landing-tracking",
      };

      expect(globalWindow.window?.MASARX_RUNTIME).toEqual({
        appUrl: "https://app.example.com/login",
        contactEndpoint: "/__landing-contact",
        tenantSignupEndpoint: "/__tenant-signup",
        driverSignupEndpoint: "/__landing-contact",
        trackingEndpoint: "/__landing-tracking",
        turnstileSiteKey: "site-key",
        untouched: true,
      });
    } finally {
      globalWindow.window = originalWindow;
    }
  });

  test("mockTurnstile installs only the exact fixed local dummy token", async () => {
    let routeHandler: ((route: { fulfill: jest.Mock }) => Promise<void>) | undefined;
    const route = jest.fn(async (_pattern, handler) => {
      routeHandler = handler;
    });
    const fakePage = { route } as unknown as Page;

    await mockTurnstile(fakePage, LANDING_TURNSTILE_DUMMY_TOKEN);

    expect(route).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/**",
      expect.any(Function),
    );
    const fulfill = jest.fn(async () => undefined);
    await routeHandler?.({ fulfill });
    expect(fulfill).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 200,
        body: expect.stringContaining(
          `const fixedToken = "${LANDING_TURNSTILE_DUMMY_TOKEN}"`,
        ),
      }),
    );
  });

  test("mockTurnstile rejects every other fixed token before routing", async () => {
    const route = jest.fn();
    const fakePage = { route } as unknown as Page;

    await expect(mockTurnstile(fakePage, "not-the-official-dummy-token")).rejects.toThrow(
      "official local dummy token",
    );
    expect(route).not.toHaveBeenCalled();
  });

  test("patchRuntimeConfig skips init script injection when no overrides are provided", async () => {
    const addInitScript = jest.fn(async () => undefined);
    const fakePage = {
      addInitScript,
    } as unknown as Page;

    await patchRuntimeConfig(fakePage);

    expect(addInitScript).not.toHaveBeenCalled();
  });
});

test("document return endpoint is independently wired into runtime overrides", async () => {
  const addInitScript = jest.fn(async () => undefined);
  await patchRuntimeConfig({ addInitScript } as unknown as Page, { driverApplicationDocumentsEndpoint: "/__driver-documents" });
  expect(addInitScript.mock.calls[0][1]).toEqual({ driverApplicationDocumentsEndpoint: "/__driver-documents" });
});
