import type { Meta, StoryObj } from "@storybook/react";
import { ResourceDetailActions } from "./resource-detail-actions";

const meta: Meta<typeof ResourceDetailActions> = {
  title: "Resource/ResourceDetailActions",
  component: ResourceDetailActions,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Action bar for a single record detail view. " +
          "Wraps ResourceBulkActions with the detail record ID as selection.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ResourceDetailActions>;

export const Default: Story = {
  args: {
    detailId: "sh_001",
    bulkActions: {
      resourceKey: "shipments",
      commands: [],
      appKey: "console",
      appBasePath: "/console",
      downloadBasePath: "/api/download",
      userCapabilities: ["shipments:read", "shipments:write"],
    },
  },
};

export const NoDetail: Story = {
  args: {
    detailId: null,
    bulkActions: null,
  },
};
