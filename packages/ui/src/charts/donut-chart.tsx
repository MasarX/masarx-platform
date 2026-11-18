"use client";

import { createUiTranslator } from "../i18n";
import { cn } from "../utils";

type DonutSegment = {
  name: string;
  value: number;
  color?: string;
};

type DonutChartProps = {
  data: DonutSegment[];
  title?: string;
  height?: number;
  className?: string;
  centerLabel?: string;
  centerValue?: string | number;
};

const DEFAULT_COLORS = [
  "rgb(var(--ui-accent))",
  "rgb(var(--ui-success))",
  "rgb(var(--ui-warning))",
  "rgb(var(--ui-danger))",
  "rgb(var(--ui-info))",
  "rgb(var(--ui-violet, 139 92 246))",
  "rgb(var(--ui-pink, 236 72 153))",
  "rgb(var(--ui-amber, 245 158 11))",
];

/**
 * Donut chart for status distribution visualization.
 * Optional center label for total count display.
 */
export function DonutChart({
  data,
  title,
  height = 250,
  className,
  centerLabel,
  centerValue,
}: DonutChartProps) {
  const t = createUiTranslator("ui.charts");

  const segments = data.filter(({ value }) => Number.isFinite(value) && value > 0);
  const max = segments.reduce((largest, { value }) => Math.max(largest, value), 1);
  const total = segments.reduce((sum, { value }) => sum + value / max, 0);
  let offset = 0;
  const stops = segments.map((segment, index) => {
    const start = offset;
    offset += (segment.value / max) / total * 100;
    const color = segment.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length];
    return { ...segment, start, end: offset, color };
  });
  const background = stops.length
    ? "conic-gradient(" + stops.map(({ color, start, end }) => color + " " + start + "% " + end + "%").join(", ") + ")"
    : undefined;
  const diameter = Math.max(40, Math.min(360, Number.isFinite(height) ? height * 0.75 : 180));

  return (
    <figure className={cn("rounded-lg border border-ui-border/60 bg-ui-surface p-4", className)}>
      {title ? <figcaption className="mb-2 text-sm font-semibold text-ui-ink">{title}</figcaption> : null}
      {background ? (
        <>
          <div className="mx-auto grid max-w-full place-items-center rounded-full"
            style={{ background, width: diameter, aspectRatio: "1" }}>
            <div className="grid h-2/3 w-2/3 place-content-center rounded-full bg-ui-surface text-center">
              {centerValue != null ? <strong>{centerValue}</strong> : null}
              {centerLabel ? <span className="text-xs text-ui-muted">{centerLabel}</span> : null}
            </div>
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
            {stops.map(({ name, value, color }, index) => (
              <li key={index} className="flex items-center gap-1">
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                <span>{name}: {value}</span>
              </li>
            ))}
          </ul>
        </>
      ) : <p className="text-sm text-ui-muted">{t.has?.("noData") ? t("noData") : "No data"}</p>}
    </figure>
  );
}
