"use client";

import { memo } from "react";

import type { CellDisplay } from "./cell-display";
import type { EditConfig, InlineEditState } from "./editing";
import type { DisplayRow } from "./row-types";
import type { ResourceColumn } from "./columns";
import type { TranslateFn } from "./types";
import { resolveDisplayIdentifier } from "../display-identifiers";
import {
  formatIdValue,
  formatReferenceValue,
  resolveRecordDescriptor,
  resolveRecordLabel,
} from "../resource-utils";
import { resolveColumnLabel } from "./columns";
import { cn } from "../utils";
import { Checkbox } from "../checkbox";
import { buildHref } from "../url";
import { InlineEditor } from "./inline-editor";
import {
  CellBooleanDisplay,
  CellMultiSelect,
  CellSelectTag,
  resolveRenderType,
} from "./cell-renderers";
import { renderTypedCell } from "./cell-renderer-dispatch";
import { conditionalStyleToCss, evaluateConditionalFormatting } from "./conditional-formatting";
import type { ConditionalFormattingRule } from "./view-types";

type DataRow = Extract<DisplayRow, { type: "row" }>;

type TableDataRowProps = {
  t: TranslateFn;
  row: DataRow;
  rowIndex: number;
  showRowNumbers?: boolean;
  idKey?: string | null;
  baseHref?: string | null;
  resolveRowHref?: (rowId: string) => string | null;
  selectionEnabled: boolean;
  selectionReady?: boolean;
  selectedIds: Set<string>;
  cellPadding: string;
  displayColumns: ResourceColumn[];
  pinnedOffsets: Record<string, number | undefined>;
  columnWidths: Record<string, number>;
  pinnedCellClass: string;
  conditionalFormatting?: ConditionalFormattingRule[] | null;
  numericColumnSet: Set<string>;
  hasGrouping: boolean;
  editConfigByKey: Map<string, EditConfig>;
  inlineEdit: InlineEditState | null;
  editPending: boolean;
  updateInlineEditValue: (value: string | boolean | string[]) => void;
  cancelInlineEdit: () => void;
  commitInlineEdit: () => void;
  startInlineEdit: (rowId: string, column: ResourceColumn, value: unknown) => void;
  toggleRowExpanded: (rowKey: string) => void;
  resolveRowKey: (item: Record<string, unknown>, fallback: string) => string;
  resolveCellDisplay: (item: Record<string, unknown>, column: ResourceColumn) => CellDisplay;
  expandedRowIds: Set<string>;
  onSelectRow: (rowIndex: number, rowId: string, isRange: boolean) => void;
  onNavigate: (href: string) => void;
  onContextMenu?: (event: React.MouseEvent, rowId: string, rowData: Record<string, unknown>) => void;
};

