import { render, fireEvent, screen } from "@testing-library/react";
import { DetailFieldEditor } from "../../packages/ui/src/detail/detail-field-editor";

const defaultProps = {
  fieldKey: "name",
  label: "Name",
  editType: "text",
  value: "hello",
  onSave: jest.fn(),
  onCancel: jest.fn(),
};

beforeEach(() => {
  defaultProps.onSave.mockClear();
  defaultProps.onCancel.mockClear();
});

test("renders text input for text editType", () => {
  render(<DetailFieldEditor {...defaultProps} editType="text" value="hello" />);

  const input = screen.getByDisplayValue("hello");
  expect(input).toBeInTheDocument();
  expect(input).toHaveAttribute("type", "text");
});

test("renders checkbox for boolean editType", () => {
  render(
    <DetailFieldEditor {...defaultProps} editType="boolean" value={true} />
  );

  const checkbox = screen.getByRole("checkbox");
  expect(checkbox).toBeInTheDocument();
  expect(checkbox).toBeChecked();
});

test("calls onSave with field key and value on save button click", () => {
  render(
    <DetailFieldEditor
      {...defaultProps}
      fieldKey="title"
      editType="text"
      value="draft"
    />
  );

  const saveButton = screen.getByRole("button", { name: "Save" });
  fireEvent.click(saveButton);

  expect(defaultProps.onSave).toHaveBeenCalledTimes(1);
  expect(defaultProps.onSave).toHaveBeenCalledWith("title", "draft");
});

test("calls onCancel on cancel button click", () => {
  render(<DetailFieldEditor {...defaultProps} />);

  const cancelButton = screen.getByRole("button", { name: "Cancel" });
  fireEvent.click(cancelButton);

  expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
});

test("calls onCancel on Escape key", () => {
  render(<DetailFieldEditor {...defaultProps} editType="text" value="test" />);

  const input = screen.getByDisplayValue("test");
  fireEvent.keyDown(input, { key: "Escape" });

  expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
});

test("calls onSave on Enter key", () => {
  render(
    <DetailFieldEditor
      {...defaultProps}
      fieldKey="name"
      editType="text"
      value="world"
    />
  );

  const input = screen.getByDisplayValue("world");
  fireEvent.keyDown(input, { key: "Enter" });

  expect(defaultProps.onSave).toHaveBeenCalledTimes(1);
  expect(defaultProps.onSave).toHaveBeenCalledWith("name", "world");
});

test("shows error message when error prop set", () => {
  render(
    <DetailFieldEditor {...defaultProps} error="Something went wrong" />
  );

  expect(screen.getByText("Something went wrong")).toBeInTheDocument();
});

test("disables buttons when saving", () => {
  render(<DetailFieldEditor {...defaultProps} saving={true} />);

  const buttons = screen.getAllByRole("button");
  for (const button of buttons) {
    expect(button).toBeDisabled();
  }
});
