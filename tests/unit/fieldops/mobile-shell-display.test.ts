import {
  normalizeMobileDisplayPolicy,
  resolveEffectiveDirection,
  resolveEffectiveLocale,
  resolveEffectiveTheme,
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

  test("normalizes nested row-driven display policy", () => {
    const policy = normalizeMobileDisplayPolicy({
      display: {
        allowed_locales: ["ar"],
        default_locale: "ar",
        allow_locale_select: false,
        allowed_themes: ["dark", "light"],
        default_theme: "dark",
        allow_theme_select: true,
        allow_direction_override: true,
      },
    });

    expect(policy).toMatchObject({
      allowedLocales: ["ar"],
      defaultLocale: "ar",
      allowLocaleSelect: false,
      allowedThemes: ["dark", "light"],
      defaultTheme: "dark",
      allowThemeSelect: true,
      allowDirectionOverride: true,
    });
  });

  test("constrains persisted preferences to policy", () => {
    const policy = normalizeMobileDisplayPolicy({
      display: {
        allowed_locales: ["en"],
        default_locale: "en",
        allowed_themes: ["system", "dark"],
        default_theme: "system",
      },
    });

    expect(resolveEffectiveLocale({ storedValue: "ar", policy })).toBe("en");
    expect(resolveEffectiveTheme({ storedValue: "light", policy })).toBe("system");
  });

  test("uses locale direction unless policy explicitly permits an override", () => {
    const lockedPolicy = normalizeMobileDisplayPolicy({ display: { allow_direction_override: false } });
    const openPolicy = normalizeMobileDisplayPolicy({ display: { allow_direction_override: true } });

    expect(resolveEffectiveDirection({ storedValue: "ltr", locale: "ar", policy: lockedPolicy })).toBe("rtl");
    expect(resolveEffectiveDirection({ storedValue: "ltr", locale: "ar", policy: openPolicy })).toBe("ltr");
  });

  test("disables user selectors when the row disables display preferences", () => {
    const policy = normalizeMobileDisplayPolicy({
      display: {
        enabled: false,
        allow_locale_select: true,
        allow_theme_select: true,
        allow_direction_override: true,
      },
    });

    expect(policy.allowLocaleSelect).toBe(false);
    expect(policy.allowThemeSelect).toBe(false);
    expect(policy.allowDirectionOverride).toBe(false);
  });

  test.each([
    [" EN ", "en"], [" AR ", "ar"], ["\tAr\n", "ar"],
  ])("normalizes locale case and whitespace: %s", (value, expected) => {
    expect(resolveLocaleMode(value)).toBe(expected);
    const policy = normalizeMobileDisplayPolicy({});
    expect(resolveEffectiveLocale({ storedValue: value, policy })).toBe(expected);
  });

  test.each([undefined, null, 42, {}, ["ar"], "", "fr"])("uses the policy default for invalid locale %p", (value) => {
    expect(resolveLocaleMode(value)).toBe("en");
    const policy = normalizeMobileDisplayPolicy({
      display: { allowed_locales: ["en", "ar"], default_locale: "ar" },
    });
    expect(resolveEffectiveLocale({ storedValue: value, policy })).toBe("ar");
  });

  test("keeps Arabic-only and disabled selectors authoritative", () => {
    for (const display of [
      { allowed_locales: ["ar"], default_locale: "ar" },
      { default_locale: "ar", allow_locale_select: false },
      { default_locale: "ar", enabled: false },
    ]) {
      const policy = normalizeMobileDisplayPolicy({ display });
      const locale = resolveEffectiveLocale({ storedValue: "en", policy });
      expect(locale).toBe("ar");
      expect(resolveEffectiveDirection({ storedValue: "ltr", locale, policy })).toBe("rtl");
    }
  });
});
