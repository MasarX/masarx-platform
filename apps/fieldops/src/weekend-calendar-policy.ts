// Resolve weekend calendars from weekend_calendar_policy.
//
// Contract: the resolver `public.resolve_weekend_calendar_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     weekend_days: [5, 6],
//     calendar_overrides: {
//       SA: [5, 6], AE: [6, 0], KW: [5, 6], BH: [5, 6], QA: [5, 6],
//       OM: [5, 6], JO: [5, 6], EG: [5, 6], US: [6, 0], GB: [6, 0]
//     }
//   }
//
// This module:
//  1. Defines the typed shape (WeekendCalendarPolicyValue).
//  2. Normalizes the JSONB into a strict-typed object (defensive parse).
//  3. Exposes `getWeekendDays(policy, country)` — returns the weekend day
//     index array for a given ISO 3166-1 alpha-2 country code, falling
//     back to `policy.weekend_days` when no override exists.
//  4. Exposes `isWeekend(policy, date, country)` — convenience predicate
//     used by shift planner / scheduling surfaces.
//  5. Ships a STATIC fallback that mirrors the global default seed exactly.
//
//
// Day index convention is JS-native: 0=Sunday..6=Saturday (matches
// Date.getDay() and Intl.DateTimeFormat weekday output).
//
// Backward compat: STATIC_WEEKEND_CALENDAR MUST stay in sync with the
// migration global default seed in
// supabase/migrations/202604241940_weekend_calendar_policy_v1.sql. The pgTAP
// test 0zd_weekend_calendar_policy.sql asserts the seed values. The Jest test
// tests/unit/weekend-calendar-policy.test.ts asserts the constants match the
// migration shape exactly.

export type WeekendCalendarPolicyValue = {
  version: number;
  weekend_days: number[];
  calendar_overrides: Record<string, number[]>;
};

// Mirror of the migration seed (see supabase/migrations/202604241940_weekend_calendar_policy_v1.sql).
// Day indices are JS-native: 0=Sunday..6=Saturday.
export const STATIC_WEEKEND_CALENDAR: WeekendCalendarPolicyValue = {
  version: 1,
  weekend_days: [5, 6],
  calendar_overrides: {
    SA: [5, 6],
    AE: [6, 0],
    KW: [5, 6],
    BH: [5, 6],
    QA: [5, 6],
    OM: [5, 6],
    JO: [5, 6],
    EG: [5, 6],
    US: [6, 0],
    GB: [6, 0],
  },
};

// Sanitize an array of day indices: only accepts integers 0..6, drops
// duplicates, preserves first-occurrence order. Returns null when the input
// is not an array OR contains zero valid entries.
function sanitizeDayArray(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const entry of raw) {
    if (typeof entry !== "number") continue;
    if (!Number.isInteger(entry)) continue;
    if (entry < 0 || entry > 6) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.length === 0 ? null : out;
}

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// WeekendCalendarPolicyValue. Defensive: invalid days dropped, invalid
// override entries dropped, falls back to STATIC seed for missing/malformed
// top-level fields so a bad row in production cannot crash shift planner.
export function normalizeWeekendCalendarPolicy(
  raw: unknown,
): WeekendCalendarPolicyValue {
  if (!raw || typeof raw !== "object") {
    return {
      version: STATIC_WEEKEND_CALENDAR.version,
      weekend_days: [...STATIC_WEEKEND_CALENDAR.weekend_days],
      calendar_overrides: deepCloneOverrides(STATIC_WEEKEND_CALENDAR.calendar_overrides),
    };
  }
  const obj = raw as Record<string, unknown>;

  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw) ? versionRaw : 1;

  const weekendDaysClean = sanitizeDayArray(obj.weekend_days);
  const weekend_days = weekendDaysClean ?? [...STATIC_WEEKEND_CALENDAR.weekend_days];

  const overridesRaw = obj.calendar_overrides;
  const calendar_overrides: Record<string, number[]> = {};
  if (overridesRaw && typeof overridesRaw === "object" && !Array.isArray(overridesRaw)) {
    for (const [country, days] of Object.entries(overridesRaw as Record<string, unknown>)) {
      const trimmed = country.trim().toUpperCase();
      if (!trimmed) continue;
      const cleanDays = sanitizeDayArray(days);
      if (cleanDays === null) continue;
      calendar_overrides[trimmed] = cleanDays;
    }
  }

  return {
    version,
    weekend_days,
    calendar_overrides,
  };
}

function deepCloneOverrides(
  src: Record<string, number[]>,
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = [...v];
  }
  return out;
}

// Return the weekend day indices for a given ISO 3166-1 alpha-2 country
// code. Country code is normalized to upper-case + trimmed before lookup.
// Falls back to `policy.weekend_days` when no override exists for the
// requested country (or when the country argument is empty/non-string).
export function getWeekendDays(
  policy: WeekendCalendarPolicyValue,
  country: string,
): number[] {
  const normalized = typeof country === "string" ? country.trim().toUpperCase() : "";
  if (normalized) {
    const override = policy.calendar_overrides[normalized];
    if (Array.isArray(override) && override.length > 0) {
      return [...override];
    }
  }
  return [...policy.weekend_days];
}

// Convenience predicate: is the supplied date a weekend day in the given
// country's calendar? Uses Date.getDay() (0=Sunday..6=Saturday).
export function isWeekend(
  policy: WeekendCalendarPolicyValue,
  date: Date,
  country: string,
): boolean {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return false;
  }
  const days = getWeekendDays(policy, country);
  return days.includes(date.getDay());
}
