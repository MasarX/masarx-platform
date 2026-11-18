// Verify opt-in high contrast and the precedence of the manual override.

import {
  STATIC_SUNLIGHT_MODE,
  normalizeSunlightModePolicy,
  resolveSunlightActive,
  type SunlightModePolicyValue,
} from "../../apps/fieldops/src/sunlight-mode-policy";

function fullyEnabledPolicy(threshold: number): SunlightModePolicyValue {
  return {
    version: 1,
    enabled: true,
    auto_switch: {
      enabled: true,
      ambient_lux_threshold: threshold,
      user_override_persists_minutes: 30,
    },
    user_toggle_visible: true,
  };
}

describe("sunlight_mode_policy helpers", () => {
  describe("STATIC_SUNLIGHT_MODE (mirror of migration global default)", () => {
    test("version is 1", () => {
      expect(STATIC_SUNLIGHT_MODE.version).toBe(1);
    });

    test("enabled is false (variant is opt-in)", () => {
      expect(STATIC_SUNLIGHT_MODE.enabled).toBe(false);
    });

    test("auto_switch.enabled is false (auto-switch is opt-in)", () => {
      expect(STATIC_SUNLIGHT_MODE.auto_switch.enabled).toBe(false);
    });

    test("auto_switch.ambient_lux_threshold is 50000 (GCC outdoor noon margin)", () => {
      expect(STATIC_SUNLIGHT_MODE.auto_switch.ambient_lux_threshold).toBe(50000);
    });

    test("auto_switch.user_override_persists_minutes is 30", () => {
      expect(STATIC_SUNLIGHT_MODE.auto_switch.user_override_persists_minutes).toBe(30);
    });

    test("user_toggle_visible is true (manual toggle exposed by default)", () => {
      expect(STATIC_SUNLIGHT_MODE.user_toggle_visible).toBe(true);
    });
  });

  describe("normalizeSunlightModePolicy (defensive parse)", () => {
    test("returns STATIC seed for null / undefined / non-object inputs", () => {
      expect(normalizeSunlightModePolicy(null)).toEqual(STATIC_SUNLIGHT_MODE);
      expect(normalizeSunlightModePolicy(undefined)).toEqual(STATIC_SUNLIGHT_MODE);
      expect(normalizeSunlightModePolicy("string")).toEqual(STATIC_SUNLIGHT_MODE);
      expect(normalizeSunlightModePolicy(42)).toEqual(STATIC_SUNLIGHT_MODE);
    });

    test("preserves a fully-valid policy body unchanged", () => {
      const input: SunlightModePolicyValue = {
        version: 1,
        enabled: true,
        auto_switch: {
          enabled: true,
          ambient_lux_threshold: 75000,
          user_override_persists_minutes: 60,
        },
        user_toggle_visible: false,
      };
      const result = normalizeSunlightModePolicy(input);
      expect(result.version).toBe(1);
      expect(result.enabled).toBe(true);
      expect(result.auto_switch.enabled).toBe(true);
      expect(result.auto_switch.ambient_lux_threshold).toBe(75000);
      expect(result.auto_switch.user_override_persists_minutes).toBe(60);
      expect(result.user_toggle_visible).toBe(false);
    });

    test("malformed enabled / user_toggle_visible fall back to STATIC defaults", () => {
      const result = normalizeSunlightModePolicy({
        version: 1,
        enabled: "yes",
        auto_switch: {
          enabled: 1,
          ambient_lux_threshold: 50000,
          user_override_persists_minutes: 30,
        },
        user_toggle_visible: null,
      });
      expect(result.enabled).toBe(false);
      expect(result.auto_switch.enabled).toBe(false);
      expect(result.user_toggle_visible).toBe(true);
    });

    test("non-finite or negative thresholds clamp to safe defaults", () => {
      const result = normalizeSunlightModePolicy({
        version: 1,
        enabled: true,
        auto_switch: {
          enabled: true,
          ambient_lux_threshold: -100,
          user_override_persists_minutes: NaN,
        },
        user_toggle_visible: true,
      });
      // -100 → clamped to 0 (max with 0)
      expect(result.auto_switch.ambient_lux_threshold).toBe(0);
      // NaN → fallback to STATIC default 30
      expect(result.auto_switch.user_override_persists_minutes).toBe(30);
    });

    test("missing auto_switch falls back to STATIC seed sub-object", () => {
      const result = normalizeSunlightModePolicy({
        version: 1,
        enabled: true,
        user_toggle_visible: true,
      });
      expect(result.auto_switch).toEqual(STATIC_SUNLIGHT_MODE.auto_switch);
    });

    test("uses default version=1 when version is missing or invalid", () => {
      expect(
        normalizeSunlightModePolicy({
          enabled: false,
          auto_switch: STATIC_SUNLIGHT_MODE.auto_switch,
          user_toggle_visible: true,
        }).version,
      ).toBe(1);
      expect(
        normalizeSunlightModePolicy({
          version: "not-a-number",
          enabled: false,
          auto_switch: STATIC_SUNLIGHT_MODE.auto_switch,
          user_toggle_visible: true,
        }).version,
      ).toBe(1);
    });
  });

  describe("resolveSunlightActive (decision matrix)", () => {
    test("user toggle ALWAYS wins, even when policy is disabled", () => {
      // Static (disabled) policy + user toggle on → still active.
      expect(resolveSunlightActive(STATIC_SUNLIGHT_MODE, null, true)).toBe(true);
      expect(resolveSunlightActive(STATIC_SUNLIGHT_MODE, 100, true)).toBe(true);
      expect(resolveSunlightActive(STATIC_SUNLIGHT_MODE, 1_000_000, true)).toBe(true);
    });

    test("user toggle wins even when ambient lux is null", () => {
      const policy = fullyEnabledPolicy(50000);
      expect(resolveSunlightActive(policy, null, true)).toBe(true);
    });

    test("disabled master switch returns false (without user toggle)", () => {
      // Static seed: enabled=false. Even at extreme lux readings, no toggle → false.
      expect(resolveSunlightActive(STATIC_SUNLIGHT_MODE, 200_000, false)).toBe(false);
    });

    test("disabled auto_switch returns false (without user toggle)", () => {
      const policy: SunlightModePolicyValue = {
        ...STATIC_SUNLIGHT_MODE,
        enabled: true,
        auto_switch: { ...STATIC_SUNLIGHT_MODE.auto_switch, enabled: false },
      };
      expect(resolveSunlightActive(policy, 200_000, false)).toBe(false);
    });

    test("null ambient lux returns false when no user toggle", () => {
      const policy = fullyEnabledPolicy(50000);
      expect(resolveSunlightActive(policy, null, false)).toBe(false);
    });

    test("non-finite ambient lux (NaN, Infinity) returns false", () => {
      const policy = fullyEnabledPolicy(50000);
      expect(resolveSunlightActive(policy, Number.NaN, false)).toBe(false);
      expect(resolveSunlightActive(policy, Number.POSITIVE_INFINITY, false)).toBe(false);
      expect(resolveSunlightActive(policy, Number.NEGATIVE_INFINITY, false)).toBe(false);
    });

    test("ambient lux >= threshold returns true (auto-switch fires)", () => {
      const policy = fullyEnabledPolicy(50000);
      expect(resolveSunlightActive(policy, 50000, false)).toBe(true);
      expect(resolveSunlightActive(policy, 75000, false)).toBe(true);
      expect(resolveSunlightActive(policy, 120000, false)).toBe(true); // GCC noon
    });

    test("ambient lux < threshold returns false (indoor / overcast)", () => {
      const policy = fullyEnabledPolicy(50000);
      expect(resolveSunlightActive(policy, 49999, false)).toBe(false);
      expect(resolveSunlightActive(policy, 10000, false)).toBe(false); // overcast outdoor
      expect(resolveSunlightActive(policy, 500, false)).toBe(false);   // indoor
      expect(resolveSunlightActive(policy, 0, false)).toBe(false);     // dark
    });

    test("ambient lux exactly at threshold returns true (>= boundary)", () => {
      const policy = fullyEnabledPolicy(50000);
      expect(resolveSunlightActive(policy, 50000, false)).toBe(true);
    });

    test("threshold of 0 means any non-null reading auto-activates (when both switches on)", () => {
      const policy = fullyEnabledPolicy(0);
      expect(resolveSunlightActive(policy, 0, false)).toBe(true);
      expect(resolveSunlightActive(policy, 1, false)).toBe(true);
    });
  });
});
