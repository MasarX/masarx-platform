import {
  STATIC_BRAND_HERO,
  normalizeBrandHeroPolicy,
  resolveHeroMoment,
  shouldShowHeroMoment,
  type BrandHeroPolicyValue,
  type BrandHeroMoment,
  type SignInMomentConfig,
  type ShiftStartMomentConfig,
  type ShiftEndMomentConfig,
  type ErrorRecoveryMomentConfig,
} from "../../apps/fieldops/src/brand-hero-policy";

// EXACT mirror of the migration global default seed in
// supabase/migrations/202604242030_brand_hero_policy_v1.sql. If anyone
// edits STATIC_BRAND_HERO without a parallel migration update, this
// constant is the canary that fails the test suite.
const HISTORICAL_BRAND_HERO_SEED: BrandHeroPolicyValue = {
  version: 1,
  moments: {
    sign_in: {
      enabled: true,
      variant: "tinted_glass",
      show_biometric_pill: true,
      background_animation: "subtle_glow",
    },
    shift_start: {
      enabled: true,
      variant: "confetti_haptic",
      show_earnings_preview: true,
      haptic_pattern: "success",
      duration_ms: 2400,
    },
    shift_end: {
      enabled: true,
      variant: "summary_card",
      show_sparkline: true,
      show_thank_you: true,
      show_share_export: true,
    },
    error_recovery: {
      enabled: true,
      variant: "branded_boundary",
      show_offline_radar: true,
      preserve_last_state: true,
      show_retry_cta: true,
    },
  },
  respect_reduce_motion: true,
  respect_driving_lock: true,
};

// Helper: clone the seed with optional overrides on the top-level fields, so
// each test exercising shouldShowHeroMoment can flip moment.enabled or
// respect flags without mutating the shared static value.
function clonedPolicy(
  overrides: Partial<BrandHeroPolicyValue> = {},
): BrandHeroPolicyValue {
  return {
    ...HISTORICAL_BRAND_HERO_SEED,
    moments: {
      sign_in: { ...HISTORICAL_BRAND_HERO_SEED.moments.sign_in },
      shift_start: { ...HISTORICAL_BRAND_HERO_SEED.moments.shift_start },
      shift_end: { ...HISTORICAL_BRAND_HERO_SEED.moments.shift_end },
      error_recovery: { ...HISTORICAL_BRAND_HERO_SEED.moments.error_recovery },
    },
    ...overrides,
  };
}

const ALL_MOMENTS: BrandHeroMoment[] = [
  "sign_in",
  "shift_start",
  "shift_end",
  "error_recovery",
];

