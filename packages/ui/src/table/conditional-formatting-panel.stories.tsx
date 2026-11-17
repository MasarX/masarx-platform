import type { Meta, StoryObj } from "@storybook/react";
import { ConditionalFormattingPanel } from "./conditional-formatting-panel";
import type { TranslateFn } from "./types";
import type { ResourceColumn } from "./columns";
import type { ConditionalFormattingRule } from "./view-types";

const noop = () => {};

const mockT: TranslateFn = (key, values) => {
  if (values) return `${key} ${JSON.stringify(values)}`;
  return key;
};

const sampleColumns: ResourceColumn[] = [
  { key: "name", label: "Name" },
  { key: "amount", label: "Amount" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
];

const meta: Meta<typeof ConditionalFormattingPanel> = {
  title: "Table/ConditionalFormattingPanel",
  component: ConditionalFormattingPanel,
  args: {
    t: mockT,
    columns: sampleColumns,
    onRulesChange: noop,
  },
};

export default meta;
type Story = StoryObj<typeof ConditionalFormattingPanel>;

export const Default: Story = {
  args: {
    rules: [],
  },
};

export const WithRules: Story = {
  args: {
    rules: [
      {
        id: "rule-1",
        field: "amount",
        operator: "gt",
        value: "1000",
        style: { bgColor: "#fef3c7", textColor: null, bold: null },
        scope: "cell",
      },
      {
        id: "rule-2",
        field: "status",
        operator: "eq",
        value: "active",
        style: { bgColor: "#dcfce7", textColor: null, bold: null },
        scope: "row",
      },
    ] satisfies ConditionalFormattingRule[],
  },
};
