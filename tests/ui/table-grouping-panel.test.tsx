import { fireEvent, render, screen } from "@testing-library/react";
import type { ResourceColumn } from "../../packages/ui/src/table/columns";
import type { TranslateFn } from "../../packages/ui/src/table/types";
import { TableGroupingPanel } from "../../packages/ui/src/table/grouping-panel";

const t: TranslateFn = (key) => key;

const columns: ResourceColumn[] = [
  { key: "region", label: "Region" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
];

const columnsByKey = new Map(columns.map((c) => [c.key, c]));

function renderPanel(
  override: Partial<React.ComponentProps<typeof TableGroupingPanel>> = {}
) {
  const defaults: React.ComponentProps<typeof TableGroupingPanel> = {
    t,
    availableGroupKeys: ["region", "status", "priority"],
    resolvedGroupBy: [],
    columnsByKey,
    groupIds: [],
    collapsedGroups: new Set<string>(),
    onAddGroupKey: jest.fn(),
    onMoveGroupKey: jest.fn(),
    onRemoveGroupKey: jest.fn(),
    onClearGroupBy: jest.fn(),
    onCollapseAll: jest.fn(),
    onExpandAll: jest.fn(),
    testIdPrefix: "test",
    ...override,
  };
  return render(<TableGroupingPanel {...defaults} />);
}

describe("TableGroupingPanel", () => {
  it("renders with no grouping", () => {
    renderPanel({ resolvedGroupBy: [] });
    expect(screen.getByText("grouping.empty")).toBeInTheDocument();
    expect(screen.getByTestId("test-group-panel")).toBeInTheDocument();
  });

  it("renders active group by columns", () => {
    renderPanel({
      availableGroupKeys: ["priority"],
      resolvedGroupBy: ["region", "status"],
      groupIds: ["group-1", "group-2"],
    });
    expect(screen.getByText("Region")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.queryByText("grouping.empty")).not.toBeInTheDocument();
  });

  it("calls onRemoveGroupKey when remove clicked", () => {
    const onRemoveGroupKey = jest.fn();
    renderPanel({
      resolvedGroupBy: ["region"],
      groupIds: ["group-1"],
      onRemoveGroupKey,
    });
    fireEvent.click(screen.getByText("grouping.remove"));
    expect(onRemoveGroupKey).toHaveBeenCalledWith("region");
  });

  it("calls onClearGroupBy when clear clicked", () => {
    const onClearGroupBy = jest.fn();
    renderPanel({
      resolvedGroupBy: ["region"],
      groupIds: ["group-1"],
      onClearGroupBy,
    });
    fireEvent.click(screen.getByText("grouping.clearAll"));
    expect(onClearGroupBy).toHaveBeenCalledTimes(1);
  });

  it("calls onCollapseAll and onExpandAll", () => {
    const onCollapseAll = jest.fn();
    const onExpandAll = jest.fn();
    renderPanel({
      resolvedGroupBy: ["region"],
      groupIds: ["group-1", "group-2"],
      collapsedGroups: new Set(["group-1"]),
      onCollapseAll,
      onExpandAll,
    });
    fireEvent.click(screen.getByText("grouping.collapseAll"));
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("grouping.expandAll"));
    expect(onExpandAll).toHaveBeenCalledTimes(1);
  });
});
