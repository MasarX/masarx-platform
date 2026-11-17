import type { Meta, StoryObj } from "@storybook/react";
import { ResourceDetailSkeleton } from "./resource-detail-skeleton";

const meta: Meta<typeof ResourceDetailSkeleton> = {
  title: "UI/States/ResourceDetailSkeleton",
  component: ResourceDetailSkeleton
};

export default meta;
type Story = StoryObj<typeof ResourceDetailSkeleton>;

export const Default: Story = {};
