import type { Meta, StoryObj } from "@storybook/react";
import { DashboardMetricsPanel } from "./dashboard-metrics-panel";

const meta: Meta<typeof DashboardMetricsPanel> = {
  title: "Domain/DashboardMetricsPanel",
  component: DashboardMetricsPanel,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Dashboard KPI cards grid with optional donut chart. " +
          "Displays pre-computed metrics from the server component.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof DashboardMetricsPanel>;

export const Default: Story = {
  args: {
    kpis: [
      { title: "Total Shipments", value: 1284, change: 12.5, changeLabel: "vs last month", tone: "success" },
      { title: "Active Orders", value: 342, change: -3.2, changeLabel: "vs last week", tone: "warning" },
      { title: "Delivery Rate", value: "96.8%", tone: "success" },
      { title: "Exceptions", value: 18, change: 5, changeLabel: "this week", tone: "danger" },
    ],
    donutData: [
      { name: "Delivered", value: 842, color: "#22c55e" },
      { name: "In Transit", value: 285, color: "#3b82f6" },
      { name: "Processing", value: 120, color: "#f59e0b" },
      { name: "Failed", value: 37, color: "#ef4444" },
    ],
    donutTitle: "Shipment Status",
    donutCenterLabel: "Total",
    donutCenterValue: 1284,
  },
};

export const KpiOnly: Story = {
  args: {
    kpis: [
      { title: "Revenue", value: "SAR 125,000", tone: "success" },
      { title: "Orders", value: 450 },
      { title: "Avg Weight", value: "8.3 kg" },
      { title: "On-Time %", value: "94.2%", tone: "warning" },
    ],
    donutData: [],
  },
};

export const SingleKpi: Story = {
  args: {
    kpis: [
      { title: "Active Shipments", value: 42 },
    ],
    donutData: [],
  },
};
