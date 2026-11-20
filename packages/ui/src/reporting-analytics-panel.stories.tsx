import type { Meta, StoryObj } from "@storybook/react";
import { ReportingAnalyticsPanel } from "./reporting-analytics-panel";

const meta: Meta<typeof ReportingAnalyticsPanel> = {
  title: "Domain/ReportingAnalyticsPanel",
  component: ReportingAnalyticsPanel,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Reporting analytics panel with KPI cards, donut chart, trend chart, " +
          "date-range selector, and CSV export button.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ReportingAnalyticsPanel>;

const dateRangeOptions = [
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
];

const trendData = [
  { day: "2026-04-01", count: 45 },
  { day: "2026-04-02", count: 52 },
  { day: "2026-04-03", count: 38 },
  { day: "2026-04-04", count: 61 },
  { day: "2026-04-05", count: 55 },
  { day: "2026-04-06", count: 48 },
  { day: "2026-04-07", count: 67 },
];

export const Default: Story = {
  args: {
    kpis: [
      { title: "Total Orders", value: 1250, change: 8.3, changeLabel: "vs prior period", tone: "success" },
      { title: "Revenue", value: "SAR 450K", change: 12.1, tone: "success" },
      { title: "Avg Delivery Time", value: "2.3 days", tone: "neutral" },
      { title: "Return Rate", value: "4.2%", change: -1.5, tone: "warning" },
    ],
    donutData: [
      { name: "Delivered", value: 920, color: "#22c55e" },
      { name: "In Transit", value: 180, color: "#3b82f6" },
      { name: "Processing", value: 100, color: "#f59e0b" },
      { name: "Failed", value: 50, color: "#ef4444" },
    ],
    donutTotal: 1250,
    trendData,
    dateRangeOptions,
    activeDateRange: "7d",
    onDateRangeChange: () => {},
    onExportCsv: () => {},
    labels: {
      dateRangeLabel: "Date Range",
      kpiTitle: "Key Metrics",
      statusTitle: "Status Distribution",
      statusCenter: "Total",
      trendTitle: "Daily Trend",
      exportCsv: "Export CSV",
      emptyTitle: "No data available",
      emptyDescription: "Adjust the date range or filters.",
    },
  },
};

export const EmptyData: Story = {
  args: {
    kpis: [],
    donutData: [],
    donutTotal: 0,
    trendData: [],
    dateRangeOptions,
    activeDateRange: "30d",
    labels: {
      dateRangeLabel: "Date Range",
      kpiTitle: "Key Metrics",
      statusTitle: "Status Distribution",
      statusCenter: "Total",
      trendTitle: "Daily Trend",
      exportCsv: "Export CSV",
      emptyTitle: "No data available",
      emptyDescription: "No records found for the selected period.",
    },
  },
};
