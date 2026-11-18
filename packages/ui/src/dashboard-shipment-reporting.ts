import type { UiReadRegistry, UiResourceMetrics, UiShipmentReportingConfig } from "@masarx/api";
import { resolveDashboardResourceReadState } from "./dashboard-utils";

type MetricsReader = (
  resource: string, filters?: Record<string, unknown>, columns?: string[] | null
) => Promise<UiResourceMetrics>;

export type ShipmentReporting = {
  unavailable: boolean;
  cards: Array<{ key: string; value: number | null; percent?: boolean }>;
  statuses: Array<{ key: string; labelKey: string; value: number | null }>;
};

const unavailable = (): ShipmentReporting => ({
  unavailable: true, cards: [], statuses: [],
});

function parseConfig(value: unknown): Extract<UiShipmentReportingConfig, { enabled: true }> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const config = value as Extract<UiShipmentReportingConfig, { enabled: true }>;
  const text = (v: unknown): v is string => typeof v === "string" && v.trim() === v && v.length > 0;
  if (config.enabled !== true || !text(config.resource) || !text(config.status_filter)
    || !Array.isArray(config.app_keys) || config.app_keys.length === 0
    || !config.app_keys.every(text) || new Set(config.app_keys).size !== config.app_keys.length
    || !Array.isArray(config.statuses) || config.statuses.length === 0 || config.statuses.length > 50
    || !config.statuses.every((status) => status && text(status.key) && text(status.label_key) && /^[A-Za-z0-9_]+$/.test(status.label_key))
    || !Array.isArray(config.active_status_keys) || config.active_status_keys.length === 0) return null;
  const keys = new Set(config.statuses.map((status) => status.key));
  if (keys.size !== config.statuses.length
    || new Set(config.active_status_keys).size !== config.active_status_keys.length
    || ![...config.active_status_keys, config.delivered_status_key,
      config.pending_status_key, config.exception_status_key].every((key) => text(key) && keys.has(key))) return null;
  return config;
}

/** All-time scoped reporting; no lookup grants, page-count fallback or persisted rollup. */
export async function resolveShipmentReporting(
  value: unknown,
  appKey: string,
  registry: UiReadRegistry | null,
  capabilities: Set<string>,
  readMetrics: MetricsReader,
): Promise<ShipmentReporting | null> {
  if (value == null || (typeof value === "object" && !Array.isArray(value)
    && (value as { enabled?: unknown }).enabled === false)) return null;
  const config = parseConfig(value);
  if (!config) return unavailable();
  if (!config.app_keys.includes(appKey)) return null;
  const authority = resolveDashboardResourceReadState(config.resource, registry, capabilities);
  const filters = authority.resource?.filters?.filter((filter) => filter.key === config.status_filter) ?? [];
  const statusFilter = filters[0];
  if (!authority.readAllowed || filters.length !== 1 || !statusFilter
    || !(statusFilter.ops ?? [statusFilter.op ?? "eq"]).includes("eq")) return unavailable();
  const count = async (filter: Record<string, unknown>): Promise<number | null> => {
    try {
      const result = await readMetrics(config.resource, filter, [authority.resource?.id_column ?? "id"]);
      return result?.resource === config.resource && Number.isSafeInteger(result.total) && result.total >= 0
        ? result.total : null;
    } catch {
      return null;
    }
  };
  // Independent calls share the existing request-local API memoization; one query per status.
  const [total, ...values] = await Promise.all([
    count({}), ...config.statuses.map((status) => count({ [config.status_filter]: status.key })),
  ]);
  const counts = new Map(config.statuses.map((status, index) => [status.key, values[index] ?? null]));
  const activeValues = config.active_status_keys.map((key) => counts.get(key) ?? null);
  const active = activeValues.every((value): value is number => value !== null)
    ? activeValues.reduce((sum, value) => sum + value, 0) : null;
  const delivered = counts.get(config.delivered_status_key) ?? null;
  const rate = total !== null && delivered !== null && delivered <= total
    ? (total === 0 ? 0 : Math.round(delivered / total * 100)) : null;
  const cards: ShipmentReporting["cards"] = [
    { key: "total", value: total },
    { key: "active", value: active !== null && Number.isSafeInteger(active) ? active : null },
    { key: "exceptions", value: counts.get(config.exception_status_key) ?? null },
    { key: "rate", value: rate, percent: true },
    { key: "delivered", value: delivered },
    { key: "pending", value: counts.get(config.pending_status_key) ?? null },
  ];
  return {
    unavailable: cards.some((card) => card.value === null) || values.some((value) => value === null),
    cards,
    statuses: config.statuses.map((status, index) => ({
      key: status.key, labelKey: status.label_key, value: values[index] ?? null,
    })),
  };
}
