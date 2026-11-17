/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, fireEvent } from "@testing-library/react";
import { CanvasBlock } from "../../packages/ui/src/label-designer/canvas/canvas-block";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

// Mock lazy barcode block
jest.mock("../../packages/ui/src/label-designer/canvas/canvas-barcode-block", () => ({
  CanvasBarcodeBlock: ({ block }: { block: TemplateBlock }) => (
    <g data-testid="mock-barcode">{block.fallback || "barcode"}</g>
  ),
}));

const defaultHandlers = {
  onSelect: jest.fn(),
  onHover: jest.fn(),
};

function renderBlock(
  block: TemplateBlock,
  overrides: Partial<React.ComponentProps<typeof CanvasBlock>> = {},
) {
  const props = {
    block,
    index: 0,
    scale: 1,
    isSelected: false,
    isHovered: false,
    ...defaultHandlers,
    ...overrides,
  };
  return render(
    <svg>
      <CanvasBlock {...props} />
    </svg>,
  );
}

describe("CanvasBlock", () => {
  beforeEach(() => {
    defaultHandlers.onSelect.mockClear();
    defaultHandlers.onHover.mockClear();
  });

  it("renders text block with fallback content", () => {
    const block: TemplateBlock = {
      type: "text", x: 10, y: 10, width: 100, height: 20,
      fallback: "Hello",
    };
    const { container } = renderBlock(block);
    const text = container.querySelector("text");
    expect(text?.textContent).toBe("Hello");
  });

  it("renders text block with value_path when no fallback", () => {
    const block: TemplateBlock = {
      type: "text", x: 10, y: 10, width: 100, height: 20,
      value_path: "shipment.tracking_number",
    };
    const { container } = renderBlock(block);
    const text = container.querySelector("text");
    expect(text?.textContent).toBe("shipment.tracking_number");
  });

  it('renders text block with "Text" default', () => {
    const block: TemplateBlock = {
      type: "text", x: 10, y: 10, width: 100, height: 20,
    };
    const { container } = renderBlock(block);
    const text = container.querySelector("text");
    expect(text?.textContent).toBe("Text");
  });

  it("renders barcode block with Suspense fallback", () => {
    const block: TemplateBlock = {
      type: "barcode", x: 10, y: 10, width: 180, height: 60,
      barcode_type: "code128", fallback: "12345",
    };
    const { container } = renderBlock(block);
    // Should render the barcode wrapper group
    const g = container.querySelector("[data-block-index='0']");
    expect(g).toBeTruthy();
  });

  it("renders image block with asset_ref label", () => {
    const block: TemplateBlock = {
      type: "image", x: 10, y: 10, width: 80, height: 40,
      asset_ref: "company_logo.png",
    };
    const { container } = renderBlock(block);
    const text = container.querySelector("text");
    expect(text?.textContent).toBe("company_logo.png");
  });

  it('renders image block with "image" default', () => {
    const block: TemplateBlock = {
      type: "image", x: 10, y: 10, width: 80, height: 40,
    };
    const { container } = renderBlock(block);
    const text = container.querySelector("text");
    expect(text?.textContent).toBe("image");
  });

  it("renders line block with hit area (transparent stroke)", () => {
    const block: TemplateBlock = {
      type: "line", x: 10, y: 10, width: 200, height: 0,
      stroke_width: 2,
    };
    const { container } = renderBlock(block);
    const lines = container.querySelectorAll("line");
    // Should have visible line + transparent hit area line
    expect(lines.length).toBe(2);
    const hitArea = lines[1];
    expect(hitArea?.getAttribute("stroke")).toBe("transparent");
  });

  it("renders rect block with fill_color", () => {
    const block: TemplateBlock = {
      type: "rect", x: 10, y: 10, width: 100, height: 60,
      fill_color: "#ff0000",
    };
    const { container } = renderBlock(block);
    const rect = container.querySelector("rect[fill='#ff0000']");
    expect(rect).toBeTruthy();
  });

  it("resolveColor adds # prefix when missing", () => {
    const block: TemplateBlock = {
      type: "text", x: 10, y: 10, width: 100, height: 20,
      color: "ff0000", fallback: "Red",
    };
    const { container } = renderBlock(block);
    const text = container.querySelector("text");
    expect(text?.getAttribute("fill")).toBe("#ff0000");
  });

  it("resolveColor passes through # prefixed colors", () => {
    const block: TemplateBlock = {
      type: "text", x: 10, y: 10, width: 100, height: 20,
      color: "#00ff00", fallback: "Green",
    };
    const { container } = renderBlock(block);
    const text = container.querySelector("text");
    expect(text?.getAttribute("fill")).toBe("#00ff00");
  });

  it("rotation transform applied at block center", () => {
    const block: TemplateBlock = {
      type: "text", x: 10, y: 10, width: 100, height: 20,
      rotation: 45, fallback: "Rotated",
    };
    const { container } = renderBlock(block);
    const g = container.querySelector("[data-block-index='0']");
    const transform = g?.getAttribute("transform");
    // Should contain rotate(45, cx, cy)
    expect(transform).toContain("rotate(45");
    // Center should be at x + w/2 = 10 + 50 = 60, y + h/2 = 10 + 10 = 20
    expect(transform).toContain("60");
    expect(transform).toContain("20");
  });

  it("selected block shows blue outline (#2563eb)", () => {
    const block: TemplateBlock = {
      type: "text", x: 10, y: 10, width: 100, height: 20,
      fallback: "Selected",
    };
    const { container } = renderBlock(block, { isSelected: true });
    const rects = container.querySelectorAll("rect");
    const outlineRect = Array.from(rects).find(
      (r) => r.getAttribute("stroke") === "#2563eb",
    );
    expect(outlineRect).toBeTruthy();
  });

  it("hovered block shows light blue outline (#93c5fd)", () => {
    const block: TemplateBlock = {
      type: "text", x: 10, y: 10, width: 100, height: 20,
      fallback: "Hovered",
    };
    const { container } = renderBlock(block, { isHovered: true });
    const rects = container.querySelectorAll("rect");
    const hoverRect = Array.from(rects).find(
      (r) => r.getAttribute("stroke") === "#93c5fd",
    );
    expect(hoverRect).toBeTruthy();
  });

  it("non-selected non-hovered has transparent outline", () => {
    const block: TemplateBlock = {
      type: "text", x: 10, y: 10, width: 100, height: 20,
      fallback: "Normal",
    };
    const { container } = renderBlock(block, { isSelected: false, isHovered: false });
    const rects = container.querySelectorAll("rect");
    const normalRect = Array.from(rects).find(
      (r) => r.getAttribute("stroke") === "transparent",
    );
    expect(normalRect).toBeTruthy();
  });

  it("calls onSelect on mouseDown", () => {
    const onSelect = jest.fn();
    const block: TemplateBlock = {
      type: "text", x: 10, y: 10, width: 100, height: 20,
      fallback: "Click me",
    };
    const { container } = renderBlock(block, { onSelect });
    const g = container.querySelector("[data-block-index='0']")!;
    fireEvent.mouseDown(g);
    expect(onSelect).toHaveBeenCalledWith(0);
  });
});
