import {
  STATIC_RAMADAN_MODE,
  normalizeRamadanModePolicy,
  resolveEtaMultiplierPct,
  inflateEtaMinutes,
  isInSuhoorShiftWindow,
  type RamadanModePolicyValue,
} from "../../apps/fieldops/src/ramadan-mode-policy";

// EXACT mirror of the migration global default seed in
// supabase/migrations/202604241910_ramadan_mode_policy_v1.sql. If anyone
// edits STATIC_RAMADAN_MODE without a parallel migration update, this
// constant is the canary that fails the test suite.
const HISTORICAL_RAMADAN_MODE_SEED: RamadanModePolicyValue = {
  version: 1,
  enabled: false,
  active_window: { from_hijri_year: 1447, to_hijri_year: 1447 },
  eta_inflation: {
    iftar_hour: {
      start_local_offset_min_before_maghrib: 30,
      end_local_offset_min_after_maghrib: 30,
      multiplier_pct: 130,
    },
    general: { multiplier_pct: 110 },
  },
  shift_overrides: {
    iftar_break_minutes: 45,
    suhoor_shift_start_local: "21:00",
    suhoor_shift_end_local: "03:00",
  },
  bonuses: {
    iftar_completion_pct: 25,
    suhoor_completion_pct: 15,
  },
};

// Helper: clone the static seed and flip enabled=true so we can exercise the
// inflation / Suhoor-window paths without mutating the shared static value.
function enabledPolicy(
  overrides: Partial<RamadanModePolicyValue> = {},
): RamadanModePolicyValue {
  return {
    ...HISTORICAL_RAMADAN_MODE_SEED,
    enabled: true,
    eta_inflation: {
      iftar_hour: { ...HISTORICAL_RAMADAN_MODE_SEED.eta_inflation.iftar_hour },
      general: { ...HISTORICAL_RAMADAN_MODE_SEED.eta_inflation.general },
    },
    shift_overrides: { ...HISTORICAL_RAMADAN_MODE_SEED.shift_overrides },
    bonuses: { ...HISTORICAL_RAMADAN_MODE_SEED.bonuses },
    active_window: { ...HISTORICAL_RAMADAN_MODE_SEED.active_window },
    ...overrides,
  };
}

