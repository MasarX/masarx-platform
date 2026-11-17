jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  useTranslations:
    (namespace?: string) =>
    (key: string) =>
      namespace ? `${namespace}.${key}` : key,
  createTranslator:
    ({ namespace }: { namespace?: string } = {}) =>
    (key: string) =>
      namespace ? `${namespace}.${key}` : key,
}));

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowRunLogsPanel } from "../../packages/ui/src/workflow-run-logs-panel";
import { renderWithIntl } from "./test-utils";

const labels = {
  tabs: { simple: "Simple", advanced: "Advanced" },
  summary: { stepsLabel: "Steps", issuesLabel: "Issues" },
  controls: {
    issuesOnly: "Issues only",
    replayLabel: "Replay presets",
    replayLatestIssue: "Replay latest issue",
    replayFirstIssue: "Replay first issue",
    replayAllIssues: "Replay all issues",
    replayModalTitle: "Replay workflow",
    replayModalDescription: "Replay failed steps using preset payloads.",
  },
  filters: {
    searchPlaceholder: "Search steps",
    statusLabel: "Status",
    statusAll: "All",
  },
  actions: {
    copyJson: "Copy JSON",
    downloadJson: "Download JSON",
    copySuccessTitle: "Copied",
    copyFailedTitle: "Copy failed",
    downloadFailedTitle: "Download failed",
  },
  empty: {
    title: "No steps yet",
    description: "This run has not recorded any step activity.",
  },
  emptyNoMatches: {
    title: "No matches",
    description: "No steps match the current filters.",
  },
  emptyNoIssues: {
    title: "No issues recorded",
    description: "This run has not recorded any step issues.",
  },
  emptyStepFilter: {
    title: "No logs for this step yet",
    description: "This run has not recorded any activity for the selected workflow step.",
  },
  step: {
    statusLabel: "Status",
    durationLabel: "Duration",
    attemptLabel: "Attempt",
    decisionLogLabel: "Decision log",
    openDecisionLog: "Open decision log",
    resultLabel: "Result",
    metadataLabel: "Metadata",
    errorLabel: "Error",
    notesLabel: "Notes",
    timestampsLabel: "Timestamps",
    enqueuedAtLabel: "Enqueued",
    startedAtLabel: "Started",
    completedAtLabel: "Completed",
    replayFromStep: "Replay from step",
    replayModalTitle: "Replay from step",
    replayModalDescription: "Retry this workflow from the selected failed step.",
  },
};

