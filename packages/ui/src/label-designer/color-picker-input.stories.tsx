import type { Meta, StoryObj } from "@storybook/react";
import { ColorPickerInput } from "./color-picker-input";

const meta: Meta<typeof ColorPickerInput> = {
  title: "Label Designer/ColorPickerInput",
  component: ColorPickerInput,
  args: {
    value: "#2563eb",
    id: "demo-color",
    onChange: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ColorPickerInput>;

export const Default: Story = {};

export const WithLabel: Story = {
  args: { label: "Fill Color" },
};

export const NoHashPrefix: Story = {
  args: { value: "ff6600" },
};

export const EmptyValue: Story = {
  args: { value: undefined },
};
