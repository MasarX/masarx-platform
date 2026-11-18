import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResourceTable } from "../../packages/ui/src/resource-table";
import { setUiReporter } from "../../packages/ui/src/reporting";
import { renderWithIntl } from "./test-utils";

const replaceMock = jest.fn();
const pushMock = jest.fn();
const requestSettingsChangeMock = jest.fn();
const updateResourceMock = jest.fn();

const createDataTransfer = () => {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
};

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: () => ({
    requestSettingsChange: requestSettingsChangeMock,
    updateResource: updateResourceMock,
  }),
}));

const expectTextVisible = (text: string | RegExp) => {
  expect(screen.getAllByText(text).length).toBeGreaterThan(0);
};

const expectTextHidden = (text: string | RegExp) => {
  expect(screen.queryAllByText(text)).toHaveLength(0);
};

beforeEach(() => {
  replaceMock.mockClear();
  pushMock.mockClear();
  requestSettingsChangeMock.mockClear();
  updateResourceMock.mockClear();
  setUiReporter(jest.fn());
});

afterEach(() => {
  setUiReporter(null);
});

test("resource table renders empty message", () => {
  renderWithIntl(
    <ResourceTable
      columns={[{ key: "id", label: "ID" }]}
      items={[]}
      emptyMessage="No rows"
    />
  );

  expect(screen.getByText("No rows")).toBeInTheDocument();
});

test("resource table renders rows and links when configured", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" }
      ]}
      items={[{ id: "123", name: "Shipment 123" }]}
      idKey="id"
      baseHref="/resources/shipments"
    />
  );

  expectTextVisible("Shipment 123");
  const link = screen.getByRole("link", { name: /Shipment 123/ });
  expect(link).toHaveAttribute(
    "href",
    "/resources/shipments?id=123&detail_open=1"
  );
});

test("resource table expands rows to show detail panel", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
        { key: "status", label: "Status" },
      ]}
      items={[{ id: "1", name: "Alpha", status: "Ready" }]}
      idKey="id"
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Expand row Alpha" }));
  const detailPanel = screen.getByTestId("row-detail-1");
  expect(within(detailPanel).getByText("Row details: Alpha")).toBeInTheDocument();
  expect(within(detailPanel).getByText("Status")).toBeInTheDocument();
  expect(within(detailPanel).getByText("Ready")).toBeInTheDocument();
});

test("resource table supports column toggles", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" }
      ]}
      items={[
        { id: "1", name: "Alpha" },
        { id: "2", name: "Zulu" }
      ]}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  const nameCheckbox = screen.getByRole("checkbox", { name: /Name/ });
  fireEvent.click(nameCheckbox);

  expect(screen.queryByRole("columnheader", { name: "Name" })).toBeNull();
});

test("resource table supports drag-drop column reordering", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
        { key: "status", label: "Status" },
      ]}
      items={[{ id: "1", name: "Alpha", status: "Ready" }]}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  const dataTransfer = createDataTransfer();
  const dragHandle = screen.getByLabelText("Drag to reorder column: Name");
  const dropTarget = screen.getByRole("checkbox", { name: /Status/ }).closest("div");
  if (!dropTarget) {
    throw new Error("Expected column row for Status.");
  }

  fireEvent.dragStart(dragHandle, { dataTransfer });
  fireEvent.dragOver(dropTarget, { dataTransfer });
  fireEvent.drop(dropTarget, { dataTransfer });
  fireEvent.dragEnd(dragHandle, { dataTransfer });

  const headers = screen.getAllByRole("columnheader");
  expect(headers[0]).toHaveTextContent("ID");
  expect(headers[1]).toHaveTextContent("Status");
  expect(headers[2]).toHaveTextContent("Name");
});

test("resource table supports pinned columns", async () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
      ]}
      items={[
        { id: "1", name: "Alpha" },
        { id: "2", name: "Zulu" },
      ]}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  const nameRow = screen.getByRole("checkbox", { name: /Name/ }).closest("div");
  if (!nameRow) {
    throw new Error("Expected column row for Name.");
  }
  fireEvent.click(within(nameRow).getByRole("button", { name: "Pin" }));

  await waitFor(() => {
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute(
      "data-pinned",
      "true"
    );
  });

  const resizeHandle = screen.getByLabelText("Resize Name");
  fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });
  fireEvent.keyDown(resizeHandle, { key: "ArrowRight", shiftKey: true });
});

