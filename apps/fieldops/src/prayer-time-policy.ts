// Resolve prayer windows, dispatch suppression and advance warnings from prayer_time_policy.
//
// Contract: the resolver `public.resolve_prayer_time_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     enabled: false,
//     windows: [
//       { key: "fajr",    label_en: "Fajr",    label_ar: "الفجر",   suppress_dispatch: true,  suppression_minutes: 30 },
//       { key: "dhuhr",   label_en: "Dhuhr",   label_ar: "الظهر",   suppress_dispatch: true,  suppression_minutes: 30 },
//       { key: "asr",     label_en: "Asr",     label_ar: "العصر",   suppress_dispatch: true,  suppression_minutes: 20 },
//       { key: "maghrib", label_en: "Maghrib", label_ar: "المغرب",  suppress_dispatch: true,  suppression_minutes: 20 },
//       { key: "isha",    label_en: "Isha",    label_ar: "العشاء",  suppress_dispatch: true,  suppression_minutes: 30 },
//       { key: "jumuah",  label_en: "Jumu'ah", label_ar: "الجمعة",  suppress_dispatch: true,  suppression_minutes: 90, weekday_only: 5 }
//     ],
//     pre_window_warning_minutes: 5,
//     respect_critical_only: true
//   }
//
// This module:
//  1. Defines the typed shape (PrayerTimePolicyValue / PrayerWindow / PrayerWindowKey).
//  2. Normalizes the JSONB into a strict-typed object (defensive parse).
//  3. Exposes pure helpers:
//      - resolveActivePrayerWindow(policy, nowUtc, prayerTimes)
//      - shouldSuppressDispatch(activeWindow)
//      - pendingPrayerWarning(policy, nowUtc, prayerTimes)
//  4. Ships a STATIC fallback that mirrors the global default seed exactly.
//
//
// Backward compat: STATIC_PRAYER_TIME MUST stay in sync with the migration
// global default seed in supabase/migrations/202604241900_prayer_time_policy_v1.sql.
// The pgTAP test 0zd_prayer_time_policy.sql asserts the seed values; the
// Jest test tests/unit/prayer-time-policy.test.ts asserts that the constant
// matches the seed shape exactly.

// All canonical prayer window keys we know about. `jumuah` is the Friday
// midday congregational prayer that replaces Dhuhr; consumers gate it via
// `weekday_only` (5 = Friday). Note: the runtime week uses 0=Sunday..6=Saturday
// (matches `Date.prototype.getDay()` and ISO weekday convention used by the
// `weekday_only` policy field).
export type PrayerWindowKey =
  | "fajr"
  | "dhuhr"
  | "asr"
  | "maghrib"
  | "isha"
  | "jumuah";

export type PrayerWindow = {
  key: PrayerWindowKey;
  label_en: string;
  label_ar: string;
  suppress_dispatch: boolean;
  suppression_minutes: number;
  weekday_only?: number;
};

export type PrayerTimePolicyValue = {
  version: number;
  enabled: boolean;
  windows: PrayerWindow[];
  pre_window_warning_minutes: number;
  respect_critical_only: boolean;
};

// The set of valid prayer window keys — used to filter out garbage entries
// from a malformed policy row before they pollute downstream resolution.
const VALID_PRAYER_WINDOW_KEYS: ReadonlySet<PrayerWindowKey> = new Set([
  "fajr",
  "dhuhr",
  "asr",
  "maghrib",
  "isha",
  "jumuah",
]);

// Mirror of the migration seed (see supabase/migrations/202604241900_prayer_time_policy_v1.sql).
// Used as the safe fallback when the resolver row is unavailable, malformed,
// or in flight. Kept here as a frozen constant; the Jest test below pins this
// contract bit-for-bit.
export const STATIC_PRAYER_TIME: PrayerTimePolicyValue = {
  version: 1,
  enabled: false,
  windows: [
    { key: "fajr",    label_en: "Fajr",    label_ar: "الفجر",  suppress_dispatch: true, suppression_minutes: 30 },
    { key: "dhuhr",   label_en: "Dhuhr",   label_ar: "الظهر",  suppress_dispatch: true, suppression_minutes: 30 },
    { key: "asr",     label_en: "Asr",     label_ar: "العصر",  suppress_dispatch: true, suppression_minutes: 20 },
    { key: "maghrib", label_en: "Maghrib", label_ar: "المغرب", suppress_dispatch: true, suppression_minutes: 20 },
    { key: "isha",    label_en: "Isha",    label_ar: "العشاء", suppress_dispatch: true, suppression_minutes: 30 },
    { key: "jumuah",  label_en: "Jumu'ah", label_ar: "الجمعة", suppress_dispatch: true, suppression_minutes: 90, weekday_only: 5 },
  ],
  pre_window_warning_minutes: 5,
  respect_critical_only: true,
};

