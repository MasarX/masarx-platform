import type { ResourceColumn } from "./columns";
import { resolveColumnLabel } from "./columns";
import type { RowDensity } from "./density";
import type { DetailOpenMode } from "./open-mode";
import type { TranslateFn } from "./types";
import { Button } from "../button";
import { Checkbox } from "../checkbox";
import { Input } from "../input";
import { Select } from "../select";
import { cn } from "../utils";

type TableColumnPanelProps = {
  t: TranslateFn;
  columnFilter: string;
  onColumnFilterChange: (value: string) => void;
  onColumnFilterClear: () => void;
  onShowAllColumns: () => void;
  onHideAllColumns: () => void;
  filteredColumns: ResourceColumn[];
  columnOrder: string[];
  visibleColumns: Set<string>;
  pinnedSet: Set<string>;
  columnWidths: Record<string, number>;
  draggingColumn: string | null;
  dragOverColumn: string | null;
  onDragStart: (key: string) => (event: React.DragEvent) => void;
  onDragOver: (key: string) => (event: React.DragEvent) => void;
  onDrop: (key: string) => (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onToggleColumn: (key: string) => void;
  onTogglePin: (key: string) => void;
  onUpdateWidth: (key: string, width: number | null) => void;
  onMoveColumn: (fromIndex: number, toIndex: number) => void;
  minColumnWidth: number;
  resizeStep: number;
  rowDensity: RowDensity;
  onRowDensityChange: (next: RowDensity) => void;
  openMode: DetailOpenMode;
  onOpenModeChange: (next: DetailOpenMode) => void;
  showRowNumbers: boolean;
  onShowRowNumbersChange: (next: boolean) => void;
  showInternalIdHints: boolean;
  onShowInternalIdHintsChange: (next: boolean) => void;
  analyticsEnabled: boolean;
  onAnalyticsToggle: (next: boolean) => void;
  summaryRowEnabled: boolean;
  onSummaryRowToggle: (next: boolean) => void;
  paginationModeOptions: Array<"client" | "server">;
  paginationMode: "client" | "server";
  onPaginationModeChange: (next: "client" | "server") => void;
  pageSize: number | null;
  pageSizeOptions: number[];
  onPageSizeChange: (next: number) => void;
};

export function TableColumnPanel({
  t,
  columnFilter,
  onColumnFilterChange,
  onColumnFilterClear,
  onShowAllColumns,
  onHideAllColumns,
  filteredColumns,
  columnOrder,
  visibleColumns,
  pinnedSet,
  columnWidths,
  draggingColumn,
  dragOverColumn,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onToggleColumn,
  onTogglePin,
  onUpdateWidth,
  onMoveColumn,
  minColumnWidth,
  resizeStep,
  rowDensity,
  onRowDensityChange,
  openMode,
  onOpenModeChange,
  showRowNumbers,
  onShowRowNumbersChange,
  showInternalIdHints,
  onShowInternalIdHintsChange,
  analyticsEnabled,
  onAnalyticsToggle,
  summaryRowEnabled,
  onSummaryRowToggle,
  paginationModeOptions,
  paginationMode,
  onPaginationModeChange,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
}: TableColumnPanelProps) {
  const totalColumnsCount = columnOrder.length;
  const visibleColumnsCount = visibleColumns.size;
  const canShowAllColumns =
    totalColumnsCount > 0 && visibleColumnsCount < totalColumnsCount;
  const canHideAllColumns =
    totalColumnsCount > 1 && visibleColumnsCount > 1;
  return (
    <>
      <div className="mt-4 text-xs font-medium text-ui-muted">
        {t("columns.title")}
      </div>
      <div className="mt-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!canShowAllColumns}
            onClick={onShowAllColumns}
          >
            {t("columns.showAll")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!canHideAllColumns}
            onClick={onHideAllColumns}
          >
            {t("columns.hideAll")}
          </Button>
        </div>
        <div className="relative">
          <Input
            value={columnFilter}
            onChange={(event) => onColumnFilterChange(event.target.value)}
            placeholder={t("columns.searchPlaceholder")}
            aria-label={t("columns.searchAria")}
            data-testid="table-columns-search"
            className="pe-9"
          />
          {columnFilter ? (
            <button
              type="button"
              onClick={onColumnFilterClear}
              aria-label={t("columns.clearAria")}
              className="absolute end-2 top-1/2 -translate-y-1/2 rounded-full px-2 py-1 text-xs text-ui-muted transition hover:text-ui-ink"
            >
              x
            </button>
          ) : null}
        </div>
        {filteredColumns.length === 0 ? (
          <div className="text-sm text-ui-muted">{t("columns.empty")}</div>
        ) : null}
        {filteredColumns.map((column) => {
          const orderIndex = columnOrder.indexOf(column.key);
          const isPinned = pinnedSet.has(column.key);
          const canPin = visibleColumns.has(column.key);
          const hasWidth = columnWidths[column.key] !== undefined;
          const widthValue = columnWidths[column.key];
          const isDragOver = draggingColumn && dragOverColumn === column.key;
          const isDragging = draggingColumn === column.key;
          const columnLabel = resolveColumnLabel(column);
          return (
            <div
              key={column.key}
              className={cn(
                "flex flex-wrap items-center gap-3 rounded-lg border border-transparent px-2 py-2",
                isDragOver && "border-ui-accent/60 bg-ui-accent-soft/30",
                isDragging && "opacity-60"
              )}
              onDragOver={onDragOver(column.key)}
              onDrop={onDrop(column.key)}
            >
              <label className="flex flex-1 items-center gap-2">
                <button
                  type="button"
                  draggable
                  onDragStart={onDragStart(column.key)}
                  onDragEnd={onDragEnd}
                  aria-label={t("columns.dragAria", {
                    label: columnLabel,
                  })}
                  className="cursor-grab rounded bg-transparent p-1 text-ui-muted transition-colors hover:text-ui-ink active:cursor-grabbing"
                >
                  <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
                    <circle cx="5.5" cy="3" r="1.2" /><circle cx="10.5" cy="3" r="1.2" />
                    <circle cx="5.5" cy="8" r="1.2" /><circle cx="10.5" cy="8" r="1.2" />
                    <circle cx="5.5" cy="13" r="1.2" /><circle cx="10.5" cy="13" r="1.2" />
                  </svg>
                  <span className="sr-only">
                    {t("columns.dragAria", { label: columnLabel })}
                  </span>
                </button>
                <Checkbox
                  aria-label={columnLabel}
                  checked={visibleColumns.has(column.key)}
                  onChange={() => onToggleColumn(column.key)}
                />
                <span>{columnLabel}</span>
              </label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!canPin}
                  onClick={() => onTogglePin(column.key)}
                >
                  {isPinned ? t("columns.unpin") : t("columns.pin")}
                </Button>
                <label className="flex items-center gap-2 text-[10px] font-medium text-ui-muted">
                  <span>{t("columns.width")}</span>
                  <Input
                    type="number"
                    min={minColumnWidth}
                    step={resizeStep}
                    value={widthValue ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (!value) {
                        onUpdateWidth(column.key, null);
                        return;
                      }
                      const parsed = Number(value);
                      if (!Number.isFinite(parsed)) return;
                      onUpdateWidth(column.key, parsed);
                    }}
                    aria-label={t("columns.widthAria", {
                      label: columnLabel,
                    })}
                    className="w-20 px-2 py-1 text-xs"
                  />
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!hasWidth}
                  onClick={() => onUpdateWidth(column.key, null)}
                >
                  {t("columns.autoWidth")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={orderIndex <= 0}
                  onClick={() =>
                    onMoveColumn(orderIndex, Math.max(orderIndex - 1, 0))
                  }
                >
                  {t("columns.moveUp")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={orderIndex === -1 || orderIndex === columnOrder.length - 1}
                  onClick={() =>
                    onMoveColumn(
                      orderIndex,
                      Math.min(orderIndex + 1, columnOrder.length - 1)
                    )
                  }
                >
                  {t("columns.moveDown")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 text-xs font-medium text-ui-muted">
        {t("density.title")}
      </div>
      <label className="mt-2 flex min-w-[220px] flex-1 flex-col gap-2">
        <span className="text-[10px] font-medium text-ui-muted">
          {t("density.label")}
        </span>
        <Select
          value={rowDensity}
          onChange={(event) => {
            const next =
              event.target.value === "compact" ? "compact" : "comfortable";
            onRowDensityChange(next);
          }}
          className="w-full"
        >
          <option value="comfortable">{t("density.comfortable")}</option>
          <option value="compact">{t("density.compact")}</option>
        </Select>
      </label>
      <div className="mt-4 text-xs font-medium text-ui-muted">
        {t("openMode.title")}
      </div>
      <label className="mt-2 flex min-w-[220px] flex-1 flex-col gap-2">
        <span className="text-[10px] font-medium text-ui-muted">
          {t("openMode.label")}
        </span>
        <Select
          value={openMode}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "full" || value === "modal") {
              onOpenModeChange(value);
            } else {
              onOpenModeChange("peek");
            }
          }}
          className="w-full"
        >
          <option value="peek">{t("openMode.peek")}</option>
          <option value="full">{t("openMode.full")}</option>
          <option value="modal">{t("openMode.modal")}</option>
        </Select>
        <span className="text-xs text-ui-muted">{t("openMode.helper")}</span>
      </label>
      <div className="mt-4 text-xs font-medium text-ui-muted">
        {t("internalIds.title")}
      </div>
      <label className="mt-2 flex items-center gap-3 text-sm text-ui-ink">
        <Checkbox
          checked={showInternalIdHints}
          onChange={(event) => onShowInternalIdHintsChange(event.target.checked)}
        />
        <span className="text-xs font-medium text-ui-muted">
          {t("internalIds.toggle")}
        </span>
      </label>
      <span className="mt-1 text-xs text-ui-muted">{t("internalIds.helper")}</span>
      <label className="mt-2 flex items-center gap-3 text-sm text-ui-ink">
        <Checkbox
          checked={showRowNumbers}
          onChange={(event) => onShowRowNumbersChange(event.target.checked)}
        />
        <span className="text-xs font-medium text-ui-muted">
          {t("rowNumbers.toggleLabel")}
        </span>
      </label>
      <div className="mt-4 text-xs font-medium text-ui-muted">
        {t("analytics.title")}
      </div>
      <label className="mt-2 flex items-center gap-3 text-sm text-ui-ink">
        <Checkbox
          checked={analyticsEnabled}
          onChange={(event) => onAnalyticsToggle(event.target.checked)}
        />
        <span className="text-xs font-medium text-ui-muted">
          {t("analytics.toggle")}
        </span>
      </label>
      <label className="mt-2 flex items-center gap-3 text-sm text-ui-ink">
        <Checkbox
          checked={summaryRowEnabled}
          onChange={(event) => onSummaryRowToggle(event.target.checked)}
          disabled={!analyticsEnabled}
        />
        <span className="text-xs font-medium text-ui-muted">
          {t("summary.toggle")}
        </span>
      </label>
      <span className="mt-1 text-xs text-ui-muted">{t("summary.helper")}</span>
      {pageSizeOptions.length > 0 ? (
        <>
          <div className="mt-4 text-xs font-medium text-ui-muted">
            {t("paging.title")}
          </div>
          {paginationModeOptions.length > 1 ? (
            <label className="mt-2 flex min-w-[220px] flex-1 flex-col gap-2 text-[10px] font-medium text-ui-muted">
              <span>{t("paging.modeLabel")}</span>
              <Select
                value={paginationMode}
                onChange={(event) =>
                  onPaginationModeChange(
                    event.target.value === "server" ? "server" : "client"
                  )
                }
                className="w-full"
              >
                {paginationModeOptions.map((value) => (
                  <option key={value} value={value}>
                    {value === "client" ? t("paging.client") : t("paging.server")}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <div className="mt-2 text-xs text-ui-muted">
              {paginationMode === "client" ? t("paging.client") : t("paging.server")}
            </div>
          )}
          <label className="mt-2 flex min-w-[220px] flex-1 flex-col gap-2 text-[10px] font-medium text-ui-muted">
            <span>{t("paging.size")}</span>
            <Select
              value={pageSize ?? ""}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="w-full"
            >
              {pageSizeOptions.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </label>
        </>
      ) : null}
    </>
  );
}