test("resource table filters the column list", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
        { key: "status", label: "Status" },
      ]}
      items={[
        { id: "1", name: "Alpha", status: "Ready" },
      ]}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  fireEvent.change(screen.getByTestId("table-columns-search"), {
    target: { value: "stat" },
  });

  expect(screen.getByRole("checkbox", { name: /Status/ })).toBeInTheDocument();
  expect(screen.queryByLabelText("Name")).toBeNull();
});

test("resource table supports inline editing when permitted", async () => {
  updateResourceMock.mockResolvedValue({ id: "1", status: "Delivered" });

  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status", editMode: "inline", editType: "text" },
      ]}
      items={[{ id: "1", status: "Ready" }]}
      idKey="id"
      resourceKey="shipments"
      capabilities={["shipments.write"]}
      capabilityWrite="shipments.write"
    />
  );

  const statusCell = screen.getByText("Ready").closest("td");
  expect(statusCell).toHaveAttribute("data-column-key", "status");
  expect(statusCell).toHaveAttribute("data-editable", "true");
  fireEvent.dblClick(statusCell!);
  await waitFor(() => {
    expect(screen.getByLabelText("Edit Status value")).toBeInTheDocument();
  });
  fireEvent.change(screen.getByLabelText("Edit Status value"), {
    target: { value: "Delivered" },
  });
  fireEvent.keyDown(screen.getByLabelText("Edit Status value"), { key: "Enter" });

  await waitFor(() => {
    expect(updateResourceMock).toHaveBeenCalledWith({
      resource: "shipments",
      id: "1",
      patch: { status: "Delivered" },
    });
  });
});

test("resource table hides inline edit action without capability", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status", editMode: "inline", editType: "text" },
      ]}
      items={[{ id: "1", status: "Ready" }]}
      idKey="id"
      resourceKey="shipments"
      capabilities={[]}
      capabilityWrite="shipments.write"
    />
  );

  expect(screen.getByText("Ready").closest("td")).toHaveAttribute(
    "data-editable",
    "false"
  );
});

test("resource table filters rows via quick search", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
      ]}
      items={[
        { id: "1", name: "Alpha" },
        { id: "2", name: "Bravo" },
      ]}
    />
  );

  fireEvent.change(screen.getByLabelText("Search rows"), {
    target: { value: "Alpha" },
  });

  expectTextVisible("Alpha");
  expectTextHidden("Bravo");
  expect(screen.getByText("Filtered 1 of 2 (page)")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Clear quick search" }));
  expectTextVisible("Bravo");
  expect(screen.getByText("Rows 2")).toBeInTheDocument();
});

test("resource table shows filter chips when filters are active", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
      ]}
      items={[{ id: "1", status: "Ready" }]}
      viewState={{
        resourceKey: "shipments",
        activeFilters: {
          id: "group-1",
          type: "group",
          op: "and",
          rules: [
            {
              id: "rule-1",
              type: "rule",
              key: "status",
              op: "eq",
              value: "Ready",
            },
            {
              id: "rule-2",
              type: "rule",
              key: "zone",
              op: "eq",
              value: "North",
            },
          ],
        },
      }}
    />
  );

  expect(screen.getByText("Filters: 2")).toBeInTheDocument();
});

test("resource table supports client pagination", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
      ]}
      items={[
        { id: "1", name: "Alpha" },
        { id: "2", name: "Bravo" },
        { id: "3", name: "Charlie" },
      ]}
      clientPagination={{ pageSizes: [1, 2], defaultPageSize: 1 }}
    />
  );

  expectTextVisible("Alpha");
  expectTextHidden("Bravo");
  expect(screen.getByText("Showing 1-1 of 3")).toBeInTheDocument();
  expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expectTextVisible("Bravo");
  expectTextHidden("Alpha");
  expect(screen.getByText("Showing 2-2 of 3")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Go to page"), {
    target: { value: "3" },
  });
  expectTextVisible("Charlie");
  expect(screen.getByText("Showing 3-3 of 3")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "First page" }));
  expectTextVisible("Alpha");

  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  fireEvent.change(screen.getByLabelText("Page size"), {
    target: { value: "2" },
  });
  expect(screen.getByText("Showing 1-2 of 3")).toBeInTheDocument();
  expectTextVisible("Alpha");
  expectTextVisible("Bravo");
});

