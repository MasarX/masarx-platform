import type { Meta, StoryObj } from "@storybook/react";
import { TableSortPanel } from "./sort-panel";
import type { TranslateFn } from "./types";
import type { ResourceColumn } from "./columns";

const noop = () => {};

const mockT: TranslateFn = (key, values) => {
  if (values) return `${key} ${JSON.stringify(values)}`;
  return key;
};

const sampleColumns: Map<string, ResourceColumn> = new Map([
  ["name", { key: "name", label: "Name" }],
  ["email", { key: "email", label: "Email" }],
  ["created_at", { key: "created_at", label: "Created At" }],
  ["status", { key: "status", label: "Status" }],
]);

const meta: Meta<typeof TableSortPanel> = {
  title: "Table/SortPanel",
  component: TableSortPanel,
  args: {
    t: mockT,
    columnsByKey: sampleColumns,
    onAddSort: noop,
    onRemoveSort: noop,
    onToggleDirection: noop,
    onMoveSort: noop,
    onClearSorts: noop,
  },
};

export default meta;
type Story = StoryObj<typeof TableSortPanel>;

export const Default: Story = {
  args: {
    sortState: [],
  },
};

export const WithSorts: Story = {
  args: {
    sortState: [
      { key: "name", direction: "asc" },
      { key: "created_at", direction: "desc" },
    ],
  },
};

export const ReadOnly: Story = {
  args: {
    sortState: [{ key: "email", direction: "asc" }],
    onAddSort: noop,
    onRemoveSort: noop,
    onToggleDirection: noop,
    onMoveSort: noop,
    onClearSorts: noop,
  },
};
