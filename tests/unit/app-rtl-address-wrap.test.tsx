/** Verify that address wrapping preserves readable text in right-to-left layouts. */

describe("useTextStart / resolveTextStart RTL address wrap", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("resolveTextStart returns 'left' when react-native is not installed", () => {
    jest.isolateModules(() => {
      // Force the require() inside safeReadI18nManager to throw so the
      // helper falls back to the LTR default — this matches the
      // jsdom/node test runner environment.
      jest.doMock("react-native", () => {
        throw new Error("not available");
      }, { virtual: true });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../../apps/fieldops/src/mobile-shell-rtl") as typeof import("../../apps/fieldops/src/mobile-shell-rtl");
      expect(mod.resolveTextStart()).toBe("left");
      expect(mod.resolveIsRTL()).toBe(false);
    });
  });

  it("resolveTextStart returns 'right' when I18nManager.isRTL is true (RTL)", () => {
    jest.isolateModules(() => {
      jest.doMock(
        "react-native",
        () => ({
          I18nManager: { isRTL: true, allowRTL: () => undefined, forceRTL: () => undefined },
        }),
        { virtual: true },
      );
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../../apps/fieldops/src/mobile-shell-rtl") as typeof import("../../apps/fieldops/src/mobile-shell-rtl");
      expect(mod.resolveTextStart()).toBe("right");
      expect(mod.resolveIsRTL()).toBe(true);
    });
  });

  it("resolveTextStart returns 'left' when I18nManager.isRTL is false (LTR)", () => {
    jest.isolateModules(() => {
      jest.doMock(
        "react-native",
        () => ({
          I18nManager: { isRTL: false, allowRTL: () => undefined, forceRTL: () => undefined },
        }),
        { virtual: true },
      );
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../../apps/fieldops/src/mobile-shell-rtl") as typeof import("../../apps/fieldops/src/mobile-shell-rtl");
      expect(mod.resolveTextStart()).toBe("left");
    });
  });

  it("resolveTextEnd returns the opposite of resolveTextStart in both branches", () => {
    jest.isolateModules(() => {
      jest.doMock(
        "react-native",
        () => ({
          I18nManager: { isRTL: true, allowRTL: () => undefined, forceRTL: () => undefined },
        }),
        { virtual: true },
      );
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../../apps/fieldops/src/mobile-shell-rtl") as typeof import("../../apps/fieldops/src/mobile-shell-rtl");
      expect(mod.resolveTextStart()).toBe("right");
      expect(mod.resolveTextEnd()).toBe("left");
    });

    jest.isolateModules(() => {
      jest.doMock(
        "react-native",
        () => ({
          I18nManager: { isRTL: false, allowRTL: () => undefined, forceRTL: () => undefined },
        }),
        { virtual: true },
      );
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../../apps/fieldops/src/mobile-shell-rtl") as typeof import("../../apps/fieldops/src/mobile-shell-rtl");
      expect(mod.resolveTextStart()).toBe("left");
      expect(mod.resolveTextEnd()).toBe("right");
    });
  });

  it("does not throw when I18nManager is missing on the react-native export", () => {
    jest.isolateModules(() => {
      jest.doMock(
        "react-native",
        () => ({}),
        { virtual: true },
      );
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../../apps/fieldops/src/mobile-shell-rtl") as typeof import("../../apps/fieldops/src/mobile-shell-rtl");
      expect(() => mod.resolveTextStart()).not.toThrow();
      expect(mod.resolveTextStart()).toBe("left");
    });
  });

  it("returns a value usable as Text.style.textAlign (string literal union)", () => {
    jest.isolateModules(() => {
      jest.doMock(
        "react-native",
        () => ({
          I18nManager: { isRTL: true, allowRTL: () => undefined, forceRTL: () => undefined },
        }),
        { virtual: true },
      );
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../../apps/fieldops/src/mobile-shell-rtl") as typeof import("../../apps/fieldops/src/mobile-shell-rtl");
      const value = mod.resolveTextStart();
      // TypeScript-narrow the value at runtime so the test fails if the
      // union ever drifts away from "left" | "right".
      expect(value === "left" || value === "right").toBe(true);
    });
  });

  it("the App.tsx address card uses textAlign=textStart for RTL parity", () => {
    // Source-level guard: if anyone removes the `textAlign: addressTextStart`
    // wiring we want the unit suite to catch it without booting the full
    // App.tsx React tree. We grep the file directly.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("node:path") as typeof import("node:path");
    const appPath = path.join(
      __dirname,
      "..",
      "..",
      "apps",
      "fieldops",
      "App.tsx",
    );
    const source = fs.readFileSync(appPath, "utf8");
    expect(source).toContain("const addressTextStart = useTextStart()");
    expect(source).toMatch(/textAlign:\s*addressTextStart/);
  });
});
