import type { Meta, StoryObj } from "@storybook/react";
import { ErrorState } from "./error-state";

const meta: Meta<typeof ErrorState> = {
  title: "Layout/ErrorState",
  component: ErrorState
};

export default meta;
type Story = StoryObj<typeof ErrorState>;

export const Default: Story = {
  args: {
    title: "Unable to load data",
    description: "Retry after checking your network connection."
  }
};
