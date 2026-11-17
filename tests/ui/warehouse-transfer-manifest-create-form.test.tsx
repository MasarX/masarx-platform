import * as React from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WarehouseTransferManifestCreateForm } from "../../packages/ui/src/warehouse-transfer-manifest-create-form";
import { renderWithIntl } from "./test-utils";

const push = jest.fn();
const toast = jest.fn();
const createWarehouseTransferManifest = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("@masarx/api", () => {
  const actual = jest.requireActual("@masarx/api");
  return {
    ...actual,
    createUiClient: () => ({ createWarehouseTransferManifest }),
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
});

test("requires shipment ids before creating a transfer manifest", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <WarehouseTransferManifestCreateForm
      appBasePath="/console"
      organizationId="org-1"
      accessScope={{ scope_type: "tenant", scope_id: "tenant-1" }}
      capabilities={["warehouse_transfers.write"]}
      capabilityWrite="warehouse_transfers.write"
      testIdPrefix="console-warehouse-transfer-manifest-create"
    />
  );

  await user.type(
    screen.getByTestId("console-warehouse-transfer-manifest-create-transfer-code"),
    "XFER-001"
  );
  await user.type(
    screen.getByTestId("console-warehouse-transfer-manifest-create-from-branch-id"),
    "branch-from"
  );
  await user.type(
    screen.getByTestId("console-warehouse-transfer-manifest-create-to-branch-id"),
    "branch-to"
  );
  await user.click(
    screen.getByTestId("console-warehouse-transfer-manifest-create-submit")
  );

  expect(
    await screen.findByTestId("console-warehouse-transfer-manifest-create-error")
  ).toHaveTextContent("At least one shipment ID is required.");
  expect(createWarehouseTransferManifest).not.toHaveBeenCalled();
});

test("submits the canonical manifest payload and redirects to transfer detail", async () => {
  const user = userEvent.setup();
  createWarehouseTransferManifest.mockResolvedValue({
    transfer_id: "transfer-1",
    warehouse_transfer_id: "transfer-1",
    transfer_code: "XFER-001",
    operation: "inserted",
  });

  renderWithIntl(
    <WarehouseTransferManifestCreateForm
      appBasePath="/portal"
      returnTo="/portal/resources/warehouse_transfers?status=draft"
      organizationId="org-1"
      accessScope={{ scope_type: "tenant", scope_id: "tenant-1" }}
      capabilities={["warehouse_transfers.write"]}
      capabilityWrite="warehouse_transfers.write"
      testIdPrefix="portal-warehouse-transfer-manifest-create"
    />
  );

  await user.type(
    screen.getByTestId("portal-warehouse-transfer-manifest-create-transfer-code"),
    "XFER-001"
  );
  await user.type(
    screen.getByTestId("portal-warehouse-transfer-manifest-create-from-branch-id"),
    "branch-from"
  );
  await user.type(
    screen.getByTestId("portal-warehouse-transfer-manifest-create-to-branch-id"),
    "branch-to"
  );
  await user.type(
    screen.getByTestId("portal-warehouse-transfer-manifest-create-planned-dispatch-at"),
    "2026-04-05T08:00:00Z"
  );
  await user.type(
    screen.getByTestId("portal-warehouse-transfer-manifest-create-planned-receive-at"),
    "2026-04-05T12:00:00Z"
  );
  await user.type(
    screen.getByTestId("portal-warehouse-transfer-manifest-create-shipment-ids"),
    "ship-1\nship-2\nship-1"
  );
  await user.click(
    screen.getByTestId("portal-warehouse-transfer-manifest-create-submit")
  );

  await waitFor(() =>
    expect(createWarehouseTransferManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        transferCode: "XFER-001",
        fromBranchId: "branch-from",
        toBranchId: "branch-to",
        shipmentIds: ["ship-1", "ship-2"],
        plannedDispatchAt: "2026-04-05T08:00:00Z",
        plannedReceiveAt: "2026-04-05T12:00:00Z",
      })
    )
  );
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/portal/resources/warehouse_transfers?status=draft&id=transfer-1&detail_open=1"
    )
  );
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      tone: "success",
      title: "Transfer manifest created",
    })
  );
});

test("blocks submit when transfer-create capability is missing", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <WarehouseTransferManifestCreateForm
      appBasePath="/console"
      organizationId="org-1"
      accessScope={{ scope_type: "tenant", scope_id: "tenant-1" }}
      capabilities={[]}
      capabilityWrite="warehouse_transfers.write"
      testIdPrefix="console-warehouse-transfer-manifest-create"
    />
  );

  await user.type(
    screen.getByTestId("console-warehouse-transfer-manifest-create-transfer-code"),
    "XFER-001"
  );
  await user.type(
    screen.getByTestId("console-warehouse-transfer-manifest-create-from-branch-id"),
    "branch-from"
  );
  await user.type(
    screen.getByTestId("console-warehouse-transfer-manifest-create-to-branch-id"),
    "branch-to"
  );
  await user.type(
    screen.getByTestId("console-warehouse-transfer-manifest-create-shipment-ids"),
    "ship-1"
  );
  await user.click(
    screen.getByTestId("console-warehouse-transfer-manifest-create-submit")
  );

  expect(
    await screen.findByTestId("console-warehouse-transfer-manifest-create-error")
  ).toHaveTextContent("You do not have permission to create warehouse transfers.");
  expect(createWarehouseTransferManifest).not.toHaveBeenCalled();
});
