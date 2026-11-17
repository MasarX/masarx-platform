import {
  getFieldOpsThemeTokens,
  resolveAppliedFieldOpsTheme,
} from "../../../apps/fieldops/src/mobile-theme";
import { computeMobileContrastRatio } from "../../../apps/fieldops/src/mobile-accessibility-audit";

describe("FieldOps theme foundation", () => {
  test("uses live system scheme only for system mode", () => {
    expect(resolveAppliedFieldOpsTheme("system", "dark")).toBe("dark");
    expect(resolveAppliedFieldOpsTheme("system", null)).toBe("light");
    expect(resolveAppliedFieldOpsTheme("system", "unspecified")).toBe("light");
    expect(resolveAppliedFieldOpsTheme("light", "dark")).toBe("light");
  });

  test("keeps explicit dark mode regardless of the system scheme", () => {
    expect(resolveAppliedFieldOpsTheme("dark", "light")).toBe("dark");
    expect(resolveAppliedFieldOpsTheme("dark", null)).toBe("dark");
    expect(resolveAppliedFieldOpsTheme("dark", undefined)).toBe("dark");
  });

  test("keeps layout tokens stable and platform fonts explicit", () => {
    const light = getFieldOpsThemeTokens("light", "web");
    const dark = getFieldOpsThemeTokens("dark", "native");
    expect(light.radius).toEqual(dark.radius);
    expect(light.font.sans).toContain("IBM Plex Sans");
    expect(dark.font.sans).toBeUndefined();
    expect(light.color.pageBg).not.toBe(dark.color.pageBg);
    expect(Object.keys(light.color).sort()).toEqual(Object.keys(dark.color).sort());
  });

  test.each(["light", "dark"] as const)("%s primary text meets AA on page and card", (theme) => {
    const { color } = getFieldOpsThemeTokens(theme, "native");
    expect(computeMobileContrastRatio(color.text, color.pageBg)).toBeGreaterThanOrEqual(4.5);
    expect(computeMobileContrastRatio(color.text, color.cardBg)).toBeGreaterThanOrEqual(4.5);
  });
});
