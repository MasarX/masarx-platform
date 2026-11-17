import type { Meta, StoryObj } from "@storybook/react";
import { TableExportPanel } from "./export-panel";
import type { TranslateFn } from "./types";

const noop = () => {};

const mockT: TranslateFn = (key, values) => {
  if (values) return `${key} ${JSON.stringify(values)}`;
  return key;
};

const meta: Meta<typeof TableExportPanel> = {
  title: "Table/ExportPanel",
  component: TableExportPanel,
  args: {
    t: mockT,
    analyticsEnabled: true,
    onExportMetrics: noop,
    metricsExportDisabled: false,
    onExportCsv: noop,
    exportDisabled: false,
    onExportExcel: noop,
    excelExportDisabled: false,
  },
};

export default meta;
type Story = StoryObj<typeof TableExportPanel>;

export const Default: Story = {};
