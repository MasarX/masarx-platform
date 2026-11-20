import type { Meta, StoryObj } from "@storybook/react";
import { DashboardMetricsSkeleton } from "./dashboard-metrics-skeleton";

const meta: Meta<typeof DashboardMetricsSkeleton> = {
  title: "Domain/DashboardMetricsSkeleton",
  component: DashboardMetricsSkeleton,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Skeleton placeholder matching the DashboardMetricsPanel layout " +
          "(KPI card grid + donut chart area). Shown during data loading.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof DashboardMetricsSkeleton>;

export const Default: Story = {};
