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

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(),
  WILDCARD_CAPABILITY: "*",
  resolveCapabilitySet: (values?: string[] | null) =>
    new Set(Array.isArray(values) ? values : []),
  hasCapability: (capabilitySet: Set<string>, capability: string) =>
    capabilitySet.has("*") || capabilitySet.has(capability),
}));

jest.mock("../../packages/ui/src/navigate", () => ({
  navigateTo: jest.fn(),
}));

jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator: () => (key: string) => {
    const table: Record<string, string> = {
      "actions.testRun": "Run test",
      "actions.changeStatus": "Change status",
      "actions.statusModal.title": "Change workflow status",
      "actions.statusModal.description": "Record an audited lifecycle transition.",
      "actions.statusModal.statusLabel": "Status",
      "actions.statusModal.statuses.draft": "Draft",
      "actions.statusModal.statuses.active": "Active",
      "actions.statusModal.statuses.archived": "Archived",
      "actions.statusModal.reasonLabel": "Reason",
      "actions.statusModal.cancel": "Cancel",
      "actions.statusModal.save": "Save",
      "actions.statusModal.saving": "Saving...",
      "actions.testRunModal.title": "Run workflow",
      "actions.testRunModal.description": "Execute workflow run",
      "actions.testRunModal.templateNotActive": "Template is not active.",
      "actions.testRunModal.payloadLabel": "Payload",
      "actions.testRunModal.payloadPlaceholder": "{}",
      "actions.testRunModal.allowInactiveLabel": "Allow inactive template",
      "actions.testRunModal.allowInactiveHint": "Run even when inactive.",
      "actions.testRunModal.cancel": "Cancel",
      "actions.testRunModal.run": "Run",
      "actions.testRunModal.running": "Running...",
      "toast.testRun.invalidJsonTitle": "Invalid JSON",
      "toast.testRun.invalidJsonDescription": "Fix JSON and retry.",
      "toast.testRun.errorTitle": "Run failed",
      "toast.testRun.errorMissingRun": "Missing workflow run id.",
      "toast.testRun.successTitle": "Run started",
      "toast.status.successTitle": "Workflow status updated",
      "toast.status.errorTitle": "Unable to update workflow status",
    };
    return table[key] ?? key;
  },
}));

import { createUiClient } from "@masarx/api";
import { navigateTo } from "../../packages/ui/src/navigate";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { WorkflowTemplateStudioActions } from "../../packages/ui/src/workflow-template-studio-actions";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiClient = createUiClient as unknown as jest.Mock;
const mockedNavigateTo = navigateTo as unknown as jest.Mock;

