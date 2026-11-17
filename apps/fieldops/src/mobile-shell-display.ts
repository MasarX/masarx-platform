export type MobileThemeMode = "system" | "light" | "dark";
export type MobileLocaleMode = "en" | "ar";
export type MobileDirectionMode = "ltr" | "rtl";

export type MobileDisplayPolicy = {
  enabled: boolean;
  allowedLocales: MobileLocaleMode[];
  defaultLocale: MobileLocaleMode;
  allowLocaleSelect: boolean;
  allowedThemes: MobileThemeMode[];
  defaultTheme: MobileThemeMode;
  allowThemeSelect: boolean;
  allowDirectionOverride: boolean;
};

const DEFAULT_DISPLAY_POLICY: MobileDisplayPolicy = {
  enabled: true,
  allowedLocales: ["en", "ar"],
  defaultLocale: "en",
  allowLocaleSelect: true,
  allowedThemes: ["system", "light", "dark"],
  defaultTheme: "system",
  allowThemeSelect: true,
  allowDirectionOverride: false,
};

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

export function resolveThemeMode(value: unknown): MobileThemeMode {
  const normalized = normalizeString(value);
  if (normalized === "light" || normalized === "dark" || normalized === "system") {
    return normalized;
  }
  return "system";
}

export function resolveLocaleMode(value: unknown): MobileLocaleMode {
  const normalized = normalizeString(value);
  if (normalized === "ar" || normalized === "en") return normalized;
  return "en";
}

export function resolveDirectionMode(input: {
  value: unknown;
  locale: MobileLocaleMode;
}): MobileDirectionMode {
  const normalized = normalizeString(input.value);
  if (normalized === "rtl" || normalized === "ltr") return normalized;
  return input.locale === "ar" ? "rtl" : "ltr";
}

export function toAppearanceColorScheme(mode: MobileThemeMode): "light" | "dark" | null {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeAllowedValues<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: readonly T[]
): T[] {
  if (!Array.isArray(value)) return [...fallback];
  const normalized = value
    .map(normalizeString)
    .filter((candidate): candidate is T => Boolean(candidate && allowed.includes(candidate as T)));
  return normalized.length ? Array.from(new Set(normalized)) : [...fallback];
}

export function normalizeMobileDisplayPolicy(value: unknown): MobileDisplayPolicy {
  const policy = asRecord(value);
  const display = asRecord(policy.display ?? value);
  const allowedLocales = normalizeAllowedValues(
    display.allowed_locales,
    ["en", "ar"] as const,
    DEFAULT_DISPLAY_POLICY.allowedLocales
  );
  const allowedThemes = normalizeAllowedValues(
    display.allowed_themes,
    ["system", "light", "dark"] as const,
    DEFAULT_DISPLAY_POLICY.allowedThemes
  );
  const requestedDefaultLocale = resolveLocaleMode(display.default_locale);
  const requestedDefaultTheme = resolveThemeMode(display.default_theme);
  const enabled = normalizeBoolean(display.enabled, DEFAULT_DISPLAY_POLICY.enabled);

  return {
    enabled,
    allowedLocales,
    defaultLocale: allowedLocales.includes(requestedDefaultLocale)
      ? requestedDefaultLocale
      : allowedLocales[0],
    allowLocaleSelect: enabled && normalizeBoolean(
      display.allow_locale_select,
      DEFAULT_DISPLAY_POLICY.allowLocaleSelect
    ),
    allowedThemes,
    defaultTheme: allowedThemes.includes(requestedDefaultTheme)
      ? requestedDefaultTheme
      : allowedThemes[0],
    allowThemeSelect: enabled && normalizeBoolean(
      display.allow_theme_select,
      DEFAULT_DISPLAY_POLICY.allowThemeSelect
    ),
    allowDirectionOverride: enabled && normalizeBoolean(
      display.allow_direction_override,
      DEFAULT_DISPLAY_POLICY.allowDirectionOverride
    ),
  };
}

export function resolveEffectiveLocale(input: {
  storedValue: unknown;
  policy: MobileDisplayPolicy;
}): MobileLocaleMode {
  if (!input.policy.enabled || !input.policy.allowLocaleSelect) return input.policy.defaultLocale;
  const candidate = normalizeString(input.storedValue) as MobileLocaleMode | null;
  return candidate && input.policy.allowedLocales.includes(candidate)
    ? candidate
    : input.policy.defaultLocale;
}

export function resolveEffectiveTheme(input: {
  storedValue: unknown;
  policy: MobileDisplayPolicy;
}): MobileThemeMode {
  if (!input.policy.enabled || !input.policy.allowThemeSelect) return input.policy.defaultTheme;
  const candidate = normalizeString(input.storedValue) as MobileThemeMode | null;
  return candidate && input.policy.allowedThemes.includes(candidate)
    ? candidate
    : input.policy.defaultTheme;
}

export function resolveEffectiveDirection(input: {
  storedValue: unknown;
  locale: MobileLocaleMode;
  policy: MobileDisplayPolicy;
}): MobileDirectionMode {
  if (!input.policy.enabled || !input.policy.allowDirectionOverride) {
    return input.locale === "ar" ? "rtl" : "ltr";
  }
  return resolveDirectionMode({ value: input.storedValue, locale: input.locale });
}
