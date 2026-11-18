import * as React from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShipmentManualCreateForm } from "../../packages/ui/src/shipment-manual-create-form";
import { renderWithIntl } from "./test-utils";

const push = jest.fn();
const toast = jest.fn();
const createShipment = jest.fn();
const mockUnsavedGuard = jest.fn();
const rpc = jest.fn();
const serviceOfferings = [
  { id: "offering-1", displayName: "Riyadh delivery", serviceLevelKey: "standard" },
];

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("@masarx/api", () => {
  const actual = jest.requireActual("@masarx/api");
  return {
    ...actual,
    createUiClient: () => ({ createShipment, rpc }),
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
  useUnsavedChangesGuard: (options: unknown) => mockUnsavedGuard(options),
}));

beforeEach(() => {
  push.mockReset();
  toast.mockReset();
  createShipment.mockReset();
  mockUnsavedGuard.mockReset();
  rpc.mockReset();
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
      serviceOfferings={serviceOfferings}
    />
  );

  await user.type(
    screen.getByTestId("console-shipment-manual-create-service-type"),
    "delivery"
  );
  await user.selectOptions(
    screen.getByTestId("console-shipment-manual-create-service-offering"),
    "offering-1"
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
      serviceOfferings={serviceOfferings}
    />
  );

  expect(
    screen.queryByTestId("portal-shipment-manual-create-client-id")
  ).not.toBeInTheDocument();

  await user.type(
    screen.getByTestId("portal-shipment-manual-create-service-type"),
    "delivery"
  );
  await user.selectOptions(
    screen.getByTestId("portal-shipment-manual-create-service-offering"),
    "offering-1"
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
        serviceOfferingId: "offering-1",
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
      serviceOfferings={serviceOfferings}
    />
  );

  await user.type(
    screen.getByTestId("console-shipment-manual-create-service-type"),
    "delivery"
  );
  await user.selectOptions(
    screen.getByTestId("console-shipment-manual-create-service-offering"),
    "offering-1"
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
        serviceOfferingId: "offering-1",
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
      serviceOfferings={serviceOfferings}
    />
  );

  await user.type(
    screen.getByTestId("console-shipment-manual-create-service-type"),
    "delivery"
  );
  await user.selectOptions(
    screen.getByTestId("console-shipment-manual-create-service-offering"),
    "offering-1"
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
      serviceOfferings={serviceOfferings}
    />
  );

  await user.type(
    screen.getByTestId("portal-shipment-manual-create-service-type"),
    "delivery"
  );
  await user.selectOptions(
    screen.getByTestId("portal-shipment-manual-create-service-offering"),
    "offering-1"
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
        serviceOfferingId: "offering-1",
        trackingNumber: "TRACK-2",
      })
    )
  );
  expect(
    screen.queryByTestId("portal-shipment-manual-create-error")
  ).not.toBeInTheDocument();
});

test.each(["tenant", "client", "sender"])("default %s form is pristine and reverting an edit clears dirty state", async (scopeType) => {
  const user = userEvent.setup();
  renderWithIntl(<ShipmentManualCreateForm appBasePath="/portal" organizationId="org-1"
    accessScope={{ scope_type: scopeType, scope_id: "scope-1" }}
    capabilities={["shipments.write"]} capabilityWrite="shipments.write" testIdPrefix="pristine"
    serviceOfferings={serviceOfferings} />);
  expect(mockUnsavedGuard).toHaveBeenLastCalledWith(expect.objectContaining({ hasChanges: false }));
  const tracking = screen.getByTestId("pristine-tracking-number");
  await user.type(tracking, "TRACK");
  expect(mockUnsavedGuard).toHaveBeenLastCalledWith(expect.objectContaining({ hasChanges: true }));
  await user.clear(tracking);
  expect(mockUnsavedGuard).toHaveBeenLastCalledWith(expect.objectContaining({ hasChanges: false }));
  await user.selectOptions(screen.getByTestId("pristine-service-offering"), "offering-1");
  expect(mockUnsavedGuard).toHaveBeenLastCalledWith(expect.objectContaining({ hasChanges: true }));
});

