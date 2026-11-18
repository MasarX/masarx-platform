"use client";

import * as React from "react";
import type { SortState } from "./sorting";
import type { ResourceColumn } from "./columns";
import type { TranslateFn } from "./types";
import type { ColumnMenuAction } from "./column-header-menu";
import { ColumnHeaderMenu } from "./column-header-menu";
import { resolveColumnLabel } from "./columns";
import { cn } from "../utils";
import { Checkbox } from "../checkbox";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ColumnTypeBooleanIcon,
  ColumnTypeDateIcon,
  ColumnTypeIdIcon,
  ColumnTypeNumberIcon,
  ColumnTypeSelectIcon,
  ColumnTypeTextIcon,
} from "../icons";

function resolveColumnTypeIcon(column: ResourceColumn) {
  const raw = String(column.renderType ?? column.editType ?? "").toLowerCase();
  if (raw.includes("bool")) return <ColumnTypeBooleanIcon className="text-ui-muted" />;
  if (raw.includes("date")) return <ColumnTypeDateIcon className="text-ui-muted" />;
  if (raw.includes("select") || raw.includes("enum")) return <ColumnTypeSelectIcon className="text-ui-muted" />;
  if (raw === "id" || raw.includes("uuid")) return <ColumnTypeIdIcon className="text-ui-muted" />;
  if (
    raw.includes("number") ||
    raw.includes("int") ||
    raw.includes("float") ||
    raw.includes("currency") ||
    raw.includes("decimal")
  ) return <ColumnTypeNumberIcon className="text-ui-muted" />;
  return <ColumnTypeTextIcon className="text-ui-muted" />;
}

type TableHeaderRowProps = {
  t: TranslateFn;
  showRowNumbers?: boolean;
  selectionEnabled: boolean;
  selectionReady?: boolean;
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
  cellPadding: string;
  registerHeaderRef: (key: string) => (
    node: HTMLTableHeaderCellElement | null
  ) => void;
  onResizeStart: (key: string, event: React.MouseEvent<HTMLButtonElement>) => void;
  onResizeKey: (key: string, event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onUpdateWidth: (key: string, nextWidth: number | null) => void;
  pinnedSet?: Set<string>;
  onColumnMenuAction?: (action: ColumnMenuAction, columnKey: string) => void;
};

export function TableHeaderRow({
  t,
  showRowNumbers,
  selectionEnabled,
  selectionReady = true,
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
  cellPadding,
  registerHeaderRef,
  onResizeStart,
  onResizeKey,
  onUpdateWidth,
  pinnedSet,
  onColumnMenuAction,
}: TableHeaderRowProps) {
  return (
    <thead className="sticky top-0 z-20 text-xs font-medium text-ui-muted" style={{ backgroundColor: "var(--table-header-bg)" }}>
      <tr className="border-b border-b-ui-border/30">
        {selectionEnabled ? (
          <th
            ref={selectHeaderRef as React.Ref<HTMLTableHeaderCellElement>}
            className={cn("font-medium", cellPadding, "border-e border-ui-border/20")}
          >
            <Checkbox
              ref={selectAllRef as React.Ref<HTMLInputElement>}
              aria-label={t("selection.selectAllAria")}
              checked={allSelected}
              disabled={!selectionReady}
              className="h-3.5 w-3.5 rounded-[3px]"
              onChange={onToggleAll}
            />
          </th>
        ) : null}
        {showRowNumbers ? (
          <th
            className={cn("font-medium text-center w-10", cellPadding, "border-e border-ui-border/20")}
          >
            <span className="text-[10px] text-ui-muted">{t("rowNumbers.header")}</span>
          </th>
        ) : null}
        {displayColumns.map((column) => {
          const sortIndex = sortState.findIndex((entry) => entry.key === column.key);
          const sortEntry = sortIndex >= 0 ? sortState[sortIndex] : null;
          const isSorted = Boolean(sortEntry);
          const sortIcon = sortEntry
            ? sortEntry.direction === "asc"
              ? <ChevronUpIcon className="h-3 w-3 transition-transform duration-200" />
              : <ChevronDownIcon className="h-3 w-3 transition-transform duration-200" />
            : null;
          const ariaSort = sortEntry
            ? sortEntry.direction === "asc"
              ? "ascending"
              : "descending"
            : "none";
          const isNumeric = numericColumnSet.has(column.key);
          const pinnedOffset = pinnedOffsets[column.key];
          const isPinned = pinnedOffset !== undefined;
          const widthStyle = columnWidths[column.key];
          const columnStyle = {
            ...(isPinned ? { left: pinnedOffset } : null),
            ...(widthStyle ? { width: widthStyle } : null),
          };
          const widthTitle = widthStyle
            ? t("columns.widthTitle", { width: Math.round(widthStyle) })
            : undefined;
          return (
            <th
              key={column.key}
              ref={registerHeaderRef(column.key)}
              data-pinned={isPinned ? "true" : undefined}
              aria-sort={ariaSort}
              className={cn(
                "group/header font-medium transition-colors hover:bg-ui-highlight/30",
                cellPadding,
                "border-s border-ui-border/15 first:border-s-0",
                isPinned && pinnedHeaderClass,
                isNumeric && "text-right"
              )}
              style={columnStyle}
              title={widthTitle}
            >
              <div
                className="flex items-center gap-2"
                style={columnWidths[column.key] ? { width: columnWidths[column.key] } : undefined}
              >
                <button
                  type="button"
                  onClick={(event) => onSort(column.key, event.shiftKey)}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2",
                    isSorted ? "text-ui-accent" : "text-ui-muted",
                    isNumeric && "justify-end"
                  )}
                >
                  <span className="flex-none">{resolveColumnTypeIcon(column)}</span>
                  <span className="truncate">{resolveColumnLabel(column)}</span>
                  {sortIcon ? (
                    <span className="inline-flex items-center gap-0.5 text-ui-muted">
                      {sortIcon}
                      {sortState.length > 1 ? (
                        <span className="text-[10px]">{sortIndex + 1}</span>
                      ) : null}
                    </span>
                  ) : null}
                </button>
                {onColumnMenuAction ? (
                  <ColumnHeaderMenu
                    t={t}
                    column={column}
                    isPinned={pinnedSet?.has(column.key) ?? false}
                    onAction={onColumnMenuAction}
                    trigger={
                      <button
                        type="button"
                        aria-label={t("columnMenu.menuAria", { label: resolveColumnLabel(column) })}
                        className="inline-flex h-5 w-5 flex-none items-center justify-center rounded text-ui-muted opacity-0 transition-all hover:bg-ui-highlight/50 hover:text-ui-ink group-hover/header:opacity-100 focus-visible:opacity-100"
                      >
                        <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
                          <circle cx="4" cy="8" r="1.2" />
                          <circle cx="8" cy="8" r="1.2" />
                          <circle cx="12" cy="8" r="1.2" />
                        </svg>
                      </button>
                    }
                  />
                ) : null}
                <button
                  type="button"
                  onMouseDown={(event) => onResizeStart(column.key, event)}
                  onKeyDown={(event) => onResizeKey(column.key, event)}
                  onDoubleClick={() => onUpdateWidth(column.key, null)}
                  aria-label={t("columns.resizeAria", { label: resolveColumnLabel(column) })}
                  title={t("columns.resizeHint")}
                  className="h-full w-1 cursor-col-resize rounded-full bg-ui-border/40 opacity-0 transition-all hover:bg-ui-accent/60 group-hover/header:opacity-100 focus-visible:opacity-100"
                />
              </div>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}
