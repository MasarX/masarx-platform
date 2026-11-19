// Mobile V2 incident-type registry — types + defensive parser for the
// `mobile_incident_policy.types[]` payload resolved through the settings
// ladder.
//
// Engineering audit B1 / I2: the incident sheet's type registry was
// only ever a PREVIEW/DEV fixture and the `submit_fieldops_incident_v1`
// write RPC had zero callers. This module is the RN-free home of the
// `MobileV2IncidentType` contract so both the RPC hooks layer
// (`useFieldopsIncidentTypesRpc`) and the sheet component
// (`mobile-v2-sheet-incident.tsx`) share one definition, and the
// resolver payload is shape-validated before it reaches the UI.
//
// React-free so the jest unit runner covers the parser directly.

import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import { MOBILE_V2_ICON_NAMES } from "./mobile-v2-icon-specs";

export type MobileV2IncidentSeverity = "high" | "med" | "low";

/**
 * Required artefacts a driver must capture / trigger before submitting
 * an incident report. Resolved from `mobile_incident_policy.types[].needs`.
 * `photo` / `statement` gate the submit CTA; `geo` / `call_112` /
 * `call_999` are dispatcher-side markers and do not gate.
 */
export type MobileV2IncidentNeed =
  | "photo"
  | "geo"
  | "statement"
  | "call_112"
  | "call_999";

export interface MobileV2IncidentType {
  readonly id: string;
  readonly label: string;
  readonly icon: MobileV2IconName;
  readonly severity: MobileV2IncidentSeverity;
  readonly needs: ReadonlyArray<MobileV2IncidentNeed>;
}

const ICON_NAME_SET = new Set<string>(MOBILE_V2_ICON_NAMES as ReadonlyArray<string>);
const SEVERITY_SET = new Set<string>(["high", "med", "low"]);
const NEED_SET = new Set<string>([
  "photo",
  "geo",
  "statement",
  "call_112",
  "call_999",
]);

function parseString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Parse a single incident-type row. Returns null when required fields
 * are missing / wrong-typed so a malformed policy row is dropped rather
 * than crashing the sheet. `icon` falls back to `alert` (always present
 * in the catalog) when the policy supplies an unknown glyph; severity
 * falls back to `med`.
 */
export function parseMobileV2IncidentType(value: unknown): MobileV2IncidentType | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = parseString(row.id);
  const label = parseString(row.label);
  if (id === null || label === null) return null;
  const iconRaw = parseString(row.icon);
  const icon: MobileV2IconName =
    iconRaw !== null && ICON_NAME_SET.has(iconRaw)
      ? (iconRaw as MobileV2IconName)
      : "alert";
  const severityRaw = parseString(row.severity);
  const severity: MobileV2IncidentSeverity =
    severityRaw !== null && SEVERITY_SET.has(severityRaw)
      ? (severityRaw as MobileV2IncidentSeverity)
      : "med";
  const needs: MobileV2IncidentNeed[] = [];
  if (Array.isArray(row.needs)) {
    for (const n of row.needs) {
      if (typeof n === "string" && NEED_SET.has(n) && !needs.includes(n as MobileV2IncidentNeed)) {
        needs.push(n as MobileV2IncidentNeed);
      }
    }
  }
  return Object.freeze({
    id,
    label,
    icon,
    severity,
    needs: Object.freeze(needs),
  });
}

/**
 * Parse the `mobile_incident_policy` resolver payload into a typed
 * incident-type list. Accepts either a bare array of rows or an object
 * envelope carrying a `types` array (the policy `value` shape). Returns
 * an empty array when the payload is malformed — callers fall back to
 * the fixture in that case.
 */
export function parseMobileV2IncidentTypeList(
  value: unknown,
): ReadonlyArray<MobileV2IncidentType> {
  const rows = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && Array.isArray((value as Record<string, unknown>).types)
      ? ((value as Record<string, unknown>).types as ReadonlyArray<unknown>)
      : null;
  if (rows === null) return Object.freeze([]);
  const out: MobileV2IncidentType[] = [];
  for (const r of rows) {
    const parsed = parseMobileV2IncidentType(r);
    if (parsed !== null) out.push(parsed);
  }
  return Object.freeze(out);
}
