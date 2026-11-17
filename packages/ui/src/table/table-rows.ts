"use client";
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { buildGroupTree, flattenGroupTree, type GroupLabels } from "./grouping";
import { computePageMetrics } from "./metrics";
import type { ResourceColumn } from "./columns";
import type { DisplayRow } from "./row-types";

type RowHeights = {
  base: number;
  group: number;
  detail: number;
};

type TableRowsParams = {
  pagedItems: Record<string, unknown>[];
  resolvedGroupBy: string[];
  analyticsEnabled: boolean;
  activeColumns: ResourceColumn[];
  groupLabels: GroupLabels;
  idKey?: string | null;
  rowHeights: RowHeights;
  tableContainerRef: React.RefObject<HTMLDivElement | null>;
  overscan?: number;
};

type TableRowsState = {
  displayRows: DisplayRow[];
  rowsToRender: Array<{ index: number }>;
  paddingTop: number;
  paddingBottom: number;
  groupIds: string[];
  collapsedGroups: Set<string>;
  expandedRowIds: Set<string>;
  resolveRowKey: (item: Record<string, unknown>, fallback: string) => string;
  toggleGroupCollapse: (groupId: string) => void;
  collapseAllGroups: () => void;
  expandAllGroups: () => void;
  toggleRowExpanded: (rowKey: string) => void;
  resetRowState: () => void;
};

export function useTableRows({
  pagedItems,
  resolvedGroupBy,
  analyticsEnabled,
  activeColumns,
  groupLabels,
  idKey,
  rowHeights,
  tableContainerRef,
  overscan,
}: TableRowsParams): TableRowsState {
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(
    () => new Set()
  );
  const [expandedRowIds, setExpandedRowIds] = React.useState<Set<string>>(
    () => new Set()
  );

  React.useEffect(() => {
    setCollapsedGroups((current) =>
      current.size === 0 ? current : new Set()
    );
  }, [resolvedGroupBy.join("|")]);

  const groupedRows = React.useMemo(() => {
    if (resolvedGroupBy.length === 0) {
      return pagedItems.map((item, index) => ({
        type: "row" as const,
        id: `row:${index}`,
        depth: 0,
        item,
        groupPath: [],
      }));
    }
    const nodes = buildGroupTree(pagedItems, resolvedGroupBy, groupLabels);
    const resolveMetrics = analyticsEnabled
      ? (groupItems: Record<string, unknown>[]) =>
          computePageMetrics(groupItems, activeColumns)
      : undefined;
    return flattenGroupTree(nodes, 0, resolveMetrics);
  }, [pagedItems, resolvedGroupBy, groupLabels, analyticsEnabled, activeColumns]);

  const groupIds = React.useMemo(
    () =>
      groupedRows.flatMap((row) => (row.type === "group" ? [row.groupId] : [])),
    [groupedRows]
  );

  const collapsedRows = React.useMemo(() => {
    if (collapsedGroups.size === 0) return groupedRows;
    return groupedRows.filter((row) => {
      if (row.type === "group") {
        return !row.groupPath.slice(0, -1).some((id) => collapsedGroups.has(id));
      }
      return !row.groupPath.some((id) => collapsedGroups.has(id));
    });
  }, [groupedRows, collapsedGroups]);

  const resolveRowKey = React.useCallback(
    (item: Record<string, unknown>, fallback: string) => {
      if (!idKey) return fallback;
      const value = item[idKey];
      if (value === null || value === undefined) return fallback;
      return String(value);
    },
    [idKey]
  );

  const rowKeySet = React.useMemo(() => {
    const next = new Set<string>();
    collapsedRows.forEach((row) => {
      if (row.type !== "row") return;
      next.add(resolveRowKey(row.item, row.id));
    });
    return next;
  }, [collapsedRows, resolveRowKey]);

  React.useEffect(() => {
    setExpandedRowIds((current) => {
      if (current.size === 0) return current;
      let changed = false;
      const next = new Set<string>();
      current.forEach((key) => {
        if (rowKeySet.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      });
      if (!changed && next.size === current.size) return current;
      return next;
    });
  }, [rowKeySet]);

  const displayRows = React.useMemo(() => {
    const rows: DisplayRow[] = [];
    collapsedRows.forEach((row) => {
      rows.push(row);
      if (row.type !== "row") return;
      const rowKey = resolveRowKey(row.item, row.id);
      if (!expandedRowIds.has(rowKey)) return;
      const rawId =
        idKey && row.item[idKey] !== null && row.item[idKey] !== undefined
          ? String(row.item[idKey])
          : null;
      rows.push({
        type: "detail",
        id: `${row.id}-detail`,
        depth: row.depth,
        item: row.item,
        groupPath: row.groupPath,
        parentKey: rowKey,
        parentId: rawId,
      });
    });
    return rows;
  }, [collapsedRows, expandedRowIds, resolveRowKey, idKey]);

  const toggleRowExpanded = React.useCallback((rowKey: string) => {
    setExpandedRowIds((current) => {
      const next = new Set(current);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  }, []);

  const toggleGroupCollapse = React.useCallback((groupId: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const collapseAllGroups = React.useCallback(() => {
    setCollapsedGroups(new Set(groupIds));
  }, [groupIds]);

  const expandAllGroups = React.useCallback(() => {
    setCollapsedGroups(new Set());
  }, []);

  const resetRowState = React.useCallback(() => {
    setCollapsedGroups((current) =>
      current.size === 0 ? current : new Set()
    );
    setExpandedRowIds((current) =>
      current.size === 0 ? current : new Set()
    );
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: (index) => {
      const row = displayRows[index];
      if (!row) return rowHeights.base;
      if (row.type === "group") return rowHeights.group;
      if (row.type === "detail") return rowHeights.detail;
      return rowHeights.base;
    },
    overscan: Number.isFinite(overscan) && (overscan ?? 0) >= 0 ? overscan : 8,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const containerHeight = tableContainerRef.current?.clientHeight ?? 0;
  const overscanCount = Number.isFinite(overscan) ? (overscan ?? 0) : 8;
  const estimatedVisible =
    containerHeight > 0 ? Math.ceil(containerHeight / rowHeights.base) : 0;
  const fallbackCount =
    estimatedVisible > 0
      ? Math.min(displayRows.length, estimatedVisible + overscanCount * 2)
      : displayRows.length;
  const fallbackRows = displayRows
    .slice(0, fallbackCount)
    .map((_row, index) => ({ index }));
  const fallbackTotal =
    totalSize > 0 ? totalSize : displayRows.length * rowHeights.base;

  const firstVirtualRow = virtualRows[0];
  const lastVirtualRow = virtualRows[virtualRows.length - 1];
  const paddingTop = firstVirtualRow ? firstVirtualRow.start : 0;
  const paddingBottom = lastVirtualRow
    ? totalSize - lastVirtualRow.end
    : Math.max(0, fallbackTotal - fallbackCount * rowHeights.base);
  const rowsToRender = virtualRows.length > 0 ? virtualRows : fallbackRows;

  return {
    displayRows,
    rowsToRender,
    paddingTop,
    paddingBottom,
    groupIds,
    collapsedGroups,
    expandedRowIds,
    resolveRowKey,
    toggleGroupCollapse,
    collapseAllGroups,
    expandAllGroups,
    toggleRowExpanded,
    resetRowState,
  };
}
