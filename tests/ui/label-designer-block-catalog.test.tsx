/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlockCatalogSidebar } from "../../packages/ui/src/label-designer/block-catalog-sidebar";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

// Mock the Button component to render as regular button
jest.mock("../../packages/ui/src/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => {
    const { children, size, variant, asChild, loading, ...rest } = props as Record<string, unknown>;
    return <button {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children as React.ReactNode}</button>;
  },
}));

const sampleFields = [
  { path: "shipment.tracking_number", label: "Tracking Number", label_ar: "\u0631\u0642\u0645 \u0627\u0644\u062a\u062a\u0628\u0639" },
  { path: "shipment.recipient_name", label: "Recipient Name" },
  { path: "shipment.weight_kg", label: "Weight (kg)", type: "number" },
  { path: "shipment.cod_amount", label: "COD Amount", type: "number" },
];

const sampleAssets = [
  { name: "logo.png", path: "org/logo.png" },
  { name: "barcode_frame.svg", path: "org/barcode_frame.svg" },
];

function renderCatalog(overrides: Partial<React.ComponentProps<typeof BlockCatalogSidebar>> = {}) {
  const onAddBlock = jest.fn();
  const result = render(
    <BlockCatalogSidebar
      fieldCatalog={sampleFields}
      assets={sampleAssets}
      onAddBlock={onAddBlock}
      {...overrides}
    />,
  );
  return { ...result, onAddBlock };
}

describe("BlockCatalogSidebar", () => {
  it("renders 7 block template buttons", () => {
    const { container } = renderCatalog();
    // Grid of block template buttons: Text, Barcode, QR Code, EAN-13, Image, Line, Rectangle
    const gridButtons = container.querySelectorAll(".grid button");
    expect(gridButtons.length).toBe(7);
  });

  it("calls onAddBlock when template clicked", () => {
    const { onAddBlock } = renderCatalog();
    fireEvent.click(screen.getByText("Text"));
    expect(onAddBlock).toHaveBeenCalledTimes(1);
    const block = onAddBlock.mock.calls[0][0] as TemplateBlock;
    expect(block.type).toBe("text");
  });

  it("search filters fields by path", () => {
    const { container } = renderCatalog();
    const searchInput = container.querySelector("[data-testid='block-catalog-search']")!;
    fireEvent.change(searchInput, { target: { value: "tracking" } });
    // Only "shipment.tracking_number" should match
    expect(screen.getByText("shipment.tracking_number")).toBeTruthy();
    expect(screen.queryByText("shipment.recipient_name")).toBeNull();
  });

  it("search is case-insensitive", () => {
    const { container } = renderCatalog();
    const searchInput = container.querySelector("[data-testid='block-catalog-search']")!;
    fireEvent.change(searchInput, { target: { value: "TRACKING" } });
    expect(screen.getByText("shipment.tracking_number")).toBeTruthy();
  });

  it("search filters by label", () => {
    const { container } = renderCatalog();
    const searchInput = container.querySelector("[data-testid='block-catalog-search']")!;
    fireEvent.change(searchInput, { target: { value: "Weight" } });
    expect(screen.getByText("shipment.weight_kg")).toBeTruthy();
    expect(screen.queryByText("shipment.tracking_number")).toBeNull();
  });

  it("search filters by label_ar", () => {
    const { container } = renderCatalog();
    const searchInput = container.querySelector("[data-testid='block-catalog-search']")!;
    fireEvent.change(searchInput, { target: { value: "\u0631\u0642\u0645" } });
    expect(screen.getByText("shipment.tracking_number")).toBeTruthy();
  });

  it("empty search shows all fields", () => {
    const { container } = renderCatalog();
    const searchInput = container.querySelector("[data-testid='block-catalog-search']")!;
    fireEvent.change(searchInput, { target: { value: "xyz" } });
    // Clear search
    fireEvent.change(searchInput, { target: { value: "" } });
    expect(screen.getByText("shipment.tracking_number")).toBeTruthy();
    expect(screen.getByText("shipment.recipient_name")).toBeTruthy();
  });

  it("no results shows empty message", () => {
    const { container } = renderCatalog();
    const searchInput = container.querySelector("[data-testid='block-catalog-search']")!;
    fireEvent.change(searchInput, { target: { value: "nonexistentfield" } });
    // Should show "no fields match" message (via i18n key)
    expect(screen.queryByText("shipment.tracking_number")).toBeNull();
  });

  it("drag start sets application/json data", () => {
    renderCatalog();
    const textBtn = screen.getByText("Text");
    const setData = jest.fn();
    fireEvent.dragStart(textBtn, {
      dataTransfer: { setData, effectAllowed: "" },
    });
    expect(setData).toHaveBeenCalledWith("application/json", expect.any(String));
    const parsed = JSON.parse(setData.mock.calls[0][1]) as TemplateBlock;
    expect(parsed.type).toBe("text");
  });

  it("asset list renders when assets provided", () => {
    renderCatalog();
    expect(screen.getByText("logo.png")).toBeTruthy();
    expect(screen.getByText("barcode_frame.svg")).toBeTruthy();
  });
});
