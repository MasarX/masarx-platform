import type { Meta, StoryObj } from "@storybook/react";
import { ResourceDetailModal } from "./resource-detail-modal";

const meta: Meta<typeof ResourceDetailModal> = {
  title: "Resource/ResourceDetailModal",
  component: ResourceDetailModal,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Center peek (modal) open mode for resource detail. " +
          "Wraps content in a responsive modal dialog.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ResourceDetailModal>;

export const Open: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    title: "Shipment SH-001",
    description: "Express delivery to Jeddah",
    children: (
      <div className="p-4 space-y-3 text-sm">
        <p><strong>Tracking:</strong> TRK-12345</p>
        <p><strong>Status:</strong> In Transit</p>
        <p><strong>Origin:</strong> Riyadh</p>
        <p><strong>Destination:</strong> Jeddah</p>
        <p><strong>Weight:</strong> 12.5 kg</p>
      </div>
    ),
  },
};

export const Minimal: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    children: (
      <div className="p-4 text-sm text-ui-muted">
        Detail content without title or description.
      </div>
    ),
  },
};
