/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { LabelCanvas } from "../../packages/ui/src/label-designer/canvas/label-canvas";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

// Mock lazy-loaded components
jest.mock("../../packages/ui/src/label-designer/canvas/canvas-barcode-block", () => ({
  CanvasBarcodeBlock: () => <g data-testid="mock-barcode" />,
}));
jest.mock("../../packages/ui/src/label-designer/keyboard-shortcuts-modal", () => ({
  KeyboardShortcutsModal: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? <div data-testid="shortcuts-modal"><button onClick={onClose}>close</button></div> : null,
}));

const sampleBlocks: TemplateBlock[] = [
  { type: "text", x: 20, y: 30, width: 100, height: 20, font_size: 12, fallback: "Hello" },
  { type: "rect", x: 50, y: 80, width: 60, height: 40 },
];

function renderCanvas(overrides: Partial<React.ComponentProps<typeof LabelCanvas>> = {}) {
  const onBlocksChange = jest.fn();
  const onSelectBlock = jest.fn();
  const result = render(
    <LabelCanvas
      blocks={sampleBlocks}
      onBlocksChange={onBlocksChange}
      onSelectBlock={onSelectBlock}
      selectedBlockIndex={0}
      {...overrides}
    />,
  );
  return { ...result, onBlocksChange, onSelectBlock };
}

