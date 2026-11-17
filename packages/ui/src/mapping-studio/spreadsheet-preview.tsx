"use client";

import * as React from "react";

type SpreadsheetPreviewProps = {
  columns: string[];
  sampleRows: Record<string, unknown>[];
};

export function SpreadsheetPreview({
  columns,
  sampleRows,
}: SpreadsheetPreviewProps) {
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-ui-ink">Spreadsheet preview</div>
      {columns.length === 0 ? (
        <p className="text-sm text-ui-muted">Upload a CSV/XLSX file to inspect headers and sample rows.</p>
      ) : (
        <div className="overflow-auto rounded-xl border border-ui-border/60 bg-ui-surface/70">
          <table className="min-w-full border-collapse text-left text-xs text-ui-ink">
            <thead className="border-b border-ui-border bg-ui-paper/70 text-ui-muted">
              <tr>
                {columns.map((column) => (
                  <th key={column} className="px-3 py-2 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sampleRows.slice(0, 5).map((row, index) => (
                <tr key={`${index}`} className="border-b border-ui-border/30 last:border-b-0">
                  {columns.map((column) => (
                    <td key={`${index}-${column}`} className="px-3 py-2 align-top text-ui-muted">
                      {row[column] == null ? "" : String(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
