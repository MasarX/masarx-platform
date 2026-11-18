import type { Meta, StoryObj } from "@storybook/react";
import { TrackingSearchForm } from "./tracking-search-form";

const meta: Meta<typeof TrackingSearchForm> = {
  title: "Domain/TrackingSearchForm",
  component: TrackingSearchForm,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Tracking search form with reference input and submit action. " +
          "Used on the portal tracking page for shipment lookups.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof TrackingSearchForm>;

export const Default: Story = {
  args: {
    actionHref: "/tracking",
    paramKey: "ref",
    placeholder: "Enter tracking number...",
    searchLabel: "Track",
    clearLabel: "Clear",
  },
};

export const WithDefaultValue: Story = {
  args: {
    actionHref: "/tracking",
    paramKey: "ref",
    defaultValue: "TRK-12345",
    label: "Tracking Reference",
    placeholder: "Enter tracking number...",
    searchLabel: "Search",
    clearLabel: "Reset",
  },
};

export const WithTestId: Story = {
  args: {
    actionHref: "/tracking",
    paramKey: "ref",
    testIdPrefix: "portal-tracking",
    placeholder: "Shipment reference or AWB...",
    searchLabel: "Find Shipment",
  },
};
