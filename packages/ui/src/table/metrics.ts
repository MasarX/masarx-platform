import type { ResourceColumn } from "./columns";
import { resolveColumnLabelByKey, toCsvRow } from "./columns";

export type ColumnMetric = {
  count: number;
  sum: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  median?: number | null;
};

export type ResourceMetrics = {
  total: number;
  columns: Record<string, ColumnMetric>;
};

export const EMPTY_METRIC: ColumnMetric = {
  count: 0,
  sum: null,
  min: null,
  max: null,
  avg: null,
  median: null,
};

export function computePageMetrics(
  items: Record<string, unknown>[],
  columns: ResourceColumn[]
): ResourceMetrics {
  const metrics: Record<string, ColumnMetric> = {};
  columns.forEach((column) => {
    let count = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const numericValues: number[] = [];
    items.forEach((item) => {
      const value = item[column.key];
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      count += 1;
      numericValues.push(value);
      sum += value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    });
    if (count > 0) {
      numericValues.sort((left, right) => left - right);
      const middle = Math.floor(count / 2);
      const median = count % 2 === 0
        ? numericValues[middle - 1]! / 2 + numericValues[middle]! / 2
        : numericValues[middle]!;
      metrics[column.key] = {
        count,
        sum,
        min,
        max,
        avg: sum / count,
        median,
      };
    }
  });
  return { total: items.length, columns: metrics };
}

export type AggregationType = "count" | "sum" | "avg" | "min" | "max" | "median" | "none";

export function getAggregationValue(
  metric: ColumnMetric | null,
  type: AggregationType
): number | null {
  if (!metric || type === "none") return null;
  switch (type) {
    case "count": return metric.count;
    case "sum": return metric.sum;
    case "avg": return metric.avg;
    case "min": return metric.min;
    case "max": return metric.max;
    case "median": return metric.median ?? null;
    default: return null;
  }
}

export function formatMetricValue(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercentValue(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatMetricCsvValue(value: number | null | undefined) {
  if (value === null || value === undefined) return "";
  if (!Number.isFinite(value)) return "";
  return String(value);
}

export function buildMetricsCsv(
  metricKeys: string[],
  pageMetrics: ResourceMetrics,
  datasetMetrics: ResourceMetrics | null,
  columnsByKey: Map<string, ResourceColumn>
) {
  const baseHeaders = [
    "column",
    "page_count",
    "page_sum",
    "page_avg",
    "page_min",
    "page_max",
  ];
  const datasetHeaders = datasetMetrics
    ? ["dataset_count", "dataset_sum", "dataset_avg", "dataset_min", "dataset_max"]
    : [];
  const headers = [...baseHeaders, ...datasetHeaders];
  const lines = [toCsvRow(headers)];
  metricKeys.forEach((key) => {
    const label = resolveColumnLabelByKey(columnsByKey, key);
    const page = pageMetrics.columns[key] ?? EMPTY_METRIC;
    const dataset = datasetMetrics?.columns[key] ?? null;
    const row = [
      label,
      String(page.count),
      formatMetricCsvValue(page.sum),
      formatMetricCsvValue(page.avg),
      formatMetricCsvValue(page.min),
      formatMetricCsvValue(page.max),
      ...(datasetMetrics
        ? [
            String(dataset?.count ?? ""),
            formatMetricCsvValue(dataset?.sum ?? null),
            formatMetricCsvValue(dataset?.avg ?? null),
            formatMetricCsvValue(dataset?.min ?? null),
            formatMetricCsvValue(dataset?.max ?? null),
          ]
        : []),
    ];
    lines.push(toCsvRow(row));
  });
  return lines.join("\r\n");
}
