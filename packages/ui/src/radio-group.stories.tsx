import type { Meta, StoryObj } from "@storybook/react";
import { RadioGroup, RadioGroupItem } from "./radio-group";

const meta: Meta<typeof RadioGroup> = {
  title: "Forms/RadioGroup",
  component: RadioGroup
};

export default meta;
type Story = StoryObj<typeof RadioGroup>;

export const Default: Story = {
  render: (args) => (
    <RadioGroup {...args}>
      <label className="flex items-center gap-2 text-sm text-ui-ink">
        <RadioGroupItem name="priority" value="standard" defaultChecked />
        Standard
      </label>
      <label className="flex items-center gap-2 text-sm text-ui-ink">
        <RadioGroupItem name="priority" value="priority" />
        Priority
      </label>
    </RadioGroup>
  )
};

export const Disabled: Story = {
  render: (args) => (
    <RadioGroup {...args}>
      <label className="flex items-center gap-2 text-sm text-ui-muted">
        <RadioGroupItem name="priority-disabled" value="standard" disabled />
        Standard
      </label>
      <label className="flex items-center gap-2 text-sm text-ui-muted">
        <RadioGroupItem name="priority-disabled" value="priority" disabled />
        Priority
      </label>
    </RadioGroup>
  )
};
