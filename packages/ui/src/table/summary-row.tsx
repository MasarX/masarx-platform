import { cn } from "../utils";
import { CalculationPopover } from "./calculation-popover";
import type { ResourceColumn } from "./columns";
import {
  formatMetricValue,
  getAggregationValue,
  type AggregationType,
  type ResourceMetrics,
} from "./metrics";
import type { TranslateFn } from "./types";

type TableSummaryRowProps = {
  t: TranslateFn;
  selectionEnabled: boolean;
  cellPadding: string;
  displayColumns: ResourceColumn[];
  pinnedOffsets: Record<string, number | undefined>;
  columnWidths: Record<string, number>;
  pinnedCellClass: string;
  numericColumnSet: Set<string>;
  pageMetrics: ResourceMetrics;
  columnAggregations?: Record<string, AggregationType>;
  onSelectAggregation?: (columnKey: string, aggregation: AggregationType) => void;
};

export function TableSummaryRow({
  t,
  selectionEnabled,
  cellPadding,
  displayColumns,
  pinnedOffsets,
  columnWidths,
  pinnedCellClass,
  numericColumnSet,
  pageMetrics,
  columnAggregations,
  onSelectAggregation,
}: TableSummaryRowProps) {
  return (
    <tfoot className="border-t border-t-ui-border/30 text-[11px] text-ui-muted">
      <tr className="sticky bottom-0 z-20 bg-ui-paper/95 backdrop-blur-sm">
        {selectionEnabled ? (
          <td
            className={cn(
              cellPadding,
              "border-e border-ui-border/40 bg-ui-paper/95"
            )}
          />
        ) : null}
        {displayColumns.map((column, colIndex) => {
          const pinnedOffset = pinnedOffsets[column.key];
          const isPinned = pinnedOffset !== undefined;
          const isNumeric = numericColumnSet.has(column.key);
          const metric = pageMetrics.columns[column.key] ?? null;
          const cellStyle = {
            ...(isPinned ? { left: pinnedOffset } : null),
            ...(columnWidths[column.key]
              ? { width: columnWidths[column.key] }
              : null),
          };
          if (colIndex === 0) {
            return (
              <td
                key={`summary-${column.key}`}
                data-pinned={isPinned ? "true" : undefined}
                className={cn(
                  cellPadding,
                  "border-s border-ui-border/30 first:border-s-0",
                  isPinned && pinnedCellClass,
                  "bg-ui-paper/95 font-medium text-ui-ink"
                )}
                style={cellStyle}
              >
                {t("summary.label", { total: pageMetrics.total })}
              </td>
            );
          }
          const aggregationType: AggregationType =
            columnAggregations?.[column.key] ?? "count";
          const aggregationValue = getAggregationValue(metric, aggregationType);
          const displayValue =
            aggregationType === "none"
              ? "\u2014"
              : aggregationType === "count"
                ? String(aggregationValue ?? 0)
                : formatMetricValue(aggregationValue);
          const cellContent = (
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-ui-highlight/40",
                isNumeric && "justify-end"
              )}
            >
              <span className="text-[10px] text-ui-muted/70">
                {t(`calculation.${aggregationType}`)}
              </span>
              <span className="tabular-nums">{displayValue}</span>
            </button>
          );
          return (
            <td
              key={`summary-${column.key}`}
              data-pinned={isPinned ? "true" : undefined}
              className={cn(
                cellPadding,
                "border-s border-ui-border/30 first:border-s-0",
                isPinned && pinnedCellClass,
                "bg-ui-paper/95",
                isNumeric && "text-right tabular-nums"
              )}
              style={cellStyle}
            >
              {onSelectAggregation ? (
                <CalculationPopover
                  t={t}
                  columnKey={column.key}
                  selected={aggregationType}
                  onSelect={onSelectAggregation}
                >
                  {cellContent}
                </CalculationPopover>
              ) : (
                cellContent
              )}
            </td>
          );
        })}
      </tr>
    </tfoot>
  );
}
