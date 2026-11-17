import type { Meta, StoryObj } from "@storybook/react";
import { TableGroupingPanel } from "./grouping-panel";
import type { TranslateFn } from "./types";
import type { ResourceColumn } from "./columns";

const noop = () => {};

const mockT: TranslateFn = (key, values) => {
  if (values) return `${key} ${JSON.stringify(values)}`;
  return key;
};

const sampleColumnsByKey: Map<string, ResourceColumn> = new Map([
  ["status", { key: "status", label: "Status" }],
  ["category", { key: "category", label: "Category" }],
  ["priority", { key: "priority", label: "Priority" }],
  ["assignee", { key: "assignee", label: "Assignee" }],
]);

const meta: Meta<typeof TableGroupingPanel> = {
  title: "Table/GroupingPanel",
  component: TableGroupingPanel,
  args: {
    t: mockT,
    columnsByKey: sampleColumnsByKey,
    onAddGroupKey: noop,
    onMoveGroupKey: noop,
    onRemoveGroupKey: noop,
    onClearGroupBy: noop,
    onCollapseAll: noop,
    onExpandAll: noop,
  },
};

export default meta;
type Story = StoryObj<typeof TableGroupingPanel>;

export const Default: Story = {
  args: {
    availableGroupKeys: ["status", "category", "priority", "assignee"],
    resolvedGroupBy: [],
    groupIds: [],
    collapsedGroups: new Set<string>(),
  },
};

export const WithGroups: Story = {
  args: {
    availableGroupKeys: ["priority", "assignee"],
    resolvedGroupBy: ["status", "category"],
    groupIds: ["group-1", "group-2", "group-3"],
    collapsedGroups: new Set(["group-1"]),
  },
};
