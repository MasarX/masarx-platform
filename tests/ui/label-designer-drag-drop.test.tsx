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

function makeSvgMock(container: Element) {
  const svg = container.querySelector("[data-testid='label-canvas-svg']")!;
  jest.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: 400, bottom: 600,
    width: 400, height: 600, x: 0, y: 0, toJSON: () => {},
  });
  return svg;
}

function makeDataTransfer(data: string) {
  return {
    getData: jest.fn().mockReturnValue(data),
    dropEffect: "",
    effectAllowed: "",
    setData: jest.fn(),
  } as unknown as DataTransfer;
}

describe("LabelCanvas drag-drop from catalog", () => {
  it("accepts a drop with valid JSON and adds a block", () => {
    const blocks: TemplateBlock[] = [];
    const onBlocksChange = jest.fn();
    const { container } = render(
      <LabelCanvas blocks={blocks} onBlocksChange={onBlocksChange} />,
    );

    const viewport = container.querySelector("[data-testid='label-canvas-viewport']")!;
    makeSvgMock(container);

    const dropBlock: TemplateBlock = {
      type: "text",
      x: 10,
      y: 10,
      width: 150,
      height: 20,
      font_size: 12,
    };

    const dataTransfer = makeDataTransfer(JSON.stringify(dropBlock));

    fireEvent.dragOver(viewport, { dataTransfer });
    fireEvent.drop(viewport, { clientX: 100, clientY: 200, dataTransfer });

    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const result = onBlocksChange.mock.calls[0][0];
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("text");
    expect(typeof result[0].x).toBe("number");
    expect(typeof result[0].y).toBe("number");
  });

  it("ignores drop with invalid JSON", () => {
    const onBlocksChange = jest.fn();
    const { container } = render(
      <LabelCanvas blocks={[]} onBlocksChange={onBlocksChange} />,
    );

    const viewport = container.querySelector("[data-testid='label-canvas-viewport']")!;
    const dataTransfer = makeDataTransfer("not-json");

    fireEvent.drop(viewport, { clientX: 100, clientY: 200, dataTransfer });
    expect(onBlocksChange).not.toHaveBeenCalled();
  });

  it("ignores drop in readOnly mode", () => {
    const onBlocksChange = jest.fn();
    const { container } = render(
      <LabelCanvas blocks={[]} onBlocksChange={onBlocksChange} readOnly />,
    );

    const viewport = container.querySelector("[data-testid='label-canvas-viewport']")!;
    const dropBlock: TemplateBlock = { type: "text", x: 10, y: 10, width: 150, height: 20 };
    const dataTransfer = makeDataTransfer(JSON.stringify(dropBlock));

    fireEvent.drop(viewport, { clientX: 100, clientY: 200, dataTransfer });
    expect(onBlocksChange).not.toHaveBeenCalled();
  });

  it("drop barcode block sets correct type", () => {
    const onBlocksChange = jest.fn();
    const { container } = render(
      <LabelCanvas blocks={[]} onBlocksChange={onBlocksChange} />,
    );

    const viewport = container.querySelector("[data-testid='label-canvas-viewport']")!;
    makeSvgMock(container);

    const barcodeBlock: TemplateBlock = {
      type: "barcode",
      x: 10, y: 10, width: 180, height: 60,
      barcode_type: "code128",
    };
    const dataTransfer = makeDataTransfer(JSON.stringify(barcodeBlock));

    fireEvent.dragOver(viewport, { dataTransfer });
    fireEvent.drop(viewport, { clientX: 50, clientY: 100, dataTransfer });

    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const result = onBlocksChange.mock.calls[0][0];
    expect(result[0].type).toBe("barcode");
    expect(result[0].barcode_type).toBe("code128");
  });

  it("drop image block preserves asset_ref", () => {
    const onBlocksChange = jest.fn();
    const { container } = render(
      <LabelCanvas blocks={[]} onBlocksChange={onBlocksChange} />,
    );

    const viewport = container.querySelector("[data-testid='label-canvas-viewport']")!;
    makeSvgMock(container);

    const imageBlock: TemplateBlock = {
      type: "image",
      x: 10, y: 10, width: 80, height: 40,
      asset_ref: "company_logo.png",
    };
    const dataTransfer = makeDataTransfer(JSON.stringify(imageBlock));

    fireEvent.dragOver(viewport, { dataTransfer });
    fireEvent.drop(viewport, { clientX: 50, clientY: 100, dataTransfer });

    const result = onBlocksChange.mock.calls[0][0];
    expect(result[0].type).toBe("image");
    expect(result[0].asset_ref).toBe("company_logo.png");
  });

  it("drop line/rect block preserves stroke_width and fill_color", () => {
    const onBlocksChange = jest.fn();
    const { container } = render(
      <LabelCanvas blocks={[]} onBlocksChange={onBlocksChange} />,
    );

    const viewport = container.querySelector("[data-testid='label-canvas-viewport']")!;
    makeSvgMock(container);

    const rectBlock: TemplateBlock = {
      type: "rect",
      x: 10, y: 10, width: 100, height: 60,
      stroke_width: 2,
      fill_color: "#ff0000",
    };
    const dataTransfer = makeDataTransfer(JSON.stringify(rectBlock));

    fireEvent.dragOver(viewport, { dataTransfer });
    fireEvent.drop(viewport, { clientX: 50, clientY: 100, dataTransfer });

    const result = onBlocksChange.mock.calls[0][0];
    expect(result[0].type).toBe("rect");
    expect(result[0].stroke_width).toBe(2);
    expect(result[0].fill_color).toBe("#ff0000");
  });

  it("drop coordinates are numbers", () => {
    const onBlocksChange = jest.fn();
    const { container } = render(
      <LabelCanvas blocks={[]} onBlocksChange={onBlocksChange} />,
    );

    const viewport = container.querySelector("[data-testid='label-canvas-viewport']")!;
    makeSvgMock(container);

    const block: TemplateBlock = { type: "text", x: 0, y: 0, width: 100, height: 20 };
    const dataTransfer = makeDataTransfer(JSON.stringify(block));

    fireEvent.dragOver(viewport, { dataTransfer });
    fireEvent.drop(viewport, { clientX: 100, clientY: 100, dataTransfer });

    expect(onBlocksChange).toHaveBeenCalledTimes(1);
    const result = onBlocksChange.mock.calls[0][0];
    // Block should have x/y set by the drop handler (Math.max(0, ...) in source)
    expect(typeof result[0].x).toBe("number");
    expect(typeof result[0].y).toBe("number");
  });

  it("drop selects newly added block", () => {
    const onBlocksChange = jest.fn();
    const onSelectBlock = jest.fn();
    const { container } = render(
      <LabelCanvas blocks={[]} onBlocksChange={onBlocksChange} onSelectBlock={onSelectBlock} />,
    );

    const viewport = container.querySelector("[data-testid='label-canvas-viewport']")!;
    makeSvgMock(container);

    const block: TemplateBlock = { type: "text", x: 10, y: 10, width: 100, height: 20 };
    const dataTransfer = makeDataTransfer(JSON.stringify(block));

    fireEvent.dragOver(viewport, { dataTransfer });
    fireEvent.drop(viewport, { clientX: 100, clientY: 100, dataTransfer });

    expect(onSelectBlock).toHaveBeenCalledWith(0); // First block, index 0
  });

  it("drop with empty getData ignores", () => {
    const onBlocksChange = jest.fn();
    const { container } = render(
      <LabelCanvas blocks={[]} onBlocksChange={onBlocksChange} />,
    );

    const viewport = container.querySelector("[data-testid='label-canvas-viewport']")!;
    const dataTransfer = makeDataTransfer("");

    fireEvent.drop(viewport, { clientX: 100, clientY: 200, dataTransfer });
    expect(onBlocksChange).not.toHaveBeenCalled();
  });
});