describe("WorkflowRunLogsPanel", () => {
  it("renders simple and advanced logs for workflow run steps", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <WorkflowRunLogsPanel
        steps={[
          {
            id: "step-1",
            sequence_order: 1,
            operation_name: "first_step",
            step_status: "completed",
            duration_ms: 1500,
          },
          {
            id: "step-2",
            sequence_order: 2,
            operation_name: "second_step",
            step_status: "failed",
            last_error: "boom",
            decision_log_id: "decision-2",
          },
        ]}
        appBasePath="/portal"
        labels={labels}
        testIdPrefix="run"
      />
    );

    const summary = screen.getByTestId("run-logs-summary");
    expect(summary).toHaveTextContent("Steps: 2");
    expect(summary).toHaveTextContent("Issues: 1");

    expect(screen.getByTestId("run-logs-tab-simple")).toBeInTheDocument();
    expect(screen.getByText("First Step")).toBeInTheDocument();
    expect(screen.getByText("Second Step")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open decision log" })).toHaveAttribute(
      "href",
      "/portal/resources/decision_log?id=decision-2"
    );

    await user.click(screen.getByTestId("run-logs-issues-toggle"));
    await waitFor(() => expect(summary).toHaveTextContent("Steps: 1"));
    await waitFor(() => expect(screen.queryByText("First Step")).not.toBeInTheDocument());
    expect(screen.getByText("Second Step")).toBeInTheDocument();

    await user.click(screen.getByTestId("run-logs-issues-toggle"));
    await waitFor(() => expect(summary).toHaveTextContent("Steps: 2"));

    await user.click(screen.getByRole("tab", { name: labels.tabs.advanced }));
    await waitFor(() => expect(screen.getByTestId("run-logs-advanced")).toBeVisible());
    expect(screen.getByTestId("run-logs-action-copy-json")).toBeInTheDocument();
    expect(screen.getByTestId("run-logs-action-download-json")).toBeInTheDocument();

    const search = screen.getByTestId("run-logs-filter-search");
    await user.type(search, "second");
    await waitFor(() => {
      expect(screen.queryByTestId("run-logs-step-step-1")).not.toBeInTheDocument();
      expect(screen.getByTestId("run-logs-step-step-2")).toBeInTheDocument();
    });

    await user.clear(search);
    await user.selectOptions(screen.getByTestId("run-logs-filter-status"), "failed");
    await waitFor(() => {
      expect(screen.queryByTestId("run-logs-step-step-1")).not.toBeInTheDocument();
      expect(screen.getByTestId("run-logs-step-step-2")).toBeInTheDocument();
    });

    const details = screen.getByTestId("run-logs-step-step-2");
    await user.click(within(details).getByText("Second Step"));
    expect(within(details).getByText("boom")).toBeInTheDocument();
  });

  it("renders fallback action when appBasePath is unsafe", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <WorkflowRunLogsPanel
        steps={[
          {
            id: "step-1",
            sequence_order: 1,
            operation_name: "first_step",
            step_status: "failed",
            last_error: "oops",
            decision_log_id: "decision-2",
          },
        ]}
        appBasePath="javascript:alert(1)"
        labels={labels}
        testIdPrefix="unsafe-run"
      />
    );

    const fallback = screen.getByText(labels.step.openDecisionLog);
    expect(fallback).toBeInTheDocument();
    expect(fallback.tagName.toLowerCase()).toBe("span");
    expect(screen.queryByRole("link", { name: labels.step.openDecisionLog })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: labels.tabs.advanced }));
    await waitFor(() =>
      expect(screen.getByTestId("unsafe-run-logs-advanced")).toBeInTheDocument()
    );
    expect(screen.getByText(labels.step.openDecisionLog).tagName.toLowerCase()).toBe("span");
    expect(
      screen.queryByRole("link", { name: labels.step.openDecisionLog })
    ).not.toBeInTheDocument();
  });

  it("shows a dedicated empty state when filtering issues only yields no results", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <WorkflowRunLogsPanel
        steps={[
          {
            id: "step-1",
            sequence_order: 1,
            operation_name: "first_step",
            step_status: "completed",
            duration_ms: 1500,
          },
        ]}
        appBasePath="/portal"
        labels={labels}
        testIdPrefix="run"
      />
    );

    await user.click(screen.getByTestId("run-logs-issues-toggle"));
    await waitFor(() => expect(screen.getByText(labels.emptyNoIssues.title)).toBeInTheDocument());
    expect(screen.getByText(labels.emptyNoIssues.description)).toBeInTheDocument();
  });

  it("shows a dedicated empty state when filtering to a template step with no logs", () => {
    renderWithIntl(
      <WorkflowRunLogsPanel
        steps={[
          {
            id: "step-1",
            sequence_order: 1,
            operation_name: "first_step",
            step_status: "completed",
          },
        ]}
        appBasePath="/portal"
        labels={labels}
        testIdPrefix="run"
        filterWorkflowTemplateStepId="template-step-1"
      />
    );

    expect(screen.getByText(labels.emptyStepFilter.title)).toBeInTheDocument();
    expect(screen.getByText(labels.emptyStepFilter.description)).toBeInTheDocument();
  });

  it("shows a dedicated empty state when advanced filters exclude every step", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <WorkflowRunLogsPanel
        steps={[
          {
            id: "step-1",
            sequence_order: 1,
            operation_name: "first_step",
            step_status: "completed",
          },
        ]}
        appBasePath="/portal"
        labels={labels}
        testIdPrefix="run"
      />
    );

    await user.click(screen.getByRole("tab", { name: labels.tabs.advanced }));
    await waitFor(() => expect(screen.getByTestId("run-logs-advanced")).toBeVisible());

    await user.type(screen.getByTestId("run-logs-filter-search"), "does-not-match");
    await waitFor(() => expect(screen.getByText(labels.emptyNoMatches.title)).toBeInTheDocument());
    expect(screen.getByText(labels.emptyNoMatches.description)).toBeInTheDocument();
  });

  it("shows replay action for failed steps when replay config is provided", async () => {
    renderWithIntl(
      <WorkflowRunLogsPanel
        steps={[
          {
            id: "step-ok",
            workflow_template_step_id: "template-step-ok",
            sequence_order: 1,
            operation_name: "first_step",
            step_status: "completed",
          },
          {
            id: "step-failed",
            workflow_template_step_id: "template-step-failed",
            sequence_order: 2,
            operation_name: "second_step",
            step_status: "failed",
            last_error: "boom",
          },
        ]}
        appBasePath="/portal"
        labels={labels}
        testIdPrefix="run"
        stepReplay={{
          workflowTemplateId: "template-1",
          workflowRunId: "run-1",
          payload: { shipment_id: "shipment-1" },
          capabilities: ["workflow_runs.write"],
        }}
      />
    );

    expect(
      screen.getByTestId("run-logs-step-replay-step-failed-test-run")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("run-logs-step-replay-step-ok-test-run")
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("run-logs-replay-latest-test-run")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("run-logs-replay-all-test-run")
    ).not.toBeInTheDocument();
  });

  it("shows replay presets for multiple failed steps and seeds batch payload", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <WorkflowRunLogsPanel
        steps={[
          {
            id: "step-failed-1",
            workflow_template_step_id: "template-step-failed-1",
            sequence_order: 2,
            operation_name: "second_step",
            step_status: "failed",
            last_error: "boom",
          },
          {
            id: "step-failed-2",
            workflow_template_step_id: "template-step-failed-2",
            sequence_order: 3,
            operation_name: "third_step",
            step_status: "failed",
            last_error: "still boom",
          },
        ]}
        appBasePath="/portal"
        labels={labels}
        testIdPrefix="run"
        stepReplay={{
          workflowTemplateId: "template-1",
          workflowRunId: "run-1",
          payload: { shipment_id: "shipment-1" },
          capabilities: ["workflow_runs.write"],
        }}
      />
    );

    expect(
      screen.getByTestId("run-logs-replay-first-test-run")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("run-logs-replay-latest-test-run")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("run-logs-replay-all-test-run")
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("run-logs-replay-all-test-run"));
    const payloadEditor = await screen.findByTestId(
      "run-logs-replay-all-test-run-payload"
    );
    const payloadText = (payloadEditor as HTMLTextAreaElement).value;
    expect(payloadText).toContain("\"mode\": \"failed_steps_batch\"");
    expect(payloadText).toContain("\"source_workflow_run_step_ids\"");
    expect(payloadText).toContain("\"step-failed-1\"");
    expect(payloadText).toContain("\"step-failed-2\"");
  });

  it("shows replay audit metadata when replay payload includes _ui_replay context", () => {
    renderWithIntl(
      <WorkflowRunLogsPanel
        steps={[
          {
            id: "step-failed",
            workflow_template_step_id: "template-step-failed",
            sequence_order: 2,
            operation_name: "second_step",
            step_status: "failed",
            last_error: "boom",
          },
        ]}
        appBasePath="/portal"
        labels={labels}
        testIdPrefix="run"
        stepReplay={{
          workflowTemplateId: "template-1",
          workflowRunId: "run-1",
          payload: {
            _ui_replay: {
              mode: "latest_failed_step",
              source_run_id: "run-1",
              source_workflow_run_step_id: "step-failed",
            },
          },
          capabilities: ["workflow_runs.write"],
        }}
      />
    );

    const audit = screen.getByTestId("run-logs-replay-audit");
    expect(audit).toHaveTextContent("Replay presets");
    expect(audit).toHaveTextContent("latest_failed_step");
    expect(audit).toHaveTextContent("run-1");
    expect(audit).toHaveTextContent("Steps: 1");
    expect(audit).toHaveTextContent("Issues: 1");
  });
});
