import type { Meta, StoryObj } from "@storybook/react";
import { ResourceDownloadAction } from "./resource-download-action";

const meta: Meta<typeof ResourceDownloadAction> = {
  title: "Resource/ResourceDownloadAction",
  component: ResourceDownloadAction
};

export default meta;
type Story = StoryObj<typeof ResourceDownloadAction>;

export const Default: Story = {
  args: {
    resourceKey: "orders",
    downloadBasePath: "/api/download",
    selectedIds: ["1", "2"]
  }
};

export const Disabled: Story = {
  args: {
    resourceKey: "orders",
    downloadBasePath: "/api/download",
    selectedIds: ["1", "2"],
    disabled: true,
    disabledReason: "Select items first"
  }
};

export const NoSelection: Story = {
  args: {
    resourceKey: "orders",
    downloadBasePath: "/api/download",
    selectedIds: []
  }
};
