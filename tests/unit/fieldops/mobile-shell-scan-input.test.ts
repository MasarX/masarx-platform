import {
  defaultScanInputModeForPlatform,
  defaultScanInputModesForPlatform,
  resolveAllowedScanInputModes,
  resolveEffectiveScanInputMode,
} from "../../../apps/fieldops/src/mobile-shell-scan-input";

describe("mobile shell scan input helpers", () => {
  test("default scan mode follows platform", () => {
    expect(defaultScanInputModeForPlatform("android")).toBe("camera");
    expect(defaultScanInputModeForPlatform("ios")).toBe("camera");
    expect(defaultScanInputModeForPlatform("scanner")).toBe("scanner");
  });

  test("default allowed modes are platform aware", () => {
    expect(defaultScanInputModesForPlatform("android")).toEqual(["camera", "scanner"]);
    expect(defaultScanInputModesForPlatform("scanner")).toEqual(["scanner"]);
  });

  test("resolveAllowedScanInputModes reads policy rows when present", () => {
    expect(
      resolveAllowedScanInputModes({
        policyValue: { scan_input_modes: ["scanner", "camera", "scanner"] },
        platform: "android",
      })
    ).toEqual(["scanner", "camera"]);
  });

  test("resolveAllowedScanInputModes falls back to platform defaults", () => {
    expect(
      resolveAllowedScanInputModes({
        policyValue: {},
        platform: "scanner",
      })
    ).toEqual(["scanner"]);
  });

  test("resolveEffectiveScanInputMode keeps stored allowed mode", () => {
    expect(
      resolveEffectiveScanInputMode({
        storedMode: "scanner",
        platform: "android",
        allowedModes: ["camera", "scanner"],
      })
    ).toBe("scanner");
  });

  test("resolveEffectiveScanInputMode falls back when stored mode is invalid", () => {
    expect(
      resolveEffectiveScanInputMode({
        storedMode: "unsupported",
        platform: "android",
        allowedModes: ["scanner"],
      })
    ).toBe("scanner");
  });
});
