jest.mock("../../packages/ui/src/clipboard", () => ({
  copyTextToClipboard: jest.fn(),
}));

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowRunProvenancePanel } from "../../packages/ui/src/workflow-run-provenance-panel";
import { copyTextToClipboard } from "../../packages/ui/src/clipboard";
import { renderWithIntl } from "./test-utils";

const mockedCopyTextToClipboard = copyTextToClipboard as unknown as jest.Mock;

const labels = {
  title: "Provenance",
  description: "Understand what triggered this run and follow its source.",
  triggeredVia: "Triggered via",
  sources: {
    manual: "Manual",
    webhook: "Webhook",
    schedule: "Schedule",
    scheduleManual: "Schedule (manual)",
    workflowRunTrigger: "Workflow run trigger",
    unknown: "Unknown",
  },
  fields: {
    correlationId: "Tracking key",
    requestedBy: "Requested by",
    requestContextId: "Request context",
    scheduleTriggerId: "Schedule reference",
    runTriggerId: "Linked run rule",
    triggerFireId: "Schedule occurrence",
    sourceRunId: "Previous activity",
    sourceStatus: "Previous activity status",
    sourceCompletedAt: "Previous activity completed",
    idempotencyKey: "Duplicate check key",
    scope: "Scope",
  },
  actions: {
    openRun: "Open run",
    openSchedule: "Open schedule",
    openTrigger: "Open trigger",
    openFire: "Open fire",
    showRaw: "Show request details",
    copy: "Copy",
    copySuccessTitle: "Copied to clipboard.",
    copyFailedTitle: "Copy failed.",
  },
};

describe("WorkflowRunProvenancePanel", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders correlation id, idempotency key, and scope and allows copying", async () => {
    const user = userEvent.setup();
    mockedCopyTextToClipboard.mockResolvedValue(true);

    renderWithIntl(
      <WorkflowRunProvenancePanel
        workflowRun={{
          id: "run-1",
          triggered_by_request_id: "corr-123",
          context: {
            trigger_source: "webhook",
            requested_by: "user@example.com",
            request_context_id: "reqctx-123",
            idempotency_key: "idem-123",
            scope_type: "client",
            scope_id: "client-1",
          },
        }}
        appBasePath="/portal"
        labels={labels}
        testIdPrefix="run"
      />
    );

    expect(screen.getByTestId("run-provenance")).toBeInTheDocument();
    expect(screen.getByTestId("run-provenance-correlation-id")).toBeInTheDocument();
    expect(screen.getByTestId("run-provenance-idempotency-key")).toBeInTheDocument();
    expect(screen.getByTestId("run-provenance-scope")).toBeInTheDocument();

    await user.click(screen.getByTestId("run-provenance-correlation-id-copy"));
    expect(mockedCopyTextToClipboard).toHaveBeenCalledWith("corr-123");

    await user.click(screen.getByTestId("run-provenance-idempotency-key-copy"));
    expect(mockedCopyTextToClipboard).toHaveBeenCalledWith("idem-123");

    await user.click(screen.getByTestId("run-provenance-scope-copy"));
    expect(mockedCopyTextToClipboard).toHaveBeenCalledWith("client:client-1");
  });

  it("renders trusted provenance action links when appBasePath is safe", () => {
    renderWithIntl(
      <WorkflowRunProvenancePanel
        workflowRun={{
          id: "run-1",
          triggered_by_request_id: "corr-123",
          context: {
            scope_type: "client",
            scope_id: "client-1",
            workflow_schedule_trigger_id: "schedule-1",
            workflow_run_trigger_id: "trigger-1",
            workflow_trigger_fire_id: "fire-1",
            source: {
              workflow_run_id: "run-2",
            },
          },
          trigger_source: "workflow_run_trigger",
        }}
        appBasePath="/portal"
        labels={labels}
        testIdPrefix="run"
      />
    );

    const runIdRow = screen.getByTestId("run-provenance-run-id");
    expect(runIdRow.querySelector("a")).toHaveAttribute(
      "href",
      "/portal/workflows/runs/run-1"
    );
    expect(screen.getByRole("link", { name: "Open schedule" })).toHaveAttribute(
      "href",
      "/portal/resources/workflow_schedule_triggers?id=schedule-1"
    );
  });

  it("hides provenance action links when appBasePath is unsafe", () => {
    renderWithIntl(
      <WorkflowRunProvenancePanel
        workflowRun={{
          id: "run-1",
          triggered_by_request_id: "corr-123",
          context: {
            scope_type: "client",
            scope_id: "client-1",
            workflow_schedule_trigger_id: "schedule-1",
            workflow_run_trigger_id: "trigger-1",
            workflow_trigger_fire_id: "fire-1",
            source: {
              workflow_run_id: "run-2",
            },
          },
          trigger_source: "workflow_run_trigger",
        }}
        appBasePath="javascript:alert(1)"
        labels={labels}
        testIdPrefix="run"
      />
    );

    expect(screen.queryByRole("link", { name: "Open run" })).toBeNull();
  });
});
