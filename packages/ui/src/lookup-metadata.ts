import "server-only";

/**
 * Helpers for resolving lookup_values metadata at the page level.
 *
 * Pages that previously used hardcoded switch/constant patterns
 * (dispatch, COD, integration-health) now call these helpers to
 * derive behaviour from DB-stored metadata, with compile-time
 * fallbacks for backward compatibility.
 */

import type { LookupValueRow } from "./status-config-resolver";

/* ------------------------------------------------------------------ */
/*  Generic helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Minimal client interface for fetching lookup values.
 */
export type LookupClient = {
  listLookupValues: (category: string) => Promise<LookupValueRow[]>;
};

/**
 * Fetch lookup values for a category and return rows whose metadata
 * contains the given field. Falls back to an empty array on error.
 */
export async function fetchLookupWithMeta(
  client: LookupClient,
  category: string,
  metadataField: string,
): Promise<LookupValueRow[]> {
  try {
    const rows = (await client.listLookupValues(category)) ?? [];
    return rows.filter(
      (r) => r.metadata != null && metadataField in r.metadata,
    );
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  route_run_status: is_terminal                                      */
/* ------------------------------------------------------------------ */

/** Hardcoded fallback: active (non-terminal) route run statuses. */
const FALLBACK_ACTIVE_ROUTE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "planned",
  "in_progress",
]);

/**
 * Resolve the set of active (non-terminal) route run statuses.
 *
 * Reads `is_terminal` metadata from `route_run_status` lookup_values.
 * Falls back to compile-time defaults when metadata is not populated.
 */
export async function resolveActiveRouteRunStatuses(
  client: LookupClient,
): Promise<ReadonlySet<string>> {
  try {
    const rows = (await client.listLookupValues("route_run_status")) ?? [];
    const withMeta = rows.filter(
      (r) => r.metadata != null && "is_terminal" in r.metadata,
    );
    if (withMeta.length === 0) return FALLBACK_ACTIVE_ROUTE_RUN_STATUSES;
    const active = withMeta
      .filter((r) => r.metadata?.is_terminal !== true)
      .map((r) => r.value);
    return new Set(active);
  } catch {
    return FALLBACK_ACTIVE_ROUTE_RUN_STATUSES;
  }
}

/* ------------------------------------------------------------------ */
/*  shipment_status: delivery_outcome (COD)                            */
/* ------------------------------------------------------------------ */

/** Maps delivery_outcome metadata value to CodEntry status. */
const OUTCOME_TO_COD_STATUS: Record<string, string> = {
  collected: "pending",
  missing: "missing",
};

/**
 * Build a mapping from shipment_status value to COD reconciliation
 * status, driven by `delivery_outcome` metadata.
 *
 * Returns a Map where keys are shipment status values and values are
 * the corresponding COD status strings.
 */
export async function resolveCodStatusMap(
  client: LookupClient,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const rows = (await client.listLookupValues("shipment_status")) ?? [];
    for (const row of rows) {
      const outcome = row.metadata?.delivery_outcome;
      if (typeof outcome === "string" && outcome in OUTCOME_TO_COD_STATUS) {
        map.set(row.value, OUTCOME_TO_COD_STATUS[outcome]!);
      }
    }
  } catch {
    // Fallback handled by caller
  }
  return map;
}

/** Compile-time fallback COD status map (same logic as the old switch). */
export const FALLBACK_COD_STATUS_MAP: ReadonlyMap<string, string> = new Map([
  ["delivered", "pending"],
  ["delivery_failed", "missing"],
]);

/* ------------------------------------------------------------------ */
/*  provider_type: integration_surface                                 */
/* ------------------------------------------------------------------ */

/**
 * Build a mapping from provider_type value to integration surface type,
 * driven by `integration_surface` metadata.
 */
export async function resolveProviderSurfaceMap(
  client: LookupClient,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const rows = (await client.listLookupValues("provider_type")) ?? [];
    for (const row of rows) {
      const surface = row.metadata?.integration_surface;
      if (typeof surface === "string" && surface.trim()) {
        map.set(row.value, surface.trim());
      }
    }
  } catch {
    // Fallback handled by caller
  }
  return map;
}

/** Compile-time fallback provider-type to surface map (same as old switch). */
export const FALLBACK_PROVIDER_SURFACE_MAP: ReadonlyMap<string, string> = new Map([
  ["comms", "api"],
  ["ai", "api"],
  ["sms", "api"],
  ["3pl", "webhook"],
  ["delivery", "webhook"],
  ["http", "edge_function"],
  ["routing", "edge_function"],
  ["payment", "edge_function"],
]);

/** Default surface when provider_type has no mapping. */
export const DEFAULT_INTEGRATION_SURFACE = "edge_function";

/* ------------------------------------------------------------------ */
/*  component_health_status: health tone mapping                       */
/* ------------------------------------------------------------------ */

/** Compile-time fallback: health_status -> IntegrationHealthEntry status. */
const FALLBACK_HEALTH_STATUS_MAP: Record<string, string> = {
  healthy: "healthy",
  degraded: "degraded",
  down: "down",
  unhealthy: "down",
};

/**
 * Resolve a raw health_status string to a normalized status tone.
 *
 * Reads `status_tone` metadata from `component_health_status` lookup_values
 * when available, falling back to compile-time defaults.
 */
export async function resolveHealthStatusTone(
  client: LookupClient,
  healthStatus: string | null | undefined,
): Promise<string> {
  if (!healthStatus) return "degraded";
  try {
    const rows = (await client.listLookupValues("component_health_status")) ?? [];
    const withMeta = rows.filter(
      (r) => r.metadata != null && "status_tone" in r.metadata,
    );
    if (withMeta.length > 0) {
      const match = withMeta.find((r) => r.value === healthStatus);
      if (match && typeof match.metadata?.status_tone === "string") {
        return match.metadata.status_tone;
      }
    }
  } catch {
    // Fall through to compile-time map
  }
  return FALLBACK_HEALTH_STATUS_MAP[healthStatus] ?? "degraded";
}

/**
 * Synchronous fallback for health status mapping when a LookupClient
 * is not available or the caller does not need async resolution.
 */
export function resolveHealthStatusToneSync(
  healthStatus: string | null | undefined,
): string {
  if (!healthStatus) return "degraded";
  return FALLBACK_HEALTH_STATUS_MAP[healthStatus] ?? "degraded";
}