test("resource table sorts rows by column", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" }
      ]}
      items={[
        { id: "1", name: "Zulu" },
        { id: "2", name: "Alpha" }
      ]}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  const rows = screen.getAllByRole("row");
  expect(rows[1]).toHaveTextContent("Alpha");
});

test("resource table supports multi-column sorting", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
        { key: "status", label: "Status" }
      ]}
      items={[
        { id: "1", name: "Alpha", status: "B" },
        { id: "2", name: "Alpha", status: "A" },
        { id: "3", name: "Bravo", status: "C" }
      ]}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  fireEvent.click(screen.getByRole("button", { name: "Status" }), {
    shiftKey: true
  });

  const rows = screen.getAllByRole("row");
  expect(rows[1]).toHaveTextContent("Alpha");
  expect(rows[1]).toHaveTextContent("A");
  expect(rows[2]).toHaveTextContent("Alpha");
  expect(rows[2]).toHaveTextContent("B");
});

test("resource table reports telemetry for filters, sorts, and groups", () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
      ]}
      items={[{ id: "1", status: "Ready" }]}
      resourceKey="shipments"
      baseHref="/resources/shipments"
      filters={[{ key: "status", column: "status", op: "eq" }]}
      viewState={{
        resourceKey: "shipments",
        scopeType: "tenant",
        scopeId: "tenant-1",
        scopeValue: "acme",
        settingsResolutionId: "res-123",
      }}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  fireEvent.change(screen.getByPlaceholderText("value or comma-separated values"), {
    target: { value: "Ready" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

  fireEvent.click(screen.getByRole("button", { name: "Sort" }));
  fireEvent.change(screen.getByLabelText("Add sort"), {
    target: { value: "status" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Group" }));
  fireEvent.change(screen.getByLabelText("Add group"), {
    target: { value: "status" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand all" }));

  const meta = {
    settingsResolutionId: "res-123",
    scopeType: "tenant",
    scopeId: "tenant-1",
    scopeValue: "acme",
  };
  const events = reporter.mock.calls.map((call) => call[0]);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "ui.table.filter.apply",
        context: "shipments",
        digest: "res-123",
        meta,
      }),
      expect.objectContaining({
        type: "ui.table.sort.add",
        context: "shipments",
        name: "status",
        digest: "res-123",
        meta,
      }),
      expect.objectContaining({
        type: "ui.table.group.add",
        context: "shipments",
        name: "status",
        digest: "res-123",
        meta,
      }),
      expect.objectContaining({
        type: "ui.table.group.collapse_all",
        context: "shipments",
        digest: "res-123",
        meta,
      }),
      expect.objectContaining({
        type: "ui.table.group.expand_all",
        context: "shipments",
        digest: "res-123",
        meta,
      }),
    ])
  );
});

test("resource table honors saved view columns", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" }
      ]}
      items={[{ id: "1", status: "Ready" }]}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "view-1",
        views: [
          {
            id: "view-1",
            label: "Lean view",
            columns: {
              order: ["id", "status"],
              hidden: ["status"]
            }
          }
        ]
      }}
    />
  );

  expect(screen.queryByRole("columnheader", { name: "Status" })).toBeNull();
  expect(screen.getByRole("columnheader", { name: "ID" })).toBeInTheDocument();
});

test("resource table can show all columns from properties panel", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
      ]}
      items={[{ id: "1", status: "Ready" }]}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "view-1",
        views: [
          {
            id: "view-1",
            label: "Lean view",
            columns: {
              order: ["id", "status"],
              hidden: ["status"],
            },
          },
        ],
      }}
    />
  );

  expect(screen.queryByRole("columnheader", { name: "Status" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  fireEvent.click(screen.getByRole("button", { name: "Show all" }));

  expect(
    screen.getByRole("columnheader", { name: "Status" })
  ).toBeInTheDocument();
});

test("resource table shows empty state when all columns are hidden", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
      ]}
      items={[{ id: "1", status: "Ready" }]}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "hidden",
        views: [
          {
            id: "hidden",
            label: "Hidden",
            columns: {
              hidden: ["id", "status"],
            },
          },
        ],
      }}
    />
  );

  expect(
    screen.getByText("No columns selected. Update the view to show data.")
  ).toBeInTheDocument();
});

