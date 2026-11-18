jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/test",
}));

jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator:
    (namespace) =>
    (key) => {
      const fullKey = namespace ? `${namespace}.${key}` : key;
      if (fullKey === "ui.resourceDetail.sections.general") return "General";
      if (fullKey === "ui.resourceDetail.internalIdLabel") return "Internal ID";
      if (fullKey === "ui.resourceDetail.title") return "Details";
      if (fullKey === "ui.resourceDetail.emptyMessage") return "No data available";
      return fullKey;
    },
}));

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { ResourceDetailEditable } from "../../packages/ui/src/resource-detail-editable";

const defaultOnUpdate = jest.fn().mockResolvedValue(undefined);

beforeEach(() => {
  defaultOnUpdate.mockClear();
});

test("renders detail sections from data and columns", () => {
  renderWithIntl(
    <ResourceDetailEditable
      title="Order detail"
      data={{
        name: "Widget A",
        status: "active",
        category: "tools",
      }}
      columns={[
        { key: "name", label: "Name", detailSection: "Info" },
        { key: "status", label: "Status", detailSection: "Info" },
        { key: "category", label: "Category", detailSection: "Classification" },
      ]}
      onUpdate={defaultOnUpdate}
    />
  );

  expect(screen.getByText("Order detail")).toBeInTheDocument();
  expect(screen.getByText("Info")).toBeInTheDocument();
  expect(screen.getByText("Classification")).toBeInTheDocument();
  expect(screen.getByText("Name")).toBeInTheDocument();
  expect(screen.getByText("Widget A")).toBeInTheDocument();
  expect(screen.getByText("Status")).toBeInTheDocument();
  expect(screen.getByText("active")).toBeInTheDocument();
  expect(screen.getByText("Category")).toBeInTheDocument();
  expect(screen.getByText("tools")).toBeInTheDocument();
});

test("shows empty message when data is null", () => {
  renderWithIntl(
    <ResourceDetailEditable
      data={null}
      emptyMessage="Nothing to show"
      onUpdate={defaultOnUpdate}
    />
  );

  expect(screen.getByText("Nothing to show")).toBeInTheDocument();
  expect(screen.queryByText("General")).not.toBeInTheDocument();
});

test("shows empty message when data is empty object", () => {
  renderWithIntl(
    <ResourceDetailEditable
      data={{}}
      emptyMessage="Empty record"
      onUpdate={defaultOnUpdate}
    />
  );

  // With an empty data object, buildDetailSections returns no sections
  // so no section labels or field entries should appear
  expect(screen.queryByText("General")).not.toBeInTheDocument();
});

test("renders editable fields with edit buttons when editMode is inline", () => {
  renderWithIntl(
    <ResourceDetailEditable
      title="Edit test"
      data={{
        name: "Widget A",
        status: "active",
      }}
      columns={[
        { key: "name", label: "Name", editMode: "inline", editType: "text" },
        { key: "status", label: "Status", editMode: "inline", editType: "text" },
      ]}
      resourceKey="widgets"
      recordId="w_1"
      onUpdate={defaultOnUpdate}
    />
  );

  const editButtons = screen.getAllByRole("button", { name: "Edit" });
  expect(editButtons.length).toBe(2);
});

test("does not show edit buttons for non-editable fields", () => {
  renderWithIntl(
    <ResourceDetailEditable
      title="Read-only test"
      data={{
        name: "Widget A",
        status: "active",
      }}
      columns={[
        { key: "name", label: "Name" },
        { key: "status", label: "Status" },
      ]}
      resourceKey="widgets"
      recordId="w_1"
      onUpdate={defaultOnUpdate}
    />
  );

  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
});

