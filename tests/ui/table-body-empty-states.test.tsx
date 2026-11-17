import { render, screen, fireEvent } from "@testing-library/react";
import { TableBody } from "../../packages/ui/src/table/body";
import type { TranslateFn } from "../../packages/ui/src/table/types";
import type { DisplayRow } from "../../packages/ui/src/table/row-types";

const t: TranslateFn = (key) => key;

const baseProps = {
  t,
  rowDensity: "comfortable" as const,
  noColumnsSelected: false,
  isEmpty: false,
  emptyMessage: null,
  emptyAction: undefined,
  noColumnsAction: undefined,
  clientFilterActive: false,
  safeColumnCount: 3,
  paddingTop: 0,
  paddingBottom: 0,
  rowsToRender: [] as Array<{ index: number }>,
  displayRows: [] as DisplayRow[],
  renderRow: jest.fn(),
  onCreateRow: undefined,
  createRowLabel: "New row",
};

function renderBody(overrides: Partial<typeof baseProps> = {}) {
  return render(
    <table>
      <TableBody {...baseProps} {...overrides} />
    </table>
  );
}

test("no columns: shows NoColumnsIcon and title", () => {
  renderBody({ noColumnsSelected: true });
  expect(screen.getByText("table.noColumns")).toBeInTheDocument();
});

test("no columns: renders noColumnsAction", () => {
  renderBody({
    noColumnsSelected: true,
    noColumnsAction: <button>Add columns</button>,
  });
  expect(
    screen.getByRole("button", { name: "Add columns" })
  ).toBeInTheDocument();
});

test("no data: shows EmptyTableIcon and title", () => {
  renderBody({ isEmpty: true, clientFilterActive: false });
  expect(screen.getByText("table.noRecords")).toBeInTheDocument();
});

test("no data: uses custom emptyMessage", () => {
  renderBody({
    isEmpty: true,
    clientFilterActive: false,
    emptyMessage: "No shipments found",
  });
  expect(screen.getByText("No shipments found")).toBeInTheDocument();
});

test("no data: renders emptyAction", () => {
  renderBody({
    isEmpty: true,
    emptyAction: <button>Create record</button>,
  });
  expect(
    screen.getByRole("button", { name: "Create record" })
  ).toBeInTheDocument();
});

test("search empty: shows search-specific title", () => {
  renderBody({ isEmpty: true, clientFilterActive: true });
  expect(screen.getByText("table.noSearchResults")).toBeInTheDocument();
});

test("create row button renders when onCreateRow provided", () => {
  const onCreateRow = jest.fn();
  const row: DisplayRow = {
    type: "detail",
    id: "1",
    depth: 0,
    item: { id: "1", name: "Alpha" },
    groupPath: [],
    parentKey: "id",
  };
  renderBody({
    rowsToRender: [{ index: 0 }],
    displayRows: [row],
    renderRow: (r) => (
      <tr key={r.id}>
        <td>{(r as typeof row).item.name as string}</td>
      </tr>
    ),
    onCreateRow,
    createRowLabel: "New row",
  });
  expect(screen.getByText("New row")).toBeInTheDocument();
});

test("create row calls onCreateRow", () => {
  const onCreateRow = jest.fn();
  const row: DisplayRow = {
    type: "detail",
    id: "1",
    depth: 0,
    item: { id: "1" },
    groupPath: [],
    parentKey: "id",
  };
  renderBody({
    rowsToRender: [{ index: 0 }],
    displayRows: [row],
    renderRow: (r) => <tr key={r.id}><td>row</td></tr>,
    onCreateRow,
    createRowLabel: "New row",
  });

  fireEvent.click(screen.getByText("New row"));
  expect(onCreateRow).toHaveBeenCalledTimes(1);
});

test("create row hidden when no callback", () => {
  renderBody({
    rowsToRender: [],
    displayRows: [],
    onCreateRow: undefined,
    createRowLabel: "New row",
  });
  expect(screen.queryByText("New row")).toBeNull();
});

test("renders data rows with padding", () => {
  const row: DisplayRow = {
    type: "detail",
    id: "1",
    depth: 0,
    item: { id: "1", name: "Alpha" },
    groupPath: [],
    parentKey: "id",
  };
  const renderRow = jest.fn((r: DisplayRow) => (
    <tr key={r.id}>
      <td>{(r as typeof row).item.name as string}</td>
    </tr>
  ));
  renderBody({
    paddingTop: 100,
    paddingBottom: 50,
    rowsToRender: [{ index: 0 }],
    displayRows: [row],
    renderRow,
  });

  expect(renderRow).toHaveBeenCalledWith(row, 0);
  expect(screen.getByText("Alpha")).toBeInTheDocument();
});
