import { randomUUID } from "node:crypto";
import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WarehouseTransferManifestCreateForm } from "../../packages/ui/src/warehouse-transfer-manifest-create-form";
import { renderWithIntl } from "./test-utils";

const createWarehouseTransferManifest = jest.fn();

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: () => ({ createWarehouseTransferManifest, listResource: async () => ({ items: [] }) }),
}));
jest.mock("../../packages/ui/src/use-unsaved-changes", () => ({ useUnsavedChangesGuard: () => undefined }));

// DESIGN.md section 9: each error is announced with its field and focus moves to that field.
function expectFieldError(field: HTMLElement, message: string) {
  expect(screen.getByRole("alert")).toHaveTextContent(message);
  expect(field).toHaveFocus();
  expect(field).toHaveAttribute("aria-invalid", "true");
  expect(field).toHaveAccessibleDescription(message);
}

test("required field errors focus and describe the lookup fields", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <WarehouseTransferManifestCreateForm appBasePath="/console" organizationId={randomUUID()}
      capabilities={["*"]} capabilityWrite="warehouse_transfers.write" />
  );
  const submit = screen.getByRole("button", { name: "Create transfer manifest" });

  await user.click(submit);
  expectFieldError(screen.getByLabelText("Transfer code"), "Transfer code is required.");

  await user.type(screen.getByLabelText("Transfer code"), "EXAMPLE-TRANSFER");
  await user.click(submit);
  const fromBranch = screen.getByRole("combobox", { name: "Search origin branches" });
  expectFieldError(fromBranch, "From branch ID and to branch ID are required.");
  expect(screen.getByLabelText("Transfer code")).not.toHaveAttribute("aria-invalid");

  fireEvent.change(screen.getByLabelText("From branch ID"), { target: { value: "branch-a" } });
  await user.click(submit);
  expectFieldError(screen.getByRole("combobox", { name: "Search destination branches" }),
    "From branch ID and to branch ID are required.");
  expect(fromBranch).not.toHaveAttribute("aria-invalid");

  fireEvent.change(screen.getByLabelText("To branch ID"), { target: { value: "branch-b" } });
  await user.click(submit);
  expectFieldError(screen.getByRole("combobox", { name: "Search shipment tracking or client reference" }),
    "At least one shipment ID is required.");
  expect(createWarehouseTransferManifest).not.toHaveBeenCalled();
});

test("required field errors open and focus the raw ID fields when lookups are unavailable", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <WarehouseTransferManifestCreateForm appBasePath="/console" organizationId={randomUUID()}
      capabilities={[]} capabilityWrite="warehouse_transfers.write" />
  );
  const submit = screen.getByRole("button", { name: "Create transfer manifest" });
  const summary = screen.getByText("Enter record IDs and timestamps", { selector: "summary" });

  await user.type(screen.getByLabelText("Transfer code"), "EXAMPLE-TRANSFER");
  await user.click(submit);
  expect(summary.closest("details")).toHaveAttribute("open");
  expectFieldError(screen.getByLabelText("From branch ID"), "From branch ID and to branch ID are required.");

  fireEvent.change(screen.getByLabelText("From branch ID"), { target: { value: "branch-a" } });
  fireEvent.change(screen.getByLabelText("To branch ID"), { target: { value: "branch-b" } });
  await user.click(submit);
  expectFieldError(screen.getByLabelText("Shipment IDs"), "At least one shipment ID is required.");
});