// Defensive: produce a fresh deep-clone of the static seed so callers cannot
// mutate the shared constant.
function cloneStaticSeed(): PrayerTimePolicyValue {
  return {
    version: STATIC_PRAYER_TIME.version,
    enabled: STATIC_PRAYER_TIME.enabled,
    windows: STATIC_PRAYER_TIME.windows.map((w) => ({ ...w })),
    pre_window_warning_minutes: STATIC_PRAYER_TIME.pre_window_warning_minutes,
    respect_critical_only: STATIC_PRAYER_TIME.respect_critical_only,
  };
}

// Defensive parse for a single window descriptor. Returns null when the
// descriptor is structurally invalid (missing required fields, unknown key,
// non-numeric duration). Caller drops nulls.
function sanitizeWindow(raw: unknown): PrayerWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const keyRaw = obj.key;
  if (typeof keyRaw !== "string") return null;
  const key = keyRaw.trim() as PrayerWindowKey;
  if (!VALID_PRAYER_WINDOW_KEYS.has(key)) return null;

  const labelEnRaw = obj.label_en;
  const labelArRaw = obj.label_ar;
  if (typeof labelEnRaw !== "string" || !labelEnRaw.trim()) return null;
  if (typeof labelArRaw !== "string" || !labelArRaw.trim()) return null;

  const suppressRaw = obj.suppress_dispatch;
  // Treat unset / non-boolean as suppression-on (safer default for a policy
  // explicitly opted in via `enabled: true`). Mirrors the migration's
  // `required` schema list which marks suppress_dispatch as required, but
  // tolerates ops typos.
  const suppress_dispatch =
    typeof suppressRaw === "boolean" ? suppressRaw : true;

  const minutesRaw = obj.suppression_minutes;
  const suppression_minutes =
    typeof minutesRaw === "number" && Number.isFinite(minutesRaw) && minutesRaw >= 0
      ? Math.floor(minutesRaw)
      : 0;

  const weekdayRaw = obj.weekday_only;
  const weekday_only =
    typeof weekdayRaw === "number" &&
    Number.isFinite(weekdayRaw) &&
    weekdayRaw >= 0 &&
    weekdayRaw <= 6
      ? Math.floor(weekdayRaw)
      : undefined;

  const out: PrayerWindow = {
    key,
    label_en: labelEnRaw.trim(),
    label_ar: labelArRaw.trim(),
    suppress_dispatch,
    suppression_minutes,
  };
  if (weekday_only !== undefined) {
    out.weekday_only = weekday_only;
  }
  return out;
}

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// PrayerTimePolicyValue. Defensive: invalid windows are dropped, and if the
// windows array is malformed/empty we fall back to the static seed so a bad
// row in production cannot brick the dispatch scheduler.
export function normalizePrayerTimePolicy(raw: unknown): PrayerTimePolicyValue {
  if (!raw || typeof raw !== "object") return cloneStaticSeed();
  const obj = raw as Record<string, unknown>;

  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw) ? versionRaw : 1;

  // `enabled` defaults to false (matches the migration seed) so an undefined
  // / malformed value never accidentally enables suppression for tenants
  // that have not explicitly opted in.
  const enabledRaw = obj.enabled;
  const enabled = typeof enabledRaw === "boolean" ? enabledRaw : false;

  let windows: PrayerWindow[] = [];
  if (Array.isArray(obj.windows)) {
    const seen = new Set<PrayerWindowKey>();
    for (const entry of obj.windows) {
      const w = sanitizeWindow(entry);
      if (!w) continue;
      if (seen.has(w.key)) continue; // drop duplicates, preserve first occurrence
      seen.add(w.key);
      windows.push(w);
    }
  }
  if (windows.length === 0) {
    windows = STATIC_PRAYER_TIME.windows.map((w) => ({ ...w }));
  }

  const preWarnRaw = obj.pre_window_warning_minutes;
  const pre_window_warning_minutes =
    typeof preWarnRaw === "number" && Number.isFinite(preWarnRaw) && preWarnRaw >= 0
      ? Math.floor(preWarnRaw)
      : STATIC_PRAYER_TIME.pre_window_warning_minutes;

  const respectRaw = obj.respect_critical_only;
  const respect_critical_only =
    typeof respectRaw === "boolean" ? respectRaw : STATIC_PRAYER_TIME.respect_critical_only;

  return {
    version,
    enabled,
    windows,
    pre_window_warning_minutes,
    respect_critical_only,
  };
}

// Map of prayer window keys -> the local Date instances representing each
// window's start time on a given day. Consumers compute these per-day from a
// prayer-time provider (Aladhan, IslamicFinder, etc.) and pass the resolved
// map to the helpers below. We never compute prayer times here — that lives
//
export type PrayerTimesByKey = Partial<Record<PrayerWindowKey, Date>>;

