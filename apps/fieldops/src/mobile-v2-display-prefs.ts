// Mobile V2 display preferences — user-controlled (theme, locale, direction,
// density) persisted in canonical KV. Per AGENTS.md Mobile Field Ops Policy
// Contract these are user preferences, NOT policy-governed; ux_safety_policy
// governs accessibility floors only (motion-reduce, contrast minimum, etc).
//
// Coexists with mobile-shell-display.ts which serves V1 screens (light/dark
// only). V2 introduces a third "hivis" theme and the design's locale catalog
// (en-SA / ar-SA / ur-PK) plus an explicit density axis (comfy/compact).
//
// All loaders fail-safe: corrupt or missing KV values resolve to design
// defaults so a stale device never shows a broken shell.

import type { MobileStorageAdapter } from "@masarx/auth/mobile";

import {
  MOBILE_V2_DEFAULT_THEME,
  resolveMobileV2ThemeKey,
  type MobileV2ThemeKey,
} from "./mobile-v2-themes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MobileV2LocaleCode = "en-SA" | "ar-SA" | "ur-PK";
export type MobileV2DirectionMode = "ltr" | "rtl";
export type MobileV2DensityMode = "comfy" | "compact";

export interface MobileV2DisplayPrefs {
  readonly theme: MobileV2ThemeKey;
  readonly locale: MobileV2LocaleCode;
  readonly direction: MobileV2DirectionMode;
  readonly density: MobileV2DensityMode;
}

export const MOBILE_V2_LOCALE_CODES: ReadonlyArray<MobileV2LocaleCode> = Object.freeze([
  "en-SA",
  "ar-SA",
  "ur-PK",
]);

export const MOBILE_V2_DEFAULT_LOCALE: MobileV2LocaleCode = "en-SA";
export const MOBILE_V2_DEFAULT_DENSITY: MobileV2DensityMode = "comfy";

export const MOBILE_V2_DEFAULT_DISPLAY_PREFS: MobileV2DisplayPrefs = Object.freeze({
  theme: MOBILE_V2_DEFAULT_THEME,
  locale: MOBILE_V2_DEFAULT_LOCALE,
  direction: "ltr",
  density: MOBILE_V2_DEFAULT_DENSITY,
});

// ---------------------------------------------------------------------------
// KV keys (canonical; namespaced under mobile.v2.* to avoid V1 collision)
// ---------------------------------------------------------------------------

export const MOBILE_V2_KV_KEYS = Object.freeze({
  theme: "mobile.v2.theme",
  locale: "mobile.v2.locale",
  density: "mobile.v2.density",
} as const);

// ---------------------------------------------------------------------------
// Normalizers (pure, fail-safe)
// ---------------------------------------------------------------------------

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Return canonical locale code from a candidate (case-insensitive). */
export function resolveMobileV2LocaleCode(candidate: unknown): MobileV2LocaleCode {
  const trimmed = normalizeString(candidate);
  if (trimmed !== null) {
    const lowered = trimmed.toLowerCase();
    for (const code of MOBILE_V2_LOCALE_CODES) {
      if (code.toLowerCase() === lowered) {
        return code;
      }
    }
  }
  return MOBILE_V2_DEFAULT_LOCALE;
}

/**
 * Resolve direction from a candidate, falling back to the locale's natural
 * direction. RTL locales: ar-SA, ur-PK. LTR locales: en-SA.
 */
export function resolveMobileV2Direction(input: {
  readonly value: unknown;
  readonly locale: MobileV2LocaleCode;
}): MobileV2DirectionMode {
  const trimmed = normalizeString(input.value);
  if (trimmed !== null) {
    const lowered = trimmed.toLowerCase();
    if (lowered === "ltr" || lowered === "rtl") return lowered;
  }
  return localeDirectionDefault(input.locale);
}

/** Direction implied by a locale (Arabic + Urdu are RTL; English-SA is LTR). */
export function localeDirectionDefault(locale: MobileV2LocaleCode): MobileV2DirectionMode {
  if (locale === "ar-SA" || locale === "ur-PK") return "rtl";
  return "ltr";
}

