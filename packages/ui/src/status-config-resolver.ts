import "server-only";

import type { BadgeTone } from "./badge";
import type { StatusToneMap } from "./status-icon";
import type { ShipmentLifecycleStep } from "./shipment-status-stepper";
import type { REPORTING_DONUT_KEYS } from "./status-defaults";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/**
 * Row shape returned by `list_lookup_values_v1`.
 * Callers pass a function matching this contract so the resolver
 * stays decoupled from the transport (RPC, REST, direct SQL).
 */
export type LookupValueRow = {
  value: string;
  label: string;
  description?: string | null;
  sort_order?: number | null;
  is_default?: boolean | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Fully-resolved status configuration derived from `lookup_values`
 * metadata. Computed server-side and passed to client components
 * via props so the UI stays zero-hardcoded.
 */
export type StatusConfig = {
  /** status value -> badge tone (drives StatusIcon, Badge, etc.) */
  toneMap: StatusToneMap;
  /** Ordered lifecycle steps for ShipmentStatusStepper */
  lifecycleSteps: ShipmentLifecycleStep[];
  /** Status aliases (e.g. "created" -> "pending") */
  aliases: Record<string, string>;
  /** Terminal failure statuses */
  failureStatuses: string[];
  /** KPI metric keys for DashboardMetricsBuilder */
  kpiKeys: string[];
  /** Donut segment definitions for DashboardMetricsBuilder */
  donutKeys: typeof REPORTING_DONUT_KEYS;
};

/* ------------------------------------------------------------------ */
/*  Tone resolution helpers                                            */
/* ------------------------------------------------------------------ */

const VALID_TONES = new Set<BadgeTone>([
  "success",
  "warning",
  "danger",
  "info",
  "neutral",
  "accent",
]);

function asBadgeTone(value: unknown): BadgeTone | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return VALID_TONES.has(normalized as BadgeTone)
    ? (normalized as BadgeTone)
    : null;
}

/* ------------------------------------------------------------------ */
/*  Resolver                                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve status-to-tone mappings and component configuration from
 * `lookup_values` metadata.
 *
 * The `listLookupValues` callback fetches rows for a given category
 * via the existing `list_lookup_values_v1` RPC. This keeps the
 * resolver independent of transport.
 *
 * Metadata fields consumed per lookup_value row:
 * - `tone` (BadgeTone)           – drives toneMap
 * - `is_lifecycle_step` (bool)   – includes in stepper steps
 * - `alias_for` (string)         – maps to canonical lifecycle key
 * - `is_failure` (bool)          – terminal failure status
 * - `is_kpi` (bool)              – include in KPI card keys
 * - `is_donut` (bool)            – include in donut segments
 * - `donut_label_key` (string)   – i18n key for donut label
 */
export async function resolveStatusConfig(
  listLookupValues: (category: string) => Promise<LookupValueRow[]>,
): Promise<StatusConfig> {
  let rows: LookupValueRow[];
  try {
    rows = (await listLookupValues("shipment_status")) ?? [];
  } catch {
    rows = [];
  }

  const toneMap: StatusToneMap = {};
  const lifecycleSteps: ShipmentLifecycleStep[] = [];
  const aliases: Record<string, string> = {};
  const failureStatuses: string[] = [];
  const kpiKeys: string[] = [];
  const donutKeys: typeof REPORTING_DONUT_KEYS = [];

  for (const row of rows) {
    const key = row.value.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!key || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const meta = row.metadata ?? {};

    // Tone map
    const tone = asBadgeTone(meta.tone);
    if (tone) {
      toneMap[key] = tone;
    }

    // Lifecycle steps (ordered by sort_order from the query)
    if (meta.is_lifecycle_step === true) {
      lifecycleSteps.push({ key, label: row.label });
    }

    // Aliases
    if (typeof meta.alias_for === "string" && meta.alias_for.trim()) {
      aliases[key] = meta.alias_for.trim();
    }

    // Failure statuses
    if (meta.is_failure === true) {
      failureStatuses.push(key);
    }

    // KPI keys
    if (meta.is_kpi === true) {
      kpiKeys.push(key);
    }

    // Donut keys
    if (meta.is_donut === true) {
      const labelKey =
        typeof meta.donut_label_key === "string" && meta.donut_label_key.trim()
          ? meta.donut_label_key.trim()
          : `metricsStatus${key.charAt(0).toUpperCase()}${key.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
      donutKeys.push({ key, labelKey });
    }
  }

  return {
    toneMap,
    lifecycleSteps,
    aliases,
    failureStatuses,
    kpiKeys,
    donutKeys,
  };
}

/**
 * Check whether a resolved config has meaningful data.
 * When lookup_values metadata has not been populated yet, callers
 * should fall back to built-in defaults for backward compatibility.
 */
export function isStatusConfigPopulated(config: StatusConfig): boolean {
  return Object.keys(config.toneMap).length > 0;
}
