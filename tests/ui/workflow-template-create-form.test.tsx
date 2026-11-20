jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(),
}));

const push = jest.fn();
const mockInvalidateWorkflowTemplates = jest.fn();
const mockTemplateToast = jest.fn();
jest.mock("../../packages/ui/src/hooks/use-resource-query", () => ({
  useResourceListInvalidate: jest.fn(() => mockInvalidateWorkflowTemplates),
}));
jest.mock("../../packages/ui/src/use-toast", () => ({
  ...jest.requireActual("../../packages/ui/src/use-toast"),
  useToast: () => ({ toast: mockTemplateToast }),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: jest.fn() }),
}));

import { createUiClient } from "@masarx/api";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { WorkflowTemplateCreateForm } from "../../packages/ui/src/workflow-template-create-form";
import { useResourceListInvalidate } from "../../packages/ui/src/hooks/use-resource-query";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiClient = createUiClient as unknown as jest.Mock;

describe("WorkflowTemplateCreateForm", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    push.mockReset();
    mockInvalidateWorkflowTemplates.mockReset().mockResolvedValue(undefined);
    (useResourceListInvalidate as jest.Mock).mockReturnValue(mockInvalidateWorkflowTemplates);
  });

  it("creates workflow template and navigates to studio", async () => {
    const createWorkflowTemplate = jest.fn().mockResolvedValue({
      status: "ok",
      workflow_template_id: "template-123",
    });

    mockedCreateUiClient.mockReturnValue({
      createWorkflowTemplate,
    });

    renderWithIntl(
      <WorkflowTemplateCreateForm
        appBasePath="/console"
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        templates={[]}
        testIdPrefix="workflow-template-create"
      />
    );

    fireEvent.change(screen.getByTestId("workflow-template-create-name"), {
      target: { value: "new_workflow_v1" },
    });

    fireEvent.click(screen.getByTestId("workflow-template-create-submit"));

    await waitFor(() => expect(createWorkflowTemplate).toHaveBeenCalled());

    expect(createWorkflowTemplate).toHaveBeenCalledWith({
      name: "new_workflow_v1",
      description: null,
      cloneFrom: null,
    });

    await waitFor(() => expect(push).toHaveBeenCalledWith("/console/workflows/templates/template-123"));
    expect(useResourceListInvalidate).toHaveBeenCalledWith("workflow_templates");
    expect(mockInvalidateWorkflowTemplates).toHaveBeenCalledTimes(1);
    expect(mockInvalidateWorkflowTemplates.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0]);
  });

  it("requires a name before submitting", async () => {
    const createWorkflowTemplate = jest.fn();
    mockedCreateUiClient.mockReturnValue({
      createWorkflowTemplate,
    });

    renderWithIntl(
      <WorkflowTemplateCreateForm
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        templates={[]}
        testIdPrefix="workflow-template-create"
      />
    );

    fireEvent.click(screen.getByTestId("workflow-template-create-submit"));

    await waitFor(() => {
      expect(createWorkflowTemplate).not.toHaveBeenCalled();
    });
  });

  it("retries once when the first attempt times out", async () => {
    jest.useFakeTimers();
    const originalTimeout = process.env.MASARX_UI_RPC_TIMEOUT_MS;
    process.env.MASARX_UI_RPC_TIMEOUT_MS = "5";

    try {
      const createWorkflowTemplate = jest
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue({
          status: "ok",
          workflow_template_id: "template-456",
        });

      mockedCreateUiClient.mockReturnValue({
        createWorkflowTemplate,
      });

      renderWithIntl(
        <WorkflowTemplateCreateForm
          appBasePath="/console"
          capabilities={["workflow_runs.write"]}
          capabilityWrite="workflow_runs.write"
          templates={[]}
          testIdPrefix="workflow-template-create"
        />
      );

      fireEvent.change(screen.getByTestId("workflow-template-create-name"), {
        target: { value: "retry_workflow_v1" },
      });

      fireEvent.click(screen.getByTestId("workflow-template-create-submit"));

      await act(async () => {
        jest.advanceTimersByTime(10);
      });

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });

      await waitFor(() => expect(createWorkflowTemplate).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(push).toHaveBeenCalledWith("/console/workflows/templates/template-456")
      );
    } finally {
      process.env.MASARX_UI_RPC_TIMEOUT_MS = originalTimeout;
      jest.useRealTimers();
    }
  });

  it("locks submit button while request is in progress", async () => {
    const createWorkflowTemplate = jest
      .fn()
      .mockImplementation(() => new Promise(() => {}));

    mockedCreateUiClient.mockReturnValue({
      createWorkflowTemplate,
    });

    renderWithIntl(
      <WorkflowTemplateCreateForm
        appBasePath="/console"
        capabilities={[
          "workflow_runs.write",
        ]}
        capabilityWrite="workflow_runs.write"
        templates={[]}
        testIdPrefix="workflow-template-create"
      />
    );

    fireEvent.change(screen.getByTestId("workflow-template-create-name"), {
      target: { value: "retry_lock_workflow_v1" },
    });

    const submitButton = screen.getByTestId(
      "workflow-template-create-submit"
    );

    fireEvent.click(submitButton);

    await waitFor(() => expect(createWorkflowTemplate).toHaveBeenCalledTimes(1));

    expect(submitButton).toBeDisabled();

    fireEvent.click(submitButton);

    expect(createWorkflowTemplate).toHaveBeenCalledTimes(1);
  });

  it("prompts before navigation when create form has unsaved edits", () => {
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);

    mockedCreateUiClient.mockReturnValue({
      createWorkflowTemplate: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateCreateForm
        appBasePath="/console"
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        templates={[]}
        testIdPrefix="workflow-template-create"
      />
    );

    fireEvent.change(screen.getByTestId("workflow-template-create-name"), {
      target: { value: "new_workflow_v1" },
    });

    const externalLink = document.createElement("a");
    externalLink.href = "/console/workflows";
    externalLink.textContent = "leave";
    document.body.appendChild(externalLink);

    fireEvent.click(externalLink);

    expect(confirmSpy).toHaveBeenCalledWith(
      "You have unsaved workflow template edits. Leave anyway?"
    );

    externalLink.remove();
    confirmSpy.mockRestore();
  });
});

