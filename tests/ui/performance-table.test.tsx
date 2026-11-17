import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { formatResourceSearchValue } from "../../packages/ui/src/resource-utils";
import {
  buildGroupTree,
  flattenGroupTree,
  type GroupLabels,
} from "../../packages/ui/src/table/grouping";
import { useTableRows } from "../../packages/ui/src/table/table-rows";
import { compareValues } from "../../packages/ui/src/table/resource-table-utils";

type HarnessProps = {
  count: number;
  height: number;
};

const groupLabels: GroupLabels = { empty: "Empty", all: "All" };

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index];
};

const samplePerf = (fn: () => void, iterations: number) => {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return samples;
};

function TableRowsHarness({ count, height }: HarnessProps) {
  const tableContainerRef = React.useMemo(() => {
    const element = document.createElement("div");
    Object.defineProperty(element, "clientHeight", {
      value: height,
      configurable: true,
    });
    Object.defineProperty(element, "scrollTop", {
      value: 0,
      writable: true,
      configurable: true,
    });
    element.getBoundingClientRect = () => ({
      width: 800,
      height,
      top: 0,
      left: 0,
      right: 800,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => "",
    });
    return { current: element } as React.RefObject<HTMLDivElement>;
  }, [height]);
  const items = React.useMemo(
    () =>
      Array.from({ length: count }, (_, index) => ({
        id: `row-${index}`,
        name: `Row ${index}`,
      })),
    [count]
  );

  const { displayRows, rowsToRender } = useTableRows({
    pagedItems: items,
    resolvedGroupBy: [],
    analyticsEnabled: false,
    activeColumns: [],
    groupLabels,
    idKey: "id",
    rowHeights: { base: 44, group: 36, detail: 180 },
    tableContainerRef,
    overscan: 8,
  });

  React.useEffect(() => {
    if (!tableContainerRef.current) return;
    document.body.appendChild(tableContainerRef.current);
    return () => {
      if (!tableContainerRef.current) return;
      document.body.removeChild(tableContainerRef.current);
    };
  }, [tableContainerRef]);

  return (
    <div>
      <output data-testid="display-count">{displayRows.length}</output>
      <output data-testid="render-count">{rowsToRender.length}</output>
    </div>
  );
}

test("virtualization limits rendered rows for large datasets", async () => {
  render(<TableRowsHarness count={10000} height={480} />);

  const displayCount = screen.getByTestId("display-count");
  const renderCount = screen.getByTestId("render-count");

  await waitFor(() => {
    expect(Number(displayCount.textContent)).toBe(10000);
    expect(Number(renderCount.textContent)).toBeGreaterThan(0);
    expect(Number(renderCount.textContent)).toBeLessThan(500);
  });
});

test("p95 for filter/sort/group on 10k rows is reported", () => {
  const count = 10000;
  const iterations = 25;
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    status:
      index % 5 === 0
        ? "exception"
        : index % 2 === 0
          ? "in_transit"
          : "delivered",
    customer: `Customer ${index % 200}`,
    amount: index * 3.17,
  }));
  const columns = [
    { key: "status", renderType: null },
    { key: "customer", renderType: null },
    { key: "amount", renderType: "number" },
  ];
  const searchTerm = "customer 42";
  const runFilter = () => {
    const normalized = searchTerm.toLowerCase();
    rows.filter((row) =>
      columns.some((column) => {
        const value = formatResourceSearchValue(row[column.key], {
          renderType: column.renderType,
          formatOptions: null,
        });
        return value.toLowerCase().includes(normalized);
      })
    );
  };
  const runSort = () => {
    const next = [...rows];
    next.sort((a, b) => compareValues(a.amount, b.amount, "asc"));
  };
  const runGroup = () => {
    const tree = buildGroupTree(rows, ["status"], groupLabels);
    flattenGroupTree(tree, 0);
  };

  const filterSamples = samplePerf(runFilter, iterations);
  const sortSamples = samplePerf(runSort, iterations);
  const groupSamples = samplePerf(runGroup, iterations);
  const p95Filter = percentile(filterSamples, 0.95);
  const p95Sort = percentile(sortSamples, 0.95);
  const p95Group = percentile(groupSamples, 0.95);

  console.info(
    `[ui-perf] rows=${count} filter_p95_ms=${p95Filter?.toFixed(2) ?? "n/a"} sort_p95_ms=${p95Sort?.toFixed(2) ?? "n/a"} group_p95_ms=${p95Group?.toFixed(2) ?? "n/a"}`
  );

  expect(p95Filter).not.toBeNull();
  expect(p95Sort).not.toBeNull();
  expect(p95Group).not.toBeNull();
});
