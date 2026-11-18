import {
  STATIC_PRAYER_TIME,
  normalizePrayerTimePolicy,
  resolveActivePrayerWindow,
  shouldSuppressDispatch,
  pendingPrayerWarning,
  type PrayerTimePolicyValue,
  type PrayerTimesByKey,
} from "../../apps/fieldops/src/prayer-time-policy";

// EXACT historical seed shape that ships in
// supabase/migrations/202604241900_prayer_time_policy_v1.sql. If anyone edits
// STATIC_PRAYER_TIME without a parallel migration update, this constant is
// the canary that fails the test suite.
const HISTORICAL_PRAYER_TIME_SEED: PrayerTimePolicyValue = {
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

// Build a policy that is *enabled* (the seed ships disabled). Most of the
// runtime-behavior tests need an enabled policy.
function enabledPolicy(overrides?: Partial<PrayerTimePolicyValue>): PrayerTimePolicyValue {
  return {
    ...HISTORICAL_PRAYER_TIME_SEED,
    enabled: true,
    windows: HISTORICAL_PRAYER_TIME_SEED.windows.map((w) => ({ ...w })),
    ...overrides,
  };
}

// Friday is weekday=5 in `Date.prototype.getDay()` semantics. We pin a known
// Friday (2026-04-24 is a Friday) and a known non-Friday (2026-04-23 Thursday)
// so the weekday-gated tests are timezone-agnostic.
//
// NOTE: We construct dates in local time so `getDay()` matches the calendar
// expectation across CI timezones. The resolveActivePrayerWindow helper uses
// epoch-ms for window comparison and `getDay()` for weekday gating — both
// align with the local-time convention we use here.
const FRIDAY_2026_04_24 = (h: number, m: number) =>
  new Date(2026, 3, 24, h, m, 0, 0); // month is 0-indexed
const THURSDAY_2026_04_23 = (h: number, m: number) =>
  new Date(2026, 3, 23, h, m, 0, 0);

describe("prayer_time_policy helpers", () => {
  describe("STATIC_PRAYER_TIME (mirror of migration seed)", () => {
    test("matches the historical migration seed exactly", () => {
      expect(STATIC_PRAYER_TIME).toEqual(HISTORICAL_PRAYER_TIME_SEED);
    });

    test("declares all 5 daily Salat windows + Jumu'ah", () => {
      const keys = STATIC_PRAYER_TIME.windows.map((w) => w.key);
      expect(keys).toEqual(["fajr", "dhuhr", "asr", "maghrib", "isha", "jumuah"]);
    });

    test("Jumu'ah carries weekday_only=5 (Friday gate); other windows do not", () => {
      const jumuah = STATIC_PRAYER_TIME.windows.find((w) => w.key === "jumuah");
      expect(jumuah?.weekday_only).toBe(5);
      const nonJumuah = STATIC_PRAYER_TIME.windows.filter((w) => w.key !== "jumuah");
      for (const w of nonJumuah) {
        expect(w.weekday_only).toBeUndefined();
      }
    });

    test("default `enabled` is false (no surprise-suppress for default tenants)", () => {
      expect(STATIC_PRAYER_TIME.enabled).toBe(false);
    });

    test("default `pre_window_warning_minutes` is 5 and `respect_critical_only` is true", () => {
      expect(STATIC_PRAYER_TIME.pre_window_warning_minutes).toBe(5);
      expect(STATIC_PRAYER_TIME.respect_critical_only).toBe(true);
    });
  });

  describe("normalizePrayerTimePolicy (defensive parse)", () => {
    test("returns STATIC seed for null / undefined / non-object inputs", () => {
      expect(normalizePrayerTimePolicy(null)).toEqual(HISTORICAL_PRAYER_TIME_SEED);
      expect(normalizePrayerTimePolicy(undefined)).toEqual(HISTORICAL_PRAYER_TIME_SEED);
      expect(normalizePrayerTimePolicy("string")).toEqual(HISTORICAL_PRAYER_TIME_SEED);
      expect(normalizePrayerTimePolicy(123)).toEqual(HISTORICAL_PRAYER_TIME_SEED);
      expect(normalizePrayerTimePolicy(true)).toEqual(HISTORICAL_PRAYER_TIME_SEED);
    });

    test("normalized output deep-clones STATIC arrays (caller mutation is safe)", () => {
      const out = normalizePrayerTimePolicy(null);
      out.windows.pop();
      // Mutating `out.windows` must not poison the STATIC seed.
      const fresh = normalizePrayerTimePolicy(null);
      expect(fresh.windows.length).toBe(HISTORICAL_PRAYER_TIME_SEED.windows.length);
    });

    test("preserves a fully-valid policy body unchanged in shape", () => {
      const input = {
        version: 2,
        enabled: true,
        windows: [
          { key: "fajr", label_en: "Fajr", label_ar: "الفجر", suppress_dispatch: false, suppression_minutes: 15 },
        ],
        pre_window_warning_minutes: 10,
        respect_critical_only: false,
      };
      const result = normalizePrayerTimePolicy(input);
      expect(result.version).toBe(2);
      expect(result.enabled).toBe(true);
      expect(result.windows).toEqual([
        { key: "fajr", label_en: "Fajr", label_ar: "الفجر", suppress_dispatch: false, suppression_minutes: 15 },
      ]);
      expect(result.pre_window_warning_minutes).toBe(10);
      expect(result.respect_critical_only).toBe(false);
    });

    test("drops unknown window keys (defensive against typos / future renames)", () => {
      const result = normalizePrayerTimePolicy({
        version: 1,
        enabled: true,
        windows: [
          { key: "fajr", label_en: "Fajr", label_ar: "الفجر", suppress_dispatch: true, suppression_minutes: 30 },
          { key: "moon-prayer", label_en: "Moon", label_ar: "Moon", suppress_dispatch: true, suppression_minutes: 30 },
          { key: "isha", label_en: "Isha", label_ar: "العشاء", suppress_dispatch: true, suppression_minutes: 30 },
        ],
        pre_window_warning_minutes: 5,
        respect_critical_only: true,
      });
      const keys = result.windows.map((w) => w.key);
      expect(keys).toEqual(["fajr", "isha"]);
    });

    test("drops duplicate window keys (preserving first occurrence)", () => {
      const result = normalizePrayerTimePolicy({
        version: 1,
        enabled: true,
        windows: [
          { key: "fajr", label_en: "Fajr A", label_ar: "الفجر", suppress_dispatch: true, suppression_minutes: 30 },
          { key: "fajr", label_en: "Fajr B", label_ar: "الفجر", suppress_dispatch: false, suppression_minutes: 99 },
        ],
        pre_window_warning_minutes: 5,
        respect_critical_only: true,
      });
      expect(result.windows.length).toBe(1);
      expect(result.windows[0]?.label_en).toBe("Fajr A");
    });

    test("falls back to STATIC windows when input windows is malformed/empty", () => {
      const result = normalizePrayerTimePolicy({
        version: 1,
        enabled: true,
        windows: "not-an-array",
        pre_window_warning_minutes: 5,
        respect_critical_only: true,
      });
      expect(result.windows.length).toBe(HISTORICAL_PRAYER_TIME_SEED.windows.length);

      const result2 = normalizePrayerTimePolicy({
        version: 1,
        enabled: true,
        windows: [],
        pre_window_warning_minutes: 5,
        respect_critical_only: true,
      });
      expect(result2.windows.length).toBe(HISTORICAL_PRAYER_TIME_SEED.windows.length);
    });

    test("`enabled` defaults to false when missing/non-boolean (safe default)", () => {
      expect(
        normalizePrayerTimePolicy({
          version: 1,
          windows: [{ key: "fajr", label_en: "Fajr", label_ar: "الفجر", suppress_dispatch: true, suppression_minutes: 30 }],
          pre_window_warning_minutes: 5,
          respect_critical_only: true,
        }).enabled,
      ).toBe(false);
      expect(
        normalizePrayerTimePolicy({
          version: 1,
          enabled: "yes",
          windows: [{ key: "fajr", label_en: "Fajr", label_ar: "الفجر", suppress_dispatch: true, suppression_minutes: 30 }],
          pre_window_warning_minutes: 5,
          respect_critical_only: true,
        }).enabled,
      ).toBe(false);
    });

    test("normalizes weekday_only out-of-range to undefined and floors valid integers", () => {
      const result = normalizePrayerTimePolicy({
        version: 1,
        enabled: true,
        windows: [
          { key: "jumuah", label_en: "Jumu'ah", label_ar: "الجمعة", suppress_dispatch: true, suppression_minutes: 90, weekday_only: 99 },
          { key: "fajr",   label_en: "Fajr",    label_ar: "الفجر", suppress_dispatch: true, suppression_minutes: 30, weekday_only: 5.7 },
        ],
        pre_window_warning_minutes: 5,
        respect_critical_only: true,
      });
      const jumuah = result.windows.find((w) => w.key === "jumuah");
      const fajr = result.windows.find((w) => w.key === "fajr");
      expect(jumuah?.weekday_only).toBeUndefined();
      expect(fajr?.weekday_only).toBe(5);
    });
  });

  describe("resolveActivePrayerWindow", () => {
    const FAJR_START = THURSDAY_2026_04_23(5, 0);
    const DHUHR_START = THURSDAY_2026_04_23(12, 30);
    const ISHA_START = THURSDAY_2026_04_23(20, 0);

    const baseTimes: PrayerTimesByKey = {
      fajr: FAJR_START,
      dhuhr: DHUHR_START,
      isha: ISHA_START,
    };

    test("returns null when policy is null/undefined", () => {
      expect(resolveActivePrayerWindow(null, THURSDAY_2026_04_23(5, 10), baseTimes)).toBeNull();
      expect(resolveActivePrayerWindow(undefined, THURSDAY_2026_04_23(5, 10), baseTimes)).toBeNull();
    });

    test("returns null when policy.enabled === false (master flag off)", () => {
      const policy = enabledPolicy({ enabled: false });
      expect(resolveActivePrayerWindow(policy, THURSDAY_2026_04_23(5, 10), baseTimes)).toBeNull();
    });

    test("returns the active window when nowUtc is within [start, start + suppression_minutes]", () => {
      const policy = enabledPolicy();
      // Fajr suppression_minutes=30 -> active 05:00..05:30 inclusive.
      const r1 = resolveActivePrayerWindow(policy, THURSDAY_2026_04_23(5, 0), baseTimes);
      expect(r1?.key).toBe("fajr");
      const r2 = resolveActivePrayerWindow(policy, THURSDAY_2026_04_23(5, 15), baseTimes);
      expect(r2?.key).toBe("fajr");
      const r3 = resolveActivePrayerWindow(policy, THURSDAY_2026_04_23(5, 30), baseTimes);
      expect(r3?.key).toBe("fajr");
    });

    test("returns null when nowUtc is just outside the suppression window (1 ms after end)", () => {
      const policy = enabledPolicy();
      // 05:30:00.001 -> just past Fajr end (30 min from 05:00).
      const justAfter = new Date(FAJR_START.getTime() + 30 * 60_000 + 1);
      expect(resolveActivePrayerWindow(policy, justAfter, baseTimes)).toBeNull();
    });

    test("returns null when nowUtc is before the window start", () => {
      const policy = enabledPolicy();
      expect(resolveActivePrayerWindow(policy, THURSDAY_2026_04_23(4, 59), baseTimes)).toBeNull();
    });

    test("skips windows whose prayer time is missing from prayerTimes map", () => {
      const policy = enabledPolicy();
      // Only Fajr is provided; Dhuhr is missing — at Dhuhr time, no active.
      const onlyFajr: PrayerTimesByKey = { fajr: FAJR_START };
      expect(resolveActivePrayerWindow(policy, THURSDAY_2026_04_23(12, 35), onlyFajr)).toBeNull();
    });

    test("Jumu'ah weekday gate: active on Friday, ignored on Thursday", () => {
      const policy = enabledPolicy();
      const jumuahStart = FRIDAY_2026_04_24(12, 30);
      const friTimes: PrayerTimesByKey = { jumuah: jumuahStart };
      // 30 min into the 90-min Jumu'ah window on Friday.
      const r = resolveActivePrayerWindow(policy, FRIDAY_2026_04_24(13, 0), friTimes);
      expect(r?.key).toBe("jumuah");

      // Same time-of-day, Thursday (weekday_only=5 should reject).
      const thuTimes: PrayerTimesByKey = { jumuah: THURSDAY_2026_04_23(12, 30) };
      const r2 = resolveActivePrayerWindow(policy, THURSDAY_2026_04_23(13, 0), thuTimes);
      expect(r2).toBeNull();
    });

    test("returns null when policy.windows is empty (defensive)", () => {
      const policy: PrayerTimePolicyValue = { ...enabledPolicy(), windows: [] };
      expect(resolveActivePrayerWindow(policy, THURSDAY_2026_04_23(5, 10), baseTimes)).toBeNull();
    });

    test("returns null when nowUtc is an invalid Date", () => {
      const policy = enabledPolicy();
      expect(resolveActivePrayerWindow(policy, new Date("invalid"), baseTimes)).toBeNull();
    });
  });

  describe("shouldSuppressDispatch", () => {
    test("returns false for null active window (no suppression)", () => {
      expect(shouldSuppressDispatch(null)).toBe(false);
    });

    test("returns true when active window has suppress_dispatch=true", () => {
      expect(
        shouldSuppressDispatch({
          key: "fajr",
          label_en: "Fajr",
          label_ar: "الفجر",
          suppress_dispatch: true,
          suppression_minutes: 30,
        }),
      ).toBe(true);
    });

    test("returns false when active window has suppress_dispatch=false (informational only)", () => {
      expect(
        shouldSuppressDispatch({
          key: "fajr",
          label_en: "Fajr",
          label_ar: "الفجر",
          suppress_dispatch: false,
          suppression_minutes: 30,
        }),
      ).toBe(false);
    });
  });

  describe("pendingPrayerWarning", () => {
    const FAJR_START = THURSDAY_2026_04_23(5, 0);
    const DHUHR_START = THURSDAY_2026_04_23(12, 30);

    const baseTimes: PrayerTimesByKey = {
      fajr: FAJR_START,
      dhuhr: DHUHR_START,
    };

    test("returns null when policy is null/undefined or disabled", () => {
      expect(pendingPrayerWarning(null, THURSDAY_2026_04_23(4, 56), baseTimes)).toBeNull();
      expect(
        pendingPrayerWarning(enabledPolicy({ enabled: false }), THURSDAY_2026_04_23(4, 56), baseTimes),
      ).toBeNull();
    });

    test("returns null when pre_window_warning_minutes is 0 (warnings disabled)", () => {
      const policy = enabledPolicy({ pre_window_warning_minutes: 0 });
      expect(pendingPrayerWarning(policy, THURSDAY_2026_04_23(4, 56), baseTimes)).toBeNull();
    });

    test("returns the next window with minutesUntil when within lead window", () => {
      const policy = enabledPolicy(); // pre_window_warning_minutes=5
      // 4 min before Fajr (05:00) -> within 5-min lead window.
      const r = pendingPrayerWarning(policy, THURSDAY_2026_04_23(4, 56), baseTimes);
      expect(r?.window.key).toBe("fajr");
      expect(r?.minutesUntil).toBe(4);
    });

    test("rounds minutesUntil up so the countdown never claims '0 min' while still in the future", () => {
      const policy = enabledPolicy();
      // 30 seconds before Fajr — should round to 1 min, not 0.
      const r = pendingPrayerWarning(policy, new Date(FAJR_START.getTime() - 30_000), baseTimes);
      expect(r?.window.key).toBe("fajr");
      expect(r?.minutesUntil).toBe(1);
    });

    test("returns null when nowUtc is exactly at or past the window start (warning passed)", () => {
      const policy = enabledPolicy();
      // At Fajr start exactly — we're now in the active window, not the warning window.
      expect(pendingPrayerWarning(policy, FAJR_START, baseTimes)).toBeNull();
      // 1 ms past Fajr start — same.
      expect(pendingPrayerWarning(policy, new Date(FAJR_START.getTime() + 1), baseTimes)).toBeNull();
    });

    test("returns null when nowUtc is well outside any lead window", () => {
      const policy = enabledPolicy();
      // 2 hours before Fajr.
      expect(pendingPrayerWarning(policy, THURSDAY_2026_04_23(3, 0), baseTimes)).toBeNull();
    });

    test("picks the most imminent window when multiple are in the lead range", () => {
      const policy = enabledPolicy({ pre_window_warning_minutes: 60 });
      // 50 min before Fajr (05:00) AND 7h50min before Dhuhr — Fajr wins.
      const r = pendingPrayerWarning(policy, THURSDAY_2026_04_23(4, 10), baseTimes);
      expect(r?.window.key).toBe("fajr");
      expect(r?.minutesUntil).toBe(50);
    });

    test("Jumu'ah weekday gate: warning fires on Friday only", () => {
      const policy = enabledPolicy();
      const jumuahStart = FRIDAY_2026_04_24(12, 30);
      const friTimes: PrayerTimesByKey = { jumuah: jumuahStart };
      // 3 min before Jumu'ah on Friday -> warning fires.
      const r = pendingPrayerWarning(policy, FRIDAY_2026_04_24(12, 27), friTimes);
      expect(r?.window.key).toBe("jumuah");
      expect(r?.minutesUntil).toBe(3);

      // Same delta on Thursday — Jumu'ah weekday_only=5 must skip.
      const thuTimes: PrayerTimesByKey = { jumuah: THURSDAY_2026_04_23(12, 30) };
      expect(pendingPrayerWarning(policy, THURSDAY_2026_04_23(12, 27), thuTimes)).toBeNull();
    });
  });
});
