/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { CanvasLayersPanel } from "../../packages/ui/src/label-designer/canvas/canvas-layers-panel";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

const blocks: TemplateBlock[] = [
  { type: "text", x: 10, y: 10, width: 100, height: 20, name: "Title" },
  { type: "barcode", x: 10, y: 50, width: 180, height: 60 },
  { type: "rect", x: 5, y: 5, width: 280, height: 420, visible: false },
];

describe("CanvasLayersPanel", () => {
  it("renders all layers", () => {
    render(
      <CanvasLayersPanel
        blocks={blocks}
        selectedIndices={[]}
        onSelect={jest.fn()}
        onBlocksChange={jest.fn()}
      />,
    );
    expect(screen.getByTestId("layers-panel")).toBeTruthy();
    expect(screen.getByTestId("layer-0")).toBeTruthy();
    expect(screen.getByTestId("layer-1")).toBeTruthy();
    expect(screen.getByTestId("layer-2")).toBeTruthy();
  });

  it("shows block name when set", () => {
    render(
      <CanvasLayersPanel
        blocks={blocks}
        selectedIndices={[]}
        onSelect={jest.fn()}
        onBlocksChange={jest.fn()}
      />,
    );
    expect(screen.getByText("Title")).toBeTruthy();
  });

  it("shows type+index when name is not set", () => {
    render(
      <CanvasLayersPanel
        blocks={blocks}
        selectedIndices={[]}
        onSelect={jest.fn()}
        onBlocksChange={jest.fn()}
      />,
    );
    expect(screen.getByText("barcode #1")).toBeTruthy();
  });

  it("highlights selected layer", () => {
    const { container } = render(
      <CanvasLayersPanel
        blocks={blocks}
        selectedIndices={[0]}
        onSelect={jest.fn()}
        onBlocksChange={jest.fn()}
      />,
    );
    const layer0 = container.querySelector("[data-testid='layer-0']");
    expect(layer0?.className).toContain("bg-blue-50");
  });

  it("reduces opacity for hidden layers", () => {
    const { container } = render(
      <CanvasLayersPanel
        blocks={blocks}
        selectedIndices={[]}
        onSelect={jest.fn()}
        onBlocksChange={jest.fn()}
      />,
    );
    const layer2 = container.querySelector("[data-testid='layer-2']");
    expect(layer2?.className).toContain("opacity-50");
  });

  it("calls onSelect when layer is clicked", () => {
    const onSelect = jest.fn();
    render(
      <CanvasLayersPanel
        blocks={blocks}
        selectedIndices={[]}
        onSelect={onSelect}
        onBlocksChange={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("layer-1"));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("toggles visibility when eye icon clicked", () => {
    const onBlocksChange = jest.fn();
    render(
      <CanvasLayersPanel
        blocks={blocks}
        selectedIndices={[]}
        onSelect={jest.fn()}
        onBlocksChange={onBlocksChange}
      />,
    );
    fireEvent.click(screen.getByTestId("layer-0-visibility"));
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const updated = onBlocksChange.mock.calls[0][0];
    expect(updated[0].visible).toBe(false);
  });

  it("toggles lock when lock icon clicked", () => {
    const onBlocksChange = jest.fn();
    render(
      <CanvasLayersPanel
        blocks={blocks}
        selectedIndices={[]}
        onSelect={jest.fn()}
        onBlocksChange={onBlocksChange}
      />,
    );
    fireEvent.click(screen.getByTestId("layer-0-lock"));
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const updated = onBlocksChange.mock.calls[0][0];
    expect(updated[0].locked).toBe(true);
  });

  it("keeps visibility and lock mutations disabled in read-only mode", () => {
    const onBlocksChange = jest.fn();
    render(
      <CanvasLayersPanel
        blocks={blocks}
        selectedIndices={[]}
        readOnly
        onSelect={jest.fn()}
        onBlocksChange={onBlocksChange}
      />,
    );

    const visibility = screen.getByTestId("layer-0-visibility");
    const lock = screen.getByTestId("layer-0-lock");
    expect(visibility).toBeDisabled();
    expect(lock).toBeDisabled();
    fireEvent.click(visibility);
    fireEvent.click(lock);
    expect(onBlocksChange).not.toHaveBeenCalled();
  });

  it("empty state with no blocks", () => {
    const { container } = render(
      <CanvasLayersPanel
        blocks={[]}
        selectedIndices={[]}
        onSelect={jest.fn()}
        onBlocksChange={jest.fn()}
      />,
    );
    expect(screen.getByTestId("layers-panel")).toBeTruthy();
    // No layer items
    expect(container.querySelector("[data-testid='layer-0']")).toBeNull();
  });

  it("lock icon for locked blocks", () => {
    const lockedBlocks: TemplateBlock[] = [
      { type: "text", x: 10, y: 10, width: 100, height: 20, locked: true, name: "Locked" },
    ];
    render(
      <CanvasLayersPanel
        blocks={lockedBlocks}
        selectedIndices={[]}
        onSelect={jest.fn()}
        onBlocksChange={jest.fn()}
      />,
    );
    const lockBtn = screen.getByTestId("layer-0-lock");
    expect(lockBtn).toBeTruthy();
  });

  it("handles 20+ blocks without error", () => {
    const manyBlocks: TemplateBlock[] = Array.from({ length: 25 }, (_, i) => ({
      type: "text" as const,
      x: 10,
      y: 10 + i * 20,
      width: 100,
      height: 20,
      name: `Block ${i}`,
    }));
    const { container } = render(
      <CanvasLayersPanel
        blocks={manyBlocks}
        selectedIndices={[]}
        onSelect={jest.fn()}
        onBlocksChange={jest.fn()}
      />,
    );
    expect(container.querySelectorAll("[data-testid^='layer-']").length).toBeGreaterThanOrEqual(25);
  });

  it("multi-select highlights multiple layers", () => {
    const { container } = render(
      <CanvasLayersPanel
        blocks={blocks}
        selectedIndices={[0, 1]}
        onSelect={jest.fn()}
        onBlocksChange={jest.fn()}
      />,
    );
    const layer0 = container.querySelector("[data-testid='layer-0']");
    const layer1 = container.querySelector("[data-testid='layer-1']");
    expect(layer0?.className).toContain("bg-blue-50");
    expect(layer1?.className).toContain("bg-blue-50");
  });

  it("block type in layer label", () => {
    const typedBlocks: TemplateBlock[] = [
      { type: "image", x: 10, y: 10, width: 80, height: 40 },
    ];
    render(
      <CanvasLayersPanel
        blocks={typedBlocks}
        selectedIndices={[]}
        onSelect={jest.fn()}
        onBlocksChange={jest.fn()}
      />,
    );
    expect(screen.getByText("image #0")).toBeTruthy();
  });

  it("toggling visibility on hidden block shows it", () => {
    const hiddenBlocks: TemplateBlock[] = [
      { type: "text", x: 10, y: 10, width: 100, height: 20, visible: false },
    ];
    const onBlocksChange = jest.fn();
    render(
      <CanvasLayersPanel
        blocks={hiddenBlocks}
        selectedIndices={[]}
        onSelect={jest.fn()}
        onBlocksChange={onBlocksChange}
      />,
    );
    fireEvent.click(screen.getByTestId("layer-0-visibility"));
    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const updated = onBlocksChange.mock.calls[0][0];
    expect(updated[0].visible).toBe(true);
  });

  it("layers in correct z-order (last block is topmost)", () => {
    const orderedBlocks: TemplateBlock[] = [
      { type: "text", x: 10, y: 10, width: 100, height: 20, name: "Bottom" },
      { type: "rect", x: 20, y: 20, width: 60, height: 40, name: "Middle" },
      { type: "image", x: 30, y: 30, width: 80, height: 40, name: "Top" },
    ];
    const { container } = render(
      <CanvasLayersPanel
        blocks={orderedBlocks}
        selectedIndices={[]}
        onSelect={jest.fn()}
        onBlocksChange={jest.fn()}
      />,
    );
    // All 3 layers should render
    expect(container.querySelector("[data-testid='layer-0']")).toBeTruthy();
    expect(container.querySelector("[data-testid='layer-1']")).toBeTruthy();
    expect(container.querySelector("[data-testid='layer-2']")).toBeTruthy();
    // Verify labels
    expect(screen.getByText("Bottom")).toBeTruthy();
    expect(screen.getByText("Middle")).toBeTruthy();
    expect(screen.getByText("Top")).toBeTruthy();
  });
});
