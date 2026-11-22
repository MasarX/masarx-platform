import {
  defaultScanInputModeForPlatform,
  defaultScanInputModesForPlatform,
  normalizeScanBarcode,
  resolveAllowedScanInputModes,
  resolveEffectiveScanInputMode,
} from "../../../apps/fieldops/src/mobile-shell-scan-input";
import * as fs from "fs";
import * as path from "path";

describe("mobile shell scan input helpers", () => {
  test("scanner wedge keeps native focus and routes its submit delimiter through the existing queue", () => {
    const source = fs.readFileSync(path.resolve("apps/fieldops/App.tsx"), "utf8");
    const start = source.indexOf("        ref={barcodeInputRef}");
    const input = source.slice(start, source.indexOf("      <View style={styles.screenActionsRow}", start));

    expect(source).toContain('if (effectiveScanInputMode === "scanner" && !scanReadOnly) barcodeInputRef.current?.focus();');
    expect(input).toContain('submitBehavior={effectiveScanInputMode === "scanner" ? "submit" : "blurAndSubmit"}');
    expect(input).toContain('if (effectiveScanInputMode === "scanner" && canQueue) void queueScan();');
    expect(input).not.toContain("onKeyDown");
    expect(source).toContain('testID="mobile-scan-queue"');
  });

  test("default scan mode follows platform", () => {
    expect(defaultScanInputModeForPlatform("android")).toBe("camera");
    expect(defaultScanInputModeForPlatform("ios")).toBe("camera");
    expect(defaultScanInputModeForPlatform("scanner")).toBe("scanner");
  });

  test("scanner submit prefers the completed native value when input state lags", () => {
    const source = fs.readFileSync(path.resolve("apps/fieldops/App.tsx"), "utf8");
    const start = source.indexOf("        ref={barcodeInputRef}");
    const input = source.slice(start, source.indexOf("      <View style={styles.screenActionsRow}", start));

    expect(input).toMatch(/onSubmitEditing=\{\(\{ nativeEvent \}\) => \{\s*if \(scanReadOnly\) return;\s*const submitted = nativeEvent\.text;/);
    expect(input).toMatch(/if \(typeof submitted !== "string" \|\| submitted === barcode\)[\s\S]*?else if \(effectiveScanInputMode === "scanner" && deviceId\) \{\s*void queueScan\(submitted\);/);
    expect(source).toContain('const scannedBarcode = normalizeScanBarcode(value);');
  });

  test("normalizes scanner framing while preserving case and interior separators", () => {
    expect(normalizeScanBarcode("  Synthetic\u001dBox-01\u0000\t\r\n")).toBe("Synthetic\u001dBox-01");
    expect(normalizeScanBarcode("\u0002\u0000 Synthetic\u001dBox-01\u0003\r\n")).toBe("Synthetic\u001dBox-01");
    expect(normalizeScanBarcode("\u0000\r\n")).toBe("");
  });

  test("default allowed modes are platform aware", () => {
    expect(defaultScanInputModesForPlatform("android")).toEqual(["camera", "scanner"]);
    expect(defaultScanInputModesForPlatform("scanner")).toEqual(["scanner"]);
  });

  test("resolveAllowedScanInputModes reads policy rows when present", () => {
    expect(
      resolveAllowedScanInputModes({
        policyValue: { scan_input_modes: ["scanner", "camera"] },
        platform: "android",
      })
    ).toEqual(["scanner", "camera"]);
  });

  test("scanner platform intersects the policy modes with device capability", () => {
    expect(resolveAllowedScanInputModes({
      policyValue: { scan_input_modes: ["camera", "scanner"] }, platform: "scanner",
    })).toEqual(["scanner"]);
    const allowedModes = resolveAllowedScanInputModes({
      policyValue: { scan_input_modes: ["camera"] }, platform: "scanner",
    });
    expect(allowedModes).toEqual([]);
    expect(resolveEffectiveScanInputMode({
      storedMode: "scanner", platform: "scanner", allowedModes,
    })).toBeNull();
  });

  test.each([
    {},
    { accepted_input_modes: ["scanner"] },
    { scan_input_modes: [] },
    { scan_input_modes: ["camera", "hardware"] },
    { scan_input_modes: ["scanner", "scanner"] },
    { scan_input_modes: null },
  ])("invalid or missing policy mode list fails closed (case %#)", (policyValue) => {
    const allowedModes = resolveAllowedScanInputModes({ policyValue, platform: "scanner" });
    expect(allowedModes).toEqual([]);
    expect(resolveEffectiveScanInputMode({
      storedMode: "scanner", platform: "scanner", allowedModes,
    })).toBeNull();
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

  test("scoped policy can restrict scanner input", () => {
    const allowedModes = resolveAllowedScanInputModes({
      policyValue: { scan_input_modes: ["camera"] }, platform: "android",
    });
    expect(allowedModes).toEqual(["camera"]);
    expect(resolveEffectiveScanInputMode({
      storedMode: "scanner", platform: "android", allowedModes,
    })).toBe("camera");
  });
});
