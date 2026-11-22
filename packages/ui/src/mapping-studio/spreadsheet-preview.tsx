"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

type SpreadsheetPreviewProps = {
  columns: string[];
  sampleRows: Record<string, unknown>[];
  columnLimit?: number;
  sampleRowLimit?: number;
};

export function SpreadsheetPreview({
  columns,
  sampleRows,
  columnLimit = columns.length,
  sampleRowLimit = 5,
}: SpreadsheetPreviewProps) {
  const t = useTranslations("ui.tabularFile");
  const previewId = React.useId();
  const [showAllColumns, setShowAllColumns] = React.useState(false);
  const initialColumns = columns.slice(0, Math.max(1, columnLimit));
  const visibleColumns = showAllColumns ? columns : initialColumns;
  const visibleRows = sampleRows.slice(0, Math.max(1, sampleRowLimit));
  const hasColumnLimit = initialColumns.length < columns.length;

  return (
    <div className="space-y-3">
      <div id={`${previewId}-label`} className="text-sm font-medium text-ui-ink">Spreadsheet preview</div>
      {columns.length === 0 ? (
        <p className="text-sm text-ui-muted">Upload a CSV/XLSX file to inspect headers and sample rows.</p>
      ) : (
        <>
          {hasColumnLimit ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-ui-muted">
              <span>{t("previewColumnCount", { shown: visibleColumns.length, total: columns.length })}</span>
              <button
                type="button"
                className="rounded px-2 py-1 font-medium underline"
                aria-expanded={showAllColumns}
                aria-controls={previewId}
                onClick={() => setShowAllColumns((expanded) => !expanded)}
              >
                {showAllColumns ? t("previewShowFirstColumns", { count: initialColumns.length }) : t("previewShowAllColumns")}
              </button>
            </div>
          ) : null}
          <div
            id={previewId}
            role="region"
            aria-labelledby={`${previewId}-label`}
            tabIndex={0}
            className="overflow-auto rounded-xl border border-ui-border/60 bg-ui-surface/70"
          >
            <table className="min-w-full border-collapse text-left text-xs text-ui-ink">
              <thead className="border-b border-ui-border bg-ui-paper/70 text-ui-muted">
                <tr>
                  {visibleColumns.map((column) => (
                    <th key={column} scope="col" className="px-3 py-2 font-medium">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, index) => (
                  <tr key={index} className="border-b border-ui-border/30 last:border-b-0">
                    {visibleColumns.map((column) => (
                      <td key={column} className="px-3 py-2 align-top text-ui-muted">
                        {row[column] == null ? "" : String(row[column])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
