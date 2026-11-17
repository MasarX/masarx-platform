import { POINTS_PER_INCH } from "./canvas-types";

/** Default grid snap: 0.25 inch = 18pt */
export const DEFAULT_GRID_SIZE = POINTS_PER_INCH / 4;

/** Snap a value to the nearest grid position. */
export function snapToGrid(value: number, gridSize: number = DEFAULT_GRID_SIZE): number {
  return Math.round(value / gridSize) * gridSize;
}
