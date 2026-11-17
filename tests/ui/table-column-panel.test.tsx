import { render, screen, fireEvent } from "@testing-library/react";
import { TableColumnPanel } from "../../packages/ui/src/table/column-panel";
import type { TranslateFn } from "../../packages/ui/src/table/types";
import type { ResourceColumn } from "../../packages/ui/src/table/columns";

const t: TranslateFn = (key) => key;

const columns: ResourceColumn[] = [
  { key: "name", label: "Name" },
  { key: "status", label: "Status" },
  { key: "created_at", label: "Created" },
];

const defaultProps = {
  t,
  columnFilter: "",
  onColumnFilterChange: jest.fn(),
  onColumnFilterClear: jest.fn(),
  onShowAllColumns: jest.fn(),
  onHideAllColumns: jest.fn(),
  filteredColumns: columns,
  columnOrder: ["name", "status", "created_at"],
  visibleColumns: new Set(["name", "status", "created_at"]),
  pinnedSet: new Set<string>(),
  columnWidths: {} as Record<string, number>,
  draggingColumn: null,
  dragOverColumn: null,
  onDragStart: jest.fn(() => jest.fn()),
  onDragOver: jest.fn(() => jest.fn()),
  onDrop: jest.fn(() => jest.fn()),
  onDragEnd: jest.fn(),
  onToggleColumn: jest.fn(),
  onTogglePin: jest.fn(),
  onUpdateWidth: jest.fn(),
  onMoveColumn: jest.fn(),
  minColumnWidth: 50,
  resizeStep: 10,
  rowDensity: "comfortable" as const,
  onRowDensityChange: jest.fn(),
  openMode: "peek" as const,
  onOpenModeChange: jest.fn(),
  showRowNumbers: false,
  onShowRowNumbersChange: jest.fn(),
  showInternalIdHints: false,
  onShowInternalIdHintsChange: jest.fn(),
  analyticsEnabled: false,
  onAnalyticsToggle: jest.fn(),
  summaryRowEnabled: false,
  onSummaryRowToggle: jest.fn(),
  paginationModeOptions: ["client" as const],
  paginationMode: "client" as const,
  onPaginationModeChange: jest.fn(),
  pageSize: 25,
  pageSizeOptions: [10, 25, 50],
  onPageSizeChange: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders column list", () => {
  render(<TableColumnPanel {...defaultProps} />);
  expect(screen.getByText("Name")).toBeInTheDocument();
  expect(screen.getByText("Status")).toBeInTheDocument();
  expect(screen.getByText("Created")).toBeInTheDocument();
});

test("calls onToggleColumn when column visibility toggled", () => {
  const onToggleColumn = jest.fn();
  render(
    <TableColumnPanel {...defaultProps} onToggleColumn={onToggleColumn} />
  );
  const nameCheckbox = screen.getByRole("checkbox", { name: "Name" });
  fireEvent.click(nameCheckbox);
  expect(onToggleColumn).toHaveBeenCalledWith("name");
});

test("calls onColumnFilterChange on search input", () => {
  const onColumnFilterChange = jest.fn();
  render(
    <TableColumnPanel
      {...defaultProps}
      onColumnFilterChange={onColumnFilterChange}
    />
  );
  const searchInput = screen.getByTestId("table-columns-search");
  fireEvent.change(searchInput, { target: { value: "stat" } });
  expect(onColumnFilterChange).toHaveBeenCalledWith("stat");
});

test("calls onShowAllColumns", () => {
  const onShowAllColumns = jest.fn();
  render(
    <TableColumnPanel
      {...defaultProps}
      visibleColumns={new Set(["name"])}
      onShowAllColumns={onShowAllColumns}
    />
  );
  const showAllButton = screen.getByText("columns.showAll");
  fireEvent.click(showAllButton);
  expect(onShowAllColumns).toHaveBeenCalledTimes(1);
});

test("calls onHideAllColumns", () => {
  const onHideAllColumns = jest.fn();
  render(
    <TableColumnPanel {...defaultProps} onHideAllColumns={onHideAllColumns} />
  );
  const hideAllButton = screen.getByText("columns.hideAll");
  fireEvent.click(hideAllButton);
  expect(onHideAllColumns).toHaveBeenCalledTimes(1);
});
