import type { Meta, StoryObj } from "@storybook/react";
import { ResourceDetailEditable } from "./resource-detail-editable";

const meta: Meta<typeof ResourceDetailEditable> = {
  title: "Resource/ResourceDetailEditable",
  component: ResourceDetailEditable,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Editable variant of ResourceDetail with inline field editing. " +
          "Shows edit icons next to editable fields and submits patches via onUpdate.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ResourceDetailEditable>;

export const Default: Story = {
  args: {
    title: "Shipment SH-001",
    resourceKey: "shipments",
    recordId: "sh_001",
    data: {
      id: "sh_001",
      tracking_number: "TRK-12345",
      status: "processing",
      origin: "Riyadh",
      destination: "Jeddah",
      weight_kg: 12.5,
      notes: "Handle with care",
    },
    columns: [
      { key: "tracking_number", label: "Tracking #" },
      { key: "status", label: "Status" },
      { key: "origin", label: "Origin" },
      { key: "destination", label: "Destination" },
      { key: "weight_kg", label: "Weight (kg)" },
      { key: "notes", label: "Notes" },
    ],
    onUpdate: async (patch) => {
      console.log("Update patch:", patch);
    },
  },
};

export const Empty: Story = {
  args: {
    title: "No Record",
    data: null,
    emptyMessage: "Record not found.",
    onUpdate: async () => {},
  },
};
