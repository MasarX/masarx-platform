import type { MobileV2DamageSeverity } from "./mobile-v2-sheet-damage-hold";
import { EN_STRINGS, type FieldOpsStrings } from "./i18n";

export interface MobileV2DamageHoldPolicy {
  readonly version: number;
  readonly severities: ReadonlyArray<MobileV2DamageSeverity>;
}

export const MOBILE_V2_DAMAGE_HOLD_DEFAULT_CATEGORIES: ReadonlyArray<MobileV2DamageSeverity> =
  Object.freeze([
    Object.freeze({ id: "crushed", label: EN_STRINGS.damageHold.severity.crushed, color: "danger" as const }),
    Object.freeze({ id: "wet", label: EN_STRINGS.damageHold.severity.wet, color: "danger" as const }),
    Object.freeze({ id: "tampered", label: EN_STRINGS.damageHold.severity.tampered, color: "danger" as const }),
    Object.freeze({ id: "wrong-label", label: EN_STRINGS.damageHold.severity["wrong-label"], color: "warning" as const }),
    Object.freeze({ id: "missing-barcode", label: EN_STRINGS.damageHold.severity["missing-barcode"], color: "warning" as const }),
  ]);

export const MOBILE_V2_DAMAGE_HOLD_DEFAULT_POLICY: MobileV2DamageHoldPolicy =
  Object.freeze({
    version: 1,
    severities: MOBILE_V2_DAMAGE_HOLD_DEFAULT_CATEGORIES,
  });

/**
 * Display label for a damage category. The built-in default label (English
 * catalog text) is shown in the active locale; any other label came from the
 * policy row and is shown as-is.
 */
export function damageSeverityLabel(
  severity: MobileV2DamageSeverity,
  strings: FieldOpsStrings = EN_STRINGS,
): string {
  const defaults: Readonly<Record<string, string>> = EN_STRINGS.damageHold.severity;
  const localized: Readonly<Record<string, string>> = strings.damageHold.severity;
  return defaults[severity.id] === severity.label ? localized[severity.id] ?? severity.label : severity.label;
}

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
