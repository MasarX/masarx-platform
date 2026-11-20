import type { Meta, StoryObj } from "@storybook/react";
import { Skeleton } from "./skeleton";

const meta: Meta<typeof Skeleton> = {
  title: "Feedback/Skeleton",
  component: Skeleton
};

export default meta;
type Story = StoryObj<typeof Skeleton>;

export const Text: Story = {
  render: () => (
    <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading">
      <Skeleton aria-hidden className="h-4 w-1/2" />
      <Skeleton aria-hidden className="h-4 w-2/3" />
      <Skeleton aria-hidden className="h-4 w-1/3" />
    </div>
  )
};

export const Block: Story = {
  render: () => <Skeleton className="h-40 w-full" />
};
