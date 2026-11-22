/**
 * Compute KPI card data and donut segments from dashboard resource counts.
 * Runs server-side; produces serializable props for the client panel.
 *
 * Resource keys and donut segment definitions are accepted as parameters
 * so callers can drive them from DB configuration (e.g. ui_dashboard
 * settings_versions) instead of compile-time constants.
 */

import { resolveStatusToneColor } from "./status-colors";
import {
  DEFAULT_KPI_KEYS,
  DEFAULT_DONUT_KEYS,
  STATUS_DELIVERED,
  STATUS_IN_TRANSIT,
} from "./status-defaults";

export type KpiItem = {
  title: string;
  value: string | number;
  change?: number | null;
  changeLabel?: string | null;
  tone?: "neutral" | "success" | "warning" | "danger";
};

export type DonutSegment = {
  name: string;
  value: number;
  color?: string;
};

/** Configuration for which resource keys to use in metrics builders.
 * Resolved server-side via {@link resolveStatusConfig} from lookup_values metadata.
 */
export type DashboardMetricsConfig = {
  /** Keys to pull for KPI cards (e.g. ["shipments","in_transit","out_for_delivery","exceptions","delivered"]) */
  kpiKeys?: string[];
  /** Keys for donut segments, each with its i18n label key */
  donutKeys?: { key: string; labelKey: string; color?: string }[];
};

/* KPI keys and donut segment definitions imported from status-defaults SSOT. */

/**
 * Delivery rate thresholds for KPI tone resolution.
 * TODO: resolve from dashboard_metrics_policy settings category
 */
const DELIVERY_RATE_SUCCESS_THRESHOLD = 90;
const DELIVERY_RATE_WARNING_THRESHOLD = 70;

export const safeCount = (counts: Map<string, number | null>, key: string): number => {
  const v = counts.get(key);
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};

/**
 * Build KPI card props from resource counts.
 * Accepts optional `config.kpiKeys` to override which resource keys are used.
 * Falls back to well-known defaults when no config is provided.
 */
export function buildKpiCards(
  counts: Map<string, number | null>,
  t: (key: string, values?: Record<string, string>) => string,
  config?: DashboardMetricsConfig
): KpiItem[] {
  const keys = config?.kpiKeys ?? DEFAULT_KPI_KEYS;
  const get = (key: string) => safeCount(counts, key);

  const shipments = get(keys[0] ?? "shipments");
  const inTransit = get(keys[1] ?? STATUS_IN_TRANSIT);
  const outForDelivery = get(keys[2] ?? "out_for_delivery");
  const exceptions = get(keys[3] ?? "exceptions");
  const delivered = get(keys[4] ?? STATUS_DELIVERED);

  const activeDeliveries = inTransit + outForDelivery;
  const deliveryRate =
    shipments > 0 ? Math.round((delivered / shipments) * 100) : 0;

  return [
    {
      title: t("metricsTotalShipments"),
      value: shipments.toLocaleString(),
      tone: "neutral" as const,
    },
    {
      title: t("metricsActiveDeliveries"),
      value: activeDeliveries.toLocaleString(),
      tone: "success" as const,
    },
    {
      title: t("metricsPendingExceptions"),
      value: exceptions.toLocaleString(),
      tone: exceptions > 0 ? ("warning" as const) : ("neutral" as const),
    },
    {
      title: t("metricsDeliveryRate"),
      value: `${deliveryRate}%`,
      tone:
        deliveryRate >= DELIVERY_RATE_SUCCESS_THRESHOLD
          ? ("success" as const)
          : deliveryRate >= DELIVERY_RATE_WARNING_THRESHOLD
            ? ("warning" as const)
            : ("danger" as const),
    },
  ];
}

/**
 * Build donut chart segments from resource counts for shipment status breakdown.
 * Labels are resolved via the i18n translator so RTL locales display correctly.
 * Accepts optional `config.donutKeys` to override segment definitions.
 */
export function buildStatusDonut(
  counts: Map<string, number | null>,
  t: (key: string) => string,
  config?: DashboardMetricsConfig
): { segments: DonutSegment[]; total: number } {
  const donutDefs = config?.donutKeys ?? DEFAULT_DONUT_KEYS;

  const segments: DonutSegment[] = [];
  let total = 0;

  for (const s of donutDefs) {
    const v = safeCount(counts, s.key);
    if (v > 0) {
      const color = s.color ?? resolveStatusToneColor(s.key);
      segments.push({ name: t(s.labelKey), value: v, color });
      total += v;
    }
  }

  return { segments, total };
}
