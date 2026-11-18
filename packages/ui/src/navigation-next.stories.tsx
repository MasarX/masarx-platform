import type { Meta, StoryObj } from "@storybook/react";
import { NavigationNext } from "./navigation-next";

const meta: Meta<typeof NavigationNext> = {
  title: "Navigation/NavigationNext",
  component: NavigationNext,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Next.js sidebar navigation rendering sections from ui_navigation. " +
          "Supports favorites, collapse state, command palette integration, " +
          "badge counts, and capability gating.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 260, minHeight: 500, border: "1px solid #e5e7eb" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof NavigationNext>;

const sampleSections = [
  {
    id: "main",
    label: "Main",
    items: [
      { id: "dashboard", label: "Dashboard", href: "/dashboard" },
      { id: "shipments", label: "Shipments", href: "/shipments" },
      { id: "orders", label: "Orders", href: "/orders" },
      { id: "customers", label: "Customers", href: "/customers" },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { id: "workflows", label: "Workflows", href: "/workflows" },
      { id: "settings", label: "Settings", href: "/settings" },
    ],
  },
];

export const Default: Story = {
  args: {
    sections: sampleSections,
    appKey: "console",
    basePath: "/console",
  },
};

export const WithCapabilities: Story = {
  args: {
    sections: sampleSections,
    appKey: "console",
    basePath: "/console",
    capabilities: ["shipments:read", "orders:read", "workflows:read"],
  },
};

export const PortalApp: Story = {
  args: {
    sections: [
      {
        id: "portal",
        label: "Portal",
        items: [
          { id: "tracking", label: "Track Shipment", href: "/tracking" },
          { id: "orders", label: "My Orders", href: "/orders" },
          { id: "support", label: "Support", href: "/support" },
        ],
      },
    ],
    appKey: "portal",
    basePath: "/portal",
  },
};
