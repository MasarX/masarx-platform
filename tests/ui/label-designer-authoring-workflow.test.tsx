import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DraftWorkflow } from "../../packages/ui/src/label-designer/draft-workflow";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

jest.mock("../../packages/ui/src/label-designer/canvas/label-canvas", () => ({
  LabelCanvas: ({ blocks, page, onBlocksChange, onUndo, onRedo, canUndo, canRedo }: { blocks: TemplateBlock[]; page: unknown; onBlocksChange: (blocks: TemplateBlock[]) => void; onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean }) => <div>
    <output data-testid="selected-template">{JSON.stringify({ blocks, page })}</output>
    <button onClick={() => onBlocksChange(blocks.map((block) => ({ ...block, x: 77 })))}>Move selected</button>
    <button disabled={!canUndo} onClick={onUndo}>Undo edit</button><button disabled={!canRedo} onClick={onRedo}>Redo edit</button>
  </div>,
}));
const draft = { id: "draft", scope_type: "tenant" as const, scope_id: "org", label_type: "return", draft_name: "Design", draft_value: {}, status: "draft", updated_at: null, published_at: null };
const document = { marker: "keep", templates: {
  shipping: { page: { width_inch: 4 }, blocks: [{ type: "text", x: 3, y: 4, fallback: "shipping" }], metadata: "keep" },
  return: { page: { width_inch: 3 }, blocks: [{ type: "text", x: 5, y: 6, fallback: "return" }] },
} };
const callbacks = { onDraftSelection: jest.fn(), onDraftNameChange: jest.fn(), onLabelTypeChange: jest.fn(), onCreateDraft: jest.fn(), onSaveDraft: jest.fn(), onValidateDraft: jest.fn(), onPublishDraft: jest.fn() };
const change = jest.fn();
function Editor({ readOnly = false, busy = false, published = false, initialDocument = document }: { readOnly?: boolean; busy?: boolean; published?: boolean; initialDocument?: unknown }) {
  const [value, setValue] = React.useState(JSON.stringify(initialDocument));
  return <DraftWorkflow {...callbacks} prefix="ld" canWrite={!readOnly} isBusy={busy} busyAction={null} selectedScope={{ scopeType: "tenant", scopeId: "org" }} drafts={[{ ...draft, status: published ? "published" : "draft" }]} selectedDraftId="draft" draftName="Design" labelType="return" labelTypeOptions={["shipping", { value: "return", label: "Return label" }]} draftEditor={value} draftEditorError={null} fieldCatalogJson={JSON.stringify({ fields: [{ value_path: "shipment.code", label_en: "Code", data_type: "string" }] })} onDraftEditorChange={(next) => { change(next); setValue(next); }} />;
}
beforeEach(() => { change.mockClear(); Object.values(callbacks).forEach((callback) => callback.mockClear()); });

