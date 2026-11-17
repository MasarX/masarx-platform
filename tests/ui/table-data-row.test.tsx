import { fireEvent, render, screen } from "@testing-library/react";
import type { ResourceColumn } from "../../packages/ui/src/table/columns";
import { TableDataRow } from "../../packages/ui/src/table/data-row";

const t = (key: string, values?: Record<string, unknown>) => {
  const payload = values ?? {};
  if (key === "detail.openAria") return `Open details for ${String(payload.label ?? "")}`;
  if (key === "detail.expandAria") return `Expand row ${String(payload.label ?? "")}`;
  if (key === "detail.collapseAria") return `Collapse row ${String(payload.label ?? "")}`;
  if (key === "detail.openLabel") return "Open";
  if (key === "detail.expandLabel") return "Expand";
  if (key === "detail.collapseLabel") return "Collapse";
  if (key === "selection.rowAria") return `Select row ${String(payload.id ?? "")}`;
  if (key === "edit.uuidHint") {
    return `${String(payload.label ?? "")} expects an internal UUID.`;
  }
  if (key === "edit.uuidBusinessHint") {
    return `Use ${String(payload.label ?? "")}: ${String(payload.value ?? "")} in business-facing reference fields.`;
  }
  if (key === "edit.save") return "Save";
  if (key === "edit.cancel") return "Cancel";
  if (key === "edit.saveAria") return `Save ${String(payload.label ?? "")}`;
  if (key === "edit.cancelAria") return `Cancel edit for ${String(payload.label ?? "")}`;
  if (key === "edit.inputAria") return `Edit ${String(payload.label ?? "")} value`;
  if (key === "edit.action") return "Edit";
  if (key === "edit.aria") return `Edit ${String(payload.label ?? "")}`;
  return key;
};

const displayColumns: ResourceColumn[] = [
  { key: "id", label: "ID" },
  { key: "sender_id", label: "Sender ID" },
  { key: "tracking_number", label: "Tracking Number" },
];

function renderRow(override: Partial<React.ComponentProps<typeof TableDataRow>> = {}) {
  return render(
    <table>
      <tbody>
        <TableDataRow
          t={t}
          row={{
            type: "row",
            id: "row-1",
            depth: 0,
            groupPath: [],
            item: {
              id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
              sender_id: "d7cf8c31-a468-4ab4-bb95-0095cb52e0f0",
              tracking_number: "TESTB-62836344",
            },
          }}
          rowIndex={0}
          idKey="id"
          selectionEnabled
          selectedIds={new Set<string>()}
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
          updateInlineEditValue={() => undefined}
          cancelInlineEdit={() => undefined}
          commitInlineEdit={() => undefined}
          startInlineEdit={() => undefined}
          toggleRowExpanded={() => undefined}
          resolveRowKey={(item, fallback) =>
            typeof item.id === "string" && item.id.trim() ? item.id : fallback
          }
          resolveCellDisplay={(item, column) => ({
            primary: String(item[column.key] ?? "-"),
          })}
          expandedRowIds={new Set<string>()}
          onSelectRow={() => undefined}
          onNavigate={() => undefined}
          {...override}
        />
      </tbody>
    </table>
  );
}

describe("TableDataRow", () => {
  it("uses business identifiers for row toggle and selection labels", () => {
    renderRow();

    const toggle = screen.getByRole("button", { name: "Expand row TESTB-62836344" });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveTextContent("Expand");
    expect(
      screen.getByRole("checkbox", { name: "Select row TESTB-62836344" })
    ).toBeInTheDocument();
  });

  it("shows UUID helper hints during inline edit", () => {
    const rowId = "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c";
    const senderId = "d7cf8c31-a468-4ab4-bb95-0095cb52e0f0";
    renderRow({
      selectionEnabled: false,
      editConfigByKey: new Map([["sender_id", { editType: "uuid", options: [] }]]),
      inlineEdit: {
        rowId,
        columnKey: "sender_id",
        editType: "uuid",
        value: senderId,
        status: "idle",
      },
    });

    expect(screen.getByText("Sender ID expects an internal UUID.")).toBeInTheDocument();
  });

  it("does not render inline edit action for primary id column", () => {
    renderRow({
      selectionEnabled: false,
      editConfigByKey: new Map([["id", { editType: "uuid", options: [] }]]),
    });

    expect(screen.queryByRole("button", { name: "Edit ID" })).not.toBeInTheDocument();
  });

  it("opens linked detail panels instead of inline expand when row href exists", () => {
    const onNavigate = jest.fn();
    const toggleRowExpanded = jest.fn();

    renderRow({
      baseHref: "/portal/resources/shipments",
      onNavigate,
      toggleRowExpanded,
    });

    const toggle = screen.getByRole("button", {
      name: "Open details for TESTB-62836344",
    });
    expect(toggle).toHaveTextContent("Open");
    fireEvent.click(toggle);

    expect(onNavigate).toHaveBeenCalledWith(
      "/portal/resources/shipments?id=e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c"
    );
    expect(toggleRowExpanded).not.toHaveBeenCalled();
  });

  it("uses readable fallback references when no business identifier exists", () => {
    renderRow({
      row: {
        type: "row",
        id: "row-2",
        depth: 0,
        groupPath: [],
        item: {
          id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
        },
      },
      displayColumns: [{ key: "id", label: "ID" }],
      resolveCellDisplay: (item, column) => ({
        primary: String(item[column.key] ?? "-"),
      }),
    });

    expect(
      screen.getByRole("button", { name: "Expand row REF-E5E9E25C" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select row REF-E5E9E25C" })
    ).toBeInTheDocument();
  });

  it("uses descriptor text for row labels when identifiers are opaque", () => {
    renderRow({
      row: {
        type: "row",
        id: "row-3",
        depth: 0,
        groupPath: [],
        item: {
          id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
          description: "Handover pending at depot",
        },
      },
      displayColumns: [{ key: "id", label: "ID" }],
      resolveCellDisplay: (item, column) => ({
        primary: String(item[column.key] ?? "-"),
      }),
    });

    expect(
      screen.getByRole("button", {
        name: "Expand row Handover pending at depot",
      })
    ).toBeInTheDocument();
  });
});
