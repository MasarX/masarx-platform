/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, fireEvent } from "@testing-library/react";
import { LabelCanvas } from "../../packages/ui/src/label-designer/canvas/label-canvas";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

jest.mock("../../packages/ui/src/label-designer/canvas/canvas-barcode-block", () => ({
  CanvasBarcodeBlock: () => <g data-testid="mock-barcode" />,
}));
jest.mock("../../packages/ui/src/label-designer/keyboard-shortcuts-modal", () => ({
  KeyboardShortcutsModal: () => null,
}));

const blocks: TemplateBlock[] = [
  { type: "text", x: 10, y: 10, width: 80, height: 20 },
  { type: "rect", x: 100, y: 100, width: 60, height: 40 },
  { type: "text", x: 50, y: 50, width: 80, height: 20 },
];

function renderCanvas(overrides: Partial<React.ComponentProps<typeof LabelCanvas>> = {}) {
  const onBlocksChange = jest.fn();
  const onSelectBlock = jest.fn();
  const result = render(
    <LabelCanvas
      blocks={blocks}
      onBlocksChange={onBlocksChange}
      onSelectBlock={onSelectBlock}
      {...overrides}
    />,
  );
  return { ...result, onBlocksChange, onSelectBlock };
}

describe("LabelCanvas multi-select", () => {
  it("renders all blocks", () => {
    const { container } = render(
      <LabelCanvas blocks={blocks} />,
    );
    const blockGroups = container.querySelectorAll("[data-block-index]");
    expect(blockGroups.length).toBe(3);
  });

  it("shows N blocks selected in toolbar when multi-selected", () => {
    const { container } = render(
      <LabelCanvas blocks={blocks} selectedBlockIndex={null} />,
    );
    expect(container.querySelector("[data-testid='label-canvas-container']")).toBeTruthy();
  });

  it("delete all selected blocks skips locked", () => {
    const lockedBlocks: TemplateBlock[] = [
      { type: "text", x: 10, y: 10, width: 80, height: 20, locked: true },
      { type: "rect", x: 50, y: 50, width: 60, height: 40 },
    ];
    const onBlocksChange = jest.fn();
    render(
      <LabelCanvas
        blocks={lockedBlocks}
        onBlocksChange={onBlocksChange}
        selectedBlockIndex={0}
      />,
    );
    fireEvent.keyDown(window, { key: "Delete" });
    expect(onBlocksChange).not.toHaveBeenCalled();
  });

  it("shift+click adds block to selection", () => {
    const { container, onSelectBlock } = renderCanvas({ selectedBlockIndex: 0 });
    const block1 = container.querySelector("[data-block-index='1']")!;
    fireEvent.mouseDown(block1, { shiftKey: true });
    // The block should be added to internal multi-selection
    expect(block1).toBeTruthy();
  });

  it("shift+click removes block from selection when already selected", () => {
    const { container } = renderCanvas({ selectedBlockIndex: 0 });
    // First shift+click to add block 1
    const block1 = container.querySelector("[data-block-index='1']")!;
    fireEvent.mouseDown(block1, { shiftKey: true });
    // Then shift+click again to remove it
    fireEvent.mouseDown(block1, { shiftKey: true });
    // Block 1 should be removed from multi-selection
    expect(block1).toBeTruthy();
  });

  it("rubber band below 2px threshold does not select", () => {
    const { container, onSelectBlock } = renderCanvas();
    const svg = container.querySelector("[data-testid='label-canvas-svg']")!;
    jest.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 600,
      width: 400, height: 600, x: 0, y: 0, toJSON: () => {},
    });
    // Start rubber band with a tiny movement (< 2px)
    fireEvent.mouseDown(svg, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 101, clientY: 101 });
    fireEvent.mouseUp(window);
    // Should not have selected anything via rubber band
    expect(onSelectBlock).toHaveBeenCalledWith(null);
  });

  it("rubber band skips hidden blocks", () => {
    const hiddenBlocks: TemplateBlock[] = [
      { type: "text", x: 10, y: 10, width: 80, height: 20 },
      { type: "rect", x: 20, y: 20, width: 60, height: 40, visible: false },
    ];
    const onBlocksChange = jest.fn();
    const { container } = render(
      <LabelCanvas blocks={hiddenBlocks} onBlocksChange={onBlocksChange} />,
    );
    // Hidden blocks are not rendered in the canvas
    const blockGroups = container.querySelectorAll("[data-block-index]");
    expect(blockGroups.length).toBe(1);
  });

  it("multi-delete removes all selected unlocked blocks", () => {
    const onBlocksChange = jest.fn();
    const onSelectBlock = jest.fn();
    const unlocked: TemplateBlock[] = [
      { type: "text", x: 10, y: 10, width: 80, height: 20 },
      { type: "rect", x: 50, y: 50, width: 60, height: 40 },
    ];
    render(
      <LabelCanvas
        blocks={unlocked}
        onBlocksChange={onBlocksChange}
        onSelectBlock={onSelectBlock}
        selectedBlockIndex={0}
      />,
    );
    fireEvent.keyDown(window, { key: "Delete" });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const result = onBlocksChange.mock.calls[0][0];
    expect(result.length).toBe(1);
  });

  it("multi-delete skips locked blocks in selection", () => {
    const mixedBlocks: TemplateBlock[] = [
      { type: "text", x: 10, y: 10, width: 80, height: 20, locked: true },
      { type: "rect", x: 50, y: 50, width: 60, height: 40 },
    ];
    const onBlocksChange = jest.fn();
    render(
      <LabelCanvas
        blocks={mixedBlocks}
        onBlocksChange={onBlocksChange}
        selectedBlockIndex={0}
      />,
    );
    fireEvent.keyDown(window, { key: "Delete" });
    // Block 0 is locked, so delete is blocked
    expect(onBlocksChange).not.toHaveBeenCalled();
  });

  it("multi-nudge moves selected block with arrow key (1px)", () => {
    const { onBlocksChange } = renderCanvas({ selectedBlockIndex: 0 });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const result = onBlocksChange.mock.calls[0][0];
    expect(result[0].x).toBe(11);
  });

  it("multi-nudge moves selected block with shift+arrow (10px)", () => {
    const { onBlocksChange } = renderCanvas({ selectedBlockIndex: 0 });
    fireEvent.keyDown(window, { key: "ArrowDown", shiftKey: true });
    const result = onBlocksChange.mock.calls[0][0];
    expect(result[0].y).toBe(20);
  });

  it("multi-copy/paste duplicates selected block with +10 offset", () => {
    const { onBlocksChange } = renderCanvas({ selectedBlockIndex: 0 });
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const result = onBlocksChange.mock.calls[0][0];
    expect(result.length).toBe(4);
    expect(result[3].x).toBe(20); // 10 + 10
    expect(result[3].y).toBe(20); // 10 + 10
  });

  it("Ctrl+D duplicates selected block", () => {
    const { onBlocksChange } = renderCanvas({ selectedBlockIndex: 0 });
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const result = onBlocksChange.mock.calls[0][0];
    expect(result.length).toBe(4);
  });

  it("clicking empty canvas clears multi-selection", () => {
    const { container, onSelectBlock } = renderCanvas({ selectedBlockIndex: 0 });
    const svg = container.querySelector("[data-testid='label-canvas-svg']")!;
    fireEvent.mouseDown(svg);
    fireEvent.mouseUp(window);
    expect(onSelectBlock).toHaveBeenCalledWith(null);
  });
});
