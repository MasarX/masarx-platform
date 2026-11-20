import type { Meta, StoryObj } from "@storybook/react";
import { ResourceDetail } from "./resource-detail";

const meta: Meta<typeof ResourceDetail> = {
  title: "Resource/ResourceDetail",
  component: ResourceDetail,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Renders a record detail view with grouped field sections, " +
          "media previews, copy-to-clipboard, and collapsible sections. " +
          "Columns drive layout; fields without a detailSection fall into General.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ResourceDetail>;

export const Default: Story = {
  args: {
    title: "Shipment SH-001",
    data: {
      id: "sh_001",
      tracking_number: "TRK-12345",
      status: "in_transit",
      origin: "Riyadh",
      destination: "Jeddah",
      weight_kg: 12.5,
      created_at: "2026-01-15T10:30:00Z",
    },
    columns: [
      { key: "tracking_number", label: "Tracking #" },
      { key: "status", label: "Status" },
      { key: "origin", label: "Origin" },
      { key: "destination", label: "Destination" },
      { key: "weight_kg", label: "Weight (kg)", renderType: "number" },
      { key: "created_at", label: "Created", renderType: "datetime" },
    ],
  },
};

export const WithSections: Story = {
  args: {
    title: "Order ORD-500",
    data: {
      id: "ord_500",
      reference: "REF-2026-500",
      customer_name: "Example Customer",
      amount: 2500,
      currency: "SAR",
      status: "completed",
      notes: "Express delivery requested",
      created_at: "2026-03-01T08:00:00Z",
      updated_at: "2026-03-02T14:00:00Z",
    },
    columns: [
      { key: "reference", label: "Reference" },
      { key: "customer_name", label: "Customer", detailSection: "customer" },
      { key: "amount", label: "Amount", detailSection: "financial" },
      { key: "currency", label: "Currency", detailSection: "financial" },
      { key: "status", label: "Status" },
      { key: "notes", label: "Notes", detailSection: "metadata" },
      { key: "created_at", label: "Created", detailSection: "metadata" },
      { key: "updated_at", label: "Updated", detailSection: "metadata" },
    ],
  },
};

export const Empty: Story = {
  args: {
    title: "No Record",
    data: null,
    emptyMessage: "Record not found or access denied.",
  },
};
