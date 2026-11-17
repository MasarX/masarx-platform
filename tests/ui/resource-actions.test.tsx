import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UiCommandDefinition } from "@masarx/api";
import {
  BulkActions,
  type BulkActionDefinition,
} from "../../packages/ui/src/bulk-actions";
import { setUiReporter } from "../../packages/ui/src/reporting";
import {
  matchesResourceCategory,
  resolveResourceBulkActions,
  resolveResourceCommandCategory,
} from "../../packages/ui/src/resource-actions-core";
import { createUiTranslator } from "../../packages/ui/src/i18n";
import { renderWithIntl } from "./test-utils";

const rpcMock = jest.fn();
const getResourceMock = jest.fn();
const getWorkflowRunOutputStatusMock = jest.fn();
const progressWorkflowRunUntilWaitMock = jest.fn();
const requestUiWorkflowRunOutputDownloadMock = jest.fn();
const getSessionMock = jest.fn();
const navigateToMock = jest.fn();

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: () => ({
    rpc: rpcMock,
    getResource: getResourceMock,
    getWorkflowRunOutputStatus: getWorkflowRunOutputStatusMock,
    progressWorkflowRunUntilWait: progressWorkflowRunUntilWaitMock,
  }),
  requestUiWorkflowRunOutputDownload: (...args: unknown[]) =>
    requestUiWorkflowRunOutputDownloadMock(...args),
}));

jest.mock("@masarx/auth/browser", () => ({
  createBrowserClient: () => ({
    auth: {
      getSession: () => getSessionMock(),
    },
  }),
}));

jest.mock("../../packages/ui/src/navigate", () => ({
  navigateTo: (href: string) => navigateToMock(href),
}));

beforeEach(() => {
  rpcMock.mockReset();
  getResourceMock.mockReset();
  getWorkflowRunOutputStatusMock.mockReset();
  progressWorkflowRunUntilWaitMock.mockReset();
  requestUiWorkflowRunOutputDownloadMock.mockReset();
  getSessionMock.mockReset();
  navigateToMock.mockReset();
  getSessionMock.mockResolvedValue({
    data: { session: { access_token: "token-123" } },
    error: null,
  });
  setUiReporter(jest.fn());
});

afterEach(() => {
  setUiReporter(null);
  jest.restoreAllMocks();
});

const submitBulkActionConfirm = async (
  user: ReturnType<typeof userEvent.setup>
) => {
  await user.click(await screen.findByRole("button", { name: "Confirm" }));
};

const buildPrintActionParams = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  auto_download: true,
  output_url_paths: ["context.generated_labels[0].download_url"],
  poll_schedule_ms: [1],
  poll_interval_ms: 100,
  poll_timeout_ms: 10,
  poll_progress_enabled: true,
  poll_progress_budget_ms: 250,
  poll_progress_max_steps: 3,
  target_download_ms: 100,
  fallback_mode: "none",
  ...overrides,
});

const actions: BulkActionDefinition[] = [
  {
    key: "settings.request",
    label: "Request settings change",
    href: "/console/settings/request",
    execution: { type: "navigate" },
  },
];

test("bulk actions disable buttons with no selection", () => {
  renderWithIntl(<BulkActions actions={actions} selectedIds={[]} />);

  const button = screen.getByRole("button", {
    name: "Request settings change",
  });
  expect(button).toBeDisabled();
});

test("bulk actions enable buttons when selection exists", () => {
  renderWithIntl(<BulkActions actions={actions} selectedIds={["1"]} />);

  const button = screen.getByRole("button", {
    name: "Request settings change",
  });
  expect(button).not.toBeDisabled();
});

test("bulk actions expose overflow actions with stable action keys", async () => {
  const user = userEvent.setup();
  const overflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.print_labels",
      label: "Print labels",
      execution: { type: "workflow", rpc: "ui_execute_command_v1" },
    },
    {
      key: "shipments.delete",
      label: "Delete shipments",
      execution: { type: "rpc", rpc: "ui_execute_command_v1" },
    },
    {
      key: "shipments.reschedule",
      label: "Reschedule shipments",
      execution: { type: "rpc", rpc: "ui_execute_command_v1" },
    },
    {
      key: "shipments.requeue_geocode",
      label: "Requeue geocode",
      execution: { type: "rpc", rpc: "ui_execute_command_v1" },
    },
    {
      key: "shipments.edit",
      label: "Edit shipment",
      href: "/console/resources/shipments?id=1",
      execution: { type: "navigate" },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={overflowActions}
      selectedIds={["1"]}
      testIdPrefix="ops"
    />
  );

  await user.click(screen.getByTestId("ops-bulk-actions-menu"));
  expect(
    await screen.findByTestId("ops-bulk-actions-menu-action-shipments.edit")
  ).toHaveAttribute("data-action-key", "shipments.edit");
});

test("bulk actions report structured telemetry", async () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  rpcMock.mockResolvedValue({});
  const user = userEvent.setup();
  const telemetry = {
    settingsResolutionId: "res-123",
    scopeType: "tenant",
    scopeId: "tenant-1",
    scopeValue: "acme",
  };
  const trackedActions: BulkActionDefinition[] = [
    {
      key: "shipments.delete",
      label: "Delete shipments",
      resourceKey: "shipments",
      execution: {
        type: "rpc",
        rpc: "ui_execute_shipment_batch_operation_v1",
        params: {
          operation: "cancel",
        },
      },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={trackedActions}
      selectedIds={["shp-1"]}
      telemetry={telemetry}
    />
  );

  await user.click(
    screen.getByRole("button", { name: "Delete shipments" })
  );
  await submitBulkActionConfirm(user);
  await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));

  const events = reporter.mock.calls.map((call) => call[0]);
  const executeEvent = events.find(
    (event) => event.type === "ui.bulk_action.execute"
  );
  expect(executeEvent).toEqual(
    expect.objectContaining({
      context: "shipments",
      name: "shipments.delete",
      message: "Delete shipments",
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

test("bulk actions require confirmation for mutation actions without explicit confirm config", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({});
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "shipments.delete",
      label: "Delete shipment",
      resourceKey: "shipments",
      execution: {
        type: "rpc",
        rpc: "ui_execute_shipment_batch_operation_v1",
        params: {
          operation: "cancel",
        },
      },
      selection: { mode: "any" },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Delete shipment" }));

  await waitFor(() =>
    expect(
      screen.getByTestId("test-bulk-actions-confirm-dialog")
    ).toBeInTheDocument()
  );

  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_shipment_batch_operation_v1",
    expect.objectContaining({
      p_action_key: "shipments.delete",
      p_resource_key: "shipments",
      p_selection_ids: ["1"],
      p_selection_count: 1,
      p_params: {
        operation: "cancel",
      },
    })
  );
});

test("bulk actions call the dedicated device governance RPC with the standard payload contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({ status: "revoked", count: 1, items: [] });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "user_devices.revoke",
      label: "Revoke device",
      resourceKey: "user_devices",
      execution: {
        type: "rpc",
        rpc: "ui_execute_user_device_revoke_v1",
        params: {
          revoked_reason: "revoked by console or portal operator",
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["device-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Revoke device" }));
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_user_device_revoke_v1",
    expect.objectContaining({
      p_action_key: "user_devices.revoke",
      p_resource_key: "user_devices",
      p_selection_ids: ["device-1"],
      p_selection_id: "device-1",
      p_selection_count: 1,
      p_params: {
        revoked_reason: "revoked by console or portal operator",
      },
    })
  );
});

