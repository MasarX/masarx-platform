"use client";
import * as React from "react";

import type { ResourceColumn } from "./columns";
import type { AggregationType, ResourceMetrics } from "./metrics";
import type { DisplayRow } from "./row-types";
import type { SortState } from "./sorting";
import type { TranslateFn } from "./types";
import type { RowDensity } from "./density";
import type { ColumnMenuAction } from "./column-header-menu";
import type { ResizeGuide } from "./resize-guide";
import { TableBody } from "./body";
import { TableHeaderRow } from "./header-row";
import { TableResizeGuide } from "./resize-guide";
import { TableSummaryRow } from "./summary-row";
import { cn } from "../utils";

type TableViewportProps = {
  t: TranslateFn;
  tableContainerRef: React.RefObject<HTMLDivElement | null>;
  rowDensity: RowDensity;
  showRowNumbers?: boolean;
  selectionEnabled: boolean;
  selectionReady?: boolean;
  resourceLabel?: string | null;
  createHref?: string | null;
  selectHeaderRef: React.RefObject<HTMLTableHeaderCellElement | null>;
  selectAllRef: React.RefObject<HTMLInputElement | null>;
  allSelected: boolean;
  onToggleAll: () => void;
  displayColumns: ResourceColumn[];
  sortState: SortState[];
  onSort: (key: string, isMulti: boolean) => void;
  numericColumnSet: Set<string>;
  pinnedOffsets: Record<string, number | undefined>;
  columnWidths: Record<string, number>;
  pinnedHeaderClass: string;
  pinnedCellClass: string;
  cellPadding: string;
  registerHeaderRef: (
    key: string
  ) => (node: HTMLTableHeaderCellElement | null) => void;
  onResizeStart: (key: string, event: React.MouseEvent<HTMLButtonElement>) => void;
  onResizeKey: (key: string, event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onUpdateWidth: (key: string, nextWidth: number | null) => void;
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
  showSummaryRow: boolean;
  pageMetrics: ResourceMetrics;
  resizeGuide: ResizeGuide | null;
  onCreateRow?: () => void;
  createRowLabel?: string;
  pinnedSet?: Set<string>;
  onColumnMenuAction?: (action: ColumnMenuAction, columnKey: string) => void;
  columnAggregations?: Record<string, AggregationType>;
  onSelectAggregation?: (columnKey: string, aggregation: AggregationType) => void;
};

export const TableViewport = React.memo(function TableViewport({
  t,
  tableContainerRef,
  rowDensity,
  showRowNumbers,
  selectionEnabled,
  selectionReady = true,
  resourceLabel,
  createHref,
  selectHeaderRef,
  selectAllRef,
  allSelected,
  onToggleAll,
  displayColumns,
  sortState,
  onSort,
  numericColumnSet,
  pinnedOffsets,
  columnWidths,
  pinnedHeaderClass,
  pinnedCellClass,
  cellPadding,
  registerHeaderRef,
  onResizeStart,
  onResizeKey,
  onUpdateWidth,
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
  showSummaryRow,
  pageMetrics,
  resizeGuide,
  onCreateRow,
  createRowLabel,
  pinnedSet,
  onColumnMenuAction,
  columnAggregations,
  onSelectAggregation,
}: TableViewportProps) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-ui-border/15 bg-transparent">
      <div
        ref={tableContainerRef as React.Ref<HTMLDivElement>}
        className="table-scrollbar relative max-h-[calc(100vh-14rem)] overflow-auto"
      >
        <table
          className={cn(
            "min-w-full border-collapse text-left",
            rowDensity === "compact" ? "text-xs" : "text-sm"
          )}
        >
          <TableHeaderRow
            t={t}
            showRowNumbers={showRowNumbers}
            selectionEnabled={selectionEnabled}
            selectionReady={selectionReady}
            selectHeaderRef={selectHeaderRef}
            selectAllRef={selectAllRef}
            allSelected={allSelected}
            onToggleAll={onToggleAll}
            displayColumns={displayColumns}
            sortState={sortState}
            onSort={onSort}
            numericColumnSet={numericColumnSet}
            pinnedOffsets={pinnedOffsets}
            columnWidths={columnWidths}
            pinnedHeaderClass={pinnedHeaderClass}
            cellPadding={cellPadding}
            registerHeaderRef={registerHeaderRef}
            onResizeStart={onResizeStart}
            onResizeKey={onResizeKey}
            onUpdateWidth={onUpdateWidth}
            pinnedSet={pinnedSet}
            onColumnMenuAction={onColumnMenuAction}
          />
          <TableBody
            t={t}
            rowDensity={rowDensity}
            noColumnsSelected={noColumnsSelected}
            isEmpty={isEmpty}
            emptyMessage={emptyMessage}
            emptyAction={emptyAction}
            resourceLabel={resourceLabel}
            createHref={createHref}
            noColumnsAction={noColumnsAction}
            clientFilterActive={clientFilterActive}
            safeColumnCount={safeColumnCount}
            paddingTop={paddingTop}
            paddingBottom={paddingBottom}
            rowsToRender={rowsToRender}
            displayRows={displayRows}
            renderRow={renderRow}
            onCreateRow={onCreateRow}
            createRowLabel={createRowLabel}
          />
          {showSummaryRow ? (
            <TableSummaryRow
              t={t}
              selectionEnabled={selectionEnabled}
              cellPadding={cellPadding}
              displayColumns={displayColumns}
              pinnedOffsets={pinnedOffsets}
              columnWidths={columnWidths}
              pinnedCellClass={pinnedCellClass}
              numericColumnSet={numericColumnSet}
              pageMetrics={pageMetrics}
              columnAggregations={columnAggregations}
              onSelectAggregation={onSelectAggregation}
            />
          ) : null}
        </table>
        <TableResizeGuide guide={resizeGuide} />
      </div>
    </div>
  );
});

TableViewport.displayName = "TableViewport";
