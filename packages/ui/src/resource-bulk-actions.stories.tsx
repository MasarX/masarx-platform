import type { Meta, StoryObj } from "@storybook/react";
import { ResourceBulkActions } from "./resource-bulk-actions";

const meta: Meta<typeof ResourceBulkActions> = {
  title: "Resource/ResourceBulkActions",
  component: ResourceBulkActions,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Resolves bulk actions from resource definition and command registry, " +
          "then renders them via BulkActions. Supports navigate, rpc, workflow, " +
          "print, and download execution types.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ResourceBulkActions>;

export const Default: Story = {
  args: {
    resourceKey: "shipments",
    commands: [],
    selectedIds: ["sh_001", "sh_002", "sh_003"],
    appKey: "console",
    appBasePath: "/console",
    downloadBasePath: "/api/download",
    userCapabilities: ["shipments:read", "shipments:write"],
  },
};

export const WithCommands: Story = {
  args: {
    resourceKey: "orders",
    commands: [
      {
        key: "bulk_export",
        label: "Export Selected",
        execution_type: "download",
        resource_key: "orders",
        category: "bulk",
        capability_required: "orders:read",
      },
    ] as any,
    selectedIds: ["ord_001", "ord_002"],
    appKey: "console",
    appBasePath: "/console",
    downloadBasePath: "/api/download",
    userCapabilities: ["orders:read", "orders:write"],
  },
};

export const EmptySelection: Story = {
  args: {
    resourceKey: "shipments",
    commands: [],
    selectedIds: [],
    appKey: "console",
    appBasePath: "/console",
    downloadBasePath: "/api/download",
    userCapabilities: ["shipments:read"],
  },
};