test("bulk actions call the dedicated route-plan solve RPC with the standard payload contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({ status: "solved", count: 1, items: [] });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "route_plans.solve_sequence",
      label: "Optimize sequence",
      resourceKey: "route_plans",
      execution: {
        type: "rpc",
        rpc: "ui_execute_route_plan_solve_v1",
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["route-plan-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Optimize sequence" }));
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_route_plan_solve_v1",
    expect.objectContaining({
      p_action_key: "route_plans.solve_sequence",
      p_resource_key: "route_plans",
      p_selection_ids: ["route-plan-1"],
      p_selection_id: "route-plan-1",
      p_selection_count: 1,
      p_params: null,
    })
  );
});

test("bulk actions call the dedicated shipment resort RPC with the standard payload contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({
    status: "resorted",
    workflow_run_id: "workflow-run-shipment-resort-1",
    items: [],
  });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "shipments.resort",
      label: "Re-sort shipment",
      resourceKey: "shipments",
      execution: {
        type: "rpc",
        rpc: "ui_execute_shipment_resort_v1",
        params: {
          workflow_template_name: "shipment_resort_v1",
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["shipment-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Re-sort shipment" }));
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_shipment_resort_v1",
    expect.objectContaining({
      p_action_key: "shipments.resort",
      p_resource_key: "shipments",
      p_selection_ids: ["shipment-1"],
      p_selection_id: "shipment-1",
      p_selection_count: 1,
      p_params: {
        workflow_template_name: "shipment_resort_v1",
      },
    })
  );
});

test("bulk actions call the dedicated shipment update geocode RPC with the standard payload contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({
    status: "completed",
    workflow_run_id: "workflow-run-shipment-geocode-1",
    items: [],
  });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "shipments.update_geocode",
      label: "Requeue geocode",
      resourceKey: "shipments",
      execution: {
        type: "rpc",
        rpc: "ui_execute_shipment_update_geocode_v1",
        params: {
          workflow_template_name: "shipment_update_geocode_v1",
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["shipment-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Requeue geocode" }));
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_shipment_update_geocode_v1",
    expect.objectContaining({
      p_action_key: "shipments.update_geocode",
      p_resource_key: "shipments",
      p_selection_ids: ["shipment-1"],
      p_selection_id: "shipment-1",
      p_selection_count: 1,
      p_params: {
        workflow_template_name: "shipment_update_geocode_v1",
      },
    })
  );
});

test("bulk actions collect slot date input for the dedicated shipment batch reschedule RPC", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({
    status: "rescheduled",
    items: [],
  });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "shipments.reschedule",
      label: "Reschedule shipments",
      resourceKey: "shipments",
      execution: {
        type: "rpc",
        rpc: "ui_execute_shipment_batch_operation_v1",
        params: {
          operation: "reschedule",
        },
        input_schema: {
          version: 1,
          title: "Reschedule shipments",
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
      selection: { mode: "any", min_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["shipment-1", "shipment-2"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Reschedule shipments" }));
  await user.type(screen.getByLabelText("Promised delivery date"), "2026-04-10");
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_shipment_batch_operation_v1",
    expect.objectContaining({
      p_action_key: "shipments.reschedule",
      p_resource_key: "shipments",
      p_selection_ids: ["shipment-1", "shipment-2"],
      p_selection_id: null,
      p_selection_count: 2,
      p_params: {
        operation: "reschedule",
        slot_date: "2026-04-10",
      },
    })
  );
});

test("bulk actions render lookup confirm fields, validate required input, and submit the selected value", async () => {
  const user = userEvent.setup();
  rpcMock.mockImplementation(async (rpcName: string, args?: Record<string, unknown>) => {
    if (rpcName === "list_lookup_values_v1") {
      expect(args).toEqual({ p_category: "ndr_action" });
      return [
        { value: "reattempt", label: "Reattempt" },
        { value: "hold_at_branch", label: "Hold at branch" },
      ];
    }
    if (rpcName === "ui_execute_dispatch_exception_resolution_v1") {
      return { status: "completed", items: [] };
    }
    throw new Error(`Unexpected RPC ${rpcName}`);
  });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "dispatch_exception_review.resolve",
      label: "Resolve exception",
      resourceKey: "dispatch_exception_review",
      execution: {
        type: "rpc",
        rpc: "ui_execute_dispatch_exception_resolution_v1",
        input_schema: {
          version: 1,
          fields: [
            {
              key: "ndr_action",
              label: "Resolution action",
              type: "lookup",
              lookup_category: "ndr_action",
              required: true,
            },
          ],
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["task-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Resolve exception" }));

  const combobox = await screen.findByRole("combobox", {
    name: "Resolution action",
  });
  await waitFor(() =>
    expect(
      within(combobox).getByRole("option", { name: "Reattempt" })
    ).toBeInTheDocument()
  );
  expect(
    within(combobox).getByRole("option", { name: "Hold at branch" })
  ).toBeInTheDocument();

  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Resolution action is required."
  );

  await user.selectOptions(combobox, "reattempt");
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  await waitFor(() =>
    expect(rpcMock).toHaveBeenCalledWith(
      "ui_execute_dispatch_exception_resolution_v1",
      expect.objectContaining({
        p_action_key: "dispatch_exception_review.resolve",
        p_resource_key: "dispatch_exception_review",
        p_selection_ids: ["task-1"],
        p_selection_id: "task-1",
        p_selection_count: 1,
        p_params: {
          ndr_action: "reattempt",
        },
      })
    )
  );
});

test("bulk actions collect route closeout inputs for the shared ui_execute_command_v1 contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({ status: "route_closed_out", count: 1, items: [] });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "tasks.close_route",
      label: "Close route",
      resourceKey: "tasks",
      execution: {
        type: "rpc",
        rpc: "ui_execute_command_v1",
        payload_key: "payload",
        params: {
          handler: "route_closeout",
          route_closeout: {
            confirmation_token: "confirmed",
          },
        },
        input_schema: {
          version: 1,
          fields: [
            {
              key: "vehicle_secured_ack",
              label: "Vehicle secured",
              type: "text",
              required: true,
              default_value: "confirmed",
            },
            {
              key: "proofs_synced_ack",
              label: "Proofs synced",
              type: "text",
              required: true,
              default_value: "confirmed",
            },
            {
              key: "exceptions_reviewed_ack",
              label: "Exceptions reviewed",
              type: "text",
              required: true,
              default_value: "confirmed",
            },
            {
              key: "leftover_stop_count",
              label: "Leftover stop count",
              type: "number",
              required: true,
            },
            {
              key: "leftover_notes",
              label: "Leftover notes",
              type: "textarea",
              required: false,
            },
            {
              key: "closeout_notes",
              label: "Closeout notes",
              type: "textarea",
              required: true,
            },
          ],
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["task-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Close route" }));
  await user.clear(screen.getByLabelText("Leftover stop count"));
  await user.type(screen.getByLabelText("Leftover stop count"), "1");
  await user.type(
    screen.getByLabelText("Leftover notes"),
    "One stop returned to branch cage"
  );
  await user.type(
    screen.getByLabelText("Closeout notes"),
    "Driver returned to branch after reviewing unresolved exceptions."
  );
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_command_v1",
    expect.objectContaining({
      p_action_key: "tasks.close_route",
      p_resource_key: "tasks",
      p_selection_ids: ["task-1"],
      p_selection_id: "task-1",
      p_selection_count: 1,
      p_params: {
        handler: "route_closeout",
        route_closeout: {
          confirmation_token: "confirmed",
        },
        payload: {
          vehicle_secured_ack: "confirmed",
          proofs_synced_ack: "confirmed",
          exceptions_reviewed_ack: "confirmed",
          leftover_stop_count: "1",
          leftover_notes: "One stop returned to branch cage",
          closeout_notes:
            "Driver returned to branch after reviewing unresolved exceptions.",
        },
      },
    })
  );
});

