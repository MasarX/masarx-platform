"use client";

import * as React from "react";

type CanvasMeasurementTooltipProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  visible: boolean;
};

export function CanvasMeasurementTooltip({
  x,
  y,
  width,
  height,
  scale,
  visible,
}: CanvasMeasurementTooltipProps) {
  if (!visible) return null;

  const sx = x * scale;
  const sy = y * scale;
  const labelX = Math.round(x);
  const labelY = Math.round(y);
  const labelW = Math.round(width);
  const labelH = Math.round(height);

  return (
    <g style={{ pointerEvents: "none" }}>
      <rect
        x={sx + 8}
        y={sy - 22}
        width={110}
        height={18}
        rx={3}
        fill="rgba(0,0,0,0.75)"
      />
      <text
        x={sx + 14}
        y={sy - 8}
        fontSize={10}
        fill="#ffffff"
        fontFamily="monospace"
      >
        {labelX},{labelY} {labelW}x{labelH}
      </text>
    </g>
  );
}
