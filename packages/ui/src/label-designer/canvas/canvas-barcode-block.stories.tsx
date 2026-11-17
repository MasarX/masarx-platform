import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { CanvasBarcodeBlock } from "./canvas-barcode-block";

const SvgWrapper = (props: React.ComponentProps<typeof CanvasBarcodeBlock>) => (
  <svg width={400} height={200} style={{ border: "1px solid #e5e7eb" }}>
    <CanvasBarcodeBlock {...props} />
  </svg>
);

const meta: Meta<typeof CanvasBarcodeBlock> = {
  title: "Label Designer/CanvasBarcodeBlock",
  component: CanvasBarcodeBlock,
  render: (args) => <SvgWrapper {...args} />,
  args: {
    x: 10,
    y: 10,
    width: 300,
    height: 80,
    scale: 1,
  },
};

export default meta;
type Story = StoryObj<typeof CanvasBarcodeBlock>;

export const Code128: Story = {
  args: {
    block: {
      type: "barcode",
      x: 10,
      y: 10,
      width: 300,
      height: 80,
      barcode_type: "code128",
      fallback: "123456789012",
    },
  },
};

export const QR: Story = {
  args: {
    x: 10,
    y: 10,
    width: 120,
    height: 120,
    block: {
      type: "barcode",
      x: 10,
      y: 10,
      width: 120,
      height: 120,
      barcode_type: "qr",
      fallback: "https://example.com/track?id=abc123",
    },
  },
};

export const EAN13: Story = {
  args: {
    block: {
      type: "barcode",
      x: 10,
      y: 10,
      width: 300,
      height: 80,
      barcode_type: "ean13",
      fallback: "590123412345",
    },
  },
};

export const InvalidData: Story = {
  args: {
    block: {
      type: "barcode",
      x: 10,
      y: 10,
      width: 300,
      height: 80,
      barcode_type: "ean13",
      fallback: "INVALID",
    },
  },
};