test("bulk actions call the dedicated warehouse transfer dispatch workflow RPC with the standard payload contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({
    status: "workflow_started",
    workflow_run_id: "workflow-run-transfer-1",
  });
  const workflowActions: BulkActionDefinition[] = [
    {
      key: "warehouse_transfers.dispatch",
      label: "Dispatch transfer",
      resourceKey: "warehouse_transfers",
      execution: {
        type: "workflow",
        rpc: "ui_execute_warehouse_transfer_dispatch_v1",
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["transfer-1"]}
      appBasePath="/portal"
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Dispatch transfer" }));
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_warehouse_transfer_dispatch_v1",
    expect.objectContaining({
      p_action_key: "warehouse_transfers.dispatch",
      p_resource_key: "warehouse_transfers",
      p_selection_ids: ["transfer-1"],
      p_selection_id: "transfer-1",
      p_selection_count: 1,
      p_params: null,
    })
  );
  await waitFor(() =>
    expect(navigateToMock).toHaveBeenCalledWith(
      "/portal/workflows/runs/workflow-run-transfer-1"
    )
  );
});

test("bulk actions call the dedicated route assignment RPC with the standard payload contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({ status: "assigned", count: 1, items: [] });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "routes.assign",
      label: "Assign route",
      resourceKey: "routes",
      execution: {
        type: "rpc",
        rpc: "ui_execute_route_run_assign_v1",
        params: {
          driver_user_id: "driver-1",
          vehicle_id: "vehicle-1",
          notes: "dispatch assignment",
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["route-run-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Assign route" }));
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_route_run_assign_v1",
    expect.objectContaining({
      p_action_key: "routes.assign",
      p_resource_key: "routes",
      p_selection_ids: ["route-run-1"],
      p_selection_id: "route-run-1",
      p_selection_count: 1,
      p_params: {
        driver_user_id: "driver-1",
        vehicle_id: "vehicle-1",
        notes: "dispatch assignment",
      },
    })
  );
});

test("bulk actions call the dedicated route-stop reassignment RPC with the standard payload contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({ status: "assigned", count: 1, items: [] });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "route_stops.reassign",
      label: "Reassign selected stops",
      resourceKey: "route_stops",
      execution: {
        type: "rpc",
        rpc: "ui_execute_route_stop_reassign_v1",
        params: {
          driver_user_id: "driver-2",
          vehicle_id: "vehicle-2",
          reassignment_reason: "Capacity rebalance",
        },
      },
      selection: { mode: "any", min_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["route-stop-1", "route-stop-2"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Reassign selected stops" }));
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_route_stop_reassign_v1",
    expect.objectContaining({
      p_action_key: "route_stops.reassign",
      p_resource_key: "route_stops",
      p_selection_ids: ["route-stop-1", "route-stop-2"],
      p_selection_id: null,
      p_selection_count: 2,
      p_params: {
        driver_user_id: "driver-2",
        vehicle_id: "vehicle-2",
        reassignment_reason: "Capacity rebalance",
      },
    })
  );
});

test("bulk actions collect alternate-capacity fields for the route reassignment RPC", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({ status: "assigned", count: 1, items: [] });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "routes.reassign",
      label: "Reassign route",
      resourceKey: "routes",
      execution: {
        type: "rpc",
        rpc: "ui_execute_route_run_assign_v1",
        input_schema: {
          version: 1,
          fields: [
            {
              key: "assignment_mode",
              label: "Assignment mode",
              type: "text",
              required: true,
              default_value: "internal_driver",
              placeholder: "internal_driver | partner_fleet | alternate_capacity_pool",
            },
            {
              key: "partner_name",
              label: "Partner name",
              type: "text",
              required: false,
            },
            {
              key: "reassignment_reason",
              label: "Reassignment reason",
              type: "textarea",
              required: true,
            },
            {
              key: "notes",
              label: "Assignment notes",
              type: "textarea",
              required: false,
            },
          ],
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["route-run-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Reassign route" }));
  expect(screen.getByLabelText("Assignment mode")).toHaveValue("internal_driver");
  await user.clear(screen.getByLabelText("Assignment mode"));
  await user.type(
    screen.getByLabelText("Assignment mode"),
    "alternate_capacity_pool"
  );
  await user.type(screen.getByLabelText("Partner name"), "Rush overflow pool");
  await user.type(
    screen.getByLabelText("Reassignment reason"),
    "Breakdown cover for express route"
  );
  await user.type(
    screen.getByLabelText("Assignment notes"),
    "Use the standby marketplace pool for overflow."
  );
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_route_run_assign_v1",
    expect.objectContaining({
      p_action_key: "routes.reassign",
      p_resource_key: "routes",
      p_selection_ids: ["route-run-1"],
      p_selection_id: "route-run-1",
      p_selection_count: 1,
      p_params: {
        assignment_mode: "alternate_capacity_pool",
        partner_name: "Rush overflow pool",
        reassignment_reason: "Breakdown cover for express route",
        notes: "Use the standby marketplace pool for overflow.",
      },
    })
  );
});

test("bulk actions call the dedicated route-plan publish RPC with the standard payload contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({ status: "published", count: 1, items: [] });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "route_plans.publish",
      label: "Publish execution pack",
      resourceKey: "route_plans",
      execution: {
        type: "rpc",
        rpc: "ui_execute_route_plan_publish_v1",
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["route-plan-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Publish execution pack" }));
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_route_plan_publish_v1",
    expect.objectContaining({
      p_action_key: "route_plans.publish",
      p_resource_key: "route_plans",
      p_selection_ids: ["route-plan-1"],
      p_selection_id: "route-plan-1",
      p_selection_count: 1,
      p_params: null,
    })
  );
});

test("bulk actions call the dedicated route-plan rebalance RPC with the standard payload contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({ status: "rebalanced", count: 1, items: [] });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "route_plans.rebalance",
      label: "Rebalance route plan",
      resourceKey: "route_plans",
      execution: {
        type: "rpc",
        rpc: "ui_execute_route_plan_rebalance_v1",
        params: {
          target_branch_id: "branch-2",
          shipment_ids: ["shipment-1", "shipment-2"],
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["route-plan-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Rebalance route plan" }));
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_route_plan_rebalance_v1",
    expect.objectContaining({
      p_action_key: "route_plans.rebalance",
      p_resource_key: "route_plans",
      p_selection_ids: ["route-plan-1"],
      p_selection_id: "route-plan-1",
      p_selection_count: 1,
      p_params: {
        target_branch_id: "branch-2",
        shipment_ids: ["shipment-1", "shipment-2"],
      },
    })
  );
});

