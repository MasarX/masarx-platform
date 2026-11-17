import * as React from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShipmentManualCreateForm } from "../../packages/ui/src/shipment-manual-create-form";
import { renderWithIntl } from "./test-utils";

const push = jest.fn();
const toast = jest.fn();
const createShipment = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("@masarx/api", () => {
  const actual = jest.requireActual("@masarx/api");
  return {
    ...actual,
    createUiClient: () => ({ createShipment }),
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
  createShipment.mockReset();
});

test("requires client id for tenant-scoped shipment create", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <ShipmentManualCreateForm
      appBasePath="/console"
      organizationId="org-1"
      accessScope={{ scope_type: "tenant", scope_id: "tenant-1" }}
      capabilities={["shipments.write"]}
      capabilityWrite="shipments.write"
      testIdPrefix="console-shipment-manual-create"
    />
  );

  await user.type(
    screen.getByTestId("console-shipment-manual-create-service-type"),
    "delivery"
  );
  await user.click(screen.getByTestId("console-shipment-manual-create-submit"));

  expect(
    await screen.findByTestId("console-shipment-manual-create-error")
  ).toHaveTextContent("Client ID is required for this scope.");
  expect(createShipment).not.toHaveBeenCalled();
});

test("uses scoped client id and redirects to shipment detail", async () => {
  const user = userEvent.setup();
  createShipment.mockResolvedValue({
    shipment_id: "shipment-1",
    tracking_number: "TRACK-1",
    operation: "inserted",
  });

  renderWithIntl(
    <ShipmentManualCreateForm
      appBasePath="/portal"
      returnTo="/portal/resources/shipments?status=pending"
      organizationId="org-1"
      accessScope={{ scope_type: "client", scope_id: "client-1" }}
      capabilities={["shipments.write"]}
      capabilityWrite="shipments.write"
      testIdPrefix="portal-shipment-manual-create"
    />
  );

  expect(
    screen.queryByTestId("portal-shipment-manual-create-client-id")
  ).not.toBeInTheDocument();

  await user.type(
    screen.getByTestId("portal-shipment-manual-create-service-type"),
    "delivery"
  );
  await user.type(
    screen.getByTestId("portal-shipment-manual-create-tracking-number"),
    "TRACK-1"
  );
  await user.click(screen.getByTestId("portal-shipment-manual-create-submit"));

  await waitFor(() =>
    expect(createShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "client-1",
        serviceType: "delivery",
        trackingNumber: "TRACK-1",
      })
    )
  );
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/portal/resources/shipments?status=pending&id=shipment-1&detail_open=1"
    )
  );
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ tone: "success", title: "Shipment created" })
  );
});

test("reuses duplicate shipments and keeps the detail panel open", async () => {
  const user = userEvent.setup();
  createShipment.mockResolvedValue({
    shipment_id: "shipment-reused",
    tracking_number: "TRACK-REUSED",
    operation: "reused",
  });

  renderWithIntl(
    <ShipmentManualCreateForm
      appBasePath="/console"
      returnTo="/console/resources/shipments?view=active"
      organizationId="org-1"
      accessScope={{ scope_type: "tenant", scope_id: "tenant-1" }}
      capabilities={["shipments.write"]}
      capabilityWrite="shipments.write"
      testIdPrefix="console-shipment-manual-create"
    />
  );

  await user.type(
    screen.getByTestId("console-shipment-manual-create-service-type"),
    "delivery"
  );
  await user.type(
    screen.getByTestId("console-shipment-manual-create-client-id"),
    "client-1"
  );
  await user.type(
    screen.getByTestId("console-shipment-manual-create-tracking-number"),
    "TRACK-REUSED"
  );
  await user.click(screen.getByTestId("console-shipment-manual-create-submit"));

  await waitFor(() =>
    expect(createShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "client-1",
        serviceType: "delivery",
        trackingNumber: "TRACK-REUSED",
      })
    )
  );
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/console/resources/shipments?view=active&id=shipment-reused&detail_open=1"
    )
  );
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ tone: "success", title: "Existing shipment reused" })
  );
});

test("blocks submit when shipment-create capability is missing", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <ShipmentManualCreateForm
      appBasePath="/console"
      organizationId="org-1"
      accessScope={{ scope_type: "tenant", scope_id: "tenant-1" }}
      capabilities={[]}
      capabilityWrite="shipments.write"
      testIdPrefix="console-shipment-manual-create"
    />
  );

  await user.type(
    screen.getByTestId("console-shipment-manual-create-service-type"),
    "delivery"
  );
  await user.type(
    screen.getByTestId("console-shipment-manual-create-client-id"),
    "client-1"
  );
  await user.click(screen.getByTestId("console-shipment-manual-create-submit"));

  expect(
    await screen.findByTestId("console-shipment-manual-create-error")
  ).toHaveTextContent("You do not have permission to create shipments.");
  expect(createShipment).not.toHaveBeenCalled();
});

test("allows wildcard capability holders to create shipments", async () => {
  const user = userEvent.setup();
  createShipment.mockResolvedValue({
    shipment_id: "shipment-2",
    tracking_number: "TRACK-2",
    operation: "inserted",
  });

  renderWithIntl(
    <ShipmentManualCreateForm
      appBasePath="/portal"
      organizationId="org-1"
      accessScope={{ scope_type: "platform", scope_id: "platform-1" }}
      capabilities={["*"]}
      capabilityWrite="shipments.write"
      testIdPrefix="portal-shipment-manual-create"
    />
  );

  await user.type(
    screen.getByTestId("portal-shipment-manual-create-service-type"),
    "delivery"
  );
  await user.type(
    screen.getByTestId("portal-shipment-manual-create-client-id"),
    "client-1"
  );
  await user.type(
    screen.getByTestId("portal-shipment-manual-create-tracking-number"),
    "TRACK-2"
  );
  await user.click(screen.getByTestId("portal-shipment-manual-create-submit"));

  await waitFor(() =>
    expect(createShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "client-1",
        serviceType: "delivery",
        trackingNumber: "TRACK-2",
      })
    )
  );
  expect(
    screen.queryByTestId("portal-shipment-manual-create-error")
  ).not.toBeInTheDocument();
});
