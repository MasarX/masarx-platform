// Resolve the Hijri calendar display policy.
//
// Contract: the resolver `public.resolve_hijri_calendar_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     enabled: false,
//     display_mode: "dual" | "hijri_only" | "gregorian_only",
//     calendar_system: "umm_al_qura" | "islamic" | "islamic_civil" | "islamic_tbla",
//     show_in_route_headers: true,
//     show_in_settlement_dates: true
//   }
//
// This module:
//  1. Defines the typed shape (HijriCalendarPolicyValue + CalendarSystem).
//  2. Normalizes the JSONB into a strict-typed object (defensive parse).
//  3. Exposes `formatGregorianAndHijri(policy, date, locale)` — the
//     consumer-facing helper that route headers + settlement screens call.
//     Uses Intl.DateTimeFormat with the appropriate `calendar` option for
//     the selected Hijri system (no external library needed).
//  4. Ships a STATIC fallback that mirrors the global default seed exactly.
//
//
// behavior must read through resolver functions, not hardcoded code-side maps.
// The resolver controls dual-calendar date display and its locale-specific formatting.
// global default seed in
// supabase/migrations/202604241930_hijri_calendar_policy_v1.sql. The pgTAP
// test 0zd_hijri_calendar_policy.sql asserts the seed values. The Jest test
// tests/unit/hijri-calendar-policy.test.ts asserts that this static mirror
// matches the migration shape and exercises the formatter against multiple
// locales / dates.

// Supported Islamic calendar systems. Maps directly to the Intl.DateTimeFormat
// `calendar` option.
//   umm_al_qura  -> "islamic-umalqura" (Saudi Arabian Umm al-Qura — official KSA)
//   islamic      -> "islamic"          (default Islamic civil tabular)
//   islamic_civil-> "islamic-civil"    (alternative civil tabular)
//   islamic_tbla -> "islamic-tbla"     (astronomical / tabular)
export type CalendarSystem =
  | "umm_al_qura"
  | "islamic"
  | "islamic_civil"
  | "islamic_tbla";

export type HijriDisplayMode = "dual" | "hijri_only" | "gregorian_only";

export type HijriCalendarPolicyValue = {
  version: number;
  enabled: boolean;
  display_mode: HijriDisplayMode;
  calendar_system: CalendarSystem;
  show_in_route_headers: boolean;
  show_in_settlement_dates: boolean;
};

const VALID_DISPLAY_MODES: ReadonlySet<HijriDisplayMode> = new Set([
  "dual",
  "hijri_only",
  "gregorian_only",
]);

const VALID_CALENDAR_SYSTEMS: ReadonlySet<CalendarSystem> = new Set([
  "umm_al_qura",
  "islamic",
  "islamic_civil",
  "islamic_tbla",
]);

// Mirror of the migration seed (see supabase/migrations/202604241930_hijri_calendar_policy_v1.sql).
// Default `enabled: false` so behavior is preserved bit-for-bit for non-MENA
// tenants when the resolver returns the global default (or is offline).
export const STATIC_HIJRI_CALENDAR: HijriCalendarPolicyValue = {
  version: 1,
  enabled: false,
  display_mode: "dual",
  calendar_system: "umm_al_qura",
  show_in_route_headers: true,
  show_in_settlement_dates: true,
};

