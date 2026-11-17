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

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator: () => (key: string) => {
    if (key === "actions.testRun") return "Run test";
    if (key === "actions.testRunModal.title") return "Run workflow";
    if (key === "actions.testRunModal.description") return "Execute workflow run";
    if (key === "actions.testRunModal.templateNotActive") return "Template is not active.";
    if (key === "actions.testRunModal.payloadLabel") return "Payload";
    if (key === "actions.testRunModal.payloadPlaceholder") return "{}";
    if (key === "actions.testRunModal.allowInactiveLabel") return "Allow inactive template";
    if (key === "actions.testRunModal.allowInactiveHint") return "Run even when inactive.";
    if (key === "actions.testRunModal.cancel") return "Cancel";
    if (key === "actions.testRunModal.run") return "Run";
    if (key === "actions.testRunModal.running") return "Running...";
    if (key === "toast.testRun.invalidJsonTitle") return "Invalid JSON";
    if (key === "toast.testRun.invalidJsonDescription") return "Fix JSON and retry.";
    if (key === "toast.testRun.errorTitle") return "Run failed";
    if (key === "toast.testRun.errorMissingRun") return "Missing workflow run id.";
    if (key === "toast.testRun.successTitle") return "Run started";
    return key;
  },
}));

import { screen } from "@testing-library/react";
import { WorkflowRunPage } from "../../packages/ui/src/workflow-run-page";
import { createUiServerClient } from "@masarx/api/server";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiServerClient = createUiServerClient as unknown as jest.Mock;

