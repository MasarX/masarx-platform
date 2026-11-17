"use client";

import * as React from "react";

export type CellPosition = {
  rowIndex: number;
  colIndex: number;
};

type UseTableCellNavigationParams = {
  enabled: boolean;
  rowCount: number;
  colCount: number;
  onStartEdit?: (rowIndex: number, colIndex: number) => void;
  onCommitAndMove?: (direction: "down" | "right") => void;
};

export function useTableCellNavigation({
  enabled,
  rowCount,
  colCount,
  onStartEdit,
  onCommitAndMove,
}: UseTableCellNavigationParams) {
  const [focusedCell, setFocusedCell] = React.useState<CellPosition | null>(
    null
  );
  const [isEditing, setIsEditing] = React.useState(false);

  const moveFocus = React.useCallback(
    (deltaRow: number, deltaCol: number) => {
      setFocusedCell((current) => {
        if (!current) return { rowIndex: 0, colIndex: 0 };
        let nextRow = current.rowIndex + deltaRow;
        let nextCol = current.colIndex + deltaCol;

        // Wrap column
        if (nextCol >= colCount) {
          nextCol = 0;
          nextRow += 1;
        }
        if (nextCol < 0) {
          nextCol = colCount - 1;
          nextRow -= 1;
        }

        // Clamp row
        nextRow = Math.max(0, Math.min(rowCount - 1, nextRow));

        return { rowIndex: nextRow, colIndex: nextCol };
      });
    },
    [colCount, rowCount]
  );

  const handleTableKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (!enabled || !focusedCell) return;

      if (isEditing) {
        if (event.key === "Escape") {
          event.preventDefault();
          setIsEditing(false);
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          setIsEditing(false);
          onCommitAndMove?.("right");
          moveFocus(0, event.shiftKey ? -1 : 1);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          setIsEditing(false);
          onCommitAndMove?.("down");
          moveFocus(1, 0);
          return;
        }
        return;
      }

      // Navigation mode
      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          moveFocus(-1, 0);
          break;
        case "ArrowDown":
          event.preventDefault();
          moveFocus(1, 0);
          break;
        case "ArrowLeft":
          event.preventDefault();
          moveFocus(0, -1);
          break;
        case "ArrowRight":
          event.preventDefault();
          moveFocus(0, 1);
          break;
        case "Tab":
          event.preventDefault();
          moveFocus(0, event.shiftKey ? -1 : 1);
          break;
        case "Enter":
          event.preventDefault();
          setIsEditing(true);
          onStartEdit?.(focusedCell.rowIndex, focusedCell.colIndex);
          break;
        case "Escape":
          event.preventDefault();
          setFocusedCell(null);
          break;
      }
    },
    [enabled, focusedCell, isEditing, moveFocus, onCommitAndMove, onStartEdit]
  );

  const focusCell = React.useCallback((position: CellPosition) => {
    setFocusedCell(position);
    setIsEditing(false);
  }, []);

  const isCellFocused = React.useCallback(
    (rowIndex: number, colIndex: number) => {
      if (!focusedCell) return false;
      return (
        focusedCell.rowIndex === rowIndex && focusedCell.colIndex === colIndex
      );
    },
    [focusedCell]
  );

  return {
    focusedCell,
    isEditing,
    setIsEditing,
    focusCell,
    isCellFocused,
    handleTableKeyDown,
    moveFocus,
  };
}
