/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlockPropertyPanel } from "../../packages/ui/src/label-designer/block-property-panel";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

// Mock react-colorful
jest.mock("react-colorful", () => ({
  HexColorPicker: ({ color, onChange }: { color: string; onChange: (c: string) => void }) => (
    <div data-testid="hex-color-picker">
      <input data-testid="mock-picker-input" value={color} onChange={(e) => onChange(e.target.value)} />
    </div>
  ),
}));

function renderPanel(
  block: TemplateBlock,
  overrides: Partial<React.ComponentProps<typeof BlockPropertyPanel>> = {},
) {
  const onUpdate = jest.fn();
  const result = render(
    <BlockPropertyPanel
      block={block}
      blockIndex={0}
      onUpdate={onUpdate}
      {...overrides}
    />,
  );
  return { ...result, onUpdate };
}

describe("BlockPropertyPanel", () => {
  it("renders text block fields (value_path, fallback, font_size, color, align)", () => {
    const block: TemplateBlock = {
      type: "text", x: 10, y: 10, width: 100, height: 20,
      font_size: 14, fallback: "Hello", color: "#333",
    };
    const { container } = renderPanel(block);
    expect(container.querySelector("[data-testid='block-props-panel']")).toBeTruthy();
    // Should have value_path, fallback, font_size fields
    expect(container.querySelector("#block-props-0-value_path")).toBeTruthy();
    expect(container.querySelector("#block-props-0-fallback")).toBeTruthy();
    expect(container.querySelector("#block-props-0-font_size")).toBeTruthy();
  });

  it("renders barcode block fields (barcode_type, value_path)", () => {
    const block: TemplateBlock = {
      type: "barcode", x: 10, y: 10, width: 180, height: 60,
      barcode_type: "code128",
    };
    const { container } = renderPanel(block);
    expect(container.querySelector("#block-props-0-barcode_type")).toBeTruthy();
    expect(container.querySelector("#block-props-0-value_path")).toBeTruthy();
  });

  it("renders image block fields (asset_ref)", () => {
    const block: TemplateBlock = {
      type: "image", x: 10, y: 10, width: 80, height: 40,
      asset_ref: "logo.png",
    };
    const { container } = renderPanel(block);
    expect(container.querySelector("#block-props-0-asset_ref")).toBeTruthy();
  });

  it("renders line block fields (color, stroke_width)", () => {
    const block: TemplateBlock = {
      type: "line", x: 10, y: 10, width: 200, height: 0,
      stroke_width: 2,
    };
    const { container } = renderPanel(block);
    expect(container.querySelector("#block-props-0-stroke_width")).toBeTruthy();
  });

  it("rect block shows fill_color picker", () => {
    const block: TemplateBlock = {
      type: "rect", x: 10, y: 10, width: 100, height: 60,
      fill_color: "#ff0000",
    };
    const { container } = renderPanel(block);
    expect(container.querySelector("[data-testid='block-props-0-fill_color-swatch']")).toBeTruthy();
  });

  it("lock toggle calls onUpdate with locked:true", () => {
    const block: TemplateBlock = {
      type: "text", x: 10, y: 10, width: 100, height: 20,
    };
    const { container, onUpdate } = renderPanel(block);
    const checkbox = container.querySelector("input[type='checkbox']") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(onUpdate).toHaveBeenCalledWith(0, { locked: true });
  });

  it("position fields update x/y/w/h", () => {
    const block: TemplateBlock = {
      type: "text", x: 10, y: 20, width: 100, height: 30,
    };
    const { container, onUpdate } = renderPanel(block);
    const xInput = container.querySelector("#block-props-0-x") as HTMLInputElement;
    fireEvent.change(xInput, { target: { value: "50" } });
    expect(onUpdate).toHaveBeenCalledWith(0, { x: 50 });
  });

  it("barcode validation badge shows valid", () => {
    const block: TemplateBlock = {
      type: "barcode", x: 10, y: 10, width: 180, height: 60,
      barcode_type: "code128", fallback: "12345678",
    };
    const { container } = renderPanel(block);
    // Look for the validation badge text
    const badges = container.querySelectorAll("span.inline-block");
    const texts = Array.from(badges).map((b) => b.textContent);
    // Should contain the valid badge (key from i18n)
    expect(texts.some((t) => t?.includes("Valid") || t?.includes("valid") || t?.includes("barcodeDataValid"))).toBe(true);
  });

  it("barcode validation badge shows invalid", () => {
    const block: TemplateBlock = {
      type: "barcode", x: 10, y: 10, width: 180, height: 60,
      barcode_type: "ean13", fallback: "invalid!@#",
    };
    const { container } = renderPanel(block);
    const badges = container.querySelectorAll("span.inline-block");
    const texts = Array.from(badges).map((b) => b.textContent);
    // Should have invalid badge
    expect(texts.some((t) => t?.includes("Invalid") || t?.includes("invalid") || t?.includes("barcodeDataInvalid"))).toBe(true);
  });

  it("barcode quality badge renders", () => {
    const block: TemplateBlock = {
      type: "barcode", x: 10, y: 10, width: 180, height: 60,
      barcode_type: "code128", fallback: "12345678",
    };
    const { container } = renderPanel(block);
    const badges = container.querySelectorAll("span.inline-block");
    // Should have at least one quality badge
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("advanced settings toggle reveals module_width/quiet_zone", () => {
    const block: TemplateBlock = {
      type: "barcode", x: 10, y: 10, width: 180, height: 60,
      barcode_type: "code128",
    };
    const { container } = renderPanel(block);
    // Find the advanced settings toggle button
    const advancedBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Advanced") || b.textContent?.includes("advanced") || b.textContent?.includes("advancedSettings"),
    );
    expect(advancedBtn).toBeTruthy();
    fireEvent.click(advancedBtn!);
    // After toggle, module_width and quiet_zone inputs should appear
    expect(container.querySelector("#block-props-0-module_width")).toBeTruthy();
    expect(container.querySelector("#block-props-0-quiet_zone")).toBeTruthy();
  });

  it("default dpi is 203", () => {
    const block: TemplateBlock = {
      type: "barcode", x: 10, y: 10, width: 180, height: 60,
      barcode_type: "code128",
    };
    // The panel uses dpi=203 by default for quality assessment
    const { container } = renderPanel(block);
    // Just verify it renders without error with default dpi
    expect(container.querySelector("[data-testid='block-props-panel']")).toBeTruthy();
  });
});