test("bulk actions collect checkpoint inputs for the warehouse transfer departure RPC", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({
    status: "task_completed",
    workflow_run_id: "workflow-run-transfer-departure-1",
  });
  const workflowActions: BulkActionDefinition[] = [
    {
      key: "warehouse_transfers.scan_departure",
      label: "Scan departure",
      resourceKey: "warehouse_transfers",
      execution: {
        type: "workflow",
        rpc: "ui_execute_warehouse_transfer_checkpoint_v1",
        input_schema: {
          version: 1,
          fields: [
            {
              key: "barcode",
              label: "Scan barcode",
              type: "text",
              required: true,
            },
            {
              key: "handling_unit_code",
              label: "Handling unit code",
              type: "text",
              required: false,
            },
            {
              key: "notes",
              label: "Notes",
              type: "textarea",
              required: false,
            },
          ],
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["transfer-1"]}
      appBasePath="/portal"
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Scan departure" }));
  await user.type(screen.getByLabelText("Scan barcode"), "HU-LOAD-001");
  await user.type(screen.getByLabelText("Handling unit code"), "HU-LOAD-001");
  await user.type(screen.getByLabelText("Notes"), "Loaded and sealed");
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_warehouse_transfer_checkpoint_v1",
    expect.objectContaining({
      p_action_key: "warehouse_transfers.scan_departure",
      p_resource_key: "warehouse_transfers",
      p_selection_ids: ["transfer-1"],
      p_selection_id: "transfer-1",
      p_selection_count: 1,
      p_params: {
        barcode: "HU-LOAD-001",
        handling_unit_code: "HU-LOAD-001",
        notes: "Loaded and sealed",
      },
    })
  );
  await waitFor(() =>
    expect(navigateToMock).toHaveBeenCalledWith(
      "/portal/workflows/runs/workflow-run-transfer-departure-1"
    )
  );
});

test("bulk actions collect checkpoint inputs for the warehouse transfer arrival RPC", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({
    status: "task_completed",
    workflow_run_id: "workflow-run-transfer-arrival-1",
  });
  const workflowActions: BulkActionDefinition[] = [
    {
      key: "warehouse_transfers.scan_arrival",
      label: "Scan arrival",
      resourceKey: "warehouse_transfers",
      execution: {
        type: "workflow",
        rpc: "ui_execute_warehouse_transfer_checkpoint_v1",
        input_schema: {
          version: 1,
          fields: [
            {
              key: "barcode",
              label: "Scan barcode",
              type: "text",
              required: true,
            },
            {
              key: "device_id",
              label: "Device ID",
              type: "text",
              required: false,
            },
            {
              key: "ops_session_id",
              label: "Ops session ID",
              type: "text",
              required: false,
            },
          ],
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["transfer-1"]}
      appBasePath="/portal"
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Scan arrival" }));
  await user.type(screen.getByLabelText("Scan barcode"), "HU-LOAD-001");
  await user.type(screen.getByLabelText("Device ID"), "device-123");
  await user.type(screen.getByLabelText("Ops session ID"), "ops-session-456");
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_warehouse_transfer_checkpoint_v1",
    expect.objectContaining({
      p_action_key: "warehouse_transfers.scan_arrival",
      p_resource_key: "warehouse_transfers",
      p_selection_ids: ["transfer-1"],
      p_selection_id: "transfer-1",
      p_selection_count: 1,
      p_params: {
        barcode: "HU-LOAD-001",
        device_id: "device-123",
        ops_session_id: "ops-session-456",
      },
    })
  );
  await waitFor(() =>
    expect(navigateToMock).toHaveBeenCalledWith(
      "/portal/workflows/runs/workflow-run-transfer-arrival-1"
    )
  );
});

test("bulk actions call the dedicated warehouse transfer reconcile workflow RPC with the canonical payload contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({
    status: "reconcile_recorded",
    workflow_run_id: "workflow-run-transfer-1",
    task_event_id: "task-event-1",
  });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "warehouse_transfers.reconcile_destination",
      label: "Reconcile transfer",
      resourceKey: "warehouse_transfers",
      execution: {
        type: "workflow",
        rpc: "ui_execute_warehouse_transfer_reconcile_v1",
        input_schema: {
          version: 1,
          title: "Destination reconciliation",
          fields: [
            {
              key: "received_shipment_count",
              label: "Received shipment count",
              type: "text",
              required: true,
            },
            {
              key: "damaged_shipment_count",
              label: "Damaged shipment count",
              type: "text",
              required: false,
            },
            {
              key: "missing_shipment_count",
              label: "Missing shipment count",
              type: "text",
              required: false,
            },
            {
              key: "unmanifested_shipment_count",
              label: "Unmanifested shipment count",
              type: "text",
              required: false,
            },
            {
              key: "reconcile_notes",
              label: "Reconcile notes",
              type: "textarea",
              required: false,
            },
          ],
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["transfer-1"]}
      appBasePath="/console"
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Reconcile transfer" }));
  await user.type(screen.getByLabelText("Received shipment count"), "12");
  await user.type(screen.getByLabelText("Damaged shipment count"), "1");
  await user.type(screen.getByLabelText("Missing shipment count"), "0");
  await user.type(screen.getByLabelText("Unmanifested shipment count"), "0");
  await user.type(
    screen.getByLabelText("Reconcile notes"),
    "Received at destination dock"
  );
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_warehouse_transfer_reconcile_v1",
    expect.objectContaining({
      p_action_key: "warehouse_transfers.reconcile_destination",
      p_resource_key: "warehouse_transfers",
      p_selection_ids: ["transfer-1"],
      p_selection_id: "transfer-1",
      p_selection_count: 1,
      p_params: {
        received_shipment_count: "12",
        damaged_shipment_count: "1",
        missing_shipment_count: "0",
        unmanifested_shipment_count: "0",
        reconcile_notes: "Received at destination dock",
      },
    })
  );
  await waitFor(() =>
    expect(navigateToMock).toHaveBeenCalledWith(
      "/console/workflows/runs/workflow-run-transfer-1"
    )
  );
});

test("bulk actions call the dedicated mis-sort resolve RPC with the standard payload contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({ status: "resolved", count: 1, items: [] });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "mis_sort_exceptions.resolve_reassign",
      label: "Resolve mis-sort",
      resourceKey: "mis_sort_exceptions",
      execution: {
        type: "rpc",
        rpc: "ui_execute_mis_sort_exception_resolve_v1",
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["exception-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Resolve mis-sort" }));
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_mis_sort_exception_resolve_v1",
    expect.objectContaining({
      p_action_key: "mis_sort_exceptions.resolve_reassign",
      p_resource_key: "mis_sort_exceptions",
      p_selection_ids: ["exception-1"],
      p_selection_id: "exception-1",
      p_selection_count: 1,
      p_params: null,
    })
  );
});

test("bulk actions call the dedicated wrong-zone resolve RPC with the standard payload contract", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({ status: "resolved", count: 1, items: [] });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "wrong_zone_exceptions.resolve_reassign",
      label: "Reassign to expected zone",
      resourceKey: "wrong_zone_exceptions",
      execution: {
        type: "rpc",
        rpc: "ui_execute_mis_sort_exception_resolve_v1",
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["exception-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Reassign to expected zone" }));
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_mis_sort_exception_resolve_v1",
    expect.objectContaining({
      p_action_key: "wrong_zone_exceptions.resolve_reassign",
      p_resource_key: "wrong_zone_exceptions",
      p_selection_ids: ["exception-1"],
      p_selection_id: "exception-1",
      p_selection_count: 1,
      p_params: null,
    })
  );
});

