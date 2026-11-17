"use client";

import * as React from "react";
import type { ResizeHandle, TemplateBlock } from "./canvas-types";

type CanvasSelectionProps = {
  block: TemplateBlock;
  scale: number;
  testIdPrefix?: string;
  onResizeStart: (handle: ResizeHandle, e: React.MouseEvent) => void;
};

const HANDLE_SIZE = 8;

const HANDLES: { key: ResizeHandle; xFrac: number; yFrac: number; cursor: string }[] = [
  { key: "nw", xFrac: 0, yFrac: 0, cursor: "nwse-resize" },
  { key: "ne", xFrac: 1, yFrac: 0, cursor: "nesw-resize" },
  { key: "sw", xFrac: 0, yFrac: 1, cursor: "nesw-resize" },
  { key: "se", xFrac: 1, yFrac: 1, cursor: "nwse-resize" },
  { key: "n", xFrac: 0.5, yFrac: 0, cursor: "ns-resize" },
  { key: "s", xFrac: 0.5, yFrac: 1, cursor: "ns-resize" },
  { key: "w", xFrac: 0, yFrac: 0.5, cursor: "ew-resize" },
  { key: "e", xFrac: 1, yFrac: 0.5, cursor: "ew-resize" },
];

export function CanvasSelection({
  block,
  scale,
  testIdPrefix,
  onResizeStart,
}: CanvasSelectionProps) {
  const x = block.x * scale;
  const y = block.y * scale;
  const w = (block.width || 80) * scale;
  const h = (block.height || 20) * scale;
  const half = HANDLE_SIZE / 2;

  return (
    <g style={{ pointerEvents: "all" }} data-testid={testIdPrefix ? `${testIdPrefix}-selection` : undefined}>
      {/* Selection border */}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="transparent"
        stroke="#2563eb"
        strokeWidth={1.5}
        strokeDasharray="4 2"
        style={{ pointerEvents: "none" }}
      />
      {/* Resize handles */}
      {HANDLES.map((handle) => {
        const cx = x + w * handle.xFrac;
        const cy = y + h * handle.yFrac;
        return (
          <rect
            key={handle.key}
            x={cx - half}
            y={cy - half}
            width={HANDLE_SIZE}
            height={HANDLE_SIZE}
            fill="#ffffff"
            stroke="#2563eb"
            strokeWidth={1.5}
            rx={1}
            data-testid={testIdPrefix ? `${testIdPrefix}-resize-${handle.key}` : undefined}
            style={{ cursor: handle.cursor }}
            onMouseDown={(e) => {
              e.stopPropagation();
              onResizeStart(handle.key, e);
            }}
          />
        );
      })}
    </g>
  );
}
