import type { Meta, StoryObj } from "@storybook/react";
import { CommandPalette } from "./command-palette";

const meta: Meta<typeof CommandPalette> = {
  title: "Navigation/CommandPalette",
  component: CommandPalette,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Modal command palette with fuzzy search across navigation items and commands. " +
          "Supports keyboard navigation, recent/favorite sections, and capability gating.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ minHeight: 500 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof CommandPalette>;

const sampleSections = [
  {
    id: "main",
    label: "Main",
    items: [
      { id: "dashboard", label: "Dashboard", href: "/dashboard" },
      { id: "shipments", label: "Shipments", href: "/shipments" },
      { id: "orders", label: "Orders", href: "/orders" },
      { id: "settings", label: "Settings", href: "/settings" },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { id: "workflows", label: "Workflows", href: "/workflows" },
      { id: "tracking", label: "Tracking", href: "/tracking" },
    ],
  },
];

export const Default: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    navigationSections: sampleSections,
    favorites: ["dashboard"],
    recents: ["shipments", "orders"],
    onRecordRecent: () => {},
    appBasePath: "/console",
    shortcut: "mod+k",
  },
};

export const WithRegistryResources: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    navigationSections: sampleSections,
    favorites: [],
    recents: [],
    onRecordRecent: () => {},
    appBasePath: "/console",
    registryResources: [
      { key: "invoices", label: "Invoices" },
      { key: "customers", label: "Customers" },
      { key: "warehouses", label: "Warehouses" },
    ],
  },
};

export const Empty: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    navigationSections: [],
    favorites: [],
    recents: [],
    onRecordRecent: () => {},
  },
};
