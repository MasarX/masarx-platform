import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MappingStudioPage } from "../../packages/ui/src/mapping-studio-page";

const mockUi = {
  readRegistry: jest.fn(),
  mappingStudio: { parse: jest.fn(), infer: jest.fn(), preview: jest.fn(), save: jest.fn() },
};
const mockToast = jest.fn();
jest.mock("@masarx/api", () => ({ createUiClient: () => mockUi }));
jest.mock("../../packages/ui/src/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock("../../packages/ui/src/tabular-file", () => ({ TABULAR_FILE_ACCEPT: ".csv", parseTabularFile: jest.fn() }));
jest.mock("../../packages/ui/src/mapping-studio/mapping-test-panel", () => ({ MappingTestPanel: () => null }));
jest.mock("../../packages/ui/src/mapping-studio/payload-path-picker", () => ({ PayloadPathPicker: () => null }));
jest.mock("../../packages/ui/src/mapping-studio/spreadsheet-preview", () => ({ SpreadsheetPreview: () => null }));
jest.mock("../../packages/ui/src/mapping-studio/review-diagnostics", () => ({ ReviewDiagnostics: () => null }));
jest.mock("../../packages/ui/src/mapping-studio/operation-report-viewer", () => ({ OperationReportViewer: () => null }));
jest.mock("../../packages/ui/src/mapping-studio/openapi-operation-preview", () => ({ OpenApiOperationPreview: () => null }));

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function start(artifact: "webhook_inbound" | "api_outbound" = "webhook_inbound") {
  const view = render(<MappingStudioPage appBasePath="/console" initialArtifact={artifact} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Parse / infer" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Source contract / sample"), { target: { value: '{"id":"one"}' } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Parse / infer" }));
  });
  return view;
}

