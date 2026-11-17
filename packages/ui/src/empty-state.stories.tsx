import type { Meta, StoryObj } from "@storybook/react";
import { EmptyState } from "./empty-state";
import { Button } from "./button";

const meta: Meta<typeof EmptyState> = {
  title: "UI/States/EmptyState",
  component: EmptyState,
  args: {
    title: "No shipments yet",
    description: "Create your first shipment to start tracking."
  }
};

export default meta;
type Story = StoryObj<typeof EmptyState>;

export const Default: Story = {};

export const WithAction: Story = {
  args: {
    action: <Button>Create shipment</Button>
  }
};

export const Inline: Story = {
  args: {
    variant: "inline",
    title: "No matches"
  }
};