test("bulk actions collect registry-defined override inputs for the zone-override approval RPC", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({ status: "pending_review", count: 1, items: [] });
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "wrong_zone_exceptions.request_zone_override",
      label: "Request zone override",
      resourceKey: "wrong_zone_exceptions",
      execution: {
        type: "rpc",
        rpc: "ui_execute_zone_override_request_v1",
        input_schema: {
          version: 1,
          fields: [
            {
              key: "override_reason",
              label: "Override reason",
              type: "textarea",
              required: true,
            },
            {
              key: "requested_zone_id",
              label: "Requested zone ID",
              type: "text",
              required: false,
            },
          ],
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["exception-1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Request zone override" }));
  await user.type(
    screen.getByLabelText("Override reason"),
    "Manual override approved by supervisor"
  );
  await user.type(
    screen.getByLabelText("Requested zone ID"),
    "zone-c-1"
  );
  await user.click(screen.getByTestId("test-bulk-actions-confirm-submit"));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith(
    "ui_execute_zone_override_request_v1",
    expect.objectContaining({
      p_action_key: "wrong_zone_exceptions.request_zone_override",
      p_resource_key: "wrong_zone_exceptions",
      p_selection_ids: ["exception-1"],
      p_selection_id: "exception-1",
      p_selection_count: 1,
      p_params: {
        override_reason: "Manual override approved by supervisor",
        requested_zone_id: "zone-c-1",
      },
    })
  );
});

test("bulk action confirm submit is locked while request is pending", async () => {
  const user = userEvent.setup();
  let resolveRpc: (() => void) | null = null;
  const inFlightRpc = new Promise<Record<string, unknown>>((resolve) => {
    resolveRpc = resolve;
  });
  rpcMock.mockReturnValue(inFlightRpc);
  const mutationActions: BulkActionDefinition[] = [
    {
      key: "shipments.archive",
      label: "Archive shipment",
      resourceKey: "shipments",
      execution: { type: "workflow", rpc: "ui_execute_command_v1" },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={mutationActions}
      selectedIds={["1"]}
      testIdPrefix="test"
    />
  );

  await user.click(screen.getByRole("button", { name: "Archive shipment" }));
  const confirmButton = await screen.findByTestId(
    "test-bulk-actions-confirm-submit"
  );

  await user.click(confirmButton);
  expect(confirmButton).toBeDisabled();

  await user.click(confirmButton);
  expect(rpcMock).toHaveBeenCalledTimes(1);

  resolveRpc?.();

  await waitFor(() =>
    expect(
      screen.queryByTestId("test-bulk-actions-confirm-dialog")
    ).not.toBeInTheDocument()
  );
});

test("bulk actions surface undo when configured", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({});
  const undoableActions: BulkActionDefinition[] = [
    {
      key: "shipments.delete",
      label: "Delete shipments",
      resourceKey: "shipments",
      execution: {
        type: "rpc",
        rpc: "ui_execute_command_v1",
        params: {
          handler: "resource_delete",
          undo_command_key: "shipments.delete.undo",
        },
      },
    },
    {
      key: "shipments.delete.undo",
      label: "Undo delete shipments",
      resourceKey: "shipments",
      execution: { type: "rpc", rpc: "ui_execute_command_v1" },
    },
  ];

  renderWithIntl(
    <BulkActions actions={undoableActions} selectedIds={["1"]} />
  );

  await user.click(
    screen.getByRole("button", { name: "Delete shipments" })
  );
  await submitBulkActionConfirm(user);

  const undoButton = await screen.findByRole("button", {
    name: "Undo delete shipments",
  });
  await user.click(undoButton);
  await submitBulkActionConfirm(user);

  expect(rpcMock).toHaveBeenNthCalledWith(
    1,
    "ui_execute_command_v1",
    expect.objectContaining({
      p_action_key: "shipments.delete",
      p_resource_key: "shipments",
      p_selection_ids: ["1"],
      p_selection_id: "1",
      p_selection_count: 1,
      p_params: {
        handler: "resource_delete",
        undo_command_key: "shipments.delete.undo",
      },
    })
  );
  expect(rpcMock).toHaveBeenNthCalledWith(
    2,
    "ui_execute_command_v1",
    expect.objectContaining({
      p_action_key: "shipments.delete.undo",
      p_resource_key: "shipments",
      p_selection_ids: ["1"],
      p_selection_id: "1",
      p_selection_count: 1,
      p_params: null,
    })
  );
});

test("print bulk actions fail closed when auto-download is disabled", async () => {
  const user = userEvent.setup();
  const openMock = jest.spyOn(window, "open").mockReturnValue({} as any);
  rpcMock.mockResolvedValue({
    status: "workflow_started",
    workflow_run_id: "run-123",
  });

  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.print_labels",
      label: "Print labels",
      resourceKey: "shipments",
      execution: {
        type: "print",
        rpc: "ui_execute_command_v1",
        params: buildPrintActionParams({
          auto_download: false,
          fallback_mode: "open_run_outputs",
        }),
      },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["1"]}
      appBasePath="/portal"
    />
  );

  await user.click(
    screen.getByRole("button", { name: "Print labels" })
  );
  await submitBulkActionConfirm(user);

  await waitFor(() => {
    expect(
      screen.getByText(/Invalid print action contract:/i)
    ).toBeInTheDocument();
    expect(openMock).not.toHaveBeenCalled();
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  openMock.mockRestore();
});

test("print bulk actions auto-download when workflow output URL is available", async () => {
  const user = userEvent.setup();
  const openMock = jest.spyOn(window, "open").mockReturnValue({} as any);
  rpcMock.mockResolvedValue({
    status: "workflow_started",
    workflow_run_id: "run-321",
    correlation_id: "corr-321",
  });
  progressWorkflowRunUntilWaitMock.mockResolvedValue({
    workflow_run_id: "run-321",
    status: "pending",
  });
  getWorkflowRunOutputStatusMock.mockResolvedValue({
    workflow_run_id: "run-321",
    phase: "downloading",
    output_ready: true,
    output_url: "https://files.example.com/labels-1.pdf",
  });

  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.print_labels",
      label: "Print labels",
      resourceKey: "shipments",
      execution: {
        type: "print",
        rpc: "ui_execute_command_v1",
        params: buildPrintActionParams(),
      },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["1"]}
      appBasePath="/portal"
    />
  );

  await user.click(screen.getByRole("button", { name: "Print labels" }));
  await submitBulkActionConfirm(user);

  await waitFor(() => {
    expect(progressWorkflowRunUntilWaitMock).not.toHaveBeenCalled();
    expect(getWorkflowRunOutputStatusMock).toHaveBeenCalledWith("run-321", [
      "context.generated_labels[0].download_url",
    ]);
    expect(openMock).toHaveBeenCalledWith(
      "https://files.example.com/labels-1.pdf",
      "_blank",
      "noopener,noreferrer"
    );
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  openMock.mockRestore();
});

