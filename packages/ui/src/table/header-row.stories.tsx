import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { TableHeaderRow } from "./header-row";
import type { TranslateFn } from "./types";
import type { ResourceColumn } from "./columns";

const noop = () => {};

const mockT: TranslateFn = (key, values) => {
  if (values) return `${key} ${JSON.stringify(values)}`;
  return key;
};

const mockColumns: ResourceColumn[] = [
  { key: "name", label: "Name", renderType: "text" },
  { key: "status", label: "Status", renderType: "select" },
  { key: "amount", label: "Amount", renderType: "number" },
];

const meta: Meta<typeof TableHeaderRow> = {
  title: "Table/HeaderRow",
  component: TableHeaderRow,
  decorators: [
    (Story) => (
      <table>
        <Story />
      </table>
    ),
  ],
  args: {
    t: mockT,
    selectionEnabled: false,
    selectHeaderRef: { current: null },
    selectAllRef: { current: null },
    allSelected: false,
    onToggleAll: noop,
    displayColumns: mockColumns,
    sortState: [],
    onSort: noop,
    numericColumnSet: new Set(["amount"]),
    pinnedOffsets: {},
    columnWidths: {},
    pinnedHeaderClass: "sticky z-30 bg-ui-highlight/40",
    cellPadding: "px-3 py-2",
    registerHeaderRef: () => () => {},
    onResizeStart: noop,
    onResizeKey: noop,
    onUpdateWidth: noop,
  },
};

export default meta;
type Story = StoryObj<typeof TableHeaderRow>;

export const Default: Story = {};
