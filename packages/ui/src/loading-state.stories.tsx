import type { Meta, StoryObj } from "@storybook/react";
import { LoadingState } from "./loading-state";

const meta: Meta<typeof LoadingState> = {
  title: "UI/States/LoadingState",
  component: LoadingState
};

export default meta;
type Story = StoryObj<typeof LoadingState>;

export const Page: Story = {};

export const Section: Story = {
  args: {
    variant: "section",
    lines: 3
  }
};