// Convert internal CalendarSystem token to the BCP-47 calendar identifier
// expected by Intl.DateTimeFormat.
function calendarSystemToIntlId(system: CalendarSystem): string {
  switch (system) {
    case "umm_al_qura":
      return "islamic-umalqura";
    case "islamic":
      return "islamic";
    case "islamic_civil":
      return "islamic-civil";
    case "islamic_tbla":
      return "islamic-tbla";
  }
}

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// HijriCalendarPolicyValue. Defensive: invalid enums fall back to the static
// seed values so a bad row in production cannot crash route headers.
export function normalizeHijriCalendarPolicy(
  raw: unknown,
): HijriCalendarPolicyValue {
  if (!raw || typeof raw !== "object") {
    return { ...STATIC_HIJRI_CALENDAR };
  }
  const obj = raw as Record<string, unknown>;

  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw) ? versionRaw : 1;

  const enabled = typeof obj.enabled === "boolean" ? obj.enabled : STATIC_HIJRI_CALENDAR.enabled;

  const displayModeRaw = typeof obj.display_mode === "string" ? obj.display_mode.trim() : "";
  const display_mode: HijriDisplayMode = VALID_DISPLAY_MODES.has(displayModeRaw as HijriDisplayMode)
    ? (displayModeRaw as HijriDisplayMode)
    : STATIC_HIJRI_CALENDAR.display_mode;

  const calendarSystemRaw = typeof obj.calendar_system === "string" ? obj.calendar_system.trim() : "";
  const calendar_system: CalendarSystem = VALID_CALENDAR_SYSTEMS.has(calendarSystemRaw as CalendarSystem)
    ? (calendarSystemRaw as CalendarSystem)
    : STATIC_HIJRI_CALENDAR.calendar_system;

  const show_in_route_headers =
    typeof obj.show_in_route_headers === "boolean"
      ? obj.show_in_route_headers
      : STATIC_HIJRI_CALENDAR.show_in_route_headers;

  const show_in_settlement_dates =
    typeof obj.show_in_settlement_dates === "boolean"
      ? obj.show_in_settlement_dates
      : STATIC_HIJRI_CALENDAR.show_in_settlement_dates;

  return {
    version,
    enabled,
    display_mode,
    calendar_system,
    show_in_route_headers,
    show_in_settlement_dates,
  };
}

// Result of formatGregorianAndHijri. `hijri` is null when:
//   - policy.enabled === false
//   - policy.display_mode === 'gregorian_only'
//   - the date is invalid
//   - the runtime Intl implementation does not support the requested calendar
// `gregorian` is null when policy.display_mode === 'hijri_only' (caller still
// gets the Hijri rendering); otherwise it is always populated.
export type FormattedDualDate = {
  gregorian: string | null;
  hijri: string | null;
};

// Format a Date in Gregorian and/or Hijri according to the policy.
// Locale must be "en" (English) or "ar" (Arabic). For "ar" we request
// `ar-SA` to bias the Hijri formatter toward Saudi-style numerals/labels;
// for "en" we use `en-u-ca-<system>`. The Gregorian half always uses the
// caller-supplied locale (en / ar) with the Gregorian calendar.
export function formatGregorianAndHijri(
  policy: HijriCalendarPolicyValue,
  date: Date,
  locale: "en" | "ar",
): FormattedDualDate {
  // Defensive: invalid Date → both null.
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return { gregorian: null, hijri: null };
  }

  // Master toggle: when disabled, we render only the Gregorian half so the
  // app can still display dates without invoking Hijri formatting.
  if (!policy.enabled) {
    const gregOnly = formatGregorian(date, locale);
    return { gregorian: gregOnly, hijri: null };
  }

  const wantsGregorian = policy.display_mode !== "hijri_only";
  const wantsHijri = policy.display_mode !== "gregorian_only";

  const gregorian = wantsGregorian ? formatGregorian(date, locale) : null;
  const hijri = wantsHijri ? formatHijri(date, locale, policy.calendar_system) : null;

  return { gregorian, hijri };
}

function formatGregorian(date: Date, locale: "en" | "ar"): string | null {
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      calendar: "gregory",
    }).format(date);
  } catch {
    // Older runtimes / unusual locales — fall back to ISO date string.
    return date.toISOString().slice(0, 10);
  }
}

function formatHijri(
  date: Date,
  locale: "en" | "ar",
  system: CalendarSystem,
): string | null {
  const calendarId = calendarSystemToIntlId(system);
  // Bias Arabic locale toward Saudi region for Umm al-Qura readability.
  const baseLocale = locale === "ar" ? "ar-SA" : "en";
  const localeWithCalendar = `${baseLocale}-u-ca-${calendarId}`;
  try {
    return new Intl.DateTimeFormat(localeWithCalendar, {
      year: "numeric",
      month: "long",
      day: "numeric",
      calendar: calendarId,
    }).format(date);
  } catch {
    // If the runtime does not support the requested Islamic calendar,
    // signal absence rather than falling back to Gregorian (which would
    // mislead the caller into thinking it has a Hijri rendering).
    return null;
  }
}
