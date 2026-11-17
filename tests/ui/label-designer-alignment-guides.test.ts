import { computeGuides } from "../../packages/ui/src/label-designer/canvas/use-alignment-guides";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

const makeBlock = (x: number, y: number, w = 80, h = 20): TemplateBlock => ({
  type: "text",
  x,
  y,
  width: w,
  height: h,
});

describe("alignment guides computation", () => {
  it("returns no guides when no blocks align", () => {
    const dragged = makeBlock(0, 0);
    const others = [makeBlock(200, 200)];
    const result = computeGuides(dragged, [dragged, ...others], 0);
    expect(result.guides.length).toBe(0);
    expect(result.snapX).toBeNull();
    expect(result.snapY).toBeNull();
  });

  it("detects left-edge alignment within threshold", () => {
    const dragged = makeBlock(101, 50);
    const target = makeBlock(100, 150);
    const result = computeGuides(dragged, [dragged, target], 0);
    const vertical = result.guides.filter((g) => g.orientation === "vertical");
    expect(vertical.length).toBeGreaterThan(0);
    expect(result.snapX).not.toBeNull();
  });

  it("detects top-edge alignment within threshold", () => {
    const dragged = makeBlock(50, 101);
    const target = makeBlock(200, 100);
    const result = computeGuides(dragged, [dragged, target], 0);
    const horizontal = result.guides.filter((g) => g.orientation === "horizontal");
    expect(horizontal.length).toBeGreaterThan(0);
    expect(result.snapY).not.toBeNull();
  });

  it("detects center alignment", () => {
    const dragged = makeBlock(9, 50, 80, 20); // centerX = 49
    const target = makeBlock(10, 150, 80, 20); // centerX = 50
    const result = computeGuides(dragged, [dragged, target], 0);
    expect(result.guides.length).toBeGreaterThan(0);
  });

  it("deduplicates guides", () => {
    const dragged = makeBlock(100, 100);
    const target1 = makeBlock(100, 50);
    const target2 = makeBlock(100, 200);
    const result = computeGuides(dragged, [dragged, target1, target2], 0);
    const positions = result.guides
      .filter((g) => g.orientation === "vertical")
      .map((g) => g.position);
    const unique = new Set(positions);
    expect(unique.size).toBe(positions.length);
  });

  it("skips hidden blocks", () => {
    const dragged = makeBlock(100, 50);
    const hidden: TemplateBlock = { ...makeBlock(100, 200), visible: false };
    const result = computeGuides(dragged, [dragged, hidden], 0);
    expect(result.guides.length).toBe(0);
  });

  it("skips self (draggedIndex)", () => {
    const blocks = [makeBlock(100, 100), makeBlock(200, 200)];
    const result = computeGuides(blocks[0]!, blocks, 0);
    // Should only check blocks[1], not itself
    expect(result.guides.every((g) => g.position !== 100 || result.guides.length === 0)).toBeTruthy();
  });
});
