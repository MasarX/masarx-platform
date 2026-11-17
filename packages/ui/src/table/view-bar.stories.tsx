import type { Meta, StoryObj } from "@storybook/react";
import { TableViewBar } from "./view-bar";
import type { TablePanelKey } from "./view-bar";
import type { ResourceViewEntry } from "./view-types";
import type { TranslateFn } from "./types";

const noop = () => {};

const mockT: TranslateFn = (key, values) => {
  if (values) return `${key} ${JSON.stringify(values)}`;
  return key;
};

const sampleViews: ResourceViewEntry[] = [
  { id: "v1", label: "Default", },
  { id: "v2", label: "Compact" },
];

const baseArgs = {
  t: mockT,
  views: sampleViews,
  activeViewId: "v1",
  onViewChange: noop,
  viewTabsMax: 5,
  viewDirty: false,
  hasBaseHref: true,
  canManageViews: true,
  activePanel: null as TablePanelKey | null,
  onPanelToggle: noop,
  onResetView: noop,
  sortingLabel: "Name \u2191",
  groupingLabel: "None",
  filtersLabel: "Active",
  filtersCount: 0,
  sortCount: 0,
  groupCount: 0,
  visibleColumnsCount: 5,
  totalColumnsCount: 8,
};

const meta: Meta<typeof TableViewBar> = {
  title: "Table/ViewBar",
  component: TableViewBar,
  args: baseArgs,
};

export default meta;
type Story = StoryObj<typeof TableViewBar>;

export const Default: Story = {};

export const WithDirtyView: Story = {
  args: {
    viewDirty: true,
  },
};

export const WithActivePanel: Story = {
  args: {
    activePanel: "sort",
    sortCount: 1,
  },
};
