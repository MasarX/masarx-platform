/**
 * Fallback status configuration constants.
 *
 * Used ONLY when resolveStatusConfig() returns empty (DB metadata not
 * populated). These values MUST match lookup_values rows. This file is
 * the SINGLE fallback location -- no other file should define status
 * constants for tone mapping, lifecycle steps, aliases, or failure sets.
 *
 * @see resolveStatusConfig for the DB-driven path
 * @see supabase/migrations/202604150100_shipment_status_tone_metadata_v1.sql
 */

import type { BadgeTone } from "./badge";


/* ------------------------------------------------------------------ */
/*  V1-a: Status-icon tone keyword arrays                              */
/* ------------------------------------------------------------------ */

/** Status keywords that map to the "success" badge tone. */
export const DEFAULT_SUCCESS_KEYWORDS: readonly string[] = [
  "active", "healthy", "delivered", "completed", "success", "ok",
  "resolved", "approved", "enabled", "done", "verified", "confirmed",
];

/** Status keywords that map to the "warning" badge tone. */
export const DEFAULT_WARNING_KEYWORDS: readonly string[] = [
  "pending", "processing", "scheduled", "planned", "queued",
  "waiting", "in_progress", "draft", "paused",
];

/** Status keywords that map to the "danger" badge tone. */
export const DEFAULT_DANGER_KEYWORDS: readonly string[] = [
  "failed", "error", "cancelled", "rejected", "expired",
  "disabled", "blocked", "critical",
];

/** Status keywords that map to the "info" badge tone. */
export const DEFAULT_INFO_KEYWORDS: readonly string[] = [
  "in_transit", "transit", "shipped", "dispatched", "sent",
  "running", "syncing",
];

/** All keyword arrays grouped by tone for iteration convenience. */
export const STATUS_KEYWORD_GROUPS: ReadonlyArray<{
  tone: BadgeTone;
  keywords: readonly string[];
}> = [
  { tone: "success", keywords: DEFAULT_SUCCESS_KEYWORDS },
  { tone: "danger", keywords: DEFAULT_DANGER_KEYWORDS },
  { tone: "warning", keywords: DEFAULT_WARNING_KEYWORDS },
  { tone: "info", keywords: DEFAULT_INFO_KEYWORDS },
];

/* ------------------------------------------------------------------ */
/*  V1-b: Shipment lifecycle stepper defaults                          */
/* ------------------------------------------------------------------ */

/** i18n key mapping for default shipment lifecycle step labels. */
export const DEFAULT_STEP_I18N_KEYS: Readonly<Record<string, string>> = {
  pending: "steps.pending",
  processing: "steps.processing",
  in_transit: "steps.inTransit",
  out_for_delivery: "steps.outForDelivery",
  delivered: "steps.delivered",
};

/**
 * Default alias mappings for common shipment status variants.
 * Overridden by DB-driven aliases via resolveStatusConfig.
 */
export const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
  created: "pending",
  draft: "pending",
  confirmed: "processing",
  picked_up: "in_transit",
  pickup_complete: "in_transit",
  in_warehouse: "processing",
  dispatched: "in_transit",
  at_hub: "in_transit",
  with_courier: "out_for_delivery",
  delivery_attempted: "out_for_delivery",
  delivery_failed: "out_for_delivery",
  completed: "delivered",
};

/**
 * Default terminal failure statuses that trigger warning state on the stepper.
 * Overridden by DB-driven failure statuses via resolveStatusConfig.
 */
export const DEFAULT_FAILURE_STATUSES: readonly string[] = [
  "delivery_failed",
  "cancelled",
  "returned",
  "lost",
];

/* ------------------------------------------------------------------ */
/*  V1-b2: Individual status key constants (SSOT for fallback refs)    */
/* ------------------------------------------------------------------ */

/**
 * Individual status key constants for use as fallback identifiers
 * across the codebase. Import these instead of using raw string
 * literals so changes propagate from a single location.
 */
export const STATUS_PENDING = "pending" as const;
export const STATUS_DELIVERED = "delivered" as const;
export const STATUS_IN_TRANSIT = "in_transit" as const;
export const STATUS_CREATED = "created" as const;
export const STATUS_OUT_FOR_DELIVERY = "out_for_delivery" as const;
export const STATUS_CANCELLED = "cancelled" as const;
export const STATUS_RETURNED = "returned" as const;

/* ------------------------------------------------------------------ */
/*  V1-c: Dashboard / reporting metric key defaults                    */
/* ------------------------------------------------------------------ */

/** Default KPI resource keys when no DB config is provided. */
export const DEFAULT_KPI_KEYS: readonly string[] = [
  "shipments",
  "in_transit",
  "out_for_delivery",
  "exceptions",
  "delivered",
];

/** Default donut segment definitions when no DB config is provided. */
export const DEFAULT_DONUT_KEYS: ReadonlyArray<{
  key: string;
  labelKey: string;
  color?: string;
}> = [
  { key: "delivered", labelKey: "metricsStatusDelivered" },
  { key: "in_transit", labelKey: "metricsStatusInTransit" },
  { key: "out_for_delivery", labelKey: "metricsStatusOutForDelivery" },
  { key: "exceptions", labelKey: "metricsStatusExceptions" },
  { key: "pending", labelKey: "metricsStatusPending" },
];

/** Default resource keys fetched for reporting analytics (fallback). */
export const DEFAULT_REPORTING_RESOURCES: readonly string[] = [
  "shipments",
  "delivered",
  "in_transit",
  "out_for_delivery",
  "exceptions",
  "pending",
  "cancelled",
  "returned",
];

/**
 * Reporting-specific KPI keys (extends dashboard defaults with
 * delivered and pending as separate cards).
 */
export const REPORTING_KPI_KEYS: readonly string[] = [
  "shipments",
  "in_transit",
  "out_for_delivery",
  "exceptions",
  "delivered",
  "pending",
];

/** Reporting donut includes additional cancelled/returned segments. */
export const REPORTING_DONUT_KEYS = [
  { key: "delivered", labelKey: "statusDelivered" },
  { key: "in_transit", labelKey: "statusInTransit" },
  { key: "out_for_delivery", labelKey: "statusOutForDelivery" },
  { key: "pending", labelKey: "statusPending" },
  { key: "exceptions", labelKey: "statusExceptions" },
  { key: "cancelled", labelKey: "statusCancelled" },
  { key: "returned", labelKey: "statusReturned" },
];

/** Pre-composed reporting metrics config using the reporting key sets. */
export const REPORTING_METRICS_CONFIG = {
  kpiKeys: [...REPORTING_KPI_KEYS],
  donutKeys: REPORTING_DONUT_KEYS,
};