test("untrusted app base cannot become the manual form cancel destination", () => {
  renderWithIntl(<ShipmentManualCreateForm appBasePath="javascript:alert(1)" organizationId="org-1"
    capabilities={["shipments.write"]} capabilityWrite="shipments.write" testIdPrefix="safe-return" />);
  expect(screen.getByTestId("safe-return-cancel")).toHaveAttribute("href", "/resources/shipments");
});

test.each([
  ["/console/resources/shipments?status=pending", "/portal/resources/shipments"],
  ["/portal/resources/shipments?status=pending#list", "/portal/resources/shipments?status=pending#list"],
  ["/resources/shipments?status=pending#list", "/resources/shipments?status=pending#list"],
  ["/portal/../console/resources/shipments", "/portal/resources/shipments"],
  ["/\\evil.invalid", "/portal/resources/shipments"],
])("validates the manual return destination %s", (returnTo, expected) => {
  renderWithIntl(<ShipmentManualCreateForm appBasePath="/portal" returnTo={returnTo}
    organizationId="org-1" capabilities={["shipments.write"]}
    capabilityWrite="shipments.write" testIdPrefix="return-scope" />);
  expect(screen.getByTestId("return-scope-cancel")).toHaveAttribute("href", expected);
});

test("cross-app return fallback survives create metadata and successful navigation", async () => {
  const user = userEvent.setup();
  createShipment.mockResolvedValue({
    shipment_id: "shipment-safe-return",
    tracking_number: "TRACK-SAFE",
    operation: "inserted",
  });
  renderWithIntl(
    <ShipmentManualCreateForm
      appBasePath="/console"
      returnTo="/portal/resources/shipments?status=pending"
      organizationId="org-1"
      accessScope={{ scope_type: "tenant", scope_id: "tenant-1" }}
      capabilities={["shipments.write"]}
      capabilityWrite="shipments.write"
      testIdPrefix="safe-create-return"
      serviceOfferings={serviceOfferings}
    />
  );
  expect(screen.getByTestId("safe-create-return-cancel"))
    .toHaveAttribute("href", "/console/resources/shipments");
  await user.type(screen.getByTestId("safe-create-return-service-type"), "delivery");
  await user.selectOptions(
    screen.getByTestId("safe-create-return-service-offering"), "offering-1"
  );
  await user.type(screen.getByTestId("safe-create-return-client-id"), "client-1");
  await user.click(screen.getByTestId("safe-create-return-submit"));
  await waitFor(() => expect(createShipment).toHaveBeenCalledTimes(1));
  expect(createShipment).toHaveBeenCalledWith(expect.objectContaining({
    clientId: "client-1",
    serviceType: "delivery",
    serviceOfferingId: "offering-1",
    metadata: expect.objectContaining({
      app_base_path: "/console",
      return_to: "/console/resources/shipments",
    }),
  }));
  await waitFor(() => expect(push).toHaveBeenCalledWith(
    "/console/resources/shipments?id=shipment-safe-return&detail_open=1"
  ));
  expect(push).toHaveBeenCalledTimes(1);
});

async function prepareAddressCreate() {
  const user = userEvent.setup();
  renderWithIntl(<ShipmentManualCreateForm appBasePath="/console" organizationId="org-1"
    accessScope={{ scope_type: "client", scope_id: "client-1" }}
    capabilities={["shipments.write"]} capabilityWrite="shipments.write"
    testIdPrefix="capture" serviceOfferings={serviceOfferings} />);
  await user.type(screen.getByTestId("capture-service-type"), "delivery");
  await user.selectOptions(screen.getByTestId("capture-service-offering"), "offering-1");
  await user.type(screen.getByTestId("capture-address-line1"), "Street 1");
  await user.type(screen.getByTestId("capture-address-city"), "Riyadh");
  return user;
}

