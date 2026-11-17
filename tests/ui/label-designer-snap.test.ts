import { snapToGrid, DEFAULT_GRID_SIZE } from "../../packages/ui/src/label-designer/canvas/canvas-snap";
import { POINTS_PER_INCH } from "../../packages/ui/src/label-designer/canvas/canvas-types";

describe("canvas-snap", () => {
  it("DEFAULT_GRID_SIZE is 0.25 inch = 18pt", () => {
    expect(DEFAULT_GRID_SIZE).toBe(POINTS_PER_INCH / 4);
    expect(DEFAULT_GRID_SIZE).toBe(18);
  });

  it("snaps exact grid position to itself", () => {
    expect(snapToGrid(18)).toBe(18);
    expect(snapToGrid(36)).toBe(36);
    expect(snapToGrid(0)).toBe(0);
  });

  it("snaps to nearest grid position (round)", () => {
    expect(snapToGrid(10)).toBe(18); // closer to 18 than 0
    expect(snapToGrid(8)).toBe(0);   // closer to 0 than 18
    expect(snapToGrid(9)).toBe(18);  // equidistant rounds up
    expect(snapToGrid(27)).toBe(36); // 27 is closer to 36 than 18
    expect(snapToGrid(26)).toBe(18); // 26 is closer to 18 than 36
  });

  it("snaps with custom grid size", () => {
    expect(snapToGrid(7, 10)).toBe(10);
    expect(snapToGrid(3, 10)).toBe(0);
    expect(snapToGrid(25, 10)).toBe(30);
  });

  it("handles negative values", () => {
    expect(Object.is(snapToGrid(-5, 18), 0) || Object.is(snapToGrid(-5, 18), -0)).toBe(true);
    expect(snapToGrid(-10, 18)).toBe(-18);
  });
});
