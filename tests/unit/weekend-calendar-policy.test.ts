// Verify country-specific weekends and the default calendar fallback.

import {
  STATIC_WEEKEND_CALENDAR,
  normalizeWeekendCalendarPolicy,
  getWeekendDays,
  isWeekend,
  type WeekendCalendarPolicyValue,
} from "../../apps/fieldops/src/weekend-calendar-policy";

// 2024-01-12 is a Friday (UTC). 2024-01-13 is a Saturday. 2024-01-14 is a Sunday.
const FRIDAY_2024_01_12 = new Date(Date.UTC(2024, 0, 12, 12, 0, 0));
const SATURDAY_2024_01_13 = new Date(Date.UTC(2024, 0, 13, 12, 0, 0));
const SUNDAY_2024_01_14 = new Date(Date.UTC(2024, 0, 14, 12, 0, 0));
const MONDAY_2024_01_15 = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));

describe("weekend_calendar_policy helpers", () => {
  describe("STATIC_WEEKEND_CALENDAR (mirror of migration global default)", () => {
    test("version is 1", () => {
      expect(STATIC_WEEKEND_CALENDAR.version).toBe(1);
    });

    test("default weekend_days is [5, 6] — Fri-Sat (MENA-majority fallback)", () => {
      expect(STATIC_WEEKEND_CALENDAR.weekend_days).toEqual([5, 6]);
    });

    test("KSA override is [5, 6] — Fri-Sat", () => {
      expect(STATIC_WEEKEND_CALENDAR.calendar_overrides.SA).toEqual([5, 6]);
    });

    test("UAE override is [6, 0] — Sat-Sun (post-2022 reform)", () => {
      expect(STATIC_WEEKEND_CALENDAR.calendar_overrides.AE).toEqual([6, 0]);
    });

    test("US override is [6, 0] — Sat-Sun (Western convention)", () => {
      expect(STATIC_WEEKEND_CALENDAR.calendar_overrides.US).toEqual([6, 0]);
    });

    test("GB override is [6, 0] — Sat-Sun (Western convention)", () => {
      expect(STATIC_WEEKEND_CALENDAR.calendar_overrides.GB).toEqual([6, 0]);
    });

    test("Other MENA markets (KW, BH, QA, OM, JO, EG) all match Fri-Sat", () => {
      for (const cc of ["KW", "BH", "QA", "OM", "JO", "EG"]) {
        expect(STATIC_WEEKEND_CALENDAR.calendar_overrides[cc]).toEqual([5, 6]);
      }
    });
  });

  describe("getWeekendDays (per-country resolution)", () => {
    test("returns KSA override [5, 6] for SA", () => {
      expect(getWeekendDays(STATIC_WEEKEND_CALENDAR, "SA")).toEqual([5, 6]);
    });

    test("returns UAE override [6, 0] for AE (Sat-Sun post-2022)", () => {
      expect(getWeekendDays(STATIC_WEEKEND_CALENDAR, "AE")).toEqual([6, 0]);
    });

    test("returns US override [6, 0] for US (Sat-Sun)", () => {
      expect(getWeekendDays(STATIC_WEEKEND_CALENDAR, "US")).toEqual([6, 0]);
    });

    test("returns fallback weekend_days [5, 6] for unknown country (XX)", () => {
      expect(getWeekendDays(STATIC_WEEKEND_CALENDAR, "XX")).toEqual([5, 6]);
    });

    test("returns fallback weekend_days for empty country code", () => {
      expect(getWeekendDays(STATIC_WEEKEND_CALENDAR, "")).toEqual([5, 6]);
    });

    test("normalizes country code (lower-case + whitespace) before lookup", () => {
      expect(getWeekendDays(STATIC_WEEKEND_CALENDAR, "ae")).toEqual([6, 0]);
      expect(getWeekendDays(STATIC_WEEKEND_CALENDAR, "  AE  ")).toEqual([6, 0]);
      expect(getWeekendDays(STATIC_WEEKEND_CALENDAR, " sa ")).toEqual([5, 6]);
    });

    test("returns fresh array each call (caller mutation is safe)", () => {
      const a = getWeekendDays(STATIC_WEEKEND_CALENDAR, "SA");
      const b = getWeekendDays(STATIC_WEEKEND_CALENDAR, "SA");
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      a.pop();
      expect(getWeekendDays(STATIC_WEEKEND_CALENDAR, "SA")).toEqual([5, 6]);
    });
  });

  describe("isWeekend (calendar predicate)", () => {
    test("KSA: Friday 2024-01-12 is weekend", () => {
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, FRIDAY_2024_01_12, "SA")).toBe(true);
    });

    test("KSA: Saturday 2024-01-13 is weekend", () => {
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, SATURDAY_2024_01_13, "SA")).toBe(true);
    });

    test("KSA: Sunday 2024-01-14 is NOT weekend (Fri-Sat market)", () => {
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, SUNDAY_2024_01_14, "SA")).toBe(false);
    });

    test("UAE: Friday 2024-01-12 is NOT weekend (Sat-Sun market post-2022)", () => {
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, FRIDAY_2024_01_12, "AE")).toBe(false);
    });

    test("UAE: Saturday 2024-01-13 is weekend", () => {
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, SATURDAY_2024_01_13, "AE")).toBe(true);
    });

    test("UAE: Sunday 2024-01-14 is weekend (post-2022 reform)", () => {
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, SUNDAY_2024_01_14, "AE")).toBe(true);
    });

    test("US: Saturday + Sunday are weekend; Friday + Monday are not", () => {
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, SATURDAY_2024_01_13, "US")).toBe(true);
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, SUNDAY_2024_01_14, "US")).toBe(true);
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, FRIDAY_2024_01_12, "US")).toBe(false);
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, MONDAY_2024_01_15, "US")).toBe(false);
    });

    test("Unknown country falls back to default weekend_days [5,6]", () => {
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, FRIDAY_2024_01_12, "XX")).toBe(true);
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, SUNDAY_2024_01_14, "XX")).toBe(false);
    });

    test("Invalid Date returns false (not weekend)", () => {
      expect(isWeekend(STATIC_WEEKEND_CALENDAR, new Date("nope"), "SA")).toBe(false);
    });
  });

  describe("normalizeWeekendCalendarPolicy (defensive parse)", () => {
    test("returns STATIC seed for null / undefined / non-object inputs", () => {
      expect(normalizeWeekendCalendarPolicy(null)).toEqual(STATIC_WEEKEND_CALENDAR);
      expect(normalizeWeekendCalendarPolicy(undefined)).toEqual(STATIC_WEEKEND_CALENDAR);
      expect(normalizeWeekendCalendarPolicy("string")).toEqual(STATIC_WEEKEND_CALENDAR);
      expect(normalizeWeekendCalendarPolicy(42)).toEqual(STATIC_WEEKEND_CALENDAR);
    });

    test("preserves a fully-valid policy body unchanged", () => {
      const input: WeekendCalendarPolicyValue = {
        version: 1,
        weekend_days: [5, 6],
        calendar_overrides: { SA: [5, 6], AE: [6, 0] },
      };
      const result = normalizeWeekendCalendarPolicy(input);
      expect(result.version).toBe(1);
      expect(result.weekend_days).toEqual([5, 6]);
      expect(result.calendar_overrides.SA).toEqual([5, 6]);
      expect(result.calendar_overrides.AE).toEqual([6, 0]);
    });

    test("drops invalid day indices (out of range, non-integer)", () => {
      const result = normalizeWeekendCalendarPolicy({
        version: 1,
        weekend_days: [5, 6, 7, -1, 1.5, "string", null],
        calendar_overrides: { SA: [5, 6, 99] },
      });
      expect(result.weekend_days).toEqual([5, 6]);
      expect(result.calendar_overrides.SA).toEqual([5, 6]);
    });

    test("drops duplicate days (preserves first-occurrence order)", () => {
      const result = normalizeWeekendCalendarPolicy({
        version: 1,
        weekend_days: [5, 6, 5, 6],
        calendar_overrides: { SA: [6, 5, 6, 5] },
      });
      expect(result.weekend_days).toEqual([5, 6]);
      expect(result.calendar_overrides.SA).toEqual([6, 5]);
    });

    test("drops override entries with zero valid days", () => {
      const result = normalizeWeekendCalendarPolicy({
        version: 1,
        weekend_days: [5, 6],
        calendar_overrides: {
          SA: [5, 6],
          BAD: [99, -1, "x"], // all invalid → dropped entirely
        },
      });
      expect(result.calendar_overrides.SA).toEqual([5, 6]);
      expect(result.calendar_overrides.BAD).toBeUndefined();
    });

    test("normalizes override country keys to upper-case", () => {
      const result = normalizeWeekendCalendarPolicy({
        version: 1,
        weekend_days: [5, 6],
        calendar_overrides: { sa: [5, 6], "  ae  ": [6, 0] },
      });
      expect(result.calendar_overrides.SA).toEqual([5, 6]);
      expect(result.calendar_overrides.AE).toEqual([6, 0]);
    });

    test("falls back to STATIC weekend_days when input is malformed", () => {
      const result = normalizeWeekendCalendarPolicy({
        version: 1,
        weekend_days: "not-an-array",
        calendar_overrides: { SA: [5, 6] },
      });
      expect(result.weekend_days).toEqual([5, 6]);
      expect(result.calendar_overrides.SA).toEqual([5, 6]);
    });

    test("returns empty calendar_overrides for null / non-object overrides", () => {
      const result = normalizeWeekendCalendarPolicy({
        version: 1,
        weekend_days: [5, 6],
        calendar_overrides: null,
      });
      expect(result.calendar_overrides).toEqual({});
    });

    test("uses default version=1 when version is missing or invalid", () => {
      expect(
        normalizeWeekendCalendarPolicy({
          weekend_days: [5, 6],
          calendar_overrides: {},
        }).version,
      ).toBe(1);
      expect(
        normalizeWeekendCalendarPolicy({
          version: "not-a-number",
          weekend_days: [5, 6],
          calendar_overrides: {},
        }).version,
      ).toBe(1);
    });

    test("normalized output is fully usable by getWeekendDays + isWeekend", () => {
      const policy = normalizeWeekendCalendarPolicy({
        version: 1,
        weekend_days: [5, 6],
        calendar_overrides: { ae: [6, 0] },
      });
      expect(getWeekendDays(policy, "AE")).toEqual([6, 0]);
      expect(isWeekend(policy, SUNDAY_2024_01_14, "AE")).toBe(true);
      expect(isWeekend(policy, FRIDAY_2024_01_12, "AE")).toBe(false);
    });
  });
});
