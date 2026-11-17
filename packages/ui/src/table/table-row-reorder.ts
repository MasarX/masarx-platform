"use client";

import * as React from "react";

type UseTableRowReorderParams = {
  items: Record<string, unknown>[];
  idKey: string | null;
  enabled: boolean;
  onReorder: (fromId: string, toId: string) => void;
};

type TableRowReorderState = {
  dragRowId: string | null;
  dropTargetId: string | null;
};

export function useTableRowReorder({
  items,
  idKey,
  enabled,
  onReorder,
}: UseTableRowReorderParams) {
  const [state, setState] = React.useState<TableRowReorderState>({
    dragRowId: null,
    dropTargetId: null,
  });

  const handleDragStart = React.useCallback(
    (rowId: string) => (event: React.DragEvent) => {
      if (!enabled) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", rowId);
      setState({ dragRowId: rowId, dropTargetId: null });
    },
    [enabled]
  );

  const handleDragOver = React.useCallback(
    (rowId: string) => (event: React.DragEvent) => {
      if (!enabled || !state.dragRowId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (rowId !== state.dropTargetId) {
        setState((prev) => ({ ...prev, dropTargetId: rowId }));
      }
    },
    [enabled, state.dragRowId, state.dropTargetId]
  );

  const handleDrop = React.useCallback(
    (rowId: string) => (event: React.DragEvent) => {
      event.preventDefault();
      if (!enabled || !state.dragRowId || state.dragRowId === rowId) {
        setState({ dragRowId: null, dropTargetId: null });
        return;
      }
      onReorder(state.dragRowId, rowId);
      setState({ dragRowId: null, dropTargetId: null });
    },
    [enabled, onReorder, state.dragRowId]
  );

  const handleDragEnd = React.useCallback(() => {
    setState({ dragRowId: null, dropTargetId: null });
  }, []);

  return {
    dragRowId: state.dragRowId,
    dropTargetId: state.dropTargetId,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
  };
}