export function resolveMobileV2Density(candidate: unknown): MobileV2DensityMode {
  const trimmed = normalizeString(candidate);
  if (trimmed !== null) {
    const lowered = trimmed.toLowerCase();
    if (lowered === "comfy" || lowered === "compact") return lowered;
  }
  return MOBILE_V2_DEFAULT_DENSITY;
}

// ---------------------------------------------------------------------------
// KV load / save (uses MobileStorageAdapter from @masarx/auth/mobile)
// ---------------------------------------------------------------------------

/**
 * Load all display preferences from KV. Any unset / corrupt value resolves
 * to its design default. Always returns a frozen prefs object; never throws.
 */
export async function loadMobileV2DisplayPrefs(
  storage: MobileStorageAdapter,
): Promise<MobileV2DisplayPrefs> {
  const [themeRaw, localeRaw, densityRaw] = await Promise.all([
    safeGet(storage, MOBILE_V2_KV_KEYS.theme),
    safeGet(storage, MOBILE_V2_KV_KEYS.locale),
    safeGet(storage, MOBILE_V2_KV_KEYS.density),
  ]);
  const theme = resolveMobileV2ThemeKey(themeRaw);
  const locale = resolveMobileV2LocaleCode(localeRaw);
  const direction = localeDirectionDefault(locale);
  const density = resolveMobileV2Density(densityRaw);
  return Object.freeze({ theme, locale, direction, density });
}

/**
 * Persist a single preference. Returns void; KV failures are swallowed (the
 * caller already reflects the change in memory and the next load just falls
 * back to the design default if persistence failed).
 */
export async function saveMobileV2Theme(
  storage: MobileStorageAdapter,
  theme: MobileV2ThemeKey,
): Promise<void> {
  await safeSet(storage, MOBILE_V2_KV_KEYS.theme, theme);
}

export async function saveMobileV2Locale(
  storage: MobileStorageAdapter,
  locale: MobileV2LocaleCode,
): Promise<void> {
  await safeSet(storage, MOBILE_V2_KV_KEYS.locale, locale);
}

export async function saveMobileV2Density(
  storage: MobileStorageAdapter,
  density: MobileV2DensityMode,
): Promise<void> {
  await safeSet(storage, MOBILE_V2_KV_KEYS.density, density);
}

/** Convenience: persist all prefs in one call. */
export async function saveMobileV2DisplayPrefs(
  storage: MobileStorageAdapter,
  prefs: MobileV2DisplayPrefs,
): Promise<void> {
  await Promise.all([
    saveMobileV2Theme(storage, prefs.theme),
    saveMobileV2Locale(storage, prefs.locale),
    saveMobileV2Density(storage, prefs.density),
  ]);
}

/**
 * Apply a partial change to a current prefs object. Recomputes direction
 * from the (possibly new) locale unless the caller pinned it explicitly.
 */
export function reduceMobileV2DisplayPrefs(
  current: MobileV2DisplayPrefs,
  patch: Partial<MobileV2DisplayPrefs>,
): MobileV2DisplayPrefs {
  const nextTheme = patch.theme !== undefined ? resolveMobileV2ThemeKey(patch.theme) : current.theme;
  const nextLocale =
    patch.locale !== undefined ? resolveMobileV2LocaleCode(patch.locale) : current.locale;
  const nextDensity =
    patch.density !== undefined ? resolveMobileV2Density(patch.density) : current.density;
  const nextDirection =
    patch.direction !== undefined
      ? resolveMobileV2Direction({ value: patch.direction, locale: nextLocale })
      : patch.locale !== undefined && patch.direction === undefined
        ? localeDirectionDefault(nextLocale)
        : current.direction;
  return Object.freeze({
    theme: nextTheme,
    locale: nextLocale,
    direction: nextDirection,
    density: nextDensity,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function safeGet(storage: MobileStorageAdapter, key: string): Promise<string | null> {
  try {
    return await storage.getItem(key);
  } catch {
    return null;
  }
}

async function safeSet(storage: MobileStorageAdapter, key: string, value: string): Promise<void> {
  try {
    await storage.setItem(key, value);
  } catch {
    // Persistence is best-effort; an in-memory update has already happened.
  }
}
