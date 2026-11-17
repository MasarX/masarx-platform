import type { Meta, StoryObj } from "@storybook/react";
import { TableStatusBar } from "./status-bar";
import type { TranslateFn } from "./types";

const noop = () => {};

const mockT: TranslateFn = (key, values) => {
  if (values) return `${key} ${JSON.stringify(values)}`;
  return key;
};

const meta: Meta<typeof TableStatusBar> = {
  title: "Table/StatusBar",
  component: TableStatusBar,
  args: {
    t: mockT,
    onToggleView: noop,
    onResetView: noop,
    sortingLabel: "Name \u2191",
    groupingLabel: "None",
    filtersLabel: "2 active",
  },
};

export default meta;
type Story = StoryObj<typeof TableStatusBar>;

export const Default: Story = {
  args: {
    viewOpen: false,
  },
};

export const ViewOpen: Story = {
  args: {
    viewOpen: true,
  },
};