describe("MappingStudioPage canonical roundtrip", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUi.readRegistry.mockResolvedValue({ resources: [{ key: "shipments", columns: [] }] });
    mockUi.mappingStudio.preview.mockResolvedValue({ review: { diagnostics: [], review_summary: {} }, save_modes: { direct_allowed: true } });
    mockUi.mappingStudio.save.mockResolvedValue({ ok: true, save_mode: "direct" });
  });

  test.each([
    { field_mappings: { id: ["$.id", "$.legacy"] }, metadata: { retained: true } },
    { transforms: { shipment: { id: ["$.id", "$.legacy"] } }, metadata: { retained: true } },
  ])("Review and Save send the same effective runtime config %j", async (mapping) => {
    mockUi.mappingStudio.parse.mockResolvedValue({ mapping_suggestion: { ...mapping, artifact: "api_outbound" } });
    await start();
    await waitFor(() => expect(screen.getByRole("button", { name: "Build review" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Build review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mockUi.mappingStudio.save).toHaveBeenCalledTimes(1));
    const reviewed = mockUi.mappingStudio.preview.mock.calls[0][0].mapping_config;
    expect(reviewed).toEqual({ version: 1, ...mapping, artifact: "webhook_inbound" });
    expect(mockUi.mappingStudio.save.mock.calls[0][0].mapping_config).toEqual(reviewed);
  });

  test("editing and clearing primary retain remaining fallback paths on submission", async () => {
    mockUi.mappingStudio.parse.mockResolvedValue({ mapping_suggestion: { field_mappings: { id: ["$.id", "$.legacy"] } } });
    await start();
    const input = await screen.findByLabelText("Source path / column");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Build review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mockUi.mappingStudio.save).toHaveBeenCalledTimes(1));
    expect(mockUi.mappingStudio.save.mock.calls[0][0].mapping_config.field_mappings).toEqual({ id: ["$.legacy"] });
  });

  test("late parse after source change neither dispatches infer nor installs stale rules", async () => {
    const pending = deferred();
    mockUi.mappingStudio.parse.mockReturnValue(pending.promise);
    await start("api_outbound");
    fireEvent.change(screen.getByLabelText("Source contract / sample"), { target: { value: '{"id":"two"}' } });
    await act(async () => { pending.resolve({ normalized_contract: {}, mapping_suggestion: { field_mappings: { stale: "$.old" } } }); });
    expect(mockUi.mappingStudio.infer).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("stale")).toBeNull();
    expect(screen.getByRole("button", { name: "Parse / infer" })).toBeEnabled();
  });

  test("late infer after artifact change does not restore previous artifact mapping", async () => {
    const pending = deferred();
    mockUi.mappingStudio.parse.mockResolvedValue({ normalized_contract: {} });
    mockUi.mappingStudio.infer.mockReturnValue(pending.promise);
    await start("api_outbound");
    await waitFor(() => expect(mockUi.mappingStudio.infer).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Artifact"), { target: { value: "webhook_inbound" } });
    await act(async () => { pending.resolve({ mapping_suggestion: { field_mappings: { stale: "$.old" } } }); });
    expect(screen.queryByDisplayValue("stale")).toBeNull();
    expect(screen.getByLabelText("Artifact")).toHaveValue("webhook_inbound");
  });

  test("malformed reparse does not combine new config with previous accepted rules", async () => {
    mockUi.mappingStudio.parse.mockResolvedValueOnce({ mapping_suggestion: { field_mappings: { id: ["$.id", "$.legacy"] }, metadata: { accepted: true } } });
    await start();
    await screen.findByLabelText("Source path / column");
    mockUi.mappingStudio.parse.mockResolvedValueOnce({ mapping_suggestion: { field_mappings: { invalid: ["$.id", 7] }, metadata: { poisoned: true } } });
    fireEvent.click(screen.getByRole("button", { name: "Parse / infer" }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Source parse failed" })));
    fireEvent.click(screen.getByRole("button", { name: "Build review" }));
    await waitFor(() => expect(mockUi.mappingStudio.preview).toHaveBeenCalled());
    expect(mockUi.mappingStudio.preview.mock.calls[0][0].mapping_config).toEqual({
      version: 1, artifact: "webhook_inbound", field_mappings: { id: ["$.id", "$.legacy"] }, metadata: { accepted: true },
    });
  });

  test("changing source clears accepted mapping and review while internal request suggestions do not", async () => {
    mockUi.mappingStudio.parse.mockResolvedValue({ normalized_contract: {} });
    mockUi.mappingStudio.infer.mockResolvedValue({
      mapping_suggestion: { field_mappings: { id: ["$.id", "$.legacy"] } },
      outbound_suggestions: [{ method: "POST", url_template: "https://example.com" }],
    });
    await start("api_outbound");
    await screen.findByLabelText("Source path / column");
    expect((screen.getByLabelText("Request config JSON") as HTMLTextAreaElement).value).toContain("https://example.com");
    fireEvent.click(screen.getByRole("button", { name: "Build review" }));
    await screen.findByRole("button", { name: "Submit" });
    fireEvent.change(screen.getByLabelText("Source contract / sample"), { target: { value: '{"id":"new"}' } });
    expect(screen.queryByLabelText("Source path / column")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });

  test("late review after source change cannot restore submit eligibility", async () => {
    mockUi.mappingStudio.parse.mockResolvedValue({ mapping_suggestion: { field_mappings: { id: "$.id" } } });
    const pending = deferred();
    mockUi.mappingStudio.preview.mockReturnValueOnce(pending.promise);
    await start();
    await screen.findByLabelText("Source path / column");
    fireEvent.click(screen.getByRole("button", { name: "Build review" }));
    fireEvent.change(screen.getByLabelText("Source contract / sample"), { target: { value: '{"id":"new"}' } });
    await act(async () => { pending.resolve({ review: { diagnostics: [] }, save_modes: { direct_allowed: true } }); });
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(screen.queryByLabelText("Source path / column")).toBeNull();
  });

  test("late save after artifact change cannot install old report or success toast", async () => {
    mockUi.mappingStudio.parse.mockResolvedValue({ mapping_suggestion: { field_mappings: { id: "$.id" } } });
    const pending = deferred();
    mockUi.mappingStudio.save.mockReturnValueOnce(pending.promise);
    await start();
    await screen.findByLabelText("Source path / column");
    fireEvent.click(screen.getByRole("button", { name: "Build review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mockUi.mappingStudio.save).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Artifact"), { target: { value: "api_outbound" } });
    await act(async () => { pending.resolve({ ok: true, save_mode: "direct", report: { id: "old-report" } }); });
    expect(screen.queryByText("Submit report")).toBeNull();
    expect(mockToast).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Artifact")).toHaveValue("api_outbound");
  });

  describe.each(["pending", "completed"])("%s review invalidation", (phase) => {
    const edits: Array<[string, () => void]> = [
      ["rule edit", () => fireEvent.change(screen.getByLabelText("Source path / column"), { target: { value: "$.new" } })],
      ["rule add", () => fireEvent.click(screen.getByRole("button", { name: "Add rule" }))],
      ["rule remove", () => fireEvent.click(screen.getByRole("button", { name: "Remove" }))],
      ["target schema", () => fireEvent.change(screen.getByLabelText("Target schema JSON"), { target: { value: '{"type":"object","required":["id"]}' } })],
      ["workflow binding", () => fireEvent.change(screen.getByLabelText("Workflow binding JSON"), { target: { value: '{"mode":"draft"}' } })],
      ["target resource", () => fireEvent.change(screen.getByLabelText("Target resource (optional)"), { target: { value: "shipments" } })],
    ];
    test.each(edits)("%s requires a fresh review without erasing source input", async (_name, edit) => {
      mockUi.mappingStudio.parse.mockResolvedValue({ mapping_suggestion: { field_mappings: { id: ["$.id", "$.legacy"] } } });
      const pending = deferred();
      if (phase === "pending") mockUi.mappingStudio.preview.mockReturnValueOnce(pending.promise);
      await start();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Build review" })); });
      if (phase === "completed") await screen.findByRole("button", { name: "Submit" });
      edit();
      if (phase === "pending") {
        await act(async () => { pending.resolve({ review: { diagnostics: [] }, save_modes: { direct_allowed: true } }); });
      }
      expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
      expect(screen.getByLabelText("Source contract / sample")).toHaveValue('{"id":"one"}');
      expect(mockUi.mappingStudio.save).not.toHaveBeenCalled();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Build review" })); });
      expect(await screen.findByRole("button", { name: "Submit" })).toBeEnabled();
    });
  });

  test("same context object replacement retains form but a new source context resets it", async () => {
    mockUi.mappingStudio.parse.mockResolvedValue({ mapping_suggestion: { field_mappings: { id: "$.id" } } });
    const view = render(<MappingStudioPage appBasePath="/console" initialArtifact="webhook_inbound" initialContext={{ webhookSourceId: "source-a" }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Parse / infer" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Source contract / sample"), { target: { value: '{"id":"one"}' } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Parse / infer" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Build review" })); });
    await screen.findByRole("button", { name: "Submit" });
    view.rerender(<MappingStudioPage appBasePath="/console" initialArtifact="webhook_inbound" initialContext={{ webhookSourceId: "source-a" }} />);
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
    view.rerender(<MappingStudioPage appBasePath="/console" initialArtifact="webhook_inbound" initialContext={{ webhookSourceId: "source-b" }} />);
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(screen.queryByLabelText("Source path / column")).toBeNull();
    expect(screen.getByLabelText("Source contract / sample")).toHaveValue("");
    await waitFor(() => expect(screen.getByRole("button", { name: "Parse / infer" })).toBeEnabled());
  });

  test("a stale save retains serial mutation admission across source context replacement", async () => {
    mockUi.mappingStudio.parse.mockResolvedValue({ mapping_suggestion: { field_mappings: { id: "$.id" } } });
    const pending = deferred();
    mockUi.mappingStudio.save.mockReturnValueOnce(pending.promise);
    const view = await start();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Build review" })); });
    const submit = await screen.findByRole("button", { name: "Submit" });
    await act(async () => { fireEvent.click(submit); });
    view.rerender(<MappingStudioPage appBasePath="/console" initialArtifact="webhook_inbound" initialContext={{ webhookSourceId: "source-b" }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Parse / infer" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Source contract / sample"), { target: { value: '{"id":"two"}' } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Parse / infer" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Build review" })); });
    expect(await screen.findByRole("button", { name: "Submit" })).toBeDisabled();
    expect(mockUi.mappingStudio.save).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ ok: true, report: { id: "obsolete" } }); });
    expect(mockToast).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Submit" })); });
    expect(mockUi.mappingStudio.save).toHaveBeenCalledTimes(2);
    expect(mockUi.mappingStudio.save.mock.calls[1][0].webhook_source_id).toBe("source-b");
  });

  test("save-only notes edit discards obsolete response without hiding reviewed mode choices", async () => {
    mockUi.mappingStudio.parse.mockResolvedValue({ mapping_suggestion: { field_mappings: { id: "$.id" } } });
    const pending = deferred();
    mockUi.mappingStudio.save.mockReturnValueOnce(pending.promise);
    await start();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Build review" })); });
    const submit = await screen.findByRole("button", { name: "Submit" });
    await act(async () => { fireEvent.click(submit); });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "New notes" } });
    expect(screen.getByLabelText("Save mode")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    await act(async () => { pending.resolve({ ok: true, report: { id: "obsolete" } }); });
    expect(mockToast).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
  });

  test("late parse after unmount does not dispatch infer or report an obsolete failure", async () => {
    const pending = deferred();
    mockUi.mappingStudio.parse.mockReturnValue(pending.promise);
    const view = await start("api_outbound");
    view.unmount();
    await act(async () => { pending.resolve({ normalized_contract: {} }); });
    expect(mockUi.mappingStudio.infer).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });
});
