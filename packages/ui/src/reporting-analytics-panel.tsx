"use client";

import * as React from "react";
import { KpiCard } from "./charts/kpi-card";
import { DonutChart } from "./charts/donut-chart";
import { TrendChart } from "./charts/trend-chart";
import { Button } from "./button";
import { EmptyState } from "./empty-state";
import { cn } from "./utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type KpiItem = {
  title: string;
  value: string | number;
  change?: number | null;
  changeLabel?: string | null;
  tone?: "neutral" | "success" | "warning" | "danger";
};

type DonutSegment = {
  name: string;
  value: number;
  color?: string;
};

type TrendPoint = {
  day: string;
  count: number;
};

type DateRangeOption = {
  key: string;
  label: string;
  days: number;
};

export type ReportingAnalyticsPanelProps = {
  kpis: KpiItem[];
  donutData: DonutSegment[];
  donutTotal: number;
  trendData: TrendPoint[];
  dateRangeOptions: DateRangeOption[];
  activeDateRange: string;
  onDateRangeChange?: (key: string) => void;
  onExportCsv?: () => void;
  /** i18n labels */
  labels: {
    dateRangeLabel: string;
    kpiTitle: string;
    statusTitle: string;
    statusCenter: string;
    trendTitle: string;
    exportCsv: string;
    emptyTitle: string;
    emptyDescription: string;
  };
  testId?: string;
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

/**
 * Client-side reporting analytics panel with KPI cards, donut chart,
 * trend chart, date-range selector, and CSV export button.
 * Receives pre-computed data from the server component.
 */
export function ReportingAnalyticsPanel({
  kpis,
  donutData,
  donutTotal,
  trendData,
  dateRangeOptions,
  activeDateRange,
  onDateRangeChange,
  onExportCsv,
  labels,
  testId,
}: ReportingAnalyticsPanelProps) {
  const hasData = kpis.length > 0 || donutData.length > 0 || trendData.length > 0;

  if (!hasData) {
    return (
      <EmptyState
        variant="page"
        title={labels.emptyTitle}
        description={labels.emptyDescription}
        testId={testId ? `${testId}-empty` : undefined}
      />
    );
  }

  return (
    <div data-testid={testId} className="space-y-6">
      {/* Date range selector + export */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1" role="group" aria-label={labels.dateRangeLabel}>
          {dateRangeOptions.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => onDateRangeChange?.(opt.key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                activeDateRange === opt.key
                  ? "bg-ui-accent text-white shadow-sm"
                  : "bg-ui-highlight/60 text-ui-muted hover:bg-ui-highlight hover:text-ui-ink"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {onExportCsv ? (
          <Button size="sm" variant="soft" onClick={onExportCsv}>
            {labels.exportCsv}
          </Button>
        ) : null}
      </div>

      {/* KPI cards */}
      {kpis.length > 0 ? (
        <section aria-label={labels.kpiTitle}>
          <p className="mb-3 text-sm font-semibold text-ui-ink">{labels.kpiTitle}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {kpis.map((kpi) => (
              <KpiCard
                key={kpi.title}
                title={kpi.title}
                value={kpi.value}
                change={kpi.change}
                changeLabel={kpi.changeLabel}
                tone={kpi.tone}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* Charts row */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Status distribution donut */}
        {donutData.length > 0 ? (
          <DonutChart
            data={donutData}
            title={labels.statusTitle}
            centerLabel={labels.statusCenter}
            centerValue={donutTotal}
            height={260}
          />
        ) : null}

        {/* Trend chart */}
        {trendData.length > 0 ? (
          <TrendChart
            data={trendData}
            xKey="day"
            bars={[{ key: "count", label: labels.trendTitle }]}
            title={labels.trendTitle}
            height={260}
          />
        ) : null}
      </div>
    </div>
  );
}
