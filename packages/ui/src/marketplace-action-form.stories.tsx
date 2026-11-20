import type { Meta, StoryObj } from "@storybook/react";
import { MarketplaceActionForm } from "./marketplace-action-form";

const meta: Meta<typeof MarketplaceActionForm> = {
  title: "Domain/MarketplaceActionForm",
  component: MarketplaceActionForm,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Dynamic form for marketplace actions with configurable fields. " +
          "Supports text, textarea, select, hidden, and datetime-local field kinds.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof MarketplaceActionForm>;

export const Default: Story = {
  args: {
    action: async () => ({ status: "idle" as const }),
    submitLabel: "Submit Request",
    testIdPrefix: "marketplace-action",
    fields: [
      { name: "title", label: "Request Title", kind: "text", required: true, placeholder: "Enter title..." },
      { name: "priority", label: "Priority", kind: "select", options: [
        { label: "Low", value: "low" },
        { label: "Medium", value: "medium" },
        { label: "High", value: "high" },
      ], defaultValue: "medium" },
      { name: "description", label: "Description", kind: "textarea", rows: 4, placeholder: "Describe your request..." },
      { name: "deadline", label: "Deadline", kind: "datetime-local" },
    ],
  },
};

export const MinimalFields: Story = {
  args: {
    action: async () => ({ status: "idle" as const }),
    submitLabel: "Confirm",
    testIdPrefix: "marketplace-confirm",
    fields: [
      { name: "reference_id", kind: "hidden", defaultValue: "ref_123" },
      { name: "notes", label: "Notes", kind: "textarea", rows: 2 },
    ],
  },
};
