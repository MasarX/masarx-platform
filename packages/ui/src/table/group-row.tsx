"use client";

import { cn } from "../utils";
import { ChevronDownIcon } from "../icons";
import { resolveColumnLabelByKey, type ResourceColumn } from "./columns";
import { formatMetricValue, formatPercentValue, type ResourceMetrics } from "./metrics";
import type { GroupRow } from "./grouping";
import type { TranslateFn } from "./types";

type GroupHeaderRow = Extract<GroupRow, { type: "group" }>;

type TableGroupRowProps = {
  t: TranslateFn;
  row: GroupHeaderRow;
  resolvedGroupBy: string[];
  columnsByKey: Map<string, ResourceColumn>;
  displayColumns: ResourceColumn[];
  selectionEnabled: boolean;
  showRowNumbers?: boolean;
  cellPadding: string;
  pinnedOffsets: Record<string, number | undefined>;
  columnWidths: Record<string, number>;
  pinnedGroupClass: string;
  numericColumnSet: Set<string>;
  pageMetrics: ResourceMetrics;
  analyticsEnabled: boolean;
  safeColumnCount: number;
  collapsedGroups: Set<string>;
  onToggleCollapse: (groupId: string) => void;
};

export function TableGroupRow({
  t,
  row,
  resolvedGroupBy,
  columnsByKey,
  displayColumns,
  selectionEnabled,
  showRowNumbers,
  cellPadding,
  pinnedOffsets,
  columnWidths,
  pinnedGroupClass,
  numericColumnSet,
  pageMetrics,
  analyticsEnabled,
  safeColumnCount,
  collapsedGroups,
  onToggleCollapse,
}: TableGroupRowProps) {
  const metricsByColumn = row.metrics?.columns ?? null;
  const isCollapsed = collapsedGroups.has(row.groupId);
  const toggleLabel = isCollapsed
    ? t("group.toggleExpand")
    : t("group.toggleCollapse");
  const groupKey = resolvedGroupBy[row.depth] ?? null;
  const groupKeyLabel = groupKey
    ? resolveColumnLabelByKey(columnsByKey, groupKey)
    : t("group.labelFallback");
  const groupPercent =
    pageMetrics.total > 0 ? (row.count / pageMetrics.total) * 100 : null;
  const groupPercentLabel = formatPercentValue(groupPercent);
  const groupMeta = groupPercentLabel
    ? t("group.metaWithShare", {
        count: row.count,
        share: groupPercentLabel,
      })
    : t("group.meta", { count: row.count });
  const groupTitle = t("group.title", {
    label: groupKeyLabel,
    value: row.label,
    meta: groupMeta,
  });
  const toggleDescription = t("group.description", {
    label: groupKeyLabel,
    value: row.label,
  });

  if (!analyticsEnabled) {
    return (
      <tr className="border-t border-ui-border/15 bg-ui-highlight/40 text-sm font-semibold text-ui-muted transition-colors hover:bg-ui-highlight/60">
        <td colSpan={safeColumnCount + (showRowNumbers ? 1 : 0)} className={cellPadding}>
          <div
            className="flex items-center gap-2.5"
            style={{ paddingLeft: `${row.depth * 16}px` }}
          >
            <button
              type="button"
              onClick={() => onToggleCollapse(row.groupId)}
              aria-label={`${toggleLabel}: ${toggleDescription}`}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-ui-ink transition hover:bg-ui-highlight/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper"
            >
              <span
                className={cn(
                  "transition-transform duration-200",
                  isCollapsed && "-rotate-90"
                )}
              >
                <ChevronDownIcon />
              </span>
            </button>
            <span className="text-ui-ink">{row.label}</span>
            <span className="inline-flex items-center rounded-full bg-ui-highlight px-2 py-0.5 text-[11px] font-medium text-ui-muted">
              {row.count}
            </span>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t border-ui-border/15 bg-ui-highlight/40 text-sm font-semibold text-ui-muted transition-colors hover:bg-ui-highlight/60">
      {showRowNumbers ? (
        <td className={cn(cellPadding, "border-r border-ui-border/15 w-10")} />
      ) : null}
      {selectionEnabled ? (
        <td className={cn(cellPadding, "border-r border-ui-border/15")} />
      ) : null}
      {displayColumns.map((column, colIndex) => {
        const pinnedOffset = pinnedOffsets[column.key];
        const isPinned = pinnedOffset !== undefined;
        const widthStyle = columnWidths[column.key];
        const isNumeric = numericColumnSet.has(column.key);
        const cellStyle = {
          ...(isPinned ? { left: pinnedOffset } : null),
          ...(widthStyle ? { width: widthStyle } : null),
        };
        if (colIndex === 0) {
          return (
            <td
              key={`${row.id}-${column.key}`}
              data-pinned={isPinned ? "true" : undefined}
              className={cn(cellPadding, isPinned && pinnedGroupClass)}
              style={cellStyle}
            >
              <div
                className="flex items-center gap-2.5"
                style={{ paddingLeft: `${row.depth * 16}px` }}
              >
                <button
                  type="button"
                  onClick={() => onToggleCollapse(row.groupId)}
                  aria-label={`${toggleLabel}: ${toggleDescription}`}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-ui-ink transition hover:bg-ui-highlight/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper"
                >
                  <span
                    className={cn(
                      "transition-transform duration-200",
                      isCollapsed && "-rotate-90"
                    )}
                  >
                    <ChevronDownIcon />
                  </span>
                </button>
                <span>{groupTitle}</span>
              </div>
            </td>
          );
        }
        const metric = metricsByColumn?.[column.key] ?? null;
        if (!metric) {
          return (
            <td
              key={`${row.id}-${column.key}`}
              data-pinned={isPinned ? "true" : undefined}
              className={cn(
                "text-xs text-ui-muted",
                cellPadding,
                "border-l border-ui-border/40",
                isPinned && pinnedGroupClass,
                isNumeric && "text-right tabular-nums"
              )}
              style={cellStyle}
            >
              {"\u2014"}
            </td>
          );
        }
        return (
          <td
            key={`${row.id}-${column.key}`}
            data-pinned={isPinned ? "true" : undefined}
            className={cn(
              cellPadding,
              "border-l border-ui-border/40",
              isPinned && pinnedGroupClass,
              isNumeric && "text-right tabular-nums"
            )}
            style={cellStyle}
          >
            <div className="space-y-1 text-[10px] leading-tight text-ui-muted">
              <div>{t("metrics.count", { value: metric.count })}</div>
              <div>{t("metrics.sum", { value: formatMetricValue(metric.sum) })}</div>
              <div>{t("metrics.avg", { value: formatMetricValue(metric.avg) })}</div>
              <div>{t("metrics.min", { value: formatMetricValue(metric.min) })}</div>
              <div>{t("metrics.max", { value: formatMetricValue(metric.max) })}</div>
            </div>
          </td>
        );
      })}
    </tr>
  );
}
