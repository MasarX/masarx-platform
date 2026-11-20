import * as React from "react";

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(),
}));

import { createUiClient } from "@masarx/api";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JsonSchemaForm } from "../../packages/ui/src/json-schema-form";

const mockedCreateUiClient = createUiClient as unknown as jest.Mock;

describe("JsonSchemaForm", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders resource_select widgets from x-ui metadata", async () => {
    const listResource = jest.fn().mockResolvedValue({
      resource: "workflow_templates",
      keys: ["id", "name"],
      items: [
        { id: "11111111-1111-1111-1111-111111111111", name: "Template One" },
        { id: "22222222-2222-2222-2222-222222222222", name: "Template Two" },
      ],
      limit: 100,
      offset: 0,
      total: 2,
    });

    mockedCreateUiClient.mockReturnValue({ listResource });

    const onChange = jest.fn();

    render(
      <JsonSchemaForm
        schema={{
          type: "object",
          properties: {
            child_workflow_template_id: {
              type: "string",
              format: "uuid",
              "x-ui": {
                widget: "resource_select",
                resource: "workflow_templates",
                label_column: "name",
                filters: { status: "active" },
              },
            },
          },
          required: ["child_workflow_template_id"],
        }}
        value={{}}
        onChange={onChange}
        testIdPrefix="schema-form"
      />
    );

    await waitFor(() => expect(listResource).toHaveBeenCalled());

    expect(listResource).toHaveBeenCalledWith(
      "workflow_templates",
      { status: "active" },
      100,
      0,
      { key: "name", direction: "asc" }
    );

    // The resource_select widget renders a Combobox with role="combobox"
    const combobox = screen.getByRole("combobox");
    expect(combobox).toBeInTheDocument();

    // Open the combobox to see options
    fireEvent.click(combobox);

    // Options should appear in the listbox
    await waitFor(() => {
      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(2);
      expect(options[0]).toHaveTextContent("Template One");
      expect(options[1]).toHaveTextContent("Template Two");
    });

    // Select the second option
    const options = screen.getAllByRole("option");
    fireEvent.click(options[1]);

    expect(onChange).toHaveBeenLastCalledWith({
      child_workflow_template_id: "22222222-2222-2222-2222-222222222222",
    });

    // Re-open and type a search query to filter
    fireEvent.click(combobox);
    const searchInput = screen.getByRole("searchbox");
    fireEvent.change(searchInput, { target: { value: "Two" } });

    await waitFor(() => {
      const filteredOptions = screen.getAllByRole("option");
      expect(filteredOptions).toHaveLength(1);
      expect(filteredOptions[0]).toHaveTextContent("Template Two");
    });
  });

  it("shows reference-style labels for stale selected resource ids instead of raw ids", async () => {
    const listResource = jest.fn().mockResolvedValue({
      resource: "workflow_templates",
      keys: ["id", "name"],
      items: [{ id: "11111111-1111-1111-1111-111111111111", name: "Template One" }],
      limit: 100,
      offset: 0,
      total: 1,
    });

    mockedCreateUiClient.mockReturnValue({ listResource });

    render(
      <JsonSchemaForm
        schema={{
          type: "object",
          properties: {
            child_workflow_template_id: {
              type: "string",
              format: "uuid",
              "x-ui": {
                widget: "resource_select",
                resource: "workflow_templates",
                label_column: "name",
              },
            },
          },
        }}
        value={{
          child_workflow_template_id: "33333333-3333-3333-3333-333333333333",
        }}
        onChange={jest.fn()}
      />
    );

    await waitFor(() => expect(listResource).toHaveBeenCalled());

    const combobox = screen.getByRole("combobox");
    expect(combobox).toHaveTextContent("REF-333333");
    expect(combobox).not.toHaveTextContent(
      "33333333-3333-3333-3333-333333333333"
    );
  });

  it("shows reference-style labels for fetched resource rows without friendly labels", async () => {
    const workflowTemplateId = "44444444-5555-4666-8777-888888888888";
    const listResource = jest.fn().mockResolvedValue({
      resource: "workflow_templates",
      keys: ["id", "name"],
      items: [{ id: workflowTemplateId, name: "" }],
      limit: 100,
      offset: 0,
      total: 1,
    });

    mockedCreateUiClient.mockReturnValue({ listResource });

    const onChange = jest.fn();

    render(
      <JsonSchemaForm
        schema={{
          type: "object",
          properties: {
            child_workflow_template_id: {
              type: "string",
              format: "uuid",
              "x-ui": {
                widget: "resource_select",
                resource: "workflow_templates",
                label_column: "name",
              },
            },
          },
        }}
        value={{}}
        onChange={onChange}
      />
    );

    await waitFor(() => expect(listResource).toHaveBeenCalled());

    const combobox = screen.getByRole("combobox");
    fireEvent.click(combobox);

    const option = await screen.findByRole("option", { name: "REF-44448888" });
    expect(option).not.toHaveTextContent(workflowTemplateId);

    fireEvent.click(option);

    expect(onChange).toHaveBeenLastCalledWith({
      child_workflow_template_id: workflowTemplateId,
    });
  });

  it("does not expose distinct raw UUID resource labels as primary option text", async () => {
    const workflowTemplateId = "44444444-5555-4666-8777-888888888888";
    const rawUuidLabel = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
    const listResource = jest.fn().mockResolvedValue({
      resource: "workflow_templates",
      keys: ["id", "name"],
      items: [{ id: workflowTemplateId, name: rawUuidLabel }],
      limit: 100,
      offset: 0,
      total: 1,
    });

    mockedCreateUiClient.mockReturnValue({ listResource });

    const onChange = jest.fn();

    render(
      <JsonSchemaForm
        schema={{
          type: "object",
          properties: {
            child_workflow_template_id: {
              type: "string",
              format: "uuid",
              "x-ui": {
                widget: "resource_select",
                resource: "workflow_templates",
                label_column: "name",
              },
            },
          },
        }}
        value={{}}
        onChange={onChange}
      />
    );

    await waitFor(() => expect(listResource).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("combobox"));
    const option = await screen.findByRole("option", { name: "REF-44448888" });
    expect(option).not.toHaveTextContent(rawUuidLabel);

    fireEvent.click(option);

    expect(onChange).toHaveBeenLastCalledWith({
      child_workflow_template_id: workflowTemplateId,
    });
  });

  it("renders workflow metadata UUID fields as resource selectors when lookup metadata is present", async () => {
    const workflowTemplateId = "11111111-1111-1111-1111-111111111111";
    const workflowRunId = "33333333-3333-3333-3333-333333333333";
    const listResource = jest.fn(async (resource: string) => {
      if (resource === "workflow_templates") {
        return {
          resource,
          keys: ["id", "name"],
          items: [{ id: workflowTemplateId, name: "Child workflow" }],
          limit: 100,
          offset: 0,
          total: 1,
        };
      }

      if (resource === "workflow_runs") {
        return {
          resource,
          keys: ["id", "run_reference"],
          items: [{ id: workflowRunId, run_reference: "Child run 42" }],
          limit: 100,
          offset: 0,
          total: 1,
        };
      }

      return {
        resource,
        keys: ["id"],
        items: [],
        limit: 100,
        offset: 0,
        total: 0,
      };
    });

    mockedCreateUiClient.mockReturnValue({ listResource });

    const onChange = jest.fn();
    const workflowMetadataSchema = {
      type: "object",
      properties: {
        workflow_template_id: {
          title: "Workflow template",
          type: "string",
          format: "uuid",
          "x-ui": {
            widget: "resource_select",
            resource: "workflow_templates",
            label_column: "name",
            filters: { status: "active" },
          },
        },
        child_workflow_run_id: {
          title: "Child workflow run",
          type: "string",
          format: "uuid",
          "x-ui": {
            widget: "resource_select",
            resource: "workflow_runs",
            label_column: "run_reference",
            filters: { workflow_status: "in_progress" },
          },
        },
      },
    };

    function WorkflowMetadataFormHarness() {
      const [value, setValue] = React.useState<Record<string, unknown>>({});
      return (
        <JsonSchemaForm
          schema={workflowMetadataSchema}
          value={value}
          onChange={(nextValue) => {
            onChange(nextValue);
            setValue(
              nextValue && typeof nextValue === "object"
                ? (nextValue as Record<string, unknown>)
                : {}
            );
          }}
          testIdPrefix="schema-form"
        />
      );
    }

    render(<WorkflowMetadataFormHarness />);

    await waitFor(() => expect(listResource).toHaveBeenCalledTimes(2));

    expect(listResource).toHaveBeenCalledWith(
      "workflow_templates",
      { status: "active" },
      100,
      0,
      { key: "name", direction: "asc" }
    );
    expect(listResource).toHaveBeenCalledWith(
      "workflow_runs",
      { workflow_status: "in_progress" },
      100,
      0,
      { key: "run_reference", direction: "asc" }
    );

    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes).toHaveLength(2);

    fireEvent.click(screen.getByRole("combobox", { name: "Child workflow run" }));
    fireEvent.click(await screen.findByRole("option", { name: "Child run 42" }));

    expect(onChange).toHaveBeenLastCalledWith({
      child_workflow_run_id: workflowRunId,
    });

    fireEvent.click(screen.getByRole("combobox", { name: "Workflow template" }));
    fireEvent.click(await screen.findByRole("option", { name: "Child workflow" }));

    expect(onChange).toHaveBeenLastCalledWith({
      child_workflow_run_id: workflowRunId,
      workflow_template_id: workflowTemplateId,
    });
  });

  it("uses user-friendly labels for enum values while preserving canonical values", () => {
    const onChange = jest.fn();

    render(
      <JsonSchemaForm
        schema={{
          type: "object",
          properties: {
            ndr_action: {
              type: "string",
              enum: ["hold_at_branch", "return_to_sender"],
            },
          },
        }}
        value={{ ndr_action: "return_to_sender" }}
        onChange={onChange}
      />
    );

    const select = screen.getByRole("combobox");
    expect(select).toHaveDisplayValue("Return To Sender");

    fireEvent.change(select, { target: { value: "hold_at_branch" } });

    expect(onChange).toHaveBeenLastCalledWith({
      ndr_action: "hold_at_branch",
    });
  });
});
