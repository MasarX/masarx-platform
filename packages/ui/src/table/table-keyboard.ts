"use client";
import type * as React from "react";

type ResizeKeyHandlerParams = {
  columnWidths: Record<string, number>;
  headerRefs: React.MutableRefObject<Map<string, HTMLTableHeaderCellElement>>;
  defaultWidth: number;
  resizeStep: number;
  resizeStepLarge: number;
  updateColumnWidth: (key: string, width: number) => void;
};

export function createResizeKeyHandler({
  columnWidths,
  headerRefs,
  defaultWidth,
  resizeStep,
  resizeStepLarge,
  updateColumnWidth,
}: ResizeKeyHandlerParams) {
  return (key: string, event: React.KeyboardEvent) => {
    const isLeft = event.key === "ArrowLeft" || event.key === "ArrowDown";
    const isRight = event.key === "ArrowRight" || event.key === "ArrowUp";
    if (!isLeft && !isRight) return;
    event.preventDefault();
    const delta = event.shiftKey ? resizeStepLarge : resizeStep;
    const current =
      columnWidths[key] ??
      headerRefs.current.get(key)?.getBoundingClientRect().width ??
      defaultWidth;
    const nextWidth = isLeft ? current - delta : current + delta;
    updateColumnWidth(key, nextWidth);
  };
}
