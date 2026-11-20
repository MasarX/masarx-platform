import type { Meta, StoryObj } from "@storybook/react";
import { ResourceImportLauncher } from "./resource-import-launcher";

const meta: Meta<typeof ResourceImportLauncher> = {
  title: "Resource/ResourceImportLauncher",
  component: ResourceImportLauncher,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Import button that opens a drawer with the import page. " +
          "Falls back to a standalone link when drawer is not supported. " +
          "Capability-gated: shows disabled state with reason when not allowed.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ResourceImportLauncher>;

export const Allowed: Story = {
  args: {
    appBasePath: "/console",
    resourceKey: "shipments",
    allowed: true,
  },
};

export const Disabled: Story = {
  args: {
    appBasePath: "/console",
    resourceKey: "shipments",
    allowed: false,
    disabledReason: "Import requires shipments:import capability.",
  },
};

export const WithReturnTo: Story = {
  args: {
    appBasePath: "/console",
    resourceKey: "orders",
    allowed: true,
    returnTo: "/console/orders",
    testIdPrefix: "orders-import",
  },
};
