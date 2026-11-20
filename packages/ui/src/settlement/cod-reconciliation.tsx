"use client";

import * as React from "react";
import { Badge } from "../badge";
import { createUiTranslator } from "../i18n";
import { cn } from "../utils";

export type CodEntry = {
  id: string;
  orderId: string;
  trackingNumber?: string | null;
  expectedAmount: number;
  collectedAmount: number;
  remittedAmount?: number | null;
  currency: string;
  status: "pending" | "matched" | "short" | "excess" | "missing";
  driverName?: string | null;
  collectedAt?: string | null;
};

type CodReconciliationProps = {
  entries: CodEntry[];
  onEntryClick?: (entry: CodEntry) => void;
  className?: string;
};

const statusTones: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = {
  matched: "success",
  pending: "neutral",
  short: "danger",
  excess: "warning",
  missing: "danger",
};

/**
 * COD reconciliation table showing Order -> Collected -> Remitted -> Variance.
 * Highlights discrepancies with color coding.
 */
export function CodReconciliation({
  entries,
  onEntryClick,
  className,
}: CodReconciliationProps) {
  const t = createUiTranslator("ui.codReconciliation");
  const totalExpected = entries.reduce((s, e) => s + e.expectedAmount, 0);
  const totalCollected = entries.reduce((s, e) => s + e.collectedAmount, 0);
  const totalVariance = totalCollected - totalExpected;
  const currency = entries[0]?.currency ?? "\u2014";

  return (
    <div className={cn("space-y-4", className)}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-ui-border/40 bg-ui-surface p-3">
          <p className="text-[10px] tracking-wide text-ui-muted">{t("expected")}</p>
          <p className="mt-0.5 text-lg font-bold text-ui-ink">{totalExpected.toLocaleString()} {currency}</p>
        </div>
        <div className="rounded-lg border border-ui-border/40 bg-ui-surface p-3">
          <p className="text-[10px] tracking-wide text-ui-muted">{t("collected")}</p>
          <p className="mt-0.5 text-lg font-bold text-ui-ink">{totalCollected.toLocaleString()} {currency}</p>
        </div>
        <div className={cn("rounded-lg border border-ui-border/40 bg-ui-surface p-3", totalVariance < 0 && "border-s-4 border-s-[rgb(var(--ui-danger))]", totalVariance > 0 && "border-s-4 border-s-[rgb(var(--ui-warning))]")}>
          <p className="text-[10px] tracking-wide text-ui-muted">{t("variance")}</p>
          <p className={cn("mt-0.5 text-lg font-bold", totalVariance < 0 ? "text-[rgb(var(--ui-danger))]" : totalVariance > 0 ? "text-[rgb(var(--ui-warning))]" : "text-[rgb(var(--ui-success))]")}>
            {totalVariance > 0 ? "+" : ""}{totalVariance.toLocaleString()} {currency}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-ui-border/40">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ui-border/30 bg-ui-highlight/30">
              <th className="px-3 py-2 text-left text-xs font-medium tracking-wide text-ui-muted">{t("order")}</th>
              <th className="px-3 py-2 text-left text-xs font-medium tracking-wide text-ui-muted">{t("tracking")}</th>
              <th className="px-3 py-2 text-right text-xs font-medium tracking-wide text-ui-muted">{t("expected")}</th>
              <th className="px-3 py-2 text-right text-xs font-medium tracking-wide text-ui-muted">{t("collected")}</th>
              <th className="px-3 py-2 text-right text-xs font-medium tracking-wide text-ui-muted">{t("variance")}</th>
              <th className="px-3 py-2 text-center text-xs font-medium tracking-wide text-ui-muted">{t("status")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const variance = entry.collectedAmount - entry.expectedAmount;
              return (
                <tr key={entry.id} className="border-b border-ui-border/10 transition hover:bg-ui-highlight/20 cursor-pointer" onClick={() => onEntryClick?.(entry)}>
                  <td className="px-3 py-2 font-mono text-xs text-ui-ink">{entry.orderId}</td>
                  <td className="px-3 py-2 text-xs text-ui-muted">{entry.trackingNumber ?? "-"}</td>
                  <td className="px-3 py-2 text-right text-xs text-ui-ink">{entry.expectedAmount.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right text-xs text-ui-ink">{entry.collectedAmount.toLocaleString()}</td>
                  <td className={cn("px-3 py-2 text-right text-xs font-medium", variance < 0 ? "text-[rgb(var(--ui-danger))]" : variance > 0 ? "text-[rgb(var(--ui-warning))]" : "text-[rgb(var(--ui-success))]")}>
                    {variance > 0 ? "+" : ""}{variance.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <Badge tone={statusTones[entry.status] ?? "neutral"} size="sm" dot>{entry.status}</Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