// Returns the active prayer window if `nowUtc` falls within
// `[startOf(window), startOf(window) + suppression_minutes]` for any window
// whose key has a corresponding entry in `prayerTimes`. Jumu'ah is gated by
// weekday_only=5 (Friday). Returns null when:
//   - policy.enabled === false (master flag off)
//   - no window is active
//   - the active window's prayer time is missing from prayerTimes
//
// The `nowUtc` argument represents "now" as a Date (any timezone — only the
// underlying epoch is used for the comparison; the weekday gate uses
// `nowUtc.getDay()` so callers should use a Date constructed in the device's
// local timezone for weekday gating to be correct).
export function resolveActivePrayerWindow(
  policy: PrayerTimePolicyValue | null | undefined,
  nowUtc: Date,
  prayerTimes: PrayerTimesByKey,
): PrayerWindow | null {
  if (!policy || !policy.enabled) return null;
  if (!Array.isArray(policy.windows) || policy.windows.length === 0) return null;
  if (!(nowUtc instanceof Date) || Number.isNaN(nowUtc.getTime())) return null;
  if (!prayerTimes || typeof prayerTimes !== "object") return null;

  const nowMs = nowUtc.getTime();
  const weekday = nowUtc.getDay();

  for (const window of policy.windows) {
    if (window.weekday_only !== undefined && window.weekday_only !== weekday) {
      continue;
    }
    const startTime = prayerTimes[window.key];
    if (!(startTime instanceof Date) || Number.isNaN(startTime.getTime())) {
      continue;
    }
    const startMs = startTime.getTime();
    const endMs = startMs + window.suppression_minutes * 60_000;
    if (nowMs >= startMs && nowMs <= endMs) {
      return window;
    }
  }
  return null;
}

// Returns true when an active prayer window is present AND that window has
// `suppress_dispatch === true`. Pure boolean helper so the dispatch
// scheduler can guard scheduling logic with a single call:
//
//   if (shouldSuppressDispatch(resolveActivePrayerWindow(policy, now, times))) { defer(); }
//
// Note: this helper does NOT consider `respect_critical_only` — that is the
// caller's responsibility (the caller knows whether the dispatch event is
// critical). When `respect_critical_only` is true, callers should bypass the
// suppression check for safety-critical events (driving lock alerts, etc.).
export function shouldSuppressDispatch(
  activeWindow: PrayerWindow | null,
): boolean {
  if (!activeWindow) return false;
  return activeWindow.suppress_dispatch === true;
}

// Returns the next prayer window if `nowUtc` falls within
// `[startOf(window) - pre_window_warning_minutes, startOf(window))` for that
// window. Used to drive the "Salat in N min" driver banner. Returns null
// when:
//   - policy.enabled === false
//   - pre_window_warning_minutes === 0 (warnings disabled)
//   - no window is in the warning lead window
//
// Returns the *earliest* such pending window when multiple are within the
// lead window (consumer shows the most imminent one first). `minutesUntil`
// is rounded UP so the displayed countdown never claims "0 min" while the
// window is still in the future.
export function pendingPrayerWarning(
  policy: PrayerTimePolicyValue | null | undefined,
  nowUtc: Date,
  prayerTimes: PrayerTimesByKey,
): { window: PrayerWindow; minutesUntil: number } | null {
  if (!policy || !policy.enabled) return null;
  if (!Array.isArray(policy.windows) || policy.windows.length === 0) return null;
  if (policy.pre_window_warning_minutes <= 0) return null;
  if (!(nowUtc instanceof Date) || Number.isNaN(nowUtc.getTime())) return null;
  if (!prayerTimes || typeof prayerTimes !== "object") return null;

  const nowMs = nowUtc.getTime();
  const weekday = nowUtc.getDay();
  const leadMs = policy.pre_window_warning_minutes * 60_000;

  let best: { window: PrayerWindow; deltaMs: number } | null = null;
  for (const window of policy.windows) {
    if (window.weekday_only !== undefined && window.weekday_only !== weekday) {
      continue;
    }
    const startTime = prayerTimes[window.key];
    if (!(startTime instanceof Date) || Number.isNaN(startTime.getTime())) {
      continue;
    }
    const startMs = startTime.getTime();
    const deltaMs = startMs - nowMs;
    // Strictly in the future, but within the lead window.
    if (deltaMs > 0 && deltaMs <= leadMs) {
      if (!best || deltaMs < best.deltaMs) {
        best = { window, deltaMs };
      }
    }
  }
  if (!best) return null;
  return {
    window: best.window,
    minutesUntil: Math.max(1, Math.ceil(best.deltaMs / 60_000)),
  };
}
