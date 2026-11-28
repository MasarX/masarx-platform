"use client";

import * as React from "react";
import { Badge } from "../badge";
import { KpiCard } from "../charts/kpi-card";
import { cn } from "../utils";
import { createUiTranslator } from "../i18n";
import { formatResourceValue } from "../resource-utils";

export type IntegrationHealthEntry = {
  id: string;
  name: string;
  type: "webhook" | "api" | "edge_function";
  status: "healthy" | "degraded" | "down";
  successRate?: number | null;
  totalCalls?: number | null;
  avgResponseMs?: number | null;
  lastError?: string | null;
  lastCheckedAt?: string | null;
};

type IntegrationHealthProps = {
  integrations: IntegrationHealthEntry[];
  className?: string;
};

const statusTones: Record<string, "success" | "warning" | "danger"> = {
  healthy: "success",
  degraded: "warning",
  down: "danger",
};

/**
 * Integration health dashboard showing webhook delivery success rate,
 * API call volume, error rates, and per-integration status.
 */
export function IntegrationHealth({
  integrations,
  className,
}: IntegrationHealthProps) {
  const t = createUiTranslator("ui.integrationHealth");
  const healthy = integrations.filter((i) => i.status === "healthy").length;
  const degraded = integrations.filter((i) => i.status === "degraded").length;
  const down = integrations.filter((i) => i.status === "down").length;
  const avgSuccess =
    integrations.length > 0
      ? Math.round(
          integrations.reduce((s, i) => s + (i.successRate ?? 100), 0) / integrations.length
        )
      : 100;

  return (
    <div className={cn("space-y-6", className)}>
      {/* Summary KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard title={t("total")} value={integrations.length} tone="neutral" />
        <KpiCard title={t("healthy")} value={healthy} tone="success" />
        <KpiCard title={t("degraded")} value={degraded} tone="warning" />
        <KpiCard title={t("down")} value={down} tone={down > 0 ? "danger" : "success"} />
      </div>

      {/* Integration list */}
      <div className="rounded-lg border border-ui-border/40">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ui-border/30 bg-ui-highlight/30">
              <th className="px-3 py-2 text-start text-xs font-medium tracking-wide text-ui-muted">{t("integration")}</th>
              <th className="px-3 py-2 text-center text-xs font-medium tracking-wide text-ui-muted">{t("type")}</th>
              <th className="px-3 py-2 text-center text-xs font-medium tracking-wide text-ui-muted">{t("status")}</th>
              <th className="px-3 py-2 text-end text-xs font-medium tracking-wide text-ui-muted">{t("successPercent")}</th>
              <th className="px-3 py-2 text-end text-xs font-medium tracking-wide text-ui-muted">{t("calls")}</th>
              <th className="px-3 py-2 text-end text-xs font-medium tracking-wide text-ui-muted">{t("avgResponse")}</th>
            </tr>
          </thead>
          <tbody>
            {integrations.map((entry) => (
              <tr
                key={entry.id}
                className="border-b border-ui-border/10 transition hover:bg-ui-highlight/20"
              >
                <td className="px-3 py-2 font-medium text-ui-ink">{entry.name}</td>
                <td className="px-3 py-2 text-center">
                  <Badge tone="neutral" size="sm">{entry.type}</Badge>
                </td>
                <td className="px-3 py-2 text-center">
                  <Badge tone={statusTones[entry.status] ?? "neutral"} size="sm" dot>
                    {entry.status}
                  </Badge>
                </td>
                <td className={cn(
                  "px-3 py-2 text-end font-mono text-xs",
                  (entry.successRate ?? 100) < 95 ? "text-[rgb(var(--ui-danger))]" : "text-ui-ink"
                )}>
                  {entry.successRate != null ? `${entry.successRate}%` : "-"}
                </td>
                <td className="px-3 py-2 text-end text-xs text-ui-muted">
                  {formatResourceValue(entry.totalCalls, { renderType: "number" })}
                </td>
                <td className="px-3 py-2 text-end text-xs text-ui-muted">
                  {entry.avgResponseMs != null ? `${entry.avgResponseMs}ms` : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
