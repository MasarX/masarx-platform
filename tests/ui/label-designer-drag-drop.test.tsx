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
  it("dragging a legacy right anchor uses max dimensions without adding explicit dimensions", () => {
    const legacy = { type: "text" as const, x: 270, y: 100, max_width: 100, max_height: 30, align: "right" as const, fallback: "Text" };
    const changed = jest.fn();
    const { container } = render(<LabelCanvas blocks={[legacy]} onBlocksChange={changed} />);
    fireEvent.mouseDown(container.querySelector("[data-block-index='0']")!, { clientX: 270, clientY: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 10, clientY: 430 });
    fireEvent.mouseUp(window);
    expect(changed.mock.calls.at(-1)![0]).toEqual([{ ...legacy, x: 100, y: 402 }]);
  });

  it("keeps untouched legacy block identity and geometry after delete and reorder", () => {
    const first: TemplateBlock = { type: "text", x: 0, y: 0, fallback: "first" };
    const legacy: TemplateBlock = { type: "text", x: 270, y: 100, align: "right", fallback: "sender_phone" };
    const changed = jest.fn();
    const { rerender } = render(<LabelCanvas blocks={[first, legacy]} selectedBlockIndex={0} onBlocksChange={changed} />);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(changed.mock.calls.at(-1)![0]).toEqual([legacy]);
    expect(changed.mock.calls.at(-1)![0][0]).toBe(legacy);
    rerender(<LabelCanvas blocks={[first, legacy]} selectedBlockIndex={1} onBlocksChange={changed} />);
    fireEvent.keyDown(window, { key: "[", ctrlKey: true });
    expect(changed.mock.calls.at(-1)![0]).toEqual([legacy, first]);
    expect(changed.mock.calls.at(-1)![0][0]).toBe(legacy);
    expect(changed.mock.calls.at(-1)![0][1]).toBe(first);
  });

  it("inline text edits preserve legacy right anchors and absent dimensions", () => {
    const legacy: TemplateBlock = { type: "text", x: 270, y: 100, align: "right", fallback: "sender_phone" };
    const changed = jest.fn();
    const { container, getByTestId } = render(<LabelCanvas blocks={[legacy]} onBlocksChange={changed} />);
    fireEvent.doubleClick(container.querySelector("[data-block-index='0']")!);
    fireEvent.change(getByTestId("canvas-inline-editor"), { target: { value: "Updated phone" } });
    fireEvent.keyDown(getByTestId("canvas-inline-editor"), { key: "Enter" });
    expect(changed.mock.calls.at(-1)![0][0]).toEqual({ ...legacy, fallback: "Updated phone" });
  });

  it("starts a direct block drag from the initiating event and wires resize to persisted blocks", () => {
    const initial: TemplateBlock = { type: "text", x: 10, y: 20, width: 100, height: 40 };
    const changed = jest.fn();
    function Editor() {
      const [blocks, setBlocks] = React.useState([initial]);
      return <LabelCanvas blocks={blocks} onBlocksChange={(next) => { changed(next); setBlocks(next); }} />;
    }
    const { container, getByTestId } = render(<Editor />);
    const block = container.querySelector("[data-block-index='0']")!;
    fireEvent.mouseDown(block, { clientX: 45, clientY: 75, button: 0 });
    fireEvent.mouseMove(window, { clientX: 65, clientY: 105 });
    fireEvent.mouseUp(window);
    expect(changed.mock.calls.at(-1)![0][0]).toMatchObject({ x: 30, y: 50 });
    fireEvent.mouseDown(getByTestId("label-canvas-resize-se"), { clientX: 130, clientY: 90, button: 0 });
    fireEvent.mouseMove(window, { clientX: 150, clientY: 110 });
    fireEvent.mouseUp(window);
    expect(changed.mock.calls.at(-1)![0][0]).toMatchObject({ x: 30, y: 50, width: 120, height: 60 });
  });

  it.each([{ readOnly: true }, { locked: true }])("locked/readonly initiation does not mutate: %p", ({ readOnly, locked }) => {
    const changed = jest.fn();
    const { container } = render(<LabelCanvas readOnly={readOnly} blocks={[{ type: "text", x: 10, y: 10, width: 80, height: 20, locked }]} onBlocksChange={changed} />);
    fireEvent.mouseDown(container.querySelector("[data-block-index='0']")!, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.mouseMove(window, { clientX: 50, clientY: 50 });
    fireEvent.mouseUp(window);
    expect(changed).not.toHaveBeenCalled();
  });

  it("ignores secondary-button drags and ends a gesture on window blur", () => {
    const changed = jest.fn();
    const { container } = render(<LabelCanvas blocks={[{ type: "text", x: 10, y: 10, width: 80, height: 20 }]} onBlocksChange={changed} />);
    const block = container.querySelector("[data-block-index='0']")!;
    fireEvent.mouseDown(block, { clientX: 10, clientY: 10, button: 2 });
    fireEvent.mouseMove(window, { clientX: 50, clientY: 50 });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.mouseDown(block, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.blur(window);
    fireEvent.mouseMove(window, { clientX: 50, clientY: 50 });
    expect(changed).not.toHaveBeenCalled();
  });

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