describe("WorkflowRunPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("surfaces output links found in workflow run context and metadata", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({ resources: [] }),
      me: jest.fn().mockResolvedValue({ capabilities: [] }),
      settingsPreview: jest.fn().mockResolvedValue({ value: null }),
      getResource: jest.fn().mockResolvedValue({
        id: "run-1",
        workflow_status: "completed",
        context: {
          label_print: {
            bundle_response: {
              signed_url: "https://example.com/labels.pdf",
            },
          },
        },
        metadata: {
          results: [{ url: "https://example.com/extra" }],
        },
      }),
      listResource: jest.fn().mockResolvedValue({
        resource: "workflow_run_steps",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
    });

    const node = await WorkflowRunPage({
      runId: "run-1",
      appBasePath: "/console",
      t: (key) => key,
      includeTraceLink: false,
      testIdPrefix: "workflow-run",
    });

    renderWithIntl(node);

    expect(screen.getByText("https://example.com/labels.pdf")).toBeInTheDocument();
    const openLinks = screen.getAllByRole("link", {
      name: "observability.workflowRun.outputs.open",
    });
    expect(
      openLinks.some(
        (link) => link.getAttribute("href") === "https://example.com/labels.pdf"
      )
    ).toBe(true);
  });

  it("renders replay action and template shortcut when workflow template id is available", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({ resources: [] }),
      me: jest.fn().mockResolvedValue({ capabilities: ["workflow_runs.write"] }),
      settingsPreview: jest.fn().mockResolvedValue({ value: null }),
      getResource: jest.fn().mockResolvedValue({
        id: "run-2",
        workflow_template_id: "template-2",
        payload: { source: "replay" },
      }),
      listResource: jest.fn().mockResolvedValue({
        resource: "workflow_run_steps",
        keys: [
          "id",
          "workflow_template_step_id",
          "sequence_order",
          "step_status",
        ],
        items: [
          {
            id: "step-1",
            workflow_template_step_id: "tmpl-step-1",
            sequence_order: 1,
            step_status: "failed",
          },
          {
            id: "step-2",
            workflow_template_step_id: "tmpl-step-2",
            sequence_order: 2,
            step_status: "failed",
          },
        ],
        limit: 25,
        offset: 0,
        total: 2,
      }),
    });

    const node = await WorkflowRunPage({
      runId: "run-2",
      appBasePath: "/console",
      t: (key) => key,
      includeTraceLink: false,
      testIdPrefix: "workflow-run",
    });

    renderWithIntl(node);

    expect(
      screen.getByTestId("workflow-run-replay-test-run")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("workflow-run-replay-latest-test-run")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("workflow-run-replay-first-test-run")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("workflow-run-replay-all-test-run")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("workflow-run-steps-replay-latest-test-run")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("workflow-run-steps-replay-all-test-run")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "observability.workflowRun.openTemplate" })
    ).toHaveAttribute("href", "/console/workflows/templates/template-2");
  });

  it("renders replay audit badges when _ui_replay payload metadata is present", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({ resources: [] }),
      me: jest.fn().mockResolvedValue({ capabilities: ["workflow_runs.write"] }),
      settingsPreview: jest.fn().mockResolvedValue({ value: null }),
      getResource: jest.fn().mockResolvedValue({
        id: "run-2a",
        workflow_template_id: "template-2",
        payload: {
          _ui_replay: {
            mode: "latest_failed_step",
            source_run_id: "123e4567-e89b-12d3-a456-426614174000",
          },
        },
      }),
      listResource: jest.fn().mockResolvedValue({
        resource: "workflow_run_steps",
        keys: [
          "id",
          "workflow_template_step_id",
          "sequence_order",
          "step_status",
        ],
        items: [
          {
            id: "step-1",
            workflow_template_step_id: "tmpl-step-1",
            sequence_order: 1,
            step_status: "failed",
          },
        ],
        limit: 25,
        offset: 0,
        total: 1,
      }),
    });

    const node = await WorkflowRunPage({
      runId: "run-2a",
      appBasePath: "/console",
      t: (key) => key,
      includeTraceLink: false,
      testIdPrefix: "workflow-run",
    });

    renderWithIntl(node);

    expect(
      screen.getByText("observability.workflowRun.logs.controls.replayLabel: latest_failed_step")
    ).toBeInTheDocument();
    expect(screen.getAllByText("REF-123E4000").length).toBeGreaterThan(0);
    expect(
      screen.getByTestId("workflow-run-steps-replay-audit")
    ).toBeInTheDocument();
  });

  it("does not render replay action when workflow template id is missing", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({ resources: [] }),
      me: jest.fn().mockResolvedValue({ capabilities: ["workflow_runs.write"] }),
      settingsPreview: jest.fn().mockResolvedValue({ value: null }),
      getResource: jest.fn().mockResolvedValue({
        id: "run-3",
      }),
      listResource: jest.fn().mockResolvedValue({
        resource: "workflow_run_steps",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
    });

    const node = await WorkflowRunPage({
      runId: "run-3",
      appBasePath: "/portal",
      t: (key) => key,
      includeTraceLink: false,
      testIdPrefix: "workflow-run",
    });

    renderWithIntl(node);

    expect(screen.queryByTestId("workflow-run-replay-test-run")).not.toBeInTheDocument();
  });

  it("hides unsafe appBasePath navigation links", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({ resources: [] }),
      me: jest.fn().mockResolvedValue({ capabilities: ["workflow_runs.write"] }),
      settingsPreview: jest.fn().mockResolvedValue({ value: null }),
      getResource: jest.fn().mockResolvedValue({
        id: "run-4",
        workflow_template_id: "template-4",
        payload: { source: "replay" },
      }),
      listResource: jest.fn().mockResolvedValue({
        resource: "workflow_run_steps",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
    });

    const node = await WorkflowRunPage({
      runId: "run-4",
      appBasePath: "javascript:alert(1)",
      t: (key) => key,
      includeTraceLink: false,
      testIdPrefix: "workflow-run",
    });

    renderWithIntl(node);

    expect(
      screen.queryByRole("link", { name: "observability.workflowRun.openTemplate" })
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "observability.workflowRun.steps.openFullView" })
    ).toBeNull();
    expect(screen.getByText("observability.workflowRun.openTemplate")).toBeInTheDocument();
  });
});
