import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { BlockCatalogSidebar } from "../../packages/ui/src/label-designer/block-catalog-sidebar";
import { BlockPropertyPanel } from "../../packages/ui/src/label-designer/block-property-panel";
import { CanvasLayersPanel } from "../../packages/ui/src/label-designer/canvas/canvas-layers-panel";
import { FontSelector } from "../../packages/ui/src/label-designer/font-selector";
import { ColorPickerInput } from "../../packages/ui/src/label-designer/color-picker-input";
import type { BlockType } from "../../packages/ui/src/label-designer/canvas/canvas-types";

test("readonly catalog blocks template, field and asset clicks AND drag payloads", () => {
  const onAddBlock = jest.fn(), setData = jest.fn();
  render(<BlockCatalogSidebar readOnly fieldCatalog={[{ path: "shipment.code", label: "Code" }]} assets={[{ name: "logo", path: "logo.png" }]} onAddBlock={onAddBlock} />);
  screen.getAllByRole("button").forEach((button) => {
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("draggable", "false");
    fireEvent.click(button);
    fireEvent.dragStart(button, { dataTransfer: { setData } });
  });
  expect(onAddBlock).not.toHaveBeenCalled();
  expect(setData).not.toHaveBeenCalled();
});

test.each<BlockType>(["text", "barcode", "image", "line", "rect"])("readonly %s property controls cannot mutate even on synthetic events", (type) => {
  const onUpdate = jest.fn();
  const { container } = render(<BlockPropertyPanel readOnly block={{ type, x: 10, y: 10, barcode_type: "QR" }} blockIndex={0} onUpdate={onUpdate} />);
  container.querySelectorAll("input,select,button").forEach((control) => {
    expect(control).toBeDisabled();
    if (control.tagName === "INPUT" || control.tagName === "SELECT") fireEvent.change(control, { target: { value: "77" } });
    else fireEvent.click(control);
  });
  expect(onUpdate).not.toHaveBeenCalled();
});

test("readonly layers still select but cannot toggle visibility or lock", () => {
  const onBlocksChange = jest.fn(), onSelect = jest.fn();
  render(<CanvasLayersPanel readOnly blocks={[{ type: "text", x: 0, y: 0 }]} selectedIndices={[]} onSelect={onSelect} onBlocksChange={onBlocksChange} />);
  fireEvent.click(screen.getByTestId("layer-0"));
  expect(onSelect).toHaveBeenCalledWith(0);
  for (const id of ["layer-0-visibility", "layer-0-lock"]) {
    expect(screen.getByTestId(id)).toBeDisabled();
    fireEvent.click(screen.getByTestId(id));
  }
  expect(onBlocksChange).not.toHaveBeenCalled();
});

test("font and color popovers cannot remain interactive after write permission is lost", () => {
  const onChange = jest.fn();
  const { rerender } = render(<><FontSelector value="regular" onChange={onChange} /><ColorPickerInput value="#000000" onChange={onChange} /></>);
  fireEvent.click(screen.getByTestId("font-selector"));
  fireEvent.click(screen.getByTestId("color-swatch"));
  rerender(<><FontSelector disabled value="regular" onChange={onChange} /><ColorPickerInput disabled value="#000000" onChange={onChange} /></>);
  expect(screen.queryByRole("button", { name: "Inter Bold" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByTestId("color-input"), { target: { value: "#ffffff" } });
  expect(onChange).not.toHaveBeenCalled();
});
