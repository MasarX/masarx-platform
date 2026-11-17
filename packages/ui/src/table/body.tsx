"use client";

import type { DisplayRow } from "./row-types";
import type { RowDensity } from "./density";
import type { TranslateFn } from "./types";
import { EmptyState } from "../empty-state";
import { PlusIcon } from "../icons";
import { cn } from "../utils";

function EmptyTableIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 48 48"
      className="h-10 w-10 text-ui-muted/40"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="6" y="10" width="36" height="28" rx="3" />
      <path d="M6 18h36" />
      <path d="M18 18v20" />
      <path d="M30 18v20" />
      <path d="M6 26h36" />
      <path d="M6 34h36" />
    </svg>
  );
}

function EmptySearchIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 48 48"
      className="h-10 w-10 text-ui-muted/40"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="22" cy="22" r="12" />
      <path d="M31 31l9 9" />
      <path d="M18 19h8" />
      <path d="M18 25h5" />
    </svg>
  );
}

function NoColumnsIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 48 48"
      className="h-10 w-10 text-ui-muted/40"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="6" y="10" width="36" height="28" rx="3" />
      <path d="M6 18h36" />
      <path d="M17 28l14 0" opacity="0.4" strokeDasharray="3 3" />
      <path d="M20 34l8 0" opacity="0.4" strokeDasharray="3 3" />
    </svg>
  );
}

type TableBodyProps = {
  t: TranslateFn;
  rowDensity: RowDensity;
  noColumnsSelected: boolean;
  isEmpty: boolean;
  emptyMessage?: string | null;
  emptyAction?: React.ReactNode;
  noColumnsAction?: React.ReactNode;
  clientFilterActive: boolean;
  safeColumnCount: number;
  paddingTop: number;
  paddingBottom: number;
  rowsToRender: Array<{ index: number }>;
  displayRows: DisplayRow[];
  renderRow: (row: DisplayRow, rowIndex: number) => React.ReactNode;
  onCreateRow?: () => void;
  createRowLabel?: string;
};

export function TableBody({
  t,
  rowDensity,
  noColumnsSelected,
  isEmpty,
  emptyMessage,
  emptyAction,
  noColumnsAction,
  clientFilterActive,
  safeColumnCount,
  paddingTop,
  paddingBottom,
  rowsToRender,
  displayRows,
  renderRow,
  onCreateRow,
  createRowLabel,
}: TableBodyProps) {
  const emptyPadding = cn("px-6", rowDensity === "compact" ? "py-8" : "py-12");
  return (
    <tbody>
      {noColumnsSelected ? (
        <tr className="border-t border-ui-border/40">
          <td colSpan={safeColumnCount} className={emptyPadding}>
            <EmptyState
              variant="inline"
              icon={<NoColumnsIcon />}
              title={t("table.noColumns")}
              description={t("table.noColumnsHint")}
              action={noColumnsAction}
            />
          </td>
        </tr>
      ) : isEmpty ? (
        <tr className="border-t border-ui-border/40">
          <td colSpan={safeColumnCount} className={emptyPadding}>
            <EmptyState
              variant="inline"
              icon={clientFilterActive ? <EmptySearchIcon /> : <EmptyTableIcon />}
              title={
                clientFilterActive
                  ? t("table.noSearchResults")
                  : emptyMessage ?? t("table.noRecords")
              }
              description={
                clientFilterActive
                  ? t("table.noSearchResultsHint")
                  : t("table.noRecordsHint")
              }
              action={emptyAction}
            />
          </td>
        </tr>
      ) : (
        <>
          {paddingTop > 0 ? (
            <tr className="border-0">
              <td colSpan={safeColumnCount} style={{ height: paddingTop }} />
            </tr>
          ) : null}
          {rowsToRender.map((virtualRow) => {
            const row = displayRows[virtualRow.index];
            const rowIndex = virtualRow.index;
            if (!row) return null;
            return renderRow(row, rowIndex);
          })}
          {onCreateRow ? (
            <tr className="border-t border-ui-border/40">
              <td colSpan={safeColumnCount} className="px-2 py-1.5">
                <button
                  type="button"
                  onClick={onCreateRow}
                  className="flex items-center gap-2 text-xs text-ui-muted transition hover:text-ui-ink"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  <span>{createRowLabel}</span>
                </button>
              </td>
            </tr>
          ) : null}
          {paddingBottom > 0 ? (
            <tr className="border-0">
              <td colSpan={safeColumnCount} style={{ height: paddingBottom }} />
            </tr>
          ) : null}
        </>
      )}
    </tbody>
  );
}
