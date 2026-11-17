import { render, screen } from "@testing-library/react";
import { TableAnalyticsPanel } from "../../packages/ui/src/table/analytics-panel";
import type { TranslateFn } from "../../packages/ui/src/table/types";
import type { ResourceColumn } from "../../packages/ui/src/table/columns";
import type { ResourceMetrics } from "../../packages/ui/src/table/metrics";

const t: TranslateFn = (key) => key;

const columns: ResourceColumn[] = [
  { key: "price", label: "Price" },
  { key: "quantity", label: "Quantity" },
];

const columnsByKey = new Map<string, ResourceColumn>(
  columns.map((c) => [c.key, c])
);

const pageMetrics: ResourceMetrics = {
  total: 42,
  columns: {
    price: { count: 40, sum: 1000, avg: 25, min: 5, max: 100 },
    quantity: { count: 42, sum: 500, avg: 11.9, min: 1, max: 50 },
  },
};

const defaultProps = {
  t,
  metricKeys: ["price", "quantity"],
  pageMetrics,
  datasetMetrics: null,
  selectedMetrics: null,
  selectedMetricKeys: [] as string[],
  columnsByKey,
  pageShareLabel: null,
  selectedShareLabel: null,
  hasGrouping: false,
};

test("renders metric keys as rows", () => {
  render(<TableAnalyticsPanel {...defaultProps} />);
  expect(screen.getByText("Price")).toBeInTheDocument();
  expect(screen.getByText("Quantity")).toBeInTheDocument();
});

test("shows page metrics values", () => {
  render(<TableAnalyticsPanel {...defaultProps} />);
  // count values
  expect(screen.getByText("40")).toBeInTheDocument();
  expect(screen.getByText("42")).toBeInTheDocument();
  // sum values (formatted with Intl: 1,000 and 500)
  expect(screen.getByText("1,000")).toBeInTheDocument();
  expect(screen.getByText("500")).toBeInTheDocument();
  // avg values
  expect(screen.getByText("25")).toBeInTheDocument();
  expect(screen.getByText("11.9")).toBeInTheDocument();
});

test("renders without crashing when no dataset metrics", () => {
  render(
    <TableAnalyticsPanel {...defaultProps} datasetMetrics={null} />
  );
  // Should still render the analytics title
  expect(screen.getByText("analytics.title")).toBeInTheDocument();
  // Dataset-specific column headers should NOT appear
  expect(
    screen.queryByText("analytics.columns.datasetCount")
  ).not.toBeInTheDocument();
});

test("renders total count", () => {
  render(<TableAnalyticsPanel {...defaultProps} />);
  // The total is rendered through the translation key with count param
  // Our t mock returns the key, so we look for the key text
  expect(screen.getByText("analytics.pageRows")).toBeInTheDocument();
});
