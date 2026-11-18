import type { ReactElement } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { resolveColumns } from "../../packages/ui/src/resource-page-utils";
import { ResourcePage } from "../../packages/ui/src/resource-page";
import { createUiServerClient } from "@masarx/api/server";
import { renderWithIntl } from "./test-utils";

jest.mock("../../packages/ui/src/resource-table", () => ({
  ResourceTable: () => null,
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const originalReplaceState = window.history.replaceState;

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

test("resolveColumns uses registry labels when provided", () => {
  const resource = {
    key: "shipments",
    relation: "shipments",
    select: ["sender_id", "status"],
    column_labels: { sender_id: "Sender" },
  };
  const columns = resolveColumns(resource, { resource: "shipments", items: [] as Record<string, unknown>[], limit: 25, offset: 0 });
  const labels = columns.map((column) => column.label);
  expect(labels).toEqual(["Sender", "Status"]);
});

test("resolveColumns honors explicit column metadata", () => {
  const resource = {
    key: "shipments",
    relation: "shipments",
    column_labels: { status: "Status" },
    columns: [
      {
        key: "status",
        label: "State",
        render_type: "text",
        format_options: { uppercase: false },
        edit_mode: "inline",
        edit_type: "text",
        edit_allow_id: true,
        edit_permission: "shipments.write",
        edit_options: ["ready", "pending"],
        aggregation: { enabled: true, methods: ["count"] },
      },
    ],
  };

  const columns = resolveColumns(resource, {
    resource: "shipments",
    keys: ["status", "created_at"],
    items: [],
    limit: 25,
    offset: 0,
  });

  expect(columns).toEqual([
    {
      key: "status",
      label: "State",
      renderType: "text",
      formatOptions: { uppercase: false },
      editMode: "inline",
      editType: "text",
      editAllowId: true,
      editPermission: "shipments.write",
      editOptions: ["ready", "pending"],
      detailSection: null,
      aggregation: { enabled: true, methods: ["count"] },
    },
    {
      key: "created_at",
      label: "Created At",
    },
  ]);
});

test("resolveColumns can keep only configured columns when strict_columns is enabled", () => {
  const resource = {
    key: "customer_shipment_changes",
    relation: "support_cases",
    strict_columns: true,
    columns: [
      { key: "tracking_number", label: "Tracking number" },
      { key: "request_outcome", label: "Outcome" },
    ],
  };

  const columns = resolveColumns(resource, {
    resource: "customer_shipment_changes",
    keys: ["tracking_number", "request_outcome", "metadata", "organization_id"],
    items: [
      {
        tracking_number: "PT-TRACK-001",
        request_outcome: "pending_review",
        metadata: {},
        organization_id: "org-1",
      },
    ],
    limit: 25,
    offset: 0,
  });

  expect(columns).toEqual([
    { key: "tracking_number", label: "Tracking number", renderType: null, formatOptions: null, editMode: null, editType: null, editAllowId: null, editPermission: null, editOptions: null, detailSection: null, aggregation: null },
    { key: "request_outcome", label: "Outcome", renderType: null, formatOptions: null, editMode: null, editType: null, editAllowId: null, editPermission: null, editOptions: null, detailSection: null, aggregation: null },
  ]);
});

test("resolveColumns derives labels from list when select is missing", () => {
  const resource = {
    key: "shipments",
    relation: "shipments",
    column_labels: { tracking_number: "Tracking" },
  };
  const list = {
    resource: "shipments",
    items: [{ tracking_number: "ABC123", status: "ready" }],
    limit: 25,
    offset: 0,
  };

  const columns = resolveColumns(resource, list);
  expect(columns).toEqual([
    { key: "tracking_number", label: "Tracking" },
    { key: "status", label: "Status" },
  ]);
});

test("resolveColumns uses list keys even when list is empty", () => {
  const resource = {
    key: "shipments",
    relation: "shipments",
  };

  const columns = resolveColumns(resource, {
    resource: "shipments",
    keys: ["id", "status"],
    items: [],
    limit: 25,
    offset: 0,
  });

  expect(columns).toEqual([
    { key: "id", label: "ID", renderType: "id" },
    { key: "status", label: "Status" },
  ]);
});

test("resolveColumns adds keys from list items when list keys are partial", () => {
  const resource = {
    key: "shipments",
    relation: "shipments",
  };

  const columns = resolveColumns(resource, {
    resource: "shipments",
    keys: ["id"],
    items: [
      { id: "1" },
      { id: "2", status: "ready" },
    ],
    limit: 25,
    offset: 0,
  });

  expect(columns).toEqual([
    { key: "id", label: "ID", renderType: "id" },
    { key: "status", label: "Status" },
  ]);
});

test("resolveColumns infers id render type for *_id keys when metadata is missing", () => {
  const resource = {
    key: "shipments",
    relation: "shipments",
  };
  const list = {
    resource: "shipments",
    keys: ["sender_id", "status"],
    items: [{ sender_id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c", status: "ready" }],
    limit: 25,
    offset: 0,
  };
  const columns = resolveColumns(resource, list);
  expect(columns).toEqual([
    { key: "sender_id", label: "Sender ID", renderType: "id" },
    { key: "status", label: "Status" },
  ]);
});

test("resource page does not show pagination settings resolution (cleaned for minimal UI)", async () => {
  const mockedCreateUiServerClient = createUiServerClient as jest.Mock;
  mockedCreateUiServerClient.mockReturnValue({
    readRegistry: jest.fn().mockResolvedValue({
      resources: [{ key: "shipments", relation: "shipments" }],
    }),
    me: jest.fn().mockResolvedValue({
      capabilities: [],
      access_scope: { scope_type: "tenant", scope_id: "tenant-1" },
    }),
    settingsPreview: jest.fn().mockResolvedValue({
      category: "ui_pagination",
      settings_resolution_id: "resolution-12345678",
      value: { allowed_sizes: [25], max_page_size: 25 },
    }),
    tableViews: jest.fn().mockResolvedValue({
      resource: "shipments",
      views: {},
      default_view_id: null,
      scope_type: "tenant",
      scope_id: "tenant-1",
      settings_resolution_id: "views-resolution",
      scope_value: null,
    }),
    listResource: jest.fn().mockResolvedValue({
      resource: "shipments",
      items: [{ id: "1" }],
      limit: 25,
      offset: 0,
      total: 1,
    }),
    commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
    getResource: jest.fn().mockResolvedValue(null),
  });

  const result = await ResourcePage({
    appKey: "console",
    resourceKey: "shipments",
    searchParams: {},
    appBasePath: "/console",
    description: "Shipments",
    testIdPrefix: "console-shipments",
  });

  renderWithIntl(result as ReactElement);

  expect(
    screen.queryByText("Pagination settings resolution:")
  ).not.toBeInTheDocument();
  expect(screen.queryByText("reso...5678")).not.toBeInTheDocument();
});

test("resource page back-to-list preserves query params (full detail layout)", async () => {
  const mockedCreateUiServerClient = createUiServerClient as jest.Mock;
  mockedCreateUiServerClient.mockReturnValue({
    readRegistry: jest.fn().mockResolvedValue({
      resources: [{ key: "shipments", relation: "shipments" }],
    }),
    me: jest.fn().mockResolvedValue({
      capabilities: [],
      access_scope: { scope_type: "tenant", scope_id: "tenant-1" },
    }),
    settingsPreview: jest.fn().mockResolvedValue({
      category: "ui_pagination",
      settings_resolution_id: "resolution-12345678",
      value: { allowed_sizes: [25], max_page_size: 25 },
    }),
    tableViews: jest.fn().mockResolvedValue({
      resource: "shipments",
      views: {},
      default_view_id: null,
      scope_type: "tenant",
      scope_id: "tenant-1",
      settings_resolution_id: "views-resolution",
      scope_value: null,
    }),
    listResource: jest.fn().mockResolvedValue({
      resource: "shipments",
      items: [{ id: "1" }],
      limit: 25,
      offset: 0,
      total: 1,
    }),
    commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
    getResource: jest.fn().mockResolvedValue(null),
  });

  const result = await ResourcePage({
    appKey: "console",
    resourceKey: "shipments",
    searchParams: { id: "1", foo: "bar", detail_layout: "full" },
    appBasePath: "/console",
    description: "Shipments",
    testIdPrefix: "console-shipments",
  });

  const replaceState = jest.fn();
  window.history.replaceState = replaceState;

  renderWithIntl(result as ReactElement);

  // "Open side peek" is now a client-side button (layout toggle) — verify before back-to-list hides the panel
  expect(screen.getByRole("button", { name: "Open side peek" })).toBeInTheDocument();

  // "Back to list" is now a client-side button that calls history.replaceState
  const backToList = screen.getByRole("button", { name: /Back to list/i });
  fireEvent.click(backToList);
  expect(replaceState).toHaveBeenCalledWith(
    null,
    "",
    "/console/resources/shipments?foo=bar"
  );

  window.history.replaceState = originalReplaceState;
});

test("resource page open-full button toggles layout to full", async () => {
  const mockedCreateUiServerClient = createUiServerClient as jest.Mock;
  mockedCreateUiServerClient.mockReturnValue({
    readRegistry: jest.fn().mockResolvedValue({
      resources: [{ key: "shipments", relation: "shipments" }],
    }),
    me: jest.fn().mockResolvedValue({
      capabilities: [],
      access_scope: { scope_type: "tenant", scope_id: "tenant-1" },
    }),
    settingsPreview: jest.fn().mockResolvedValue({
      category: "ui_pagination",
      settings_resolution_id: "resolution-12345678",
      value: { allowed_sizes: [25], max_page_size: 25 },
    }),
    tableViews: jest.fn().mockResolvedValue({
      resource: "shipments",
      views: {},
      default_view_id: null,
      scope_type: "tenant",
      scope_id: "tenant-1",
      settings_resolution_id: "views-resolution",
      scope_value: null,
    }),
    listResource: jest.fn().mockResolvedValue({
      resource: "shipments",
      items: [{ id: "1" }],
      limit: 25,
      offset: 0,
      total: 1,
    }),
    commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
    getResource: jest.fn().mockResolvedValue(null),
  });

  const result = await ResourcePage({
    appKey: "console",
    resourceKey: "shipments",
    searchParams: { id: "1", foo: "bar", detail_open: "1" },
    appBasePath: "/console",
    description: "Shipments",
    testIdPrefix: "console-shipments",
  });

  // Set up URL so syncUrl can read current params
  window.history.pushState({}, "", "/console/resources/shipments?id=1&foo=bar&detail_open=1");
  const replaceState = jest.fn();
  window.history.replaceState = replaceState;

  renderWithIntl(result as ReactElement);

  // "Open full page" is now a client-side button (layout toggle)
  const openFull = screen.getByRole("button", { name: "Open full page" });
  fireEvent.click(openFull);

  expect(replaceState).toHaveBeenCalled();
  const calledUrl = replaceState.mock.calls[0][2] as string;
  const fullUrl = new URL(calledUrl, "https://example.com");
  expect(fullUrl.searchParams.get("id")).toBe("1");
  expect(fullUrl.searchParams.get("foo")).toBe("bar");
  expect(fullUrl.searchParams.get("detail_layout")).toBe("full");

  window.history.replaceState = originalReplaceState;
});

test("resource page shows configured, available, and blocked action counts", async () => {
  const mockedCreateUiServerClient = createUiServerClient as jest.Mock;
  mockedCreateUiServerClient.mockReturnValue({
    readRegistry: jest.fn().mockResolvedValue({
      resources: [
        {
          key: "shipments",
          relation: "shipments",
          download: { capability: "labels.download" },
        },
      ],
    }),
    me: jest.fn().mockResolvedValue({
      capabilities: ["labels.download"],
      access_scope: { scope_type: "tenant", scope_id: "tenant-1" },
    }),
    settingsPreview: jest.fn().mockResolvedValue({
      category: "ui_pagination",
      settings_resolution_id: "resolution-12345678",
      value: { allowed_sizes: [25], max_page_size: 25 },
    }),
    tableViews: jest.fn().mockResolvedValue({
      resource: "shipments",
      views: {},
      default_view_id: null,
      scope_type: "tenant",
      scope_id: "tenant-1",
      settings_resolution_id: "views-resolution",
      scope_value: null,
    }),
    listResource: jest.fn().mockResolvedValue({
      resource: "shipments",
      items: [{ id: "1" }],
      limit: 25,
      offset: 0,
      total: 1,
    }),
    commandRegistry: jest.fn().mockResolvedValue({
      commands: [
        {
          key: "shipments.print_labels",
          label: "Print labels",
          capability: "labels.download",
          schema_category: "resource:shipments",
          execution: { type: "workflow", rpc: "ui_execute_command_v1" },
        },
        {
          key: "shipments.delete",
          label: "Delete shipments",
          capability: "shipments.write",
          schema_category: "resource:shipments",
          execution: {
            type: "rpc",
            rpc: "ui_execute_shipment_batch_operation_v1",
            params: {
              operation: "cancel",
            },
          },
        },
        {
          key: "shipments.reschedule",
          label: "Reschedule shipments",
          capability: "shipments.write",
          schema_category: "resource:shipments",
          execution: {
            type: "rpc",
            rpc: "ui_execute_shipment_batch_operation_v1",
            params: {
              operation: "reschedule",
            },
            input_schema: {
              version: 1,
              fields: [
                {
                  key: "slot_date",
                  label: "Promised delivery date",
                  type: "text",
                  required: true,
                },
              ],
            },
          },
        },
      ],
    }),
    getResource: jest.fn().mockResolvedValue(null),
  });

  const result = await ResourcePage({
    appKey: "console",
    resourceKey: "shipments",
    searchParams: {},
    appBasePath: "/console",
    description: "Shipments",
    testIdPrefix: "console-shipments",
  });

  renderWithIntl(result as ReactElement);

  expect(screen.getByTestId("console-shipments-actions-configured")).toHaveTextContent("4 configured");
  expect(screen.getByTestId("console-shipments-actions-available")).toHaveTextContent("2 available");
  expect(screen.getByTestId("console-shipments-actions-blocked")).toHaveTextContent("2 blocked");
});

test("resource page hides header actions when header capability is missing", async () => {
  const mockedCreateUiServerClient = createUiServerClient as jest.Mock;
  mockedCreateUiServerClient.mockReturnValue({
    readRegistry: jest.fn().mockResolvedValue({
      resources: [{ key: "integration_plugins", relation: "integration_plugins" }],
    }),
    me: jest.fn().mockResolvedValue({
      capabilities: ["integration_plugins.read"],
      access_scope: { scope_type: "tenant", scope_id: "tenant-1" },
    }),
    settingsPreview: jest.fn().mockResolvedValue({
      category: "ui_pagination",
      value: { allowed_sizes: [25], max_page_size: 25 },
    }),
    tableViews: jest.fn().mockResolvedValue({
      resource: "integration_plugins",
      views: {},
      default_view_id: null,
      scope_type: "tenant",
      scope_id: "tenant-1",
    }),
    listResource: jest.fn().mockResolvedValue({
      resource: "integration_plugins",
      items: [{ id: "1", name: "Draft plugin" }],
      limit: 25,
      offset: 0,
      total: 1,
    }),
    commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
    getResource: jest.fn().mockResolvedValue(null),
  });

  const result = await ResourcePage({
    appKey: "console",
    resourceKey: "integration_plugins",
    searchParams: {},
    appBasePath: "/console",
    description: "Integration plugins",
    testIdPrefix: "console-integration-plugins",
    headerActionsCapability: "integration_plugins.write",
    headerActions: "New Plugin",
  });

  renderWithIntl(result as ReactElement);

  expect(screen.queryByText("New Plugin")).not.toBeInTheDocument();
});

test("resource page renders a missing-record message when detail resolves null", async () => {
  const mockedCreateUiServerClient = createUiServerClient as jest.Mock;
  mockedCreateUiServerClient.mockReturnValue({
    readRegistry: jest.fn().mockResolvedValue({
      resources: [{ key: "integration_plugins", relation: "integration_plugins" }],
    }),
    me: jest.fn().mockResolvedValue({
      capabilities: ["integration_plugins.read"],
      access_scope: { scope_type: "tenant", scope_id: "tenant-1" },
    }),
    settingsPreview: jest.fn().mockResolvedValue({
      category: "ui_pagination",
      value: { allowed_sizes: [25], max_page_size: 25 },
    }),
    tableViews: jest.fn().mockResolvedValue({
      resource: "integration_plugins",
      views: {},
      default_view_id: null,
      scope_type: "tenant",
      scope_id: "tenant-1",
    }),
    listResource: jest.fn().mockResolvedValue({
      resource: "integration_plugins",
      items: [{ id: "1", name: "Draft plugin" }],
      limit: 25,
      offset: 0,
      total: 1,
    }),
    commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
    getResource: jest.fn().mockResolvedValue(null),
  });

  const result = await ResourcePage({
    appKey: "console",
    resourceKey: "integration_plugins",
    searchParams: { id: "missing-id", detail_open: "1" },
    appBasePath: "/console",
    description: "Integration plugins",
    testIdPrefix: "console-integration-plugins",
  });

  renderWithIntl(result as ReactElement);

  expect(screen.getByText("Record not found.")).toBeInTheDocument();
});
