/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { CanvasLayersPanel } from "../../packages/ui/src/label-designer/canvas/canvas-layers-panel";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

// The selected layer row reads in dark themes via the root data-theme attribute (#362).
const blocks: TemplateBlock[] = [
  { type: "text", x: 10, y: 10, width: 100, height: 20, name: "Title" },
  { type: "barcode", x: 10, y: 50, width: 180, height: 60 },
];

describe("CanvasLayersPanel selected row in dark theme", () => {
  it("adds data-theme dark variants to the selected row only", () => {
    render(
      <CanvasLayersPanel
        blocks={blocks}
        selectedIndices={[0]}
        onSelect={jest.fn()}
        onBlocksChange={jest.fn()}
      />,
    );
    const selected = screen.getByTestId("layer-0").className;
    expect(selected).toContain("bg-blue-50");
    expect(selected).toContain("text-blue-700");
    expect(selected).toContain("[[data-theme=dark]_&]:bg-ui-accent-soft");
    expect(selected).toContain("[[data-theme=dark]_&]:text-ui-ink");
    expect(screen.getByTestId("layer-1").className).not.toContain(
      "[[data-theme=dark]_&]",
    );
  });
});
