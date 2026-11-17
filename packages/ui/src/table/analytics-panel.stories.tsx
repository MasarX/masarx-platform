import type { Meta, StoryObj } from "@storybook/react";
import { TableAnalyticsPanel } from "./analytics-panel";
import type { TranslateFn } from "./types";
import type { ResourceColumn } from "./columns";

const mockT: TranslateFn = (key, values) => {
  if (values) return `${key} ${JSON.stringify(values)}`;
  return key;
};

const mockColumns: ResourceColumn[] = [
  { key: "amount", label: "Amount", renderType: "number" },
  { key: "quantity", label: "Quantity", renderType: "number" },
];

const mockColumnsByKey = new Map<string, ResourceColumn>(
  mockColumns.map((c) => [c.key, c])
);

const meta: Meta<typeof TableAnalyticsPanel> = {
  title: "Table/AnalyticsPanel",
  component: TableAnalyticsPanel,
  args: {
    t: mockT,
    metricKeys: [],
    pageMetrics: { total: 0, columns: {} },
    selectedMetricKeys: [],
    columnsByKey: mockColumnsByKey,
    hasGrouping: false,
  },
};

export default meta;
type Story = StoryObj<typeof TableAnalyticsPanel>;

export const Default: Story = {};

export const WithMetrics: Story = {
  args: {
    metricKeys: ["amount", "quantity"],
    pageMetrics: {
      total: 100,
      columns: {
        amount: { count: 100, sum: 5000, min: 10, max: 200, avg: 50 },
        quantity: { count: 100, sum: 300, min: 1, max: 15, avg: 3 },
      },
    },
    datasetMetrics: {
      total: 500,
      columns: {
        amount: { count: 500, sum: 25000, min: 5, max: 500, avg: 50 },
        quantity: { count: 500, sum: 1500, min: 1, max: 20, avg: 3 },
      },
    },
    pageShareLabel: "20%",
  },
};
