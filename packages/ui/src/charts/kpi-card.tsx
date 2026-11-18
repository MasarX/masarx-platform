"use client";

import * as React from "react";
import { cn } from "../utils";

type KpiCardProps = {
  title: string;
  value: string | number;
  change?: number | null;
  changeLabel?: string | null;
  icon?: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
  className?: string;
};

/**
 * KPI metric card with value, trend arrow, and optional icon.
 * Use in dashboard grids for operational metrics.
 */
export function KpiCard({
  title,
  value,
  change,
  changeLabel,
  icon,
  tone = "neutral",
  className,
}: KpiCardProps) {
  const trendUp = change != null && change > 0;
  const trendDown = change != null && change < 0;
  const trendColor = trendUp
    ? "text-[rgb(var(--ui-success))]"
    : trendDown
      ? "text-[rgb(var(--ui-danger))]"
      : "text-ui-muted";

  const borderColor =
    tone === "success"
      ? "border-s-[rgb(var(--ui-success))]"
      : tone === "warning"
        ? "border-s-[rgb(var(--ui-warning))]"
        : tone === "danger"
          ? "border-s-[rgb(var(--ui-danger))]"
          : "border-s-ui-accent";

  return (
    <div
      className={cn(
        "rounded-lg border border-ui-border/60 border-s-4 bg-ui-surface p-4 shadow-sm transition hover:shadow-md",
        borderColor,
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-ui-muted">
            {title}
          </p>
          <p className="mt-1 text-2xl font-bold text-ui-ink">{value}</p>
          {change != null ? (
            <div className={cn("mt-1 flex items-center gap-1 text-xs", trendColor)}>
              {trendUp ? (
                <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
                  <path d="M6 2l4 5H2z" />
                </svg>
              ) : trendDown ? (
                <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
                  <path d="M6 10l4-5H2z" />
                </svg>
              ) : null}
              <span>
                {change > 0 ? "+" : ""}
                {change}%
              </span>
              {changeLabel ? (
                <span className="text-ui-muted">{changeLabel}</span>
              ) : null}
            </div>
          ) : null}
        </div>
        {icon ? (
          <div className="shrink-0 text-ui-muted/40">{icon}</div>
        ) : null}
      </div>
    </div>
  );
}
