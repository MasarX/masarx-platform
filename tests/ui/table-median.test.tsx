import { render, screen } from "@testing-library/react";
import { computePageMetrics, getAggregationValue } from "../../packages/ui/src/table/metrics";
import { TableSummaryRow } from "../../packages/ui/src/table/summary-row";

const columns = [{ key: "id", label: "ID" }, { key: "amount", label: "Amount" }];

it.each([
  [[100, 1, 2], 2],
  [[100, 2, 1, 4], 3],
  [[-3, -10, -1], -3],
])("calculates the median of %j without changing the source order", (values, expected) => {
  const items = values.map((amount, index) => Object.freeze({ id: String(index), amount }));
  const originalItems = [...items];
  const metrics = computePageMetrics(items, columns);

  expect(getAggregationValue(metrics.columns.amount ?? null, "median")).toBe(expected);
  expect(items).toEqual(originalItems);
  expect(items.map((item) => item.amount)).toEqual(values);
});

it("excludes missing and nonfinite values from every numeric aggregation", () => {
  const values = [null, undefined, NaN, Infinity, -Infinity, "100", 100, 1, 2];
  const metrics = computePageMetrics(values.map((amount) => ({ amount })), columns);

  expect(metrics.columns.amount).toEqual({
    count: 3, sum: 103, min: 1, max: 100, avg: 103 / 3, median: 2,
  });
  expect(getAggregationValue(computePageMetrics([{ amount: null }], columns).columns.amount ?? null, "median"))
    .toBeNull();
});

it("shows the computed median in the table footer instead of the average", () => {
  const pageMetrics = computePageMetrics([{ amount: 100 }, { amount: 1 }, { amount: 2 }], columns);
  render(
    <table>
      <TableSummaryRow
        t={(key) => key}
        selectionEnabled={false}
        cellPadding=""
        displayColumns={columns}
        pinnedOffsets={{}}
        columnWidths={{}}
        pinnedCellClass=""
        numericColumnSet={new Set(["amount"])}
        pageMetrics={pageMetrics}
        columnAggregations={{ amount: "median" }}
      />
    </table>
  );

  expect(screen.getByRole("button", { name: "calculation.median 2" })).toBeVisible();
});
