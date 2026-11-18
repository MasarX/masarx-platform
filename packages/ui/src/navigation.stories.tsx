import type { Meta, StoryObj } from "@storybook/react";
import { Navigation } from "./navigation";

const meta: Meta<typeof Navigation> = {
  title: "Navigation/Navigation",
  component: Navigation,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Core navigation component rendering sections with collapsible groups, " +
          "favorites, badge counts, and active path highlighting.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 260, minHeight: 400, border: "1px solid #e5e7eb" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof Navigation>;

const sampleSections = [
  {
    id: "main",
    label: "Main",
    items: [
      { id: "dashboard", label: "Dashboard", href: "/dashboard" },
      { id: "shipments", label: "Shipments", href: "/shipments", badge: "12" },
      { id: "orders", label: "Orders", href: "/orders", badge: "3" },
      { id: "customers", label: "Customers", href: "/customers" },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { id: "workflows", label: "Workflows", href: "/workflows" },
      { id: "imports", label: "Imports", href: "/imports" },
      { id: "settings", label: "Settings", href: "/settings" },
    ],
  },
];

export const Default: Story = {
  args: {
    sections: sampleSections,
    activeHref: "/shipments",
    basePath: "/console",
  },
};

export const WithFavorites: Story = {
  args: {
    sections: sampleSections,
    activeHref: "/dashboard",
    basePath: "/console",
    favorites: ["dashboard", "shipments"],
    onToggleFavorite: () => {},
  },
};

export const CollapsedSection: Story = {
  args: {
    sections: sampleSections,
    activeHref: "/dashboard",
    basePath: "/console",
    collapsedSections: ["operations"],
    onToggleSection: () => {},
  },
};

export const NestedItems: Story = {
  args: {
    sections: [
      {
        id: "nested",
        label: "Nested Example",
        items: [
          {
            id: "parent",
            label: "Parent Item",
            href: "/parent",
            items: [
              { id: "child1", label: "Child 1", href: "/parent/child1" },
              { id: "child2", label: "Child 2", href: "/parent/child2" },
            ],
          },
          { id: "sibling", label: "Sibling", href: "/sibling" },
        ],
      },
    ],
    activeHref: "/parent/child1",
    basePath: "/console",
  },
};
