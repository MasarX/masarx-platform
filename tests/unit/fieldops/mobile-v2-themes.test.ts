import {
  MOBILE_V2_DEFAULT_THEME,
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SHADOWS,
  MOBILE_V2_SPACING,
  MOBILE_V2_THEMES,
  MOBILE_V2_THEME_KEYS,
  MOBILE_V2_TYPE_LETTER_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  getMobileV2Theme,
  isValidColorLiteral,
  resolveMobileV2ThemeKey,
} from "../../../apps/fieldops/src/mobile-v2-themes";

describe("mobile-v2 themes — token contract", () => {
  test("exposes exactly three theme keys (light, dark, hivis)", () => {
    expect(MOBILE_V2_THEME_KEYS).toEqual(["light", "dark", "hivis"]);
    expect(Object.keys(MOBILE_V2_THEMES).sort()).toEqual(["dark", "hivis", "light"]);
  });

  test("default theme is hivis (matches design harness default)", () => {
    expect(MOBILE_V2_DEFAULT_THEME).toBe("hivis");
  });

  test("every theme exposes the full token surface from the design source", () => {
    const requiredKeys = [
      "name",
      "bg",
      "surface",
      "surfaceAlt",
      "border",
      "borderStrong",
      "ink",
      "inkSoft",
      "muted",
      "mutedSoft",
      "accent",
      "accentSoft",
      "accentInk",
      "success",
      "successSoft",
      "warning",
      "warningSoft",
      "danger",
      "dangerSoft",
      "info",
      "infoSoft",
      "mapBg",
      "mapRoute",
      "chrome",
      "onChrome",
    ];
    for (const themeKey of MOBILE_V2_THEME_KEYS) {
      const theme = MOBILE_V2_THEMES[themeKey];
      for (const key of requiredKeys) {
        expect(theme).toHaveProperty(key);
        const value = theme[key as keyof typeof theme];
        expect(typeof value).toBe("string");
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  test("every color literal is a valid hex or rgba expression", () => {
    const colorKeys = [
      "bg",
      "surface",
      "surfaceAlt",
      "border",
      "borderStrong",
      "ink",
      "inkSoft",
      "muted",
      "mutedSoft",
      "accent",
      "accentSoft",
      "accentInk",
      "success",
      "successSoft",
      "warning",
      "warningSoft",
      "danger",
      "dangerSoft",
      "info",
      "infoSoft",
      "mapBg",
      "mapRoute",
      "chrome",
      "onChrome",
    ] as const;
    for (const themeKey of MOBILE_V2_THEME_KEYS) {
      const theme = MOBILE_V2_THEMES[themeKey];
      for (const colorKey of colorKeys) {
        expect(isValidColorLiteral(theme[colorKey])).toBe(true);
      }
    }
  });

  test("hivis theme reflects high-contrast accent (yellow on black)", () => {
    const hivis = MOBILE_V2_THEMES.hivis;
    expect(hivis.bg).toBe("#000000");
    expect(hivis.ink).toBe("#FFFFFF");
    expect(hivis.accent).toBe("#F5D90A");
  });

  test("light theme uses purple accent (matches design source)", () => {
    expect(MOBILE_V2_THEMES.light.accent).toBe("#6D28D9");
  });

  test("dark theme uses softer purple accent (#A78BFA)", () => {
    expect(MOBILE_V2_THEMES.dark.accent).toBe("#A78BFA");
  });

  test("getMobileV2Theme returns the same reference each call (frozen)", () => {
    const a = getMobileV2Theme("hivis");
    const b = getMobileV2Theme("hivis");
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe("mobile-v2 themes — typography & geometry", () => {
  test("font families fall back to system safely", () => {
    expect(MOBILE_V2_FONT_SANS).toContain("Geist");
    expect(MOBILE_V2_FONT_SANS).toContain("System");
    expect(MOBILE_V2_FONT_MONO).toContain("Geist Mono");
    expect(MOBILE_V2_FONT_MONO).toContain("Menlo");
  });

  test("type scale exposes the design source sizes", () => {
    expect(MOBILE_V2_TYPE_SIZES.appBarTitle).toBe(17);
    expect(MOBILE_V2_TYPE_SIZES.metricValue).toBe(22);
    expect(MOBILE_V2_TYPE_SIZES.sectionHead).toBe(10);
    expect(MOBILE_V2_TYPE_SIZES.body).toBe(13);
  });

  test("type weights are RN-string compatible", () => {
    expect(MOBILE_V2_TYPE_WEIGHTS.regular).toBe("400");
    expect(MOBILE_V2_TYPE_WEIGHTS.semibold).toBe("600");
    expect(MOBILE_V2_TYPE_WEIGHTS.bold).toBe("700");
  });

  test("letter-spacing values match design source (px)", () => {
    expect(MOBILE_V2_TYPE_LETTER_SPACING.appBarTitle).toBe(-0.2);
    expect(MOBILE_V2_TYPE_LETTER_SPACING.metricValue).toBe(-0.5);
    expect(MOBILE_V2_TYPE_LETTER_SPACING.sectionHead).toBe(0.8);
  });

  test("spacing scale is monotonic and non-negative", () => {
    const ordered = [
      MOBILE_V2_SPACING.px,
      MOBILE_V2_SPACING.xs,
      MOBILE_V2_SPACING.sm,
      MOBILE_V2_SPACING.md,
      MOBILE_V2_SPACING.lg,
      MOBILE_V2_SPACING.xl,
      MOBILE_V2_SPACING["2xl"],
      MOBILE_V2_SPACING["3xl"],
      MOBILE_V2_SPACING["4xl"],
      MOBILE_V2_SPACING["5xl"],
      MOBILE_V2_SPACING["6xl"],
      MOBILE_V2_SPACING["7xl"],
    ];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]).toBeGreaterThanOrEqual(ordered[i - 1] ?? 0);
      expect(ordered[i]).toBeGreaterThanOrEqual(0);
    }
  });

  test("radii match design source", () => {
    expect(MOBILE_V2_RADII.button).toBe(12);
    expect(MOBILE_V2_RADII.card).toBe(14);
    expect(MOBILE_V2_RADII.sheetTop).toBe(22);
    expect(MOBILE_V2_RADII.chip).toBe(999);
    expect(MOBILE_V2_RADII.phoneFrame).toBe(28);
  });

  test("shadow recipes are RN-shape compliant", () => {
    for (const recipe of Object.values(MOBILE_V2_SHADOWS)) {
      expect(typeof recipe.shadowColor).toBe("string");
      expect(typeof recipe.shadowOpacity).toBe("number");
      expect(recipe.shadowOpacity).toBeGreaterThanOrEqual(0);
      expect(recipe.shadowOpacity).toBeLessThanOrEqual(1);
      expect(typeof recipe.shadowRadius).toBe("number");
      expect(typeof recipe.shadowOffset.width).toBe("number");
      expect(typeof recipe.shadowOffset.height).toBe("number");
      expect(typeof recipe.elevation).toBe("number");
      expect(recipe.elevation).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("mobile-v2 themes — resolver helpers", () => {
  test("resolveMobileV2ThemeKey accepts the three known keys", () => {
    expect(resolveMobileV2ThemeKey("light")).toBe("light");
    expect(resolveMobileV2ThemeKey("dark")).toBe("dark");
    expect(resolveMobileV2ThemeKey("hivis")).toBe("hivis");
  });

  test("resolveMobileV2ThemeKey is case-insensitive and trims whitespace", () => {
    expect(resolveMobileV2ThemeKey("  HIVIS  ")).toBe("hivis");
    expect(resolveMobileV2ThemeKey("Light")).toBe("light");
  });

  test("resolveMobileV2ThemeKey falls back on unknown / non-string input", () => {
    expect(resolveMobileV2ThemeKey("midnight")).toBe(MOBILE_V2_DEFAULT_THEME);
    expect(resolveMobileV2ThemeKey(undefined)).toBe(MOBILE_V2_DEFAULT_THEME);
    expect(resolveMobileV2ThemeKey(null)).toBe(MOBILE_V2_DEFAULT_THEME);
    expect(resolveMobileV2ThemeKey(42)).toBe(MOBILE_V2_DEFAULT_THEME);
    expect(resolveMobileV2ThemeKey({ theme: "dark" })).toBe(MOBILE_V2_DEFAULT_THEME);
  });

  test("isValidColorLiteral catches malformed strings", () => {
    expect(isValidColorLiteral("#FFFFFF")).toBe(true);
    expect(isValidColorLiteral("#fff")).toBe(true);
    expect(isValidColorLiteral("#FFFFFF80")).toBe(true);
    expect(isValidColorLiteral("rgba(0,0,0,0.5)")).toBe(true);
    expect(isValidColorLiteral("rgb(0, 0, 0)")).toBe(true);
    expect(isValidColorLiteral("white")).toBe(false);
    expect(isValidColorLiteral("#GGGGGG")).toBe(false);
    expect(isValidColorLiteral("")).toBe(false);
  });
});
