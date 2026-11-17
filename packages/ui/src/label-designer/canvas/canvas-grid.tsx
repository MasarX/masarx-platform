"use client";

import * as React from "react";
import type { PageConfig } from "./canvas-types";
import { POINTS_PER_INCH } from "./canvas-types";

type CanvasGridProps = {
  page: PageConfig;
  scale: number;
  visible: boolean;
};

export function CanvasGrid({ page, scale, visible }: CanvasGridProps) {
  if (!visible) return null;

  const w = page.width_inch * POINTS_PER_INCH * scale;
  const h = page.height_inch * POINTS_PER_INCH * scale;

  // Grid every 0.25 inch
  const stepMajor = POINTS_PER_INCH * scale;
  const stepMinor = (POINTS_PER_INCH / 4) * scale;

  const lines: React.ReactElement[] = [];

  // Minor grid
  for (let x = stepMinor; x < w; x += stepMinor) {
    lines.push(
      <line key={`vmin-${x}`} x1={x} y1={0} x2={x} y2={h} stroke="#e5e7eb" strokeWidth={0.5} />,
    );
  }
  for (let y = stepMinor; y < h; y += stepMinor) {
    lines.push(
      <line key={`hmin-${y}`} x1={0} y1={y} x2={w} y2={y} stroke="#e5e7eb" strokeWidth={0.5} />,
    );
  }

  // Major grid (every inch)
  for (let x = stepMajor; x < w; x += stepMajor) {
    lines.push(
      <line key={`vmaj-${x}`} x1={x} y1={0} x2={x} y2={h} stroke="#d1d5db" strokeWidth={1} />,
    );
  }
  for (let y = stepMajor; y < h; y += stepMajor) {
    lines.push(
      <line key={`hmaj-${y}`} x1={0} y1={y} x2={w} y2={y} stroke="#d1d5db" strokeWidth={1} />,
    );
  }

  return <g style={{ pointerEvents: "none" }}>{lines}</g>;
}
