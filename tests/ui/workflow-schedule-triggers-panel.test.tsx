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
    expect(mockedNavigateTo).toHaveBeenCalledWith("/portal/workflows/runs/run-123");
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
  });
});
