const invalidateQueries = jest.fn();

jest.mock("@tanstack/react-query", () => ({
  ...jest.requireActual("@tanstack/react-query"),
  useQueryClient: () => ({ invalidateQueries }),
}));

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(),
}));

jest.mock("../../packages/ui/src/navigate", () => ({
  navigateTo: jest.fn(),
}));

import { createUiClient } from "@masarx/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { WorkflowScheduleTriggersPanel } from "../../packages/ui/src/workflow-schedule-triggers-panel";
import { navigateTo } from "../../packages/ui/src/navigate";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiClient = createUiClient as unknown as jest.Mock;
const mockedNavigateTo = navigateTo as unknown as jest.Mock;

describe("WorkflowScheduleTriggersPanel", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    invalidateQueries.mockReset();
  });

  it("renders an empty state when no schedules exist", () => {
    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger: jest.fn(),
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[]}
        triggersTotal={0}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    expect(screen.getByText("No schedule triggers are configured yet.")).toBeInTheDocument();
  });

  it("renders safe full-view and last-run links when appBasePath is trusted", () => {
    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger: jest.fn(),
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[
          {
            id: "trigger-1",
            enabled: true,
            schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
            next_run_at: "2026-01-21T00:00:00Z",
            last_run_id: "run-1",
          },
        ]}
        triggersTotal={1}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    const fullViewLink = screen.getByRole("link", { name: "Open schedules in full view" });
    expect(fullViewLink).toHaveAttribute("href", "/portal/resources/workflow_schedule_triggers?workflow_template_id=template-1");

    const lastRunLink = screen.getByRole("link", { name: "Open last run" });
    expect(lastRunLink).toHaveAttribute("href", "/portal/workflows/runs/run-1");
  });

  it("renders root-relative links when appBasePath is the app root", () => {
    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger: jest.fn(),
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[
          {
            id: "trigger-1",
            enabled: true,
            schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
            next_run_at: "2026-01-21T00:00:00Z",
            last_run_id: "run-1",
          },
        ]}
        triggersTotal={1}
        appBasePath="/"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    const fullViewLink = screen.getByRole("link", { name: "Open schedules in full view" });
    expect(fullViewLink).toHaveAttribute(
      "href",
      "/resources/workflow_schedule_triggers?workflow_template_id=template-1"
    );

    const lastRunLink = screen.getByRole("link", { name: "Open last run" });
    expect(lastRunLink).toHaveAttribute("href", "/workflows/runs/run-1");
  });

  it("renders recurring shipment guidance and trigger notes when provided", () => {
    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger: jest.fn(),
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[
          {
            id: "trigger-1",
            enabled: true,
            notes: "Recurring shipment smoke",
            schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
            next_run_at: "2026-01-21T00:00:00Z",
          },
        ]}
        triggersTotal={1}
        appBasePath="/portal"
        scheduleTemplateGuide={{
          kind: "shipment_create_reserved",
          exampleContextPatch: {
            client_id: "<client-uuid-for-tenant-scoped-schedules>",
            service_type: "delivery",
          },
        }}
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    expect(screen.getByText("Recurring shipments")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This workflow template already reserves a shipment id and tracking number before create_shipment runs."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Recurring shipment smoke")).toBeInTheDocument();
    expect(screen.getByTestId("schedule-panel-shipment-guide-example")).toHaveTextContent(
      '"client_id": "<client-uuid-for-tenant-scoped-schedules>"'
    );
  });

  it("runs a schedule trigger and navigates to the workflow run", async () => {
    const runWorkflowScheduleTrigger = jest.fn().mockResolvedValue({
      workflow_run_id: "run-123",
    });

    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger,
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[
          {
            id: "trigger-1",
            enabled: true,
            schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
            next_run_at: "2026-01-21T00:00:00Z",
          },
        ]}
        triggersTotal={1}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    expect(screen.getByText("Every 1 hour · UTC")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("schedule-panel-run-trigger-1"));

    await waitFor(() => expect(runWorkflowScheduleTrigger).toHaveBeenCalledWith("trigger-1"));
    const receipt = await screen.findByTestId("schedule-panel-run-readback-trigger-1");
    expect(receipt).toHaveAttribute("role", "status");
    expect(within(receipt).getByText("Schedule run started.")).toBeInTheDocument();
    expect(within(receipt).getByText("run-123")).toBeInTheDocument();
    expect(within(receipt).getByRole("link", { name: "Open last run" }))
      .toHaveAttribute("href", "/portal/workflows/runs/run-123");
    expect(mockedNavigateTo).toHaveBeenCalledWith("/portal/workflows/runs/run-123");
  });

  it("runs a schedule trigger and navigates to the workflow run from the app root", async () => {
    const runWorkflowScheduleTrigger = jest.fn().mockResolvedValue({
      workflow_run_id: "run-123",
    });

    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger,
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[
          {
            id: "trigger-1",
            enabled: true,
            schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
            next_run_at: "2026-01-21T00:00:00Z",
          },
        ]}
        triggersTotal={1}
        appBasePath="/"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    fireEvent.click(screen.getByTestId("schedule-panel-run-trigger-1"));

    await waitFor(() => expect(runWorkflowScheduleTrigger).toHaveBeenCalledWith("trigger-1"));
    expect(mockedNavigateTo).toHaveBeenCalledWith("/workflows/runs/run-123");
  });

  it("disables run-now actions when the template is not active", () => {
    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger: jest.fn(),
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        templateStatus="draft"
        triggers={[
          {
            id: "trigger-1",
            enabled: true,
            schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
            next_run_at: "2026-01-21T00:00:00Z",
          },
        ]}
        triggersTotal={1}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    expect(
      screen.getByText("This template is not active. Enable preview mode to run drafts safely.")
    ).toBeInTheDocument();
    expect(screen.getByTestId("schedule-panel-run-trigger-1")).toBeDisabled();
  });

  it("does not navigate when schedule run destination is unsafe", async () => {
    const runWorkflowScheduleTrigger = jest.fn().mockResolvedValue({
      workflow_run_id: "run-123",
    });

    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger,
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[
          {
            id: "trigger-1",
            enabled: true,
            schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
            next_run_at: "2026-01-21T00:00:00Z",
          },
        ]}
        triggersTotal={1}
        appBasePath="javascript:alert(1)"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    fireEvent.click(screen.getByTestId("schedule-panel-run-trigger-1"));

    await waitFor(() => expect(runWorkflowScheduleTrigger).toHaveBeenCalledWith("trigger-1"));
    expect(mockedNavigateTo).not.toHaveBeenCalled();
  });

  it("renders full-view link as plain text when destination is unsafe", () => {
    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger: jest.fn(),
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[
          {
            id: "trigger-1",
            enabled: true,
            schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
            next_run_at: "2026-01-21T00:00:00Z",
            last_run_id: "run-1",
          },
        ]}
        triggersTotal={1}
        appBasePath="javascript:alert(1)"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    const fullViewLabel = screen.getByText("Open schedules in full view");
    expect(fullViewLabel.closest("a")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open schedules in full view" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open last run" })).toBeNull();
  });

  it("navigates to trace page when trigger run includes correlation id", async () => {
    const runWorkflowScheduleTrigger = jest.fn().mockResolvedValue({
      workflow_run_id: "run-123",
      correlation_id: "corr-trigger",
    });

    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger,
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[
          {
            id: "trigger-1",
            enabled: true,
            schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
            next_run_at: "2026-01-21T00:00:00Z",
          },
        ]}
        triggersTotal={1}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    fireEvent.click(screen.getByTestId("schedule-panel-run-trigger-1"));

    await waitFor(() => expect(runWorkflowScheduleTrigger).toHaveBeenCalledWith("trigger-1"));
    expect(mockedNavigateTo).toHaveBeenCalledWith(
      "/portal/observability/trace/corr-trigger"
    );
  });

  it("toggles schedule enabled state via updateResource", async () => {
    const updateResource = jest.fn().mockResolvedValue({
      id: "trigger-1",
      enabled: false,
      schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
      next_run_at: "2026-01-21T00:00:00Z",
    });

    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger: jest.fn(),
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[
          {
            id: "trigger-1",
            enabled: true,
            schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
            next_run_at: "2026-01-21T00:00:00Z",
          },
        ]}
        triggersTotal={1}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    fireEvent.click(screen.getByTestId("schedule-panel-toggle-trigger-1"));

    await waitFor(() =>
      expect(updateResource).toHaveBeenCalledWith({
        resource: "workflow_schedule_triggers",
        id: "trigger-1",
        patch: { enabled: false },
      })
    );

    const row = screen.getByTestId("schedule-panel-row-trigger-1");
    await waitFor(() => expect(within(row).getByText("disabled")).toBeInTheDocument());
  });

  it("creates a schedule trigger from the modal and refreshes the route", async () => {
    const createWorkflowScheduleTrigger = jest.fn().mockResolvedValue({
      workflow_schedule_trigger_id: "trigger-2",
    });

    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger: jest.fn(),
      createWorkflowScheduleTrigger,
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[]}
        triggersTotal={0}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    fireEvent.click(screen.getByTestId("schedule-panel-new"));

    const modal = await screen.findByTestId("schedule-panel-editor-modal");
    const [scheduleTypeSelect] = within(modal).getAllByRole("combobox");
    fireEvent.change(scheduleTypeSelect, { target: { value: "daily" } });

    const timezoneInput = within(modal).getByPlaceholderText("UTC");
    fireEvent.change(timezoneInput, { target: { value: "UTC" } });

    const dailyTime = within(modal).getByDisplayValue("09:00");
    fireEvent.change(dailyTime, { target: { value: "10:30" } });

    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(createWorkflowScheduleTrigger).toHaveBeenCalledWith({
        workflowTemplateId: "template-1",
        schedule: { type: "daily", at_time: "10:30", timezone: "UTC" },
        contextPatch: {},
        enabled: true,
        notes: null,
      })
    );

    await waitFor(() => expect(invalidateQueries).toHaveBeenCalled());
    expect(screen.getByTestId("schedule-panel-row-trigger-2")).toBeInTheDocument();
  });

  it("creates an interval schedule trigger with unit conversion", async () => {
    const createWorkflowScheduleTrigger = jest.fn().mockResolvedValue({
      workflow_schedule_trigger_id: "trigger-2",
    });

    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger: jest.fn(),
      createWorkflowScheduleTrigger,
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[]}
        triggersTotal={0}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    fireEvent.click(screen.getByTestId("schedule-panel-new"));

    const modal = await screen.findByTestId("schedule-panel-editor-modal");
    const [, unitSelect] = within(modal).getAllByRole("combobox");
    fireEvent.change(unitSelect, { target: { value: "minutes" } });

    const intervalValue = within(modal).getByRole("spinbutton");
    fireEvent.change(intervalValue, { target: { value: "5" } });

    const timezoneInput = within(modal).getByPlaceholderText("UTC");
    fireEvent.change(timezoneInput, { target: { value: "UTC" } });

    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(createWorkflowScheduleTrigger).toHaveBeenCalledWith({
        workflowTemplateId: "template-1",
        schedule: { type: "interval", interval_seconds: 300, timezone: "UTC" },
        contextPatch: {},
        enabled: true,
        notes: null,
      })
    );
  });

  it("validates and formats schedule context patch JSON", async () => {
    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger: jest.fn(),
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[]}
        triggersTotal={0}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    fireEvent.click(screen.getByTestId("schedule-panel-new"));

    const modal = await screen.findByTestId("schedule-panel-editor-modal");
    const textarea = within(modal).getByPlaceholderText("{}");

    fireEvent.change(textarea, { target: { value: "{\"foo\":1}" } });
    fireEvent.click(within(modal).getByRole("button", { name: "Format JSON" }));
    expect(textarea).toHaveValue("{\n  \"foo\": 1\n}");

    fireEvent.change(textarea, { target: { value: "{ invalid-json" } });
    expect(within(modal).getByText("Context patch must be a JSON object.")).toBeInTheDocument();
    expect(within(modal).getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.click(within(modal).getByRole("button", { name: "Reset" }));
    expect(textarea).toHaveValue("{}");
    expect(within(modal).queryByText("Context patch must be a JSON object.")).toBeNull();
    expect(within(modal).getByRole("button", { name: "Save" })).not.toBeDisabled();
  });

  it("deletes a schedule trigger via ui_delete_resource_v1", async () => {
    const rpc = jest.fn().mockResolvedValue({});

    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger: jest.fn(),
      createWorkflowScheduleTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc,
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[
          {
            id: "trigger-1",
            enabled: true,
            schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
            next_run_at: "2026-01-21T00:00:00Z",
          },
        ]}
        triggersTotal={1}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    fireEvent.click(screen.getByTestId("schedule-panel-delete-trigger-1"));

    const modal = await screen.findByTestId("schedule-panel-delete-modal");
    fireEvent.click(within(modal).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("ui_delete_resource_v1", {
        p_resource: "workflow_schedule_triggers",
        p_id: "trigger-1",
      })
    );

    await waitFor(() => expect(invalidateQueries).toHaveBeenCalled());
    expect(screen.queryByTestId("schedule-panel-row-trigger-1")).toBeNull();
  });
});

