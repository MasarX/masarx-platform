/**
 * @jest-environment jsdom
 *
 * WCAG 2.5.7: every block, field and asset in the label designer catalog can be
 * added to the canvas from the keyboard, not only by dragging (#301).
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BlockCatalogSidebar } from "../../packages/ui/src/label-designer/block-catalog-sidebar";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

jest.mock("../../packages/ui/src/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => {
    const { children, size, variant, asChild, loading, ...rest } = props as Record<string, unknown>;
    return <button {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children as React.ReactNode}</button>;
  },
}));

function renderCatalog() {
  const onAddBlock = jest.fn();
  render(
    <BlockCatalogSidebar
      fieldCatalog={[{ path: "shipment.tracking_number", label: "Tracking Number" }]}
      assets={[{ name: "logo.png", path: "org/logo.png" }]}
      onAddBlock={onAddBlock}
    />,
  );
  return onAddBlock;
}

const addedTypes = (onAddBlock: jest.Mock) =>
  onAddBlock.mock.calls.map(([block]) => (block as TemplateBlock).type);

describe("BlockCatalogSidebar keyboard path", () => {
  test("Enter on a block template adds it", async () => {
    const user = userEvent.setup();
    const onAddBlock = renderCatalog();
    (screen.getByText("Barcode").closest("button") as HTMLButtonElement).focus();
    await user.keyboard("{Enter}");
    expect(addedTypes(onAddBlock)).toEqual(["barcode"]);
  });

  test("Space on a field adds a bound block, Enter on an asset adds an image", async () => {
    const user = userEvent.setup();
    const onAddBlock = renderCatalog();
    (screen.getByText("shipment.tracking_number").closest("button") as HTMLButtonElement).focus();
    await user.keyboard(" ");
    (screen.getByText("logo.png").closest("button") as HTMLButtonElement).focus();
    await user.keyboard("{Enter}");
    expect(onAddBlock).toHaveBeenCalledTimes(2);
    expect(onAddBlock.mock.calls[0][0]).toMatchObject({ type: "text", value_path: "shipment.tracking_number" });
    expect(onAddBlock.mock.calls[1][0]).toMatchObject({ type: "image", asset_ref: "logo.png" });
  });
});
