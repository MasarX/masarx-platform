"use client";
import { Button } from "../button";
import type { TranslateFn } from "./types";

type TableExportPanelProps = {
  t: TranslateFn;
  analyticsEnabled: boolean;
  onExportMetrics: () => void;
  metricsExportDisabled: boolean;
  onExportCsv: () => void;
  exportDisabled: boolean;
  onExportExcel: () => void;
  excelExportDisabled: boolean;
  testIdPrefix?: string | null;
};

export function TableExportPanel({
  t,
  analyticsEnabled,
  onExportMetrics,
  metricsExportDisabled,
  onExportCsv,
  exportDisabled,
  onExportExcel,
  excelExportDisabled,
  testIdPrefix,
}: TableExportPanelProps) {
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const panelTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-export-panel`
    : undefined;
  const metricsTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-export-metrics`
    : undefined;
  const excelTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-export-excel`
    : undefined;
  const csvTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-export-csv`
    : undefined;
  return (
    <div className="grid gap-2 sm:grid-cols-3" data-testid={panelTestId}>
      {analyticsEnabled ? (
        <Button
          type="button"
          variant="ghost"
          onClick={onExportMetrics}
          disabled={metricsExportDisabled}
          data-testid={metricsTestId}
        >
          {t("export.metrics")}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        onClick={onExportExcel}
        disabled={excelExportDisabled}
        data-testid={excelTestId}
      >
        {t("export.excel")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        onClick={onExportCsv}
        disabled={exportDisabled}
        data-testid={csvTestId}
      >
        {t("export.csv")}
      </Button>
    </div>
  );
}
