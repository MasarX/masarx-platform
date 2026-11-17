"use client";

import * as React from "react";
import type { GuideLine } from "./use-alignment-guides";

type CanvasAlignmentGuidesProps = {
  guides: GuideLine[];
  scale: number;
  canvasWidth: number;
  canvasHeight: number;
};

export function CanvasAlignmentGuides({
  guides,
  scale,
  canvasWidth,
  canvasHeight,
}: CanvasAlignmentGuidesProps) {
  if (guides.length === 0) return null;

  return (
    <g style={{ pointerEvents: "none" }}>
      {guides.map((guide, i) => {
        if (guide.orientation === "vertical") {
          const x = guide.position * scale;
          return (
            <line
              key={`v-${i}`}
              x1={x}
              y1={0}
              x2={x}
              y2={canvasHeight}
              stroke="#2563eb"
              strokeWidth={0.5}
              strokeDasharray="4 3"
              opacity={0.6}
            />
          );
        }
        const y = guide.position * scale;
        return (
          <line
            key={`h-${i}`}
            x1={0}
            y1={y}
            x2={canvasWidth}
            y2={y}
            stroke="#2563eb"
            strokeWidth={0.5}
            strokeDasharray="4 3"
            opacity={0.6}
          />
        );
      })}
    </g>
  );
}
