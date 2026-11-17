import type { Meta, StoryObj } from "@storybook/react";
import { Select } from "./select";

const meta: Meta<typeof Select> = {
  title: "Forms/Select",
  component: Select,
  args: {
    defaultValue: "standard"
  }
};

export default meta;
type Story = StoryObj<typeof Select>;

export const Default: Story = {
  render: (args) => (
    <Select {...args}>
      <option value="standard">Standard</option>
      <option value="priority">Priority</option>
      <option value="express">Express</option>
    </Select>
  )
};

export const Disabled: Story = {
  args: {
    disabled: true
  },
  render: (args) => (
    <Select {...args}>
      <option value="standard">Standard</option>
    </Select>
  )
};
