jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(),
}));

const invalidateQueries = jest.fn();

jest.mock("@tanstack/react-query", () => ({
  ...jest.requireActual("@tanstack/react-query"),
  useQueryClient: () => ({ invalidateQueries }),
}));

import { createUiClient } from "@masarx/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { WorkflowTemplateStepsBuilder } from "../../packages/ui/src/workflow-template-steps-builder";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiClient = createUiClient as unknown as jest.Mock;

describe("WorkflowTemplateStepsBuilder", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    invalidateQueries.mockReset();
  });

  it("creates a workflow step and refreshes the studio", async () => {
    const createWorkflowTemplateStep = jest.fn().mockResolvedValue({
      status: "ok",
      workflow_template_step_id: "step-99",
    });
    const getResource = jest.fn().mockResolvedValue({
      id: "step-99",
      operation_name: "dispatch_labels",
      transition_condition: "success",
      handler_key: null,
      enabled: true,
      manual_action_required: false,
    });

    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep,
      getResource,
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[]}
        idKey="id"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write", "lookups.read"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-add"));

    fireEvent.change(screen.getByTestId("steps-builder-add-operation"), {
      target: { value: "dispatch_labels" },
    });

    fireEvent.change(screen.getByTestId("steps-builder-add-transition"), {
      target: { value: "success" },
    });

    fireEvent.click(screen.getByTestId("steps-builder-add-submit"));

    await waitFor(() => expect(createWorkflowTemplateStep).toHaveBeenCalled());

    expect(createWorkflowTemplateStep).toHaveBeenCalledWith({
      workflowTemplateId: "template-1",
      step: {
        operation_name: "dispatch_labels",
        transition_condition: "success",
        handler_key: "dispatch_labels",
        enabled: true,
        manual_action_required: false,
      },
    });

    expect(invalidateQueries).toHaveBeenCalled();
  });

  it("quick-adds a workflow step from operation suggestions", async () => {
    const createWorkflowTemplateStep = jest.fn().mockResolvedValue({
      status: "ok",
      workflow_template_step_id: "step-100",
    });
    const getResource = jest.fn().mockResolvedValue({
      id: "step-100",
      operation_name: "dispatch_labels",
      transition_condition: "success",
      handler_key: null,
      enabled: true,
      manual_action_required: false,
    });
    const listResource = jest.fn(async (resource: string) => {
      if (resource === "lookup_definitions") {
        return {
          resource,
          keys: ["id"],
          items: [{ id: "def-1", category: "workflow_transition" }],
          limit: 5,
          offset: 0,
          total: 1,
        };
      }
      if (resource === "lookup_values") {
        return {
          resource,
          keys: ["value"],
          items: [{ value: "success", label: "Success" }],
          limit: 100,
          offset: 0,
          total: 1,
        };
      }
      if (resource === "operation_handlers") {
        return {
          resource,
          keys: ["handler_key"],
          items: [{ handler_key: "dispatch_labels" }],
          limit: 25,
          offset: 0,
          total: 1,
        };
      }
      return {
        resource,
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      };
    });

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep,
      getResource,
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[]}
        idKey="id"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write", "lookups.read"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-add"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-add-modal")).toBeInTheDocument()
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /dispatch_labels/i })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /dispatch_labels/i }));

    await waitFor(() => expect(createWorkflowTemplateStep).toHaveBeenCalled());

    expect(createWorkflowTemplateStep).toHaveBeenCalledWith({
      workflowTemplateId: "template-1",
      step: {
        operation_name: "dispatch_labels",
        transition_condition: "success",
        handler_key: "dispatch_labels",
        enabled: true,
        manual_action_required: false,
      },
    });
  });

  it("groups the flow operation library by ui_category when available", async () => {
    const listResource = jest.fn(async (resource: string) => {
      if (resource === "operation_handlers") {
        return {
          resource,
          keys: ["handler_key"],
          items: [
            {
              handler_key: "dispatch_labels",
              ui_label: "Dispatch labels",
              ui_category: "Labels",
              ui_description: "Generate or enqueue shipment labels",
            },
            {
              handler_key: "send_whatsapp",
              ui_label: "Send WhatsApp",
              ui_category: "Comms",
              ui_description: "Send a WhatsApp message via provider",
            },
          ],
          limit: 25,
          offset: 0,
          total: 2,
        };
      }
      return {
        resource,
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      };
    });

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const paletteList = screen.getByTestId("steps-builder-palette-list");

    await waitFor(() =>
      expect(within(paletteList).getByText("Dispatch labels")).toBeInTheDocument()
    );

    const labelsHeader = within(paletteList).getByText("Labels");
    const commsHeader = within(paletteList).getByText("Comms");

    expect(labelsHeader).toHaveClass("uppercase");
    expect(commsHeader).toHaveClass("uppercase");
    expect(within(paletteList).getByText("Dispatch labels")).toBeInTheDocument();
    expect(within(paletteList).getByText("Send WhatsApp")).toBeInTheDocument();
  });

  it("shows a manage plugins link in the flow palette for ops users", async () => {
    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "operation_handlers",
        keys: ["handler_key"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[]}
        idKey="id"
        layout="flow"
        appBasePath="/portal"
        capabilities={["workflow_runs.write", "operation_handlers.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-palette-manage-plugins")).toHaveAttribute(
        "href",
        "/portal/resources/operation_handlers"
      )
    );
  });

  it("hides the manage plugins link when operation handler write is missing", async () => {
    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "operation_handlers",
        keys: ["handler_key"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[]}
        idKey="id"
        layout="flow"
        appBasePath="/portal"
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    expect(screen.queryByTestId("steps-builder-palette-manage-plugins")).toBeNull();
  });

  it("hides the run preview link when appBasePath is unsafe", async () => {
    const listResource = jest.fn().mockResolvedValue({
      resource: "workflow_run_steps",
      keys: ["id"],
      items: [],
      limit: 25,
      offset: 0,
      total: 0,
    });
    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            enabled: true,
          },
        ]}
        runs={[{ id: "run-1" }]}
        appBasePath="javascript:alert(1)"
        idKey="id"
        layout="flow"
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    await waitFor(() =>
      expect(listResource).toHaveBeenCalledWith(
        "workflow_run_steps",
        { workflow_run_id: "run-1" },
        200,
        0,
        { key: "sequence_order", direction: "asc" }
      )
    );
    expect(screen.queryByTestId("steps-builder-run-preview-open")).toBeNull();
  });

  it("renders safe links when appBasePath is trusted", async () => {
    const listResource = jest.fn().mockResolvedValue({
      resource: "workflow_run_steps",
      keys: ["id"],
      items: [],
      limit: 25,
      offset: 0,
      total: 0,
    });
    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            enabled: true,
          },
        ]}
        runs={[{ id: "run-1" }]}
        appBasePath="/portal"
        idKey="id"
        layout="flow"
        capabilities={["workflow_runs.write", "operation_handlers.write"]}
        capabilityWrite="workflow_runs.write"
        paletteTestId="palette"
        testIdPrefix="steps-builder"
      />
    );

    const runPreviewOpen = await screen.findByTestId("steps-builder-run-preview-open");
    expect(runPreviewOpen).toHaveAttribute("href", "/portal/workflows/runs/run-1");
    expect(screen.getByTestId("steps-builder-palette-manage-plugins")).toHaveAttribute(
      "href",
      "/portal/resources/operation_handlers"
    );
  });

  it("edits a workflow step from the step editor drawer", async () => {
    const updateResource = jest
      .fn()
      .mockResolvedValueOnce({
        id: "step-1",
        operation_name: "dispatch_labels",
        transition_condition: "success",
        handler_key: "handler_v2",
        enabled: true,
        manual_action_required: false,
      })
      .mockResolvedValueOnce({
        id: "step-1",
        operation_name: "dispatch_labels",
        transition_condition: "success",
        handler_key: "handler_v1",
        enabled: true,
        manual_action_required: false,
      })
      .mockResolvedValueOnce({
        id: "step-1",
        operation_name: "dispatch_labels",
        transition_condition: "success",
        handler_key: "handler_v2",
        enabled: true,
        manual_action_required: false,
      });

    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            handler_key: "handler_v1",
            enabled: true,
            manual_action_required: false,
          },
        ]}
        idKey="id"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-step-card-step-1"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-drawer")).toBeInTheDocument()
    );

    fireEvent.change(screen.getByTestId("steps-builder-step-editor-handler"), {
      target: { value: "handler_v2" },
    });

    fireEvent.click(screen.getByTestId("steps-builder-step-editor-save"));

    await waitFor(() => expect(updateResource).toHaveBeenCalled());

    expect(updateResource).toHaveBeenCalledWith({
      resource: "workflow_template_steps",
      id: "step-1",
      patch: { handler_key: "handler_v2" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-undo")).not.toBeDisabled()
    );
    fireEvent.click(screen.getByTestId("steps-builder-undo"));

    await waitFor(() => expect(updateResource).toHaveBeenCalledTimes(2));

    expect(updateResource).toHaveBeenNthCalledWith(2, {
      resource: "workflow_template_steps",
      id: "step-1",
      patch: { handler_key: "handler_v1" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-redo")).not.toBeDisabled()
    );
    fireEvent.click(screen.getByTestId("steps-builder-redo"));

    await waitFor(() => expect(updateResource).toHaveBeenCalledTimes(3));

    expect(updateResource).toHaveBeenNthCalledWith(3, {
      resource: "workflow_template_steps",
      id: "step-1",
      patch: { handler_key: "handler_v2" },
    });
  });

  it("edits workflow step metadata from the step editor drawer", async () => {
    const updateResource = jest.fn().mockResolvedValue({
      id: "step-1",
      operation_name: "dispatch_labels",
      transition_condition: "success",
      handler_key: "handler_v1",
      enabled: true,
      manual_action_required: false,
      metadata: { hello: "world" },
    });

    const listResource = jest.fn(async (resource: string) => {
      if (resource === "schema_registry") {
        return {
          resource,
          keys: ["id"],
          items: [
            {
              id: "schema-1",
              category: "workflow_template_step_metadata",
              version: 1,
              is_active: true,
              schema: { type: "object", additionalProperties: true },
            },
          ],
          limit: 1,
          offset: 0,
          total: 1,
        };
      }
      return {
        resource,
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      };
    });

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            handler_key: "handler_v1",
            enabled: true,
            manual_action_required: false,
            metadata: {},
          },
        ]}
        idKey="id"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-step-card-step-1"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-drawer")).toBeInTheDocument()
    );

    const metadataPanel = screen.getByTestId(
      "steps-builder-step-editor-metadata"
    ) as unknown as HTMLDetailsElement;
    metadataPanel.open = true;
    fireEvent(metadataPanel, new Event("toggle"));

    fireEvent.click(
      screen.getByTestId("steps-builder-step-editor-metadata-mode-json")
    );

    fireEvent.change(screen.getByTestId("steps-builder-step-editor-metadata-text"), {
      target: { value: '{ "hello": "world" }' },
    });

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-save")).not.toBeDisabled()
    );

    fireEvent.click(screen.getByTestId("steps-builder-step-editor-save"));

    await waitFor(() => expect(updateResource).toHaveBeenCalled());

    expect(updateResource).toHaveBeenCalledWith({
      resource: "workflow_template_steps",
      id: "step-1",
      patch: { metadata: { hello: "world" } },
    });
  });

  it("blocks saving workflow step metadata when JSON is invalid", async () => {
    const updateResource = jest.fn().mockResolvedValue({
      id: "step-1",
      operation_name: "dispatch_labels",
      transition_condition: "success",
      handler_key: "handler_v1",
      enabled: true,
      manual_action_required: false,
      metadata: {},
    });

    const listResource = jest.fn(async (resource: string) => {
      if (resource === "schema_registry") {
        return {
          resource,
          keys: ["id"],
          items: [
            {
              id: "schema-1",
              category: "workflow_template_step_metadata",
              version: 1,
              is_active: true,
              schema: { type: "object", additionalProperties: true },
            },
          ],
          limit: 1,
          offset: 0,
          total: 1,
        };
      }
      return {
        resource,
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      };
    });

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            handler_key: "handler_v1",
            enabled: true,
            manual_action_required: false,
            metadata: {},
          },
        ]}
        idKey="id"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-step-card-step-1"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-drawer")).toBeInTheDocument()
    );

    const metadataPanel = screen.getByTestId(
      "steps-builder-step-editor-metadata"
    ) as unknown as HTMLDetailsElement;
    metadataPanel.open = true;
    fireEvent(metadataPanel, new Event("toggle"));

    fireEvent.click(
      screen.getByTestId("steps-builder-step-editor-metadata-mode-json")
    );

    fireEvent.change(screen.getByTestId("steps-builder-step-editor-metadata-text"), {
      target: { value: "{ invalid-json" },
    });

    expect(screen.getByTestId("steps-builder-step-editor-save")).toBeDisabled();
    expect(updateResource).not.toHaveBeenCalled();
  });

  it("edits workflow step routing from the step editor drawer", async () => {
    const updateResource = jest.fn().mockResolvedValue({
      id: "step-1",
      operation_name: "dispatch_labels",
      transition_condition: "success",
      handler_key: "handler_v1",
      enabled: true,
      manual_action_required: false,
      condition_jsonlogic: { "==": [1, 1] },
      next_operation_name: "dispatch_followup",
      next_operation_priority: 5,
      next_operation_delay_seconds: 30,
    });

    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "operation_handlers",
        keys: ["handler_key"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            handler_key: "handler_v1",
            enabled: true,
            manual_action_required: false,
            condition_jsonlogic: null,
            next_operation_name: null,
            next_operation_priority: null,
            next_operation_delay_seconds: null,
          },
        ]}
        idKey="id"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-step-card-step-1"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-drawer")).toBeInTheDocument()
    );

    const routingPanel = screen.getByTestId(
      "steps-builder-step-editor-routing"
    ) as unknown as HTMLDetailsElement;
    routingPanel.open = true;
    fireEvent(routingPanel, new Event("toggle"));

    fireEvent.change(screen.getByTestId("steps-builder-step-editor-routing-condition"), {
      target: { value: '{ "==": [1, 1] }' },
    });

    fireEvent.change(screen.getByTestId("steps-builder-step-editor-routing-next-operation"), {
      target: { value: "dispatch_followup" },
    });

    fireEvent.change(screen.getByTestId("steps-builder-step-editor-routing-next-priority"), {
      target: { value: "5" },
    });

    fireEvent.change(screen.getByTestId("steps-builder-step-editor-routing-next-delay"), {
      target: { value: "30" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-save")).not.toBeDisabled()
    );

    fireEvent.click(screen.getByTestId("steps-builder-step-editor-save"));

    await waitFor(() => expect(updateResource).toHaveBeenCalled());

    expect(updateResource).toHaveBeenCalledWith({
      resource: "workflow_template_steps",
      id: "step-1",
      patch: {
        condition_jsonlogic: { "==": [1, 1] },
        next_operation_name: "dispatch_followup",
        next_operation_priority: 5,
        next_operation_delay_seconds: 30,
      },
    });
  });

  it("shows a routing hint when next operation matches a step in the template", async () => {
    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "operation_handlers",
        keys: ["handler_key"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            handler_key: "handler_v1",
            enabled: true,
            manual_action_required: false,
            next_operation_name: null,
          },
          {
            id: "step-2",
            operation_name: "dispatch_followup",
            transition_condition: "success",
            handler_key: "handler_v2",
            enabled: true,
            manual_action_required: false,
          },
        ]}
        idKey="id"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-step-card-step-1"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-drawer")).toBeInTheDocument()
    );

    const routingPanel = screen.getByTestId(
      "steps-builder-step-editor-routing"
    ) as unknown as HTMLDetailsElement;
    routingPanel.open = true;
    fireEvent(routingPanel, new Event("toggle"));

    fireEvent.change(screen.getByTestId("steps-builder-step-editor-routing-next-operation"), {
      target: { value: "dispatch_followup" },
    });

    expect(
      screen.getByTestId("steps-builder-step-editor-routing-next-operation-hint")
    ).toHaveTextContent("Targets step 2");
  });

  it("blocks saving workflow step routing when JSONLogic condition is invalid", async () => {
    const updateResource = jest.fn().mockResolvedValue({
      id: "step-1",
      operation_name: "dispatch_labels",
      transition_condition: "success",
      handler_key: "handler_v1",
      enabled: true,
      manual_action_required: false,
      condition_jsonlogic: null,
    });

    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "operation_handlers",
        keys: ["handler_key"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            handler_key: "handler_v1",
            enabled: true,
            manual_action_required: false,
            condition_jsonlogic: null,
          },
        ]}
        idKey="id"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-step-card-step-1"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-drawer")).toBeInTheDocument()
    );

    const routingPanel = screen.getByTestId(
      "steps-builder-step-editor-routing"
    ) as unknown as HTMLDetailsElement;
    routingPanel.open = true;
    fireEvent(routingPanel, new Event("toggle"));

    fireEvent.change(screen.getByTestId("steps-builder-step-editor-routing-condition"), {
      target: { value: "{ invalid-json" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-save")).toBeDisabled()
    );
    expect(updateResource).not.toHaveBeenCalled();
  });

  it("selects step metadata schema based on operation handler config_schema_category", async () => {
    const updateResource = jest.fn().mockResolvedValue({
      id: "step-1",
      operation_name: "dispatch_labels",
      transition_condition: "success",
      handler_key: "handler_v1",
      enabled: true,
      manual_action_required: false,
      metadata: {},
    });

    const listResource = jest.fn(async (resource: string, filters?: Record<string, unknown>) => {
      if (resource === "operation_handlers") {
        const handlerKey = String(filters?.handler_key ?? "").trim();
        if (handlerKey === "handler_v1") {
          return {
            resource,
            keys: ["handler_key"],
            items: [
              {
                handler_key: "handler_v1",
                config_schema_category: "custom_step_metadata",
              },
            ],
            limit: 25,
            offset: 0,
            total: 1,
          };
        }
        return { resource, keys: ["handler_key"], items: [], limit: 25, offset: 0, total: 0 };
      }

      if (resource === "schema_registry") {
        const category = String(filters?.category ?? "").trim();
        if (category === "custom_step_metadata") {
          return {
            resource,
            keys: ["id"],
            items: [
              {
                id: "schema-1",
                category: "custom_step_metadata",
                version: 1,
                is_active: true,
                schema: { type: "object", additionalProperties: true },
              },
            ],
            limit: 1,
            offset: 0,
            total: 1,
          };
        }
        return { resource, keys: ["id"], items: [], limit: 1, offset: 0, total: 0 };
      }

      return { resource, keys: ["id"], items: [], limit: 25, offset: 0, total: 0 };
    });

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            handler_key: "handler_v1",
            enabled: true,
            manual_action_required: false,
            metadata: {},
          },
        ]}
        idKey="id"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-step-card-step-1"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-drawer")).toBeInTheDocument()
    );

    await waitFor(() =>
      expect(listResource).toHaveBeenCalledWith(
        "schema_registry",
        expect.objectContaining({ category: "custom_step_metadata", is_active: true }),
        1,
        0,
        { key: "version", direction: "desc" }
      )
    );
  });

  it("inserts a workflow step from the flow view and reorders", async () => {
    const createWorkflowTemplateStep = jest.fn().mockResolvedValue({
      status: "ok",
      workflow_template_step_id: "step-99",
    });
    const reorderResource = jest.fn().mockResolvedValue({});
    const getResource = jest.fn().mockResolvedValue({
      id: "step-99",
      operation_name: "new_step",
      transition_condition: "always",
      handler_key: null,
      enabled: true,
      manual_action_required: false,
    });

    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep,
      getResource,
      reorderResource,
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            enabled: true,
          },
          {
            id: "step-2",
            operation_name: "download_labels",
            transition_condition: "always",
            enabled: true,
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write", "lookups.read"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-insert-after-step-1"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-add-modal")).toBeInTheDocument()
    );

    fireEvent.change(screen.getByTestId("steps-builder-add-operation"), {
      target: { value: "new_step" },
    });
    fireEvent.change(screen.getByTestId("steps-builder-add-transition"), {
      target: { value: "always" },
    });
    fireEvent.click(screen.getByTestId("steps-builder-add-submit"));

    await waitFor(() => expect(createWorkflowTemplateStep).toHaveBeenCalled());
    await waitFor(() => expect(reorderResource).toHaveBeenCalled());

    expect(createWorkflowTemplateStep).toHaveBeenCalledWith({
      workflowTemplateId: "template-1",
      step: expect.objectContaining({
        operation_name: "new_step",
        handler_key: "new_step",
      }),
    });

    expect(reorderResource).toHaveBeenCalledWith({
      resource: "workflow_template_steps",
      ids: ["step-1", "step-99", "step-2"],
    });
  });

  it("inserts a workflow step at the start from the flow view", async () => {
    const createWorkflowTemplateStep = jest.fn().mockResolvedValue({
      status: "ok",
      workflow_template_step_id: "step-99",
    });
    const reorderResource = jest.fn().mockResolvedValue({});
    const getResource = jest.fn().mockResolvedValue({
      id: "step-99",
      operation_name: "new_step",
      transition_condition: "always",
      handler_key: null,
      enabled: true,
      manual_action_required: false,
    });

    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep,
      getResource,
      reorderResource,
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            enabled: true,
          },
          {
            id: "step-2",
            operation_name: "download_labels",
            transition_condition: "always",
            enabled: true,
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write", "lookups.read"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-insert-start"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-add-modal")).toBeInTheDocument()
    );

    fireEvent.change(screen.getByTestId("steps-builder-add-operation"), {
      target: { value: "new_step" },
    });
    fireEvent.change(screen.getByTestId("steps-builder-add-transition"), {
      target: { value: "always" },
    });
    fireEvent.click(screen.getByTestId("steps-builder-add-submit"));

    await waitFor(() => expect(createWorkflowTemplateStep).toHaveBeenCalled());
    await waitFor(() => expect(reorderResource).toHaveBeenCalled());

    expect(createWorkflowTemplateStep).toHaveBeenCalledWith({
      workflowTemplateId: "template-1",
      step: expect.objectContaining({
        operation_name: "new_step",
        handler_key: "new_step",
      }),
    });

    expect(reorderResource).toHaveBeenCalledWith({
      resource: "workflow_template_steps",
      ids: ["step-99", "step-1", "step-2"],
    });
  });

  it("renders an overlap badge on the flow start card when overlaps are detected", async () => {
    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[]}
        triggers={[]}
        overlapCount={2}
        overlapsHref="#workflow-overlaps"
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    expect(screen.getByRole("button", { name: "Reset view" })).toBeInTheDocument();
    expect(screen.getByTestId("steps-builder-zoom-out")).toBeInTheDocument();
    expect(screen.getByTestId("steps-builder-zoom-in")).toBeInTheDocument();
    expect(screen.getByTestId("steps-builder-zoom-fit")).toBeInTheDocument();
    expect(screen.getByTestId("steps-builder-zoom-value")).toHaveTextContent("100%");
    expect(screen.getByTestId("steps-builder-zoom-value")).not.toBeDisabled();
    expect(screen.getByRole("link", { name: "2 duplicates" })).toHaveAttribute(
      "href",
      "#workflow-overlaps"
    );
  });

  it("supports flow zoom controls", async () => {
    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "first_op",
            transition_condition: "always",
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const zoomValue = screen.getByTestId("steps-builder-zoom-value");
    const canvasScroll = screen.getByTestId("steps-builder-canvas-scroll");
    expect(canvasScroll).toHaveAttribute("tabindex", "0");
    expect(canvasScroll).toHaveAttribute("role", "region");
    expect(canvasScroll).toHaveAttribute("aria-label", "Workflow canvas");
    const describedBy = canvasScroll.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toBeInTheDocument();
    expect(zoomValue).toHaveTextContent("100%");
    expect(zoomValue).not.toBeDisabled();
    expect(screen.getByTestId("steps-builder-zoom-out")).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+- Meta+-"
    );
    expect(zoomValue).toHaveAttribute("aria-keyshortcuts", "Control+0 Meta+0");
    expect(screen.getByTestId("steps-builder-zoom-in")).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+= Meta+="
    );

    fireEvent.wheel(canvasScroll, { deltaY: -10, ctrlKey: true });
    expect(zoomValue).toHaveTextContent("110%");
    expect(zoomValue).not.toBeDisabled();

    fireEvent.wheel(canvasScroll, { deltaY: 10, ctrlKey: true });
    expect(zoomValue).toHaveTextContent("100%");
    expect(zoomValue).not.toBeDisabled();

    fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    expect(zoomValue).toHaveTextContent("110%");
    expect(zoomValue).not.toBeDisabled();

    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    expect(zoomValue).toHaveTextContent("100%");
    expect(zoomValue).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("steps-builder-zoom-out"));
    expect(zoomValue).toHaveTextContent("90%");
    expect(zoomValue).not.toBeDisabled();

    fireEvent.click(zoomValue);
    expect(zoomValue).toHaveTextContent("100%");
    expect(zoomValue).not.toBeDisabled();
  });

  it("supports keyboard panning on the flow canvas", async () => {
    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "first_op",
            transition_condition: "always",
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const canvasScroll = screen.getByTestId("steps-builder-canvas-scroll") as HTMLDivElement;
    Object.defineProperty(canvasScroll, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(canvasScroll, "scrollWidth", { value: 1000, configurable: true });
    Object.defineProperty(canvasScroll, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(canvasScroll, "scrollHeight", { value: 900, configurable: true });
    canvasScroll.scrollLeft = 100;
    canvasScroll.scrollTop = 200;

    const scrollTo = jest.fn((options: any) => {
      canvasScroll.scrollLeft = options.left;
      canvasScroll.scrollTop = options.top;
    });
    (canvasScroll as any).scrollTo = scrollTo;

    canvasScroll.focus();

    fireEvent.keyDown(canvasScroll, { key: "ArrowRight" });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 180, top: 200, behavior: "auto" });

    fireEvent.keyDown(canvasScroll, { key: "ArrowDown", shiftKey: true });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 180, top: 440, behavior: "auto" });
  });

  it("supports arrow-key navigation between flow steps", async () => {
    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "first_op",
            transition_condition: "always",
          },
          {
            id: "step-2",
            operation_name: "second_op",
            transition_condition: "always",
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const step1 = await screen.findByTestId("steps-builder-step-card-step-1");
    const step2 = await screen.findByTestId("steps-builder-step-card-step-2");

    step1.focus();
    expect(document.activeElement).toBe(step1);

    fireEvent.keyDown(step1, { key: "ArrowRight" });
    expect(document.activeElement).toBe(step2);

    fireEvent.keyDown(step2, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(step1);
  });

  it("renders flow branch edges and opens the matched next step from flow view", async () => {
    const listResource = jest.fn(async (resource: string) => ({
      resource,
      keys: ["id"],
      items: [],
      limit: 25,
      offset: 0,
      total: 0,
    }));

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "first_op",
            transition_condition: "always",
            next_operation_name: "second_op",
          },
          {
            id: "step-2",
            operation_name: "second_op",
            transition_condition: "always",
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-branch-edges")).toBeInTheDocument()
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("steps-builder-branch-edge-step-1-step-2")
      ).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId("steps-builder-step-next-step-1"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-drawer")).toBeInTheDocument()
    );

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-operation")).toHaveValue(
        "second_op"
      )
    );
  });

  it("connects flow steps by dragging between connect ports", async () => {
    const updateResource = jest.fn().mockResolvedValue({
      id: "step-1",
      operation_name: "first_op",
      transition_condition: "always",
      next_operation_name: "second_op",
    });

    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "first_op",
            transition_condition: "always",
          },
          {
            id: "step-2",
            operation_name: "second_op",
            transition_condition: "always",
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const transferData = new Map<string, string>();
    const dataTransfer = {
      setData: (key: string, value: string) => transferData.set(key, value),
      getData: (key: string) => transferData.get(key) ?? "",
      effectAllowed: "",
    };

    const fromPort = screen.getByTestId("steps-builder-connect-from-step-1");
    const toPort = screen.getByTestId("steps-builder-connect-to-step-2");

    fireEvent.dragStart(fromPort, { dataTransfer });
    fireEvent.dragOver(toPort, { dataTransfer });
    fireEvent.drop(toPort, { dataTransfer });
    fireEvent.dragEnd(fromPort, { dataTransfer });

    await waitFor(() =>
      expect(updateResource).toHaveBeenCalledWith({
        resource: "workflow_template_steps",
        id: "step-1",
        patch: { next_operation_name: "second_op" },
      })
    );

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-next-step-1")).toBeInTheDocument()
    );
  });

  it("connects flow steps using keyboard connect mode", async () => {
    const updateResource = jest.fn().mockResolvedValue({
      id: "step-1",
      operation_name: "first_op",
      transition_condition: "always",
      next_operation_name: "second_op",
    });

    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "first_op",
            transition_condition: "always",
          },
          {
            id: "step-2",
            operation_name: "second_op",
            transition_condition: "always",
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const fromPort = screen.getByTestId("steps-builder-connect-from-step-1");
    const toPort = screen.getByTestId("steps-builder-connect-to-step-2");

    expect(toPort).toBeDisabled();

    fireEvent.keyDown(fromPort, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-connect-banner")).toBeInTheDocument()
    );

    await waitFor(() => expect(toPort).not.toBeDisabled());

    fireEvent.click(toPort);

    await waitFor(() =>
      expect(updateResource).toHaveBeenCalledWith({
        resource: "workflow_template_steps",
        id: "step-1",
        patch: { next_operation_name: "second_op" },
      })
    );

    await waitFor(() =>
      expect(screen.queryByTestId("steps-builder-connect-banner")).toBeNull()
    );
  });

  it("undoes and redoes flow routing connections", async () => {
    const updateResource = jest
      .fn()
      .mockResolvedValueOnce({
        id: "step-1",
        operation_name: "first_op",
        transition_condition: "always",
        next_operation_name: "second_op",
      })
      .mockResolvedValueOnce({
        id: "step-1",
        operation_name: "first_op",
        transition_condition: "always",
        next_operation_name: null,
      })
      .mockResolvedValueOnce({
        id: "step-1",
        operation_name: "first_op",
        transition_condition: "always",
        next_operation_name: "second_op",
      });

    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "first_op",
            transition_condition: "always",
          },
          {
            id: "step-2",
            operation_name: "second_op",
            transition_condition: "always",
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const fromPort = screen.getByTestId("steps-builder-connect-from-step-1");
    const toPort = screen.getByTestId("steps-builder-connect-to-step-2");

    fireEvent.keyDown(fromPort, { key: "Enter" });
    await waitFor(() => expect(toPort).not.toBeDisabled());

    fireEvent.click(toPort);

    await waitFor(() =>
      expect(updateResource).toHaveBeenNthCalledWith(1, {
        resource: "workflow_template_steps",
        id: "step-1",
        patch: { next_operation_name: "second_op" },
      })
    );

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-next-step-1")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId("steps-builder-undo"));

    await waitFor(() =>
      expect(updateResource).toHaveBeenNthCalledWith(2, {
        resource: "workflow_template_steps",
        id: "step-1",
        patch: { next_operation_name: null },
      })
    );

    await waitFor(() => expect(screen.queryByTestId("steps-builder-step-next-step-1")).toBeNull());

    fireEvent.click(screen.getByTestId("steps-builder-redo"));

    await waitFor(() =>
      expect(updateResource).toHaveBeenNthCalledWith(3, {
        resource: "workflow_template_steps",
        id: "step-1",
        patch: { next_operation_name: "second_op" },
      })
    );

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-next-step-1")).toBeInTheDocument()
    );
  });

  it("cancels keyboard connect mode from the connect banner", async () => {
    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "first_op",
            transition_condition: "always",
          },
          {
            id: "step-2",
            operation_name: "second_op",
            transition_condition: "always",
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const fromPort = screen.getByTestId("steps-builder-connect-from-step-1");
    const toPort = screen.getByTestId("steps-builder-connect-to-step-2");

    expect(toPort).toBeDisabled();

    fireEvent.keyDown(fromPort, { key: "Enter" });

    await waitFor(() => expect(toPort).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("steps-builder-connect-banner-cancel"));

    await waitFor(() => expect(toPort).toBeDisabled());
  });

  it("cancels flow connect mode on Escape", async () => {
    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "first_op",
            transition_condition: "always",
          },
          {
            id: "step-2",
            operation_name: "second_op",
            transition_condition: "always",
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const transferData = new Map<string, string>();
    const dataTransfer = {
      setData: (key: string, value: string) => transferData.set(key, value),
      getData: (key: string) => transferData.get(key) ?? "",
      effectAllowed: "",
    };

    const fromPort = screen.getByTestId("steps-builder-connect-from-step-1");

    fireEvent.dragStart(fromPort, { dataTransfer });

    await waitFor(() => expect(fromPort).toHaveClass("bg-ui-accent/25"));

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(fromPort).not.toHaveClass("bg-ui-accent/25"));
  });

  it("clears next operation routing from the flow view", async () => {
    const updateResource = jest
      .fn()
      .mockResolvedValueOnce({
        id: "step-1",
        operation_name: "first_op",
        transition_condition: "always",
        next_operation_name: null,
        next_operation_priority: null,
        next_operation_delay_seconds: null,
        condition_jsonlogic: null,
      })
      .mockResolvedValueOnce({
        id: "step-1",
        operation_name: "first_op",
        transition_condition: "always",
        next_operation_name: "second_op",
        next_operation_priority: 10,
        next_operation_delay_seconds: 30,
        condition_jsonlogic: { "==": [{ var: "status" }, "ok"] },
      })
      .mockResolvedValueOnce({
        id: "step-1",
        operation_name: "first_op",
        transition_condition: "always",
        next_operation_name: null,
        next_operation_priority: null,
        next_operation_delay_seconds: null,
        condition_jsonlogic: null,
      });

    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "first_op",
            transition_condition: "always",
            next_operation_name: "second_op",
            next_operation_priority: 10,
            next_operation_delay_seconds: 30,
            condition_jsonlogic: { "==": [{ var: "status" }, "ok"] },
          },
          {
            id: "step-2",
            operation_name: "second_op",
            transition_condition: "always",
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    expect(screen.getByTestId("steps-builder-step-next-step-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("steps-builder-step-clear-next-step-1"));
    expect(updateResource).not.toHaveBeenCalled();

    expect(
      screen.getByTestId("steps-builder-step-clear-next-step-1-confirm-dialog")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("steps-builder-step-clear-next-step-1-confirm-submit"));

    await waitFor(() =>
      expect(updateResource).toHaveBeenCalledWith({
        resource: "workflow_template_steps",
        id: "step-1",
        patch: {
          next_operation_name: null,
          next_operation_priority: null,
          next_operation_delay_seconds: null,
          condition_jsonlogic: null,
        },
      })
    );

    await waitFor(() =>
      expect(screen.queryByTestId("steps-builder-step-next-step-1")).toBeNull()
    );

    fireEvent.click(screen.getByTestId("steps-builder-undo"));

    await waitFor(() =>
      expect(updateResource).toHaveBeenNthCalledWith(2, {
        resource: "workflow_template_steps",
        id: "step-1",
        patch: {
          next_operation_name: "second_op",
          next_operation_priority: 10,
          next_operation_delay_seconds: 30,
          condition_jsonlogic: { "==": [{ var: "status" }, "ok"] },
        },
      })
    );

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-next-step-1")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId("steps-builder-redo"));

    await waitFor(() =>
      expect(updateResource).toHaveBeenNthCalledWith(3, {
        resource: "workflow_template_steps",
        id: "step-1",
        patch: {
          next_operation_name: null,
          next_operation_priority: null,
          next_operation_delay_seconds: null,
          condition_jsonlogic: null,
        },
      })
    );

    await waitFor(() =>
      expect(screen.queryByTestId("steps-builder-step-next-step-1")).toBeNull()
    );
  });

  it("adds and connects a workflow step when dropping a connect handle on an insert point", async () => {
    const createWorkflowTemplateStep = jest.fn().mockResolvedValue({
      status: "ok",
      workflow_template_step_id: "step-3",
    });
    const getResource = jest.fn().mockResolvedValue({
      id: "step-3",
      operation_name: "third_op",
      transition_condition: "always",
      handler_key: null,
      enabled: true,
      manual_action_required: false,
    });
    const updateResource = jest.fn().mockResolvedValue({
      id: "step-1",
      operation_name: "first_op",
      transition_condition: "always",
      next_operation_name: "third_op",
    });

    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn().mockResolvedValue({
        resource: "lookup_definitions",
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      }),
      createWorkflowTemplateStep,
      getResource,
      reorderResource: jest.fn(),
      updateResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "first_op",
            transition_condition: "always",
          },
          {
            id: "step-2",
            operation_name: "second_op",
            transition_condition: "always",
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const transferData = new Map<string, string>();
    const dataTransfer = {
      setData: (key: string, value: string) => transferData.set(key, value),
      getData: (key: string) => transferData.get(key) ?? "",
      effectAllowed: "",
    };

    const fromPort = screen.getByTestId("steps-builder-connect-from-step-1");
    const insertAfter = screen.getByTestId("steps-builder-insert-after-step-1");

    fireEvent.dragStart(fromPort, { dataTransfer });
    fireEvent.dragOver(insertAfter, { dataTransfer });
    fireEvent.drop(insertAfter, { dataTransfer });
    fireEvent.dragEnd(fromPort, { dataTransfer });

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-add-modal")).toBeInTheDocument()
    );

    fireEvent.change(screen.getByTestId("steps-builder-add-operation"), {
      target: { value: "third_op" },
    });

    fireEvent.change(screen.getByTestId("steps-builder-add-transition"), {
      target: { value: "always" },
    });

    fireEvent.click(screen.getByTestId("steps-builder-add-submit"));

    await waitFor(() => expect(createWorkflowTemplateStep).toHaveBeenCalled());

    await waitFor(() =>
      expect(updateResource).toHaveBeenCalledWith({
        resource: "workflow_template_steps",
        id: "step-1",
        patch: { next_operation_name: "third_op" },
      })
    );

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-next-step-1")).toBeInTheDocument()
    );
  });

  it("undoes and redoes draft step reordering", async () => {
    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn(),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          { id: "step-1", operation_name: "dispatch_labels", transition_condition: "success" },
          { id: "step-2", operation_name: "download_labels", transition_condition: "always" },
        ]}
        idKey="id"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    expect(screen.getByTestId("steps-builder-save")).toBeDisabled();

    expect(screen.getByTestId("steps-builder-undo")).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Z Meta+Z"
    );
    expect(screen.getByTestId("steps-builder-redo")).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Shift+Z Meta+Shift+Z"
    );

    const step1 = screen.getByTestId("steps-builder-step-card-step-1");
    const step2 = screen.getByTestId("steps-builder-step-card-step-2");
    const dataTransfer = {
      getData: () => "step-1",
      setData: jest.fn(),
      effectAllowed: "move",
    };

    fireEvent.dragStart(step1, { dataTransfer });
    fireEvent.dragOver(step2, { dataTransfer });
    fireEvent.drop(step2, { dataTransfer });

    await waitFor(() => {
      const cards = screen.getAllByTestId(/steps-builder-step-card-step-/);
      expect(cards[0]).toHaveAttribute("data-testid", "steps-builder-step-card-step-2");
      expect(cards[1]).toHaveAttribute("data-testid", "steps-builder-step-card-step-1");
    });

    await waitFor(() => expect(screen.getByTestId("steps-builder-save")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("steps-builder-undo"));

    await waitFor(() => {
      const cards = screen.getAllByTestId(/steps-builder-step-card-step-/);
      expect(cards[0]).toHaveAttribute("data-testid", "steps-builder-step-card-step-1");
      expect(cards[1]).toHaveAttribute("data-testid", "steps-builder-step-card-step-2");
    });

    await waitFor(() => expect(screen.getByTestId("steps-builder-save")).toBeDisabled());

    fireEvent.click(screen.getByTestId("steps-builder-redo"));

    await waitFor(() => {
      const cards = screen.getAllByTestId(/steps-builder-step-card-step-/);
      expect(cards[0]).toHaveAttribute("data-testid", "steps-builder-step-card-step-2");
      expect(cards[1]).toHaveAttribute("data-testid", "steps-builder-step-card-step-1");
    });

    await waitFor(() => expect(screen.getByTestId("steps-builder-save")).not.toBeDisabled());
  });

  it("supports keyboard shortcuts for undo/redo", async () => {
    mockedCreateUiClient.mockReturnValue({
      listResource: jest.fn(),
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          { id: "step-1", operation_name: "dispatch_labels", transition_condition: "success" },
          { id: "step-2", operation_name: "download_labels", transition_condition: "always" },
        ]}
        idKey="id"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const step1 = screen.getByTestId("steps-builder-step-card-step-1");
    const step2 = screen.getByTestId("steps-builder-step-card-step-2");
    const dataTransfer = {
      getData: () => "step-1",
      setData: jest.fn(),
      effectAllowed: "move",
    };

    fireEvent.dragStart(step1, { dataTransfer });
    fireEvent.dragOver(step2, { dataTransfer });
    fireEvent.drop(step2, { dataTransfer });

    await waitFor(() => {
      const cards = screen.getAllByTestId(/steps-builder-step-card-step-/);
      expect(cards[0]).toHaveAttribute("data-testid", "steps-builder-step-card-step-2");
    });

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    await waitFor(() => {
      const cards = screen.getAllByTestId(/steps-builder-step-card-step-/);
      expect(cards[0]).toHaveAttribute("data-testid", "steps-builder-step-card-step-1");
    });

    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      const cards = screen.getAllByTestId(/steps-builder-step-card-step-/);
      expect(cards[0]).toHaveAttribute("data-testid", "steps-builder-step-card-step-2");
    });
  });

  it("shows operation library unavailable when operation handlers cannot be listed", async () => {
    const listResource = jest.fn(async (resource: string) => {
      if (resource === "operation_handlers") {
        throw new Error("ui_list_resource_v1 unknown resource operation_handlers");
      }
      return {
        resource,
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      };
    });

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    await waitFor(() =>
      expect(
        screen.getByText(/operation library unavailable/i)
      ).toBeInTheDocument()
    );

    expect(listResource).toHaveBeenCalledWith(
      "operation_handlers",
      { is_active: true },
      25,
      0,
      { key: "handler_key", direction: "asc" }
    );
  });

  it("renders docs links for operation suggestions in the add-step modal", async () => {
    const listResource = jest.fn(async (resource: string) => {
      if (resource === "operation_handlers") {
        return {
          resource,
          keys: ["handler_key"],
          items: [
            {
              handler_key: "dispatch_labels",
              handler_schema: "labels",
              doc_url: "https://example.com/docs/dispatch_labels",
            },
            { handler_key: "download_labels", handler_schema: "labels" },
          ],
          limit: 25,
          offset: 0,
          total: 2,
        };
      }
      return {
        resource,
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      };
    });

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[]}
        idKey="id"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-add"));

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
        "href",
        "https://example.com/docs/dispatch_labels"
      )
    );
  });

  it("groups the operation library by schema and hides unsafe doc urls", async () => {
    const listResource = jest.fn(async (resource: string) => {
      if (resource === "operation_handlers") {
        return {
          resource,
          keys: ["handler_key"],
          items: [
            {
              handler_key: "dispatch_labels",
              handler_schema: "labels",
              doc_url: "https://example.com/docs/dispatch_labels",
            },
            {
              handler_key: "unsafe_doc",
              handler_schema: "labels",
              doc_url: "javascript:alert(1)",
            },
            {
              handler_key: "protocol_relative",
              handler_schema: "labels",
              doc_url: "//example.com/docs/unsafe",
            },
            {
              handler_key: "address_intake",
              handler_schema: "shipping",
            },
          ],
          limit: 25,
          offset: 0,
          total: 3,
        };
      }
      return {
        resource,
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      };
    });

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    await waitFor(() => expect(screen.getByText("Labels")).toBeInTheDocument());
    expect(screen.getByText("Shipping")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "https://example.com/docs/dispatch_labels"
    );
    expect(screen.getAllByRole("link", { name: "Docs" })).toHaveLength(1);
  });

  it("shows workflow run step statuses on the flow cards", async () => {
    const listResource = jest.fn(async (resource: string) => {
      if (resource === "lookup_definitions") {
        return {
          resource,
          keys: ["id"],
          items: [],
          limit: 25,
          offset: 0,
          total: 0,
        };
      }
      if (resource === "workflow_run_steps") {
        return {
          resource,
          keys: ["id"],
          items: [
            {
              id: "run-step-1",
              workflow_template_step_id: "step-1",
              step_status: "completed",
              duration_ms: 1200,
            },
          ],
          limit: 200,
          offset: 0,
          total: 1,
        };
      }
      return {
        resource,
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      };
    });

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            enabled: true,
          },
        ]}
        runs={[
          {
            id: "run-1",
            workflow_status: "completed",
            created_at: "2026-01-20T00:00:00Z",
          },
        ]}
        appBasePath="/portal"
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    await waitFor(() =>
      expect(screen.getByText("Completed")).toBeInTheDocument()
    );
  });

  it("adds a workflow step by dropping an operation into the flow", async () => {
    const createWorkflowTemplateStep = jest.fn().mockResolvedValue({
      status: "ok",
      workflow_template_step_id: "step-99",
    });
    const reorderResource = jest.fn().mockResolvedValue({});
    const getResource = jest.fn().mockResolvedValue({
      id: "step-99",
      operation_name: "dispatch_labels",
      transition_condition: "success",
      handler_key: null,
      enabled: true,
      manual_action_required: false,
    });

    const listResource = jest.fn(async (resource: string) => {
      if (resource === "lookup_definitions") {
        return {
          resource,
          keys: ["id"],
          items: [{ id: "def-1", category: "workflow_transition" }],
          limit: 5,
          offset: 0,
          total: 1,
        };
      }
      if (resource === "lookup_values") {
        return {
          resource,
          keys: ["value"],
          items: [{ value: "success", label: "Success" }],
          limit: 100,
          offset: 0,
          total: 1,
        };
      }
      if (resource === "operation_handlers") {
        return {
          resource,
          keys: ["handler_key"],
          items: [{ handler_key: "dispatch_labels" }],
          limit: 25,
          offset: 0,
          total: 1,
        };
      }
      return {
        resource,
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      };
    });

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep,
      reorderResource,
      updateResource: jest.fn(),
      getResource,
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            operation_name: "dispatch_labels",
            transition_condition: "success",
            enabled: true,
          },
          {
            id: "step-2",
            operation_name: "download_labels",
            transition_condition: "always",
            enabled: true,
          },
        ]}
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const dropTarget = await screen.findByTestId("steps-builder-insert-after-step-1");
    const dataTransfer = {
      getData: (type: string) =>
        type === "application/x-masarx-operation" ? "dispatch_labels" : "",
      setData: jest.fn(),
      effectAllowed: "copy",
    };

    fireEvent.dragOver(dropTarget, { dataTransfer });
    fireEvent.drop(dropTarget, { dataTransfer });

    await waitFor(() => expect(createWorkflowTemplateStep).toHaveBeenCalled());
    await waitFor(() => expect(reorderResource).toHaveBeenCalled());

    expect(createWorkflowTemplateStep).toHaveBeenCalledWith({
      workflowTemplateId: "template-1",
      step: {
        operation_name: "dispatch_labels",
        transition_condition: "success",
        handler_key: "dispatch_labels",
        enabled: true,
        manual_action_required: false,
      },
    });
  });

  it("shows run preview details inside the step editor when available", async () => {
    const listResource = jest.fn(async (resource: string) => {
      if (resource === "workflow_run_steps") {
        return {
          resource,
          keys: ["id"],
          items: [
            {
              id: "run-step-1",
              workflow_run_id: "run-1",
              workflow_template_step_id: "step-1",
              sequence_order: 1,
              step_status: "failed",
              duration_ms: 4200,
              last_error: "boom",
              operation_result: { ok: false },
            },
          ],
          limit: 200,
          offset: 0,
          total: 1,
        };
      }
      return {
        resource,
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      };
    });

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            sequence_order: 1,
            operation_name: "dispatch_labels",
            transition_condition: "success",
            enabled: true,
            manual_action_required: false,
          },
        ]}
        runs={[{ id: "run-1" }]}
        appBasePath="/console"
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-step-card-step-1"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-step-editor-drawer")).toBeInTheDocument()
    );

    const preview = await screen.findByTestId("steps-builder-step-editor-run-preview");
    const scoped = within(preview);
    expect(scoped.getByText("Failed")).toBeInTheDocument();
    expect(scoped.getByText("Last error")).toBeInTheDocument();
    expect(scoped.getByText("Operation result")).toBeInTheDocument();
    expect(scoped.getByText("Raw run step data")).toBeInTheDocument();
  });

  it("opens the triggers drawer from the flow triggers card", async () => {
    const listResource = jest.fn(async (resource: string) => ({
      resource,
      keys: ["id"],
      items: [],
      limit: 25,
      offset: 0,
      total: 0,
    }));

    mockedCreateUiClient.mockReturnValue({
      listResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            sequence_order: 1,
            operation_name: "dispatch_labels",
            transition_condition: "success",
            enabled: true,
          },
        ]}
        triggers={[
          {
            webhook_source_id: "source-1",
            source_identifier: "source_one",
            name: "Source One",
            provider_type: "shopify",
            enabled: true,
          },
        ]}
        scheduleTriggers={[
          {
            id: "schedule-1",
            enabled: true,
            schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
            next_run_at: "2026-01-22T00:00:00Z",
          },
        ]}
        scheduleTriggersTotal={1}
        appBasePath="/console"
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    fireEvent.click(screen.getByTestId("steps-builder-triggers-card-open"));

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-triggers-card-drawer")).toBeInTheDocument()
    );

    const drawer = screen.getByTestId("steps-builder-triggers-card-drawer");
    const scoped = within(drawer);
    expect(scoped.getByText("Schedules: 1")).toBeInTheDocument();
    expect(scoped.getByTestId("steps-builder-triggers-card-schedules-new")).toBeInTheDocument();
  });

  it("opens the run inspector from the flow run preview", async () => {
    const listResource = jest.fn(async (resource: string) => {
      if (resource === "workflow_run_steps") {
        return {
          resource,
          keys: ["id"],
          items: [
            {
              id: "run-step-1",
              workflow_template_step_id: "step-1",
              sequence_order: 1,
              step_status: "completed",
              duration_ms: 1200,
              operation_name: "dispatch_labels",
              last_error: null,
            },
            {
              id: "run-step-2",
              workflow_template_step_id: "step-2",
              sequence_order: 2,
              step_status: "failed",
              duration_ms: 2200,
              operation_name: "wait_for_job",
              last_error: "boom",
            },
          ],
          limit: 200,
          offset: 0,
          total: 2,
        };
      }
      return {
        resource,
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      };
    });
    const getResource = jest.fn(async (resource: string, id: string) => {
      if (resource !== "workflow_runs") return null;
      return {
        id,
        workflow_status: "completed",
        created_at: "2026-01-22T00:00:00Z",
        context: { outputs: { label_url: "https://example.com/label.pdf" } },
        metadata: {},
      };
    });

    mockedCreateUiClient.mockReturnValue({
      listResource,
      getResource,
      createWorkflowTemplateStep: jest.fn(),
      reorderResource: jest.fn(),
      updateResource: jest.fn(),
      rpc: jest.fn(),
    });

    renderWithIntl(
      <WorkflowTemplateStepsBuilder
        workflowTemplateId="template-1"
        resourceKey="workflow_template_steps"
        steps={[
          {
            id: "step-1",
            sequence_order: 1,
            operation_name: "dispatch_labels",
            transition_condition: "success",
            enabled: true,
          },
          {
            id: "step-2",
            sequence_order: 2,
            operation_name: "wait_for_job",
            transition_condition: "success",
            enabled: true,
          },
        ]}
        runs={[{ id: "run-1", workflow_status: "completed" }]}
        appBasePath="/console"
        idKey="id"
        layout="flow"
        reorder={{ order_column: "sequence_order", capability: "workflow_runs.write" }}
        capabilities={["workflow_runs.write"]}
        capabilityWrite="workflow_runs.write"
        testIdPrefix="steps-builder"
      />
    );

    const inspect = await screen.findByTestId("steps-builder-run-preview-inspect");
    fireEvent.click(inspect);

    await waitFor(() =>
      expect(screen.getByTestId("steps-builder-run-inspector-drawer")).toBeInTheDocument()
    );

    await waitFor(() =>
      expect(getResource).toHaveBeenCalledWith("workflow_runs", "run-1")
    );

    const drawer = screen.getByTestId("steps-builder-run-inspector-drawer");
    const scoped = within(drawer);
    expect(scoped.getByText("Run logs")).toBeInTheDocument();
    expect(
      scoped.getByTestId("steps-builder-run-inspector-logs-tab-simple")
    ).toBeInTheDocument();
    const advancedTab = scoped.getByTestId("steps-builder-run-inspector-logs-tab-advanced");
    expect(advancedTab).toBeInTheDocument();
    expect(scoped.getByText("Outputs")).toBeInTheDocument();
    expect(scoped.getByText("https://example.com/label.pdf")).toBeInTheDocument();
    expect(scoped.getByText("Steps")).toBeInTheDocument();
    expect(scoped.getAllByText("Dispatch Labels").length).toBeGreaterThan(0);
    expect(scoped.getAllByText("Wait For Job").length).toBeGreaterThan(0);

    const logsSimple = scoped.getByTestId("steps-builder-run-inspector-logs-simple");
    expect(within(logsSimple).getByText("Dispatch Labels")).toBeInTheDocument();
    expect(within(logsSimple).getByText("Wait For Job")).toBeInTheDocument();

    const stepOneCard = scoped.getByTestId("steps-builder-run-inspector-step-card-step-1");
    fireEvent.click(stepOneCard);
    await waitFor(() => {
      expect(stepOneCard).toHaveAttribute("aria-pressed", "true");
      expect(within(logsSimple).getByText("Dispatch Labels")).toBeInTheDocument();
      expect(within(logsSimple).queryByText("Wait For Job")).not.toBeInTheDocument();
    });

    const stepTwoCard = scoped.getByTestId("steps-builder-run-inspector-step-card-step-2");
    fireEvent.click(stepTwoCard);
    await waitFor(() => {
      expect(stepTwoCard).toHaveAttribute("aria-pressed", "true");
      expect(within(logsSimple).getByText("Wait For Job")).toBeInTheDocument();
      expect(within(logsSimple).queryByText("Dispatch Labels")).not.toBeInTheDocument();
    });

    fireEvent.mouseDown(advancedTab);
    fireEvent.click(advancedTab);
    await waitFor(() =>
      expect(
        scoped.getByTestId("steps-builder-run-inspector-logs-filter-search")
      ).toBeInTheDocument()
    );
    expect(
      scoped.getByTestId("steps-builder-run-inspector-logs-action-copy-json")
    ).toBeInTheDocument();
    expect(
      scoped.getByTestId("steps-builder-run-inspector-logs-action-download-json")
    ).toBeInTheDocument();
  });
});
