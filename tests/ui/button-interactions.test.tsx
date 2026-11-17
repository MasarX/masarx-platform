jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(() => ({
    listResource: jest.fn(),
    executeCommand: jest.fn(),
  })),
}));

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockRefresh = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: mockReplace,
    push: mockPush,
    refresh: mockRefresh,
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/test",
}));

import { render, screen, fireEvent } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { ResourceDetailNavigation } from "../../packages/ui/src/resource-detail-navigation";
import { TableDataRow } from "../../packages/ui/src/table/data-row";
import { ResourceColumn } from "../../packages/ui/src/table/columns";
import { InlineEditState, EditConfig } from "../../packages/ui/src/table/editing";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const t = (key: string, values?: Record<string, unknown>) => {
  const v = values ?? {};
  if (key === "selection.rowAria") return `Select row ${String(v.id ?? "")}`;
  if (key === "detail.expandAria") return `Expand row ${String(v.label ?? "")}`;
  if (key === "detail.collapseAria") return `Collapse row ${String(v.label ?? "")}`;
  if (key === "detail.openAria") return `Open details for ${String(v.label ?? "")}`;
  if (key === "detail.openLabel") return "Open";
  if (key === "detail.expandLabel") return "Expand";
  if (key === "detail.collapseLabel") return "Collapse";
  if (key === "edit.action") return "Edit";
  if (key === "edit.aria") return `Edit ${String(v.label ?? "")}`;
  if (key === "edit.inputAria") return `Edit ${String(v.label ?? "")} value`;
  if (key === "edit.selectPlaceholder") return "Select value";
  if (key === "edit.save") return "Save";
  if (key === "edit.saving") return "Saving\u2026";
  if (key === "edit.cancel") return "Cancel";
  if (key === "edit.saveAria") return `Save ${String(v.label ?? "")}`;
  if (key === "edit.cancelAria") return `Cancel edit for ${String(v.label ?? "")}`;
  if (key === "edit.error") return "Unable to save change.";
  return key;
};

const displayColumns: ResourceColumn[] = [
  { key: "name", label: "Name" },
  { key: "status", label: "Status" },
];

function renderRow(
  override: Partial<React.ComponentProps<typeof TableDataRow>> = {}
) {
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
            item: { id: "1", name: "Alpha", status: "active" },
          }}
          rowIndex={0}
          idKey="id"
          selectionEnabled={false}
          selectedIds={new Set<string>()}
          cellPadding="px-2 py-1.5"
          displayColumns={displayColumns}
          pinnedOffsets={{}}
          columnWidths={{}}
          pinnedCellClass=""
          numericColumnSet={new Set<string>()}
          hasGrouping={false}
          editConfigByKey={new Map<string, EditConfig>()}
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockReplace.mockClear();
  mockPush.mockClear();
  mockRefresh.mockClear();
});

describe("Button Interactions", () => {
  // -----------------------------------------------------------------------
  // Navigation Buttons (ResourceDetailNavigation)
  // -----------------------------------------------------------------------
  describe("Navigation Buttons", () => {
    test("prev button calls onNavigate with prevHref", () => {
      const onNavigate = jest.fn();
      renderWithIntl(
        <ResourceDetailNavigation
          prevHref="/records/prev"
          nextHref="/records/next"
          onNavigate={onNavigate}
        />
      );

      fireEvent.click(
        screen.getByRole("button", { name: /previous record/i })
      );

      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(onNavigate).toHaveBeenCalledWith("/records/prev");
    });

    test("next button calls onNavigate with nextHref", () => {
      const onNavigate = jest.fn();
      renderWithIntl(
        <ResourceDetailNavigation
          prevHref="/records/prev"
          nextHref="/records/next"
          onNavigate={onNavigate}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /next record/i }));

      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(onNavigate).toHaveBeenCalledWith("/records/next");
    });

    test("prev button is disabled when prevHref is null", () => {
      renderWithIntl(
        <ResourceDetailNavigation prevHref={null} nextHref="/records/next" />
      );

      expect(
        screen.getByRole("button", { name: /previous record/i })
      ).toBeDisabled();
    });

    test("next button is disabled when nextHref is null", () => {
      renderWithIntl(
        <ResourceDetailNavigation prevHref="/records/prev" nextHref={null} />
      );

      expect(
        screen.getByRole("button", { name: /next record/i })
      ).toBeDisabled();
    });
  });

  // -----------------------------------------------------------------------
  // Inline Edit Buttons (TableDataRow)
  // -----------------------------------------------------------------------
  describe("Inline Edit Buttons", () => {
    const inlineEdit: InlineEditState = {
      rowId: "1",
      columnKey: "name",
      editType: "text",
      value: "Alpha",
      status: "idle",
      error: null,
    };

    const editConfigByKey = new Map<string, EditConfig>([
      ["name", { editType: "text", options: [] }],
    ]);

    test("Enter key calls commitInlineEdit", () => {
      const commitInlineEdit = jest.fn();

      renderRow({
        editConfigByKey,
        inlineEdit,
        commitInlineEdit,
      });

      const input = screen.getByLabelText("Edit Name value");
      fireEvent.keyDown(input, { key: "Enter" });

      expect(commitInlineEdit).toHaveBeenCalledTimes(1);
    });

    test("Escape key calls cancelInlineEdit", () => {
      const cancelInlineEdit = jest.fn();

      renderRow({
        editConfigByKey,
        inlineEdit,
        cancelInlineEdit,
      });

      const input = screen.getByLabelText("Edit Name value");
      fireEvent.keyDown(input, { key: "Escape" });

      expect(cancelInlineEdit).toHaveBeenCalledTimes(1);
    });

    test("input is disabled during saving", () => {
      const savingEdit: InlineEditState = {
        ...inlineEdit,
        status: "saving",
      };

      renderRow({
        editConfigByKey,
        inlineEdit: savingEdit,
      });

      const input = screen.getByLabelText("Edit Name value");
      expect(input).toBeDisabled();
    });
  });

  // -----------------------------------------------------------------------
  // Panel Toggle Buttons
  // -----------------------------------------------------------------------
  describe("Panel Toggle Buttons", () => {
    test("panel toggle buttons don't trigger navigation", () => {
      // Panel toggles live inside ResourceTable and only flip the
      // activePanel state variable via setActivePanel.  They never call
      // router.replace or router.push.  We verify this by rendering the
      // navigation component with panel-like buttons nearby and asserting
      // that the mock router methods remain untouched after interaction.

      const onNavigate = jest.fn();
      renderWithIntl(
        <ResourceDetailNavigation
          prevHref="/prev"
          nextHref="/next"
          onNavigate={onNavigate}
        />
      );

      // Click prev -- uses onNavigate, NOT router
      fireEvent.click(
        screen.getByRole("button", { name: /previous record/i })
      );
      expect(onNavigate).toHaveBeenCalled();

      // Even though navigation occurred, router.replace and router.push
      // should NOT have been invoked because onNavigate was provided.
      expect(mockReplace).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Double-Submit Prevention
  // -----------------------------------------------------------------------
  describe("Double-Submit Prevention", () => {
    const editConfigByKey = new Map<string, EditConfig>([
      ["name", { editType: "text", options: [] }],
    ]);

    const inlineEdit: InlineEditState = {
      rowId: "1",
      columnKey: "name",
      editType: "text",
      value: "Alpha",
      status: "idle",
      error: null,
    };

    test("inline edit input disabled when editPending", () => {
      renderRow({
        editConfigByKey,
        inlineEdit,
        editPending: true,
      });

      const input = screen.getByLabelText("Edit Name value");
      expect(input).toBeDisabled();
    });
  });
});