test("resource table groups rows when view defines group_by", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
      ]}
      items={[
        { id: "1", status: "Ready" },
        { id: "2", status: "Pending" },
        { id: "3", status: "Ready" },
      ]}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "grouped",
        views: [
          {
            id: "grouped",
            label: "Grouped",
            group_by: "status",
          },
        ],
      }}
    />
  );

  expect(
    screen.getByText("Group: Status = Ready (2, 67% of page)")
  ).toBeInTheDocument();
  expect(
    screen.getByText("Group: Status = Pending (1, 33% of page)")
  ).toBeInTheDocument();
});

test("resource table renders group metrics with count", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
        { key: "amount", label: "Amount" },
      ]}
      items={[
        { id: "1", status: "Ready", amount: 10 },
        { id: "2", status: "Ready", amount: 15 },
        { id: "3", status: "Pending", amount: 7 },
      ]}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "grouped",
        views: [
          {
            id: "grouped",
            label: "Grouped",
            group_by: "status",
          },
        ],
      }}
    />
  );

  const groupRow = screen
    .getByText("Group: Status = Ready (2, 67% of page)")
    .closest("tr");
  expect(groupRow).not.toBeNull();
  expect(within(groupRow!).getByText("Count 2")).toBeInTheDocument();
});

test("resource table collapses grouped rows", () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
        { key: "status", label: "Status" },
      ]}
      items={[
        { id: "1", name: "Alpha", status: "Ready" },
        { id: "2", name: "Beta", status: "Ready" },
        { id: "3", name: "Gamma", status: "Pending" },
      ]}
      resourceKey="shipments"
      viewState={{
        resourceKey: "shipments",
        scopeType: "tenant",
        scopeId: "tenant-1",
        settingsResolutionId: "res-123",
        activeViewId: "grouped",
        views: [
          {
            id: "grouped",
            label: "Grouped",
            group_by: "status",
          },
        ],
      }}
    />
  );

  const toggle = screen.getByRole("button", { name: "Collapse group: Status = Ready" });
  expectTextVisible("Alpha");
  fireEvent.click(toggle);
  expectTextHidden("Alpha");
  fireEvent.click(toggle);
  expectTextVisible("Alpha");

  const events = reporter.mock.calls.map((call) => call[0]);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "ui.table.group.collapse.toggle",
        context: "shipments",
        digest: "res-123",
        meta: {
          settingsResolutionId: "res-123",
          scopeType: "tenant",
          scopeId: "tenant-1",
        },
      }),
    ])
  );
});

test("resource table applies density from saved view", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
      ]}
      items={[{ id: "1", name: "Alpha" }]}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "compact",
        views: [
          {
            id: "compact",
            label: "Compact view",
            density: "compact",
          },
        ],
      }}
    />
  );

  const header = screen.getByRole("columnheader", { name: "ID" });
  expect(header.className).toMatch(/py-2/);
});

test("resource table uses open mode to control row href", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
      ]}
      items={[{ id: "123", name: "Shipment 123" }]}
      idKey="id"
      baseHref="/resources/shipments"
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  const openModeSelect = screen.getByLabelText(/Open records in/i);
  fireEvent.change(openModeSelect, { target: { value: "full" } });

  const link = screen.getByRole("link", { name: /Shipment 123/i });
  const href = link.getAttribute("href");
  expect(href).toContain("detail_layout=full");
  expect(href).toContain("id=123");
});

