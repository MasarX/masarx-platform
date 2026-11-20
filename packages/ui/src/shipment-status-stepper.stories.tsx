import type { Meta, StoryObj } from "@storybook/react";
import { ShipmentStatusStepper } from "./shipment-status-stepper";

const meta: Meta<typeof ShipmentStatusStepper> = {
  title: "Domain/ShipmentStatusStepper",
  component: ShipmentStatusStepper,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Visual stepper showing the standard shipment lifecycle: " +
          "Pending > Processing > In Transit > Out for Delivery > Delivered. " +
          "Completed steps show green checks, current step pulses, " +
          "and failure statuses show warning indicators.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ShipmentStatusStepper>;

export const Pending: Story = {
  args: { status: "pending" },
};

export const Processing: Story = {
  args: { status: "processing" },
};

export const InTransit: Story = {
  args: { status: "in_transit" },
};

export const OutForDelivery: Story = {
  args: { status: "out_for_delivery" },
};

export const Delivered: Story = {
  args: { status: "delivered" },
};

export const DeliveryFailed: Story = {
  args: { status: "delivery_failed" },
};

export const Cancelled: Story = {
  args: { status: "cancelled" },
};

export const AliasPickedUp: Story = {
  name: "Alias: picked_up (maps to In Transit)",
  args: { status: "picked_up" },
};

export const AliasDispatched: Story = {
  name: "Alias: dispatched (maps to In Transit)",
  args: { status: "dispatched" },
};

export const NullStatus: Story = {
  name: "Null status (defaults to Pending)",
  args: { status: null },
};

export const WithTestId: Story = {
  args: {
    status: "in_transit",
    testIdPrefix: "shipment-detail",
  },
};
