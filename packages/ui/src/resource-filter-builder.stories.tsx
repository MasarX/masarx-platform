import type { Meta, StoryObj } from "@storybook/react";
import { ResourceFilterBuilder } from "./resource-filter-builder";

const meta: Meta<typeof ResourceFilterBuilder> = {
  title: "Resource/ResourceFilterBuilder",
  component: ResourceFilterBuilder,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Advanced filter builder with add/remove rules, logical grouping (AND/OR), " +
          "operator selection, and combobox value inputs. Encodes filter tree into URL params.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ResourceFilterBuilder>;

const sampleFilters = [
  { key: "status", column: "status", label: "Status", ops: ["eq", "ne", "ilike"] },
  { key: "created_at", column: "created_at", label: "Created At", ops: ["gt", "gte", "lt", "lte"] },
  { key: "weight_kg", column: "weight_kg", label: "Weight (kg)", ops: ["eq", "gt", "lt"] },
  { key: "origin_city", column: "origin_city", label: "Origin City", ops: ["eq", "ne", "ilike"] },
];

export const Default: Story = {
  args: {
    resourceKey: "shipments",
    filters: sampleFilters,
    searchParams: {},
    actionHref: "/shipments",
    limit: 25,
    onApply: () => {},
    onClear: () => {},
  },
};

export const WithOperatorLabels: Story = {
  args: {
    resourceKey: "orders",
    filters: sampleFilters,
    searchParams: {},
    actionHref: "/orders",
    limit: 25,
    opLabels: {
      eq: "equals",
      ne: "not equal",
      gt: "greater than",
      gte: "at least",
      lt: "less than",
      lte: "at most",
      ilike: "contains",
    },
  },
};
