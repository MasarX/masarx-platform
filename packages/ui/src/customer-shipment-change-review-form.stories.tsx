import type { Meta, StoryObj } from "@storybook/react";
import { CustomerShipmentChangeReviewForm } from "./customer-shipment-change-review-form";

const meta: Meta<typeof CustomerShipmentChangeReviewForm> = {
  title: "Domain/CustomerShipmentChangeReviewForm",
  component: CustomerShipmentChangeReviewForm,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Review form for customer shipment change requests. " +
          "Supports approve/reject with notes and unsaved changes guard.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof CustomerShipmentChangeReviewForm>;

export const Default: Story = {
  args: {
    action: async () => ({ status: "idle" as const }),
    supportCaseId: "case_001",
    testIdPrefix: "shipment-change-review",
  },
};

export const Disabled: Story = {
  args: {
    action: async () => ({ status: "idle" as const }),
    supportCaseId: "case_002",
    disabled: true,
    disabledMessage: "This case has already been reviewed.",
    testIdPrefix: "shipment-change-review-disabled",
  },
};
