import type { MobileDriverSafetyPolicy } from "./mobile-shell-policy";

export type DrivingSafetyState = {
  speedKph: number;
  thresholdKph: number;
  locked: boolean;
  allowedNavKeysWhileMoving: string[];
  fallbackNavKey: string;
};

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function clampMin(value: number, min: number): number {
  if (value < min) return min;
  return value;
}

function toNavKey(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeSpeedKph(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed < 0) return null;
  return Math.round(parsed * 10) / 10;
}

export function speedMpsToKph(value: unknown): number {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed <= 0) return 0;
  return Math.round(parsed * 3.6 * 10) / 10;
}

export function computeDrivingSafetyState(params: {
  policy: MobileDriverSafetyPolicy;
  speedKph: number | null | undefined;
}): DrivingSafetyState {
  const rawAllowed = Array.isArray(params.policy.allowedNavKeysWhileMoving)
    ? params.policy.allowedNavKeysWhileMoving
    : [];
  const allowedNavKeysWhileMoving = Array.from(
    new Set(
      rawAllowed
        .map((entry) => (typeof entry === "string" ? toNavKey(entry) : ""))
        .filter((entry) => entry.length > 0)
    )
  );
  const fallbackNavKey = allowedNavKeysWhileMoving[0] ?? "route";
  const thresholdKph = clampMin(params.policy.lockThresholdKph, 0);
  const speedKph = normalizeSpeedKph(params.speedKph) ?? 0;
  const locked =
    params.policy.enabled === true &&
    params.policy.lockWhenMoving === true &&
    speedKph >= thresholdKph;

  return {
    speedKph,
    thresholdKph,
    locked,
    allowedNavKeysWhileMoving,
    fallbackNavKey,
  };
}

export function canNavigateWhileMoving(
  state: DrivingSafetyState,
  navKey: string | null | undefined
): boolean {
  if (!state.locked) return true;
  if (!navKey) return false;
  const normalized = toNavKey(navKey);
  return state.allowedNavKeysWhileMoving.includes(normalized);
}
