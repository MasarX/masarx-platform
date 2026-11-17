"use client";
import * as React from "react";
import { formatResourceValue } from "../resource-utils";
import { downloadBlob } from "../file-download";
import { buildExcelExportBlob } from "../tabular-file";
import {
  buildCsv,
  resolveColumnLabel,
  type ResourceColumn,
} from "./columns";
import {
  buildMetricsCsv,
  type ResourceMetrics,
} from "./metrics";
import type { TranslateFn } from "./types";

type TableExportOptions = {
  t: TranslateFn;
  sortedItems: Record<string, unknown>[];
  displayColumns: ResourceColumn[];
  metricKeys: string[];
  pageMetrics: ResourceMetrics | null;
  datasetMetrics: ResourceMetrics | null;
  columnsByKey: Map<string, ResourceColumn>;
  resourceKey?: string | null;
};

type TableExportHandlers = {
  exportDisabled: boolean;
  excelExportDisabled: boolean;
  metricsExportDisabled: boolean;
  onExportCsv: () => void;
  onExportExcel: () => Promise<void>;
  onExportMetrics: () => void;
};

export function useTableExport({
  t,
  sortedItems,
  displayColumns,
  metricKeys,
  pageMetrics,
  datasetMetrics,
  columnsByKey,
  resourceKey,
}: TableExportOptions): TableExportHandlers {
  const [excelExporting, setExcelExporting] = React.useState(false);
  const exportDisabled = sortedItems.length === 0 || displayColumns.length === 0;
  const metricsExportDisabled = metricKeys.length === 0 || !pageMetrics;
  const exportName = resourceKey
    ? `${resourceKey}-${new Date().toISOString().slice(0, 10)}.csv`
    : `export-${new Date().toISOString().slice(0, 10)}.csv`;
  const excelExportName = exportName.endsWith(".csv")
    ? exportName.replace(/\.csv$/, ".xlsx")
    : `${exportName}.xlsx`;
  const metricsExportName = resourceKey
    ? `${resourceKey}-metrics-${new Date().toISOString().slice(0, 10)}.csv`
    : `metrics-${new Date().toISOString().slice(0, 10)}.csv`;
  const excelExportDisabled = exportDisabled || excelExporting;

  const onExportCsv = React.useCallback(() => {
    if (exportDisabled) return;
    const csv = buildCsv(sortedItems, displayColumns);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    downloadBlob(blob, exportName);
  }, [displayColumns, exportDisabled, exportName, sortedItems]);

  const onExportExcel = React.useCallback(async () => {
    if (excelExportDisabled) return;
    setExcelExporting(true);
    try {
      const header = displayColumns.map((column) => resolveColumnLabel(column));
      const rows = sortedItems.map((item) =>
        displayColumns.map((column) =>
          formatResourceValue(item[column.key] ?? "", {
            renderType: column.renderType ?? null,
            formatOptions: column.formatOptions ?? null,
          })
        )
      );
      const blob = await buildExcelExportBlob({
        header,
        rows,
        sheetName: t("export.sheetName"),
      });
      downloadBlob(blob, excelExportName);
    } catch (error) {
      console.error("Excel export failed", error);
    } finally {
      setExcelExporting(false);
    }
  }, [
    displayColumns,
    excelExportDisabled,
    excelExportName,
    sortedItems,
    t,
  ]);

  const onExportMetrics = React.useCallback(() => {
    if (metricsExportDisabled || !pageMetrics) return;
    const csv = buildMetricsCsv(
      metricKeys,
      pageMetrics,
      datasetMetrics ?? null,
      columnsByKey
    );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    downloadBlob(blob, metricsExportName);
  }, [
    columnsByKey,
    datasetMetrics,
    metricKeys,
    metricsExportDisabled,
    metricsExportName,
    pageMetrics,
  ]);

  return {
    exportDisabled,
    excelExportDisabled,
    metricsExportDisabled,
    onExportCsv,
    onExportExcel,
    onExportMetrics,
  };
}