test("resource table shows paging mode selector when enabled", () => {
  renderWithIntl(
    <ResourceTable
      columns={[{ key: "id", label: "ID" }]}
      items={[{ id: "1" }]}
      clientPagination={{ pageSizes: [1], defaultPageSize: 1 }}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  const modeSelect = screen.getByLabelText("Paging mode");
  expect(modeSelect).toHaveValue("client");
});

test("resource table shows server paging badge when client paging is off", () => {
  renderWithIntl(
    <ResourceTable
      columns={[{ key: "id", label: "ID" }]}
      items={[{ id: "1" }]}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  expect(screen.getByText("Server paging")).toBeInTheDocument();
});

test("resource table respects analytics preference from saved view", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "amount", label: "Amount" },
      ]}
      items={[{ id: "1", amount: 10 }]}
      datasetMetrics={{
        total: 1,
        columns: {
          amount: {
            count: 1,
            sum: 10,
            min: 10,
            max: 10,
            avg: 10,
          },
        },
      }}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "no-analytics",
        views: [
          {
            id: "no-analytics",
            label: "No analytics",
            analytics: false,
          },
        ],
      }}
    />
  );

  expect(screen.queryByText("Analytics")).toBeNull();
});

test("resource table renders summary row when analytics are enabled", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "amount", label: "Amount" },
      ]}
      items={[{ id: "1", amount: 10 }]}
    />
  );

  expect(screen.getByText("Summary (1)")).toBeInTheDocument();
});

test("resource table can disable summary row from properties panel", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "amount", label: "Amount" },
      ]}
      items={[{ id: "1", amount: 10 }]}
    />
  );

  expect(screen.getByText("Summary (1)")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Show summary row" }));

  expect(screen.queryByText("Summary (1)")).not.toBeInTheDocument();
});

test("resource table respects summary row preference from saved view", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "amount", label: "Amount" },
      ]}
      items={[{ id: "1", amount: 10 }]}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "no-summary",
        views: [
          {
            id: "no-summary",
            label: "No summary",
            analytics: true,
            summary_row: false,
          },
        ],
      }}
    />
  );

  expect(screen.queryByText("Summary (1)")).not.toBeInTheDocument();
});

test("resource table does not render analytics header", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "amount", label: "Amount" },
      ]}
      items={[
        { id: "1", amount: 10 },
        { id: "2", amount: 15 },
      ]}
      idKey="id"
      datasetMetrics={{
        total: 4,
        columns: {
          amount: {
            count: 4,
            sum: 40,
            min: 5,
            max: 15,
            avg: 10,
          },
        },
      }}
    />
  );

  expect(screen.queryByText("Page share: 50%")).not.toBeInTheDocument();
});

test("resource table does not render selected metrics summary", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "amount", label: "Amount" },
      ]}
      items={[
        { id: "1", amount: 10 },
        { id: "2", amount: 15 },
      ]}
      idKey="id"
    />
  );

  fireEvent.click(screen.getByLabelText("Select row 1"));
  expect(screen.queryByText("Selected metrics")).not.toBeInTheDocument();
});

test("resource table does not render group metrics in analytics panel", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
        { key: "amount", label: "Amount" },
      ]}
      items={[
        { id: "1", status: "Ready", amount: 10 },
        { id: "2", status: "Ready", amount: 15 },
      ]}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "grouped",
        views: [
          {
            id: "grouped",
            label: "Grouped",
            group_by: "status",
          },
        ],
      }}
    />
  );

  expect(
    screen.queryByText("Group metrics reflect page rows.")
  ).not.toBeInTheDocument();
});

test("resource table exposes metrics export when analytics are enabled", async () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "amount", label: "Amount" },
      ]}
      items={[{ id: "1", amount: 10 }]}
      datasetMetrics={{
        total: 1,
        columns: {
          amount: {
            count: 1,
            sum: 10,
            min: 10,
            max: 10,
            avg: 10,
          },
        },
      }}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(await screen.findByRole("button", { name: "Export metrics" })).toBeEnabled();
});

test("resource table exposes excel export", async () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
      ]}
      items={[{ id: "1", name: "Alpha" }]}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(await screen.findByRole("button", { name: "Export Excel" })).toBeEnabled();
});

test("resource table tracks row selection", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" }
      ]}
      items={[
        { id: "1", name: "Alpha" },
        { id: "2", name: "Bravo" }
      ]}
      idKey="id"
    />
  );

  expect(screen.queryByText("Selected 0")).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Select row Alpha"));
  expect(screen.getByText("Selected 1")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Select all rows"));
  expect(screen.getByText("Selected 2")).toBeInTheDocument();
});

