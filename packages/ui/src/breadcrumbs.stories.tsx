import type { Meta, StoryObj } from "@storybook/react";
import { Breadcrumbs } from "./breadcrumbs";

const meta: Meta<typeof Breadcrumbs> = {
  title: "Navigation/Breadcrumbs",
  component: Breadcrumbs,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Breadcrumb trail built from navigation sections and current pathname. " +
          "Resolves matching nav items to build hierarchical segments.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Breadcrumbs>;

const sampleSections = [
  {
    id: "main",
    label: "Main",
    items: [
      { id: "dashboard", label: "Dashboard", href: "/dashboard" },
      {
        id: "shipments",
        label: "Shipments",
        href: "/shipments",
        items: [
          { id: "active", label: "Active", href: "/shipments/active" },
          { id: "completed", label: "Completed", href: "/shipments/completed" },
        ],
      },
      { id: "orders", label: "Orders", href: "/orders" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      { id: "general", label: "General", href: "/settings" },
      { id: "access", label: "Access", href: "/settings/access" },
    ],
  },
];

export const TopLevel: Story = {
  args: {
    appBasePath: "/console",
    navigationSections: sampleSections,
  },
};

export const NestedPath: Story = {
  args: {
    appBasePath: "/console",
    navigationSections: sampleSections,
  },
};

export const WithTestId: Story = {
  args: {
    appBasePath: "/console",
    navigationSections: sampleSections,
    testIdPrefix: "console",
  },
};
