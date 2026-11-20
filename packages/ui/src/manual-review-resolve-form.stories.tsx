import type { Meta, StoryObj } from "@storybook/react";
import { ManualReviewResolveForm } from "./manual-review-resolve-form";

const meta: Meta<typeof ManualReviewResolveForm> = {
  title: "Domain/ManualReviewResolveForm",
  component: ManualReviewResolveForm,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Form for resolving manual review tasks with approve/reject decision " +
          "and optional notes. Uses server actions for submission.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ManualReviewResolveForm>;

export const Default: Story = {
  args: {
    action: async () => ({ status: "idle" as const }),
    taskId: "review_001",
    outcomeOptions: [
      { value: "approved", label: "Approved" },
      { value: "rejected", label: "Rejected" },
    ],
    testIdPrefix: "manual-review",
  },
};

export const Disabled: Story = {
  args: {
    action: async () => ({ status: "idle" as const }),
    taskId: "review_002",
    outcomeOptions: [
      { value: "approved", label: "Approved" },
      { value: "rejected", label: "Rejected" },
    ],
    disabled: true,
    disabledMessage: "This task has already been resolved.",
    testIdPrefix: "manual-review-disabled",
  },
};