test("resource table supports range selection", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" }
      ]}
      items={[
        { id: "1", name: "Alpha" },
        { id: "2", name: "Bravo" },
        { id: "3", name: "Charlie" }
      ]}
      idKey="id"
      enableSelection
    />
  );

  fireEvent.click(screen.getByLabelText("Select row Alpha"));
  fireEvent.click(screen.getByLabelText("Select row Charlie"), { shiftKey: true });

  expect(screen.getByText("Selected 3")).toBeInTheDocument();
});

test("resource table navigates on row activation when baseHref is set", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
      ]}
      items={[{ id: "1", name: "Alpha" }]}
      idKey="id"
      baseHref="/console/resources/shipments"
    />
  );

  const row = screen.getByLabelText("Select row Alpha").closest("tr");
  expect(row).not.toBeNull();
  fireEvent.click(row!);
  expect(pushMock).toHaveBeenCalledWith(
    "/console/resources/shipments?id=1&detail_open=1"
  );
});

test("resource table supports keyboard activation for row navigation", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
      ]}
      items={[{ id: "1", name: "Alpha" }]}
      idKey="id"
      baseHref="/console/resources/shipments"
    />
  );

  const row = screen.getByLabelText("Select row Alpha").closest("tr");
  expect(row).not.toBeNull();
  fireEvent.keyDown(row!, { key: "Enter" });
  expect(pushMock).toHaveBeenCalledWith(
    "/console/resources/shipments?id=1&detail_open=1"
  );
});

test("resource table uses path detail navigation for mapped resources", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
      ]}
      items={[{ id: "wf-1", name: "Workflow 1" }]}
      idKey="id"
      baseHref="/portal/resources/workflow_runs"
      resourceKey="workflow_runs"
    />
  );

  const row = screen.getByLabelText("Select row Workflow 1").closest("tr");
  expect(row).not.toBeNull();
  fireEvent.click(row!);
  expect(pushMock).toHaveBeenCalledWith("/portal/resources/workflow_runs/wf-1");
});

test("resource table renders bulk actions when rows are selected", () => {
  const onSelectionChange = jest.fn();
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" }
      ]}
      items={[
        { id: "1", name: "Alpha" },
        { id: "2", name: "Bravo" }
      ]}
      idKey="id"
      baseHref="/portal/operations/exceptions/dispatch_exception_review"
      onSelectionChange={onSelectionChange}
      renderBulkActions={(selectedIds) => (
        <span>Bulk actions: {selectedIds.length}</span>
      )}
      testIdPrefix="ops"
    />
  );

  expect(screen.getByTestId("ops-table-root")).toHaveAttribute(
    "data-interaction-ready",
    "true"
  );
  const rowCheckbox = screen.getByLabelText("Select row Alpha");
  expect(rowCheckbox).toBeEnabled();
  const row = rowCheckbox.closest("tr");
  expect(row).not.toBeNull();

  fireEvent.click(rowCheckbox);
  expect(row).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("Bulk actions: 1")).toBeInTheDocument();
  expect(screen.getByTestId("ops-table-selection-bar")).toHaveClass(
    "pointer-events-none"
  );
  expect(screen.getByTestId("ops-table-selection-bar")).toHaveClass(
    "relative", "max-w-full"
  );
  expect(screen.getByTestId("ops-table-selection-bar")).not.toHaveClass("fixed");
  expect(screen.getByTestId("ops-table-selection-bar")).not.toHaveClass("z-50");
  fireEvent.click(screen.getByLabelText("Select row Bravo"));
  expect(screen.getByText("Bulk actions: 2")).toBeInTheDocument();
  expect(onSelectionChange).toHaveBeenCalled();
  expect(pushMock).not.toHaveBeenCalled();
});

