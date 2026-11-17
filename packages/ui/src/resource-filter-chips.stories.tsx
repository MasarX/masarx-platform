import type { Meta, StoryObj } from "@storybook/react";
import {
  ResourceFilterChips,
  type AppliedFilter
} from "./resource-filter-chips";

const meta: Meta<typeof ResourceFilterChips> = {
  title: "Resource/ResourceFilterChips",
  component: ResourceFilterChips
};

export default meta;
type Story = StoryObj<typeof ResourceFilterChips>;

const sampleFilters: AppliedFilter[] = [
  { key: "status", value: "active", op: "eq", source: "query" },
  { key: "region", value: "us-east-1", op: "eq", source: "query" }
];

export const Default: Story = {
  args: {
    filters: null,
    appliedFilters: sampleFilters,
    searchParams: { status: "active", region: "us-east-1" },
    actionHref: "/orders"
  }
};

export const WithRemove: Story = {
  args: {
    filters: null,
    appliedFilters: sampleFilters,
    searchParams: { status: "active", region: "us-east-1" },
    actionHref: "/orders",
    canRemove: true
  }
};

export const Empty: Story = {
  args: {
    filters: null,
    appliedFilters: [],
    searchParams: {},
    actionHref: "/orders"
  }
};