describe("committed template create readback", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockInvalidateWorkflowTemplates.mockResolvedValue(undefined);
    (useResourceListInvalidate as jest.Mock).mockReturnValue(mockInvalidateWorkflowTemplates);
  });
  test.each(["success", "refresh failure", "unsafe navigation", "navigation failure"])(
    "confirmed creation remains pristine after %s without repeating the RPC", async (scenario) => {
      const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
      const create = jest.fn().mockResolvedValue({ workflow_template_id: "created-1" });
      mockedCreateUiClient.mockReturnValue({ createWorkflowTemplate: create });
      if (scenario === "refresh failure") mockInvalidateWorkflowTemplates.mockRejectedValue(new Error("refresh offline"));
      if (scenario === "navigation failure") push.mockImplementation(() => { throw new Error("navigation unavailable"); });
      const anchor = document.createElement("a");
      anchor.href = "/console/workflows";
      anchor.addEventListener("click", (event) => event.preventDefault());
      document.body.appendChild(anchor);
      try {
        renderWithIntl(<WorkflowTemplateCreateForm appBasePath={scenario === "unsafe navigation" ? "javascript:alert(1)" : "/console"}
          capabilities={["workflow_runs.write"]} capabilityWrite="workflow_runs.write"
          templates={[{ id: "source-1", name: "Source" }]} testIdPrefix="saved" />);
        fireEvent.change(screen.getByTestId("saved-name"), { target: { value: "Saved template" } });
        fireEvent.change(screen.getByTestId("saved-description"), { target: { value: "Saved description" } });
        fireEvent.change(screen.getByTestId("saved-clone"), { target: { value: "source-1" } });
        fireEvent.click(screen.getByTestId("saved-submit"));
        await waitFor(() => expect(screen.getByTestId("saved-submit")).toBeEnabled());
        expect(create).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("saved-name")).toHaveValue("");
        expect(screen.getByTestId("saved-description")).toHaveValue("");
        expect(screen.getByTestId("saved-clone")).toHaveValue("");
        fireEvent.click(anchor);
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(mockTemplateToast).toHaveBeenCalledWith(expect.objectContaining({
          tone: scenario === "success" ? "success" : "warning",
          title: "Workflow template created.",
        }));
        expect(mockTemplateToast.mock.calls.some(([toast]) => toast.tone === "error")).toBe(false);
        if (scenario === "refresh failure" || scenario === "unsafe navigation") expect(push).not.toHaveBeenCalled();
      } finally {
        anchor.remove();
        confirmSpy.mockRestore();
      }
    }
  );

  test("navigation waits for template-list invalidation to settle", async () => {
    let settle!: () => void;
    mockInvalidateWorkflowTemplates.mockReturnValue(new Promise<void>((resolve) => { settle = resolve; }));
    const create = jest.fn().mockResolvedValue({ workflow_template_id: "deferred-1" });
    mockedCreateUiClient.mockReturnValue({ createWorkflowTemplate: create });
    renderWithIntl(<WorkflowTemplateCreateForm appBasePath="/console"
      capabilities={["workflow_runs.write"]} capabilityWrite="workflow_runs.write" testIdPrefix="deferred" />);
    fireEvent.change(screen.getByTestId("deferred-name"), { target: { value: "Deferred template" } });
    fireEvent.click(screen.getByTestId("deferred-submit"));
    await waitFor(() => expect(mockInvalidateWorkflowTemplates).toHaveBeenCalledTimes(1));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId("deferred-submit")).toBeDisabled();
    expect(screen.getByTestId("deferred-name")).toHaveValue("");
    await act(async () => { settle(); });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/console/workflows/templates/deferred-1"));
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("actual create failure preserves unsaved inputs and skips refresh", async () => {
    mockedCreateUiClient.mockReturnValue({ createWorkflowTemplate: jest.fn().mockRejectedValue(new Error("Permission denied")) });
    renderWithIntl(<WorkflowTemplateCreateForm appBasePath="/console"
      capabilities={["workflow_runs.write"]} capabilityWrite="workflow_runs.write" testIdPrefix="failed" />);
    fireEvent.change(screen.getByTestId("failed-name"), { target: { value: "Unsaved template" } });
    fireEvent.click(screen.getByTestId("failed-submit"));
    await waitFor(() => expect(mockTemplateToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" })));
    expect(screen.getByTestId("failed-name")).toHaveValue("Unsaved template");
    expect(mockInvalidateWorkflowTemplates).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
  it("keeps the selected clone label user-friendly when a template is preselected", () => {
    mockedCreateUiClient.mockReturnValue({
      createWorkflowTemplate: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateCreateForm
        appBasePath="/console"
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        templates={[
          {
            id: "wf-template-456",
            name: "Marketplace Dispute Flow",
            status: "ready_for_publish",
            version: 7,
          },
        ]}
        initialCloneFromId="wf-template-456"
        testIdPrefix="workflow-template-create"
      />
    );

    const cloneSelect = screen.getByTestId(
      "workflow-template-create-clone"
    ) as HTMLSelectElement;
    const selectedOption = cloneSelect.selectedOptions[0];

    expect(selectedOption?.value).toBe("wf-template-456");
    expect(selectedOption?.textContent).toBe(
      "Marketplace Dispute Flow (Ready For Publish v7)"
    );
    expect(selectedOption?.textContent).not.toContain("ready_for_publish");
    expect(selectedOption?.textContent).not.toContain("wf-template-456");
  });
});