test("selected template edits roundtrip alone, with reactive undo/redo and canonical option labels", async () => {
  render(<Editor />);
  expect(await screen.findByTestId("selected-template")).toHaveTextContent('"fallback":"return"');
  expect(screen.getByRole("option", { name: "Return label" })).toHaveValue("return");
  expect(await screen.findByText("shipment.code")).toBeInTheDocument();
  expect(screen.getByText("Code")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Move selected"));
  let next = JSON.parse(change.mock.calls.at(-1)![0]);
  expect(next.templates.shipping).toEqual(document.templates.shipping);
  expect(next.marker).toBe("keep");
  expect(next.templates.return.blocks[0].x).toBe(77);
  fireEvent.click(screen.getByText("Undo edit"));
  expect(JSON.parse(change.mock.calls.at(-1)![0])).toEqual(document);
  fireEvent.click(screen.getByText("Redo edit"));
  next = JSON.parse(change.mock.calls.at(-1)![0]);
  expect(next.templates.return.blocks[0].x).toBe(77);
  expect(next.templates.shipping).toEqual(document.templates.shipping);
});

test("catalog additions update only the selected template and are undoable/redoable", async () => {
  render(<Editor />);
  fireEvent.click(await screen.findByRole("button", { name: "Text" }));
  const next = JSON.parse(change.mock.calls.at(-1)![0]);
  expect(next.templates.shipping).toEqual(document.templates.shipping);
  expect(next.templates.return.blocks).toHaveLength(2);
  expect(next.templates.return.blocks[1]).toMatchObject({ type: "text", fallback: "Text", width: 150, height: 20 });
  // First selection loads the lazy property panel; wait for the authoring surface, not its hidden Suspense predecessor.
  await waitFor(() => expect(screen.getByText("Undo edit")).toBeEnabled());
  fireEvent.click(screen.getByText("Undo edit"));
  expect(JSON.parse(change.mock.calls.at(-1)![0])).toEqual(document);
  fireEvent.click(screen.getByText("Redo edit"));
  expect(JSON.parse(change.mock.calls.at(-1)![0])).toEqual(next);
});

test.each([
  { type: "text", x: 270, y: 100, align: "right", value_path: "sender_phone" },
  { type: "text", x: 276, y: 110, width: 264, height: 20, align: "right", fallback: "Address" },
  { type: "text", x: 144, y: 120, width: 264, height: 20, align: "center", fallback: "Title" },
])("real property-panel font edits preserve the authored geometry: %p", async (block) => {
  const initialDocument = { page: { width_inch: 4, height_inch: 6 }, blocks: [block] };
  const { container } = render(<Editor initialDocument={initialDocument} />);
  fireEvent.click(await screen.findByTestId("layer-0"));
  await screen.findByTestId("ld-block-props-panel");
  fireEvent.change(container.querySelector("#ld-block-props-0-font_size")!, { target: { value: "14" } });
  expect(JSON.parse(change.mock.calls.at(-1)![0])).toEqual({ ...initialDocument, blocks: [{ ...block, font_size: 14 }] });
});

test.each([
  ["left", "right", 10, 150], ["right", "left", 276, 138], ["left", "center", 10, 75],
] as const)("property-panel alignment %s to %s persists bounded geometry", async (before, after, x, expected) => {
  const block = { type: "text", x, y: 100, width: 150, align: before, fallback: "Text" };
  const initialDocument = { page: { width_inch: 4, height_inch: 6 }, blocks: [block] };
  const { container } = render(<Editor initialDocument={initialDocument} />);
  fireEvent.click(await screen.findByTestId("layer-0"));
  await screen.findByTestId("ld-block-props-panel");
  fireEvent.change(container.querySelector("#ld-block-props-0-align")!, { target: { value: after } });
  expect(JSON.parse(change.mock.calls.at(-1)![0])).toEqual({ ...initialDocument, blocks: [{ ...block, align: after, x: expected }] });
});

test("property-panel moves bound legacy max dimensions while preserving their field representation", async () => {
  const block = { type: "text", x: 270, y: 100, max_width: 100, max_height: 30, align: "right", fallback: "Text" };
  const initialDocument = { page: { width_inch: 4, height_inch: 6 }, blocks: [block] };
  const { container } = render(<Editor initialDocument={initialDocument} />);
  fireEvent.click(await screen.findByTestId("layer-0"));
  await screen.findByTestId("ld-block-props-panel");
  fireEvent.change(container.querySelector("#ld-block-props-0-x")!, { target: { value: "10" } });
  expect(JSON.parse(change.mock.calls.at(-1)![0]).blocks).toEqual([{ ...block, x: 100 }]);
  fireEvent.change(container.querySelector("#ld-block-props-0-y")!, { target: { value: "430" } });
  expect(JSON.parse(change.mock.calls.at(-1)![0]).blocks).toEqual([{ ...block, x: 100, y: 402 }]);
});

test.each([
  [{ marker: "root", blocks: [{ type: "text", x: 2, y: 3 }], templates: document.templates }, "root"],
  [{ marker: "fallback", templates: { invalid: null, shipping: document.templates.shipping } }, "fallback"],
])("retains root-block and first-valid-template compatibility (case %#)", async (initialDocument, marker) => {
  render(<Editor initialDocument={initialDocument} />);
  await screen.findByTestId("selected-template");
  fireEvent.click(screen.getByText("Move selected"));
  const next = JSON.parse(change.mock.calls.at(-1)![0]);
  expect(next.marker).toBe(marker);
  if (marker === "root") {
    expect(next.blocks[0].x).toBe(77);
    expect(next.templates).toEqual(document.templates);
  } else {
    expect(next.templates.shipping.blocks[0].x).toBe(77);
    expect(next.templates.invalid).toBeNull();
  }
});

test.each([{ readOnly: true }, { busy: true }])("all workflow mutation callbacks are guarded in %p", async (props) => {
  render(<Editor {...props} />);
  await screen.findByTestId("selected-template");
  fireEvent.click(screen.getByText("Move selected")); // A child cannot bypass the parent's guard.
  fireEvent.change(screen.getByTestId("ld-draft-name"), { target: { value: "changed" } });
  fireEvent.change(screen.getByTestId("ld-label-type"), { target: { value: "shipping" } });
  fireEvent.click(screen.getByTestId("ld-tab-code"));
  fireEvent.change(screen.getByTestId("ld-draft-json"), { target: { value: "{}" } });
  expect(change).not.toHaveBeenCalled();
  expect(callbacks.onDraftNameChange).not.toHaveBeenCalled();
  expect(callbacks.onLabelTypeChange).not.toHaveBeenCalled();
});

test("published selection offers an explicit fork and never enables update/publish of the original", () => {
  render(<Editor published />);
  fireEvent.click(screen.getByRole("button", { name: "Fork as new draft" }));
  expect(callbacks.onCreateDraft).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("ld-save-draft")).toBeDisabled();
  expect(screen.getByTestId("ld-publish-draft")).toBeDisabled();
  expect(callbacks.onSaveDraft).not.toHaveBeenCalled();
  expect(callbacks.onPublishDraft).not.toHaveBeenCalled();
});
