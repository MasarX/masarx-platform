import type { Meta, StoryObj } from "@storybook/react";
import { PageHeader } from "./page-header";

const meta: Meta<typeof PageHeader> = {
  title: "Layout/PageHeader",
  component: PageHeader
};

export default meta;
type Story = StoryObj<typeof PageHeader>;

export const Default: Story = {
  args: {
    title: "Shipments",
    description: "Monitor shipment status and SLA compliance."
  }
};
