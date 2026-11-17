import { fireEvent, render, screen } from "@testing-library/react";
import type { ResourceColumn } from "../../packages/ui/src/table/columns";
import type { TranslateFn } from "../../packages/ui/src/table/types";
import { TableSortPanel } from "../../packages/ui/src/table/sort-panel";

const t: TranslateFn = (key) => key;

const columns: ResourceColumn[] = [
  { key: "name", label: "Name" },
  { key: "status", label: "Status" },
  { key: "created_at", label: "Created At" },
];

const columnsByKey = new Map(columns.map((c) => [c.key, c]));

function renderPanel(
  override: Partial<React.ComponentProps<typeof TableSortPanel>> = {}
) {
  const defaults: React.ComponentProps<typeof TableSortPanel> = {
    t,
    sortState: [],
    columnsByKey,
    onAddSort: jest.fn(),
    onRemoveSort: jest.fn(),
    onToggleDirection: jest.fn(),
    onMoveSort: jest.fn(),
    onClearSorts: jest.fn(),
    testIdPrefix: "test",
    ...override,
  };
  return render(<TableSortPanel {...defaults} />);
}

describe("TableSortPanel", () => {
  it("renders with no sorts", () => {
    renderPanel({ sortState: [] });
    expect(screen.getByText("viewBar.noSorts")).toBeInTheDocument();
    expect(screen.getByTestId("test-sort-panel")).toBeInTheDocument();
  });

  it("renders existing sorts with column labels", () => {
    renderPanel({
      sortState: [
        { key: "name", direction: "asc" },
        { key: "status", direction: "desc" },
      ],
    });
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("viewBar.directionAsc")).toBeInTheDocument();
    expect(screen.getByText("viewBar.directionDesc")).toBeInTheDocument();
    expect(screen.queryByText("viewBar.noSorts")).not.toBeInTheDocument();
  });

  it("calls onToggleDirection when direction button clicked", () => {
    const onToggleDirection = jest.fn();
    renderPanel({
      sortState: [{ key: "name", direction: "asc" }],
      onToggleDirection,
    });
    fireEvent.click(screen.getByText("viewBar.directionAsc"));
    expect(onToggleDirection).toHaveBeenCalledWith("name");
  });

  it("calls onRemoveSort when remove button clicked", () => {
    const onRemoveSort = jest.fn();
    renderPanel({
      sortState: [{ key: "name", direction: "asc" }],
      onRemoveSort,
    });
    fireEvent.click(screen.getByText("viewBar.remove"));
    expect(onRemoveSort).toHaveBeenCalledWith("name");
  });

  it("calls onClearSorts when clear button clicked", () => {
    const onClearSorts = jest.fn();
    renderPanel({
      sortState: [{ key: "name", direction: "asc" }],
      onClearSorts,
    });
    fireEvent.click(screen.getByText("viewBar.clearSort"));
    expect(onClearSorts).toHaveBeenCalledTimes(1);
  });
});