test("print bulk actions sign fresh workflow output paths without redirecting", async () => {
  const user = userEvent.setup();
  const openMock = jest.spyOn(window, "open").mockReturnValue({} as any);
  rpcMock.mockResolvedValue({
    status: "workflow_started",
    workflow_run_id: "run-file-path",
    correlation_id: "corr-file-path",
  });
  getWorkflowRunOutputStatusMock.mockResolvedValue({
    workflow_run_id: "run-file-path",
    phase: "downloading",
    output_ready: true,
    output_file_path: "org-1/labels/fresh-file.pdf",
    output_bucket: "labels",
    output_needs_signing: true,
    output_source: "fresh_ready_file",
  });
  requestUiWorkflowRunOutputDownloadMock.mockResolvedValue({
    ok: true,
    url: "https://files.example.com/fresh-file.pdf",
    expires_at: "2026-03-06T12:00:00.000Z",
  });

  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.print_labels",
      label: "Print labels",
      resourceKey: "shipments",
      execution: {
        type: "print",
        rpc: "ui_execute_command_v1",
        params: buildPrintActionParams(),
      },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["1"]}
      appBasePath="/portal"
    />
  );

  await user.click(screen.getByRole("button", { name: "Print labels" }));
  await submitBulkActionConfirm(user);

  await waitFor(() => {
    expect(requestUiWorkflowRunOutputDownloadMock).toHaveBeenCalledWith({
      accessToken: "token-123",
      workflowRunId: "run-file-path",
      outputUrlPaths: ["context.generated_labels[0].download_url"],
    });
    expect(openMock).toHaveBeenCalledWith(
      "https://files.example.com/fresh-file.pdf",
      "_blank",
      "noopener,noreferrer"
    );
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  openMock.mockRestore();
});

test("print bulk actions skip client-side workflow nudges when status RPC manages progress", async () => {
  const user = userEvent.setup();
  const openMock = jest.spyOn(window, "open").mockReturnValue({} as any);
  rpcMock.mockResolvedValue({
    status: "workflow_started",
    workflow_run_id: "run-managed",
    correlation_id: "corr-managed",
  });
  getWorkflowRunOutputStatusMock
    .mockResolvedValueOnce({
      workflow_run_id: "run-managed",
      phase: "generating",
      output_ready: false,
      terminal: false,
      pending_count: 1,
      poll_progress_managed: true,
      poll_progress_attempted: true,
      poll_progress_status: "pending",
    })
    .mockResolvedValueOnce({
      workflow_run_id: "run-managed",
      phase: "downloading",
      output_ready: true,
      output_url: "https://files.example.com/labels-managed.pdf",
      poll_progress_managed: true,
      poll_progress_attempted: true,
      poll_progress_status: "completed",
    });

  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.print_labels",
      label: "Print labels",
      resourceKey: "shipments",
      execution: {
        type: "print",
        rpc: "ui_execute_command_v1",
        params: buildPrintActionParams(),
      },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["1"]}
      appBasePath="/portal"
    />
  );

  await user.click(screen.getByRole("button", { name: "Print labels" }));
  await submitBulkActionConfirm(user);

  await waitFor(() => {
    expect(progressWorkflowRunUntilWaitMock).not.toHaveBeenCalled();
    expect(getWorkflowRunOutputStatusMock).toHaveBeenCalledTimes(2);
    expect(openMock).toHaveBeenCalledWith(
      "https://files.example.com/labels-managed.pdf",
      "_blank",
      "noopener,noreferrer"
    );
  });

  openMock.mockRestore();
});

test("print bulk actions keep progress in-page and never redirect on delayed output", async () => {
  const user = userEvent.setup();
  const openMock = jest.spyOn(window, "open").mockReturnValue({} as any);
  rpcMock.mockResolvedValue({
    status: "workflow_started",
    workflow_run_id: "run-987",
    correlation_id: "corr-987",
  });
  progressWorkflowRunUntilWaitMock.mockResolvedValue({
    workflow_run_id: "run-987",
    status: "pending",
  });
  getWorkflowRunOutputStatusMock
    .mockResolvedValueOnce({
      workflow_run_id: "run-987",
      phase: "checking",
      output_ready: false,
      terminal: false,
      pending_count: 2,
    })
    .mockResolvedValueOnce({
      workflow_run_id: "run-987",
      phase: "failed",
      workflow_status: "failed",
      output_ready: false,
      terminal: true,
      failure_reason: "renderer timeout",
    });

  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.print_labels",
      label: "Print labels",
      resourceKey: "shipments",
      execution: {
        type: "print",
        rpc: "ui_execute_command_v1",
        params: buildPrintActionParams({
          poll_timeout_ms: 5,
        }),
      },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["1"]}
      appBasePath="/portal"
    />
  );

  await user.click(screen.getByRole("button", { name: "Print labels" }));
  await submitBulkActionConfirm(user);

  await waitFor(() => {
    expect(progressWorkflowRunUntilWaitMock).toHaveBeenCalled();
    expect(getWorkflowRunOutputStatusMock).toHaveBeenCalled();
    expect(screen.getByTestId("bulk-actions-print-progress")).toBeInTheDocument();
    expect(screen.getByText("renderer timeout")).toBeInTheDocument();
    expect(screen.getByText("Couldn't prepare download")).toBeInTheDocument();
    expect(navigateToMock).not.toHaveBeenCalled();
  });
  expect(openMock).not.toHaveBeenCalled();

  openMock.mockRestore();
});

test("print bulk actions expose technical details in the widget without redirecting", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({
    status: "workflow_started",
    workflow_run_id: "run-details",
  });
  progressWorkflowRunUntilWaitMock.mockResolvedValue({
    workflow_run_id: "run-details",
    status: "pending",
  });
  getWorkflowRunOutputStatusMock
    .mockResolvedValueOnce({
      workflow_run_id: "run-details",
      phase: "checking",
      output_ready: false,
      terminal: false,
      timing_source: "stage_execute_ms",
      output_source: "context",
    })
    .mockResolvedValueOnce({
      workflow_run_id: "run-details",
      phase: "failed",
      workflow_status: "failed",
      output_ready: false,
      terminal: true,
      failure_reason: "renderer timeout",
      timing_source: "stage_execute_ms",
      output_source: "context",
    });

  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.print_labels",
      label: "Print labels",
      resourceKey: "shipments",
      execution: {
        type: "print",
        rpc: "ui_execute_command_v1",
        params: buildPrintActionParams({
          poll_timeout_ms: 5,
        }),
      },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["1"]}
      appBasePath="/portal"
    />
  );

  await user.click(screen.getByRole("button", { name: "Print labels" }));
  await submitBulkActionConfirm(user);

  await screen.findByText("Couldn't prepare download");
  await user.click(screen.getByRole("button", { name: "Technical details" }));

  await waitFor(() => {
    expect(screen.getByText("Workflow run: run-details")).toBeInTheDocument();
    expect(screen.getByText("Timing source: stage_execute_ms")).toBeInTheDocument();
    expect(screen.getByText("Output source: context")).toBeInTheDocument();
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  const widget = screen.getByTestId("bulk-actions-print-progress");
  await user.click(within(widget).getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByTestId("bulk-actions-print-progress")).not.toBeInTheDocument();
});

test("print bulk actions fail closed when required auto-download contract params are missing", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({
    status: "workflow_started",
    workflow_run_id: "run-contract",
  });
  const missingProgressParams = buildPrintActionParams();
  delete missingProgressParams.poll_progress_enabled;
  delete missingProgressParams.poll_progress_budget_ms;
  delete missingProgressParams.poll_progress_max_steps;

  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.print_labels",
      label: "Print labels",
      resourceKey: "shipments",
      execution: {
        type: "print",
        rpc: "ui_execute_command_v1",
        params: missingProgressParams,
      },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["1"]}
      appBasePath="/portal"
    />
  );

  await user.click(screen.getByRole("button", { name: "Print labels" }));
  await submitBulkActionConfirm(user);

  await waitFor(() => {
    expect(
      screen.getByText(/Invalid print action contract:/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/poll_progress_enabled must be a boolean/i)
    ).toBeInTheDocument();
    expect(getWorkflowRunOutputStatusMock).not.toHaveBeenCalled();
    expect(navigateToMock).not.toHaveBeenCalled();
  });
});

