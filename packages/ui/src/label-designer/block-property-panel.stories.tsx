import type { Meta, StoryObj } from "@storybook/react";
import { BlockPropertyPanel } from "./block-property-panel";

const meta: Meta<typeof BlockPropertyPanel> = {
  title: "Label Designer/BlockPropertyPanel",
  component: BlockPropertyPanel,
  args: {
    blockIndex: 0,
    onUpdate: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof BlockPropertyPanel>;

export const TextBlock: Story = {
  args: {
    block: {
      type: "text",
      x: 20,
      y: 20,
      width: 200,
      height: 24,
      font_size: 14,
      value_path: "shipment.tracking_number",
      fallback: "TRK-000",
      color: "#000000",
      font: "regular",
    },
  },
};

export const BarcodeBlock: Story = {
  args: {
    block: {
      type: "barcode",
      x: 20,
      y: 60,
      width: 200,
      height: 60,
      barcode_type: "code128",
      value_path: "shipment.tracking_number",
      fallback: "123456789",
    },
  },
};

export const ImageBlock: Story = {
  args: {
    block: {
      type: "image",
      x: 200,
      y: 10,
      width: 60,
      height: 30,
      asset_ref: "company_logo.png",
    },
  },
};

export const LineBlock: Story = {
  args: {
    block: {
      type: "line",
      x: 10,
      y: 130,
      width: 268,
      height: 0,
      stroke_width: 1,
      color: "#000000",
    },
  },
};

export const RectBlock: Story = {
  args: {
    block: {
      type: "rect",
      x: 5,
      y: 5,
      width: 278,
      height: 420,
      stroke_width: 0.5,
      fill_color: "#f0f0f0",
    },
  },
};

export const LockedBlock: Story = {
  args: {
    block: {
      type: "text",
      x: 20,
      y: 20,
      width: 200,
      height: 24,
      font_size: 14,
      fallback: "Locked Block",
      locked: true,
    },
  },
};