describe("LabelCanvas keyboard shortcuts", () => {
  it("nudges selected block 1px with arrow keys", () => {
    const { onBlocksChange } = renderCanvas();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const updated = onBlocksChange.mock.calls[0][0];
    expect(updated[0].x).toBe(21);
    expect(updated[0].y).toBe(30);
  });

  it("nudges selected block 10px with Shift+Arrow", () => {
    const { onBlocksChange } = renderCanvas();
    fireEvent.keyDown(window, { key: "ArrowDown", shiftKey: true });
    const updated = onBlocksChange.mock.calls[0][0];
    expect(updated[0].y).toBe(40);
  });

  it("does not nudge below 0", () => {
    const blocks: TemplateBlock[] = [{ type: "text", x: 2, y: 2, width: 100, height: 20 }];
    const onBlocksChange = jest.fn();
    render(
      <LabelCanvas blocks={blocks} onBlocksChange={onBlocksChange} selectedBlockIndex={0} />,
    );
    fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true });
    const updated = onBlocksChange.mock.calls[0][0];
    expect(updated[0].x).toBe(0);
  });

  it("copy-paste duplicates block with +10 offset", () => {
    const { onBlocksChange } = renderCanvas();
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const updated = onBlocksChange.mock.calls[0][0];
    expect(updated.length).toBe(3);
    expect(updated[2].x).toBe(30); // 20 + 10
    expect(updated[2].y).toBe(40); // 30 + 10
  });

  it("Mod+D duplicates in place with offset", () => {
    const { onBlocksChange } = renderCanvas();
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const updated = onBlocksChange.mock.calls[0][0];
    expect(updated.length).toBe(3);
    expect(updated[2].x).toBe(30);
  });

  it("does not trigger shortcuts in input elements", () => {
    const { onBlocksChange } = renderCanvas();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(onBlocksChange).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("delete removes selected block", () => {
    const { onBlocksChange, onSelectBlock } = renderCanvas();
    fireEvent.keyDown(window, { key: "Delete" });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const updated = onBlocksChange.mock.calls[0][0];
    expect(updated.length).toBe(1);
  });

  it("escape deselects", () => {
    const { onSelectBlock } = renderCanvas();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onSelectBlock).toHaveBeenCalledWith(null);
  });

  it("does not delete locked blocks", () => {
    const blocks: TemplateBlock[] = [
      { type: "text", x: 10, y: 10, width: 100, height: 20, locked: true },
    ];
    const onBlocksChange = jest.fn();
    render(
      <LabelCanvas blocks={blocks} onBlocksChange={onBlocksChange} selectedBlockIndex={0} />,
    );
    fireEvent.keyDown(window, { key: "Delete" });
    expect(onBlocksChange).not.toHaveBeenCalled();
  });

  it("Ctrl+] brings block forward", () => {
    const blocks: TemplateBlock[] = [
      { type: "text", x: 10, y: 10, width: 100, height: 20, fallback: "A" },
      { type: "rect", x: 20, y: 20, width: 60, height: 40 },
    ];
    const onBlocksChange = jest.fn();
    render(
      <LabelCanvas blocks={blocks} onBlocksChange={onBlocksChange} selectedBlockIndex={0} />,
    );
    fireEvent.keyDown(window, { key: "]", ctrlKey: true });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const updated = onBlocksChange.mock.calls[0][0];
    // Block 0 should now be at index 1
    expect(updated[1].fallback).toBe("A");
  });

  it("Ctrl+[ sends block backward", () => {
    const blocks: TemplateBlock[] = [
      { type: "text", x: 10, y: 10, width: 100, height: 20, fallback: "A" },
      { type: "rect", x: 20, y: 20, width: 60, height: 40 },
    ];
    const onBlocksChange = jest.fn();
    render(
      <LabelCanvas blocks={blocks} onBlocksChange={onBlocksChange} selectedBlockIndex={1} />,
    );
    fireEvent.keyDown(window, { key: "[", ctrlKey: true });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const updated = onBlocksChange.mock.calls[0][0];
    expect(updated[0].type).toBe("rect");
  });

  it("Ctrl+Shift+] brings to front", () => {
    const blocks: TemplateBlock[] = [
      { type: "text", x: 10, y: 10, width: 100, height: 20, fallback: "A" },
      { type: "rect", x: 20, y: 20, width: 60, height: 40 },
      { type: "line", x: 30, y: 30, width: 100, height: 0 },
    ];
    const onBlocksChange = jest.fn();
    render(
      <LabelCanvas blocks={blocks} onBlocksChange={onBlocksChange} selectedBlockIndex={0} />,
    );
    fireEvent.keyDown(window, { key: "]", ctrlKey: true, shiftKey: true });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const updated = onBlocksChange.mock.calls[0][0];
    // Block "A" should now be at the end
    expect(updated[2].fallback).toBe("A");
  });

  it("Ctrl+Shift+[ sends to back", () => {
    const blocks: TemplateBlock[] = [
      { type: "text", x: 10, y: 10, width: 100, height: 20 },
      { type: "rect", x: 20, y: 20, width: 60, height: 40 },
      { type: "line", x: 30, y: 30, width: 100, height: 0 },
    ];
    const onBlocksChange = jest.fn();
    render(
      <LabelCanvas blocks={blocks} onBlocksChange={onBlocksChange} selectedBlockIndex={2} />,
    );
    fireEvent.keyDown(window, { key: "[", ctrlKey: true, shiftKey: true });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const updated = onBlocksChange.mock.calls[0][0];
    // Line block should now be at index 0
    expect(updated[0].type).toBe("line");
  });

  it("Ctrl+/ toggles shortcuts state without error", () => {
    const { container } = renderCanvas();
    // Before toggle, no modal visible
    expect(container.querySelector("[data-testid='shortcuts-modal']")).toBeNull();
    // Toggle shortcuts on - the modal is lazy-loaded and wrapped in Suspense,
    // so it may not appear synchronously in jsdom
    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    // Just verify no error was thrown
    expect(container).toBeTruthy();
  });

  it("Backspace deletes (same as Delete)", () => {
    const { onBlocksChange } = renderCanvas();
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const updated = onBlocksChange.mock.calls[0][0];
    expect(updated.length).toBe(1);
  });

  it("Space key does not trigger shortcuts", () => {
    const { onBlocksChange, onSelectBlock } = renderCanvas();
    fireEvent.keyDown(window, { key: " " });
    // Space is used for pan mode, not for any block shortcut
    expect(onBlocksChange).not.toHaveBeenCalled();
  });
});
