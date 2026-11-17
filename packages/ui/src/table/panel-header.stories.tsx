import type { Meta, StoryObj } from "@storybook/react";
import { TablePanelHeader } from "./panel-header";

const meta: Meta<typeof TablePanelHeader> = {
  title: "Table/PanelHeader",
  component: TablePanelHeader,
};

export default meta;
type Story = StoryObj<typeof TablePanelHeader>;

export const Default: Story = {
  args: {
    label: "Columns",
  },
};

export const WithCount: Story = {
  args: {
    label: "Filters",
    count: 3,
  },
};

export const WithHint: Story = {
  args: {
    label: "Sort",
    hint: "Click column headers to sort",
  },
};

export const WithActions: Story = {
  args: {
    label: "Export",
    actions: <button type="button">Reset</button>,
  },
};