describe("ramadan_mode_policy helpers", () => {
  describe("STATIC_RAMADAN_MODE (mirror of migration global default seed)", () => {
    test("matches the migration global default seed exactly (enabled=false, full shape)", () => {
      expect(STATIC_RAMADAN_MODE).toEqual(HISTORICAL_RAMADAN_MODE_SEED);
    });

    test("default `enabled` is FALSE (Ramadan mode opt-in per tenant per Hijri year)", () => {
      expect(STATIC_RAMADAN_MODE.enabled).toBe(false);
    });

    test("default Iftar multiplier is 130 and general multiplier is 110", () => {
      expect(STATIC_RAMADAN_MODE.eta_inflation.iftar_hour.multiplier_pct).toBe(130);
      expect(STATIC_RAMADAN_MODE.eta_inflation.general.multiplier_pct).toBe(110);
    });

    test("default Suhoor shift window is the overnight 21:00 → 03:00", () => {
      expect(STATIC_RAMADAN_MODE.shift_overrides.suhoor_shift_start_local).toBe("21:00");
      expect(STATIC_RAMADAN_MODE.shift_overrides.suhoor_shift_end_local).toBe("03:00");
    });
  });

  describe("normalizeRamadanModePolicy (defensive parse)", () => {
    test("returns STATIC seed for null / undefined / non-object inputs", () => {
      expect(normalizeRamadanModePolicy(null)).toEqual(HISTORICAL_RAMADAN_MODE_SEED);
      expect(normalizeRamadanModePolicy(undefined)).toEqual(HISTORICAL_RAMADAN_MODE_SEED);
      expect(normalizeRamadanModePolicy("string")).toEqual(HISTORICAL_RAMADAN_MODE_SEED);
      expect(normalizeRamadanModePolicy(42)).toEqual(HISTORICAL_RAMADAN_MODE_SEED);
      expect(normalizeRamadanModePolicy(true)).toEqual(HISTORICAL_RAMADAN_MODE_SEED);
    });

    test("normalized output deep-clones STATIC sub-objects (caller mutation is safe)", () => {
      const out = normalizeRamadanModePolicy(null);
      out.eta_inflation.iftar_hour.multiplier_pct = 999;
      out.shift_overrides.suhoor_shift_start_local = "12:34";
      out.bonuses.iftar_completion_pct = 99;
      out.active_window.from_hijri_year = 9999;
      // Mutations must NOT poison the static seed.
      const fresh = normalizeRamadanModePolicy(null);
      expect(fresh.eta_inflation.iftar_hour.multiplier_pct).toBe(130);
      expect(fresh.shift_overrides.suhoor_shift_start_local).toBe("21:00");
      expect(fresh.bonuses.iftar_completion_pct).toBe(25);
      expect(fresh.active_window.from_hijri_year).toBe(1447);
    });

    test("preserves a fully-valid policy body unchanged", () => {
      const input: RamadanModePolicyValue = {
        version: 1,
        enabled: true,
        active_window: { from_hijri_year: 1447, to_hijri_year: 1448 },
        eta_inflation: {
          iftar_hour: {
            start_local_offset_min_before_maghrib: 20,
            end_local_offset_min_after_maghrib: 40,
            multiplier_pct: 125,
          },
          general: { multiplier_pct: 115 },
        },
        shift_overrides: {
          iftar_break_minutes: 60,
          suhoor_shift_start_local: "20:30",
          suhoor_shift_end_local: "04:00",
        },
        bonuses: { iftar_completion_pct: 30, suhoor_completion_pct: 20 },
      };
      expect(normalizeRamadanModePolicy(input)).toEqual(input);
    });

    test("clamps multiplier_pct to >= 100 (a malformed policy must never DEFLATE ETA)", () => {
      const out = normalizeRamadanModePolicy({
        version: 1,
        enabled: true,
        active_window: { from_hijri_year: 1447, to_hijri_year: 1447 },
        eta_inflation: {
          iftar_hour: {
            start_local_offset_min_before_maghrib: 30,
            end_local_offset_min_after_maghrib: 30,
            multiplier_pct: 50, // would deflate — must clamp to 100
          },
          general: { multiplier_pct: 80 }, // would deflate — must clamp to 100
        },
        shift_overrides: {
          iftar_break_minutes: 45,
          suhoor_shift_start_local: "21:00",
          suhoor_shift_end_local: "03:00",
        },
        bonuses: { iftar_completion_pct: 25, suhoor_completion_pct: 15 },
      });
      expect(out.eta_inflation.iftar_hour.multiplier_pct).toBe(100);
      expect(out.eta_inflation.general.multiplier_pct).toBe(100);
    });

    test("rejects malformed HH:MM strings and falls back to static defaults", () => {
      const out = normalizeRamadanModePolicy({
        version: 1,
        enabled: true,
        active_window: { from_hijri_year: 1447, to_hijri_year: 1447 },
        eta_inflation: {
          iftar_hour: {
            start_local_offset_min_before_maghrib: 30,
            end_local_offset_min_after_maghrib: 30,
            multiplier_pct: 130,
          },
          general: { multiplier_pct: 110 },
        },
        shift_overrides: {
          iftar_break_minutes: 45,
          suhoor_shift_start_local: "9PM",
          suhoor_shift_end_local: "25:99",
        },
        bonuses: { iftar_completion_pct: 25, suhoor_completion_pct: 15 },
      });
      expect(out.shift_overrides.suhoor_shift_start_local).toBe("21:00");
      expect(out.shift_overrides.suhoor_shift_end_local).toBe("03:00");
    });

    test("treats non-boolean `enabled` as disabled (defensive)", () => {
      const out = normalizeRamadanModePolicy({
        version: 1,
        enabled: "true", // strings must NOT activate Ramadan mode
        active_window: { from_hijri_year: 1447, to_hijri_year: 1447 },
        eta_inflation: STATIC_RAMADAN_MODE.eta_inflation,
        shift_overrides: STATIC_RAMADAN_MODE.shift_overrides,
        bonuses: STATIC_RAMADAN_MODE.bonuses,
      });
      expect(out.enabled).toBe(false);
    });
  });

  describe("resolveEtaMultiplierPct (Iftar window detection vs. general Ramadan vs. disabled)", () => {
    // Pick an arbitrary Maghrib instant — we only care about offsets relative to
    // it. Using UTC for determinism (the policy uses minute offsets, so the
    // actual timezone is irrelevant for the math).
    const maghrib = new Date("2026-03-15T18:30:00Z");

    test("returns 100 when policy.enabled is false (no inflation, no-op fallback)", () => {
      const inIftar = new Date(maghrib.getTime()); // exactly at Maghrib
      expect(resolveEtaMultiplierPct(STATIC_RAMADAN_MODE, inIftar, maghrib)).toBe(100);
    });

    test("returns iftar_hour.multiplier_pct when localTime is exactly at Maghrib", () => {
      expect(
        resolveEtaMultiplierPct(enabledPolicy(), new Date(maghrib.getTime()), maghrib),
      ).toBe(130);
    });

    test("returns iftar_hour.multiplier_pct at the start edge (30m before Maghrib)", () => {
      const startEdge = new Date(maghrib.getTime() - 30 * 60_000);
      expect(resolveEtaMultiplierPct(enabledPolicy(), startEdge, maghrib)).toBe(130);
    });

    test("returns iftar_hour.multiplier_pct at the end edge (30m after Maghrib)", () => {
      const endEdge = new Date(maghrib.getTime() + 30 * 60_000);
      expect(resolveEtaMultiplierPct(enabledPolicy(), endEdge, maghrib)).toBe(130);
    });

    test("returns general.multiplier_pct just outside the Iftar window (31m before)", () => {
      const justBefore = new Date(maghrib.getTime() - 31 * 60_000);
      expect(resolveEtaMultiplierPct(enabledPolicy(), justBefore, maghrib)).toBe(110);
    });

    test("returns general.multiplier_pct just outside the Iftar window (31m after)", () => {
      const justAfter = new Date(maghrib.getTime() + 31 * 60_000);
      expect(resolveEtaMultiplierPct(enabledPolicy(), justAfter, maghrib)).toBe(110);
    });

    test("returns general.multiplier_pct mid-day (well outside Iftar window)", () => {
      const noon = new Date("2026-03-15T12:00:00Z");
      expect(resolveEtaMultiplierPct(enabledPolicy(), noon, maghrib)).toBe(110);
    });

    test("returns general.multiplier_pct when maghribTime is null (cannot detect Iftar window)", () => {
      const noon = new Date("2026-03-15T12:00:00Z");
      expect(resolveEtaMultiplierPct(enabledPolicy(), noon, null)).toBe(110);
    });

    test("honors per-tenant override of Iftar window length and multiplier", () => {
      const tenantPolicy = enabledPolicy({
        eta_inflation: {
          iftar_hour: {
            start_local_offset_min_before_maghrib: 60,
            end_local_offset_min_after_maghrib: 15,
            multiplier_pct: 150,
          },
          general: { multiplier_pct: 120 },
        },
      });
      // 45m before Maghrib → inside the wider Iftar window
      const widerStart = new Date(maghrib.getTime() - 45 * 60_000);
      expect(resolveEtaMultiplierPct(tenantPolicy, widerStart, maghrib)).toBe(150);
      // 20m after Maghrib → outside the narrower end window
      const afterEnd = new Date(maghrib.getTime() + 20 * 60_000);
      expect(resolveEtaMultiplierPct(tenantPolicy, afterEnd, maghrib)).toBe(120);
    });
  });

  describe("inflateEtaMinutes (applies multiplier with rounding)", () => {
    const maghrib = new Date("2026-03-15T18:30:00Z");

    test("returns base ETA unchanged when policy disabled (multiplier 100)", () => {
      const noon = new Date("2026-03-15T12:00:00Z");
      expect(inflateEtaMinutes(STATIC_RAMADAN_MODE, 20, noon, maghrib)).toBe(20);
    });

    test("inflates by Iftar multiplier inside Iftar window (20 * 130%)", () => {
      const inIftar = new Date(maghrib.getTime() + 10 * 60_000);
      expect(inflateEtaMinutes(enabledPolicy(), 20, inIftar, maghrib)).toBe(26);
    });

    test("inflates by general multiplier outside Iftar window (20 * 110%)", () => {
      const noon = new Date("2026-03-15T12:00:00Z");
      expect(inflateEtaMinutes(enabledPolicy(), 20, noon, maghrib)).toBe(22);
    });

    test("rounds to the nearest whole minute (15 * 130% = 19.5 → 20)", () => {
      const inIftar = new Date(maghrib.getTime());
      expect(inflateEtaMinutes(enabledPolicy(), 15, inIftar, maghrib)).toBe(20);
    });

    test("coerces negative / non-finite base ETA to 0", () => {
      const inIftar = new Date(maghrib.getTime());
      expect(inflateEtaMinutes(enabledPolicy(), -5, inIftar, maghrib)).toBe(0);
      expect(inflateEtaMinutes(enabledPolicy(), Number.NaN, inIftar, maghrib)).toBe(0);
      expect(inflateEtaMinutes(enabledPolicy(), Infinity, inIftar, maghrib)).toBe(0);
    });
  });

  describe("isInSuhoorShiftWindow (overnight wrap-around 21:00 → 03:00)", () => {
    test("returns false when policy.enabled is false (Ramadan mode off)", () => {
      expect(isInSuhoorShiftWindow(STATIC_RAMADAN_MODE, "22:00")).toBe(false);
      expect(isInSuhoorShiftWindow(STATIC_RAMADAN_MODE, "01:00")).toBe(false);
    });

    test("returns true at the start edge (21:00 inclusive)", () => {
      expect(isInSuhoorShiftWindow(enabledPolicy(), "21:00")).toBe(true);
    });

    test("returns true at the end edge (03:00 inclusive)", () => {
      expect(isInSuhoorShiftWindow(enabledPolicy(), "03:00")).toBe(true);
    });

    test("returns true late in the evening (22:30) and overnight (01:15)", () => {
      expect(isInSuhoorShiftWindow(enabledPolicy(), "22:30")).toBe(true);
      expect(isInSuhoorShiftWindow(enabledPolicy(), "01:15")).toBe(true);
      expect(isInSuhoorShiftWindow(enabledPolicy(), "23:59")).toBe(true);
      expect(isInSuhoorShiftWindow(enabledPolicy(), "00:00")).toBe(true);
    });

    test("returns false in the daytime gap (e.g. 12:00, 17:00, 20:59)", () => {
      expect(isInSuhoorShiftWindow(enabledPolicy(), "12:00")).toBe(false);
      expect(isInSuhoorShiftWindow(enabledPolicy(), "17:00")).toBe(false);
      expect(isInSuhoorShiftWindow(enabledPolicy(), "20:59")).toBe(false);
      expect(isInSuhoorShiftWindow(enabledPolicy(), "03:01")).toBe(false);
    });

    test("supports a same-day window when start < end (e.g. 09:00 → 17:00)", () => {
      const sameDay = enabledPolicy({
        shift_overrides: {
          iftar_break_minutes: 45,
          suhoor_shift_start_local: "09:00",
          suhoor_shift_end_local: "17:00",
        },
      });
      expect(isInSuhoorShiftWindow(sameDay, "08:59")).toBe(false);
      expect(isInSuhoorShiftWindow(sameDay, "09:00")).toBe(true);
      expect(isInSuhoorShiftWindow(sameDay, "12:00")).toBe(true);
      expect(isInSuhoorShiftWindow(sameDay, "17:00")).toBe(true);
      expect(isInSuhoorShiftWindow(sameDay, "17:01")).toBe(false);
    });

    test("returns false for a zero-length window (start == end)", () => {
      const zero = enabledPolicy({
        shift_overrides: {
          iftar_break_minutes: 0,
          suhoor_shift_start_local: "21:00",
          suhoor_shift_end_local: "21:00",
        },
      });
      expect(isInSuhoorShiftWindow(zero, "21:00")).toBe(false);
      expect(isInSuhoorShiftWindow(zero, "12:00")).toBe(false);
    });

    test("returns false for malformed input HH:MM (defensive — no false positives)", () => {
      expect(isInSuhoorShiftWindow(enabledPolicy(), "25:99")).toBe(false);
      expect(isInSuhoorShiftWindow(enabledPolicy(), "9PM")).toBe(false);
      expect(isInSuhoorShiftWindow(enabledPolicy(), "")).toBe(false);
      expect(isInSuhoorShiftWindow(enabledPolicy(), "ab:cd")).toBe(false);
    });
  });
});
