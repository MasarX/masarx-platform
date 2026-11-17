import { render, screen } from "@testing-library/react";
import { TableDataRow } from "../../packages/ui/src/table/data-row";
import type { ResourceColumn } from "../../packages/ui/src/table/columns";
import type { TranslateFn } from "../../packages/ui/src/table/types";

const t: TranslateFn = (key, values) => {
  if (key === "selection.rowAria") return `Select row ${String(values?.id ?? "")}`;
  if (key === "detail.expandAria") return `Expand row ${String(values?.label ?? "")}`;
  if (key === "detail.collapseAria") return `Collapse row ${String(values?.label ?? "")}`;
  if (key === "edit.action") return "Edit";
  if (key === "edit.aria") return `Edit ${String(values?.label ?? "")}`;
  if (key === "edit.inputAria") return `Edit ${String(values?.label ?? "")} value`;
  if (key === "edit.selectPlaceholder") return "Select value";
  if (key === "edit.save") return "Save";
  if (key === "edit.cancel") return "Cancel";
  if (key === "edit.error") return "Unable to save change.";
  return key;
};

const displayColumns: ResourceColumn[] = [{ key: "name", label: "Name" }];

function renderRow(selectedIds: Set<string>) {
  return render(
    <table>
      <tbody>
        <TableDataRow
          t={t}
          row={{
            type: "row",
            id: "row-1",
            depth: 0,
            item: { id: "1", name: "Alpha" },
            groupPath: [],
          }}
          rowIndex={0}
          idKey="id"
          baseHref={null}
          resolveRowHref={undefined}
          selectionEnabled
          selectedIds={selectedIds}
          cellPadding="px-2 py-1.5"
          displayColumns={displayColumns}
          pinnedOffsets={{}}
          columnWidths={{}}
          pinnedCellClass=""
          numericColumnSet={new Set<string>()}
          hasGrouping={false}
          editConfigByKey={new Map()}
          inlineEdit={null}
          editPending={false}
          updateInlineEditValue={() => {}}
          cancelInlineEdit={() => {}}
          commitInlineEdit={() => {}}
          startInlineEdit={() => {}}
          toggleRowExpanded={() => {}}
          resolveRowKey={(_, fallback) => fallback}
          resolveCellDisplay={(item, column) => {
            const value = item[column.key];
            const text = value === null || value === undefined ? "-" : String(value);
            return {
              primary: text,
              primaryTitle: text,
            };
          }}
          expandedRowIds={new Set<string>()}
          onSelectRow={() => {}}
          onNavigate={() => {}}
        />
      </tbody>
    </table>
  );
}

test("row selection checkbox is hover-revealed by default", () => {
  renderRow(new Set<string>());
  const checkbox = screen.getByRole("checkbox", { name: "Select row Alpha" });
  expect(checkbox.className).toContain("h-3.5");
  expect(checkbox.className).toContain("w-3.5");
  expect(checkbox.className).toContain("sm:opacity-0");
  expect(checkbox.className).toContain("sm:group-hover:opacity-100");
});

test("row selection checkbox stays visible when the row is selected", () => {
  renderRow(new Set<string>(["1"]));
  const checkbox = screen.getByRole("checkbox", { name: "Select row Alpha" });
  expect(checkbox.className).toContain("opacity-100");
});