test("submits normalized short address and numeric paired coordinates with verified completion", async () => {
  const user = await prepareAddressCreate();
  createShipment.mockResolvedValue({
    shipment_id: "captured", workflow_status: "completed", operation: "inserted",
    destination_address_capture: { status: "verified", address_id: "address-1",
      sa_short_code: "ABCD1234", coordinates: { latitude: 24.7, longitude: 46.6 } },
  });
  await user.type(screen.getByTestId("capture-short-code"), " abcd1234 ");
  await user.type(screen.getByTestId("capture-latitude"), "24.7");
  await user.type(screen.getByTestId("capture-longitude"), "46.6");
  expect(mockUnsavedGuard).toHaveBeenLastCalledWith(expect.objectContaining({ hasChanges: true }));
  await user.click(screen.getByTestId("capture-submit"));
  await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
  expect(createShipment).toHaveBeenCalledWith(expect.objectContaining({
    destinationAddress: { line1: "Street 1", city: "Riyadh", sa_short_code: "ABCD1234", latitude: 24.7, longitude: 46.6,
      coordinates: { latitude: 24.7, longitude: 46.6 } },
  }));
  // router.push is mocked: the completed form stays mounted rather than navigating away.
  await waitFor(() => expect(screen.getByTestId("capture-submit")).toHaveTextContent("Create shipment"));
  expect(screen.getByTestId("capture-submit")).toBeDisabled();
  expect(screen.getByTestId("capture-service-type")).toBeDisabled();
  expect(mockUnsavedGuard).toHaveBeenLastCalledWith(expect.objectContaining({ hasChanges: false }));
  await user.click(screen.getByTestId("capture-submit"));
  expect(createShipment).toHaveBeenCalledTimes(1);
});

test.each([
  ["24", "", "both"],
  ["", "46", "both"],
  ["NaN", "46", "Latitude"],
  ["91", "46", "Latitude"],
  ["24", "-181", "Latitude"],
])("blocks invalid coordinate pair %s / %s before RPC", async (lat, lng, message) => {
  const user = await prepareAddressCreate();
  if (lat) await user.type(screen.getByTestId("capture-latitude"), lat);
  if (lng) await user.type(screen.getByTestId("capture-longitude"), lng);
  await user.click(screen.getByTestId("capture-submit"));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(createShipment).not.toHaveBeenCalled();
});

test("accepted pending create is not failure or completed and prevents duplicate submission", async () => {
  const user = await prepareAddressCreate();
  createShipment.mockResolvedValue({ status: "accepted", workflow_status: "in_progress",
    workflow_run_id: "run-pending", destination_address_capture: { status: "pending" } });
  await user.type(screen.getByTestId("capture-short-code"), "ABCD1234");
  await user.click(screen.getByTestId("capture-submit"));
  expect(await screen.findByRole("status")).toHaveTextContent("still pending");
  expect(screen.getByTestId("capture-submit")).toBeDisabled();
  expect(screen.getByTestId("capture-service-type")).toBeDisabled();
  expect(screen.getByTestId("capture-address-line1")).toBeDisabled();
  expect(mockUnsavedGuard).toHaveBeenLastCalledWith(expect.objectContaining({ hasChanges: false }));
  expect(push).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  expect(createShipment).toHaveBeenCalledTimes(1);
});

test.each(["failed", "blocked", "cancelled"])("rejects %s workflow before apparent verified capture", async (workflow_status) => {
  const user = await prepareAddressCreate();
  createShipment.mockResolvedValue({ shipment_id: "shipment-failed", workflow_status,
    destination_address_capture: { status: "verified", address_id: "address-1", sa_short_code: "ABCD1234", coordinates: null } });
  await user.type(screen.getByTestId("capture-short-code"), "ABCD1234");
  await user.click(screen.getByTestId("capture-submit"));
  expect(await screen.findByRole("alert")).toHaveTextContent("did not complete");
  expect(push).not.toHaveBeenCalled();
});

test.each([
  undefined,
  { status: "pending" },
  { status: "verified", address_id: "address-1", sa_short_code: "WRONG123", coordinates: null },
])("does not claim address completion without matching proof %j", async (destination_address_capture) => {
  const user = await prepareAddressCreate();
  createShipment.mockResolvedValue({ shipment_id: "shipment-unverified", workflow_status: "completed",
    operation: "reused", destination_address_capture });
  await user.type(screen.getByTestId("capture-short-code"), "ABCD1234");
  await user.click(screen.getByTestId("capture-submit"));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByTestId("capture-submit")).toBeDisabled();
  expect(push).not.toHaveBeenCalled();
});

