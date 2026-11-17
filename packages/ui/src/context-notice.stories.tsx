import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { ContextNotice } from "./context-notice";

const meta: Meta<typeof ContextNotice> = {
  title: "Feedback/ContextNotice",
  component: ContextNotice,
  args: {
    title: "Order submitted",
    action: "Track delivery"
  }
};

export default meta;
type Story = StoryObj<typeof ContextNotice>;

export const Default: Story = {};

export const WithDetail: Story = {
  args: {
    detail: "Tracking number: ABC-123"
  }
};

export const WithLinks: Story = {
  args: {
    links: [
      { href: "#", label: "View order" },
      { href: "#", label: "Contact support" }
    ],
    linksTitle: "Related"
  }
};

export const WithDetailNode: Story = {
  args: {
    detailNode: <code>JSON payload</code>
  }
};
