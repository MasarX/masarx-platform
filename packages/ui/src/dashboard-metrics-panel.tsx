"use client";

import * as React from "react";
import { KpiCard } from "./charts/kpi-card";
import { DonutChart } from "./charts/donut-chart";

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

type DashboardMetricsPanelProps = {
  kpis: KpiItem[];
  donutData: DonutSegment[];
  donutTitle?: string;
  donutCenterLabel?: string;
  donutCenterValue?: string | number;
  testId?: string;
};

/**
 * Client-side wrapper for dashboard KPI cards and donut chart.
 * Receives pre-computed data from the server component.
 */
export function DashboardMetricsPanel({
  kpis,
  donutData,
  donutTitle,
  donutCenterLabel,
  donutCenterValue,
  testId,
}: DashboardMetricsPanelProps) {
  return (
    <div data-testid={testId}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
      {donutData.length > 0 ? (
        <div className="mt-4 max-w-md">
          <DonutChart
            data={donutData}
            title={donutTitle}
            centerLabel={donutCenterLabel}
            centerValue={donutCenterValue}
            height={220}
          />
        </div>
      ) : null}
    </div>
  );
}
