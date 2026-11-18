"use client";

import { createUiTranslator } from "../i18n";
import { cn } from "../utils";

type DataPoint = Record<string, unknown>;

type TrendChartProps = {
  data: DataPoint[];
  xKey: string;
  lines?: { key: string; color?: string; label?: string }[];
  bars?: { key: string; color?: string; label?: string }[];
  title?: string;
  height?: number;
  className?: string;
};

const DEFAULT_COLORS = [
  "rgb(var(--ui-accent))",
  "rgb(var(--ui-success))",
  "rgb(var(--ui-warning))",
  "rgb(var(--ui-info))",
  "rgb(var(--ui-danger))",
];

/**
 * Configurable trend chart supporting line and bar chart types.
 * Includes the underlying values as an accessible table.
 */
export function TrendChart({
  data,
  xKey,
  lines,
  bars,
  title,
  height = 300,
  className,
}: TrendChartProps) {
  const t = createUiTranslator("ui.charts");
  const showBars = Boolean(bars?.length);
  const series = showBars ? bars ?? [] : lines ?? [];
  const sample = (row: DataPoint, key: string) => {
    const value = row[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const values = data.flatMap((row) => series.flatMap(({ key }) => {
    const value = sample(row, key);
    return value === null ? [] : [value];
  }));
  const min = values.reduce((low, value) => Math.min(low, value), 0);
  const max = values.reduce((high, value) => Math.max(high, value), 0);
  const scale = Math.max(Math.abs(min), Math.abs(max), 1);
  const domain = max / scale - min / scale || 1;
  const y = (value: number) => 200 - ((value / scale - min / scale) / domain) * 180;
  const rowWidth = 276 / Math.max(data.length, 1);
  const zero = y(0);

  return (
    <figure className={cn("rounded-lg border border-ui-border/60 bg-ui-surface p-4", className)}>
      {title ? <figcaption className="mb-3 text-sm font-semibold text-ui-ink">{title}</figcaption> : null}
      {values.length ? (
        <>
          <svg aria-hidden className="w-full" viewBox="0 0 300 220" style={{ height }}>
            <line x1="12" x2="288" y1={zero} y2={zero} className="stroke-ui-border" />
            {series.map(({ key, color }, seriesIndex) => (
              <g key={key} stroke={color ?? DEFAULT_COLORS[seriesIndex % DEFAULT_COLORS.length]}
                fill={color ?? DEFAULT_COLORS[seriesIndex % DEFAULT_COLORS.length]}>
                {data.map((row, index) => {
                  const value = sample(row, key);
                  if (value === null) return null;
                  const x = 12 + rowWidth * (index + 0.5);
                  const top = y(value);
                  if (showBars) {
                    const width = rowWidth * 0.8 / series.length;
                    return <rect key={index} x={x - rowWidth * 0.4 + width * seriesIndex}
                      y={Math.min(zero, top)} width={width} height={Math.abs(top - zero)} rx="1" />;
                  }
                  const previous = index > 0 ? sample(data[index - 1], key) : null;
                  return <g key={index}>
                    {previous === null ? null : <line x1={x - rowWidth} x2={x} y1={y(previous)} y2={top} strokeWidth="2" />}
                    <circle cx={x} cy={top} r="2" />
                  </g>;
                })}
              </g>
            ))}
          </svg>
          <table className="w-full text-xs">
            <caption className="sr-only">{title ?? "Trend values"}</caption>
            <thead><tr><th scope="col">{xKey}</th>{series.map(({ key, label }) => <th key={key} scope="col">{label ?? key}</th>)}</tr></thead>
            <tbody>{data.map((row, index) => <tr key={index}>
              <th scope="row">{String(row[xKey] ?? "")}</th>
              {series.map(({ key }) => <td key={key}>{sample(row, key) ?? "-"}</td>)}
            </tr>)}</tbody>
          </table>
        </>
      ) : <p className="text-sm text-ui-muted">{t.has?.("noDataAvailable") ? t("noDataAvailable") : "No data"}</p>}
    </figure>
  );
}
