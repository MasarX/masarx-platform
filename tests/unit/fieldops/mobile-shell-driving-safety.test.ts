import { DEFAULT_MOBILE_DRIVER_SAFETY_POLICY } from "../../../apps/fieldops/src/mobile-shell-policy";
import {
  canNavigateWhileMoving,
  computeDrivingSafetyState,
  normalizeSpeedKph,
  speedMpsToKph,
} from "../../../apps/fieldops/src/mobile-shell-driving-safety";

describe("mobile shell driving safety helpers", () => {
  test("speedMpsToKph converts finite values", () => {
    expect(speedMpsToKph(10)).toBe(36);
    expect(speedMpsToKph(0)).toBe(0);
    expect(speedMpsToKph(-3)).toBe(0);
    expect(speedMpsToKph("10")).toBe(0);
  });

  test("normalizeSpeedKph keeps positive finite values", () => {
    expect(normalizeSpeedKph(12.345)).toBe(12.3);
    expect(normalizeSpeedKph(0)).toBe(0);
    expect(normalizeSpeedKph(-1)).toBeNull();
    expect(normalizeSpeedKph("12")).toBeNull();
  });

  test("computeDrivingSafetyState locks only when policy requires", () => {
    const state = computeDrivingSafetyState({
      policy: {
        ...DEFAULT_MOBILE_DRIVER_SAFETY_POLICY,
        enabled: true,
        lockWhenMoving: true,
        lockThresholdKph: 8,
        allowedNavKeysWhileMoving: ["route", "more"],
      },
      speedKph: 12,
    });

    expect(state.locked).toBe(true);
    expect(state.allowedNavKeysWhileMoving).toEqual(["route", "more"]);
    expect(state.fallbackNavKey).toBe("route");
  });

  test("canNavigateWhileMoving enforces allowed nav keys when locked", () => {
    const state = computeDrivingSafetyState({
      policy: {
        ...DEFAULT_MOBILE_DRIVER_SAFETY_POLICY,
        enabled: true,
        lockWhenMoving: true,
        lockThresholdKph: 5,
        allowedNavKeysWhileMoving: ["route"],
      },
      speedKph: 20,
    });

    expect(canNavigateWhileMoving(state, "route")).toBe(true);
    expect(canNavigateWhileMoving(state, "scan")).toBe(false);
    expect(canNavigateWhileMoving(state, null)).toBe(false);
  });

  test("canNavigateWhileMoving allows all nav when unlocked", () => {
    const state = computeDrivingSafetyState({
      policy: {
        ...DEFAULT_MOBILE_DRIVER_SAFETY_POLICY,
        enabled: true,
        lockWhenMoving: true,
      },
      speedKph: 0,
    });

    expect(state.locked).toBe(false);
    expect(canNavigateWhileMoving(state, "scan")).toBe(true);
  });
});
