// Text direction for a locale against the configured RTL list (getUiDefaults().rtlLocales).
export function resolveLocaleDir(locale: string, rtlLocales: readonly string[] = []): "rtl" | "ltr" {
  const localeKey = locale.toLowerCase().split("-")[0] ?? locale.toLowerCase();
  return rtlLocales.includes(localeKey) ? "rtl" : "ltr";
}
