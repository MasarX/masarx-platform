import {
  bringForward,
  sendBackward,
  bringToFront,
  sendToBack,
} from "../../packages/ui/src/label-designer/canvas/canvas-utils";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

const makeBlock = (id: string): TemplateBlock => ({
  type: "text",
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  fallback: id,
});

const blocks: TemplateBlock[] = [makeBlock("A"), makeBlock("B"), makeBlock("C")];

describe("canvas-utils z-order functions", () => {
  describe("bringForward", () => {
    it("moves block one position up", () => {
      const result = bringForward(blocks, 0);
      expect(result.map((b) => b.fallback)).toEqual(["B", "A", "C"]);
    });

    it("returns same array when already at top", () => {
      const result = bringForward(blocks, 2);
      expect(result).toBe(blocks);
    });

    it("handles invalid index", () => {
      expect(bringForward(blocks, -1)).toBe(blocks);
      expect(bringForward(blocks, 5)).toBe(blocks);
    });
  });

  describe("sendBackward", () => {
    it("moves block one position down", () => {
      const result = sendBackward(blocks, 2);
      expect(result.map((b) => b.fallback)).toEqual(["A", "C", "B"]);
    });

    it("returns same array when already at bottom", () => {
      const result = sendBackward(blocks, 0);
      expect(result).toBe(blocks);
    });

    it("handles invalid index", () => {
      expect(sendBackward(blocks, -1)).toBe(blocks);
      expect(sendBackward(blocks, 5)).toBe(blocks);
    });
  });

  describe("bringToFront", () => {
    it("moves block to end", () => {
      const result = bringToFront(blocks, 0);
      expect(result.map((b) => b.fallback)).toEqual(["B", "C", "A"]);
    });

    it("returns same ref when already at front", () => {
      // Even at index 2, it creates a new array with splice+push, so compare content
      const result = bringToFront(blocks, 2);
      expect(result.map((b) => b.fallback)).toEqual(["A", "B", "C"]);
    });

    it("handles invalid index", () => {
      expect(bringToFront(blocks, -1)).toBe(blocks);
    });
  });

  describe("sendToBack", () => {
    it("moves block to start", () => {
      const result = sendToBack(blocks, 2);
      expect(result.map((b) => b.fallback)).toEqual(["C", "A", "B"]);
    });

    it("handles invalid index", () => {
      expect(sendToBack(blocks, -1)).toBe(blocks);
    });
  });

  it("does not mutate original array", () => {
    const original = [...blocks];
    bringForward(blocks, 0);
    sendBackward(blocks, 2);
    bringToFront(blocks, 0);
    sendToBack(blocks, 2);
    expect(blocks).toEqual(original);
  });
});
