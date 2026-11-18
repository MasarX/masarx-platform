import type { Page } from "@playwright/test";
import { mergeRuntimeConfig, patchRuntimeConfig } from "../../tests/landing-e2e/helpers";

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
        driverSignupEndpoint: "/__landing-contact",
        trackingEndpoint: "/__landing-tracking",
        turnstileSiteKey: "site-key",
        untouched: true,
      });
    } finally {
      globalWindow.window = originalWindow;
    }
  });

  test("patchRuntimeConfig skips init script injection when no overrides are provided", async () => {
    const addInitScript = jest.fn(async () => undefined);
    const fakePage = {
      addInitScript,
    } as unknown as Page;

    await patchRuntimeConfig(fakePage);

    expect(addInitScript).not.toHaveBeenCalled();
  });

  test("patchRuntimeConfig keeps tenant signup endpoint explicit and separate from contact", async () => {
    const addInitScript = jest.fn(async () => undefined);
    const fakePage = {
      addInitScript,
    } as unknown as Page;

    await patchRuntimeConfig(fakePage, {
      contactEndpoint: "/__landing-contact",
      tenantSignupEndpoint: "/__tenant-signup",
    });

    expect(addInitScript).toHaveBeenCalledTimes(1);
    const [, runtimePatch] = addInitScript.mock.calls[0] || [];
    expect(runtimePatch).toEqual({
      contactEndpoint: "/__landing-contact",
      tenantSignupEndpoint: "/__tenant-signup",
      driverSignupEndpoint: "/__landing-contact",
    });
  });
});
