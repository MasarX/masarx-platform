import type { MobileStorageAdapter } from "@masarx/auth/mobile";

import {
  MOBILE_V2_DEFAULT_DENSITY,
  MOBILE_V2_DEFAULT_DISPLAY_PREFS,
  MOBILE_V2_DEFAULT_LOCALE,
  MOBILE_V2_KV_KEYS,
  MOBILE_V2_LOCALE_CODES,
  loadMobileV2DisplayPrefs,
  localeDirectionDefault,
  reduceMobileV2DisplayPrefs,
  resolveMobileV2Density,
  resolveMobileV2Direction,
  resolveMobileV2LocaleCode,
  saveMobileV2DisplayPrefs,
  saveMobileV2Density,
  saveMobileV2Locale,
  saveMobileV2Theme,
} from "../../../apps/fieldops/src/mobile-v2-display-prefs";

function memoryStorage(initial: Record<string, string> = {}): MobileStorageAdapter & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => {
      store.set(key, value);
    },
    removeItem: async (key) => {
      store.delete(key);
    },
  };
}

function failingStorage(): MobileStorageAdapter {
  return {
    getItem: async () => {
      throw new Error("kv unavailable");
    },
    setItem: async () => {
      throw new Error("kv unavailable");
    },
    removeItem: async () => {
      throw new Error("kv unavailable");
    },
  };
}

describe("mobile-v2 display prefs — locale resolver", () => {
  test("returns canonical code for known locales (case-insensitive)", () => {
    expect(resolveMobileV2LocaleCode("en-SA")).toBe("en-SA");
    expect(resolveMobileV2LocaleCode("ar-SA")).toBe("ar-SA");
    expect(resolveMobileV2LocaleCode("ur-PK")).toBe("ur-PK");
    expect(resolveMobileV2LocaleCode("AR-sa")).toBe("ar-SA");
    expect(resolveMobileV2LocaleCode("EN-sa")).toBe("en-SA");
  });

  test("falls back to en-SA for unknown / non-string", () => {
    expect(resolveMobileV2LocaleCode("fr-FR")).toBe("en-SA");
    expect(resolveMobileV2LocaleCode("")).toBe("en-SA");
    expect(resolveMobileV2LocaleCode(undefined)).toBe("en-SA");
    expect(resolveMobileV2LocaleCode(null)).toBe("en-SA");
    expect(resolveMobileV2LocaleCode(42)).toBe("en-SA");
  });

  test("locale catalog matches design source (en-SA, ar-SA, ur-PK)", () => {
    expect(MOBILE_V2_LOCALE_CODES).toEqual(["en-SA", "ar-SA", "ur-PK"]);
  });
});

describe("mobile-v2 display prefs — direction resolver", () => {
  test("explicit ltr/rtl wins over locale fallback", () => {
    expect(resolveMobileV2Direction({ value: "ltr", locale: "ar-SA" })).toBe("ltr");
    expect(resolveMobileV2Direction({ value: "rtl", locale: "en-SA" })).toBe("rtl");
  });

  test("falls back to locale's natural direction when value is missing", () => {
    expect(resolveMobileV2Direction({ value: null, locale: "en-SA" })).toBe("ltr");
    expect(resolveMobileV2Direction({ value: null, locale: "ar-SA" })).toBe("rtl");
    expect(resolveMobileV2Direction({ value: null, locale: "ur-PK" })).toBe("rtl");
    expect(resolveMobileV2Direction({ value: undefined, locale: "ar-SA" })).toBe("rtl");
  });

  test("localeDirectionDefault matches RTL languages", () => {
    expect(localeDirectionDefault("en-SA")).toBe("ltr");
    expect(localeDirectionDefault("ar-SA")).toBe("rtl");
    expect(localeDirectionDefault("ur-PK")).toBe("rtl");
  });
});

describe("mobile-v2 display prefs — density resolver", () => {
  test("accepts comfy and compact (case-insensitive)", () => {
    expect(resolveMobileV2Density("comfy")).toBe("comfy");
    expect(resolveMobileV2Density("compact")).toBe("compact");
    expect(resolveMobileV2Density("COMPACT")).toBe("compact");
  });

  test("falls back to default density on unknown / non-string", () => {
    expect(resolveMobileV2Density("dense")).toBe(MOBILE_V2_DEFAULT_DENSITY);
    expect(resolveMobileV2Density(undefined)).toBe(MOBILE_V2_DEFAULT_DENSITY);
    expect(resolveMobileV2Density(null)).toBe(MOBILE_V2_DEFAULT_DENSITY);
    expect(resolveMobileV2Density({})).toBe(MOBILE_V2_DEFAULT_DENSITY);
  });
});

describe("mobile-v2 display prefs — defaults", () => {
  test("default prefs match the design harness (hivis, en-SA, ltr, comfy)", () => {
    expect(MOBILE_V2_DEFAULT_DISPLAY_PREFS.theme).toBe("hivis");
    expect(MOBILE_V2_DEFAULT_DISPLAY_PREFS.locale).toBe(MOBILE_V2_DEFAULT_LOCALE);
    expect(MOBILE_V2_DEFAULT_DISPLAY_PREFS.direction).toBe("ltr");
    expect(MOBILE_V2_DEFAULT_DISPLAY_PREFS.density).toBe(MOBILE_V2_DEFAULT_DENSITY);
    expect(Object.isFrozen(MOBILE_V2_DEFAULT_DISPLAY_PREFS)).toBe(true);
  });
});