test("print bulk actions fail closed when poll_interval_ms is missing", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({
    status: "workflow_started",
    workflow_run_id: "run-contract-poll-interval",
  });

  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.print_labels",
      label: "Print labels",
      resourceKey: "shipments",
      execution: {
        type: "print",
        rpc: "ui_execute_command_v1",
        params: (() => {
          const params = buildPrintActionParams({
            poll_schedule_ms: [50, 100],
            poll_timeout_ms: 45000,
          });
          delete params.poll_interval_ms;
          return params;
        })(),
      },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["1"]}
      appBasePath="/portal"
    />
  );

  await user.click(screen.getByRole("button", { name: "Print labels" }));
  await submitBulkActionConfirm(user);

  await waitFor(() => {
    expect(screen.getByText(/poll_interval_ms must be a positive integer/i)).toBeInTheDocument();
    expect(getWorkflowRunOutputStatusMock).not.toHaveBeenCalled();
    expect(navigateToMock).not.toHaveBeenCalled();
  });
});

test("print bulk actions emit structured KPI telemetry meta", async () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  const user = userEvent.setup();
  const openMock = jest.spyOn(window, "open").mockReturnValue({} as any);
  rpcMock.mockResolvedValue({
    status: "workflow_started",
    workflow_run_id: "run-kpi",
  });
  progressWorkflowRunUntilWaitMock.mockResolvedValue({
    workflow_run_id: "run-kpi",
    status: "pending",
  });
  getWorkflowRunOutputStatusMock.mockResolvedValue({
    workflow_run_id: "run-kpi",
    phase: "downloading",
    artifact_persisted: true,
    job_completion_pending: false,
    timing_source: "stage_execute_ms",
    output_ready: true,
    output_source: "context",
    function_total_ms: 40,
    fresh_expected_count: 1,
    fresh_ready_count: 1,
    fresh_failed_count: 0,
    fresh_only_resolved: true,
    stage_prepare_ms: 12,
    stage_render_wait_ms: 22,
    stage_bundle_wait_ms: 33,
    stage_finalize_ms: 4,
    output_url: "https://files.example.com/labels-kpi.pdf",
  });

  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.print_labels",
      label: "Print labels",
      resourceKey: "shipments",
      execution: {
        type: "print",
        rpc: "ui_execute_command_v1",
        params: buildPrintActionParams(),
      },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["1"]}
      appBasePath="/portal"
    />
  );

  await user.click(screen.getByRole("button", { name: "Print labels" }));
  await submitBulkActionConfirm(user);

  await waitFor(() => {
    expect(openMock).toHaveBeenCalledWith(
      "https://files.example.com/labels-kpi.pdf",
      "_blank",
      "noopener,noreferrer"
    );
  });

  const events = reporter.mock.calls.map((call) => call[0]);
  const kpiEvent = events.find(
    (event) => event.type === "ui.bulk_action.print.download.kpi"
  );
  expect(kpiEvent).toEqual(
    expect.objectContaining({
      name: "shipments.print_labels",
      context: "shipments",
      meta: expect.objectContaining({
        workflow_run_id: "run-kpi",
        target_download_ms: 100,
        classification: expect.stringMatching(/^(hit|miss)$/),
        stage_command_ms: expect.any(Number),
        stage_first_status_ms: expect.any(Number),
        stage_output_ready_ms: expect.any(Number),
        stage_transport_ms: expect.any(Number),
        function_total_ms: 40,
        edge_overhead_ms: expect.any(Number),
        stage_prepare_ms: 12,
        stage_render_wait_ms: 22,
        stage_bundle_wait_ms: 33,
        stage_finalize_ms: 4,
        fresh_expected_count: 1,
        fresh_ready_count: 1,
        fresh_failed_count: 0,
        fresh_only_resolved: true,
        artifact_persisted: true,
        job_completion_pending: false,
        timing_source: "stage_execute_ms",
        output_source: expect.any(String),
        phase: "downloading",
      }),
    })
  );

  openMock.mockRestore();
});

test("print bulk actions block unsafe workflow destinations", async () => {
  const user = userEvent.setup();
  const openMock = jest.spyOn(window, "open").mockReturnValue({} as any);

  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.print_labels",
      label: "Print labels",
      resourceKey: "shipments",
      execution: { type: "print", rpc: "ui_execute_command_v1" },
    },
  ];

  rpcMock.mockResolvedValue({
    status: "workflow_started",
    workflow_run_id: "run-123",
  });

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["1"]}
      appBasePath="javascript:alert(1)"
    />
  );

  await user.click(
    screen.getByRole("button", { name: "Print labels" })
  );

  await waitFor(() => {
    expect(openMock).not.toHaveBeenCalled();
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  openMock.mockRestore();
});

test("workflow bulk actions navigate to trace page when correlation is available", async () => {
  const user = userEvent.setup();
  rpcMock.mockResolvedValue({
    status: "workflow_started",
    workflow_run_id: "run-123",
    correlation_id: "corr-workflow-1",
  });

  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.bulk.update",
      label: "Bulk update shipments",
      execution: { type: "workflow", rpc: "ui_execute_command_v1" },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={workflowActions}
      selectedIds={["1"]}
      appBasePath="/portal"
    />
  );

  await user.click(
    screen.getByRole("button", { name: "Bulk update shipments" })
  );
  await submitBulkActionConfirm(user);

  await waitFor(() =>
    expect(navigateToMock).toHaveBeenCalledWith(
      "/portal/observability/trace/corr-workflow-1"
    )
  );
});

test("bulk actions redact errors and emit telemetry on failure", async () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  const user = userEvent.setup();
  rpcMock.mockRejectedValue(
    new Error("token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature")
  );
  const telemetry = {
    settingsResolutionId: "res-987",
    scopeType: "tenant",
    scopeId: "tenant-1",
    scopeValue: "acme",
  };
  const actionsWithFailure: BulkActionDefinition[] = [
    {
      key: "shipments.fail",
      label: "Fail shipments",
      resourceKey: "shipments",
      execution: { type: "rpc", rpc: "ui_execute_command_v1" },
    },
  ];

  renderWithIntl(
    <BulkActions
      actions={actionsWithFailure}
      selectedIds={["1"]}
      telemetry={telemetry}
    />
  );

  await user.click(
    screen.getByRole("button", { name: "Fail shipments" })
  );
  await submitBulkActionConfirm(user);

  expect(await screen.findByText(/\[redacted\]/)).toBeInTheDocument();
  const events = reporter.mock.calls.map((call) => call[0]);
  const errorEvent = events.find(
    (event) => event.type === "ui.bulk_action.error"
  );
  expect(errorEvent).toEqual(
    expect.objectContaining({
      context: "shipments",
      name: "shipments.fail",
      digest: "res-987",
      message: expect.stringContaining("[redacted]"),
      meta: {
        settingsResolutionId: "res-987",
        scopeType: "tenant",
        scopeId: "tenant-1",
        scopeValue: "acme",
      },
    })
  );
});

test("bulk actions show disabled reason when permission is missing", () => {    
  const gatedActions: BulkActionDefinition[] = [
    {
      key: "settings.request",
      label: "Request settings change",
      href: "/console/settings/request",
      execution: { type: "navigate" },
      disabledReason: "Requires settings.request capability.",
    },
  ];

  renderWithIntl(<BulkActions actions={gatedActions} selectedIds={["1"]} />);

  const button = screen.getByRole("button", {
    name: "Request settings change",
  });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute(
    "title",
    "Requires settings.request capability."
  );
});

