// Verify that motion durations and easing resolve through the policy tokens.

import {
  STATIC_MOTION_TOKEN,
  normalizeMotionTokenPolicy,
  resolveMotionDuration,
  resolveMotionEasing,
  type MotionTokenPolicyValue,
} from "../../apps/fieldops/src/motion-token-policy";

describe("motion_token_policy helpers", () => {
  describe("STATIC_MOTION_TOKEN (mirror of global seed)", () => {
    test("has version 1", () => {
      expect(STATIC_MOTION_TOKEN.version).toBe(1);
    });

    test("duration buckets match the migration seed", () => {
      expect(STATIC_MOTION_TOKEN.duration).toEqual({
        instant: 0,
        micro: 120,
        short: 200,
        medium: 320,
        long: 480,
        hero: 640,
      });
    });

    test("easing curves match the migration seed (six canonical keys)", () => {
      expect(STATIC_MOTION_TOKEN.easing).toEqual({
        linear: "linear",
        standard: "cubic-bezier(0.2,0,0,1)",
        decelerate: "cubic-bezier(0,0,0,1)",
        accelerate: "cubic-bezier(0.3,0,1,1)",
        emphasis: "cubic-bezier(0.2,0,0,1)",
        expressive: "cubic-bezier(0.34,1.56,0.64,1)",
      });
    });

    test("reduce_motion_strategy defaults to 'disable_loops'", () => {
      expect(STATIC_MOTION_TOKEN.reduce_motion_strategy).toBe("disable_loops");
    });
  });

  describe("resolveMotionDuration (basic lookups)", () => {
    test("returns the policy duration for each named bucket", () => {
      expect(resolveMotionDuration(STATIC_MOTION_TOKEN, "instant")).toBe(0);
      expect(resolveMotionDuration(STATIC_MOTION_TOKEN, "micro")).toBe(120);
      expect(resolveMotionDuration(STATIC_MOTION_TOKEN, "short")).toBe(200);
      expect(resolveMotionDuration(STATIC_MOTION_TOKEN, "medium")).toBe(320);
      expect(resolveMotionDuration(STATIC_MOTION_TOKEN, "long")).toBe(480);
      expect(resolveMotionDuration(STATIC_MOTION_TOKEN, "hero")).toBe(640);
    });

    test("respects per-tenant override (custom medium duration)", () => {
      const tenantOverride: MotionTokenPolicyValue = {
        ...STATIC_MOTION_TOKEN,
        duration: { ...STATIC_MOTION_TOKEN.duration, medium: 480 },
      };
      expect(resolveMotionDuration(tenantOverride, "medium")).toBe(480);
      // Other buckets unchanged.
      expect(resolveMotionDuration(tenantOverride, "short")).toBe(200);
    });

    test("unknown duration key falls back to 'short' duration", () => {
      // Cast through unknown to simulate a runtime caller passing a stale key.
      const sneaky = "ridiculous" as unknown as "short";
      expect(resolveMotionDuration(STATIC_MOTION_TOKEN, sneaky)).toBe(200);
    });
  });

  describe("resolveMotionDuration (reduce-motion behavior)", () => {
    test("'disable_loops' + prefersReducedMotion=true → loop-relevant key (micro) collapses to 0", () => {
      expect(
        resolveMotionDuration(STATIC_MOTION_TOKEN, "micro", true),
      ).toBe(0);
    });

    test("'disable_loops' + prefersReducedMotion=true → non-loop key (medium) is unaffected", () => {
      expect(
        resolveMotionDuration(STATIC_MOTION_TOKEN, "medium", true),
      ).toBe(320);
      expect(
        resolveMotionDuration(STATIC_MOTION_TOKEN, "long", true),
      ).toBe(480);
      expect(
        resolveMotionDuration(STATIC_MOTION_TOKEN, "hero", true),
      ).toBe(640);
    });

    test("'disable_loops' + prefersReducedMotion=false → returns policy duration unchanged", () => {
      expect(
        resolveMotionDuration(STATIC_MOTION_TOKEN, "micro", false),
      ).toBe(120);
      expect(
        resolveMotionDuration(STATIC_MOTION_TOKEN, "micro"),
      ).toBe(120); // default flag = false
    });

    test("'respect' + prefersReducedMotion=true → returns policy duration unchanged (consumer decides)", () => {
      const respect: MotionTokenPolicyValue = {
        ...STATIC_MOTION_TOKEN,
        reduce_motion_strategy: "respect",
      };
      expect(resolveMotionDuration(respect, "micro", true)).toBe(120);
      expect(resolveMotionDuration(respect, "medium", true)).toBe(320);
    });

    test("'ignore' + prefersReducedMotion=true → never collapses", () => {
      const ignore: MotionTokenPolicyValue = {
        ...STATIC_MOTION_TOKEN,
        reduce_motion_strategy: "ignore",
      };
      expect(resolveMotionDuration(ignore, "micro", true)).toBe(120);
      expect(resolveMotionDuration(ignore, "instant", true)).toBe(0);
    });
  });

  describe("resolveMotionEasing", () => {
    test("returns the policy easing for each named curve", () => {
      expect(resolveMotionEasing(STATIC_MOTION_TOKEN, "linear")).toBe("linear");
      expect(resolveMotionEasing(STATIC_MOTION_TOKEN, "standard")).toBe(
        "cubic-bezier(0.2,0,0,1)",
      );
      expect(resolveMotionEasing(STATIC_MOTION_TOKEN, "decelerate")).toBe(
        "cubic-bezier(0,0,0,1)",
      );
      expect(resolveMotionEasing(STATIC_MOTION_TOKEN, "accelerate")).toBe(
        "cubic-bezier(0.3,0,1,1)",
      );
      expect(resolveMotionEasing(STATIC_MOTION_TOKEN, "emphasis")).toBe(
        "cubic-bezier(0.2,0,0,1)",
      );
      expect(resolveMotionEasing(STATIC_MOTION_TOKEN, "expressive")).toBe(
        "cubic-bezier(0.34,1.56,0.64,1)",
      );
    });

    test("unknown easing key falls back to 'standard'", () => {
      const sneaky = "swoosh" as unknown as "standard";
      expect(resolveMotionEasing(STATIC_MOTION_TOKEN, sneaky)).toBe(
        "cubic-bezier(0.2,0,0,1)",
      );
    });

    test("respects per-tenant override (custom expressive curve)", () => {
      const tenantOverride: MotionTokenPolicyValue = {
        ...STATIC_MOTION_TOKEN,
        easing: {
          ...STATIC_MOTION_TOKEN.easing,
          expressive: "cubic-bezier(0.5,1.5,0.5,1)",
        },
      };
      expect(resolveMotionEasing(tenantOverride, "expressive")).toBe(
        "cubic-bezier(0.5,1.5,0.5,1)",
      );
      // Other curves unchanged.
      expect(resolveMotionEasing(tenantOverride, "standard")).toBe(
        "cubic-bezier(0.2,0,0,1)",
      );
    });
  });

  describe("normalizeMotionTokenPolicy", () => {
    test("returns STATIC_MOTION_TOKEN for null / undefined / non-object", () => {
      expect(normalizeMotionTokenPolicy(null)).toEqual(STATIC_MOTION_TOKEN);
      expect(normalizeMotionTokenPolicy(undefined)).toEqual(STATIC_MOTION_TOKEN);
      expect(normalizeMotionTokenPolicy("string")).toEqual(STATIC_MOTION_TOKEN);
      expect(normalizeMotionTokenPolicy(123)).toEqual(STATIC_MOTION_TOKEN);
      expect(normalizeMotionTokenPolicy([])).toEqual(STATIC_MOTION_TOKEN);
    });

    test("preserves a fully-valid body verbatim", () => {
      const body = {
        version: 1,
        duration: { instant: 0, micro: 100, short: 180, medium: 280, long: 420, hero: 600 },
        easing: {
          linear: "linear",
          standard: "cubic-bezier(0.4,0,0.2,1)",
          decelerate: "cubic-bezier(0,0,0.2,1)",
          accelerate: "cubic-bezier(0.4,0,1,1)",
          emphasis: "cubic-bezier(0.2,0,0,1)",
          expressive: "cubic-bezier(0.34,1.56,0.64,1)",
        },
        reduce_motion_strategy: "respect",
      };
      const result = normalizeMotionTokenPolicy(body);
      expect(result.version).toBe(1);
      expect(result.duration.medium).toBe(280);
      expect(result.easing.standard).toBe("cubic-bezier(0.4,0,0.2,1)");
      expect(result.reduce_motion_strategy).toBe("respect");
    });

    test("falls back per-slot for missing/malformed duration buckets", () => {
      const result = normalizeMotionTokenPolicy({
        version: 1,
        duration: { micro: 100, short: "fast", medium: -50 }, // short is wrong type, medium is negative
        easing: STATIC_MOTION_TOKEN.easing,
        reduce_motion_strategy: "disable_loops",
      });
      expect(result.duration.micro).toBe(100); // valid override
      expect(result.duration.short).toBe(STATIC_MOTION_TOKEN.duration.short); // fallback (wrong type)
      expect(result.duration.medium).toBe(0); // clamped (negative -> 0)
      expect(result.duration.long).toBe(STATIC_MOTION_TOKEN.duration.long); // missing key -> fallback
      expect(result.duration.hero).toBe(STATIC_MOTION_TOKEN.duration.hero); // missing key -> fallback
      expect(result.duration.instant).toBe(STATIC_MOTION_TOKEN.duration.instant);
    });

    test("falls back per-slot for missing/malformed easing curves", () => {
      const result = normalizeMotionTokenPolicy({
        version: 1,
        duration: STATIC_MOTION_TOKEN.duration,
        easing: { standard: "cubic-bezier(0.5,0,0,1)", emphasis: 42 }, // emphasis is wrong type
        reduce_motion_strategy: "disable_loops",
      });
      expect(result.easing.standard).toBe("cubic-bezier(0.5,0,0,1)");
      expect(result.easing.emphasis).toBe(STATIC_MOTION_TOKEN.easing.emphasis);
      expect(result.easing.linear).toBe(STATIC_MOTION_TOKEN.easing.linear);
      expect(result.easing.decelerate).toBe(STATIC_MOTION_TOKEN.easing.decelerate);
      expect(result.easing.accelerate).toBe(STATIC_MOTION_TOKEN.easing.accelerate);
      expect(result.easing.expressive).toBe(STATIC_MOTION_TOKEN.easing.expressive);
    });

    test("coerces invalid reduce_motion_strategy to 'disable_loops'", () => {
      const result = normalizeMotionTokenPolicy({
        version: 1,
        duration: STATIC_MOTION_TOKEN.duration,
        easing: STATIC_MOTION_TOKEN.easing,
        reduce_motion_strategy: "annoy_user",
      });
      expect(result.reduce_motion_strategy).toBe("disable_loops");
    });

    test("uses default version=1 when version field is missing or invalid", () => {
      const result = normalizeMotionTokenPolicy({
        duration: STATIC_MOTION_TOKEN.duration,
        easing: STATIC_MOTION_TOKEN.easing,
        reduce_motion_strategy: "respect",
      });
      expect(result.version).toBe(1);

      const result2 = normalizeMotionTokenPolicy({
        version: "two",
        duration: STATIC_MOTION_TOKEN.duration,
        easing: STATIC_MOTION_TOKEN.easing,
        reduce_motion_strategy: "respect",
      });
      expect(result2.version).toBe(1);
    });

    test("normalized output is fully usable by resolveMotionDuration / resolveMotionEasing", () => {
      const policy = normalizeMotionTokenPolicy({
        version: 1,
        duration: { micro: 80 }, // partial; rest fall back
        easing: { standard: "cubic-bezier(0.1,0,0.1,1)" },
        reduce_motion_strategy: "disable_loops",
      });
      expect(resolveMotionDuration(policy, "micro")).toBe(80);
      expect(resolveMotionDuration(policy, "medium")).toBe(
        STATIC_MOTION_TOKEN.duration.medium,
      );
      expect(resolveMotionEasing(policy, "standard")).toBe(
        "cubic-bezier(0.1,0,0.1,1)",
      );
      expect(resolveMotionEasing(policy, "expressive")).toBe(
        STATIC_MOTION_TOKEN.easing.expressive,
      );
      // disable_loops still folds reduce-motion preference for micro.
      expect(resolveMotionDuration(policy, "micro", true)).toBe(0);
    });
  });
});