test("typed create API maps address to reserved metadata with unchanged eight RPC arguments", async () => {
  const { createUiClientFromSupabase } = jest.requireActual("../../packages/api/src/ui-client");
  const rpc = jest.fn().mockResolvedValue({ data: { shipment_id: "created" }, error: null });
  const ui = createUiClientFromSupabase({ rpc });
  const destinationAddress = { line1: "Street 1", city: "Riyadh", sa_short_code: "ABCD1234" };
  await ui.createShipment({ destinationAddress, metadata: { source: "test" }, serviceOfferingId: "offering-1" });
  expect(rpc).toHaveBeenCalledWith("ui_create_shipment_v1", expect.objectContaining({
    p_metadata: { source: "test", destination_address: destinationAddress, service_offering_id: "offering-1" },
  }));
  expect(Object.keys(rpc.mock.calls[0][1])).toHaveLength(8);
  expect(() => ui.createShipment({ destinationAddress, metadata: { destination_address: {} } })).toThrow("only once");
  expect(rpc).toHaveBeenCalledTimes(1);
  await ui.createShipment({ metadata: { source: "legacy" } });
  expect(rpc.mock.calls[1][1].p_metadata).toEqual({ source: "legacy" });
});

test("capture normalization preserves zero and coordinate boundaries", () => {
  const { normalizeShipmentAddressCapture } = jest.requireActual("../../packages/ui/src/shipment-address-capture");
  expect(normalizeShipmentAddressCapture("", "", "")).toBeUndefined();
  expect(normalizeShipmentAddressCapture(" abcd1234 ", "0", "-180")).toEqual({
    sa_short_code: "ABCD1234", latitude: 0, longitude: -180,
    coordinates: { latitude: 0, longitude: -180 },
  });
  expect(normalizeShipmentAddressCapture("", "-90", "180")).toEqual({
    latitude: -90, longitude: 180, coordinates: { latitude: -90, longitude: 180 },
  });
});

test.each([
  null,
  { status: "verified", address_id: "", sa_short_code: "ABCD1234", coordinates: { latitude: 24, longitude: 46 } },
  { status: "verified", address_id: "a", sa_short_code: "ABCD1234", coordinates: null },
  { status: "verified", address_id: "a", sa_short_code: "ABCD1234", coordinates: { latitude: "24", longitude: 46 } },
  { status: "verified", address_id: "a", sa_short_code: "ABCD1234", coordinates: { latitude: NaN, longitude: 46 } },
  { status: "verified", address_id: "a", sa_short_code: "ABCD1234", coordinates: { latitude: 24.001, longitude: 46 } },
])("rejects malformed or mismatched persisted capture %j", (proof) => {
  const { normalizeShipmentAddressCapture, assertShipmentAddressCapture } = jest.requireActual("../../packages/ui/src/shipment-address-capture");
  expect(() => assertShipmentAddressCapture(normalizeShipmentAddressCapture("ABCD1234", "24", "46"), proof)).toThrow();
});

test("accepts only matching submitted fields within coordinate tolerance", () => {
  const { normalizeShipmentAddressCapture, assertShipmentAddressCapture } = jest.requireActual("../../packages/ui/src/shipment-address-capture");
  expect(() => assertShipmentAddressCapture(normalizeShipmentAddressCapture("ABCD1234", "24", "46"), {
    status: "verified", address_id: "a", sa_short_code: "abcd1234",
    coordinates: { latitude: 24.000001, longitude: 46 },
  })).not.toThrow();
  expect(() => assertShipmentAddressCapture(undefined, undefined)).not.toThrow();
});


