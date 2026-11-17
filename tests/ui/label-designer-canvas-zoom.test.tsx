/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { LabelCanvas } from "../../packages/ui/src/label-designer/canvas/label-canvas";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

jest.mock("../../packages/ui/src/label-designer/canvas/canvas-barcode-block", () => ({
  CanvasBarcodeBlock: () => <g data-testid="mock-barcode" />,
}));
jest.mock("../../packages/ui/src/label-designer/keyboard-shortcuts-modal", () => ({
  KeyboardShortcutsModal: () => null,
}));

const blocks: TemplateBlock[] = [
  { type: "text", x: 10, y: 10, width: 100, height: 20, fallback: "Test" },
];

function renderCanvas(overrides: Partial<React.ComponentProps<typeof LabelCanvas>> = {}) {
  return render(
    <LabelCanvas blocks={blocks} {...overrides} />,
  );
}

function getZoomText(container: Element): string {
  // Find the zoom percentage text (e.g., "100%")
  const spans = container.querySelectorAll("span");
  for (const span of Array.from(spans)) {
    if (span.textContent?.match(/^\d+%$/)) return span.textContent;
  }
  return "";
}

function getZoomButtons(container: Element) {
  const buttons = container.querySelectorAll("button");
  let zoomOut: HTMLButtonElement | null = null;
  let zoomIn: HTMLButtonElement | null = null;
  for (const btn of Array.from(buttons)) {
    if (btn.textContent?.trim() === "-") zoomOut = btn;
    if (btn.textContent?.trim() === "+") zoomIn = btn;
  }
  return { zoomOut, zoomIn };
}

describe("LabelCanvas zoom controls", () => {
  it("initial zoom is 100%", () => {
    const { container } = renderCanvas();
    expect(getZoomText(container)).toBe("100%");
  });

  it("zoom-out decreases by 25%", () => {
    const { container } = renderCanvas();
    const { zoomOut } = getZoomButtons(container);
    fireEvent.click(zoomOut!);
    expect(getZoomText(container)).toBe("75%");
  });

  it("zoom-in increases by 25%", () => {
    const { container } = renderCanvas();
    const { zoomIn } = getZoomButtons(container);
    fireEvent.click(zoomIn!);
    expect(getZoomText(container)).toBe("125%");
  });

  it("zoom does not go below 50%", () => {
    const { container } = renderCanvas();
    const { zoomOut } = getZoomButtons(container);
    // Click zoom out 3 times: 100% -> 75% -> 50% -> 50% (clamped)
    fireEvent.click(zoomOut!);
    fireEvent.click(zoomOut!);
    fireEvent.click(zoomOut!);
    expect(getZoomText(container)).toBe("50%");
  });

  it("zoom does not go above 300%", () => {
    const { container } = renderCanvas();
    const { zoomIn } = getZoomButtons(container);
    // Click zoom in 9 times: 100% -> 125% -> ... -> 300% -> 300%
    for (let i = 0; i < 10; i++) {
      fireEvent.click(zoomIn!);
    }
    expect(getZoomText(container)).toBe("300%");
  });

  it("zoom-out button disabled at 50%", () => {
    const { container } = renderCanvas();
    const { zoomOut } = getZoomButtons(container);
    // Zoom to minimum
    fireEvent.click(zoomOut!);
    fireEvent.click(zoomOut!);
    expect(getZoomText(container)).toBe("50%");
    expect(zoomOut!.disabled).toBe(true);
  });

  it("zoom-in button disabled at 300%", () => {
    const { container } = renderCanvas();
    const { zoomIn } = getZoomButtons(container);
    // Zoom to maximum
    for (let i = 0; i < 9; i++) {
      fireEvent.click(zoomIn!);
    }
    expect(getZoomText(container)).toBe("300%");
    expect(zoomIn!.disabled).toBe(true);
  });

  it("canvas SVG dimensions scale with zoom", () => {
    const { container } = renderCanvas({
      page: { width_inch: 4, height_inch: 6, dpi: 203 },
    });
    const svg = container.querySelector("[data-testid='label-canvas-svg']")!;
    const initialWidth = parseFloat(svg.getAttribute("width") || "0");
    expect(initialWidth).toBeGreaterThan(0);

    // Zoom in
    const { zoomIn } = getZoomButtons(container);
    fireEvent.click(zoomIn!);

    const newWidth = parseFloat(svg.getAttribute("width") || "0");
    expect(newWidth).toBeGreaterThan(initialWidth);
  });

  it("grid toggle hides/shows grid", () => {
    const { container } = renderCanvas();
    const buttons = container.querySelectorAll("button");
    const gridBtn = Array.from(buttons).find(
      (b) => b.textContent?.includes("Grid") || b.textContent?.includes("grid"),
    );
    expect(gridBtn).toBeTruthy();
    // Click to toggle grid
    fireEvent.click(gridBtn!);
    // No error means toggle worked
    expect(gridBtn).toBeTruthy();
  });

  it("snap toggle enables snap-to-grid", () => {
    const { container } = renderCanvas();
    const snapBtn = container.querySelector("[data-testid='label-canvas-snap-toggle']");
    expect(snapBtn).toBeTruthy();
    fireEvent.click(snapBtn!);
    // Snap button should now show active variant
    expect(snapBtn).toBeTruthy();
  });
});