describe("mobile-v2 display prefs — KV load", () => {
  test("returns design defaults when KV is empty", async () => {
    const storage = memoryStorage();
    const prefs = await loadMobileV2DisplayPrefs(storage);
    expect(prefs).toEqual(MOBILE_V2_DEFAULT_DISPLAY_PREFS);
  });

  test("respects persisted values for theme + locale + density (and recomputes direction)", async () => {
    const storage = memoryStorage({
      [MOBILE_V2_KV_KEYS.theme]: "light",
      [MOBILE_V2_KV_KEYS.locale]: "ar-SA",
      [MOBILE_V2_KV_KEYS.density]: "compact",
    });
    const prefs = await loadMobileV2DisplayPrefs(storage);
    expect(prefs.theme).toBe("light");
    expect(prefs.locale).toBe("ar-SA");
    expect(prefs.direction).toBe("rtl");
    expect(prefs.density).toBe("compact");
  });

  test("ignores corrupt values and falls back to defaults", async () => {
    const storage = memoryStorage({
      [MOBILE_V2_KV_KEYS.theme]: "midnight-blue",
      [MOBILE_V2_KV_KEYS.locale]: "fr-FR",
      [MOBILE_V2_KV_KEYS.density]: "ultra-dense",
    });
    const prefs = await loadMobileV2DisplayPrefs(storage);
    expect(prefs.theme).toBe("hivis");
    expect(prefs.locale).toBe("en-SA");
    expect(prefs.density).toBe("comfy");
  });

  test("survives a KV that throws on every read", async () => {
    const prefs = await loadMobileV2DisplayPrefs(failingStorage());
    expect(prefs).toEqual(MOBILE_V2_DEFAULT_DISPLAY_PREFS);
  });
});

describe("mobile-v2 display prefs — KV save", () => {
  test("saveMobileV2Theme persists to the canonical key", async () => {
    const storage = memoryStorage();
    await saveMobileV2Theme(storage, "dark");
    expect(storage.store.get(MOBILE_V2_KV_KEYS.theme)).toBe("dark");
  });

  test("saveMobileV2Locale + saveMobileV2Density persist to canonical keys", async () => {
    const storage = memoryStorage();
    await saveMobileV2Locale(storage, "ar-SA");
    await saveMobileV2Density(storage, "compact");
    expect(storage.store.get(MOBILE_V2_KV_KEYS.locale)).toBe("ar-SA");
    expect(storage.store.get(MOBILE_V2_KV_KEYS.density)).toBe("compact");
  });

  test("saveMobileV2DisplayPrefs persists every key in one call", async () => {
    const storage = memoryStorage();
    await saveMobileV2DisplayPrefs(storage, {
      theme: "light",
      locale: "ur-PK",
      direction: "rtl",
      density: "compact",
    });
    expect(storage.store.get(MOBILE_V2_KV_KEYS.theme)).toBe("light");
    expect(storage.store.get(MOBILE_V2_KV_KEYS.locale)).toBe("ur-PK");
    expect(storage.store.get(MOBILE_V2_KV_KEYS.density)).toBe("compact");
  });

  test("save is best-effort: storage that throws does not propagate", async () => {
    await expect(saveMobileV2Theme(failingStorage(), "dark")).resolves.toBeUndefined();
    await expect(saveMobileV2Locale(failingStorage(), "ar-SA")).resolves.toBeUndefined();
    await expect(saveMobileV2Density(failingStorage(), "compact")).resolves.toBeUndefined();
  });
});

describe("mobile-v2 display prefs — reducer", () => {
  test("apply theme change without touching other fields", () => {
    const next = reduceMobileV2DisplayPrefs(MOBILE_V2_DEFAULT_DISPLAY_PREFS, { theme: "light" });
    expect(next.theme).toBe("light");
    expect(next.locale).toBe(MOBILE_V2_DEFAULT_DISPLAY_PREFS.locale);
    expect(next.density).toBe(MOBILE_V2_DEFAULT_DISPLAY_PREFS.density);
    expect(next.direction).toBe(MOBILE_V2_DEFAULT_DISPLAY_PREFS.direction);
  });

  test("changing locale recomputes direction by default", () => {
    const next = reduceMobileV2DisplayPrefs(MOBILE_V2_DEFAULT_DISPLAY_PREFS, { locale: "ar-SA" });
    expect(next.locale).toBe("ar-SA");
    expect(next.direction).toBe("rtl");
  });

  test("explicit direction wins over locale-derived direction in the patch", () => {
    const next = reduceMobileV2DisplayPrefs(MOBILE_V2_DEFAULT_DISPLAY_PREFS, {
      locale: "ar-SA",
      direction: "ltr",
    });
    expect(next.locale).toBe("ar-SA");
    expect(next.direction).toBe("ltr");
  });

  test("returns frozen object so accidental mutation is impossible", () => {
    const next = reduceMobileV2DisplayPrefs(MOBILE_V2_DEFAULT_DISPLAY_PREFS, { theme: "dark" });
    expect(Object.isFrozen(next)).toBe(true);
  });

  test("corrupt patch values are normalized through resolvers", () => {
    const next = reduceMobileV2DisplayPrefs(MOBILE_V2_DEFAULT_DISPLAY_PREFS, {
      // Cast to any-equivalent because the reducer is the boundary that
      // normalizes corrupted runtime input from KV / props.
      theme: "midnight" as unknown as never,
      locale: "fr-FR" as unknown as never,
      density: "ultra" as unknown as never,
    });
    expect(next.theme).toBe(MOBILE_V2_DEFAULT_DISPLAY_PREFS.theme);
    expect(next.locale).toBe(MOBILE_V2_DEFAULT_DISPLAY_PREFS.locale);
    expect(next.density).toBe(MOBILE_V2_DEFAULT_DISPLAY_PREFS.density);
  });
});