function TableDataRowContent({
  t,
  row,
  rowIndex,
  idKey,
  baseHref,
  resolveRowHref,
  selectionEnabled,
  selectionReady = true,
  selectedIds,
  cellPadding,
  displayColumns,
  pinnedOffsets,
  columnWidths,
  pinnedCellClass,
  conditionalFormatting,
  numericColumnSet,
  hasGrouping,
  editConfigByKey,
  inlineEdit,
  editPending,
  updateInlineEditValue,
  cancelInlineEdit,
  commitInlineEdit,
  startInlineEdit,
  toggleRowExpanded,
  resolveRowKey,
  resolveCellDisplay,
  expandedRowIds,
  onSelectRow,
  onNavigate,
  onContextMenu,
  showRowNumbers,
}: TableDataRowProps) {
  const item = row.item;
  const idValue = idKey ? item[idKey] : undefined;
  const rowId =
    idValue !== null && idValue !== undefined ? String(idValue) : null;
  const rowKey = resolveRowKey(item, row.id);
  const rowHref =
    rowId && (resolveRowHref || (baseHref && idKey))
      ? resolveRowHref?.(rowId) ??
        (baseHref ? buildHref(baseHref, { id: rowId }) : null)
      : null;
  const rowExpanded = expandedRowIds.has(rowKey);
  const rowLabel = resolveRecordLabel(item);
  const rowDisplayIdentifier = resolveDisplayIdentifier(item, {
    fallback: rowId ?? rowKey,
  });
  const rowDescriptor = resolveRecordDescriptor(item);
  const rowFallbackIdentifier =
    idValue !== null && idValue !== undefined
      ? formatReferenceValue(String(idValue))
      : formatReferenceValue(rowKey);
  const rowFriendlyIdentifier =
    rowLabel ??
    rowDisplayIdentifier?.value ??
    rowDescriptor ??
    rowFallbackIdentifier;
  const rowToggleLabel = rowFriendlyIdentifier ?? formatIdValue(rowKey);
  const usesLinkedDetail = Boolean(rowHref);
  const rowToggleAria = usesLinkedDetail
    ? t("detail.openAria", { label: rowToggleLabel })
    : rowExpanded
      ? t("detail.collapseAria", { label: rowToggleLabel })
      : t("detail.expandAria", { label: rowToggleLabel });
  const rowToggleLabelText = usesLinkedDetail
    ? t("detail.openLabel")
    : rowExpanded
      ? t("detail.collapseLabel")
      : t("detail.expandLabel");
  const rowSelected = rowId ? selectedIds.has(rowId) : false;
  const conditionalStyles = evaluateConditionalFormatting(item, conditionalFormatting);
  const rowStyle = conditionalStyleToCss(conditionalStyles.row);
  // Keep the selection background visible while retaining conditional foreground styles.
  const selectionStyle = rowSelected ? { backgroundColor: undefined } : undefined;
  const rowHighlightClass = rowSelected ? "bg-ui-accent/5" : null;
  const rowClickable = Boolean(rowHref);
  const rowSurfaceClass = rowSelected
    ? "bg-ui-accent/5"
    : "bg-transparent";

  const handleRowClick = (event: React.MouseEvent<HTMLTableRowElement>) => {
    if (!rowHref) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("button,a,input,select,textarea,[role='button'],[role='link'],[data-editable='true']")
    ) {
      return;
    }
    onNavigate(rowHref);
  };

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (!rowHref) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("button,a,input,select,textarea,[role='button'],[role='link'],[data-editable='true']")
    ) {
      return;
    }
    event.preventDefault();
    onNavigate(rowHref);
  };

  const rowToggleIcon = usesLinkedDetail ? (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 4h8v8" />
      <path d="M16 4l-9 9" />
      <path d="M6 8v8h8" />
    </svg>
  ) : (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={cn("h-4 w-4 transition-transform", rowExpanded && "rotate-180")}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5.5 8l4.5 4.5L14.5 8" />
    </svg>
  );

  return (
    <tr
      key={`${String(idValue ?? rowIndex)}-${row.id}`}
      className={cn(
        "group transition-colors duration-150",
        "border-s-2",
        rowSelected ? "border-s-ui-accent" : "border-s-transparent",
        rowSurfaceClass,
        !rowSelected && "hover:bg-[--table-hover-bg]",
        rowClickable &&
          "cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent/20 focus-visible:ring-offset-0",
        rowSelected && "bg-ui-accent/5"
      )}
      style={{
        borderBottom: "1px solid var(--table-row-separator)",
        ...rowStyle,
        ...selectionStyle,
      }}
      aria-selected={rowSelected}
      onClick={rowClickable ? handleRowClick : undefined}
      onKeyDown={rowClickable ? handleRowKeyDown : undefined}
      onContextMenu={onContextMenu && rowId ? (event) => {
        event.preventDefault();
        onContextMenu(event, rowId, item);
      } : undefined}
      tabIndex={rowClickable ? 0 : undefined}
    >
      {selectionEnabled ? (
        <td className={cn(cellPadding, "border-e border-ui-border/15", rowHighlightClass)}>
          <Checkbox
            aria-label={t("selection.rowAria", {
              id: rowFriendlyIdentifier ?? String(idValue ?? rowIndex),
            })}
            checked={rowSelected}
            disabled={!selectionReady}
            className={cn(
              "h-3.5 w-3.5 rounded-[3px]",
              "transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
              rowSelected && "opacity-100"
            )}
            readOnly
            onClick={(event) => {
              if (!selectionReady) return;
              if (idValue === null || idValue === undefined) return;
              onSelectRow(rowIndex, String(idValue), event.shiftKey);
            }}
          />
        </td>
      ) : null}
      {showRowNumbers ? (
        <td className={cn(cellPadding, "border-e border-ui-border/15 text-center text-[10px] text-ui-muted tabular-nums w-10", rowHighlightClass)}>
          {rowIndex + 1}
        </td>
      ) : null}
      {displayColumns.map((column, colIndex) => {
        const pinnedOffset = pinnedOffsets[column.key];
        const isPinned = pinnedOffset !== undefined;
        const isNumeric = numericColumnSet.has(column.key);
        const isPrimaryColumn = colIndex === 0;
        const indentStyle =
          hasGrouping && isPrimaryColumn
            ? { paddingLeft: `${row.depth * 16}px` }
            : undefined;
        const editConfig = editConfigByKey.get(column.key);
        const isPrimaryIdentifierColumn = Boolean(idKey && column.key === idKey);
        const isEditable = Boolean(editConfig && rowId && !isPrimaryIdentifierColumn);
        const isEditing = Boolean(
          editConfig &&
            rowId &&
            !isPrimaryIdentifierColumn &&
            inlineEdit &&
            inlineEdit.rowId === rowId &&
            inlineEdit.columnKey === column.key
        );
        const editLabel = resolveColumnLabel(column);
        const cellDisplay = resolveCellDisplay(item, column);
        const rawValue = item[column.key];
        const conditionalStyle = {
          ...rowStyle,
          ...conditionalStyleToCss(conditionalStyles.cells[column.key]),
        };
        const cellBody = renderTypedCell(
          column, rawValue, cellDisplay, isPrimaryColumn, conditionalStyle.color
        );
        const linkBody =
          rowHref && isPrimaryColumn ? (
            <a
              className="text-ui-ink hover:underline"
              style={conditionalStyle.color ? { color: conditionalStyle.color } : undefined}
              href={rowHref}
              onClick={(event) => {
                if (event.defaultPrevented) return;
                if (event.button !== 0) return;
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                onNavigate(rowHref);
              }}
            >
              {cellBody}
            </a>
          ) : (
            cellBody
          );
        const editField =
          isEditing && inlineEdit && editConfig ? (
            <InlineEditor
              t={t}
              editState={inlineEdit}
              editConfig={editConfig}
              editLabel={editLabel}
              editPending={editPending}
              onUpdateValue={updateInlineEditValue}
              onCommit={commitInlineEdit}
              onCancel={cancelInlineEdit}
            />
          ) : null;
        const contentBase = isPrimaryColumn ? (
          <div className="flex items-start gap-2" style={indentStyle}>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (rowHref) {
                  onNavigate(rowHref);
                  return;
                }
                toggleRowExpanded(rowKey);
              }}
              aria-label={rowToggleAria}
              title={rowToggleAria}
              className={cn(
                "mt-0.5 inline-flex h-7 w-7 flex-none items-center justify-center rounded-md text-ui-muted transition hover:bg-ui-highlight hover:text-ui-ink",
                "sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
                rowExpanded && "opacity-100 text-ui-ink"
              )}
            >
              {rowToggleIcon}
              <span className="sr-only">{rowToggleLabelText}</span>
            </button>
            {linkBody}
          </div>
        ) : (
          linkBody
        );
        const handleCellDoubleClick = isEditable && !isEditing
          ? (event: React.MouseEvent) => {
              event.stopPropagation();
              if (!rowId) return;
              startInlineEdit(rowId, column, item[column.key]);
            }
          : undefined;
        const content = isEditing ? (
          editField
        ) : (
          contentBase
        );
        return (
          <td
            key={`${column.key}-${row.id}`}
            data-column-key={column.key}
            data-testid={
              isPrimaryIdentifierColumn ? "resource-table-primary-identifier" : undefined
            }
            data-editable={isEditable ? "true" : "false"}
            data-pinned={isPinned ? "true" : undefined}
            onDoubleClick={handleCellDoubleClick}
            className={cn(
              cellPadding,
              "border-l border-ui-border/10 first:border-l-0",
              isPinned && pinnedCellClass,
              isNumeric && "text-right tabular-nums",
              isEditable && !isEditing && "cursor-default",
              rowHighlightClass
            )}
            style={{
              ...(isPinned ? { left: pinnedOffset } : null),
              ...(columnWidths[column.key] ? { width: columnWidths[column.key] } : null),
              ...conditionalStyle,
              ...selectionStyle,
            }}
          >
            {content}
          </td>
        );
      })}
    </tr>
  );
}

export const TableDataRow = memo(TableDataRowContent);
