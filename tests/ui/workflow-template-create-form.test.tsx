jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(),
}));

const push = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: jest.fn() }),
}));

import { createUiClient } from "@masarx/api";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { WorkflowTemplateCreateForm } from "../../packages/ui/src/workflow-template-create-form";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiClient = createUiClient as unknown as jest.Mock;

describe("WorkflowTemplateCreateForm", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    push.mockReset();
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

    expect(push).toHaveBeenCalledWith("/console/workflows/templates/template-123");
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
