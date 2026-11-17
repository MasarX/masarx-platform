import { render, screen } from "@testing-library/react";
import { TableDataRow } from "../../packages/ui/src/table/data-row";
import { TableHeaderRow } from "../../packages/ui/src/table/header-row";
import type { ResourceColumn } from "../../packages/ui/src/table/columns";
import type { TranslateFn } from "../../packages/ui/src/table/types";

const t: TranslateFn = ((key: string, values?: Record<string, unknown>) => {
  if (key === "selection.selectAllAria") return "Select all rows";
  if (key === "selection.rowAria") return `Select row ${String(values?.id ?? "")}`;
  if (key === "detail.expandAria") return `Expand row ${String(values?.label ?? "")}`;
  if (key === "detail.collapseAria") return `Collapse row ${String(values?.label ?? "")}`;
  if (key === "detail.openLabel") return "Open";
  if (key === "detail.expandLabel") return "Expand";
  if (key === "detail.collapseLabel") return "Collapse";
  if (key === "columns.resizeAria") return `Resize ${String(values?.label ?? "")}`;
  if (key === "columns.resizeHint") return "Resize column";
  if (key === "columns.widthTitle") return `${String(values?.width ?? "")}`;
  if (key === "edit.aria") return `Edit ${String(values?.label ?? "")}`;
  if (key === "edit.action") return "Edit";
  if (key === "edit.save") return "Save";
  if (key === "edit.cancel") return "Cancel";
  if (key === "edit.error") return "Unable to save change.";
  if (key === "edit.saveAria") return `Save ${String(values?.label ?? "")}`;
  if (key === "edit.cancelAria") return `Cancel ${String(values?.label ?? "")}`;
  if (key === "edit.inputAria") return `Edit ${String(values?.label ?? "")} value`;
  if (key === "edit.selectPlaceholder") return "Select";
  if (key === "edit.saving") return "Saving...";
  return key;
}) as TranslateFn;

const baseColumns: ResourceColumn[] = [{ key: "name", label: "Name" }];

test("table header row uses sticky notch-style layout classes", () => {
  const selectHeaderRef = { current: null };
  const selectAllRef = { current: null };

  render(
    <table>
      <TableHeaderRow
        t={t}
        selectionEnabled={false}
        selectHeaderRef={selectHeaderRef}
        selectAllRef={selectAllRef}
        allSelected={false}
        onToggleAll={() => {}}
        displayColumns={baseColumns}
        sortState={[]}
        onSort={() => {}}
        numericColumnSet={new Set<string>()}
        pinnedOffsets={{}}
        columnWidths={{}}
        pinnedHeaderClass=""
        cellPadding="px-2 py-1.5"
        registerHeaderRef={() => () => {}}
        onResizeStart={() => {}}
        onResizeKey={() => {}}
        onUpdateWidth={() => {}}
      />
    </table>
  );

  const thead = screen.getByRole("columnheader", { name: "Name" }).closest("thead");
  expect(thead).toHaveClass("sticky");
  expect(thead).toHaveClass("top-0");
});

test("table data rows use flat background without alternating stripes", () => {
  const row = {
    type: "row" as const,
    id: "row-1",
    depth: 0,
    item: { id: "1", name: "Alpha" },
    groupPath: [],
    parentKey: "root",
    parentId: null,
  };
  const secondRow = {
    ...row,
    id: "row-2",
    item: { id: "2", name: "Bravo" },
  };

  const sharedProps = {
    t,
    idKey: "id" as const,
    selectionEnabled: false,
    selectedIds: new Set<string>(),
    cellPadding: "px-2 py-1.5",
    displayColumns: baseColumns,
    pinnedOffsets: {},
    columnWidths: {},
    pinnedCellClass: "",
    numericColumnSet: new Set<string>(),
    hasGrouping: false,
    editConfigByKey: new Map(),
    inlineEdit: null,
    editPending: false,
    updateInlineEditValue: () => {},
    cancelInlineEdit: () => {},
    commitInlineEdit: () => {},
    startInlineEdit: () => {},
    toggleRowExpanded: () => {},
    resolveRowKey: (item: Record<string, unknown>) => String(item.id ?? ""),
    resolveCellDisplay: (item: Record<string, unknown>) => ({
      primary: String(item.name ?? ""),
    }),
    expandedRowIds: new Set<string>(),
    onSelectRow: () => {},
    onNavigate: () => {},
  };

  render(
    <table>
      <tbody>
        <TableDataRow row={row} rowIndex={0} {...sharedProps} />
        <TableDataRow row={secondRow} rowIndex={1} {...sharedProps} />
      </tbody>
    </table>
  );

  const firstRow = screen.getByText("Alpha").closest("tr");
  const secondRenderedRow = screen.getByText("Bravo").closest("tr");

  // Both rows use flat transparent background (no alternating stripes)
  expect(firstRow).toHaveClass("bg-transparent");
  expect(secondRenderedRow).toHaveClass("bg-transparent");
});

test("table header selection checkbox uses compact notion-style sizing", () => {
  const selectHeaderRef = { current: null };
  const selectAllRef = { current: null };

  render(
    <table>
      <TableHeaderRow
        t={t}
        selectionEnabled
        selectHeaderRef={selectHeaderRef}
        selectAllRef={selectAllRef}
        allSelected={false}
        onToggleAll={() => {}}
        displayColumns={baseColumns}
        sortState={[]}
        onSort={() => {}}
        numericColumnSet={new Set<string>()}
        pinnedOffsets={{}}
        columnWidths={{}}
        pinnedHeaderClass=""
        cellPadding="px-2 py-1.5"
        registerHeaderRef={() => () => {}}
        onResizeStart={() => {}}
        onResizeKey={() => {}}
        onUpdateWidth={() => {}}
      />
    </table>
  );

  const checkbox = screen.getByRole("checkbox", { name: "Select all rows" });
  expect(checkbox.className).toContain("h-3.5");
  expect(checkbox.className).toContain("w-3.5");
});
