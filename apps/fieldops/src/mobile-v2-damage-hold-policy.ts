import type { MobileV2DamageSeverity } from "./mobile-v2-sheet-damage-hold";

export interface MobileV2DamageHoldPolicy {
  readonly version: number;
  readonly severities: ReadonlyArray<MobileV2DamageSeverity>;
}

export const MOBILE_V2_DAMAGE_HOLD_DEFAULT_CATEGORIES: ReadonlyArray<MobileV2DamageSeverity> =
  Object.freeze([
    Object.freeze({ id: "crushed", label: "Crushed", color: "danger" as const }),
    Object.freeze({ id: "wet", label: "Wet / leaking", color: "danger" as const }),
    Object.freeze({ id: "tampered", label: "Open / tampered", color: "danger" as const }),
    Object.freeze({ id: "wrong-label", label: "Wrong label", color: "warning" as const }),
    Object.freeze({ id: "missing-barcode", label: "Missing barcode", color: "warning" as const }),
  ]);

export const MOBILE_V2_DAMAGE_HOLD_DEFAULT_POLICY: MobileV2DamageHoldPolicy =
  Object.freeze({
    version: 1,
    severities: MOBILE_V2_DAMAGE_HOLD_DEFAULT_CATEGORIES,
  });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseSeverity(raw: unknown): MobileV2DamageSeverity | null {
  const row = asRecord(raw);
  if (row === null) return null;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const label = typeof row.label === "string" ? row.label.trim() : "";
  const color = row.color;
  if (id === "" || label === "") return null;
  if (color !== "danger" && color !== "warning" && color !== "info") return null;
  return Object.freeze({ id, label, color });
}

export function parseMobileV2DamageHoldPolicy(value: unknown): MobileV2DamageHoldPolicy {
  const row = asRecord(value);
  if (row === null) return MOBILE_V2_DAMAGE_HOLD_DEFAULT_POLICY;
  const rawSeverities = Array.isArray(row.severities) ? row.severities : [];
  const severities = rawSeverities
    .map(parseSeverity)
    .filter((entry): entry is MobileV2DamageSeverity => entry !== null);
  if (severities.length === 0) return MOBILE_V2_DAMAGE_HOLD_DEFAULT_POLICY;
  const version = typeof row.version === "number" && Number.isFinite(row.version)
    ? Math.max(1, Math.round(row.version))
    : 1;
  return Object.freeze({
    version,
    severities: Object.freeze(severities),
  });
}