test("bulk actions enable workflow actions with rpc", () => {
  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.bulk.update",
      label: "Bulk update shipments",
      execution: { type: "workflow", rpc: "ui_execute_command_v1" },
    },
  ];

  renderWithIntl(
    <BulkActions actions={workflowActions} selectedIds={["1"]} />
  );

  const button = screen.getByRole("button", {
    name: "Bulk update shipments",
  });
  expect(button).not.toBeDisabled();
});

test("bulk actions enable workflow binding actions with rpc", () => {
  const workflowBindingActions: BulkActionDefinition[] = [
    {
      key: "shipments.change.review",
      label: "Review shipment changes",
      execution: { type: "workflow_binding", rpc: "ui_execute_command_v1" },
    },
  ];

  renderWithIntl(
    <BulkActions actions={workflowBindingActions} selectedIds={["1"]} />
  );

  const button = screen.getByRole("button", {
    name: "Review shipment changes",
  });
  expect(button).not.toBeDisabled();
});

test("bulk actions disable workflow when no execution target exists", () => {
  const workflowActions: BulkActionDefinition[] = [
    {
      key: "shipments.bulk.update",
      label: "Bulk update shipments",
      execution: { type: "workflow" },
    },
  ];

  renderWithIntl(
    <BulkActions actions={workflowActions} selectedIds={["1"]} />
  );

  const button = screen.getByRole("button", {
    name: "Bulk update shipments",
  });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute(
    "title",
    "Action execution is not configured."
  );
});

test("bulk actions allow print actions with href", () => {
  const printActions: BulkActionDefinition[] = [
    {
      key: "shipments.print",
      label: "Print labels",
      href: "/console/shipments/print",
      execution: { type: "print" },
    },
  ];

  renderWithIntl(
    <BulkActions actions={printActions} selectedIds={["1"]} />
  );

  const button = screen.getByRole("button", {
    name: "Print labels",
  });
  expect(button).not.toBeDisabled();
});

test("resolveResourceBulkActions keeps capability-gated actions visible", () => {
  const t = createUiTranslator("ui.resourceActions");
  const actions = resolveResourceBulkActions({
    t,
    resourceKey: "shipments",
    resource: {
      key: "shipments",
      relation: "shipments",
      download: { capability: "labels.download" },
    },
    commands: [
      {
        key: "shipments.update",
        label: "Update shipments",
        capability: "shipments.write",
        execution: { type: "rpc", rpc: "ui_execute_command_v1" },
      },
    ],
    appKey: "console",
    appBasePath: "/console",
    downloadBasePath: "/console/download",
    userCapabilities: [],
  });
  const updateAction = actions.find((action) => action.key === "shipments.update");
  const downloadAction = actions.find(
    (action) => action.key === "shipments.download.labels"
  );

  expect(updateAction?.disabledReason).toBe(
    "Requires shipments.write capability."
  );
  expect(downloadAction?.disabledReason).toBe(
    "Requires labels.download capability."
  );
});

test("resolveResourceCommandCategory prefers matching registry category", () => {
  const category = resolveResourceCommandCategory({
    resourceKey: "shipments",
    commands: [
      {
        key: "shipments.print",
        label: "Print labels",
        schema_category: "resource:shipments",
      },
    ],
  });

  expect(category).toBe("resource:shipments");
});

test("resolveResourceCommandCategory falls back to resource key", () => {       
  const category = resolveResourceCommandCategory({
    resourceKey: "drivers",
    commands: [],
  });

  expect(category).toBe("resource:drivers");
});

test("matchesResourceCategory accepts hierarchical categories", () => {
  expect(
    matchesResourceCategory("resource:shipments.bulk", "shipments")
  ).toBe(true);
  expect(
    matchesResourceCategory("resource/shipments/actions", "shipments")
  ).toBe(true);
  expect(
    matchesResourceCategory("shipments.print", "shipments")
  ).toBe(true);
  expect(
    matchesResourceCategory("resource:shipments-other", "shipments")
  ).toBe(false);
});

test("resolveResourceCommandCategory uses prefix category when exact missing", () => {
  const category = resolveResourceCommandCategory({
    resourceKey: "shipments",
    commands: [
      {
        key: "shipments.bulk.update",
        label: "Bulk update shipments",
        schema_category: "resource:shipments.bulk",
      },
    ],
  });

  expect(category).toBe("resource:shipments.bulk");
});

test("resolveResourceBulkActions infers workflow binding type from binding key", () => {
  const t = createUiTranslator("ui.resourceActions");
  const commands = [
    {
      key: "customer_shipment_changes.review",
      label: "Review shipment change",
      binding_key: "customer_shipment_change",
      stage_key: "review_requested",
      execution: { rpc: "ui_execute_command_v1" },
      selection: { mode: "single" },
    },
  ] as UiCommandDefinition[];

  const actions = resolveResourceBulkActions({
    t,
    resourceKey: "customer_shipment_changes",
    resource: {
      key: "customer_shipment_changes",
      relation: "customer_shipment_changes",
    },
    commands,
    appKey: "console",
    appBasePath: "/console",
    downloadBasePath: "/console/download",
    userCapabilities: [],
  });

  expect(actions[0]?.execution?.type).toBe("workflow_binding");
  expect(actions[0]?.disabledReason).toBeNull();
});

test("resolveResourceBulkActions supports full shipment action set", () => {
  const t = createUiTranslator("ui.resourceActions");
  const commands = [
    {
      key: "shipments.edit",
      label: "Edit shipment",
      capability: "shipments.write",
      execution: { type: "navigate" },
      route_targets: {
        console: { path: "/shipments/edit" },
      },
      selection: { mode: "single" },
    },
    {
      key: "shipments.delete",
      label: "Delete shipment",
      capability: "shipments.write",
      execution: {
        type: "rpc",
        rpc: "ui_execute_shipment_batch_operation_v1",
        params: {
          operation: "cancel",
        },
        confirm: { tone: "danger" },
      },
      selection: { mode: "any" },
    },
    {
      key: "shipments.reschedule",
      label: "Reschedule shipments",
      capability: "shipments.write",
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
      selection: { mode: "any", min_count: 1 },
    },
    {
      key: "shipments.print_labels",
      label: "Print labels",
      capability: "labels.download",
      execution: { type: "workflow", rpc: "ui_execute_command_v1" },
      selection: { mode: "any" },
    },
    {
      key: "shipments.update_geocode",
      label: "Requeue geocode",
      capability: "shipments.write",
      execution: {
        type: "rpc",
        rpc: "ui_execute_shipment_update_geocode_v1",
        params: {
          workflow_template_name: "shipment_update_geocode_v1",
        },
      },
      selection: { mode: "single", min_count: 1, max_count: 1 },
    },
  ] as UiCommandDefinition[];
  const actions = resolveResourceBulkActions({
    t,
    resourceKey: "shipments",
    resource: {
      key: "shipments",
      relation: "shipments",
      download: { capability: "labels.download" },
    },
    commands,
    appKey: "console",
    appBasePath: "/console",
    downloadBasePath: "/console/download",
    userCapabilities: [
      "shipments.write",
      "labels.download",
    ],
  });
  const actionKeys = actions.map((action) => action.key);
  expect(actionKeys).toEqual(
    expect.arrayContaining([
      "shipments.edit",
      "shipments.delete",
      "shipments.reschedule",
      "shipments.print_labels",
      "shipments.update_geocode",
      "shipments.download.labels",
    ])
  );
});
