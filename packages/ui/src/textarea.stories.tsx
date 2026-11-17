import type { Meta, StoryObj } from "@storybook/react";
import { Textarea } from "./textarea";

const meta: Meta<typeof Textarea> = {
  title: "Forms/Textarea",
  component: Textarea,
  args: {
    placeholder: "Add context..."
  }
};

export default meta;
type Story = StoryObj<typeof Textarea>;

export const Default: Story = {};

export const Filled: Story = {
  args: {
    defaultValue: "Operational notes for the workflow run."
  }
};

export const Disabled: Story = {
  args: {
    disabled: true
  }
};
