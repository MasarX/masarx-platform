import { randomUUID } from "node:crypto";
import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WarehouseTransferManifestCreateForm } from "../../packages/ui/src/warehouse-transfer-manifest-create-form";
import { renderWithIntl } from "./test-utils";

const push = jest.fn();
const toast = jest.fn();
const createWarehouseTransferManifest = jest.fn();
const listResource = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("@masarx/api", () => {
  const actual = jest.requireActual("@masarx/api");
  return {
    ...actual,
    createUiClient: () => ({ createWarehouseTransferManifest, listResource }),
    isRetriableNetworkError: () => false,
    isRetriableSupabaseError: () => false,
  };
});

jest.mock("../../packages/ui/src/use-toast", () => {
  const actual = jest.requireActual("../../packages/ui/src/use-toast");
  return {
    ...actual,
    useToast: () => ({ toast }),
  };
});

jest.mock("../../packages/ui/src/use-unsaved-changes", () => ({
  useUnsavedChangesGuard: () => undefined,
}));

beforeEach(() => {
  push.mockReset();
  toast.mockReset();
  createWarehouseTransferManifest.mockReset();
  listResource.mockReset().mockResolvedValue({ items: [] });
});

const externalHost = ["external", "example", "test"].join(".");
const outsideHost = ["outside", "example", "test"].join(".");

test.each([
  {
    name: "untrusted application base",
    appBasePath: `https://${externalHost}`,
    returnTo: "/\\" + externalHost + "/unsafe",
    expectedHref: "/resources/warehouse_transfers?id=transfer-a&detail_open=1",
  },
  {
    name: "authority-like normalized path",
    appBasePath: "/portal",
    returnTo: `/section/..//${outsideHost}/unsafe`,
    expectedHref: "/portal/resources/warehouse_transfers?id=transfer-a&detail_open=1",
  },
])("submits scoped lookup selections with a safe fallback for $name", async ({ appBasePath, returnTo, expectedHref }) => {
  const user = userEvent.setup();
  listResource.mockImplementation(async (resource: string) => ({
    items: resource === "branches"
      ? [
          { id: "branch-a", name: "Example Origin", code: "SITE-A" },
          { id: "branch-b", name: "Example Destination", code: "SITE-B" },
        ]
      : [{ id: "shipment-a", tracking_number: "TRACK-A", client_reference_number: "REF-A" }],
  }));
  createWarehouseTransferManifest.mockResolvedValue({ transfer_id: "transfer-a" });
  const organizationId = randomUUID();
  renderWithIntl(
    <WarehouseTransferManifestCreateForm
      appBasePath={appBasePath}
      returnTo={returnTo}
      organizationId={organizationId}
      accessScope={{ scope_type: "tenant", scope_id: organizationId, scope_label: "Example Tenant" }}
      capabilities={["*"]}
      capabilityWrite="warehouse_transfers.write"
    />
  );

  for (const [control, label] of [
    ["Search origin branches", "Example Origin | SITE-A"],
    ["Search destination branches", "Example Destination | SITE-B"],
    ["Search shipment tracking or client reference", "TRACK-A | REF-A"],
  ]) {
    await user.click(screen.getByRole("combobox", { name: control }));
    await user.type(screen.getByRole("searchbox", { name: "Search options" }), label.split(" | ")[0]);
    fireEvent.pointerDown(await screen.findByRole("option", { name: label }));
  }

  expect(screen.getByTestId("warehouse-transfer-manifest-create-organization")).toHaveTextContent("Example Tenant");
  expect(screen.getByTestId("warehouse-transfer-manifest-create-shipment-count")).toHaveTextContent("1 shipment");
  await user.type(screen.getByLabelText("Transfer code"), "EXAMPLE-TRANSFER");
  fireEvent.change(screen.getByTestId("warehouse-transfer-manifest-create-planned-dispatch-at"), {
    target: { value: "invalid timestamp" },
  });
  await user.click(screen.getByRole("button", { name: "Create transfer manifest" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid planned dispatch time.");
  expect(createWarehouseTransferManifest).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("Planned dispatch time (local)"), { target: { value: "2026-01-12T12:00" } });
  const receipt = screen.getByLabelText("Planned receipt time (local)");
  fireEvent.change(receipt, { target: { value: "2026-01-12T08:00" } });
  await user.click(screen.getByRole("button", { name: "Create transfer manifest" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Planned receive time must be at or after planned dispatch time.");
  expect(receipt).toHaveAccessibleDescription("Planned receive time must be at or after planned dispatch time.");
  expect(receipt).toHaveFocus();
  expect(createWarehouseTransferManifest).not.toHaveBeenCalled();

  fireEvent.change(receipt, { target: { value: "2026-01-12T14:00" } });
  await user.click(screen.getByRole("button", { name: "Create transfer manifest" }));
  await waitFor(() => expect(createWarehouseTransferManifest).toHaveBeenCalledWith(expect.objectContaining({
    fromBranchId: "branch-a",
    toBranchId: "branch-b",
    shipmentIds: ["shipment-a"],
  })));
  await waitFor(() => expect(push).toHaveBeenCalledWith(expectedHref));
});
