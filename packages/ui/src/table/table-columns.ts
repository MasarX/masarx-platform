"use client";

import * as React from "react";
import { createResizeKeyHandler } from "./table-keyboard";
import type { ResourceColumn } from "./columns";
import type { ResizeGuide } from "./resize-guide";
import type { ResourceViewEntry } from "./view-types";
import { moveItem } from "./list-utils";

type ColumnWidthMap = Record<string, number>;

type ColumnState = {
  ordered: string[];
  visible: Set<string>;
  pinned: string[];
  widths: ColumnWidthMap;
};

type TableColumnsParams = {
  columns: ResourceColumn[];
  columnKeys: string[];
  activeView: ResourceViewEntry | null;
  selectionEnabled: boolean;
  selectHeaderRef: React.RefObject<HTMLTableHeaderCellElement | null>;
  tableContainerRef: React.RefObject<HTMLDivElement | null>;
  minColumnWidth: number;
  defaultColumnWidth: number;
  resizeStep: number;
  resizeStepLarge: number;
};

type TableColumnsState = {
  initialColumns: ColumnState;
  columnOrder: string[];
  setColumnOrder: React.Dispatch<React.SetStateAction<string[]>>;
  visibleColumns: Set<string>;
  setVisibleColumns: React.Dispatch<React.SetStateAction<Set<string>>>;
  pinnedColumns: string[];
  setPinnedColumns: React.Dispatch<React.SetStateAction<string[]>>;
  columnWidths: ColumnWidthMap;
  setColumnWidths: React.Dispatch<React.SetStateAction<ColumnWidthMap>>;
  columnsByKey: Map<string, ResourceColumn>;
  orderedColumns: ResourceColumn[];
  activeColumns: ResourceColumn[];
  displayColumns: ResourceColumn[];
  detailColumns: ResourceColumn[];
  pinnedSet: Set<string>;
  draggingColumn: string | null;
  dragOverColumn: string | null;
  handleColumnDragStart: (key: string) => (event: React.DragEvent) => void;
  handleColumnDragOver: (key: string) => (event: React.DragEvent) => void;
  handleColumnDrop: (key: string) => (event: React.DragEvent) => void;
  handleColumnDragEnd: () => void;
  handleMoveColumn: (fromIndex: number, toIndex: number) => void;
  updateColumnWidth: (key: string, nextWidth: number | null) => void;
  toggleColumn: (key: string) => void;
  togglePin: (key: string) => void;
  registerHeaderRef: (
    key: string
  ) => (node: HTMLTableHeaderCellElement | null) => void;
  pinnedOffsets: Record<string, number>;
  resizeGuide: ResizeGuide | null;
  handleResizeStart: (key: string, event: React.MouseEvent) => void;
  handleResizeKey: (
    key: string,
    event: React.KeyboardEvent<HTMLButtonElement>
  ) => void;
};

function sortKeysByOrder(keys: string[], order: string[]) {
  const orderIndex = new Map(order.map((key, index) => [key, index]));
  return [...keys].sort(
    (left, right) =>
      (orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER)
  );
}