describe("WorkflowTemplateStudioActions", () => {
  it("offers the marketplace publication link only with capability and a safe app route", () => {
    const { rerender } = renderWithIntl(<WorkflowTemplateStudioActions templateId="template/1" capabilities={["automation_marketplace.publish"]} appBasePath="/console" />);
    expect(screen.getByRole("link", { name: "publish" })).toHaveAttribute("href", "/console/automation/marketplace/publish?asset_kind=workflow_template&source_id=template%2F1");
    rerender(<WorkflowTemplateStudioActions templateId="template/1" capabilities={[]} appBasePath="/console" />);
    expect(screen.queryByRole("link", { name: "publish" })).not.toBeInTheDocument();
    rerender(<WorkflowTemplateStudioActions templateId="template/1" capabilities={["automation_marketplace.publish"]} appBasePath="//untrusted.example" />);
    expect(screen.queryByRole("link", { name: "publish" })).not.toBeInTheDocument();
  });
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("disables test run when capability is missing", () => {
    mockedCreateUiClient.mockReturnValue({
      startWorkflowRun: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStudioActions
        templateId="template-1"
        templateStatus="active"
        capabilities={[]}
        appBasePath="/console"
      />
    );

    expect(screen.getByRole("button", { name: "Run test" })).toBeDisabled();
  });

  it("requires a reason and uses the dedicated status lifecycle method", async () => {
    const setWorkflowTemplateStatus = jest.fn().mockResolvedValue({
      status: "ok", changed: true, workflow_template_id: "template-1", next_status: "archived",
    });
    mockedCreateUiClient.mockReturnValue({ startWorkflowRun: jest.fn(), setWorkflowTemplateStatus });
    renderWithIntl(
      <WorkflowTemplateStudioActions templateId="template-1" templateStatus="draft"
        capabilities={["workflow_runs.write"]} appBasePath="/console"
        testIdPrefix="workflow-template-actions" />
    );
    fireEvent.click(screen.getByTestId("workflow-template-actions-status"));
    fireEvent.change(screen.getByTestId("workflow-template-actions-status-select"), {
      target: { value: "archived" },
    });
    expect(screen.getByTestId("workflow-template-actions-status-submit")).toBeDisabled();
    fireEvent.change(screen.getByTestId("workflow-template-actions-status-reason"), {
      target: { value: "Retire obsolete workflow" },
    });
    fireEvent.click(screen.getByTestId("workflow-template-actions-status-submit"));
    await waitFor(() => expect(setWorkflowTemplateStatus).toHaveBeenCalledWith({
      workflowTemplateId: "template-1", status: "archived", reason: "Retire obsolete workflow",
    }));
  });

  it("starts an active workflow run and navigates to run page", async () => {
    const startWorkflowRun = jest.fn().mockResolvedValue({
      status: "workflow_started",
      workflow_run_id: "run-1",
    });
    mockedCreateUiClient.mockReturnValue({
      startWorkflowRun,
    });

    renderWithIntl(
      <WorkflowTemplateStudioActions
        templateId="template-1"
        templateStatus="active"
        capabilities={["workflow_runs.write"]}
        appBasePath="/console"
        testIdPrefix="workflow-template-actions"
      />
    );

    fireEvent.click(screen.getByTestId("workflow-template-actions-test-run"));

    fireEvent.change(screen.getByTestId("workflow-template-actions-test-run-payload"), {
      target: { value: "{\"foo\":\"bar\"}" },
    });

    fireEvent.click(screen.getByTestId("workflow-template-actions-test-run-submit"));

    await waitFor(() => expect(startWorkflowRun).toHaveBeenCalled());

    expect(startWorkflowRun).toHaveBeenCalledWith({
      workflowTemplateId: "template-1",
      payload: { foo: "bar" },
      requireActive: true,
    });

    expect(mockedNavigateTo).toHaveBeenCalledWith("/console/workflows/runs/run-1");
  });

  it("blocks unsafe workflow run destinations", async () => {
    const startWorkflowRun = jest.fn().mockResolvedValue({
      status: "workflow_started",
      workflow_run_id: "run-1",
    });
    mockedCreateUiClient.mockReturnValue({
      startWorkflowRun,
    });

    renderWithIntl(
      <WorkflowTemplateStudioActions
        templateId="template-1"
        templateStatus="active"
        capabilities={["workflow_runs.write"]}
        appBasePath="javascript:alert(1)"
        testIdPrefix="workflow-template-actions"
      />
    );

    fireEvent.click(screen.getByTestId("workflow-template-actions-test-run"));

    fireEvent.change(screen.getByTestId("workflow-template-actions-test-run-payload"), {
      target: { value: "{\"foo\":\"bar\"}" },
    });

    fireEvent.click(screen.getByTestId("workflow-template-actions-test-run-submit"));

    await waitFor(() => expect(startWorkflowRun).toHaveBeenCalled());
    expect(mockedNavigateTo).not.toHaveBeenCalled();
  });

  it("starts an active workflow run and navigates to trace page when correlation exists", async () => {
    const startWorkflowRun = jest.fn().mockResolvedValue({
      status: "workflow_started",
      workflow_run_id: "run-1",
      correlation_id: "corr-1",
    });
    mockedCreateUiClient.mockReturnValue({
      startWorkflowRun,
    });

    renderWithIntl(
      <WorkflowTemplateStudioActions
        templateId="template-1"
        templateStatus="active"
        capabilities={["workflow_runs.write"]}
        appBasePath="/console"
        testIdPrefix="workflow-template-actions"
      />
    );

    fireEvent.click(screen.getByTestId("workflow-template-actions-test-run"));

    fireEvent.change(screen.getByTestId("workflow-template-actions-test-run-payload"), {
      target: { value: "{\"foo\":\"bar\"}" },
    });

    fireEvent.click(screen.getByTestId("workflow-template-actions-test-run-submit"));

    await waitFor(() => expect(startWorkflowRun).toHaveBeenCalled());

    expect(mockedNavigateTo).toHaveBeenCalledWith(
      "/console/observability/trace/corr-1"
    );
  });

  it("defaults to preview mode when template is not active", async () => {
    const startWorkflowRun = jest.fn().mockResolvedValue({
      status: "workflow_started",
      workflow_run_id: "run-2",
    });
    mockedCreateUiClient.mockReturnValue({
      startWorkflowRun,
    });

    renderWithIntl(
      <WorkflowTemplateStudioActions
        templateId="template-2"
        templateStatus="draft"
        capabilities={["workflow_runs.write"]}
        appBasePath="/portal"
        testIdPrefix="workflow-template-actions"
      />
    );

    fireEvent.click(screen.getByTestId("workflow-template-actions-test-run"));

    fireEvent.click(screen.getByTestId("workflow-template-actions-test-run-submit"));

    await waitFor(() => expect(startWorkflowRun).toHaveBeenCalled());

    expect(startWorkflowRun).toHaveBeenCalledWith({
      workflowTemplateId: "template-2",
      payload: {},
      requireActive: false,
    });

    expect(mockedNavigateTo).toHaveBeenCalledWith("/portal/workflows/runs/run-2");
  });

  it("prefills payload editor with provided default payload", () => {
    mockedCreateUiClient.mockReturnValue({
      startWorkflowRun: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStudioActions
        templateId="template-3"
        templateStatus="active"
        capabilities={["workflow_runs.write"]}
        appBasePath="/console"
        defaultPayload={{ replay: true, source_run_id: "run-3" }}
        testIdPrefix="workflow-template-actions"
      />
    );

    fireEvent.click(screen.getByTestId("workflow-template-actions-test-run"));

    expect(
      screen.getByTestId("workflow-template-actions-test-run-payload")
    ).toHaveValue('{\n  "replay": true,\n  "source_run_id": "run-3"\n}');
  });
});
