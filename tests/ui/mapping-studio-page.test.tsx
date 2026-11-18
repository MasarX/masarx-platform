import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createUiClient } from "@masarx/api";
import { MappingStudioPage } from "../../packages/ui/src/mapping-studio-page";

const readRegistry = jest.fn();
const listResource = jest.fn();
const preview = jest.fn();
const parse = jest.fn();
const infer = jest.fn();
const save = jest.fn();
const mockToast = jest.fn();

jest.mock("@masarx/api", () => {
  const actual = jest.requireActual("@masarx/api");
  return {
    ...actual,
    createUiClient: jest.fn(),
  };
});

jest.mock("../../packages/ui/src/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

describe("MappingStudioPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    readRegistry.mockResolvedValue({ resources: [] });
    listResource.mockResolvedValue({
      resource: "workflow_templates",
      keys: ["id", "name"],
      items: [
        {
          id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
          name: "Dispatch exception workflow",
        },
      ],
    });
    preview.mockResolvedValue({
      ok: true,
      save_modes: { direct_allowed: true, recommended: "direct" },
      review: { review_summary: { blocking_count: 0, warning_count: 0, coercion_count: 0 } },
    });
    (createUiClient as jest.Mock).mockReturnValue({
      readRegistry,
      listResource,
      mappingStudio: { parse, infer, preview, save },
    });
  });

  test("uses workflow template lookup labels and submits canonical workflow binding ids", async () => {
    render(
      <MappingStudioPage
        appBasePath="/console"
        initialArtifact="webhook_inbound"
        testIdPrefix="mapping-studio-test"
      />,
    );

    await waitFor(() =>
      expect(listResource).toHaveBeenCalledWith(
        "workflow_templates",
        {},
        200,
        0,
        { key: "name", direction: "asc" },
      ),
    );

    expect(screen.queryByText("Workflow binding JSON")).toBeNull();
    fireEvent.change(screen.getByLabelText("Workflow binding mode"), {
      target: { value: "attach_existing" },
    });
    fireEvent.change(screen.getByLabelText("Workflow template"), {
      target: { value: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830" },
    });

    expect(screen.getByRole("option", { name: "Dispatch exception workflow" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Build review" }));

    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_binding: {
          mode: "attach_existing",
          workflow_template_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
        },
      }),
    );
  });
});