function areArraysEqual<T>(left: T[], right: T[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function areSetsEqual<T>(left: Set<T>, right: Set<T>) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function areWidthMapsEqual(left: ColumnWidthMap, right: ColumnWidthMap) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function buildViewColumns(
  columnKeys: string[],
  view: ResourceViewEntry | null
): ColumnState {
  const ordered = view?.columns?.order?.length
    ? view.columns.order.filter((key) => columnKeys.includes(key))
    : [...columnKeys];
  columnKeys.forEach((key) => {
    if (!ordered.includes(key)) ordered.push(key);
  });
  const hidden = new Set(view?.columns?.hidden ?? []);
  const visible = new Set<string>();
  ordered.forEach((key) => {
    if (!hidden.has(key)) visible.add(key);
  });
  const pinnedRaw = view?.columns?.pinned ?? [];
  const pinned = Array.isArray(pinnedRaw)
    ? pinnedRaw.filter((key) => visible.has(key) && columnKeys.includes(key))
    : [];
  const widthsRaw = view?.columns?.widths ?? null;
  const widths: ColumnWidthMap = {};
  if (widthsRaw && typeof widthsRaw === "object") {
    Object.entries(widthsRaw as Record<string, unknown>).forEach(
      ([key, value]) => {
        if (!columnKeys.includes(key)) return;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return;
        widths[key] = parsed;
      }
    );
  }
  return { ordered, visible, pinned, widths };
}

function clampWidth(value: number, minWidth: number) {
  return Math.max(minWidth, Math.round(value));
}

export function useTableColumns({
  columns,
  columnKeys,
  activeView,
  selectionEnabled,
  selectHeaderRef,
  tableContainerRef,
  minColumnWidth,
  defaultColumnWidth,
  resizeStep,
  resizeStepLarge,
}: TableColumnsParams): TableColumnsState {
  const initialColumns = React.useMemo(
    () => buildViewColumns(columnKeys, activeView),
    [columnKeys, activeView]
  );
  const [columnOrder, setColumnOrder] = React.useState<string[]>(
    () => initialColumns.ordered
  );
  const [visibleColumns, setVisibleColumns] = React.useState<Set<string>>(
    () => initialColumns.visible
  );
  const [pinnedColumns, setPinnedColumns] = React.useState<string[]>(
    () => initialColumns.pinned
  );
  const [columnWidths, setColumnWidths] = React.useState<ColumnWidthMap>(
    () => initialColumns.widths
  );
  const [draggingColumn, setDraggingColumn] = React.useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = React.useState<string | null>(null);
  const headerRefs = React.useRef(
    new Map<string, HTMLTableHeaderCellElement>()
  );
  const [pinnedOffsets, setPinnedOffsets] = React.useState<Record<string, number>>(
    () => ({})
  );
  const [resizeGuide, setResizeGuide] = React.useState<ResizeGuide | null>(null);

  React.useEffect(() => {
    setColumnOrder((current) =>
      areArraysEqual(current, initialColumns.ordered)
        ? current
        : initialColumns.ordered
    );
    setVisibleColumns((current) =>
      areSetsEqual(current, initialColumns.visible)
        ? current
        : initialColumns.visible
    );
    setPinnedColumns((current) =>
      areArraysEqual(current, initialColumns.pinned)
        ? current
        : initialColumns.pinned
    );
    setColumnWidths((current) =>
      areWidthMapsEqual(current, initialColumns.widths)
        ? current
        : initialColumns.widths
    );
  }, [initialColumns]);

  React.useEffect(() => {
    setPinnedColumns((current) => {
      const visibleSet = new Set(visibleColumns);
      const filtered = current.filter((key) => visibleSet.has(key));
      return sortKeysByOrder(filtered, columnOrder);
    });
  }, [visibleColumns, columnOrder]);

  const columnsByKey = React.useMemo(() => {
    const map = new Map<string, ResourceColumn>();
    columns.forEach((column) => {
      map.set(column.key, column);
    });
    return map;
  }, [columns]);

  const orderedColumns = React.useMemo(
    () =>
      columnOrder.map((key) => columnsByKey.get(key)).filter(Boolean) as ResourceColumn[],
    [columnOrder, columnsByKey]
  );

  const activeColumns = React.useMemo(
    () => orderedColumns.filter((column) => visibleColumns.has(column.key)),
    [orderedColumns, visibleColumns]
  );

  const pinnedSet = React.useMemo(() => new Set(pinnedColumns), [pinnedColumns]);

  const displayColumns = React.useMemo(() => {
    if (pinnedColumns.length === 0) return activeColumns;
    const pinned = activeColumns.filter((column) => pinnedSet.has(column.key));
    const unpinned = activeColumns.filter((column) => !pinnedSet.has(column.key));
    return [...pinned, ...unpinned];
  }, [activeColumns, pinnedColumns.length, pinnedSet]);

  const detailColumns = React.useMemo(() => {
    const hidden = columnOrder.filter((key) => !visibleColumns.has(key));
    const detailColumnKeys = hidden.length > 0 ? hidden : columnOrder;
    return detailColumnKeys
      .map((key) => columnsByKey.get(key))
      .filter(Boolean) as ResourceColumn[];
  }, [columnOrder, visibleColumns, columnsByKey]);

  const pinnedKeysInOrder = React.useMemo(
    () =>
      displayColumns
        .filter((column) => pinnedSet.has(column.key))
        .map((column) => column.key),
    [displayColumns, pinnedSet]
  );

  const registerHeaderRef = React.useCallback(
    (key: string) => (node: HTMLTableHeaderCellElement | null) => {
      if (node) {
        headerRefs.current.set(key, node);
      } else {
        headerRefs.current.delete(key);
      }
    },
    []
  );

  const computePinnedOffsets = React.useCallback(() => {
    if (pinnedKeysInOrder.length === 0) {
      setPinnedOffsets({});
      return;
    }
    let offset = 0;
    if (selectionEnabled && selectHeaderRef.current) {
      offset = selectHeaderRef.current.getBoundingClientRect().width;
    }
    const next: Record<string, number> = {};
    pinnedKeysInOrder.forEach((key) => {
      next[key] = offset;
      const cell = headerRefs.current.get(key);
      const width = cell ? cell.getBoundingClientRect().width : 0;
      offset += width;
    });
    setPinnedOffsets(next);
  }, [pinnedKeysInOrder, selectionEnabled, selectHeaderRef]);

  React.useLayoutEffect(() => {
    computePinnedOffsets();
    if (typeof window === "undefined") return;
    const handleResize = () => computePinnedOffsets();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [computePinnedOffsets]);

  React.useEffect(() => {
    computePinnedOffsets();
  }, [columnWidths, computePinnedOffsets]);

  const toggleColumn = (key: string) => {
    setVisibleColumns((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        if (next.size <= 1) return next;
        next.delete(key);
        setPinnedColumns((pinned) => pinned.filter((entry) => entry !== key));
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const togglePin = (key: string) => {
    if (!visibleColumns.has(key)) return;
    setPinnedColumns((current) => {
      if (current.includes(key)) {
        return current.filter((entry) => entry !== key);
      }
      const next = [...current, key];
      return sortKeysByOrder(next, columnOrder);
    });
  };

  const updateColumnWidth = React.useCallback(
    (key: string, nextWidth: number | null) => {
      setColumnWidths((current) => {
        const next = { ...current };
        if (nextWidth === null) {
          delete next[key];
          return next;
        }
        next[key] = clampWidth(nextWidth, minColumnWidth);
        return next;
      });
    },
    [minColumnWidth]
  );

  const updateResizeGuide = React.useCallback(
    (clientX: number, nextWidth: number) => {
      const container = tableContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const scrollLeft = container.scrollLeft;
      const x = Math.min(
        Math.max(0, clientX - rect.left + scrollLeft),
        container.scrollWidth
      );
      setResizeGuide({ x, width: clampWidth(nextWidth, minColumnWidth) });
    },
    [minColumnWidth, tableContainerRef]
  );

  const handleResizeStart = React.useCallback((key: string, event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth =
      columnWidths[key] ??
      headerRefs.current.get(key)?.getBoundingClientRect().width ??
      defaultColumnWidth;
    const body = document.body;
    const previousCursor = body.style.cursor;
    const previousSelect = body.style.userSelect;
    body.style.cursor = "col-resize";
    body.style.userSelect = "none";
    updateResizeGuide(startX, startWidth);
    const handleMove = (moveEvent: MouseEvent) => {
      const nextWidth = startWidth + moveEvent.clientX - startX;
      updateColumnWidth(key, nextWidth);
      updateResizeGuide(moveEvent.clientX, nextWidth);
    };
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      body.style.cursor = previousCursor;
      body.style.userSelect = previousSelect;
      computePinnedOffsets();
      setResizeGuide(null);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }, [
    columnWidths,
    computePinnedOffsets,
    defaultColumnWidth,
    updateColumnWidth,
    updateResizeGuide,
  ]);

  const handleResizeKey = React.useMemo(
    () =>
      createResizeKeyHandler({
        columnWidths,
        headerRefs,
        defaultWidth: defaultColumnWidth,
        resizeStep,
        resizeStepLarge,
        updateColumnWidth,
      }),
    [columnWidths, defaultColumnWidth, resizeStep, resizeStepLarge, updateColumnWidth]
  );

  const handleColumnDragStart = (key: string) => (event: React.DragEvent) => {
    setDraggingColumn(key);
    setDragOverColumn(key);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", key);
    }
  };

  const handleColumnDragOver = (key: string) => (event: React.DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    setDragOverColumn(key);
  };

  const handleColumnDrop = (key: string) => (event: React.DragEvent) => {
    event.preventDefault();
    const source =
      draggingColumn ||
      (event.dataTransfer ? event.dataTransfer.getData("text/plain") : "");
    if (!source || source === key) {
      setDragOverColumn(null);
      setDraggingColumn(null);
      return;
    }
    setColumnOrder((current) => {
      const fromIndex = current.indexOf(source);
      const toIndex = current.indexOf(key);
      if (fromIndex < 0 || toIndex < 0) return current;
      return moveItem(current, fromIndex, toIndex);
    });
    setDragOverColumn(null);
    setDraggingColumn(null);
  };

  const handleColumnDragEnd = () => {
    setDragOverColumn(null);
    setDraggingColumn(null);
  };

  const handleMoveColumn = (fromIndex: number, toIndex: number) => {
    setColumnOrder((current) => {
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= current.length ||
        toIndex >= current.length
      ) {
        return current;
      }
      if (fromIndex === toIndex) return current;
      return moveItem(current, fromIndex, toIndex);
    });
  };

  return {
    initialColumns,
    columnOrder,
    setColumnOrder,
    visibleColumns,
    setVisibleColumns,
    pinnedColumns,
    setPinnedColumns,
    columnWidths,
    setColumnWidths,
    columnsByKey,
    orderedColumns,
    activeColumns,
    displayColumns,
    detailColumns,
    pinnedSet,
    draggingColumn,
    dragOverColumn,
    handleColumnDragStart,
    handleColumnDragOver,
    handleColumnDrop,
    handleColumnDragEnd,
    handleMoveColumn,
    updateColumnWidth,
    toggleColumn,
    togglePin,
    registerHeaderRef,
    pinnedOffsets,
    resizeGuide,
    handleResizeStart,
    handleResizeKey,
  };
}
