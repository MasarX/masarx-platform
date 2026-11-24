import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { PickupMutationForm } from "../../packages/ui/src/pickup-operations-form";
import { WarehouseTransferManifestCreateForm } from "../../packages/ui/src/warehouse-transfer-manifest-create-form";
import { renderWithIntl } from "./test-utils";

jest.mock("react", () => ({
  ...jest.requireActual("react"),
  useActionState: () => [{ status: "error", message: "Pickup save failed" }, "/submit", false],
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("../../packages/ui/src/use-unsaved-changes", () => ({ useUnsavedChangesGuard: () => undefined }));

// DESIGN.md section 2: error boxes pair the danger tokens with readable ink text, never the neutral surface.
function expectDangerBox(element: HTMLElement) {
  expect(element).toHaveClass("border-ui-danger/30", "bg-ui-danger/5", "text-ui-ink");
  expect(element.className).not.toMatch(/border-ui-border|bg-ui-surface|text-ui-muted/);
}

test("pickup operation errors use the danger tokens", () => {
  renderWithIntl(
    <PickupMutationForm action={async () => ({ status: "idle" })} submitLabel="Save" testIdPrefix="pickup" fields={[]} />
  );
  expectDangerBox(screen.getByRole("alert"));
});

test("transfer manifest errors use the danger tokens", () => {
  renderWithIntl(
    <WarehouseTransferManifestCreateForm
      appBasePath="/console"
      organizationId="org-1"
      capabilities={["*"]}
      capabilityWrite="warehouse_transfers.write"
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Create transfer manifest" }));
  expectDangerBox(screen.getByRole("alert"));
});