test("lost create response preserves draft and prevents automatic or repeated replay", async () => {
  const user = await prepareAddressCreate();
  createShipment.mockRejectedValue(new TypeError("fetch failed"));
  await user.type(screen.getByTestId("capture-short-code"), "ABCD1234");
  await user.click(screen.getByTestId("capture-submit"));
  expect(await screen.findByRole("alert")).toHaveTextContent("outcome is unverified");
  expect(screen.getByTestId("capture-submit")).toBeDisabled();
  expect(screen.getByTestId("capture-short-code")).toHaveValue("ABCD1234");
  expect(mockUnsavedGuard).toHaveBeenLastCalledWith(expect.objectContaining({ hasChanges: true }));
  await user.click(screen.getByTestId("capture-submit"));
  expect(createShipment).toHaveBeenCalledTimes(1);
  expect(push).not.toHaveBeenCalled();
});

test("requires basic destination fields before address capture mutation", async () => {
  const user = await prepareAddressCreate();
  await user.clear(screen.getByTestId("capture-address-city"));
  await user.type(screen.getByTestId("capture-short-code"), "ABCD1234");
  await user.click(screen.getByTestId("capture-submit"));
  expect(await screen.findByRole("alert")).toHaveTextContent("line 1 and city are required");
  expect(createShipment).not.toHaveBeenCalled();
  expect(screen.getByTestId("capture-submit")).toBeEnabled();
});

test.each(["network", "returned", "timeout"])("actual create transport does not replay %s failures", async (kind) => {
  const { createUiClientFromSupabase } = jest.requireActual("../../packages/api/src/ui-client");
  const error = kind === "network" ? new TypeError("fetch failed")
    : kind === "timeout" ? Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
    : { status: 503, message: "unavailable" };
  const rpc = kind === "returned"
    ? jest.fn().mockResolvedValue({ data: null, error })
    : jest.fn().mockRejectedValue(error);
  const ui = createUiClientFromSupabase({ rpc });
  await expect(ui.createShipment({})).rejects.toBe(error);
  expect(rpc).toHaveBeenCalledTimes(1);
});

test("shared RPC default retry remains unchanged for other callers", async () => {
  const { createRpc } = jest.requireActual("../../packages/api/src/rpc");
  const rpc = jest.fn()
    .mockResolvedValueOnce({ data: null, error: { status: 503 } })
    .mockResolvedValueOnce({ data: { ok: true }, error: null });
  await expect(createRpc({ rpc })("ui_me_v1")).resolves.toEqual({ ok: true });
  expect(rpc).toHaveBeenCalledTimes(2);
});

test.each(["missing", "denied", "null"])("console confirms persisted lineage after %s readback without creating again", async (outcome) => {
  const user = userEvent.setup();
  createShipment.mockResolvedValue({ shipment_id: "shipment-persisted", operation: "inserted",
    workflow_run_id: "run-1", workflow_status: "completed", correlation_id: "correlation-1" });
  if (outcome === "denied") rpc.mockRejectedValueOnce(new Error("Permission denied"));
  else rpc.mockResolvedValueOnce(outcome === "null" ? null : { visible: false });
  rpc.mockResolvedValueOnce({ visible: true });
  renderWithIntl(<ShipmentManualCreateForm appBasePath="/console" requirePersistedReadback
    organizationId="org-1" accessScope={{ scope_type: "client", scope_id: "client-1" }}
    capabilities={["shipments.write"]} capabilityWrite="shipments.write"
    testIdPrefix="readback" serviceOfferings={serviceOfferings} />);
  await user.type(screen.getByTestId("readback-service-type"), "delivery");
  await user.selectOptions(screen.getByTestId("readback-service-offering"), "offering-1");
  await user.click(screen.getByTestId("readback-submit"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Shipment was saved"));
  expect(push).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
  expect(screen.getByTestId("readback-service-type")).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Check persisted shipment" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith(
    "/console/resources/shipments?id=shipment-persisted&detail_open=1"));
  expect(createShipment).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenNthCalledWith(1, "ui_shipment_create_readback_v1", {
    p_shipment_id: "shipment-persisted", p_workflow_run_id: "run-1", p_correlation_id: "correlation-1",
  });
  expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
});