test("resource table submits a new view request", async () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
      ]}
      items={[{ id: "1", status: "Ready" }]}
      viewState={{
        resourceKey: "shipments",
        scopeType: "tenant",
        scopeId: "tenant-1",
        scopeValue: "acme",
        canSave: true,
        settingsResolutionId: "res-123",
        activeFilters: { status: "Ready" },
        activeSort: { key: "id", direction: "asc" },
        pageSize: 50,
      }}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  fireEvent.change(screen.getByLabelText("Column width for ID"), {
    target: { value: "240" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /Status/ }));
  fireEvent.click(screen.getByRole("button", { name: "Group" }));
  fireEvent.change(screen.getByLabelText("Add group"), {
    target: { value: "status" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.click(screen.getByRole("button", { name: "Save new view" }));
  fireEvent.change(screen.getByLabelText("View name"), {
    target: { value: "Ops view" },
  });
  fireEvent.click(screen.getByLabelText("Set as default view"));
  fireEvent.click(screen.getByRole("button", { name: "Create view" }));

  await waitFor(() =>
    expect(requestSettingsChangeMock).toHaveBeenCalledTimes(1)
  );

  const payload = requestSettingsChangeMock.mock.calls[0][0];
  expect(payload).toMatchObject({
    category: "ui_table_views",
    scopeType: "tenant",
    scopeId: "tenant-1",
  });

  const views = payload.value?.resources?.shipments?.views || {};
  const viewValues = Object.values(views);
  expect(viewValues).toHaveLength(1);
  const savedView = viewValues[0] as Record<string, unknown>;
  expect(savedView.label).toBe("Ops view");
  expect(savedView.group_by).toEqual(["status"]);
  expect(savedView.page_size).toBe(50);
  expect(savedView.filters).toEqual({ status: "Ready" });
  expect(savedView.sort).toEqual({ key: "id", direction: "asc" });
  expect(savedView.pagination_mode).toBe("server");
  expect(savedView.search_debounce_ms).toBe(0);
  expect(savedView.columns).toMatchObject({
    hidden: ["status"],
  });
  const widths = (savedView.columns as Record<string, unknown>).widths as
    | Record<string, number>
    | undefined;
  expect(widths?.id).toBe(240);
  expect(payload.value?.resources?.shipments?.default_view_id).toBe(
    savedView.id ?? undefined
  );

  const events = reporter.mock.calls.map((call) => call[0]);
  const saveEvent = events.find(
    (event) => event.type === "ui.table.view.save"
  );
  expect(saveEvent).toEqual(
    expect.objectContaining({
      context: "shipments",
      name: "Ops view",
      digest: "res-123",
      meta: {
        settingsResolutionId: "res-123",
        scopeType: "tenant",
        scopeId: "tenant-1",
        scopeValue: "acme",
      },
    })
  );
});

test("resource table updates an existing view", async () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
      ]}
      items={[{ id: "1", status: "Ready" }]}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "view-1",
        views: [
          {
            id: "view-1",
            label: "Ops view",
            columns: { order: ["id", "status"], hidden: [] },
          },
        ],
        scopeType: "tenant",
        scopeId: "tenant-1",
        canSave: true,
      }}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.click(screen.getByRole("button", { name: "Update view" }));

  await waitFor(() =>
    expect(requestSettingsChangeMock).toHaveBeenCalledTimes(1)
  );

  const payload = requestSettingsChangeMock.mock.calls[0][0];
  expect(payload.changeReason).toBe("Update UI table view: Ops view");
  expect(payload.value?.resources?.shipments?.views?.["view-1"]).toBeTruthy();
});

test("resource table view menu seeds rename and duplicate flows", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
      ]}
      items={[{ id: "1", status: "Ready" }]}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "view-1",
        views: [
          {
            id: "view-1",
            label: "Ops view",
            columns: { order: ["id", "status"], hidden: [] },
          },
        ],
        scopeType: "tenant",
        scopeId: "tenant-1",
        canSave: true,
      }}
    />
  );

  await user.click(screen.getByRole("button", { name: "Open view actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Rename view" })
  );
  expect(screen.getByLabelText("View name")).toHaveValue("Ops view");

  await user.click(screen.getByRole("button", { name: "Open view actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Duplicate view" })
  );
  expect(screen.getByLabelText("View name")).toHaveValue("Copy of Ops view");
});

