import type { Meta, StoryObj } from "@storybook/react";
import { MobileCardView } from "./mobile-card-view";

const meta: Meta<typeof MobileCardView> = {
  title: "Domain/MobileCardView",
  component: MobileCardView,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Mobile-optimized card-based view for resource lists. " +
          "Replaces tables at narrow viewports. Cards show key fields " +
          "as pills with expand-on-tap for additional details.",
      },
    },
    viewport: { defaultViewport: "mobile1" },
  },
};

export default meta;
type Story = StoryObj<typeof MobileCardView>;

export const Default: Story = {
  args: {
    items: [
      {
        id: "sh_001",
        title: "SH-001 - Riyadh to Jeddah",
        subtitle: "Express Delivery",
        fields: [
          { key: "status", label: "Status", value: "In Transit", tone: "info", isBadge: true },
          { key: "weight", label: "Weight", value: "12.5 kg" },
          { key: "eta", label: "ETA", value: "Apr 14, 2026" },
          { key: "driver", label: "Driver", value: "Mohammed A." },
          { key: "vehicle", label: "Vehicle", value: "Truck #42" },
        ],
      },
      {
        id: "sh_002",
        title: "SH-002 - Dammam to Riyadh",
        subtitle: "Standard",
        fields: [
          { key: "status", label: "Status", value: "Delivered", tone: "success", isBadge: true },
          { key: "weight", label: "Weight", value: "5.2 kg" },
          { key: "delivered_at", label: "Delivered", value: "Apr 12, 2026" },
        ],
      },
      {
        id: "sh_003",
        title: "SH-003 - Jeddah to Makkah",
        subtitle: "Same Day",
        fields: [
          { key: "status", label: "Status", value: "Failed", tone: "danger", isBadge: true },
          { key: "reason", label: "Reason", value: "Address not found" },
          { key: "attempts", label: "Attempts", value: 2 },
        ],
      },
    ],
  },
};

export const SingleItem: Story = {
  args: {
    items: [
      {
        id: "ord_100",
        title: "Order #100",
        subtitle: "Example Client",
        fields: [
          { key: "total", label: "Total", value: "SAR 2,500" },
          { key: "status", label: "Status", value: "Processing", tone: "warning", isBadge: true },
        ],
      },
    ],
  },
};

export const Empty: Story = {
  args: {
    items: [],
    emptyMessage: "No shipments match your filters.",
  },
};