describe("schedule run acceptance receipt", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    invalidateQueries.mockResolvedValue(undefined);
  });
  test.each(["blocked destination", "navigation failure", "RPC failure"])(
    "preserves accepted identity without unsafe links or reruns after %s", async (scenario) => {
      const run = scenario === "RPC failure"
        ? jest.fn().mockRejectedValue(new Error("Run denied"))
        : jest.fn().mockResolvedValue({ workflow_run_id: "accepted-1" });
      mockedCreateUiClient.mockReturnValue({ runWorkflowScheduleTrigger: run });
      if (scenario === "navigation failure") mockedNavigateTo.mockImplementation(() => { throw new Error("navigation unavailable"); });
      renderWithIntl(<WorkflowScheduleTriggersPanel workflowTemplateId="template-1"
        triggers={[{ id: "trigger-1", enabled: true }]}
        appBasePath={scenario === "blocked destination" ? "javascript:alert(1)" : "/portal"}
        capabilities={["workflow_runs.write"]} testIdPrefix="receipt" />);
      fireEvent.click(screen.getByTestId("receipt-run-trigger-1"));
      await waitFor(() => expect(screen.getByTestId("receipt-run-trigger-1")).toBeEnabled());
      expect(run).toHaveBeenCalledTimes(1);
      if (scenario === "RPC failure") {
        expect(screen.queryByTestId("receipt-run-readback-trigger-1")).not.toBeInTheDocument();
        expect(await screen.findByText("Run denied")).toBeInTheDocument();
        expect(mockedNavigateTo).not.toHaveBeenCalled();
      } else {
        const receipt = screen.getByTestId("receipt-run-readback-trigger-1");
        expect(within(receipt).getByText("accepted-1")).toBeInTheDocument();
        expect(within(receipt).getByText("Schedule run started.")).toBeInTheDocument();
        if (scenario === "blocked destination") {
          expect(within(receipt).queryByRole("link")).not.toBeInTheDocument();
          expect(mockedNavigateTo).not.toHaveBeenCalled();
        } else {
          expect(within(receipt).getByRole("link")).toHaveAttribute("href", "/portal/workflows/runs/accepted-1");
          expect(await screen.findByText("The action was written, but its canonical read-back is not visible yet. Refresh and verify before retrying.")).toBeInTheDocument();
          expect(screen.queryByText("navigation unavailable", { exact: false })).not.toBeInTheDocument();
        }
      }
      expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    }
  );

  it("applies lookup-backed context patch selections for DB-backed schedule context", async () => {
    const createWorkflowScheduleTrigger = jest.fn().mockResolvedValue({
      workflow_schedule_trigger_id: "trigger-lookup-1",
    });
    const clientId = "c112a901-3e75-47d2-9022-307fa68bd400";
    const senderId = "22222222-2222-4222-8222-222222222222";
    const listResource = jest.fn((resource: string) => {
      if (resource === "clients") {
        return Promise.resolve({
          items: [{ id: clientId, name: "Sample Organization" }],
        });
      }
      if (resource === "senders") {
        return Promise.resolve({
          items: [{ id: senderId, name: "Main Sender" }],
        });
      }
      return Promise.resolve({ items: [] });
    });
    const listLookupValues = jest.fn((category: string) => {
      if (category === "service_type") {
        return Promise.resolve([{ value: "delivery", label: "Delivery" }]);
      }
      return Promise.resolve([]);
    });

    mockedCreateUiClient.mockReturnValue({
      runWorkflowScheduleTrigger: jest.fn(),
      createWorkflowScheduleTrigger,
      updateResource: jest.fn(),
      listResource,
      listLookupValues,
    });

    renderWithIntl(
      <WorkflowScheduleTriggersPanel
        workflowTemplateId="template-1"
        triggers={[]}
        triggersTotal={0}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="schedule-panel"
      />
    );

    fireEvent.click(screen.getByTestId("schedule-panel-new"));

    const modal = await screen.findByTestId("schedule-panel-editor-modal");
    await waitFor(() => expect(listResource).toHaveBeenCalledWith("clients", {}, 100, 0, { key: "name", direction: "asc" }));
    await within(modal).findByRole("option", { name: "Sample Organization" });
    expect(listLookupValues).toHaveBeenCalledWith("service_type");
    const clientSelect = within(modal).getByLabelText("Client") as HTMLSelectElement;
    const senderSelect = within(modal).getByLabelText("Sender") as HTMLSelectElement;
    const serviceTypeSelect = within(modal).getByLabelText("Service type") as HTMLSelectElement;
    expect(within(clientSelect).getByRole("option", { name: "Sample Organization" })).toHaveValue(clientId);
    expect(within(senderSelect).getByRole("option", { name: "Main Sender" })).toHaveValue(senderId);
    expect(within(serviceTypeSelect).getByRole("option", { name: "Delivery" })).toHaveValue("delivery");
    expect(within(clientSelect).queryByRole("option", { name: clientId })).toBeNull();
    expect(within(senderSelect).queryByRole("option", { name: senderId })).toBeNull();
    expect(within(serviceTypeSelect).queryByRole("option", { name: "delivery" })).toBeNull();

    fireEvent.change(clientSelect, {
      target: { value: clientId },
    });
    fireEvent.change(senderSelect, {
      target: { value: senderId },
    });
    fireEvent.change(serviceTypeSelect, {
      target: { value: "delivery" },
    });
    expect(clientSelect).toHaveDisplayValue("Sample Organization");
    expect(senderSelect).toHaveDisplayValue("Main Sender");
    expect(serviceTypeSelect).toHaveDisplayValue("Delivery");
    expect(clientSelect).not.toHaveDisplayValue(clientId);
    expect(senderSelect).not.toHaveDisplayValue(senderId);
    expect(serviceTypeSelect).not.toHaveDisplayValue("delivery");

    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(createWorkflowScheduleTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          contextPatch: {
            client_id: clientId,
            sender_id: senderId,
            service_type: "delivery",
          },
        }),
      ),
    );
  });
});
