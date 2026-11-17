import { DEFAULT_MOBILE_DEVICE_POLICY } from "../../../apps/fieldops/src/mobile-shell-policy";
import {
  resolveAllowedMobilePlatforms,
  resolveEffectiveMobilePlatform,
  resolveNormalizedPlatformOverride,
  resolveRuntimeMobilePlatform,
} from "../../../apps/fieldops/src/mobile-shell-platform";

describe("mobile shell platform helpers", () => {
  test("resolveRuntimeMobilePlatform maps runtime os safely", () => {
    expect(resolveRuntimeMobilePlatform("ios")).toBe("ios");
    expect(resolveRuntimeMobilePlatform("android")).toBe("android");
    expect(resolveRuntimeMobilePlatform("web")).toBe("android");
  });

  test("resolveAllowedMobilePlatforms returns unique allowed policy values", () => {
    expect(
      resolveAllowedMobilePlatforms({
        ...DEFAULT_MOBILE_DEVICE_POLICY,
        allowedPlatforms: ["scanner", "android", "scanner"],
        defaultPlatform: "scanner",
      })
    ).toEqual(["scanner", "android"]);
  });

  test("resolveNormalizedPlatformOverride keeps valid override only", () => {
    expect(
      resolveNormalizedPlatformOverride({
        storedOverride: "scanner",
        allowedPlatforms: ["android", "scanner"],
      })
    ).toBe("scanner");
    expect(
      resolveNormalizedPlatformOverride({
        storedOverride: "ios",
        allowedPlatforms: ["android", "scanner"],
      })
    ).toBeNull();
  });

  test("resolveEffectiveMobilePlatform prefers valid override", () => {
    expect(
      resolveEffectiveMobilePlatform({
        policy: {
          allowedPlatforms: ["android", "scanner"],
          defaultPlatform: "android",
        },
        runtimePlatform: "android",
        storedOverride: "scanner",
      })
    ).toBe("scanner");
  });

  test("resolveEffectiveMobilePlatform falls back to runtime/default when needed", () => {
    expect(
      resolveEffectiveMobilePlatform({
        policy: {
          allowedPlatforms: ["ios", "scanner"],
          defaultPlatform: "ios",
        },
        runtimePlatform: "android",
        storedOverride: null,
      })
    ).toBe("ios");
    expect(
      resolveEffectiveMobilePlatform({
        policy: {
          allowedPlatforms: ["scanner"],
          defaultPlatform: "scanner",
        },
        runtimePlatform: "android",
        storedOverride: "invalid",
      })
    ).toBe("scanner");
  });
});