test("inline edit save calls onUpdate with correct patch", async () => {
  renderWithIntl(
    <ResourceDetailEditable
      title="Save test"
      data={{
        name: "Widget A",
        status: "active",
      }}
      columns={[
        { key: "name", label: "Name", editMode: "inline", editType: "text" },
        { key: "status", label: "Status" },
      ]}
      resourceKey="widgets"
      recordId="w_1"
      onUpdate={defaultOnUpdate}
    />
  );

  // Click the edit button for the "name" field
  const editButton = screen.getByRole("button", { name: "Edit" });
  fireEvent.click(editButton);

  // The editor should now be visible with an input pre-filled with "Widget A"
  const input = screen.getByDisplayValue("Widget A");
  expect(input).toBeInTheDocument();

  // Change the value
  fireEvent.change(input, { target: { value: "Widget B" } });

  // Click Save
  const saveButton = screen.getByRole("button", { name: "Save" });
  fireEvent.click(saveButton);

  await waitFor(() => {
    expect(defaultOnUpdate).toHaveBeenCalledTimes(1);
    expect(defaultOnUpdate).toHaveBeenCalledWith({ name: "Widget B" });
  });
});

test("inline edit cancel does not call onUpdate", () => {
  renderWithIntl(
    <ResourceDetailEditable
      title="Cancel test"
      data={{
        name: "Widget A",
        status: "active",
      }}
      columns={[
        { key: "name", label: "Name", editMode: "inline", editType: "text" },
        { key: "status", label: "Status" },
      ]}
      resourceKey="widgets"
      recordId="w_1"
      onUpdate={defaultOnUpdate}
    />
  );

  // Click the edit button for the "name" field
  const editButton = screen.getByRole("button", { name: "Edit" });
  fireEvent.click(editButton);

  // Verify editor is open
  expect(screen.getByDisplayValue("Widget A")).toBeInTheDocument();

  // Click Cancel
  const cancelButton = screen.getByRole("button", { name: "Cancel" });
  fireEvent.click(cancelButton);

  // onUpdate should NOT have been called
  expect(defaultOnUpdate).not.toHaveBeenCalled();

  // The editor should close and the original value should be visible again
  expect(screen.getByText("Widget A")).toBeInTheDocument();
});

test("shows title when provided", () => {
  renderWithIntl(
    <ResourceDetailEditable
      title="Custom Title"
      data={{ name: "Widget A" }}
      columns={[{ key: "name", label: "Name" }]}
      onUpdate={defaultOnUpdate}
    />
  );

  expect(screen.getByText("Custom Title")).toBeInTheDocument();
});

test("shows lookup labels for foreign-key detail values and inline editors", () => {
  const clientId = "11111111-1111-1111-1111-111111111111";

  renderWithIntl(
    <ResourceDetailEditable
      title="Lookup detail"
      data={{ client_id: clientId }}
      columns={[
        {
          key: "client_id",
          label: "Client",
          editMode: "inline",
          editType: "uuid",
          editOptions: [{ label: "Demo Client A", value: clientId }],
        },
      ]}
      resourceKey="shipments"
      recordId="shipment-1"
      onUpdate={defaultOnUpdate}
    />
  );

  expect(screen.getByText("Demo Client A")).toBeInTheDocument();
  expect(screen.queryByText(clientId)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));

  expect(screen.getByRole("combobox")).toBeInTheDocument();
  expect(screen.getByText("Demo Client A")).toBeInTheDocument();
});

test("uses lookup labels for display and inline editing when edit options are provided", async () => {
  renderWithIntl(
    <ResourceDetailEditable
      title="Status detail"
      data={{
        status: "hold_at_branch",
      }}
      columns={[
        {
          key: "status",
          label: "Status",
          editMode: "inline",
          editType: "select",
          editOptions: [
            { value: "hold_at_branch", label: "Hold At Branch" },
            { value: "rescheduled", label: "Rescheduled" },
          ],
        },
      ]}
      resourceKey="shipments"
      recordId="shipment-1"
      onUpdate={defaultOnUpdate}
    />
  );

  expect(screen.getByText("Hold At Branch")).toBeInTheDocument();
  expect(screen.queryByText("hold_at_branch")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const combobox = screen.getByRole("combobox");
  expect(combobox).toHaveTextContent("Hold At Branch");

  fireEvent.click(combobox);
  fireEvent.pointerDown(screen.getByRole("option", { name: "Rescheduled" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => {
    expect(defaultOnUpdate).toHaveBeenCalledWith({ status: "rescheduled" });
  });
});
