import type { Meta, StoryObj } from "@storybook/react";
import { BulkActions, type BulkActionDefinition } from "./bulk-actions";

const meta: Meta<typeof BulkActions> = {
  title: "Resource/BulkActions",
  component: BulkActions,
  parameters: {
    docs: {
      description: {
        component:
          "Renders inline and overflow bulk action buttons for a resource table selection. " +
          "Supports navigate, rpc, workflow, print, and download execution types. " +
          "Depends on createUiClient, getUiDefaults, and toast infrastructure at runtime."
      }
    }
  }
};

export default meta;
type Story = StoryObj<typeof BulkActions>;

const sampleActions: BulkActionDefinition[] = [
  {
    key: "archive",
    label: "Archive",
    href: "/orders/archive",
    resourceKey: "orders"
  },
  {
    key: "export",
    label: "Export CSV",
    href: "/orders/export",
    resourceKey: "orders"
  }
];

export const Default: Story = {
  args: {
    actions: sampleActions,
    selectedIds: ["1", "2"]
  }
};
