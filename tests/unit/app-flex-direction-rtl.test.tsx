/** Verify that FieldOps layout styles resolve flex direction for both reading directions. */

import * as fs from "node:fs";
import * as path from "node:path";

const APP_TSX_PATH = path.join(
  __dirname,
  "..",
  "..",
  "apps",
  "fieldops",
  "App.tsx",
);

describe("useRowDirection / resolveRowDirection RTL row mirror", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("resolveRowDirection returns 'row' when react-native is not installed", () => {
    jest.isolateModules(() => {
      jest.doMock("react-native", () => {
        throw new Error("not available");
      }, { virtual: true });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../../apps/fieldops/src/mobile-shell-rtl") as typeof import("../../apps/fieldops/src/mobile-shell-rtl");
      expect(mod.resolveRowDirection()).toBe("row");
    });
  });

  it("resolveRowDirection returns 'row-reverse' when isRTL is true (RTL)", () => {
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
      expect(mod.resolveRowDirection()).toBe("row-reverse");
    });
  });

  it("resolveRowDirection returns 'row' when isRTL is false (LTR)", () => {
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
      expect(mod.resolveRowDirection()).toBe("row");
    });
  });

  it("does not throw when I18nManager.isRTL is undefined", () => {
    jest.isolateModules(() => {
      jest.doMock(
        "react-native",
        () => ({ I18nManager: {} }),
        { virtual: true },
      );
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../../apps/fieldops/src/mobile-shell-rtl") as typeof import("../../apps/fieldops/src/mobile-shell-rtl");
      expect(() => mod.resolveRowDirection()).not.toThrow();
      expect(mod.resolveRowDirection()).toBe("row");
    });
  });

  it("App.tsx imports useRowDirection from mobile-shell-rtl", () => {
    const source = fs.readFileSync(APP_TSX_PATH, "utf8");
    expect(source).toMatch(/useRowDirection/);
    expect(source).toMatch(/from "\.\/src\/mobile-shell-rtl"/);
  });

  it("App.tsx defines shellRowDirection via the useRowDirection hook", () => {
    const source = fs.readFileSync(APP_TSX_PATH, "utf8");
    expect(source).toMatch(/const\s+shellRowDirection\s*=\s*useRowDirection\(\)/);
  });

  it("App.tsx applies flexDirection: shellRowDirection at >= 5 render sites", () => {
    const source = fs.readFileSync(APP_TSX_PATH, "utf8");
    const matches = source.match(/flexDirection:\s*shellRowDirection/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  it("returns a value usable as React Native FlexStyle.flexDirection (string literal union)", () => {
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
      const value = mod.resolveRowDirection();
      expect(value === "row" || value === "row-reverse").toBe(true);
    });
  });
});
