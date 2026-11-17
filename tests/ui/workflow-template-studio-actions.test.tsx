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