describe("brand_hero_policy helpers", () => {
  describe("STATIC_BRAND_HERO (mirror of migration global default seed)", () => {
    test("matches the migration global default seed exactly (all four moments enabled, both respects on)", () => {
      expect(STATIC_BRAND_HERO).toEqual(HISTORICAL_BRAND_HERO_SEED);
    });

    test("default sign_in is tinted_glass + subtle_glow + biometric pill", () => {
      expect(STATIC_BRAND_HERO.moments.sign_in.variant).toBe("tinted_glass");
      expect(STATIC_BRAND_HERO.moments.sign_in.background_animation).toBe(
        "subtle_glow",
      );
      expect(STATIC_BRAND_HERO.moments.sign_in.show_biometric_pill).toBe(true);
    });

    test("default shift_start is confetti_haptic + earnings preview + success haptic + 2400ms", () => {
      expect(STATIC_BRAND_HERO.moments.shift_start.variant).toBe(
        "confetti_haptic",
      );
      expect(STATIC_BRAND_HERO.moments.shift_start.show_earnings_preview).toBe(
        true,
      );
      expect(STATIC_BRAND_HERO.moments.shift_start.haptic_pattern).toBe(
        "success",
      );
      expect(STATIC_BRAND_HERO.moments.shift_start.duration_ms).toBe(2400);
    });

    test("default shift_end is summary_card with sparkline + thank-you + share/export", () => {
      expect(STATIC_BRAND_HERO.moments.shift_end.variant).toBe("summary_card");
      expect(STATIC_BRAND_HERO.moments.shift_end.show_sparkline).toBe(true);
      expect(STATIC_BRAND_HERO.moments.shift_end.show_thank_you).toBe(true);
      expect(STATIC_BRAND_HERO.moments.shift_end.show_share_export).toBe(true);
    });

    test("default error_recovery is branded_boundary + offline radar + state preservation + retry CTA", () => {
      expect(STATIC_BRAND_HERO.moments.error_recovery.variant).toBe(
        "branded_boundary",
      );
      expect(STATIC_BRAND_HERO.moments.error_recovery.show_offline_radar).toBe(
        true,
      );
      expect(STATIC_BRAND_HERO.moments.error_recovery.preserve_last_state).toBe(
        true,
      );
      expect(STATIC_BRAND_HERO.moments.error_recovery.show_retry_cta).toBe(
        true,
      );
    });

    test("default respect flags are both true (a11y + driving-lock honored without per-tenant config)", () => {
      expect(STATIC_BRAND_HERO.respect_reduce_motion).toBe(true);
      expect(STATIC_BRAND_HERO.respect_driving_lock).toBe(true);
    });
  });

  describe("normalizeBrandHeroPolicy (defensive parse)", () => {
    test("returns STATIC seed for null / undefined / non-object inputs", () => {
      expect(normalizeBrandHeroPolicy(null)).toEqual(HISTORICAL_BRAND_HERO_SEED);
      expect(normalizeBrandHeroPolicy(undefined)).toEqual(
        HISTORICAL_BRAND_HERO_SEED,
      );
      expect(normalizeBrandHeroPolicy("string")).toEqual(
        HISTORICAL_BRAND_HERO_SEED,
      );
      expect(normalizeBrandHeroPolicy(42)).toEqual(HISTORICAL_BRAND_HERO_SEED);
      expect(normalizeBrandHeroPolicy(true)).toEqual(
        HISTORICAL_BRAND_HERO_SEED,
      );
    });

    test("normalized output deep-clones STATIC sub-objects (caller mutation is safe)", () => {
      const out = normalizeBrandHeroPolicy(null);
      out.moments.sign_in.variant = "MUTATED";
      out.moments.shift_start.duration_ms = 9999;
      out.moments.shift_end.show_sparkline = false;
      out.moments.error_recovery.variant = "MUTATED";
      out.respect_reduce_motion = false;
      // Mutations must NOT poison the static seed.
      const fresh = normalizeBrandHeroPolicy(null);
      expect(fresh.moments.sign_in.variant).toBe("tinted_glass");
      expect(fresh.moments.shift_start.duration_ms).toBe(2400);
      expect(fresh.moments.shift_end.show_sparkline).toBe(true);
      expect(fresh.moments.error_recovery.variant).toBe("branded_boundary");
      expect(fresh.respect_reduce_motion).toBe(true);
    });

    test("preserves a fully-valid policy body unchanged", () => {
      const input: BrandHeroPolicyValue = {
        version: 1,
        moments: {
          sign_in: {
            enabled: false,
            variant: "minimal",
            show_biometric_pill: false,
            background_animation: "none",
          },
          shift_start: {
            enabled: true,
            variant: "fireworks",
            show_earnings_preview: false,
            haptic_pattern: "heavy",
            duration_ms: 1500,
          },
          shift_end: {
            enabled: false,
            variant: "minimal_card",
            show_sparkline: false,
            show_thank_you: true,
            show_share_export: false,
          },
          error_recovery: {
            enabled: true,
            variant: "minimal_boundary",
            show_offline_radar: false,
            preserve_last_state: true,
            show_retry_cta: true,
          },
        },
        respect_reduce_motion: false,
        respect_driving_lock: false,
      };
      expect(normalizeBrandHeroPolicy(input)).toEqual(input);
    });

    test("clamps shift_start.duration_ms to >= 0 and <= 30000 (defensive)", () => {
      const negativeOut = normalizeBrandHeroPolicy({
        version: 1,
        moments: {
          ...HISTORICAL_BRAND_HERO_SEED.moments,
          shift_start: {
            ...HISTORICAL_BRAND_HERO_SEED.moments.shift_start,
            duration_ms: -500,
          },
        },
        respect_reduce_motion: true,
        respect_driving_lock: true,
      });
      expect(negativeOut.moments.shift_start.duration_ms).toBe(0);

      const tooLargeOut = normalizeBrandHeroPolicy({
        version: 1,
        moments: {
          ...HISTORICAL_BRAND_HERO_SEED.moments,
          shift_start: {
            ...HISTORICAL_BRAND_HERO_SEED.moments.shift_start,
            duration_ms: 999999,
          },
        },
        respect_reduce_motion: true,
        respect_driving_lock: true,
      });
      expect(tooLargeOut.moments.shift_start.duration_ms).toBe(30000);
    });

    test("treats non-boolean enabled / respect flags as static fallback (no string-truthy)", () => {
      const out = normalizeBrandHeroPolicy({
        version: 1,
        moments: {
          ...HISTORICAL_BRAND_HERO_SEED.moments,
          sign_in: {
            ...HISTORICAL_BRAND_HERO_SEED.moments.sign_in,
            enabled: "false",
          },
        },
        respect_reduce_motion: "true",
        respect_driving_lock: 1,
      });
      // sign_in.enabled fell back to STATIC seed (which is true), not the
      // string "false" coerced to truthy.
      expect(out.moments.sign_in.enabled).toBe(true);
      expect(out.respect_reduce_motion).toBe(true);
      expect(out.respect_driving_lock).toBe(true);
    });

    test("falls back to static seed for missing moments object entirely", () => {
      const out = normalizeBrandHeroPolicy({
        version: 1,
        respect_reduce_motion: true,
        respect_driving_lock: true,
      });
      expect(out.moments.sign_in).toEqual(
        HISTORICAL_BRAND_HERO_SEED.moments.sign_in,
      );
      expect(out.moments.shift_start).toEqual(
        HISTORICAL_BRAND_HERO_SEED.moments.shift_start,
      );
      expect(out.moments.shift_end).toEqual(
        HISTORICAL_BRAND_HERO_SEED.moments.shift_end,
      );
      expect(out.moments.error_recovery).toEqual(
        HISTORICAL_BRAND_HERO_SEED.moments.error_recovery,
      );
    });

    test("preserves version field when finite, falls back when junk", () => {
      const numericOut = normalizeBrandHeroPolicy({
        version: 7,
        moments: HISTORICAL_BRAND_HERO_SEED.moments,
        respect_reduce_motion: true,
        respect_driving_lock: true,
      });
      expect(numericOut.version).toBe(7);

      const junkOut = normalizeBrandHeroPolicy({
        version: "v1",
        moments: HISTORICAL_BRAND_HERO_SEED.moments,
        respect_reduce_motion: true,
        respect_driving_lock: true,
      });
      expect(junkOut.version).toBe(1);
    });
  });

  describe("resolveHeroMoment (per-moment lookup + safe fallback)", () => {
    test("returns the matching moment for each of the four canonical moments", () => {
      const policy = clonedPolicy();
      const signIn = resolveHeroMoment(policy, "sign_in") as SignInMomentConfig;
      expect(signIn.variant).toBe("tinted_glass");
      expect(signIn.show_biometric_pill).toBe(true);

      const shiftStart = resolveHeroMoment(
        policy,
        "shift_start",
      ) as ShiftStartMomentConfig;
      expect(shiftStart.variant).toBe("confetti_haptic");
      expect(shiftStart.duration_ms).toBe(2400);

      const shiftEnd = resolveHeroMoment(
        policy,
        "shift_end",
      ) as ShiftEndMomentConfig;
      expect(shiftEnd.variant).toBe("summary_card");
      expect(shiftEnd.show_sparkline).toBe(true);

      const errorRecovery = resolveHeroMoment(
        policy,
        "error_recovery",
      ) as ErrorRecoveryMomentConfig;
      expect(errorRecovery.variant).toBe("branded_boundary");
      expect(errorRecovery.show_offline_radar).toBe(true);
    });

    test("returns a safe enabled=false fallback when the moment is missing from the policy", () => {
      const partial = {
        ...HISTORICAL_BRAND_HERO_SEED,
        moments: {
          // intentionally drop sign_in to simulate a malformed normalized row
          sign_in: undefined as unknown as SignInMomentConfig,
          shift_start: HISTORICAL_BRAND_HERO_SEED.moments.shift_start,
          shift_end: HISTORICAL_BRAND_HERO_SEED.moments.shift_end,
          error_recovery: HISTORICAL_BRAND_HERO_SEED.moments.error_recovery,
        },
      } as BrandHeroPolicyValue;
      const result = resolveHeroMoment(partial, "sign_in");
      expect(result.enabled).toBe(false);
    });

    test("returns enabled=false when the policy.moments object itself is missing", () => {
      const broken = {
        version: 1,
        moments: undefined as unknown as BrandHeroPolicyValue["moments"],
        respect_reduce_motion: true,
        respect_driving_lock: true,
      } as BrandHeroPolicyValue;
      expect(resolveHeroMoment(broken, "sign_in").enabled).toBe(false);
      expect(resolveHeroMoment(broken, "shift_start").enabled).toBe(false);
    });

    test("returned object is a fresh clone — caller mutation does not poison policy", () => {
      const policy = clonedPolicy();
      const signIn = resolveHeroMoment(policy, "sign_in") as SignInMomentConfig;
      signIn.variant = "MUTATED";
      signIn.enabled = false;
      // Re-resolve and confirm the policy is untouched.
      const fresh = resolveHeroMoment(policy, "sign_in") as SignInMomentConfig;
      expect(fresh.variant).toBe("tinted_glass");
      expect(fresh.enabled).toBe(true);
    });
  });

  describe("shouldShowHeroMoment (full matrix: 4 moments × reduce-motion × driving-lock)", () => {
    // Default-policy positive paths (no a11y / driving-lock pressure)
    test.each(ALL_MOMENTS)(
      "returns true for %s on the default policy with no a11y/driving-lock pressure",
      (moment) => {
        expect(shouldShowHeroMoment(clonedPolicy(), moment)).toBe(true);
      },
    );

    // Reduce-motion suppression paths (default policy respects reduce-motion)
    test.each(ALL_MOMENTS)(
      "returns false for %s when reduceMotion=true and policy.respect_reduce_motion=true",
      (moment) => {
        expect(
          shouldShowHeroMoment(clonedPolicy(), moment, { reduceMotion: true }),
        ).toBe(false);
      },
    );

    // Driving-lock suppression paths (default policy respects driving-lock)
    test.each(ALL_MOMENTS)(
      "returns false for %s when drivingLockActive=true and policy.respect_driving_lock=true",
      (moment) => {
        expect(
          shouldShowHeroMoment(clonedPolicy(), moment, {
            drivingLockActive: true,
          }),
        ).toBe(false);
      },
    );

    // Per-moment opt-out: when the moment.enabled is false, no condition can
    // turn it back on.
    test.each(ALL_MOMENTS)(
      "returns false for %s when moment.enabled=false (regardless of options)",
      (moment) => {
        const policy = clonedPolicy();
        // narrow + flip enabled on the right moment
        switch (moment) {
          case "sign_in":
            policy.moments.sign_in.enabled = false;
            break;
          case "shift_start":
            policy.moments.shift_start.enabled = false;
            break;
          case "shift_end":
            policy.moments.shift_end.enabled = false;
            break;
          case "error_recovery":
            policy.moments.error_recovery.enabled = false;
            break;
        }
        expect(shouldShowHeroMoment(policy, moment)).toBe(false);
        expect(shouldShowHeroMoment(policy, moment, { reduceMotion: false })).toBe(
          false,
        );
        expect(
          shouldShowHeroMoment(policy, moment, { drivingLockActive: false }),
        ).toBe(false);
      },
    );

    // Per-tenant respect-flag opt-out: when a tenant explicitly sets
    // respect_reduce_motion=false, hero moments run even with reduce-motion on.
    test("respects a tenant override of respect_reduce_motion=false (renders even when reduceMotion is on)", () => {
      const policy = clonedPolicy({ respect_reduce_motion: false });
      expect(
        shouldShowHeroMoment(policy, "sign_in", { reduceMotion: true }),
      ).toBe(true);
      expect(
        shouldShowHeroMoment(policy, "shift_start", { reduceMotion: true }),
      ).toBe(true);
    });

    test("respects a tenant override of respect_driving_lock=false (renders even when driving lock is active)", () => {
      const policy = clonedPolicy({ respect_driving_lock: false });
      expect(
        shouldShowHeroMoment(policy, "shift_end", { drivingLockActive: true }),
      ).toBe(true);
      expect(
        shouldShowHeroMoment(policy, "error_recovery", {
          drivingLockActive: true,
        }),
      ).toBe(true);
    });

    test("driving-lock takes precedence even when reduceMotion is off", () => {
      // Confirm that providing drivingLockActive=true alone (no reduce-motion)
      // still suppresses on the default respect policy.
      expect(
        shouldShowHeroMoment(clonedPolicy(), "shift_start", {
          reduceMotion: false,
          drivingLockActive: true,
        }),
      ).toBe(false);
    });

    test("both options false explicitly behaves identical to omitted options", () => {
      const policy = clonedPolicy();
      const omitted = shouldShowHeroMoment(policy, "sign_in");
      const explicit = shouldShowHeroMoment(policy, "sign_in", {
        reduceMotion: false,
        drivingLockActive: false,
      });
      expect(omitted).toBe(true);
      expect(explicit).toBe(true);
    });

    test("missing moment in the policy short-circuits to false even without a11y/driving-lock pressure", () => {
      const broken = {
        version: 1,
        moments: undefined as unknown as BrandHeroPolicyValue["moments"],
        respect_reduce_motion: true,
        respect_driving_lock: true,
      } as BrandHeroPolicyValue;
      expect(shouldShowHeroMoment(broken, "sign_in")).toBe(false);
      expect(shouldShowHeroMoment(broken, "shift_start")).toBe(false);
      expect(shouldShowHeroMoment(broken, "shift_end")).toBe(false);
      expect(shouldShowHeroMoment(broken, "error_recovery")).toBe(false);
    });
  });
});
