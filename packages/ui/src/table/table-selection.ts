"use client";
import * as React from "react";
import type { DisplayRow } from "./row-types";

type TableSelectionParams = {
  idKey?: string | null;
  selectionEnabled: boolean;
  pagedItems: Record<string, unknown>[];
  displayRows: DisplayRow[];
  selectAllRef: React.RefObject<HTMLInputElement | null>;
  onSelectionChange?: (selectedIds: string[]) => void;
};

type TableSelectionState = {
  selectedIds: Set<string>;
  selectedIdList: string[];
  selectedCount: number;
  allSelected: boolean;
  toggleAllSelection: () => void;
  handleRowSelection: (rowIndex: number, rowId: string, isRange: boolean) => void;
  clearSelection: () => void;
};

export function useTableSelection({
  idKey,
  selectionEnabled,
  pagedItems,
  displayRows,
  selectAllRef,
  onSelectionChange,
}: TableSelectionParams): TableSelectionState {
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
    () => new Set()
  );
  const [lastSelectedIndex, setLastSelectedIndex] = React.useState<number | null>(
    null
  );

  const rowIds = React.useMemo(() => {
    if (!selectionEnabled || !idKey) return [];
    return pagedItems
      .map((item) => item[idKey])
      .filter((value) => value !== null && value !== undefined)
      .map((value) => String(value));
  }, [pagedItems, idKey, selectionEnabled]);
  const rowIdSet = React.useMemo(() => new Set(rowIds), [rowIds]);
  const selectedIdList = React.useMemo(
    () => rowIds.filter((id) => selectedIds.has(id)),
    [rowIds, selectedIds]
  );
  const selectedCount = selectedIds.size;
  const allSelected =
    selectionEnabled &&
    rowIds.length > 0 &&
    rowIds.every((id) => selectedIds.has(id));

  React.useEffect(() => {
    if (!selectionEnabled) return;
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      let changed = false;
      const next = new Set<string>();
      current.forEach((id) => {
        if (rowIdSet.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      if (!changed && next.size === current.size) return current;
      return next;
    });
  }, [selectionEnabled, rowIdSet]);

  React.useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate =
      selectionEnabled && selectedCount > 0 && !allSelected;
  }, [selectionEnabled, selectedCount, allSelected, selectAllRef]);

  React.useEffect(() => {
    if (!onSelectionChange) return;
    onSelectionChange(selectedIdList);
  }, [onSelectionChange, selectedIdList]);

  const toggleSelection = React.useCallback((rowId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }, []);

  const selectRange = React.useCallback(
    (startIndex: number, endIndex: number) => {
      if (!idKey) return;
      const [from, to] =
        startIndex <= endIndex
          ? [startIndex, endIndex]
          : [endIndex, startIndex];
      setSelectedIds((current) => {
        const next = new Set(current);
        displayRows.slice(from, to + 1).forEach((row) => {
          if (row.type !== "row") return;
          const idValue = row.item[idKey];
          if (idValue === null || idValue === undefined) return;
          next.add(String(idValue));
        });
        return next;
      });
    },
    [displayRows, idKey]
  );

  const handleRowSelection = React.useCallback(
    (rowIndex: number, rowId: string, isRange: boolean) => {
      if (!selectionEnabled) return;
      if (isRange && lastSelectedIndex !== null) {
        selectRange(lastSelectedIndex, rowIndex);
      } else {
        toggleSelection(rowId);
      }
      setLastSelectedIndex(rowIndex);
    },
    [lastSelectedIndex, selectRange, selectionEnabled, toggleSelection]
  );

  const toggleAllSelection = React.useCallback(() => {
    if (!selectionEnabled) return;
    setSelectedIds((current) => {
      if (allSelected) {
        return new Set();
      }
      const next = new Set(current);
      rowIds.forEach((id) => next.add(id));
      return next;
    });
    setLastSelectedIndex(null);
  }, [allSelected, rowIds, selectionEnabled]);

  const clearSelection = React.useCallback(() => {
    setSelectedIds(new Set());
    setLastSelectedIndex(null);
  }, []);

  return {
    selectedIds,
    selectedIdList,
    selectedCount,
    allSelected,
    toggleAllSelection,
    handleRowSelection,
    clearSelection,
  };
}
