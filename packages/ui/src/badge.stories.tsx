import type { Meta, StoryObj } from "@storybook/react";
import { Badge } from "./badge";

const meta: Meta<typeof Badge> = {
  title: "Feedback/Badge",
  component: Badge
};

export default meta;
type Story = StoryObj<typeof Badge>;

export const Neutral: Story = {
  args: {
    children: "Neutral"
  }
};

export const Accent: Story = {
  args: {
    tone: "accent",
    children: "Active"
  }
};
