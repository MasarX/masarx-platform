import {
  resolveDirectionMode,
  resolveLocaleMode,
  resolveThemeMode,
  toAppearanceColorScheme,
} from "../../../apps/fieldops/src/mobile-shell-display";

describe("mobile shell display helpers", () => {
  test("resolveThemeMode accepts known values", () => {
    expect(resolveThemeMode("system")).toBe("system");
    expect(resolveThemeMode("light")).toBe("light");
    expect(resolveThemeMode("dark")).toBe("dark");
    expect(resolveThemeMode("unknown")).toBe("system");
  });

  test("resolveLocaleMode keeps en/ar only", () => {
    expect(resolveLocaleMode("en")).toBe("en");
    expect(resolveLocaleMode("ar")).toBe("ar");
    expect(resolveLocaleMode("es")).toBe("en");
  });

  test("resolveDirectionMode uses explicit value then locale fallback", () => {
    expect(resolveDirectionMode({ value: "rtl", locale: "en" })).toBe("rtl");
    expect(resolveDirectionMode({ value: null, locale: "ar" })).toBe("rtl");
    expect(resolveDirectionMode({ value: null, locale: "en" })).toBe("ltr");
  });

  test("toAppearanceColorScheme maps theme mode", () => {
    expect(toAppearanceColorScheme("system")).toBeNull();
    expect(toAppearanceColorScheme("light")).toBe("light");
    expect(toAppearanceColorScheme("dark")).toBe("dark");
  });
});
