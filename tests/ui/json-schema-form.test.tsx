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
});
