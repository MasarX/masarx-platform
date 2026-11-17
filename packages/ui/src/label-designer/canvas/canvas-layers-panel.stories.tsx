import type { Meta, StoryObj } from "@storybook/react";
import { CanvasLayersPanel } from "./canvas-layers-panel";

const meta: Meta<typeof CanvasLayersPanel> = {
  title: "Label Designer/CanvasLayersPanel",
  component: CanvasLayersPanel,
  args: {
    selectedIndices: [],
    onSelect: () => {},
    onBlocksChange: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof CanvasLayersPanel>;

export const Default: Story = {
  args: {
    blocks: [
      { type: "text", x: 20, y: 20, width: 200, height: 24, name: "Tracking #" },
      { type: "barcode", x: 20, y: 60, width: 200, height: 60, barcode_type: "code128", name: "Main Barcode" },
      { type: "image", x: 200, y: 10, width: 60, height: 30, asset_ref: "logo", name: "Logo" },
      { type: "line", x: 10, y: 130, width: 268, height: 0 },
      { type: "rect", x: 5, y: 5, width: 278, height: 420, name: "Border" },
    ],
    selectedIndices: [1],
  },
};

export const ManyBlocks: Story = {
  args: {
    blocks: Array.from({ length: 15 }, (_, i) => ({
      type: "text" as const,
      x: 10,
      y: 10 + i * 20,
      width: 100,
      height: 20,
      name: `Block ${i + 1}`,
    })),
  },
};

export const WithLockedBlock: Story = {
  args: {
    blocks: [
      { type: "text", x: 20, y: 20, width: 200, height: 24, name: "Editable" },
      { type: "rect", x: 5, y: 5, width: 278, height: 420, name: "Border", locked: true },
    ],
  },
};

export const WithHiddenBlock: Story = {
  args: {
    blocks: [
      { type: "text", x: 20, y: 20, width: 200, height: 24, name: "Visible" },
      { type: "rect", x: 5, y: 5, width: 278, height: 420, name: "Hidden BG", visible: false },
    ],
  },
};

export const Empty: Story = {
  args: {
    blocks: [],
  },
};