test("resource table view menu sets default view", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
      ]}
      items={[{ id: "1", status: "Ready" }]}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "view-1",
        views: [
          {
            id: "view-1",
            label: "Ops view",
            columns: { order: ["id", "status"], hidden: [] },
          },
        ],
        scopeType: "tenant",
        scopeId: "tenant-1",
        canSave: true,
      }}
    />
  );

  await user.click(screen.getByRole("button", { name: "Open view actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Set as default" })
  );

  await waitFor(() =>
    expect(requestSettingsChangeMock).toHaveBeenCalledTimes(1)
  );
  const payload = requestSettingsChangeMock.mock.calls[0][0];
  expect(payload.value?.resources?.shipments?.default_view_id).toBe("view-1");
});

test("resource table submits a delete view request", async () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "status", label: "Status" },
      ]}
      items={[{ id: "1", status: "Ready" }]}
      viewState={{
        resourceKey: "shipments",
        activeViewId: "view-1",
        views: [
          {
            id: "view-1",
            label: "Ops view",
            columns: { order: ["id", "status"], hidden: [] },
          },
          {
            id: "view-2",
            label: "Backup view",
            columns: { order: ["id", "status"], hidden: [] },
          },
        ],
        scopeType: "tenant",
        scopeId: "tenant-1",
        canSave: true,
        scopeValue: {
          resources: {
            shipments: {
              views: {
                "view-1": { id: "view-1", label: "Ops view" },
                "view-2": { id: "view-2", label: "Backup view" },
              },
              default_view_id: "view-1",
            },
          },
        },
      }}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

  await waitFor(() =>
    expect(requestSettingsChangeMock).toHaveBeenCalledTimes(1)
  );

  const payload = requestSettingsChangeMock.mock.calls[0][0];
  expect(payload.changeReason).toBe("Delete UI table view: Ops view");
  const views = payload.value?.resources?.shipments?.views || {};
  expect(views["view-1"]).toBeUndefined();
  expect(views["view-2"]).toBeTruthy();
  expect(payload.value?.resources?.shipments?.default_view_id).toBe("view-2");
});

test("resource table updates the URL when selecting a view", () => {
  renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
      ]}
      items={[{ id: "1", name: "Alpha" }]}
      baseHref="/resources/shipments"
      viewState={{
        resourceKey: "shipments",
        activeViewId: "view-1",
        views: [
          { id: "view-1", label: "Default" },
          { id: "view-2", label: "Ops" },
        ],
      }}
    />
  );

  fireEvent.click(screen.getByRole("tab", { name: "Ops" }));

  expect(replaceMock).toHaveBeenCalledTimes(1);
  const calledWith = replaceMock.mock.calls[0][0];
  const url = new URL(calledWith, "http://localhost");
  expect(url.pathname).toBe("/resources/shipments");
  expect(url.searchParams.get("view")).toBe("view-2");
  expect(url.searchParams.get("page")).toBe("1");
  expect(url.searchParams.get("offset")).toBe("0");
});

test("resource table shows view management disabled notice", () => {
  renderWithIntl(
    <ResourceTable
      columns={[{ key: "id", label: "ID" }]}
      items={[{ id: "1" }]}
      viewState={{
        resourceKey: "shipments",
        canSave: false,
      }}
    />
  );

  expect(
    screen.getByText("View management is disabled for your access scope.")
  ).toBeInTheDocument();
});

test("resource table does not show view scope summary in toolbar", () => {
  renderWithIntl(
    <ResourceTable
      columns={[{ key: "id", label: "ID" }]}
      items={[{ id: "1" }]}
      viewState={{
        resourceKey: "shipments",
        scopeType: "tenant",
        scopeId: "tenant-1234567890",
      }}
    />
  );

  expect(screen.queryByText("View scope")).not.toBeInTheDocument();
  expect(screen.queryByText("Tenant tena...7890")).not.toBeInTheDocument();
});

test("resource table does not show settings resolution in toolbar", () => {
  renderWithIntl(
    <ResourceTable
      columns={[{ key: "id", label: "ID" }]}
      items={[{ id: "1" }]}
      viewState={{
        resourceKey: "shipments",
        settingsResolutionId: "abcd1234efgh5678",
      }}
    />
  );

  expect(screen.queryByText("Settings resolution")).not.toBeInTheDocument();
  expect(screen.queryByText("abcd...5678")).not.toBeInTheDocument();
});
