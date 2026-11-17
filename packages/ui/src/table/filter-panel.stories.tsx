import type { Meta, StoryObj } from "@storybook/react";
import { TableFilterPanel } from "./filter-panel";
import type { TranslateFn } from "./types";

const noop = () => {};

const mockT: TranslateFn = (key, values) => {
  if (values) return `${key} ${JSON.stringify(values)}`;
  return key;
};

const meta: Meta<typeof TableFilterPanel> = {
  title: "Table/FilterPanel",
  component: TableFilterPanel,
  args: {
    t: mockT,
    filters: [],
    searchParams: {},
    actionHref: "/api/resource",
    limit: 25,
    initialTree: null,
    activeFilterCount: 0,
    filtersLabel: "Filters",
    onResetView: noop,
    onFilterApply: noop,
    onFilterClear: noop,
  },
};

export default meta;
type Story = StoryObj<typeof TableFilterPanel>;

export const Default: Story = {};

export const WithActiveFilters: Story = {
  args: {
    activeFilterCount: 3,
    filters: [
      { key: "status", column: "status", label: "Status", ops: ["eq", "neq"] },
      { key: "name", column: "name", label: "Name", ops: ["contains", "eq"] },
    ],
    initialTree: {
      id: "root",
      type: "group",
      op: "and",
      rules: [
        { id: "r1", type: "rule", key: "status", op: "eq", value: "active" },
        { id: "r2", type: "rule", key: "name", op: "contains", value: "test" },
        { id: "r3", type: "rule", key: "status", op: "neq", value: "archived" },
      ],
    },
    panelLabel: "Active Filters",
  },
};
