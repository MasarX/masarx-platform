import { render, screen, fireEvent } from "@testing-library/react";
import { InlineEditor } from "../../packages/ui/src/table/inline-editor";
import type { InlineEditState, EditConfig } from "../../packages/ui/src/table/editing";
import type { TranslateFn } from "../../packages/ui/src/table/types";

const t: TranslateFn = (key, values) => {
  if (values && typeof values === "object" && "label" in values) {
    return `${key}:${values.label}`;
  }
  return key;
};

const baseEditState: InlineEditState = {
  rowId: "r1",
  columnKey: "col1",
  editType: "text",
  value: "hello",
  status: "idle",
  error: null,
};

const baseEditConfig: EditConfig = {
  editType: "text",
  options: [],
};

function renderEditor(overrides: {
  editState?: Partial<InlineEditState>;
  editConfig?: Partial<EditConfig>;
  editLabel?: string;
  editPending?: boolean;
  onUpdateValue?: jest.Mock;
  onCommit?: jest.Mock;
  onCancel?: jest.Mock;
} = {}) {
  const onUpdateValue = overrides.onUpdateValue ?? jest.fn();
  const onCommit = overrides.onCommit ?? jest.fn();
  const onCancel = overrides.onCancel ?? jest.fn();

  const editState = { ...baseEditState, ...overrides.editState };
  const editConfig = { ...baseEditConfig, ...overrides.editConfig };

  const result = render(
    <InlineEditor
      t={t}
      editState={editState}
      editConfig={editConfig}
      editLabel={overrides.editLabel ?? "Column"}
      editPending={overrides.editPending ?? false}
      onUpdateValue={onUpdateValue}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  );
  return { ...result, onUpdateValue, onCommit, onCancel };
}

// --- Keyboard tests ---

test("Escape calls onCancel", () => {
  const { container, onCancel } = renderEditor();
  fireEvent.keyDown(container.firstElementChild!, { key: "Escape" });
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("Enter calls onCommit", () => {
  const { container, onCommit } = renderEditor();
  fireEvent.keyDown(container.firstElementChild!, { key: "Enter" });
  expect(onCommit).toHaveBeenCalledTimes(1);
});

test("Shift+Enter does NOT commit", () => {
  const { container, onCommit } = renderEditor();
  fireEvent.keyDown(container.firstElementChild!, {
    key: "Enter",
    shiftKey: true,
  });
  expect(onCommit).not.toHaveBeenCalled();
});

// --- Field type tests ---

test("text renders text input", () => {
  renderEditor({ editState: { editType: "text" } });
  const input = screen.getByRole("textbox");
  expect(input).toHaveAttribute("type", "text");
});

test("number renders number input", () => {
  renderEditor({ editState: { editType: "number", value: "42" } });
  const input = screen.getByRole("spinbutton");
  expect(input).toHaveAttribute("type", "number");
});

test("date renders date input", () => {
  renderEditor({ editState: { editType: "date", value: "2026-01-01" } });
  const input = document.querySelector('input[type="date"]');
  expect(input).toBeInTheDocument();
});

test("datetime renders datetime-local input", () => {
  renderEditor({
    editState: { editType: "datetime", value: "2026-01-01T12:00" },
  });
  const input = document.querySelector('input[type="datetime-local"]');
  expect(input).toBeInTheDocument();
});

test("boolean renders checkbox", () => {
  renderEditor({
    editState: { editType: "boolean", value: true },
    editConfig: { editType: "boolean", options: [] },
  });
  const checkbox = screen.getByRole("checkbox");
  expect(checkbox).toBeInTheDocument();
});

test("boolean auto-commits on change", () => {
  jest.useFakeTimers();
  const { onCommit } = renderEditor({
    editState: { editType: "boolean", value: false },
    editConfig: { editType: "boolean", options: [] },
  });

  fireEvent.click(screen.getByRole("checkbox"));
  jest.runAllTimers();

  expect(onCommit).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

test("uuid renders mono font and placeholder", () => {
  renderEditor({
    editState: { editType: "uuid", value: "" },
  });
  const input = screen.getByRole("textbox");
  expect(input).toHaveAttribute(
    "placeholder",
    "00000000-0000-0000-0000-000000000000"
  );
  expect(input.className).toContain("font-mono");
});

test("lookup options override raw uuid editing and suppress the uuid hint", () => {
  renderEditor({
    editState: {
      editType: "uuid",
      value: "11111111-1111-1111-1111-111111111111",
    },
    editConfig: {
      editType: "uuid",
      options: [
        {
          label: "Demo Client A",
          value: "11111111-1111-1111-1111-111111111111",
        },
      ],
    },
    editLabel: "Client",
  });

  expect(screen.getByRole("combobox")).toBeInTheDocument();
  expect(screen.getByText("Demo Client A")).toBeInTheDocument();
  expect(screen.queryByText("edit.uuidHint:Client")).toBeNull();
  expect(screen.queryByPlaceholderText("00000000-0000-0000-0000-000000000000")).toBeNull();
});

test("textarea renders textarea element", () => {
  renderEditor({
    editState: { editType: "textarea", value: "long text" },
    editConfig: { editType: "textarea", options: [] },
  });
  const textarea = document.querySelector("textarea");
  expect(textarea).toBeInTheDocument();
});

// --- State tests ---

test("error status shows error message", () => {
  renderEditor({
    editState: { status: "error", error: "Bad value" },
  });
  expect(screen.getByText("Bad value")).toBeInTheDocument();
});

test("error with no message shows fallback", () => {
  renderEditor({
    editState: { status: "error", error: null },
  });
  expect(screen.getByText("edit.error")).toBeInTheDocument();
});

test("saving disables input", () => {
  renderEditor({
    editState: { status: "saving" },
  });
  const input = screen.getByRole("textbox");
  expect(input).toBeDisabled();
});

test("editPending disables input", () => {
  renderEditor({ editPending: true });
  const input = screen.getByRole("textbox");
  expect(input).toBeDisabled();
});

test("uuid hint shown for uuid type", () => {
  renderEditor({
    editState: { editType: "uuid", value: "" },
    editLabel: "ID",
  });
  expect(screen.getByText("edit.uuidHint:ID")).toBeInTheDocument();
});
