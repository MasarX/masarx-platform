export type MobileThemeMode = "system" | "light" | "dark";
export type MobileLocaleMode = "en" | "ar";
export type MobileDirectionMode = "ltr" | "rtl";

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
