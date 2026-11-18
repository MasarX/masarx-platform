const invalidateQueries = jest.fn();

jest.mock("@tanstack/react-query", () => ({
  ...jest.requireActual("@tanstack/react-query"),
  useQueryClient: () => ({ invalidateQueries }),
}));

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}));

jest.mock("../../packages/ui/src/navigate", () => ({
  navigateTo: jest.fn(),
}));

import { createUiClient } from "@masarx/api";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { WorkflowRunTriggersPanel } from "../../packages/ui/src/workflow-run-triggers-panel";

const mockedCreateUiClient = createUiClient as unknown as jest.Mock;

describe("WorkflowRunTriggersPanel", () => {
  const clientId = "c112a901-3e75-47d2-9022-307fa68bd400";
  const senderId = "22222222-2222-4222-8222-222222222222";
  const workflowRunStatusOptions = [
    { value: "completed", label: "Completed" },
    { value: "failed", label: "Failed" },
  ];

  beforeEach(() => {
    jest.resetAllMocks();
    invalidateQueries.mockReset();
    mockedCreateUiClient.mockReturnValue({
      createWorkflowRunTrigger: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });
  });

  it("renders safe workflow-run trigger links", () => {
    renderWithIntl(
      <WorkflowRunTriggersPanel
        workflowTemplateId="template-a"
        incomingTriggers={[
          {
            id: "in-1",
            enabled: true,
            source_workflow_template_id: "template-b",
            target_workflow_template_id: "template-a",
            source_statuses: ["completed"],
            source_statuses_text: "completed",
          },
        ]}
        outgoingTriggers={[
          {
            id: "out-1",
            enabled: true,
            source_workflow_template_id: "template-a",
            target_workflow_template_id: "template-b",
            source_statuses: ["failed"],
            source_statuses_text: "failed",
          },
        ]}
        workflowTemplates={[
          { id: "template-a", name: "Template A" },
          { id: "template-b", name: "Template B" },
        ]}
        appBasePath="/portal"
      />
    );

    const fullViewLinks = screen.getAllByRole("link", {
      name: "Open workflow-run triggers in full view",
    });
    expect(fullViewLinks).toHaveLength(2);
    expect(fullViewLinks[0]).toHaveAttribute("href", "/portal/resources/workflow_run_triggers?target_workflow_template_id=template-a");
    expect(fullViewLinks[1]).toHaveAttribute("href", "/portal/resources/workflow_run_triggers?source_workflow_template_id=template-a");

    const firesLinks = screen.getAllByRole("link", { name: "Open fires" });
    expect(firesLinks).toHaveLength(2);
    expect(firesLinks[0]).toHaveAttribute("href", "/portal/resources/workflow_trigger_fires?workflow_run_trigger_id=in-1");
    expect(firesLinks[1]).toHaveAttribute("href", "/portal/resources/workflow_trigger_fires?workflow_run_trigger_id=out-1");
  });

  it("renders root-relative workflow-run trigger links from the app root", () => {
    renderWithIntl(
      <WorkflowRunTriggersPanel
        workflowTemplateId="template-a"
        incomingTriggers={[
          {
            id: "in-1",
            enabled: true,
            source_workflow_template_id: "template-b",
            target_workflow_template_id: "template-a",
            source_statuses: ["completed"],
            source_statuses_text: "completed",
          },
        ]}
        outgoingTriggers={[
          {
            id: "out-1",
            enabled: true,
            source_workflow_template_id: "template-a",
            target_workflow_template_id: "template-b",
            source_statuses: ["failed"],
            source_statuses_text: "failed",
          },
        ]}
        workflowTemplates={[
          { id: "template-a", name: "Template A" },
          { id: "template-b", name: "Template B" },
        ]}
        appBasePath="/"
      />
    );

    const fullViewLinks = screen.getAllByRole("link", {
      name: "Open workflow-run triggers in full view",
    });
    expect(fullViewLinks).toHaveLength(2);
    expect(fullViewLinks[0]).toHaveAttribute(
      "href",
      "/resources/workflow_run_triggers?target_workflow_template_id=template-a"
    );
    expect(fullViewLinks[1]).toHaveAttribute(
      "href",
      "/resources/workflow_run_triggers?source_workflow_template_id=template-a"
    );

    const firesLinks = screen.getAllByRole("link", { name: "Open fires" });
    expect(firesLinks).toHaveLength(2);
    expect(firesLinks[0]).toHaveAttribute(
      "href",
      "/resources/workflow_trigger_fires?workflow_run_trigger_id=in-1"
    );
    expect(firesLinks[1]).toHaveAttribute(
      "href",
      "/resources/workflow_trigger_fires?workflow_run_trigger_id=out-1"
    );
  });

  it("hides workflow-run trigger links when appBasePath is unsafe", () => {
    renderWithIntl(
      <WorkflowRunTriggersPanel
        workflowTemplateId="template-a"
        incomingTriggers={[
          {
            id: "in-1",
            enabled: true,
            source_workflow_template_id: "template-b",
            target_workflow_template_id: "template-a",
            source_statuses: ["completed"],
            source_statuses_text: "completed",
          },
        ]}
        outgoingTriggers={[]}
        workflowTemplates={[
          { id: "template-a", name: "Template A" },
          { id: "template-b", name: "Template B" },
        ]}
        appBasePath="javascript:alert(1)"
      />
    );

    expect(
      screen.queryByRole("link", { name: "Open workflow-run triggers in full view" })
    ).toBeNull();
    expect(screen.getAllByText("Open workflow-run triggers in full view")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Open fires" })).toBeNull();
    expect(screen.getAllByText("Open fires")).toHaveLength(1);
  });

  it("creates a workflow-run trigger and renders it immediately", async () => {
    const createWorkflowRunTrigger = jest.fn().mockResolvedValue({
      workflow_run_trigger_id: "out-2",
      source_statuses: ["completed", "failed"],
    });
    mockedCreateUiClient.mockReturnValue({
      createWorkflowRunTrigger,
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowRunTriggersPanel
        workflowTemplateId="template-a"
        incomingTriggers={[]}
        outgoingTriggers={[]}
        workflowTemplates={[
          { id: "template-a", name: "Template A" },
          { id: "template-b", name: "Template B" },
        ]}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="workflow-run-panel"
      />
    );

    fireEvent.click(screen.getByTestId("workflow-run-panel-outgoing-new"));

    const modal = await screen.findByTestId("workflow-run-panel-editor");
    fireEvent.change(
      within(modal).getByTestId("workflow-run-panel-editor-target-template"),
      { target: { value: "template-b" } }
    );
    fireEvent.change(within(modal).getByTestId("workflow-run-panel-editor-statuses"), {
      target: { value: "failed, completed" },
    });
    fireEvent.change(within(modal).getByTestId("workflow-run-panel-editor-notes"), {
      target: { value: "Immediate row" },
    });

    fireEvent.click(within(modal).getByTestId("workflow-run-panel-editor-save"));

    await waitFor(() =>
      expect(createWorkflowRunTrigger).toHaveBeenCalledWith({
        sourceWorkflowTemplateId: "template-a",
        targetWorkflowTemplateId: "template-b",
        sourceStatuses: ["failed", "completed"],
        contextPatch: {},
        enabled: true,
        notes: "Immediate row",
      })
    );

    await waitFor(() => expect(invalidateQueries).toHaveBeenCalled());
    expect(screen.getByTestId("workflow-run-panel-row-out-2")).toHaveTextContent("completed, failed");
  });
});


jest.mock("../../packages/ui/src/use-toast", () => ({
  ...jest.requireActual("../../packages/ui/src/use-toast"),
  useToast: () => ({ toast: mockLifecycleToast }),
}));
const mockLifecycleToast = jest.fn();
import { createUiClientFromSupabase } from "../../packages/api/src/ui-client";

describe("workflow trigger lifecycle UI contract", () => {
  const initial = {
    id: "trigger-1", enabled: true, notes: "Original",
    source_workflow_template_id: "template-a",
    target_workflow_template_id: "template-b",
    source_statuses: ["completed"], created_at: "2026-01-01T00:00:00Z",
  };
  const renderPanel = () => renderWithIntl(
    <WorkflowRunTriggersPanel workflowTemplateId="template-a"
      incomingTriggers={[]} outgoingTriggers={[initial]}
      workflowTemplates={[{ id: "template-a", name: "A" }, { id: "template-b", name: "B" }]}
      appBasePath="/portal" capabilities={["workflow_runs.write"]} testIdPrefix="life" />
  );
  let client: {
    updateWorkflowRunTrigger: jest.Mock; deleteWorkflowRunTrigger: jest.Mock;
    createWorkflowRunTrigger: jest.Mock; updateResource: jest.Mock; rpc: jest.Mock;
  };
  beforeEach(() => {
    mockLifecycleToast.mockClear();
    client = {
      updateWorkflowRunTrigger: jest.fn(), deleteWorkflowRunTrigger: jest.fn(),
      createWorkflowRunTrigger: jest.fn(), updateResource: jest.fn(), rpc: jest.fn(),
    };
    mockedCreateUiClient.mockReturnValue(client);
  });
  afterEach(() => {
    expect(client.updateResource).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("toggle retains row identity and existing fields while consuming canonical returned fields", async () => {
    client.updateWorkflowRunTrigger.mockResolvedValue({
      workflow_run_trigger_id: initial.id, enabled: false, source_statuses: ["completed", "failed"],
      decision_log_id: "decision", domain_event_id: "event", correlation_id: "correlation",
    });
    renderPanel();
    fireEvent.click(screen.getByTestId("life-row-trigger-1-toggle"));
    await waitFor(() => expect(client.updateWorkflowRunTrigger).toHaveBeenCalledWith({
      workflowRunTriggerId: initial.id, enabled: false,
    }));
    const row = screen.getByTestId("life-row-trigger-1");
    await waitFor(() => expect(within(row).getByTestId("life-row-trigger-1-toggle")).toHaveTextContent("Enable"));
    expect(row).toHaveTextContent("completed, failed");
    expect(within(row).getByRole("link", { name: "Open fires" })).toHaveAttribute(
      "href", "/portal/resources/workflow_trigger_fires?workflow_run_trigger_id=trigger-1"
    );
  });

  it("edit preserves canonical status order and permits explicitly clearing notes", async () => {
    client.updateWorkflowRunTrigger.mockResolvedValue({
      ...initial, workflow_run_trigger_id: initial.id, source_statuses: ["completed", "failed"],
      notes: null, context_patch: { canonical: true }, decision_log_id: "decision",
    });
    renderPanel();
    fireEvent.click(screen.getByTestId("life-row-trigger-1-edit"));
    const editor = await screen.findByTestId("life-editor");
    fireEvent.change(within(editor).getByTestId("life-editor-statuses"), { target: { value: "failed, completed" } });
    fireEvent.change(within(editor).getByTestId("life-editor-notes"), { target: { value: "" } });
    fireEvent.click(within(editor).getByTestId("life-editor-save"));
    await waitFor(() => expect(client.updateWorkflowRunTrigger).toHaveBeenCalledWith({
      workflowRunTriggerId: initial.id, sourceWorkflowTemplateId: "template-a",
      targetWorkflowTemplateId: "template-b", sourceStatuses: ["failed", "completed"],
      contextPatch: {}, enabled: true, notes: "",
    }));
    await waitFor(() => expect(screen.queryByTestId("life-editor")).not.toBeInTheDocument());
    expect(screen.getByTestId("life-row-trigger-1")).toHaveTextContent("completed, failed");
    fireEvent.click(screen.getByTestId("life-row-trigger-1-edit"));
    expect(screen.getByTestId("life-editor-notes")).toHaveValue("");
    expect(screen.getByTestId("life-editor-context-patch")).toHaveValue(JSON.stringify({ canonical: true }, null, 2));
  });

  it("deletes only after the canonical RPC returns the requested identity", async () => {
    let resolve!: (value: unknown) => void;
    client.deleteWorkflowRunTrigger.mockReturnValue(new Promise((done) => { resolve = done; }));
    renderPanel();
    fireEvent.click(screen.getByTestId("life-row-trigger-1-delete"));
    fireEvent.click(await screen.findByTestId("life-delete-confirm"));
    expect(screen.getByTestId("life-delete-confirm")).toBeDisabled();
    expect(screen.getByTestId("life-row-trigger-1")).toBeInTheDocument();
    await act(async () => { resolve({ status: "deleted", workflow_run_trigger_id: initial.id, workflow_trigger_fires_count: 1 }); });
    await waitFor(() => expect(screen.queryByTestId("life-row-trigger-1")).not.toBeInTheDocument());
    expect(client.deleteWorkflowRunTrigger).toHaveBeenCalledWith(initial.id);
  });

  it.each(["toggle", "edit", "delete"])("retains the row and surfaces %s RPC failure", async (action) => {
    const error = { code: "42501", message: "Capability denied" };
    client.updateWorkflowRunTrigger.mockRejectedValue(error);
    client.deleteWorkflowRunTrigger.mockRejectedValue(error);
    renderPanel();
    fireEvent.click(screen.getByTestId("life-row-trigger-1-" + action));
    if (action === "edit") fireEvent.click(await screen.findByTestId("life-editor-save"));
    if (action === "delete") fireEvent.click(await screen.findByTestId("life-delete-confirm"));
    await waitFor(() => expect(mockLifecycleToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" })));
    expect(screen.getByTestId("life-row-trigger-1")).toBeInTheDocument();
  });

  it.each(["toggle", "delete"])("rejects missing or mismatched %s result identity", async (action) => {
    client.updateWorkflowRunTrigger.mockResolvedValue({ enabled: false });
    client.deleteWorkflowRunTrigger.mockResolvedValue({ workflow_run_trigger_id: "foreign" });
    renderPanel();
    fireEvent.click(screen.getByTestId("life-row-trigger-1-" + action));
    if (action === "delete") fireEvent.click(await screen.findByTestId("life-delete-confirm"));
    await waitFor(() => expect(mockLifecycleToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" })));
    if (action === "delete") {
      fireEvent.click(screen.getByTestId("life-delete-cancel"));
      await waitFor(() => expect(screen.queryByTestId("life-delete-confirm")).not.toBeInTheDocument());
    }
    const retainedRow = screen.getByTestId("life-row-trigger-1");
    expect(within(retainedRow).getByText("enabled", { exact: true })).toBeInTheDocument();
    expect(within(retainedRow).getByRole("button", { name: "Disable" })).toBeEnabled();
  });
});

describe("typed workflow trigger RPC arguments", () => {
  it("preserves six-argument create and explicit active-scope overload, false and empty notes", async () => {
    const data = { workflow_run_trigger_id: "id", decision_log_id: "decision", correlation_id: "corr" };
    const rpc = jest.fn().mockResolvedValue({ data, error: null });
    const ui = createUiClientFromSupabase({ rpc } as never);
    const basic = { sourceWorkflowTemplateId: "source", targetWorkflowTemplateId: "target" };
    expect(await ui.createWorkflowRunTrigger(basic)).toBe(data);
    expect(rpc).toHaveBeenLastCalledWith("ui_create_workflow_run_trigger_v1", {
      p_source_workflow_template_id: "source", p_target_workflow_template_id: "target",
      p_source_statuses: null, p_context_patch: null, p_enabled: null, p_notes: null,
    });
    await ui.createWorkflowRunTrigger({ ...basic, scopeId: "tenant" });
    expect(rpc.mock.calls.at(-1)?.[1].p_scope_id).toBe("tenant");
    await ui.updateWorkflowRunTrigger({ workflowRunTriggerId: "id", enabled: false, notes: "", scopeId: "tenant" });
    expect(rpc).toHaveBeenLastCalledWith("ui_update_workflow_run_trigger_v1", {
      p_workflow_run_trigger_id: "id", p_source_workflow_template_id: null,
      p_target_workflow_template_id: null, p_source_statuses: null, p_context_patch: null,
      p_enabled: false, p_notes: "", p_scope_id: "tenant",
    });
    await ui.deleteWorkflowRunTrigger("id", "tenant");
    expect(rpc).toHaveBeenLastCalledWith("ui_delete_workflow_run_trigger_v1", {
      p_workflow_run_trigger_id: "id", p_scope_id: "tenant",
    });
  });

  it("uses lookup-backed workflow status options in the trigger editor", async () => {
    renderWithIntl(
      <WorkflowRunTriggersPanel
        workflowTemplateId="template-a"
        incomingTriggers={[]}
        outgoingTriggers={[
          {
            id: "out-1",
            enabled: true,
            source_workflow_template_id: "template-a",
            target_workflow_template_id: "template-b",
            source_statuses: ["failed"],
          },
        ]}
        workflowTemplates={[
          { id: "template-a", name: "Template A" },
          { id: "template-b", name: "Template B" },
        ]}
        workflowRunStatusOptions={workflowRunStatusOptions}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="workflow-run-triggers"
      />
    );

    expect(screen.getByText("Statuses: Failed")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workflow-run-triggers-outgoing-new"));
    const sourceTemplateControl = screen.getByTestId(
      "workflow-run-triggers-editor-source-template",
    );
    const targetTemplateControl = screen.getByTestId(
      "workflow-run-triggers-editor-target-template",
    );
    const statusControl = screen.getByTestId("workflow-run-triggers-editor-statuses");

    expect(sourceTemplateControl).toHaveDisplayValue("Template A");
    expect(sourceTemplateControl).toHaveValue("template-a");
    expect(within(sourceTemplateControl).getByRole("option", { name: "Template A" })).toHaveValue(
      "template-a",
    );
    expect(within(sourceTemplateControl).queryByRole("option", { name: "template-a" })).toBeNull();
    expect(within(targetTemplateControl).getByRole("option", { name: "Template B" })).toHaveValue(
      "template-b",
    );
    expect(within(targetTemplateControl).queryByRole("option", { name: "template-b" })).toBeNull();

    expect(statusControl.tagName).toBe("SELECT");
    expect(statusControl).toHaveAttribute("multiple");
    expect(within(statusControl).getByRole("option", { name: "Completed" })).toHaveValue("completed");
    expect(within(statusControl).getByRole("option", { name: "Failed" })).toHaveValue("failed");
    expect(within(statusControl).queryByRole("option", { name: "completed" })).toBeNull();
    expect(within(statusControl).queryByRole("option", { name: "failed" })).toBeNull();
    expect(screen.queryByPlaceholderText("completed, failed")).toBeNull();
    await waitFor(() =>
      expect(
        within(screen.getByTestId("workflow-run-triggers-editor-context-lookups"))
          .getAllByRole("combobox")[0],
      ).not.toBeDisabled(),
    );
  });

  it("uses lookup-backed context patch selectors for DB-backed trigger context", async () => {
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
    const rpc = jest.fn((name: string) =>
      name === "list_lookup_values_v1"
        ? Promise.resolve([{ key: "same_day", label: "Same day delivery" }])
        : Promise.resolve([]),
    );

    const createWorkflowRunTrigger = jest.fn().mockResolvedValue({ workflow_run_trigger_id: "trigger-created" });
    mockedCreateUiClient.mockReturnValue({ listResource, rpc, createWorkflowRunTrigger });

    renderWithIntl(
      <WorkflowRunTriggersPanel
        workflowTemplateId="template-a"
        incomingTriggers={[]}
        outgoingTriggers={[]}
        workflowTemplates={[
          { id: "template-a", name: "Template A" },
          { id: "template-b", name: "Template B" },
        ]}
        workflowRunStatusOptions={workflowRunStatusOptions}
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        testIdPrefix="workflow-run-triggers"
      />,
    );

    fireEvent.click(screen.getByTestId("workflow-run-triggers-outgoing-new"));
    await screen.findByText("Sample Organization");
    expect(screen.getByText("Main Sender")).toBeInTheDocument();
    expect(screen.getByText("Same day delivery")).toBeInTheDocument();
    expect(screen.queryByText(clientId)).toBeNull();
    expect(screen.queryByText(senderId)).toBeNull();

    const lookupControls = screen.getByTestId("workflow-run-triggers-editor-context-lookups");
    const [clientSelect, senderSelect, serviceTypeSelect] =
      within(lookupControls).getAllByRole("combobox");
    expect(within(lookupControls).getByRole("option", { name: "Sample Organization" })).toHaveValue(clientId);
    expect(within(lookupControls).getByRole("option", { name: "Main Sender" })).toHaveValue(senderId);
    expect(within(lookupControls).getByRole("option", { name: "Same day delivery" })).toHaveValue("same_day");
    expect(within(lookupControls).queryByRole("option", { name: clientId })).toBeNull();
    expect(within(lookupControls).queryByRole("option", { name: senderId })).toBeNull();
    expect(within(lookupControls).queryByRole("option", { name: "same_day" })).toBeNull();
    fireEvent.change(clientSelect, {
      target: { value: clientId },
    });
    fireEvent.change(senderSelect, {
      target: { value: senderId },
    });
    fireEvent.change(serviceTypeSelect, { target: { value: "same_day" } });
    expect(clientSelect).toHaveValue(clientId);
    expect(clientSelect).toHaveDisplayValue("Sample Organization");
    expect(clientSelect).not.toHaveDisplayValue(clientId);
    expect(senderSelect).toHaveValue(senderId);
    expect(senderSelect).toHaveDisplayValue("Main Sender");
    expect(senderSelect).not.toHaveDisplayValue(senderId);
    expect(serviceTypeSelect).toHaveValue("same_day");
    expect(serviceTypeSelect).toHaveDisplayValue("Same day delivery");
    expect(serviceTypeSelect).not.toHaveDisplayValue("same_day");

    expect(screen.getByTestId("workflow-run-triggers-editor-context-patch")).toHaveValue(
      JSON.stringify(
        {
          client_id: clientId,
          sender_id: senderId,
          service_type: "same_day",
        },
        null,
        2,
      ),
    );

    fireEvent.click(screen.getByTestId("workflow-run-triggers-editor-save"));

    await waitFor(() =>
      expect(createWorkflowRunTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceWorkflowTemplateId: "template-a",
          targetWorkflowTemplateId: "template-b",
          sourceStatuses: ["completed"],
          contextPatch: {
            client_id: clientId,
            sender_id: senderId,
            service_type: "same_day",
          },
        }),
      ),
    );
  });
});
