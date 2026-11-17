import type { Meta, StoryObj } from "@storybook/react";
import { FontSelector } from "./font-selector";

const meta: Meta<typeof FontSelector> = {
  title: "Label Designer/FontSelector",
  component: FontSelector,
  args: {
    value: "regular",
    id: "demo-font",
    label: "Font",
    onChange: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof FontSelector>;

export const Default: Story = {};

export const BoldSelected: Story = {
  args: { value: "bold" },
};

export const MonoSelected: Story = {
  args: { value: "mono" },
};

export const ArabicSelected: Story = {
  args: { value: "arabic" },
};
