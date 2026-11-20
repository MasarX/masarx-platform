import type { Meta, StoryObj } from "@storybook/react";
import { ResourceDetailPanel } from "./resource-detail-panel";

const meta: Meta<typeof ResourceDetailPanel> = {
  title: "Resource/ResourceDetailPanel",
  component: ResourceDetailPanel,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Split panel (desktop) or drawer (mobile) for displaying record details " +
          "alongside a resource table. Uses media queries to switch layout modes.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ minHeight: 400, position: "relative" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ResourceDetailPanel>;

export const Open: Story = {
  args: {
    open: true,
    title: "Shipment SH-001",
    children: (
      <div className="p-4 space-y-3 text-sm">
        <p><strong>Tracking:</strong> TRK-12345</p>
        <p><strong>Status:</strong> In Transit</p>
        <p><strong>Origin:</strong> Riyadh</p>
        <p><strong>Destination:</strong> Jeddah</p>
      </div>
    ),
  },
};

export const Closed: Story = {
  args: {
    open: false,
    title: "Shipment SH-002",
    children: <div className="p-4">Detail content</div>,
  },
};
