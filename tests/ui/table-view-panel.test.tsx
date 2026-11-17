import { render, screen, fireEvent } from "@testing-library/react";
import { TableViewPanel } from "../../packages/ui/src/table/view-panel";
import type { TranslateFn } from "../../packages/ui/src/table/types";

const t: TranslateFn = (key) => key;

const defaultProps = {
  t,
  canManageViews: true,
  activeView: null,
  viewsCount: 0,
  saveOpen: false,
  deleteOpen: false,
  saveName: "",
  saveDefault: false,
  saveStatus: { status: "idle" as const },
  saveDisabled: false,
  onToggleSave: jest.fn(),
  onToggleDelete: jest.fn(),
  onSaveNameChange: jest.fn(),
  onSaveDefaultChange: jest.fn(),
  onSaveView: jest.fn(),
  onDeleteView: jest.fn(),
  testIdPrefix: "test",
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders view panel", () => {
  render(<TableViewPanel {...defaultProps} />);
  expect(screen.getByTestId("test-views-panel")).toBeInTheDocument();
});

test("shows save form when saveOpen is true", () => {
  render(<TableViewPanel {...defaultProps} saveOpen />);
  expect(screen.getByTestId("test-view-save-name")).toBeInTheDocument();
  expect(screen.getByTestId("test-view-save-create")).toBeInTheDocument();
});

test("calls onToggleSave when save button clicked", () => {
  const onToggleSave = jest.fn();
  render(<TableViewPanel {...defaultProps} onToggleSave={onToggleSave} />);
  fireEvent.click(screen.getByTestId("test-view-save-toggle"));
  expect(onToggleSave).toHaveBeenCalledTimes(1);
});

test("calls onSaveView with 'new' mode", () => {
  const onSaveView = jest.fn();
  render(
    <TableViewPanel {...defaultProps} saveOpen onSaveView={onSaveView} />
  );
  fireEvent.click(screen.getByTestId("test-view-save-create"));
  expect(onSaveView).toHaveBeenCalledWith("new");
});

test("calls onDeleteView when delete confirmed", () => {
  const onDeleteView = jest.fn();
  render(
    <TableViewPanel
      {...defaultProps}
      deleteOpen
      activeView={{ id: "v1", label: "My view" }}
      onDeleteView={onDeleteView}
    />
  );
  const confirmButton = screen.getByTestId("test-view-delete-confirm-submit");
  fireEvent.click(confirmButton);
  expect(onDeleteView).toHaveBeenCalledTimes(1);
});

test("disables save when saveDisabled is true", () => {
  render(<TableViewPanel {...defaultProps} saveOpen saveDisabled />);
  expect(screen.getByTestId("test-view-save-create")).toBeDisabled();
});

test("shows view scope and settings resolution values", () => {
  render(
    <TableViewPanel
      {...defaultProps}
      viewScopeValue="org:acme"
      settingsResolutionValue="tenant-default"
    />
  );
  expect(screen.getByText("org:acme")).toBeInTheDocument();
  expect(screen.getByText("tenant-default")).toBeInTheDocument();
});
