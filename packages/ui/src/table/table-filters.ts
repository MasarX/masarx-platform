"use client";
import { flattenFilterTree, normalizeFilterNode } from "../resource-query";
import type { ResourceColumn } from "./columns";

export function resolveActiveFilterCount(
  activeFilters: Record<string, unknown> | null | undefined
) {
  if (!activeFilters) return 0;
  if (Array.isArray(activeFilters)) return activeFilters.length;
  if (typeof activeFilters !== "object") return 0;
  const record = activeFilters as Record<string, unknown>;
  if (
    Array.isArray(record.rules) ||
    record.type === "group" ||
    record.type === "rule"
  ) {
    const normalized = normalizeFilterNode(record);
    if (!normalized) return 0;
    return normalized.type === "group"
      ? flattenFilterTree(normalized).length
      : 1;
  }
  return Object.values(record).reduce<number>((count, value) => {
    if (value === null || value === undefined) return count;
    if (Array.isArray(value)) {
      return value.length > 0 ? count + 1 : count;
    }
    return String(value).trim() ? count + 1 : count;
  }, 0);
}

export function filterColumnsByLabel(
  orderedColumns: ResourceColumn[],
  columnFilter: string,
  resolveLabel: (column: ResourceColumn) => string
) {
  const needle = columnFilter.trim().toLowerCase();
  if (!needle) return orderedColumns;
  return orderedColumns.filter((column) => {
    const label = resolveLabel(column);
    return (
      label.toLowerCase().includes(needle) ||
      column.key.toLowerCase().includes(needle)
    );
  });
}
