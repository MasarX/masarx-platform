"use client";

import * as React from "react";
import type { PageConfig } from "./canvas-types";
import { POINTS_PER_INCH } from "./canvas-types";

type CanvasRulerProps = {
  page: PageConfig;
  scale: number;
};

const RULER_SIZE = 20;

export function CanvasRuler({ page, scale }: CanvasRulerProps) {
  const w = page.width_inch * POINTS_PER_INCH * scale;
  const h = page.height_inch * POINTS_PER_INCH * scale;
  const step = POINTS_PER_INCH * scale;

  return (
    <>
      {/* Top ruler */}
      <div
        className="relative overflow-hidden bg-ui-paper/80 border-b border-ui-border/50"
        style={{ height: RULER_SIZE, marginLeft: RULER_SIZE }}
      >
        <svg width={w} height={RULER_SIZE}>
          {Array.from({ length: Math.ceil(page.width_inch) + 1 }, (_, i) => (
            <g key={i}>
              <line
                x1={i * step}
                y1={RULER_SIZE - 8}
                x2={i * step}
                y2={RULER_SIZE}
                stroke="#9ca3af"
                strokeWidth={1}
              />
              <text
                x={i * step + 3}
                y={RULER_SIZE - 10}
                fontSize={9}
                fill="#6b7280"
                style={{ userSelect: "none" }}
              >
                {i}"
              </text>
            </g>
          ))}
        </svg>
      </div>

      {/* Left ruler (rendered alongside the canvas) */}
      <div
        className="absolute left-0 top-0 overflow-hidden bg-ui-paper/80 border-r border-ui-border/50"
        style={{ width: RULER_SIZE, height: h, top: RULER_SIZE }}
      >
        <svg width={RULER_SIZE} height={h}>
          {Array.from({ length: Math.ceil(page.height_inch) + 1 }, (_, i) => (
            <g key={i}>
              <line
                x1={RULER_SIZE - 8}
                y1={i * step}
                x2={RULER_SIZE}
                y2={i * step}
                stroke="#9ca3af"
                strokeWidth={1}
              />
              <text
                x={2}
                y={i * step + 12}
                fontSize={9}
                fill="#6b7280"
                style={{ userSelect: "none" }}
              >
                {i}"
              </text>
            </g>
          ))}
        </svg>
      </div>
    </>
  );
}

export { RULER_SIZE };
